import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Config } from "./config.js";
import { decide, plannedQuotes, type Decision, type Mark, type OrderRuntime } from "./decide.js";
import { Executor, type SendMode } from "./executor.js";
import { Ledger, type Intent } from "./ledger.js";
import { isSell, type Policy } from "./policy.js";
import { hasMulticall, readHead, readMarket, readTick, type Head, type MarketState } from "./reader.js";
import { RpcClient, sleep } from "./rpc.js";
import { JsonlLog, Trace, type Lane } from "./trace.js";

export interface AgentOptions {
  config: Config;
  lane: Lane;
  policy: () => Policy;
  mark: () => Mark | null;
  /** Clock for state-age checks. A fork's blocks are older than real time, so tests pass the chain's. */
  now?: () => number;
  onDecision?: (record: DecisionRecord) => void;
  sendMode?: SendMode;
}

export interface DecisionRecord {
  block: bigint;
  blockHash: string;
  decision: Decision;
  policyVersion: number;
  intent?: Intent;
  observeOnly: boolean;
  traceId: string;
}

/** The deterministic loop: new block, one pinned read, a pure decision, then sign and send. No model on this path. */
export class Agent {
  readonly rpc: RpcClient;
  readonly ledger: Ledger;
  readonly executor?: Executor;
  readonly runtime = new Map<string, OrderRuntime>();
  lastMarket: MarketState | null = null;
  lastDecision: DecisionRecord | null = null;
  polls = 0;
  missedBlocks = 0;
  errors = 0;
  /** "hot" reads everything in one round trip; "pinned" is the three-round-trip path it replaced. */
  readMode: "hot" | "pinned" = "hot";
  /** Ticks where the atomic read's block did not match, so the pinned read ran instead. */
  atomicMisses = 0;
  private multicall: boolean | null = null;
  /** The sent trade whose receipt has not been seen yet. */
  private awaiting: { intent: Intent; traceId: string; intended: number; sentAt: number } | null = null;
  private lastHead: Head | null = null;
  private stopping = false;
  private readonly traces: JsonlLog;
  private readonly decisions: JsonlLog;
  private readonly confirmations: JsonlLog;

  constructor(private readonly options: AgentOptions) {
    const { config } = options;
    this.rpc = new RpcClient(config.rpcUrl);
    this.ledger = new Ledger(join(config.dataDir, "ledger.jsonl"));
    this.traces = new JsonlLog(join(config.dataDir, "traces.jsonl"));
    this.decisions = new JsonlLog(join(config.dataDir, "decisions.jsonl"));
    this.confirmations = new JsonlLog(join(config.dataDir, "confirmations.jsonl"));
    if (config.agentKey && config.vault) {
      this.executor = new Executor({
        rpc: this.rpc,
        ledger: this.ledger,
        agentKey: config.agentKey,
        vault: config.vault,
        chainId: config.chainId,
        sendMode: options.sendMode ?? "sync",
      });
    }
    this.rebuildRuntime();
  }

  get canTrade(): boolean {
    return this.options.config.live && this.executor !== undefined;
  }

  /** Polls on a fixed timeline. A late poll keeps its intended time, so a stall shows up as latency. */
  async run(): Promise<void> {
    const chainId = Number(await this.rpc.call<string>("eth_chainId"));
    if (chainId !== this.options.config.chainId) throw new Error(`rpc is chain ${chainId}, expected ${this.options.config.chainId}`);
    if (this.canTrade) await this.executor!.recover((await readHead(this.rpc)).number);

    const start = performance.now();
    const { pollMs } = this.options.config;
    for (let tick = 0; !this.stopping; tick++) {
      const intended = start + tick * pollMs;
      const wait = intended - performance.now();
      if (wait > 0) await sleep(wait);
      try {
        await this.step(intended);
      } catch (error) {
        this.errors++;
        this.decisions.append({ wallTime: new Date().toISOString(), error: String(error) });
      }
    }
  }

  stop(): void {
    this.stopping = true;
  }

  close(): void {
    this.rpc.close();
    this.ledger.close();
  }

