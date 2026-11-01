import { formatUnits } from "viem";
import { HSKSWAP } from "./config.js";
import { networkCostUsdt, type Mark } from "./decide.js";
import { sameAddress, type MarketState, type Quote, type TokenLimits } from "./reader.js";
import { nearestRank, quantileReport } from "./stats.js";

/**
 * No vault exists on mainnet, so these limits never block a shadow decision. The floor is the smallest legal value,
 * because decide() treats a floor of zero as an owner who has set no limits.
 */
export const OPEN_LIMITS: TokenLimits = { balance: 2n ** 200n, maxTrade: 2n ** 200n, remaining: 2n ** 200n, floorPriceX18: 1n };

/** One simulated quote, as plain numbers, because a report never does money arithmetic on chain. */
export interface ShadowQuote {
  side: "sell" | "buy";
  /** The size this row belongs to, in USDT. */
  sizeUsdt: number;
  hsk: number;
  usdt: number;
}

export interface ShadowSample {
  atMs: number;
  block: string;
  ask: number;
  bid: number;
  spot: number;
  networkUsdt: number;
  markAgeMs: number;
  /** Distance from the TWAP, in ticks. */
  twapDeviation: number;
  /** What the real decide() said for the policy's own size. */
  decision: string;
  quotes: ShadowQuote[];
}

const micro = (value: bigint) => Number(formatUnits(value, 6));
const wei = (value: bigint) => Number(formatUnits(value, 18));

export function toShadowQuote(quote: Quote, sizeUsdt: number): ShadowQuote {
  return sameAddress(quote.tokenIn, HSKSWAP.whsk)
    ? { side: "sell", sizeUsdt, hsk: wei(quote.amountIn), usdt: micro(quote.amountOut) }
    : { side: "buy", sizeUsdt, hsk: wei(quote.amountOut), usdt: micro(quote.amountIn) };
}

export function toShadowSample(market: MarketState, mark: Mark, sizes: readonly number[], nowMs: number, decision: string): ShadowSample {
  return {
    atMs: nowMs,
    block: market.head.number.toString(),
    ask: micro(mark.askX18),
    bid: micro(mark.bidX18),
    spot: micro(market.spotPriceX18),
    networkUsdt: micro(networkCostUsdt(market)),
    markAgeMs: nowMs - mark.fetchedAtMs,
    twapDeviation: Math.abs(market.tick - market.twapTick),
    decision,
    quotes: market.quotes.slice(0, sizes.length).map((quote, i) => toShadowQuote(quote, sizes[i]!)),
  };
}

/**
 * Net USDT if this swap were closed on the outside venue at these prices. HSK given up is bought back at the ask and HSK
 * received is sold at the bid, the same conservative valuation as costLedger, plus the venue's fee.
 */
export function netUsdt(quote: ShadowQuote, ask: number, bid: number, networkUsdt: number, hedgeFeeBps: number): number {
  const fee = hedgeFeeBps / 10_000;
  return quote.side === "sell" ? quote.usdt - quote.hsk * ask * (1 + fee) - networkUsdt : quote.hsk * bid * (1 - fee) - quote.usdt - networkUsdt;
}

export interface ShadowOptions {
  hedgeFeeBps: number;
  /** Arms that see an opportunity, wait this long, check again, and trade only if it still pays. */
  delaysMs: readonly number[];
  /** How long the close on the outside venue takes after the swap. */
  hedgeLagMs: number;
  /** A larger hole between samples ends an opportunity, because nothing is known inside it. */
  maxGapMs: number;
  maxMarkAgeMs: number;
  maxTwapDeviation: number;
}

export const SHADOW_DEFAULTS: ShadowOptions = { hedgeFeeBps: 20, delaysMs: [0, 2_000, 5_000, 10_000], hedgeLagMs: 2_000, maxGapMs: 5_000, maxMarkAgeMs: 3_000, maxTwapDeviation: 200 };

export interface ShadowRow {
  side: "sell" | "buy";
  sizeUsdt: number;
  samples: number;
  samplesProfitable: number;
  /** One simulated fill per opportunity: a real fill would close the gap, so later samples of it are not more profit. */
  opportunities: number;
  lifetimeMsP50: number | null;
  /** Each arm's total, with how many of its opportunities still paid when it acted. */
  arms: Array<{ delayMs: number; netUsdt: number; trades: number; unknown: number }>;
  /** The act-now arm, closed on the outside venue after the lag, at the prices then. Can be negative. */
  afterHedgeLag: { netUsdt: number; worst: number | null; losers: number; trades: number };
}

