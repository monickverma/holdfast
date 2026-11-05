import assert from "node:assert/strict";
import { test } from "node:test";
import type { ShadowSample } from "../src/shadow.js";
import {
  arbRoutes,
  arbSampleFromShadow,
  ARB_ATOMIC_GAS,
  atomicGasFor,
  atomicTripCostUsdt,
  ARB_VENUES,
  findOpportunities,
  legCostUsdt,
  MAX_GAP_MS,
  packSample,
  parseArbSamples,
  quoteKey,
  replayArb,
  resolveTrips,
  solidlyAmountOut,
  spotResolver,
  summarizeArb,
  tripCostUsdt,
  v2AmountOut,
  walkRoute,
  type ArbSample,
  type PairReserves,
  type QuoteKey,
} from "../src/arb.js";

test("the Uniswap V2 formula at 0.30% reproduces a real Hyperindex swap to the unit", () => {
  // Block 28913951, pair 0xF836…3AE4: WHSK in, USDT out. Reserves before are the Sync after, less what the swap moved.
  const amountIn = 5_965_116_992_802_736_632n;
  assert.equal(v2AmountOut(amountIn, 423_682_585_232_166_610_435n, 38_667_770n, 3000n), 535_265n);
  // A fee 0.001% either side gives a different answer, so the fee is pinned, not just near.
  assert.equal(v2AmountOut(amountIn, 423_682_585_232_166_610_435n, 38_667_770n, 2990n), 535_270n);
  assert.equal(v2AmountOut(amountIn, 423_682_585_232_166_610_435n, 38_667_770n, 3010n), 535_259n);
});

test("the Solidly volatile formula at 0.20% reproduces a real swap to the unit, fee included", () => {
  // Block 28910007, pair 0x340b…047B. Its Fees event took 18,118,174,775,111,515 wei of WHSK: exactly 0.20% of the input.
  const amountIn = 9_059_087_387_555_757_694n;
  assert.equal((amountIn * 2000n) / 1_000_000n, 18_118_174_775_111_515n);
  assert.equal(solidlyAmountOut(amountIn, 484_590_505_046_926_654_337n, 44_823_321n, 2000n), 820_949n);
  assert.equal(solidlyAmountOut(amountIn, 484_590_505_046_926_654_337n, 44_823_321n, 2010n), 820_940n);
});

test("a pool with nothing in it, or nothing sent to it, pays nothing", () => {
  assert.equal(v2AmountOut(0n, 10n, 10n, 3000n), 0n);
  assert.equal(v2AmountOut(10n, 0n, 10n, 3000n), 0n);
  assert.equal(solidlyAmountOut(10n, 10n, 0n, 2000n), 0n);
});

test("routes: every pair of WHSK/USDT venues both ways, the WETH triangle both ways, and HSKSwap against itself", () => {
  const ids = arbRoutes().map((r) => r.id);
  assert.equal(ids.length, 15);
  assert.ok(ids.includes("hskswap-30>hskswap-30"));
  assert.ok(!ids.includes("solidly-20>solidly-20"));
  assert.ok(ids.includes("hskswap-30>solidly-20") && ids.includes("solidly-20>hskswap-30"));
  for (const route of arbRoutes()) {
    assert.equal(route.legs[0]!.tokenIn, "USDT");
    assert.equal(route.legs.at(-1)!.tokenOut, "USDT");
    for (let i = 1; i < route.legs.length; i++) assert.equal(route.legs[i]!.tokenIn, route.legs[i - 1]!.tokenOut);
    for (const leg of route.legs) {
      const venue = ARB_VENUES.find((v) => v.id === leg.venue)!;
      assert.ok(venue.pair.includes(leg.tokenIn) && venue.pair.includes(leg.tokenOut), `${route.id}: ${leg.venue} does not trade ${leg.tokenIn}/${leg.tokenOut}`);
    }
  }
});

const SOLIDLY: PairReserves = { token0: "WHSK", reserve0: 500n * 10n ** 18n, reserve1: 45_000_000n };
const RESERVES = new Map([["solidly-20", SOLIDLY]]);
const route = arbRoutes().find((r) => r.id === "hskswap-30>solidly-20")!;

test("a trip asks for the quote it needs, and finishes once it has it", () => {
  const quotes = new Map<string, bigint | null>();
  const first = walkRoute(route, 1_000_000n, RESERVES, (key) => quotes.get(quoteKey(key)));
  assert.deepEqual(first, { venue: "hskswap-30", tokenIn: "USDT", amountIn: 1_000_000n });
  quotes.set(quoteKey(first as QuoteKey), 11n * 10n ** 18n);
  const done = walkRoute(route, 1_000_000n, RESERVES, (key) => quotes.get(quoteKey(key)));
  assert.ok(done && !("venue" in done));
  const out = solidlyAmountOut(11n * 10n ** 18n, SOLIDLY.reserve0, SOLIDLY.reserve1, 2000n);
  assert.deepEqual(done.amounts, [11n * 10n ** 18n, out]);
  assert.equal(done.grossUsdt, out - 1_000_000n);
});

