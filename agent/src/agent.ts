import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { HSKSWAP, type Config } from "./config.js";
import { decide, plannedQuotes, type Decision, type Mark, type OrderRuntime } from "./decide.js";
import { Executor, type SendMode } from "./executor.js";
import { Ledger, type Intent } from "./ledger.js";
import { isSell, type Policy } from "./policy.js";
import { hasMulticall, poolReserves, readHead, readMarket, readTick, type Head, type MarketState } from "./reader.js";
import { RpcClient, sleep } from "./rpc.js";
import { FlashblockStream, lastSwap, overlayMarket, poolTransfers, type ConstantProductState, type Frame, type PoolState } from "./stream.js";
import { JsonlLog, Trace, type Lane } from "./trace.js";

/** How often the send lane and signer run between trades. A warm signature takes about 0.5 ms and the first one about 5 ms. */
const KEEP_WARM_MS = 5_000;

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
  /** Frames that needed a full read because a local quote was not safe. */
  localQuoteMisses = 0;
  private multicall: boolean | null = null;
  /** The sent trade whose receipt has not been seen yet. */
  private awaiting: { intent: Intent; traceId: string; intended: number; sentAt: number } | null = null;
  private lastHead: Head | null = null;
  /** The last full read, which a frame reaction builds on. */
  private warm: { market: MarketState; pendingNonce?: number; reserves?: ConstantProductState } | null = null;
  /** Test market only: pool transfers seen in blocks the last full read cannot include yet. */
  private readonly frameDeltas = new Map<bigint, { delta0: bigint; delta1: bigint }>();
  private streaming = false;
  private acting = false;
  private queuedFrame: Frame | null = null;
  private stopping = false;
  private hedgeRpcs: RpcClient[] = [];
  private sendLane: RpcClient | null = null;
  private keepWarmTimer: NodeJS.Timeout | undefined;
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
      this.hedgeRpcs = (config.hedgeRpcUrls ?? []).map((url) => new RpcClient(url));
      this.executor = new Executor({
        rpc: this.rpc,
        ledger: this.ledger,
        agentKey: config.agentKey,
        vault: config.vault,
        chainId: config.chainId,
        sendMode: options.sendMode ?? "sync",
        hedges: this.hedgeRpcs,
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

  /**
   * Polls as run() does, and also reacts the moment a flashblock shows the pool moved. If the stream drops, the polls
   * carry on by themselves. Sealed-block reads still decide stop-loss confirmation.
   */
  async runStreaming(): Promise<void> {
    const stream = this.openStream();
    await stream.start();
    try {
      await this.run();
    } finally {
      stream.close();
    }
  }

  /** A subscription that reacts to pool activity. A benchmark passes onActivity to time the reaction itself. */
  openStream(onActivity?: (frame: Frame) => void): FlashblockStream {
    const { flashblocksUrl } = this.options.config;
    if (!flashblocksUrl) throw new Error("This network has no flashblock stream configured");
    this.streaming = true;
    this.startSendLane();
    return new FlashblockStream(flashblocksUrl, (frame) => {
      if (!this.observeFrame(frame)) return;
      if (onActivity) onActivity(frame);
      else void this.reactTo(frame).catch((error) => this.logError(error));
    });
  }

  /**
   * Swaps here can be many minutes apart, so the send path would otherwise be cold when it matters. A connection only
   * sends use is pinged, and the signer runs on a throwaway transaction, between trades.
   */
  private startSendLane(): void {
    if (!this.executor || this.sendLane) return;
    const lane = new RpcClient(this.options.config.rpcUrl, { maxRetries: 0 });
    this.sendLane = lane;
    this.executor.useSendLane(lane);
    const keepWarm = () => {
      void lane.call("eth_chainId").catch(() => {});
      void this.executor!.warmSigner().catch(() => {});
    };
    keepWarm();
    this.keepWarmTimer = setInterval(keepWarm, KEEP_WARM_MS);
    this.keepWarmTimer.unref();
  }

  /** Records what a frame did to the pool. Returns true if it touched the pool. */
  private observeFrame(frame: Frame): boolean {
    if (this.options.config.poolKind === "v3") return lastSwap(frame, HSKSWAP.pool) !== null;
    const delta = poolTransfers(frame, HSKSWAP.pool, HSKSWAP.whsk, HSKSWAP.usdt);
    if (!delta) return false;
    const seen = this.frameDeltas.get(frame.block) ?? { delta0: 0n, delta1: 0n };
    this.frameDeltas.set(frame.block, { delta0: seen.delta0 + delta.delta0, delta1: seen.delta1 + delta.delta1 });
    return true;
  }

  /** The last read's reserves plus every transfer seen in blocks newer than that read. */
  private reservesNow(): ConstantProductState | null {
    const warm = this.warm;
    if (!warm?.reserves) return null;
    let { reserve0, reserve1 } = warm.reserves;
    for (const [block, delta] of this.frameDeltas) {
      if (block <= warm.market.head.number) {
        this.frameDeltas.delete(block);
      } else {
        reserve0 += delta.delta0;
        reserve1 += delta.delta1;
      }
    }
    return { kind: "constant-product", reserve0, reserve1 };
  }

  /**
   * Decides from the frame itself, with no read first, so the send can reach the next flashblock. Falls back to the
   * full read when a local quote is not safe.
   */
  async reactTo(frame: Frame): Promise<DecisionRecord | null> {
    if (this.acting) {
      this.queuedFrame = frame;
      return null;
    }
    this.acting = true;
    try {
      return await this.reactNow(frame);
    } finally {
      this.acting = false;
      const queued = this.queuedFrame;
      this.queuedFrame = null;
      if (queued) void this.reactTo(queued).catch((error) => this.logError(error));
    }
  }

  private async reactNow(frame: Frame): Promise<DecisionRecord | null> {
    this.polls++;
    const { config, lane } = this.options;
    const trace = new Trace(`f-${Date.now()}-${this.polls}`, lane, frame.arrivedAt);
    await this.settleInFlight();
    if (this.ledger.inFlight()) return null;

    const policy = this.options.policy();
    const pool: PoolState | null = config.poolKind === "v3" ? lastSwap(frame, HSKSWAP.pool) : this.reservesNow();
    const quotes = plannedQuotes(policy, this.warm?.market ?? null, this.runtime);
    const market = this.warm && pool ? overlayMarket(this.warm.market, frame, pool, quotes, HSKSWAP.whsk, HSKSWAP.fee) : null;
    if (!market) {
      this.localQuoteMisses++;
      return this.step(frame.arrivedAt, true);
    }
    return this.act(market, market.head, policy, trace, frame.arrivedAt, quotes.length, this.warm!.pendingNonce, "stream");
  }

  private logError(error: unknown): void {
    this.errors++;
    this.decisions.append({ wallTime: new Date().toISOString(), error: String(error) });
  }

  stop(): void {
    this.stopping = true;
  }

  close(): void {
    clearInterval(this.keepWarmTimer);
    this.sendLane?.close();
    for (const hedge of this.hedgeRpcs) hedge.close();
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
    if (this.streaming) void this.refreshWarm(market, tick?.pendingNonce).catch((error) => this.logError(error));
    return this.act(market, head, policy, trace, intended, quotes.length, tick?.pendingNonce, tick ? "hot" : "pinned");
  }

  /** Keeps the base a frame reaction builds on. Only the test market needs a second read, for its reserves. */
  async refreshWarm(market: MarketState, pendingNonce?: number): Promise<void> {
    const reserves = this.options.config.poolKind === "constant-product" ? await poolReserves(this.rpc, market.head.number) : undefined;
    if (!this.warm || market.head.number >= this.warm.market.head.number) this.warm = { market, pendingNonce, reserves };
  }

  /** Decides on a market state and sends any resulting trade. Every path to a trade passes through here. */
  private async act(
    market: MarketState,
    head: Head,
    policy: Policy,
    trace: Trace,
    intended: number,
    quoteCount: number,
    pendingNonce: number | undefined,
    readMode: "hot" | "pinned" | "stream",
  ): Promise<DecisionRecord> {
    const { config } = this.options;
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
      record.intent = await this.executor!.submit(this.intentKey(decision, policy, head), decision, market, trace, pendingNonce);
      const synced = record.intent.status === "included" || record.intent.status === "reverted";
      if (synced) trace.attrs.decisionToReceiptMs = trace.sinceScheduled("broadcast");
      else trace.attrs.decisionToBroadcastMs = trace.sinceScheduled("broadcast");
      trace.attrs.sendMode = this.executor!.sendMode;
      trace.attrs.readMode = readMode;
      if (synced) {
        this.confirmed(record.intent, trace.id, intended, performance.now(), undefined, readMode);
        this.rebuildRuntime();
      } else {
        this.awaiting = { intent: record.intent, traceId: trace.id, intended, sentAt: performance.now() };
      }
    }

    trace.attrs.block = head.number;
    trace.attrs.action = decision.action;
    trace.attrs.quotes = quoteCount;
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
  private confirmed(intent: Intent, traceId: string, intended: number, at: number, sentAt?: number, readMode: string = this.readMode): void {
    this.confirmations.append({
      traceId,
      key: intent.key,
      txHash: intent.txHash,
      status: intent.status,
      blockNumber: intent.blockNumber,
      readMode,
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