export interface ShadowReport {
  samples: number;
  usable: number;
  hours: number;
  blocks: number;
  spreadBps: { p10: number; p50: number; p90: number } | null;
  decisions: Record<string, number>;
  rows: ShadowRow[];
}

export function analyzeShadow(all: readonly ShadowSample[], options: ShadowOptions = SHADOW_DEFAULTS): ShadowReport {
  const usable = all.filter((s) => s.markAgeMs <= options.maxMarkAgeMs && s.twapDeviation <= options.maxTwapDeviation);
  const decisions: Record<string, number> = {};
  for (const sample of all) decisions[sample.decision] = (decisions[sample.decision] ?? 0) + 1;
  const spreads = usable.map((s) => (s.spot / ((s.ask + s.bid) / 2) - 1) * 10_000);
  const keys = new Map<string, { side: "sell" | "buy"; sizeUsdt: number }>();
  for (const sample of usable) for (const quote of sample.quotes) keys.set(`${quote.side}:${quote.sizeUsdt}`, { side: quote.side, sizeUsdt: quote.sizeUsdt });
  return {
    samples: all.length,
    usable: usable.length,
    hours: all.length > 1 ? (all.at(-1)!.atMs - all[0]!.atMs) / 3_600_000 : 0,
    blocks: new Set(all.map((s) => s.block)).size,
    spreadBps: spreads.length ? { p10: nearestRank(spreads, 0.1), p50: nearestRank(spreads, 0.5), p90: nearestRank(spreads, 0.9) } : null,
    decisions,
    rows: [...keys.values()].sort((a, b) => a.sizeUsdt - b.sizeUsdt || a.side.localeCompare(b.side)).map(({ side, sizeUsdt }) => analyzeRow(usable, side, sizeUsdt, options)),
  };
}

function analyzeRow(samples: readonly ShadowSample[], side: "sell" | "buy", sizeUsdt: number, options: ShadowOptions): ShadowRow {
  const series = samples.flatMap((sample) => {
    const quote = sample.quotes.find((q) => q.side === side && q.sizeUsdt === sizeUsdt);
    return quote ? [{ sample, quote, net: netUsdt(quote, sample.ask, sample.bid, sample.networkUsdt, options.hedgeFeeBps) }] : [];
  });
  const opportunities: Array<{ start: number; end: number }> = [];
  let open: { start: number; end: number } | null = null;
  series.forEach((point, i) => {
    const contiguous = i > 0 && point.sample.atMs - series[i - 1]!.sample.atMs <= options.maxGapMs;
    if (open && !(contiguous && point.net > 0)) {
      opportunities.push(open);
      open = null;
    }
    if (point.net > 0) open ??= { start: i, end: i };
    if (open) open.end = i;
  });
  if (open) opportunities.push(open);

  // The first sample at or after a moment, provided nothing unknown lies between.
  const at = (from: number, delayMs: number) => {
    const target = series[from]!.sample.atMs + delayMs;
    for (let i = from; i < series.length; i++) {
      if (i > from && series[i]!.sample.atMs - series[i - 1]!.sample.atMs > options.maxGapMs) return null;
      if (series[i]!.sample.atMs >= target) return series[i]!;
    }
    return null;
  };

  const arms = options.delaysMs.map((delayMs) => {
    let net = 0;
    let trades = 0;
    let unknown = 0;
    for (const { start } of opportunities) {
      const point = at(start, delayMs);
      if (!point) unknown++;
      else if (point.net > 0) {
        net += point.net;
        trades++;
      }
    }
    return { delayMs, netUsdt: net, trades, unknown };
  });

  let hedged = 0;
  let trades = 0;
  let losers = 0;
  let worst: number | null = null;
  for (const { start } of opportunities) {
    const entry = series[start]!;
    const later = at(start, options.hedgeLagMs);
    if (!later) continue;
    const net = netUsdt(entry.quote, later.sample.ask, later.sample.bid, entry.sample.networkUsdt, options.hedgeFeeBps);
    hedged += net;
    trades++;
    if (net < 0) losers++;
    worst = worst === null ? net : Math.min(worst, net);
  }

  const lifetimes = opportunities.map(({ start, end }) => series[end]!.sample.atMs - series[start]!.sample.atMs);
  const lifetime = quantileReport(lifetimes, 0.5);
  return {
    side,
    sizeUsdt,
    samples: series.length,
    samplesProfitable: series.filter((point) => point.net > 0).length,
    opportunities: opportunities.length,
    lifetimeMsP50: lifetime.value,
    arms,
    afterHedgeLag: { netUsdt: hedged, worst, losers, trades },
  };
}
