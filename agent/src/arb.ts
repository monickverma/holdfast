// Round trips between the venues that trade WHSK against USDT on HSK Chain mainnet: buy on one, sell on another, end in
// USDT. Read only. Nothing here signs or sends, and the vault cannot take any of these routes: its router, pool and fee
// are fixed at deployment, so every trade it makes is in the one HSKSwap 0.3% pool.
// Units as in economics.ts: WHSK and WETH in wei, USDT in micro-units. Money arithmetic is integer; the report that
// summarizes samples works in plain numbers, as shadow.ts does, because it never sends anything.
import type { Address } from "viem";
import { MAINNET_MARKET } from "./config.js";

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
  { address: "0x1506de22674dfB4f5A757CE525b22B97560a8D4A", what: "WHSK/USDT 0.25% concentrated-liquidity pool on factory 0x4851…21ee", why: "No compatible quoter integrated for this factory; prior discovery recorded 0.17 USDT liquidity. Excluded even though some search sizes are smaller." },
  { address: "0xA2F4C3ede0bf2016eDAc7F2419aC8BEF6A6b20B5", what: "WHSK/WETH 0.25% concentrated-liquidity pool on the same factory", why: "No quoter for that factory; it holds 2,959 WHSK and 0.0099 WETH" },
  { address: "0xB580D654cE892181937Aac80EA165950CB7D0E02", what: "WHSK/USDC.e 0.3% on HSKSwap", why: "Holds 0.08 USDC.e, and no USDC.e/USDT pool exists on HSKSwap to close through" },
] as const;

/** The median HSKSwap router swap on a mainnet fork, router alone, no vault: inherited from the original worktree evidence/v3/gas-compare.json. */
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



