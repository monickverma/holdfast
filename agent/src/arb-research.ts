import { localAmountOut, type ArbVenue, type PairReserves } from './arb.js';

export interface BookLevel { price: number; amount: number }
/** Research arithmetic only; never use floating-point outputs to construct an order. */
export function sweepBook(levels: readonly BookLevel[], quantity: number): number | null {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('invalid quantity');
  let remaining = quantity, total = 0;
  for (const level of levels) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.amount) || level.price <= 0 || level.amount < 0) throw new Error('invalid order book');
    const fill = Math.min(remaining, level.amount);
    total += fill * level.price;
    remaining -= fill;
    if (remaining < 1e-10) return total;
  }
  return null;
}

export interface HedgeInputs { dexSide: 'buy' | 'sell'; hsk: number; usdt: number; bids: BookLevel[]; asks: BookLevel[]; feeBps: number; gasUsdt: number; bufferBps: number; minBase: number; minQuote: number; amountPrecision: number }
export function evaluateHedge(input: HedgeInputs) {
  for (const v of [input.hsk, input.usdt, input.feeBps, input.gasUsdt, input.bufferBps, input.minBase, input.minQuote]) if (!Number.isFinite(v) || v < 0) throw new Error('invalid hedge inputs');
  if (!Number.isInteger(input.amountPrecision) || input.amountPrecision < 0 || input.amountPrecision > 12 || input.feeBps >= 10000) throw new Error('invalid precision or fee');
  for (const [side, levels] of [['bid', input.bids], ['ask', input.asks]] as const) {
    if (!levels.length) throw new Error('empty book');
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i]!;
      if (!Number.isFinite(level.price) || !Number.isFinite(level.amount) || level.price <= 0 || level.amount < 0) throw new Error('invalid book');
      if (i && (side === 'bid' ? level.price > levels[i - 1]!.price : level.price < levels[i - 1]!.price)) throw new Error('unsorted book');
    }
  }
  if (input.bids[0]!.price > input.asks[0]!.price) throw new Error('crossed book');
  const step = 10 ** -input.amountPrecision;
  // Sell only HSK actually acquired; buy enough to replace HSK sold. Dust earns nothing in this conservative P&L.
  const quantity = (input.dexSide === 'buy' ? Math.floor(input.hsk / step + 1e-10) : Math.ceil(input.hsk / step - 1e-10)) * step;
  if (quantity <= 0 || quantity < input.minBase) return { eligible: false as const, reason: 'minimum base', quantity };
  const notional = sweepBook(input.dexSide === 'buy' ? input.bids : input.asks, quantity);
  if (notional === null) return { eligible: false as const, reason: 'insufficient displayed depth', quantity };
  if (notional < input.minQuote) return { eligible: false as const, reason: 'minimum quote', quantity, notional };
  const fee = notional * input.feeBps / 10000;
  const buffer = Math.max(input.usdt, notional) * input.bufferBps / 10000;
  const gross = input.dexSide === 'buy' ? notional - input.usdt : input.usdt - notional;
  return { eligible: true as const, quantity, notional, fee, buffer, dustHsk: Math.abs(quantity - input.hsk), netUsdt: gross - fee - input.gasUsdt - buffer };
}

/** Two independent CP sell pools: solve the continuous marginal-output equality, then evaluate integer outputs.
 * This is a specialized routing heuristic inspired by CFMM routing, not the papers' general global optimizer.
 */
export function splitSell(amount: bigint, a: ArbVenue, ra: PairReserves, b: ArbVenue, rb: PairReserves) {
  if (a.id === b.id || amount <= 0n) throw new Error('distinct pools and positive amount required');
  for (const venue of [a, b]) if (!['uniswap-v2', 'solidly-volatile'].includes(venue.kind) || !venue.pair.includes('USDT') || !venue.pair.includes('WHSK')) throw new Error('expected WHSK/USDT constant-product pools');
  const orient = (r: PairReserves) => r.token0 === 'WHSK' ? [Number(r.reserve0) / 1e18, Number(r.reserve1) / 1e6] : [Number(r.reserve1) / 1e18, Number(r.reserve0) / 1e6];
  const [xa, ya] = orient(ra) as [number, number], [xb, yb] = orient(rb) as [number, number];
  if ([xa, ya, xb, yb].some(v => v <= 0 || !Number.isFinite(v))) throw new Error('invalid reserves');
  const ga = 1 - Number(a.feePpm) / 1e6, gb = 1 - Number(b.feePpm) / 1e6;
  const q = Number(amount) / 1e18;
  const sa = Math.sqrt(ga * xa * ya), sb = Math.sqrt(gb * xb * yb);
  const proposed = Math.max(0, Math.min(q, (sa * (xb + gb * q) - sb * xa) / (sa * gb + sb * ga)));
  const center = BigInt(Math.floor(proposed * 1e18));
  const candidates = [0n, amount, center - 10n ** 12n, center, center + 10n ** 12n];
  let best = { aIn: 0n, bIn: amount, outUsdt: 0n };
  for (const candidate of candidates) {
    const aIn = candidate < 0n ? 0n : candidate > amount ? amount : candidate;
    const outUsdt = localAmountOut(a, ra, 'WHSK', aIn) + localAmountOut(b, rb, 'WHSK', amount - aIn);
    if (outUsdt > best.outUsdt) best = { aIn, bIn: amount - aIn, outUsdt };
  }
  return best;
}
