// Round trips between the venues that trade WHSK against USDT on HSK Chain mainnet: buy on one, sell on another, end in
// USDT. Read only. Nothing here signs or sends, and the vault cannot take any of these routes: its router, pool and fee
// are fixed at deployment, so every trade it makes is in the one HSKSwap 0.3% pool.
// Units as in economics.ts: WHSK and WETH in wei, USDT in micro-units. Money arithmetic is integer; the report that
// summarizes samples works in plain numbers, as shadow.ts does, because it never sends anything.
import type { Address } from "viem";
import { MAINNET_MARKET } from "./config.js";
import { scaledQuote } from "./replay.js";
import type { ShadowSample } from "./shadow.js";
import { nearestRank } from "./stats.js";

export type ArbToken = "USDT" | "WHSK" | "WETH";
export const ARB_TOKENS: Record<ArbToken, Address> = {
  USDT: MAINNET_MARKET.usdt,
  WHSK: MAINNET_MARKET.whsk,
  WETH: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0",
};

export type VenueKind = "hskswap-v3" | "uniswap-v2" | "solidly-volatile" | "dodo-dvm";

export interface ArbVenue {
  id: string;
  address: Address;
  kind: VenueKind;
  pair: [ArbToken, ArbToken];
  /** Parts per million of the input, as the venue charges it. */
  feePpm: bigint;
  /** How the address and the fee are known. Every one is a chain read; see evidence/v4/arb-venues-*.json. */
  evidence: string;
}

/** Every venue sampled. Found by scripts/arb-venues.mjs; fees confirmed by reproducing past swaps to the unit. */
export const ARB_VENUES: readonly ArbVenue[] = [
  { id: "hskswap-30", address: MAINNET_MARKET.pool, kind: "hskswap-v3", pair: ["WHSK", "USDT"], feePpm: 3000n, evidence: "HSKSwap factory getPool(WHSK, USDT, 3000); the pool the vault trades in" },
  { id: "dodo-dvm", address: "0xc070B6a1386b0f13Caf24168539C2566Bda11E47", kind: "dodo-dvm", pair: ["WHSK", "USDT"], feePpm: 3000n, evidence: "DODO vending machine, _BASE_TOKEN_ WHSK, _QUOTE_TOKEN_ USDT; quoted by its own querySellBase and querySellQuote, which include its 0.24% LP fee and its maintainer fee" },
  { id: "solidly-20", address: "0x340bDfC78724B3C4E28385462D9A36d469ad047B", kind: "solidly-volatile", pair: ["WHSK", "USDT"], feePpm: 2000n, evidence: "Volatile pair; its Fees event takes 0.20% of input, and that reproduces its swap in block 28910007 exactly" },
  { id: "hyperindex-30", address: "0xF8365695ccC4FCa53241d7d42BbDc3b2e7d43AE4", kind: "uniswap-v2", pair: ["WHSK", "USDT"], feePpm: 3000n, evidence: "Hyperindex factory 0x09ee…20D2; 0.30% reproduces its swaps in blocks 28907807 and 28913951" },
  { id: "hyperindex-weth-30", address: "0x711d26AA3ff64dd9Dc5FA22B7c64C26c1b28f8f2", kind: "uniswap-v2", pair: ["WHSK", "WETH"], feePpm: 3000n, evidence: "Hyperindex factory; 0.30% reproduces its swap in block 29495838" },
  { id: "hskswap-weth-30", address: "0xb92b79ed6b370D5cFee2E14B1D0983C258304C16", kind: "hskswap-v3", pair: ["WETH", "USDT"], feePpm: 3000n, evidence: "HSKSwap factory getPool(WETH, USDT, 3000)" },
];

/** Found, and left out of the samples, with why. */
export const ARB_NOT_SAMPLED = [
  { address: "0x1506de22674dfB4f5A757CE525b22B97560a8D4A", what: "WHSK/USDT 0.25% concentrated-liquidity pool on factory 0x4851…21ee", why: "No quoter on chain names that factory, and the pool holds 0.17 USDT, less than the smallest size sampled" },
  { address: "0xA2F4C3ede0bf2016eDAc7F2419aC8BEF6A6b20B5", what: "WHSK/WETH 0.25% concentrated-liquidity pool on the same factory", why: "No quoter for that factory; it holds 2,959 WHSK and 0.0099 WETH" },
  { address: "0xB580D654cE892181937Aac80EA165950CB7D0E02", what: "WHSK/USDC.e 0.3% on HSKSwap", why: "Holds 0.08 USDC.e, and no USDC.e/USDT pool exists on HSKSwap to close through" },
] as const;