test("a refused quote, or a pair whose reserves were not read, ends the trip with no result", () => {
  assert.equal(walkRoute(route, 1_000_000n, RESERVES, () => null), null);
  assert.equal(walkRoute(route, 1_000_000n, new Map(), () => 11n * 10n ** 18n), null);
});

test("resolving every trip asks for each missing quote once, and needs one pass per remote leg", () => {
  const routes = arbRoutes().filter((r) => r.id === "hskswap-30>solidly-20" || r.id === "hskswap-30>hskswap-30");
  const quotes = new Map<string, bigint | null>();
  const resolve = (key: QuoteKey) => quotes.get(quoteKey(key));
  let passes = 0;
  let result = resolveTrips(routes, [1_000_000n], RESERVES, resolve);
  // Both routes start with the same HSKSwap buy, so it is asked for once.
  assert.equal(result.pending.length, 1);
  while (result.pending.length) {
    for (const key of result.pending) quotes.set(quoteKey(key), key.tokenIn === "USDT" ? 11n * 10n ** 18n : 990_000n);
    passes++;
    result = resolveTrips(routes, [1_000_000n], RESERVES, resolve);
  }
  assert.equal(passes, 2);
  assert.equal(result.trips.length, 2);
  // The same pool both ways pays its fee twice, and this one cannot gain.
  assert.equal(result.trips.find((t) => t.route === "hskswap-30>hskswap-30")!.grossUsdt, -10_000n);
});

test("network cost is charged once per leg, at the gas price and the L1 fee, rounded up", () => {
  const cost = { gasPerLeg: 104_740n, gasPriceWei: 500_000_000_000n, l1FeeWei: 25_000_000_000_000n, spotPriceX18: 87_500n };
  // (104,740 × 500 gwei + 0.000025 HSK) × 0.0875 USDT = 0.004584...; up to the next micro-USDT.
  assert.equal(legCostUsdt(cost), 4_585n);
  assert.equal(tripCostUsdt(route, cost), 9_170n);
  const triangle = arbRoutes().find((r) => r.legs.length === 3)!;
  assert.equal(tripCostUsdt(triangle, cost), 13_755n);
});

test("an atomic trip pays one transaction, at the gas of the competitor's real receipt for its pair", () => {
  assert.equal(atomicGasFor("hskswap-30>solidly-20"), ARB_ATOMIC_GAS.solidly);
  assert.equal(atomicGasFor("solidly-20>hyperindex-30"), ARB_ATOMIC_GAS.solidly);
  assert.equal(atomicGasFor("hskswap-30>hyperindex-30"), ARB_ATOMIC_GAS.hyperindex);
  // A venue id that only contains the text is not the Solidly pair.
  assert.equal(atomicGasFor("hskswap-30>notsolidly-20x"), ARB_ATOMIC_GAS.hyperindex);
  const cost = { gasPriceWei: 500_000_000_000n, l1FeeWei: 25_000_000_000_000n, spotPriceX18: 87_500n };
  // (273,775 × 500 gwei + 0.000025 HSK) × 0.0875 USDT = 0.011979...; up to the next micro-USDT.
  assert.equal(atomicTripCostUsdt("hskswap-30>solidly-20", cost), 11_980n);
  // (149,729 × 500 gwei + 0.000025 HSK) × 0.0875 = 0.006552...
  assert.equal(atomicTripCostUsdt("hskswap-30>hyperindex-30", cost), 6_553n);
  // Both are dearer than one plain leg and, for Solidly, dearer than two: atomic saves only on the Hyperindex route.
  assert.ok(atomicTripCostUsdt("hskswap-30>solidly-20", cost) > 2n * legCostUsdt({ ...cost, gasPerLeg: 104_740n }));
  assert.ok(atomicTripCostUsdt("hskswap-30>hyperindex-30", cost) < 2n * legCostUsdt({ ...cost, gasPerLeg: 104_740n }));
});

function sample(atSec: number, nets: Record<string, number>, gross = 0.002): ArbSample {
  return { atMs: atSec * 1000, block: String(atSec), spot: 0.0875, legUsdt: 0.0046, trips: Object.entries(nets).map(([key, netUsdt]) => ({ route: key.split("@")[0]!, sizeUsdt: Number(key.split("@")[1]), grossUsdt: gross, netUsdt })) };
}

test("an opportunity that lasts many samples is one fill, at the size that paid most at its start", () => {
  const samples = [
    sample(0, { "a@1": -0.001 }),
    sample(5, { "a@1": 0.002, "a@5": 0.004 }),
    sample(10, { "a@1": 0.01, "a@5": 0.03 }),
    sample(15, { "a@1": -0.001 }),
  ];
  const found = findOpportunities(samples);
  assert.deepEqual(found, [{ route: "a", sizeUsdt: 5, firstBlock: "5", lastBlock: "10", samples: 2, netUsdt: 0.004 }]);
  const replay = replayArb(samples);
  assert.equal(replay.trades, 1);
  assert.equal(replay.netUsdt, 0.004);
});

