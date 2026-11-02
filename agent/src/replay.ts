// Recorded mainnet samples, replayed through the real decide(), with simulated fills at the recorded quotes. Read only:
// nothing here touches a chain or a key. What it leaves out is listed in REPLAY_CAVEATS, and every result carries it.
import { formatUnits, parseUnits, type Hex } from "viem";
import { inventoryOf } from "./agent.js";
import { BREAKER_DEFAULTS, breakerVerdict, edgeIntents, isEdgeKey, isModelKey, modelIntents } from "./breaker.js";
import { HSKSWAP } from "./config.js";
import { decide, edgeHasClosed, networkCostUsdt, plannedQuotes, type DecideInput, type ModelProposal, type TradeDecision } from "./decide.js";
import type { Intent } from "./ledger.js";
import type { Policy } from "./policy.js";
import { sameAddress, type MarketState, type Quote, type QuoteRequest, type VaultState } from "./reader.js";
import { OPEN_LIMITS, type ShadowSample } from "./shadow.js";
import type { Strategist } from "./strategist.js";

const E18 = 10n ** 18n;

export const REPLAY_CAVEATS = [
  "Fills are simulated at the quotes recorded from the real pool. Our own trades do not move later quotes, so a gap our fill would have closed stays open in the replay.",
  "A size that was not recorded is scaled from the next larger recorded size on the same side, which has the worse average price.",
  "Vault limits are open, as in the shadow run, and the vault's price band and the preflight are not simulated. decide(), the policy's pacing and the agent's breaker are the real ones.",
  "Gas per trade is the recorded estimate: 200,000 gas at the base fee then, plus the L1 fee.",
  "Open inventory at the end is valued at the outside bid if long and the outside ask if short, the side least favourable to it.",
];

const OPEN_VAULT: VaultState = { paused: false, agentExpiry: null, whsk: OPEN_LIMITS, usdt: OPEN_LIMITS };

/** A market as decide() sees it, rebuilt from one sample, with a quote for each request the sample can answer. */
export function marketFromSample(sample: ShadowSample, requests: readonly QuoteRequest[], vault: VaultState = OPEN_VAULT): MarketState {
  const spotPriceX18 = parseUnits(sample.spot.toFixed(6), 6);
  return {
    head: { number: BigInt(sample.block), hash: `0x${BigInt(sample.block).toString(16).padStart(64, "0")}` as Hex, timestamp: BigInt(Math.floor(sample.atMs / 1000)), baseFeePerGas: 0n },
    sqrtPriceX96: 0n,
    tick: sample.twapDeviation,
    twapTick: 0,
    liquidity: 1n,
    spotPriceX18,
    quotes: requests.flatMap((request) => {
      const quote = scaledQuote(sample, request);
      return quote ? [quote] : [];
    }),
    priorityFeePerGas: 0n,
    // All of the recorded network cost goes in the L1 fee, so networkCostUsdt() gives it back.
    l1FeeWei: spotPriceX18 === 0n ? 0n : (parseUnits(sample.networkUsdt.toFixed(6), 6) * E18) / spotPriceX18,
    vault,
  };
}

/** The recorded quote for the smallest size at least this large on the same side, scaled down to this size. */
export function scaledQuote(sample: ShadowSample, request: QuoteRequest): Quote | null {
  const selling = sameAddress(request.tokenIn, HSKSWAP.whsk);
  const candidates = sample.quotes
    .filter((q) => q.side === (selling ? "sell" : "buy"))
    .map((q) => (selling ? { inBase: parseUnits(q.hsk.toFixed(18), 18), outBase: parseUnits(q.usdt.toFixed(6), 6) } : { inBase: parseUnits(q.usdt.toFixed(6), 6), outBase: parseUnits(q.hsk.toFixed(18), 18) }))
    .filter((q) => q.inBase >= request.amountIn)
    .sort((a, b) => (a.inBase < b.inBase ? -1 : 1));
  const recorded = candidates[0];
  if (!recorded || recorded.inBase === 0n) return null;
  return { tokenIn: request.tokenIn, amountIn: request.amountIn, amountOut: (request.amountIn * recorded.outBase) / recorded.inBase, ticksCrossed: 0 };
}

export interface ReplayFill {
  block: string;
  atMs: number;
  trigger: TradeDecision["trigger"];
  side: "buy" | "sell";
  amountIn: string;
  amountOut: string;
  networkUsdt: string;
  reason: string;
}

export interface ReplayReport {
  samples: number;
  decided: number;
  holds: Record<string, number>;
  fills: ReplayFill[];
  fillsByTrigger: Record<string, number>;
  /** Net token change from every simulated fill. */
  hskDelta: string;
  usdtDelta: string;
  gasUsdt: string;
  /** Open inventory at the end, valued against it, plus the USDT change, less gas. Can be negative. */
  netUsdt: string;
  openInventoryHsk: string;
  model?: { asked: number; failures: number; costUsd: number; proposals: Record<string, number> };
}

export interface ReplayOptions {
  maxMarkAgeMs: number;
  maxStateAgeMs: number;
  /** When the policy's ai rule is on, the model that proposes. Each call is real and costs money. */
  strategist?: Strategist;
  /** Set by the strategist's clock, so its calls-per-day window runs on the samples' time. */
  setClock?: (ms: number) => void;
}