/** The median HSKSwap router swap on a mainnet fork, router alone, no vault: evidence/v3/gas-compare.json. */
export const ARB_GAS_PER_LEG = 104_740n;

export const venueById = (id: string): ArbVenue => {
  const venue = ARB_VENUES.find((v) => v.id === id);
  if (!venue) throw new Error(`unknown venue ${id}`);
  return venue;
};

export interface ArbLeg {
  venue: string;
  tokenIn: ArbToken;
  tokenOut: ArbToken;
}

export interface ArbRoute {
  id: string;
  legs: ArbLeg[];
}

const WHSK_USDT = ["hskswap-30", "dodo-dvm", "solidly-20", "hyperindex-30"];

/**
 * Every two-venue round trip for the pair, buying WHSK on one and selling it on another, both ways round the WETH
 * triangle, and the HSKSwap pool against itself, which is the closing leg the agent already has. That last one can
 * only lose its two fees, so it checks the arithmetic.
 */
export function arbRoutes(): ArbRoute[] {
  const routes: ArbRoute[] = [];
  for (const buy of WHSK_USDT) {
    for (const sell of WHSK_USDT) {
      if (buy === sell && buy !== "hskswap-30") continue;
      routes.push({ id: `${buy}>${sell}`, legs: [{ venue: buy, tokenIn: "USDT", tokenOut: "WHSK" }, { venue: sell, tokenIn: "WHSK", tokenOut: "USDT" }] });
    }
  }
  routes.push({
    id: "hskswap-weth-30>hyperindex-weth-30>hskswap-30",
    legs: [
      { venue: "hskswap-weth-30", tokenIn: "USDT", tokenOut: "WETH" },
      { venue: "hyperindex-weth-30", tokenIn: "WETH", tokenOut: "WHSK" },
      { venue: "hskswap-30", tokenIn: "WHSK", tokenOut: "USDT" },
    ],
  });
  routes.push({
    id: "hskswap-30>hyperindex-weth-30>hskswap-weth-30",
    legs: [
      { venue: "hskswap-30", tokenIn: "USDT", tokenOut: "WHSK" },
      { venue: "hyperindex-weth-30", tokenIn: "WHSK", tokenOut: "WETH" },
      { venue: "hskswap-weth-30", tokenIn: "WETH", tokenOut: "USDT" },
    ],
  });
  return routes;
}

const PPM = 1_000_000n;

/** Uniswap V2: the fee comes off the input inside the product. Rounded down, as the pair's own getAmountOut is. */
export function v2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feePpm: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const withFee = amountIn * (PPM - feePpm);
  return (withFee * reserveOut) / (reserveIn * PPM + withFee);
}

/** A Solidly volatile pair: the fee is taken from the input first, then x·y = k on what is left. */
export function solidlyAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feePpm: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const net = amountIn - (amountIn * feePpm) / PPM;
  return (net * reserveOut) / (reserveIn + net);
}

/** A constant-product pair's reserves, in the order of its own token0 and token1. */
export interface PairReserves {
  token0: ArbToken;
  reserve0: bigint;
  reserve1: bigint;
}

/** True for venues whose output this code computes from reserves, so it needs no call to quote. */
export const isLocal = (venue: ArbVenue): boolean => venue.kind === "uniswap-v2" || venue.kind === "solidly-volatile";

export function localAmountOut(venue: ArbVenue, reserves: PairReserves, tokenIn: ArbToken, amountIn: bigint): bigint {
  const [reserveIn, reserveOut] = reserves.token0 === tokenIn ? [reserves.reserve0, reserves.reserve1] : [reserves.reserve1, reserves.reserve0];
  return venue.kind === "solidly-volatile" ? solidlyAmountOut(amountIn, reserveIn, reserveOut, venue.feePpm) : v2AmountOut(amountIn, reserveIn, reserveOut, venue.feePpm);
}

export interface QuoteKey {
  venue: string;
  tokenIn: ArbToken;
  amountIn: bigint;
}

export const quoteKey = (q: QuoteKey): string => `${q.venue}:${q.tokenIn}:${q.amountIn}`;

/** A venue's answer for a quote: an amount out, null if it refused, or undefined if nobody has asked it yet. */
export type Resolve = (key: QuoteKey) => bigint | null | undefined;

export interface TripResult {
  route: string;
  sizeUsdt: bigint;
  /** Each leg's output in turn; the last is USDT. */
  amounts: bigint[];
  /** USDT out less USDT in, before network cost. */
  grossUsdt: bigint;
}

/**
 * Walks a route from `sizeUsdt`. Returns the result, or the one quote it still needs to go on. A refused quote, or a
 * pair with no reserves read, returns null. Run it again once the missing quote is known, until it finishes.
 */