  /** One poll. Returns a record if this poll saw a new block, or always when `anyHead` is set. */
  async step(intended: number = performance.now(), anyHead = false): Promise<DecisionRecord | null> {
    this.polls++;
    const { config, lane } = this.options;
    const trace = new Trace(`t-${Date.now()}-${this.polls}`, lane, intended);

    await this.settleInFlight();

    const policy = this.options.policy();
    const quotes = plannedQuotes(policy, this.lastMarket, this.runtime);
    this.multicall ??= await hasMulticall(this.rpc);
    const tick =
      this.readMode === "hot" && this.multicall
        ? await trace.span("read", () => readTick(this.rpc, config, quotes, this.canTrade ? this.executor!.address : undefined))
        : null;
    if (this.readMode === "hot" && this.multicall && !tick) this.atomicMisses++;

    const head = tick ? tick.market.head : await trace.span("head", () => readHead(this.rpc));
    if (!anyHead && this.lastHead && head.number <= this.lastHead.number && head.hash === this.lastHead.hash) return null;
    if (this.lastHead && head.number > this.lastHead.number + 1n) this.missedBlocks += Number(head.number - this.lastHead.number - 1n);
    this.lastHead = head;

    const market = tick ? tick.market : await trace.span("state", () => readMarket(this.rpc, config, head, quotes));
    this.lastMarket = market;
    this.updateStreaks(policy, market);

    const decision = await trace.span("decide", () =>
      decide({
        market,
        policy,
        mark: this.options.mark(),
        runtime: this.runtime,
        nowMs: (this.options.now ?? Date.now)(),
        maxStateAgeMs: config.maxStateAgeMs,
        maxMarkAgeMs: config.maxMarkAgeMs,
      }),
    );

    const record: DecisionRecord = {
      block: head.number,
      blockHash: head.hash,
      decision,
      policyVersion: policy.version,
      observeOnly: !this.canTrade,
      traceId: trace.id,
    };

    if (decision.action === "trade" && this.canTrade && !this.ledger.inFlight()) {
      record.intent = await this.executor!.submit(this.intentKey(decision, policy, head), decision, market, trace, tick?.pendingNonce);
      const synced = record.intent.status === "included" || record.intent.status === "reverted";
      if (synced) trace.attrs.decisionToReceiptMs = trace.sinceScheduled("broadcast");
      else trace.attrs.decisionToBroadcastMs = trace.sinceScheduled("broadcast");
      trace.attrs.sendMode = this.executor!.sendMode;
      trace.attrs.readMode = tick ? "hot" : "pinned";
      if (synced) {
        this.confirmed(record.intent, trace.id, intended, performance.now());
        this.rebuildRuntime();
      } else {
        this.awaiting = { intent: record.intent, traceId: trace.id, intended, sentAt: performance.now() };
      }
    }

    trace.attrs.block = head.number;
    trace.attrs.action = decision.action;
    trace.attrs.quotes = quotes.length;
    trace.attrs.modelCalls = 0;
    this.traces.append(trace.toRecord());
    this.decisions.append({ wallTime: new Date().toISOString(), ...record });
    this.lastDecision = record;
    this.options.onDecision?.(record);
    return record;
  }

  /** Settles any intent awaiting the chain, then counts its fill against its order. */
  async settleInFlight(): Promise<void> {
    const pending = this.ledger.inFlight();
    if (!pending || !this.executor) return;
    const settled = await this.executor.settle(pending);
    if (settled) {
      if (this.awaiting?.intent.key === settled.key) {
        this.confirmed(settled, this.awaiting.traceId, this.awaiting.intended, performance.now(), this.awaiting.sentAt);
        this.awaiting = null;
      }
      this.rebuildRuntime();
    }
  }

  /** When the agent learned the outcome, measured from the intended time so waiting stays visible. */
  private confirmed(intent: Intent, traceId: string, intended: number, at: number, sentAt?: number): void {
    this.confirmations.append({
      traceId,
      key: intent.key,
      txHash: intent.txHash,
      status: intent.status,
      blockNumber: intent.blockNumber,
      readMode: this.readMode,
      sendMode: sentAt === undefined ? "sync" : "classic",
      decisionToReceiptMs: at - intended,
      broadcastToReceiptMs: sentAt === undefined ? undefined : at - sentAt,
    });
  }

  /**
   * An order tranche gets a new attempt only after the previous one reached a terminal state with no fill, so one
   * piece of work can never be live on the chain twice.
   */
  private intentKey(decision: Extract<Decision, { action: "trade" }>, policy: Policy, head: Head): string {
    if (!decision.orderId) return `edge:${head.number}`;
    const base = `order:${policy.version}:${decision.orderId}`;
    const attempts = this.ledger.all().filter((i) => i.key.startsWith(`${base}:`)).length;
    return `${base}:${attempts}`;
  }

  private rebuildRuntime(): void {
    const filled = new Map<string, bigint>();
    for (const intent of this.ledger.all()) {
      if (intent.status === "included" && intent.orderId) {
        filled.set(intent.orderId, (filled.get(intent.orderId) ?? 0n) + intent.amountIn);
      }
    }
    for (const [id, amount] of filled) {
      const state = this.runtime.get(id);
      this.runtime.set(id, { filled: amount, hitStreak: state?.hitStreak ?? 0 });
    }
  }

  private updateStreaks(policy: Policy, market: MarketState): void {
    for (const order of policy.orders) {
      if (order.kind !== "stop-loss" || !isSell(order.kind)) continue;
      const state = this.runtime.get(order.id) ?? { filled: 0n, hitStreak: 0 };
      const hit = market.spotPriceX18 <= order.triggerPriceX18!;
      // The current block counts inside decide(), so the streak here is blocks before this one.
      const next = hit ? (this.pendingStreak.get(order.id) ?? 0) : 0;
      this.runtime.set(order.id, { filled: state.filled, hitStreak: next });
      this.pendingStreak.set(order.id, hit ? next + 1 : 0);
    }
  }

  private readonly pendingStreak = new Map<string, number>();
}