/** Runs every usable sample in order through decide(). One proposal at most per sample, and it applies from the next. */
export async function replayStrategy(samples: readonly ShadowSample[], policy: Policy, options: ReplayOptions): Promise<ReplayReport> {
  const intents: Intent[] = [];
  const holds: Record<string, number> = {};
  const fills: ReplayFill[] = [];
  const proposals: Record<string, number> = {};
  let decided = 0;
  let edgeTaken = false;
  let gasMicro = 0n;
  let last: ShadowSample | null = null;
  for (const sample of samples) {
    if (sample.quotes.length === 0) continue;
    options.setClock?.(sample.atMs);
    last = sample;
    const edgeInventory = inventoryOf(edgeIntents(intents));
    const aiInventory = inventoryOf(modelIntents(intents));
    const proposal: ModelProposal | null = policy.ai?.enabled ? (options.strategist?.current() ?? null) : null;
    const sized = marketFromSample(sample, []);
    const requests = plannedQuotes(policy, sized, new Map(), { edgeInventory, aiInventory, proposal });
    const market = marketFromSample(sample, requests);
    const input: DecideInput = {
      market,
      policy,
      mark: { askX18: parseUnits(sample.ask.toFixed(6), 6), bidX18: parseUnits(sample.bid.toFixed(6), 6), fetchedAtMs: sample.atMs - sample.markAgeMs },
      runtime: new Map(),
      nowMs: sample.atMs,
      maxStateAgeMs: options.maxStateAgeMs,
      maxMarkAgeMs: options.maxMarkAgeMs,
      edgeInventory,
      edgeInventoryHsk: edgeInventory.hsk,
      aiInventory,
      proposal,
      tradeTimes: intents.map((i) => Number(i.decisionBody)),
    };
    if (edgeTaken && edgeHasClosed(input)) edgeTaken = false;
    input.edgeTaken = edgeTaken;
    decided++;
    let decision = decide(input);
    if (decision.action === "trade") {
      const reason = breakerVerdict(decision, intents, market.head.number, market.spotPriceX18, BREAKER_DEFAULTS);
      if (reason) decision = { action: "hold", code: "breaker", reason };
    }
    if (decision.action === "hold") holds[decision.code] = (holds[decision.code] ?? 0) + 1;
    else {
      const network = networkCostUsdt(market);
      gasMicro += network;
      const family = decision.trigger === "model" ? "ai" : "edge";
      const count = intents.filter((i) => (family === "ai" ? isModelKey(i.key) : isEdgeKey(i.key))).length;
      intents.push({
        key: `${family}:${count}`,
        intentId: "0x00",
        bodyHash: "0x00",
        status: "included",
        orderId: null,
        tokenIn: decision.tokenIn,
        amountIn: decision.amountIn,
        amountOut: decision.quotedOut,
        minOut: decision.minOut,
        deadline: 0n,
        blockNumber: market.head.number,
        broadcastBlock: market.head.number,
        // The pacing reads trade times from here, so the replay carries the sample's time in it.
        decisionBody: String(Math.floor(sample.atMs / 1000)),
      } as Intent);
      if (decision.trigger === "edge") edgeTaken = true;
      if (decision.proposalId) options.strategist?.consume(decision.proposalId);
      fills.push({
        block: sample.block,
        atMs: sample.atMs,
        trigger: decision.trigger,
        side: sameAddress(decision.tokenIn, HSKSWAP.whsk) ? "sell" : "buy",
        amountIn: sameAddress(decision.tokenIn, HSKSWAP.whsk) ? formatUnits(decision.amountIn, 18) : formatUnits(decision.amountIn, 6),
        amountOut: sameAddress(decision.tokenIn, HSKSWAP.whsk) ? formatUnits(decision.quotedOut, 6) : formatUnits(decision.quotedOut, 18),
        networkUsdt: formatUnits(network, 6),
        reason: decision.reason,
      });
    }
    if (policy.ai?.enabled && options.strategist && options.strategist.consider(input) === "asked") {
      await options.strategist.settled();
      const answer = options.strategist.current();
      const key = answer ? answer.action : "failed";
      proposals[key] = (proposals[key] ?? 0) + 1;
    }
  }
  const all = inventoryOf(intents);
  const bid = last ? parseUnits(last.bid.toFixed(6), 6) : 0n;
  const ask = last ? parseUnits(last.ask.toFixed(6), 6) : 0n;
  const held = (all.hsk * (all.hsk > 0n ? bid : ask)) / E18;
  const fillsByTrigger: Record<string, number> = {};
  for (const fill of fills) fillsByTrigger[fill.trigger] = (fillsByTrigger[fill.trigger] ?? 0) + 1;
  return {
    samples: samples.length,
    decided,
    holds,
    fills,
    fillsByTrigger,
    hskDelta: formatUnits(all.hsk, 18),
    usdtDelta: formatUnits(all.usdt, 6),
    gasUsdt: formatUnits(gasMicro, 6),
    netUsdt: formatUnits(all.usdt + held - gasMicro, 6),
    openInventoryHsk: formatUnits(all.hsk, 18),
    ...(options.strategist && policy.ai?.enabled
      ? { model: { asked: options.strategist.asked, failures: options.strategist.failures, costUsd: options.strategist.usage(last?.atMs ?? 0).costUsd, proposals } }
      : {}),
  };
}