export function walkRoute(route: ArbRoute, sizeUsdt: bigint, reserves: ReadonlyMap<string, PairReserves>, resolve: Resolve): TripResult | QuoteKey | null {
  let amount = sizeUsdt;
  const amounts: bigint[] = [];
  for (const leg of route.legs) {
    const venue = venueById(leg.venue);
    if (isLocal(venue)) {
      const pair = reserves.get(venue.id);
      if (!pair) return null;
      amount = localAmountOut(venue, pair, leg.tokenIn, amount);
    } else {
      const key = { venue: venue.id, tokenIn: leg.tokenIn, amountIn: amount };
      const quoted = resolve(key);
      if (quoted === undefined) return key;
      if (quoted === null) return null;
      amount = quoted;
    }
    if (amount <= 0n) return null;
    amounts.push(amount);
  }
  return { route: route.id, sizeUsdt, amounts, grossUsdt: amount - sizeUsdt };
}

/**
 * Every route at every size, as far as the quotes known so far allow. `pending` is each quote still needed, once:
 * read them, and call this again, until nothing is pending. A route needs one more pass for each leg.
 */
export function resolveTrips(routes: readonly ArbRoute[], sizesUsdt: readonly bigint[], reserves: ReadonlyMap<string, PairReserves>, resolve: Resolve): { trips: TripResult[]; pending: QuoteKey[] } {
  const trips: TripResult[] = [];
  const pending = new Map<string, QuoteKey>();
  for (const route of routes) {
    for (const size of sizesUsdt) {
      const result = walkRoute(route, size, reserves, resolve);
      if (!result) continue;
      if ("venue" in result) pending.set(quoteKey(result), result);
      else trips.push(result);
    }
  }
  return { trips, pending: [...pending.values()] };
}

/** What each swap costs on chain, in USDT micro-units at the given spot. Rounded up, against the trade. */
export interface LegCost {
  gasPerLeg: bigint;
  gasPriceWei: bigint;
  l1FeeWei: bigint;
  /** HSKSwap spot: micro-USDT per 1e18 wei of HSK, as spotPriceX18 in reader.ts. */
  spotPriceX18: bigint;
}

export function legCostUsdt(cost: LegCost): bigint {
  const wei = cost.gasPerLeg * cost.gasPriceWei + cost.l1FeeWei;
  return (wei * cost.spotPriceX18 + 10n ** 18n - 1n) / 10n ** 18n;
}

/** One transaction per leg, as an agent key without a contract of its own would send them. */
export const tripCostUsdt = (route: ArbRoute, cost: LegCost): bigint => BigInt(route.legs.length) * legCostUsdt(cost);

/**
 * Every leg in one transaction, at the gas another contract really used for it on 5 November 2026: 0x4bca…90ac through
 * the Solidly pair and 0x3aac…d663 through the Hyperindex pair. Their receipts, not our estimate.
 */
export const ARB_ATOMIC_GAS = { solidly: 273_775n, hyperindex: 149_729n } as const;

/** A route through the Solidly pair is charged its figure, the higher one; any other route the Hyperindex figure. */
export const atomicGasFor = (routeId: string): bigint => (routeId.split(">").includes("solidly-20") ? ARB_ATOMIC_GAS.solidly : ARB_ATOMIC_GAS.hyperindex);

/** One transaction for the whole trip, as a contract of our own would send it. */
export const atomicTripCostUsdt = (routeId: string, cost: Omit<LegCost, "gasPerLeg">): bigint => legCostUsdt({ ...cost, gasPerLeg: atomicGasFor(routeId) });

/** The gas the shadow run's recorded network cost was for: GAS_ESTIMATE in decide.ts. */
const SHADOW_GAS = 200_000n;

/**
 * One recorded shadow sample as an arb sample. HSKSwap legs come from the quotes recorded then, scaled to the amount the
 * way replay.ts scales them. Constant-product legs use `reserves` and DODO legs `dodo`, both read later, so this is
 * valid only for venues whose state did not change between the sample and that read. Routes through WETH come out
 * empty, because the WETH pool was not recorded. `pending` is each DODO quote still to read.
 */
