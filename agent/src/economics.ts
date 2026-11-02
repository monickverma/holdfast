// The units every trade calculation uses, in one place. All integer, all rounded against the trade.
//   HSK and WHSK amounts: wei, 1e18 per token.
//   USDT amounts: micro-units, 1e6 per token.
//   Prices (the "X18" fields): USDT micro-units per 1e18 wei, so micro-USDT per 1 HSK. Not scaled by 1e18.
//   Bps: 1/10,000 of the reference named. Nothing here is annualized or extrapolated in time.
//   What is left out: a reverted trade's gas, any later price move, and any cost on another venue.
const E18 = 10n ** 18n;
const BPS = 10_000n;

/** The widest outside spread still treated as a price at all. Twice the 150 bps its midpoint must agree within. */
export const MAX_MARK_SPREAD_BPS = 300n;
/** Fee and impact together a market order may pay against spot. The pool's own fee is 30 bps. */
export const DEFAULT_MAX_IMPACT_BPS = 300;

export interface MarkPrices {
  askX18: bigint;
  bidX18: bigint;
}

/** A crossed, zero or very wide book values one side of a trade at nonsense, so it can show a profit that does not exist. */
export function markIsSane(mark: MarkPrices): boolean {
  if (mark.bidX18 <= 0n || mark.askX18 < mark.bidX18) return false;
  return (mark.askX18 - mark.bidX18) * BPS <= mark.bidX18 * MAX_MARK_SPREAD_BPS;
}

/** Bps by which a fill is worse than spot, fee included. Negative if it is better. Rounded up, so never flattering. */
export function impactBps(selling: boolean, amountIn: bigint, amountOut: bigint, spotPriceX18: bigint): bigint {
  if (spotPriceX18 <= 0n || amountIn <= 0n) return BPS;
  // What this input would pay at spot, in the output token.
  const atSpot = selling ? (amountIn * spotPriceX18) / E18 : (amountIn * E18) / spotPriceX18;
  if (atSpot <= 0n) return BPS;
  return ceilDiv((atSpot - amountOut) * BPS, atSpot);
}

/**
 * The smallest output at which a trade nets more than `required`, valued as costLedger values it: HSK given up at the
 * ask, HSK received at the bid. In the output token's units. Below this the trade loses against the reference, so a
 * transaction with this as its minimum cannot fill at a loss on these numbers.
 */
export function breakEvenOut(selling: boolean, inputValue: bigint, networkCost: bigint, required: bigint, bidX18: bigint): bigint {
  const needed = inputValue + networkCost + required + 1n;
  return selling ? needed : ceilDiv(needed * E18, bidX18);
}

/**
 * The input at which an edge of this many bps pays for its network cost, in USDT micro-units, or null with no edge.
 * Assumes the edge holds at every size. It does not, because impact grows with size, so this is a lower bound.
 */
export function minProfitableInput(grossEdge: bigint, networkCost: bigint): bigint | null {
  return grossEdge <= 0n ? null : ceilDiv(networkCost * BPS, grossEdge);
}

/** Bps earned against the input's value, before network cost. Rounded down. */
export function grossEdgeBps(inputValue: bigint, outputValue: bigint): bigint {
  return inputValue <= 0n ? 0n : ((outputValue - inputValue) * BPS) / inputValue;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a > 0n === b > 0n ? q + 1n : q;
}