test("a hole in the samples ends an opportunity, because nothing is known inside it", () => {
  const gap = MAX_GAP_MS / 1000 + 1;
  const found = findOpportunities([sample(0, { "a@1": 0.002 }), sample(gap, { "a@1": 0.003 })]);
  assert.equal(found.length, 2);
});

test("a minimum above zero is a stricter strategy, and nothing above it means no trade and a result of zero", () => {
  const samples = [sample(0, { "a@1": 0.002 }), sample(5, { "a@1": -0.01 })];
  assert.equal(replayArb(samples, 0).trades, 1);
  const strict = replayArb(samples, 0.005);
  assert.deepEqual([strict.trades, strict.netUsdt, strict.worst], [0, 0, null]);
});

test("the summary counts trips that pay before and after network cost separately", () => {
  const samples = [sample(0, { "a@1": -0.007, "b@1": -0.009 }), sample(5, { "a@1": 0.001, "b@1": -0.009 }, -0.001)];
  const report = summarizeArb(samples);
  assert.equal(report.samples, 2);
  assert.equal(report.samplesWithPositiveGross, 1);
  assert.equal(report.samplesWithPositiveNet, 1);
  assert.deepEqual(report.best, { route: "a", sizeUsdt: 1, grossUsdt: -0.001, netUsdt: 0.001, block: "5" });
  const a = report.rows.find((r) => r.route === "a")!;
  assert.deepEqual([a.samples, a.grossPositive, a.netPositive, a.maxNet], [2, 1, 1, 0.001]);
});

test("a samples file round-trips through its packed form", () => {
  const header = { routes: ["a", "b"], sizesUsdt: [1, 5] };
  const original = sample(3, { "a@1": -0.001, "b@5": 0.002 });
  const text = `${JSON.stringify(header)}\n${JSON.stringify(packSample(original, header))}\n`;
  assert.deepEqual(parseArbSamples(text).samples, [original]);
  assert.throws(() => parseArbSamples(""), /empty/);
});

test("a recorded shadow sample replays with its own HSKSwap quotes, asks for DODO's, and leaves out the WETH routes", () => {
  const shadow: ShadowSample = {
    atMs: 1_000,
    block: "29594849",
    ask: 0.08745,
    bid: 0.08743,
    spot: 0.087587,
    networkUsdt: 0.008759,
    markAgeMs: 0,
    twapDeviation: 0,
    decision: "uneconomic",
    quotes: [
      { side: "sell", sizeUsdt: 1, hsk: 11.417219, usdt: 0.997005 },
      { side: "buy", sizeUsdt: 1, hsk: 11.38284694902855, usdt: 1 },
    ],
  };
  const routes = arbRoutes();
  const { sample, pending } = arbSampleFromShadow(shadow, routes, [1], RESERVES, new Map(), 104_740n);
  // 0.008759 for 200,000 gas is 0.0045872 for 104,740, rounded up to the micro-USDT.
  assert.equal(sample.legUsdt, 0.004588);
  assert.ok(pending.length > 0 && pending.every((k) => k.venue === "dodo-dvm"));
  const bought = 11_382_846_949_028_550_000n;
  const trip = sample.trips.find((t) => t.route === "hskswap-30>solidly-20")!;
  const out = solidlyAmountOut(bought, SOLIDLY.reserve0, SOLIDLY.reserve1, 2000n);
  assert.equal(trip.grossUsdt, Number(out - 1_000_000n) / 1e6);
  assert.equal(trip.netUsdt, Number(out - 1_000_000n - 2n * 4_588n) / 1e6);
  // The same pool both ways: bought at the recorded ask, sold at the recorded bid scaled to the amount.
  const self = sample.trips.find((t) => t.route === "hskswap-30>hskswap-30")!;
  assert.ok(self.grossUsdt < 0);
  assert.ok(!sample.trips.some((t) => t.route.includes("weth")));
  // Hyperindex was not given reserves, so its routes stop there.
  assert.ok(!sample.trips.some((t) => t.route.includes("hyperindex")));
});

test("pricing HSKSwap from spot takes its fee off the input and nothing for impact, and answers for no other venue", () => {
  const resolve = spotResolver(87_500n);
  // 1 USDT less 0.3% is 0.997 USDT, at 0.0875 USDT an HSK.
  assert.equal(resolve({ venue: "hskswap-30", tokenIn: "USDT", amountIn: 1_000_000n }), (997_000n * 10n ** 18n) / 87_500n);
  assert.equal(resolve({ venue: "hskswap-30", tokenIn: "WHSK", amountIn: 10n ** 19n }), 872_375n);
  assert.equal(resolve({ venue: "dodo-dvm", tokenIn: "USDT", amountIn: 1_000_000n }), null);
  assert.equal(spotResolver(0n)({ venue: "hskswap-30", tokenIn: "USDT", amountIn: 1n }), null);
});
