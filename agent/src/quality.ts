// Expected against realized, for every fill. Expected comes from the decision the trade committed to on chain, realized
// from its receipt, so neither is a figure this report chose. A fill with no recorded expectation says so.
import type { Address } from "viem";
import { HSKSWAP } from "./config.js";
import type { Intent } from "./ledger.js";
import { sameAddress } from "./reader.js";

const E18 = 10n ** 18n;
const BPS = 10_000n;

export interface FillQuality {
  key: string;
  txHash?: string;
  side: "sell" | "buy";
  /** Output the quote promised, in the output token's base units. */
  quotedOut: bigint | null;
  amountOut: bigint;
  /** Worse than the quote is positive. Null when the decision recorded no quote. */
  slippageBps: bigint | null;
  /** Bps of the slippage allowance used, against the minimum the transaction accepted. */
  allowanceUsedBps: bigint | null;
  /** Worse than the spot price at decision time is positive, fee and impact included. */
  costToSpotBps: bigint | null;
  gasUsed: bigint | null;
  gasEstimated: bigint | null;
  feeWei: bigint | null;
  /** Net against the outside price when the trade was decided, in USDT micro-units, using receipts. Null with no outside price. */
  expectedNetUsdt: bigint | null;
  realizedNetUsdt: bigint | null;
}

export interface QualitySummary {
  fills: number;
  fillsWithExpectation: number;
  reverted: number;
  expired: number;
  cancelled: number;
  /** Fills whose receipt had no matching Traded event from the vault. Should be zero. */
  unverifiedOutcomes: number;
  /** Simple mean, in bps, across fills with a quote. Not weighted by size. Rounded toward zero. */
  meanSlippageBps: bigint | null;
  /** Sum of realized net across fills with an outside price, USDT micro-units. Not a forecast. */
  realizedNetUsdt: bigint | null;
  rows: FillQuality[];
  definition: string;
}

interface StoredDecision {
  quotedOut?: string;
  spotPriceX18?: string;
  ledger?: { net?: string | null; inputValue?: string | null };
  mark?: { askX18?: string; bidX18?: string } | null;
  preflight?: { gasEstimate?: string } | null;
}

function parseBody(body: string | undefined): StoredDecision {
  if (!body) return {};
  try {
    return JSON.parse(body) as StoredDecision;
  } catch {
    return {};
  }
}

const big = (value: string | null | undefined): bigint | null => (value === undefined || value === null ? null : BigInt(value));

/** Reads only fills the chain has reported. Gas is in wei and converted at the decision's spot, so all nets are USDT. */
export function fillQuality(intent: Intent, whsk: Address = HSKSWAP.whsk): FillQuality | null {
  if (intent.status !== "included" || intent.amountOut === undefined) return null;
  const decision = parseBody(intent.decisionBody);
  const selling = sameAddress(intent.tokenIn, whsk);
  const spent = intent.amountSpent ?? intent.amountIn;
  const quoted = big(decision.quotedOut);
  const spot = big(decision.spotPriceX18);
  const slippage = quoted !== null && quoted > 0n ? ((quoted - intent.amountOut) * BPS) / quoted : null;
  const allowance = quoted !== null ? quoted - intent.minOut : null;
  const used = allowance !== null && allowance > 0n && quoted !== null ? ((quoted - intent.amountOut) * BPS) / allowance : null;
  let costToSpot: bigint | null = null;
  if (spot !== null && spot > 0n) {
    const atSpot = selling ? (spent * spot) / E18 : (spent * E18) / spot;
    if (atSpot > 0n) costToSpot = ((atSpot - intent.amountOut) * BPS) / atSpot;
  }

  const ask = big(decision.mark?.askX18);
  const bid = big(decision.mark?.bidX18);
  let realized: bigint | null = null;
  if (ask !== null && bid !== null && spot !== null) {
    const input = selling ? (spent * ask) / E18 : spent;
    const output = selling ? intent.amountOut : (intent.amountOut * bid) / E18;
    realized = output - input - ((intent.feeWei ?? 0n) * spot) / E18;
  }

  return {
    key: intent.key,
    ...(intent.txHash ? { txHash: intent.txHash } : {}),
    side: selling ? "sell" : "buy",
    quotedOut: quoted,
    amountOut: intent.amountOut,
    slippageBps: slippage,
    allowanceUsedBps: used,
    costToSpotBps: costToSpot,
    gasUsed: intent.gasUsed ?? null,
    gasEstimated: big(decision.preflight?.gasEstimate),
    feeWei: intent.feeWei ?? null,
    expectedNetUsdt: big(decision.ledger?.net),
    realizedNetUsdt: realized,
  };
}

export function qualitySummary(intents: readonly Intent[], whsk: Address = HSKSWAP.whsk): QualitySummary {
  const rows = intents.map((intent) => fillQuality(intent, whsk)).filter((row): row is FillQuality => row !== null);
  const withQuote = rows.filter((row) => row.slippageBps !== null);
  const withNet = rows.filter((row) => row.realizedNetUsdt !== null);
  return {
    fills: rows.length,
    fillsWithExpectation: withQuote.length,
    reverted: intents.filter((i) => i.status === "reverted").length,
    expired: intents.filter((i) => i.status === "expired").length,
    cancelled: intents.filter((i) => i.status === "cancelled").length,
    unverifiedOutcomes: intents.filter((i) => i.outcomeUnverified).length,
    meanSlippageBps: withQuote.length ? withQuote.reduce((sum, row) => sum + row.slippageBps!, 0n) / BigInt(withQuote.length) : null,
    realizedNetUsdt: withNet.length ? withNet.reduce((sum, row) => sum + row.realizedNetUsdt!, 0n) : null,
    rows,
    definition: "Slippage is against the quote at decision time. Net is against the outside price at decision time, with gas at that spot. It excludes reverted trades' gas, later price moves and any cost on another venue, so it is not profit.",
  };
}