export function arbSampleFromShadow(
  shadow: ShadowSample,
  routes: readonly ArbRoute[],
  sizesUsdt: readonly number[],
  reserves: ReadonlyMap<string, PairReserves>,
  dodo: ReadonlyMap<string, bigint | null>,
  gasPerLeg: bigint,
): { sample: ArbSample; pending: QuoteKey[] } {
  const resolve: Resolve = (key) => {
    if (key.venue === "hskswap-30") return scaledQuote(shadow, { tokenIn: ARB_TOKENS[key.tokenIn], amountIn: key.amountIn })?.amountOut ?? null;
    if (key.venue === "dodo-dvm") return dodo.get(quoteKey(key));
    return null;
  };
  const { trips, pending } = resolveTrips(routes, sizesUsdt.map((s) => BigInt(Math.round(s * 1e6))), reserves, resolve);
  // The recorded cost is for 200,000 gas plus one L1 fee; scaling the whole of it scales the L1 fee too, which is small.
  const legMicro = (BigInt(Math.round(shadow.networkUsdt * 1e6)) * gasPerLeg + SHADOW_GAS - 1n) / SHADOW_GAS;
  const byId = new Map(routes.map((r) => [r.id, r]));
  return {
    sample: {
      atMs: shadow.atMs,
      block: shadow.block,
      spot: shadow.spot,
      legUsdt: Number(legMicro) / 1e6,
      trips: trips.map((t) => ({ route: t.route, sizeUsdt: Number(t.sizeUsdt) / 1e6, grossUsdt: Number(t.grossUsdt) / 1e6, netUsdt: Number(t.grossUsdt - BigInt(byId.get(t.route)!.legs.length) * legMicro) / 1e6 })),
    },
    pending,
  };
}

/**
 * HSKSwap's leg priced from its spot alone: the fee comes off the input and nothing is lost to impact. A real quote is
 * worse by the impact, so this flatters a trip. For history, where only each swap's closing price is on chain.
 */
export function spotResolver(spotPriceX18: bigint, feePpm = 3000n): Resolve {
  return (key) => {
    if (key.venue !== "hskswap-30" || spotPriceX18 <= 0n) return null;
    const afterFee = (key.amountIn * (PPM - feePpm)) / PPM;
    return key.tokenIn === "USDT" ? (afterFee * 10n ** 18n) / spotPriceX18 : (afterFee * spotPriceX18) / 10n ** 18n;
  };
}

// ---- The report, over recorded samples. Plain numbers from here on.

export interface ArbTrip {
  route: string;
  sizeUsdt: number;
  grossUsdt: number;
  netUsdt: number;
}

export interface ArbSample {
  atMs: number;
  block: string;
  /** HSKSwap spot, USDT per HSK. */
  spot: number;
  /** Network cost of one leg, USDT. */
  legUsdt: number;
  /** What that cost was made of: the block's base fee plus the priority fee, and the L1 data fee, in wei. */
  gasPriceWei?: string;
  l1FeeWei?: string;
  trips: ArbTrip[];
}

/**
 * A sample as written to disk: each trip is [route index, size index, gross, net], against the header line that names
 * the routes and sizes, because a row of objects for every trip in every sample makes the file several times larger.
 */
export interface PackedSample extends Omit<ArbSample, "trips"> {
  t: Array<[number, number, number, number]>;
}

export interface ArbHeader {
  routes: string[];
  sizesUsdt: number[];
}

export function packSample(sample: ArbSample, header: ArbHeader): PackedSample {
  const { trips, ...rest } = sample;
  return { ...rest, t: trips.map((t) => [header.routes.indexOf(t.route), header.sizesUsdt.indexOf(t.sizeUsdt), t.grossUsdt, t.netUsdt]) };
}

export function unpackSample(packed: PackedSample, header: ArbHeader): ArbSample {
  const { t, ...rest } = packed;
  return { ...rest, trips: t.map(([r, s, grossUsdt, netUsdt]) => ({ route: header.routes[r]!, sizeUsdt: header.sizesUsdt[s]!, grossUsdt, netUsdt })) };
}

/** Reads a samples file: its first line is the header, every other line a packed sample. */
export function parseArbSamples(text: string): { header: ArbHeader; samples: ArbSample[] } {
  const [first, ...lines] = text.split("\n").filter(Boolean);
  if (!first) throw new Error("empty samples file");
  const header = JSON.parse(first) as ArbHeader;
  if (!Array.isArray(header.routes) || !Array.isArray(header.sizesUsdt)) throw new Error("samples file has no header");
  return { header, samples: lines.map((line) => unpackSample(JSON.parse(line) as PackedSample, header)) };
}

export interface ArbRow {
  route: string;
  sizeUsdt: number;
  samples: number;
  grossPositive: number;
  netPositive: number;
  maxGross: number;
  maxNet: number;
  medianNet: number;
}

export interface ArbOpportunity {
  route: string;
  sizeUsdt: number;
  firstBlock: string;
  lastBlock: string;
  samples: number;
  /** The net of its first sample: a real fill would close the gap, so the samples after it are not more profit. */
  netUsdt: number;
}

