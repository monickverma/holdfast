import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { decodeFunctionResult, encodeFunctionData, keccak256, stringToHex, type Address, type Hex } from "viem";
import { BREAKER_DEFAULTS, breakerVerdict, edgeIntents, isEdgeKey, isModelKey, modelIntents } from "./breaker.js";
import { HSKSWAP, type Config } from "./config.js";
import { decide, edgeHasClosed, plannedQuotes, type Decision, type DecideInput, type Inventory, type Mark, type ModelProposal, type OrderRuntime, type QuoteContext, type TradeDecision } from "./decide.js";
import { canonicalJson, Executor, StaleDecision, SubmissionBusy, type SendMode } from "./executor.js";
import { ChainedLog } from "./audit-log.js";
import { Ledger, type Intent } from "./ledger.js";
import { judgePreflight, preflightTrade, type Preflight, type PreflightCheck } from "./preflight.js";
import { allowsLive, verifyVenue, type VenueReport } from "./venue.js";
import { isSell, type Policy } from "./policy.js";
import { hasMulticall, poolReserves, readHead, readMarket, readTick, VAULT_ABI, type Head, type MarketState } from "./reader.js";
import { tradingResult } from "./position.js";
import { RpcClient, sleep } from "./rpc.js";
import { FlashblockStream, FrameContinuity, lastSwap, liquidityChanged, overlayMarket, poolTransfers, type ConstantProductState, type Frame, type PoolState, type StreamBreak } from "./stream.js";
import type { ProposalSource } from "./strategist.js";
import { JsonlLog, Trace, type Lane } from "./trace.js";

/** How often the send lane and signer run between trades. A warm signature takes about 0.5 ms and the first one about 5 ms. */
const KEEP_WARM_MS = 5_000;
/** How often young receipts are checked against the chain, in blocks. Costs one call per unsettled receipt. */
const RECONCILE_EVERY_BLOCKS = 10n;
/** How often the health file is rewritten. */
const HEARTBEAT_MS = 5_000;

export interface AgentOptions {
  config: Config;
  lane: Lane;
  policy: () => Policy;
  mark: () => Mark | null;
  /** Clock for state-age checks. A fork's blocks are older than real time, so tests pass the chain's. */
  now?: () => number;
  onDecision?: (record: DecisionRecord) => void;
  onVenue?: (report: VenueReport) => void;
  sendMode?: SendMode;
  /**
   * Where model proposals come from, when the policy's ai rule is on. The agent reads the latest one and tells it about
   * each sealed block, and never waits for it, so the model is never on the path from a block to a trade.
   */
  strategist?: ProposalSource;
}

export interface DecisionRecord {
  block: bigint;
  blockHash: string;
  decision: Decision;
  policyVersion: number;
  intent?: Intent;
  /** What the vault said when asked by eth_call, on a simulate run or a live preflight. */
  simulated?: Preflight;
  observeOnly: boolean;
  traceId: string;
  /** What the decision saw, so it can be judged later without trusting anything newer. */
  snapshot?: { blockTime: bigint; spotPriceX18: bigint; tick: number; twapTick: number; liquidity: bigint; baseFeePerGas: bigint };
  mark?: { askX18: bigint; bidX18: bigint; ageMs: number };
  readMode?: string;
  /** The model proposal this decision saw, if the ai rule is on. */
  proposal?: ModelProposal;
}

/** One strategy's fills, netted into what it holds and what that cost. */
export function inventoryOf(intents: readonly Intent[]): Inventory {
  const { whskDelta, usdtDelta } = tradingResult(intents, 0n);
  return { hsk: whskDelta, usdt: usdtDelta };
}

/** The deterministic loop: new block, one pinned read, a pure decision, then sign and send. No model on this path. */
/** The hash an owner pins on the vault to name the one policy allowed to trade. `npm run admin` prints it. */
export function strategyHashOf(policy: Policy): Hex {
  return keccak256(stringToHex(canonicalJson(policy)));
}