export interface ArbReport {
  samples: number;
  hours: number;
  blocks: number;
  legUsdt: { p10: number; p50: number; p90: number } | null;
  /** Samples in which any route at any size netted above zero after network cost. */
  samplesWithPositiveNet: number;
  samplesWithPositiveGross: number;
  best: (ArbTrip & { block: string }) | null;
  rows: ArbRow[];
  opportunities: ArbOpportunity[];
}

/** A larger hole between samples ends an opportunity, because nothing is known inside it. */
export const MAX_GAP_MS = 30_000;

export function summarizeArb(samples: readonly ArbSample[], minNetUsdt = 0): ArbReport {
  const keys = new Map<string, { route: string; sizeUsdt: number }>();
  for (const s of samples) for (const t of s.trips) keys.set(`${t.route}@${t.sizeUsdt}`, { route: t.route, sizeUsdt: t.sizeUsdt });
  const rows: ArbRow[] = [...keys.values()].map(({ route, sizeUsdt }) => {
    const trips = samples.flatMap((s) => s.trips.filter((t) => t.route === route && t.sizeUsdt === sizeUsdt));
    const nets = trips.map((t) => t.netUsdt);
    return {
      route,
      sizeUsdt,
      samples: trips.length,
      grossPositive: trips.filter((t) => t.grossUsdt > 0).length,
      netPositive: trips.filter((t) => t.netUsdt > minNetUsdt).length,
      maxGross: Math.max(...trips.map((t) => t.grossUsdt)),
      maxNet: Math.max(...nets),
      medianNet: nearestRank(nets, 0.5),
    };
  });
  rows.sort((a, b) => b.maxNet - a.maxNet);

  let best: ArbReport["best"] = null;
  for (const s of samples) for (const t of s.trips) if (!best || t.netUsdt > best.netUsdt) best = { ...t, block: s.block };
  const legs = samples.map((s) => s.legUsdt);
  return {
    samples: samples.length,
    hours: samples.length > 1 ? (samples.at(-1)!.atMs - samples[0]!.atMs) / 3_600_000 : 0,
    blocks: new Set(samples.map((s) => s.block)).size,
    legUsdt: legs.length ? { p10: nearestRank(legs, 0.1), p50: nearestRank(legs, 0.5), p90: nearestRank(legs, 0.9) } : null,
    samplesWithPositiveNet: samples.filter((s) => s.trips.some((t) => t.netUsdt > minNetUsdt)).length,
    samplesWithPositiveGross: samples.filter((s) => s.trips.some((t) => t.grossUsdt > 0)).length,
    best,
    rows,
    opportunities: findOpportunities(samples, minNetUsdt),
  };
}

/**
 * Runs of consecutive samples in which some trip nets above the minimum. Each run is one opportunity, taken at its
 * first sample at the size that paid most then, because a real fill would close the gap.
 */
export function findOpportunities(samples: readonly ArbSample[], minNetUsdt = 0): ArbOpportunity[] {
  const out: ArbOpportunity[] = [];
  let open: ArbOpportunity | null = null;
  let previousAt = -Infinity;
  for (const s of samples) {
    const top = s.trips.reduce<ArbTrip | null>((a, t) => (t.netUsdt > minNetUsdt && (!a || t.netUsdt > a.netUsdt) ? t : a), null);
    const contiguous = s.atMs - previousAt <= MAX_GAP_MS;
    previousAt = s.atMs;
    if (open && (!top || !contiguous)) {
      out.push(open);
      open = null;
    }
    if (!top) continue;
    if (open) {
      open.lastBlock = s.block;
      open.samples++;
    } else open = { route: top.route, sizeUsdt: top.sizeUsdt, firstBlock: s.block, lastBlock: s.block, samples: 1, netUsdt: top.netUsdt };
  }
  if (open) out.push(open);
  return out;
}

export interface ArbReplay {
  minNetUsdt: number;
  trades: number;
  /** USDT, after network cost. A replay's result, not money earned. */
  netUsdt: number;
  worst: number | null;
  fills: ArbOpportunity[];
}

/** The strategy, replayed: take each opportunity once, at its first sample, if it nets above the minimum. */
export function replayArb(samples: readonly ArbSample[], minNetUsdt = 0): ArbReplay {
  const fills = findOpportunities(samples, minNetUsdt);
  return {
    minNetUsdt,
    trades: fills.length,
    netUsdt: fills.reduce((a, f) => a + f.netUsdt, 0),
    worst: fills.length ? Math.min(...fills.map((f) => f.netUsdt)) : null,
    fills,
  };
}