/**
 * Block times of the trades the agent has sent, for the policy's pacing. A reverted trade counts, since it spent gas
 * and the next try would too. One dropped before sending, or that expired unsent, does not.
 */
export function tradeTimes(intents: readonly Intent[]): number[] {
  const times: number[] = [];
  for (const intent of intents) {
    if (!["signed", "broadcast", "included", "reverted"].includes(intent.status) || !intent.decisionBody) continue;
    const blockTime = Number((JSON.parse(intent.decisionBody) as { blockTime?: string }).blockTime);
    if (Number.isFinite(blockTime)) times.push(blockTime);
  }
  return times;
}

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
  /** Polls dropped because an earlier one ran late. Sending them all at once would hammer a limiting endpoint. */
  skippedTicks = 0;
  /** "hot" reads everything in one round trip; "pinned" is the three-round-trip path it replaced. */
  readMode: "hot" | "pinned" = "hot";
  /** Ticks where the atomic read's block did not match, so the pinned read ran instead. */
  atomicMisses = 0;
  /** Frames that needed a full read because a local quote was not safe. */
  localQuoteMisses = 0;
  readonly streamBreaks: Partial<Record<StreamBreak, number>> = {};
  private readonly continuity = new FrameContinuity();
  private warmGeneration = 0;
  private poolGeneration = 0;
  private lastFrameBlock = 0n;
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
  /** True while a trade is on its way out. Set synchronously, so a poll and a frame cannot both pass it. */
  private submitting = false;
  /** Counts sends, so a decision made before one is not acted on after it. */
  private submissionGeneration = 0;
  private nextReconcile = 0n;
  private lastHeartbeat = 0;
  private simulateFrom: Address | null = null;
  private queuedFrame: Frame | null = null;
  /** The last venue check, set before a live agent runs. */
  venue: VenueReport | null = null;
  private stopping = false;
  private hedgeRpcs: RpcClient[] = [];
  private sendLane: RpcClient | null = null;
  private keepWarmTimer: NodeJS.Timeout | undefined;
  /** True from an edge trade until the gap it traded is seen to close. */
  private edgeTaken: boolean;
  /** Ledger entries from before the owner last reset the breaker. */
  private breakerIgnored = 0;
  /** A read that began before the last send cannot show that send, so frames must not build on it. */
  private minWarmBlock = 0n;
  private readonly stopsReported = new Set<string>();
  private readonly traces: JsonlLog;
  private readonly decisions: ChainedLog;
  private lastAnchorMs = 0;
  private anchoredSeq = -1;
  anchorsSent = 0;
  /** What the owner pinned, re-read now and then. Zero means no pin. */
  private strategyPin: { value: Hex; readAtMs: number } | null = null;
  private readonly confirmations: JsonlLog;

  constructor(private readonly options: AgentOptions) {
    const { config } = options;
    this.rpc = new RpcClient(config.rpcUrl);
    this.ledger = new Ledger(join(config.dataDir, "ledger.jsonl"));
    this.traces = new JsonlLog(join(config.dataDir, "traces.jsonl"));
    this.decisions = new ChainedLog(join(config.dataDir, "decisions.jsonl"));
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
    // After a restart nothing shows whether the last edge trade's gap closed, so assume it has not.
    this.edgeTaken = edgeIntents(this.ledger.all()).length > 0;
    const reset = this.breakerResetPath;
    if (existsSync(reset)) this.breakerIgnored = (JSON.parse(readFileSync(reset, "utf8")) as { ignored: number }).ignored;
  }

  private get breakerResetPath(): string {
    return join(this.options.config.dataDir, "breaker-reset.json");
  }

  /** The owner's decision to trade again after the breaker tripped. Survives a restart. */
  resetBreaker(): void {
    this.breakerIgnored = this.ledger.all().length;
    writeFileSync(this.breakerResetPath, JSON.stringify({ ignored: this.breakerIgnored }));
  }

  get canTrade(): boolean {
    return this.options.config.live && this.executor !== undefined;
  }

  private checkVenue(): Promise<VenueReport> {
    return verifyVenue(this.rpc, this.options.config, this.executor!.address);
  }

  /** Polls on a fixed timeline. A late poll keeps its intended time, so a stall shows up as latency. */
  async run(): Promise<void> {
    const chainId = Number(await this.rpc.call<string>("eth_chainId"));
    if (chainId !== this.options.config.chainId) throw new Error(`rpc is chain ${chainId}, expected ${this.options.config.chainId}`);
    if (this.canTrade) {
      // Nothing is signed for a market that cannot be shown to be the right one. Recovery still runs on a restart with funds in flight.
      this.venue = await this.checkVenue();
      this.options.onVenue?.(this.venue);
      if (!allowsLive(this.venue)) {
        const problems = this.venue.checks.filter((c) => c.status === "fail" || c.status === "unverified").map((c) => `${c.name}: ${c.detail}`);
        throw new Error(`Venue check ${this.venue.verdict}, so the agent will not start live. ${problems.join(" ")}`);
      }
      await readHead(this.rpc)
        .then((head) => this.executor!.recover(head.number))
        .catch((error) => this.logError(error));
    }

    const start = performance.now();
    const { pollMs } = this.options.config;
    for (let tick = 0; !this.stopping; ) {
      const intended = start + tick * pollMs;
      const wait = intended - performance.now();
      if (wait > 0) await sleep(wait);
      try {
        await this.step(intended);
      } catch (error) {
        this.logError(error);
      }
      // The first late poll keeps its intended time, so the stall shows as latency. The ones it overran are dropped.
      const next = Math.max(tick + 1, Math.floor((performance.now() - start) / pollMs));
      this.skippedTicks += next - tick - 1;
      tick = next;
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
    }, (kind) => {
      this.continuity.reset();
      this.streamBreaks[kind] = (this.streamBreaks[kind] ?? 0) + 1;
      this.dropWarm(this.lastFrameBlock);
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
    this.lastFrameBlock = frame.block;
    const problem = this.continuity.observe(frame);
    if (problem) this.streamBreaks[problem] = (this.streamBreaks[problem] ?? 0) + 1;
    if (problem || frame.logsOrdered === false || (this.options.config.poolKind === "v3" && liquidityChanged(frame, HSKSWAP.pool))) {
      this.dropWarm(frame.block);
      return true;
    }
    if (this.options.config.poolKind === "v3") {
      const touched = lastSwap(frame, HSKSWAP.pool) !== null;
      if (touched) this.poolGeneration++;
      return touched;
    }
    const delta = poolTransfers(frame, HSKSWAP.pool, HSKSWAP.whsk, HSKSWAP.usdt);
    if (!delta) return false;
    this.poolGeneration++;
    const seen = this.frameDeltas.get(frame.block) ?? { delta0: 0n, delta1: 0n };
    this.frameDeltas.set(frame.block, { delta0: seen.delta0 + delta.delta0, delta1: seen.delta1 + delta.delta1 });
    return true;
  }

  private dropWarm(block: bigint): void {
    this.warm = null;
    this.warmGeneration++;
    this.minWarmBlock = block > this.minWarmBlock ? block : this.minWarmBlock;
    this.frameDeltas.clear();
    this.queuedFrame = null;
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
    if (this.submitting || this.executor?.busy) return null;
    const generation = this.submissionGeneration;
    const poolGeneration = this.poolGeneration;
    if (frame.logsOrdered === false || (this.options.config.poolKind === "v3" && liquidityChanged(frame, HSKSWAP.pool))) {
      this.dropWarm(frame.block);
    }
    this.polls++;
    const { config, lane } = this.options;
    const trace = new Trace(`f-${Date.now()}-${this.polls}`, lane, frame.arrivedAt);
    await this.settleInFlight();
    if (this.ledger.inFlight()) return null;

    const policy = this.options.policy();
    const pool: PoolState | null = config.poolKind === "v3" ? lastSwap(frame, HSKSWAP.pool) : this.reservesNow();
    const quotes = plannedQuotes(policy, this.warm?.market ?? null, this.runtime, this.quoteContext(policy));
    const market = this.warm && pool ? overlayMarket(this.warm.market, frame, pool, quotes, HSKSWAP.whsk, HSKSWAP.fee) : null;
    if (!market) {
      this.localQuoteMisses++;
      return this.step(frame.arrivedAt, true);
    }
    return this.act(market, market.head, policy, trace, frame.arrivedAt, quotes.length, this.warm!.pendingNonce, "stream", generation, poolGeneration);
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
    if (this.submitting || this.executor?.busy) return null;
    const submissionGeneration = this.submissionGeneration;
    const poolGeneration = this.poolGeneration;
    const generation = this.warmGeneration;
    this.polls++;
    const { config, lane } = this.options;
    const trace = new Trace(`t-${Date.now()}-${this.polls}`, lane, intended);

    await this.settleInFlight();

    const policy = this.options.policy();
    const quotes = plannedQuotes(policy, this.lastMarket, this.runtime, this.quoteContext(policy));
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
    await this.reconcile(head.number);
    this.writeHeartbeat(market);
    this.updateStreaks(policy, market);
    if (this.streaming) void this.refreshWarm(market, tick?.pendingNonce, generation).catch((error) => this.logError(error));
    return this.act(market, head, policy, trace, intended, quotes.length, tick?.pendingNonce, tick ? "hot" : "pinned", submissionGeneration, poolGeneration);
  }

  /** What the next read must quote for the edge rule's unwind and the model. */
  private quoteContext(policy: Policy): QuoteContext {
    const intents = this.ledger.all();
    return {
      edgeInventory: inventoryOf(edgeIntents(intents)),
      aiInventory: inventoryOf(modelIntents(intents)),
      proposal: policy.ai?.enabled ? (this.options.strategist?.current() ?? null) : null,
    };
  }

  /** Keeps the base a frame reaction builds on. Only the test market needs a second read, for its reserves. */
  async refreshWarm(market: MarketState, pendingNonce?: number, generation = this.warmGeneration): Promise<void> {
    const reserves = this.options.config.poolKind === "constant-product" ? await poolReserves(this.rpc, market.head.number) : undefined;
    if (generation !== this.warmGeneration || market.head.number < this.minWarmBlock) return;
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
    generation = this.submissionGeneration,
    poolGeneration = this.poolGeneration,
  ): Promise<DecisionRecord> {
    const { config } = this.options;
    const context = this.quoteContext(policy);
    const input: DecideInput = {
      market,
      policy,
      mark: this.options.mark(),
      runtime: this.runtime,
      nowMs: (this.options.now ?? Date.now)(),
      maxStateAgeMs: config.maxStateAgeMs,
      maxMarkAgeMs: config.maxMarkAgeMs,
      unsealed: readMode === "stream",
      edgeInventoryHsk: context.edgeInventory!.hsk,
      edgeInventory: context.edgeInventory,
      aiInventory: context.aiInventory,
      proposal: context.proposal,
      tradeTimes: tradeTimes(this.ledger.all()),
    };
    if (this.edgeTaken && !input.unsealed && edgeHasClosed(input)) this.edgeTaken = false;
    input.edgeTaken = this.edgeTaken;
    const warmGeneration = this.warmGeneration;
    const superseded = () => this.submitting || this.executor?.busy || generation !== this.submissionGeneration || warmGeneration !== this.warmGeneration || poolGeneration !== this.poolGeneration;
    const staleState: Decision = { action: "hold", code: "stale-state", reason: "another submission or state invalidation superseded this decision" };
    let decision = this.applyBreaker(await trace.span("decide", () => decide(input)), market);
    if (decision.action === "trade" && superseded()) decision = staleState;
    this.reportBlockedStop(decision);

    // A frame's trade is racing the next flashblock, and the vault still checks it, so only sealed reads ask first.
    const asks = decision.action === "trade" && (config.mode === "simulate" || (this.canTrade && config.preflight === true && readMode !== "stream"));
    let simulated: Preflight | undefined;
    let preflightChecks: PreflightCheck[] | undefined;
    if (asks) {
      simulated = await trace.span("preflight", () => this.simulate(decision as TradeDecision, market));
      const verdict = judgePreflight(decision as TradeDecision, simulated, market, input.mark, policy);
      preflightChecks = verdict.checks;
      if (verdict.hold && this.canTrade) decision = verdict.hold;
      // The vault's answer took a round trip, so check again. No await from here until `submitting` is set.
      if (decision.action === "trade" && superseded()) decision = staleState;
    }

    if (decision.action === "trade" && this.canTrade && (await this.pinRefuses(policy))) {
      decision = { action: "hold", code: "strategy-not-pinned", reason: "The owner pinned a different strategy on the vault, so this policy may not trade." };
    }

    const record: DecisionRecord = {
      block: head.number,
      blockHash: head.hash,
      decision,
      policyVersion: policy.version,
      observeOnly: !this.canTrade,
      traceId: trace.id,
      ...(simulated ? { simulated: { ...simulated, ...(preflightChecks ? { checks: preflightChecks } : {}) } } : {}),
      snapshot: { blockTime: head.timestamp, spotPriceX18: market.spotPriceX18, tick: market.tick, twapTick: market.twapTick, liquidity: market.liquidity, baseFeePerGas: head.baseFeePerGas },
      ...(input.mark ? { mark: { askX18: input.mark.askX18, bidX18: input.mark.bidX18, ageMs: input.nowMs - input.mark.fetchedAtMs } } : {}),
      readMode,
      ...(input.proposal ? { proposal: input.proposal } : {}),
    };

    if (decision.action === "trade" && this.canTrade && !this.ledger.inFlight()) {
      this.submitting = true;
      this.submissionGeneration++;
      try {
        if (decision.trigger === "edge") this.edgeTaken = true;
        // A proposal is carried out once, whatever happens to the transaction.
        if (decision.proposalId) this.options.strategist?.consume(decision.proposalId);
        // Whatever happens next changes the vault's balances and limits, so the next frame must read them first.
        this.warm = null;
        this.minWarmBlock = head.number + 1n;
        record.intent = await this.executor!.submit(this.intentKey(decision, policy), decision, market, trace, pendingNonce, () =>
          warmGeneration === this.warmGeneration && poolGeneration === this.poolGeneration && this.options.policy().version === policy.version &&
          (this.options.now ?? Date.now)() - Number(market.head.timestamp) * 1000 <= config.maxStateAgeMs,
          { policyVersion: policy.version, mark: input.mark, decidedAtMs: input.nowMs, logHead: this.decisions.head, logSeq: this.decisions.seq, strategyHash: strategyHashOf(policy), marketSource: HSKSWAP.pool, readMode, preflight: simulated ?? null });
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
      } catch (error) {
        if (!(error instanceof StaleDecision) && !(error instanceof SubmissionBusy)) throw error;
        if (decision.trigger === "edge") this.edgeTaken = false;
        record.decision = { action: "hold", code: "stale-state", reason: error.message };
      } finally {
        this.submitting = false;
        this.submissionGeneration++;
      }
    }

    trace.attrs.block = head.number;
    trace.attrs.action = record.decision.action;
    trace.attrs.quotes = quoteCount;
    // Still zero with the model on: it is asked after the decision, in the background, and only on sealed blocks.
    trace.attrs.modelCalls = 0;
    this.traces.append(trace.toRecord());
    this.decisions.append({ wallTime: new Date().toISOString(), ...record });
    this.lastDecision = record;
    this.options.onDecision?.(record);
    if (policy.ai?.enabled && readMode !== "stream") this.considerModel(input);
    await this.maybeAnchor(market);
    return record;
  }

  /** A strategist that throws is logged and otherwise ignored: the loop, and every stop, run the same without it. */
  private considerModel(input: DecideInput): void {
    try {
      this.options.strategist?.consider(input);
    } catch (error) {
      this.logError(error);
    }
  }

  /** Anchoring is optional and pays gas, so it is off unless configured, and a failure here never touches trading. */
  private async maybeAnchor(market: MarketState): Promise<void> {
    const interval = this.options.config.anchorIntervalSec ?? 0;
    const now = (this.options.now ?? Date.now)();
    if (!interval || !this.canTrade || this.submitting || this.ledger.inFlight() || now - this.lastAnchorMs < interval * 1000) return;
    if (this.decisions.seq === this.anchoredSeq) return;
    this.lastAnchorMs = now;
    try {
      if (!(await this.executor!.anchorSettled())) return;
      const seq = this.decisions.seq;
      await this.executor!.anchor(this.decisions.head, seq, market);
      this.anchoredSeq = seq;
      this.anchorsSent++;
    } catch {
      // The tail stays unanchored, and the verifier says so.
    }
  }

  /** A pin the node cannot confirm keeps its last known value. Only a vault with the function has one. */
  private async pinRefuses(policy: Policy): Promise<boolean> {
    if (!this.options.config.pinnedStrategy) return false;
    const now = (this.options.now ?? Date.now)();
    if (!this.strategyPin || now - this.strategyPin.readAtMs >= 60_000) {
      const data = encodeFunctionData({ abi: VAULT_ABI, functionName: "strategyPin" });
      try {
        const raw = await this.rpc.call<Hex>("eth_call", [{ to: this.options.config.vault, data }, "latest"]);
        this.strategyPin = { value: decodeFunctionResult({ abi: VAULT_ABI, functionName: "strategyPin", data: raw }), readAtMs: now };
      } catch {
        if (!this.strategyPin) return true;
      }
    }
    return !/^0x0+$/.test(this.strategyPin!.value) && this.strategyPin!.value !== strategyHashOf(policy);
  }

  /** Asks the vault as the agent, which works with no key loaded. */
  private async simulate(decision: TradeDecision, market: MarketState): Promise<Preflight> {
    const { config } = this.options;
    if (!config.vault) return { ok: null, error: "no vault configured", latencyMs: 0 };
    this.simulateFrom ??= this.executor?.address ?? config.agentAddress ?? (await this.readAgentAddress(config.vault));
    return preflightTrade(this.rpc, config.vault, this.simulateFrom, decision, market.head);
  }

  private async readAgentAddress(vault: Address): Promise<Address> {
    const raw = await this.rpc.call<Hex>("eth_call", [{ to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "agent" }) }, "latest"]);
    return decodeFunctionResult({ abi: VAULT_ABI, functionName: "agent", data: raw });
  }

  /** A receipt a reorg took back must stop counting as a fill. A failed check changes nothing and runs again. */
  private async reconcile(headNumber: bigint): Promise<void> {
    if (!this.executor || headNumber < this.nextReconcile) return;
    this.nextReconcile = headNumber + RECONCILE_EVERY_BLOCKS;
    try {
      const changed = await this.executor.reconcile(headNumber);
      if (changed.length) {
        console.error(`ALERT: a reorg changed ${changed.length} receipt(s): ${changed.map((i) => i.key).join(", ")}`);
        this.rebuildRuntime();
      }
    } catch (error) {
      this.logError(error);
      this.nextReconcile = headNumber + 1n;
    }
  }

  /** What `monitor` reads. Replaced atomically, so a reader never sees half a file. */
  private writeHeartbeat(market: MarketState): void {
    const now = Date.now();
    if (now - this.lastHeartbeat < HEARTBEAT_MS) return;
    this.lastHeartbeat = now;
    const { dataDir, mode, live } = this.options.config;
    const path = join(dataDir, "heartbeat.json");
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify({
        wallTime: new Date(now).toISOString(),
        mode: mode ?? (live ? "live" : "observe"),
        block: market.head.number.toString(),
        polls: this.polls,
        errors: this.errors,
        missedBlocks: this.missedBlocks,
        skippedTicks: this.skippedTicks,
        atomicMisses: this.atomicMisses,
        inFlight: this.ledger.inFlight()?.key ?? null,
        lastAction: this.lastDecision?.decision.action ?? null,
        lastHoldCode: this.lastDecision?.decision.action === "hold" ? this.lastDecision.decision.code : null,
      }));
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      this.logError(error);
    }
  }

  /** The agent's own stops. The vault still checks every trade that gets past them. */
  private applyBreaker(decision: Decision, market: MarketState): Decision {
    if (decision.action !== "trade") return decision;
    const limits = this.options.config.breaker ?? BREAKER_DEFAULTS;
    const reason = breakerVerdict(decision, this.ledger.all().slice(this.breakerIgnored), market.head.number, market.spotPriceX18, limits);
    return reason ? { action: "hold", code: "breaker", reason } : decision;
  }

  /** Once per order: this needs a person, and the log alone would not reach one. */
  private reportBlockedStop(decision: Decision): void {
    if (decision.action !== "hold" || decision.code !== "stop-blocked" || this.stopsReported.has(decision.reason)) return;
    this.stopsReported.add(decision.reason);
    console.error(`ALERT: ${decision.reason}`);
  }

  /** Settles any intent awaiting the chain, then counts its fill against its order. */
  async settleInFlight(): Promise<void> {
    if (this.submitting || this.executor?.busy) return;
    const pending = this.ledger.inFlight();
    if (!pending || !this.executor) return;
    const settled = await this.executor.settle(pending, this.lastHead ?? undefined);
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
  private intentKey(decision: Extract<Decision, { action: "trade" }>, policy: Policy): string {
    if (decision.trigger === "model") return `ai:${this.ledger.all().filter((i) => isModelKey(i.key)).length}`;
    if (!decision.orderId) return `edge:${this.ledger.all().filter((i) => isEdgeKey(i.key)).length}`;
    const base = `order:${policy.version}:${decision.orderId}`;
    const attempts = this.ledger.all().filter((i) => i.key.startsWith(`${base}:`)).length;
    return `${base}:${attempts}`;
  }

  private rebuildRuntime(): void {
    const filled = new Map<string, bigint>();
    for (const intent of this.ledger.all()) {
      if (intent.status === "included" && intent.orderId) {
        filled.set(intent.orderId, (filled.get(intent.orderId) ?? 0n) + (intent.amountSpent ?? intent.amountIn));
      }
    }
    for (const [id, amount] of filled) {
      const state = this.runtime.get(id);
      this.runtime.set(id, { filled: amount, hitStreak: state?.hitStreak ?? 0 });
    }
    // The ledger decides. A fill a reorg took back is gone from it, and so must leave here too.
    for (const [id, state] of this.runtime) {
      if (!filled.has(id)) this.runtime.set(id, { filled: 0n, hitStreak: state.hitStreak });
    }
  }

  private updateStreaks(policy: Policy, market: MarketState): void {
    for (const order of policy.orders) {
      if (order.kind !== "stop-loss" || !isSell(order.kind)) continue;
      const state = this.runtime.get(order.id) ?? { filled: 0n, hitStreak: 0 };
      const hit = market.spotPriceX18 <= order.triggerPriceX18!;
      const counted = this.pendingStreak.get(order.id) ?? new Set<string>();
      if (!hit) counted.clear();
      // The current block counts inside decide(), so the streak here is blocks before this one.
      const next = hit ? counted.size - (counted.has(market.head.hash) ? 1 : 0) : 0;
      this.runtime.set(order.id, { filled: state.filled, hitStreak: next });
      if (hit) counted.add(market.head.hash);
      this.pendingStreak.set(order.id, counted);
    }
  }

  private readonly pendingStreak = new Map<string, Set<string>>();
}
