import assert from "node:assert/strict";
import { test } from "node:test";
import { HSKSWAP } from "../src/config.js";
import { costLedger, decide, floorOut, plannedQuotes, type DecideInput, type Mark, type OrderRuntime } from "../src/decide.js";
import { DEFAULT_POLICY, type Order, type Policy } from "../src/policy.js";
import type { MarketState, TokenLimits } from "../src/reader.js";

const NOW = 1_800_000_000_000;
const PRICE = 87_400n; // 0.0874 USDT per HSK
const HSK = 10n ** 18n;
const USDT = 10n ** 6n;

const whskLimits: TokenLimits = { balance: 1_000n * HSK, maxTrade: 200n * HSK, remaining: 500n * HSK, floorPriceX18: 50_000n };
const usdtLimits: TokenLimits = { balance: 50n * USDT, maxTrade: 10n * USDT, remaining: 25n * USDT, floorPriceX18: 5n * HSK };

function market(overrides: Partial<MarketState> = {}): MarketState {
  return {
    head: { number: 100n, hash: "0xabc", timestamp: BigInt(NOW / 1000), baseFeePerGas: 500_000_000_000n },
    sqrtPriceX96: 0n,
    tick: -300694,
    twapTick: -300694,
    liquidity: 1n,
    spotPriceX18: PRICE,
    quotes: [],
    priorityFeePerGas: 1_000_000n,
    l1FeeWei: 3_919_085_385_435n,
    vault: { paused: false, whsk: whskLimits, usdt: usdtLimits },
    ...overrides,
  };
}

function sell(amountIn: bigint, amountOut: bigint) {
  return { tokenIn: HSKSWAP.whsk as `0x${string}`, amountIn, amountOut, ticksCrossed: 0 };
}

function buy(amountIn: bigint, amountOut: bigint) {
  return { tokenIn: HSKSWAP.usdt as `0x${string}`, amountIn, amountOut, ticksCrossed: 0 };
}

function input(policy: Partial<Policy>, m: MarketState, extra: Partial<DecideInput> = {}): DecideInput {
  return {
    market: m,
    policy: { ...DEFAULT_POLICY, ...policy },
    mark: null,
    runtime: new Map(),
    nowMs: NOW,
    maxStateAgeMs: 6_000,
    maxMarkAgeMs: 30_000,
    ...extra,
  };
}

const stop: Order = { id: "s1", kind: "stop-loss", amountIn: 100n * HSK, triggerPriceX18: 80_000n };
const limitSell: Order = { id: "l1", kind: "limit-sell", amountIn: 100n * HSK, triggerPriceX18: 90_000n };
const limitBuy: Order = { id: "b1", kind: "limit-buy", amountIn: 5n * USDT, triggerPriceX18: 85_000n };

test("holds with no orders and no edge", () => {
  const d = decide(input({}, market()));
  assert.equal(d.action, "hold");
  if (d.action === "hold") assert.equal(d.code, "no-signal");
});

test("paused vault and stale state refuse before anything else", () => {
  const paused = decide(input({ orders: [stop] }, market({ vault: { paused: true, whsk: whskLimits, usdt: usdtLimits } })));
  assert.equal(paused.action === "hold" && paused.code, "paused");
  const stale = decide(input({ orders: [stop] }, market(), { nowMs: NOW + 6_001 }));
  assert.equal(stale.action === "hold" && stale.code, "stale-state");
});

test("stop-loss waits for confirmation, then fires with no model and no reference price", () => {
  const m = market({ spotPriceX18: 79_000n, quotes: [sell(100n * HSK, 7_800_000n)] });
  const first = decide(input({ orders: [stop] }, m));
  assert.equal(first.action === "hold" && first.code, "stop-unconfirmed");

  const runtime = new Map<string, OrderRuntime>([["s1", { filled: 0n, hitStreak: 1 }]]);
  const second = decide(input({ orders: [stop] }, m, { runtime }));
  assert.equal(second.action, "trade");
  if (second.action === "trade") {
    assert.equal(second.trigger, "stop-loss");
    assert.equal(second.amountIn, 100n * HSK);
    assert.equal(second.minOut, (7_800_000n * 9950n) / 10000n);
  }
});

test("stop-loss above trigger is idle and reports no problem", () => {
  const d = decide(input({ orders: [stop] }, market({ quotes: [sell(100n * HSK, 8_700_000n)] })));
  assert.equal(d.action === "hold" && d.code, "no-signal");
});

test("a stop-loss below the owner's floor refuses instead of sending a doomed transaction", () => {
  const m = market({ spotPriceX18: 40_000n, quotes: [sell(100n * HSK, 4_000_000n)] });
  const runtime = new Map<string, OrderRuntime>([["s1", { filled: 0n, hitStreak: 1 }]]);
  const d = decide(input({ orders: [stop] }, m, { runtime }));
  assert.equal(d.action === "hold" && d.code, "below-floor");
});

test("minOut never falls below the vault floor, whatever the slippage setting", () => {
  const amountIn = 100n * HSK;
  const quoted = floorOut(amountIn, whskLimits.floorPriceX18) + 1n;
  const runtime = new Map<string, OrderRuntime>([["s1", { filled: 0n, hitStreak: 5 }]]);
  const m = market({ spotPriceX18: 50_000n, quotes: [sell(amountIn, quoted)] });
  const d = decide(input({ orders: [stop], slippageBps: 500 }, m, { runtime }));
  assert.equal(d.action, "trade");
  if (d.action === "trade") assert.equal(d.minOut, floorOut(amountIn, whskLimits.floorPriceX18));
});

test("limit sell fires on its execution price, not spot", () => {
  const belowAfterFee = market({ spotPriceX18: 90_500n, quotes: [sell(100n * HSK, 8_950_000n)] });
  assert.equal(decide(input({ orders: [limitSell] }, belowAfterFee)).action, "hold");
  const reached = market({ spotPriceX18: 91_000n, quotes: [sell(100n * HSK, 9_050_000n)] });
  const d = decide(input({ orders: [limitSell] }, reached));
  assert.equal(d.action === "trade" && d.trigger, "limit");
});

test("limit buy fires when the fill price is at or under the trigger", () => {
  const notYet = market({ quotes: [buy(5n * USDT, 57n * HSK)] }); // 87,719 per HSK
  assert.equal(decide(input({ orders: [limitBuy] }, notYet)).action, "hold");
  const reached = market({ quotes: [buy(5n * USDT, 60n * HSK)] }); // 83,333 per HSK
  assert.equal(decide(input({ orders: [limitBuy] }, reached)).action, "trade");
});

test("a limit refuses when spot has been pushed far from TWAP", () => {
  const m = market({ tick: -300000, twapTick: -300694, quotes: [sell(100n * HSK, 9_050_000n)] });
  const d = decide(input({ orders: [limitSell] }, m));
  assert.equal(d.action === "hold" && d.code, "price-deviation");
});

test("tranches clamp to the trade cap, and fills reduce what remains", () => {
  const big: Order = { id: "m1", kind: "market-sell", amountIn: 300n * HSK };
  assert.equal(plannedQuotes({ ...DEFAULT_POLICY, orders: [big] }, market(), new Map())[0]!.amountIn, 200n * HSK);
  const runtime = new Map<string, OrderRuntime>([["m1", { filled: 200n * HSK, hitStreak: 0 }]]);
  assert.equal(plannedQuotes({ ...DEFAULT_POLICY, orders: [big] }, market(), runtime)[0]!.amountIn, 100n * HSK);
});

test("a completed order stops trading", () => {
  const order: Order = { id: "m1", kind: "market-sell", amountIn: 10n * HSK };
  const runtime = new Map<string, OrderRuntime>([["m1", { filled: 10n * HSK, hitStreak: 0 }]]);
  const d = decide(input({ orders: [order] }, market(), { runtime }));
  assert.equal(d.action, "hold");
  assert.equal(plannedQuotes({ ...DEFAULT_POLICY, orders: [order] }, market(), runtime).length, 0);
});

test("exhausted lifetime cap refuses with that reason", () => {
  const m = market({ vault: { paused: false, whsk: { ...whskLimits, remaining: 0n }, usdt: usdtLimits } });
  const d = decide(input({ orders: [{ id: "m1", kind: "market-sell", amountIn: HSK }] }, m));
  assert.equal(d.action === "hold" && d.code, "cap-exhausted");
});

test("a quote for a different size is never used", () => {
  const m = market({ quotes: [sell(99n * HSK, 8_700_000n)] });
  const d = decide(input({ orders: [{ id: "m1", kind: "market-sell", amountIn: 100n * HSK }] }, m));
  assert.equal(d.action === "hold" && d.code, "requote");
});

// The abstention rule

const mark: Mark = { askX18: 87_500n, bidX18: 87_300n, fetchedAtMs: NOW };
const edgePolicy = { edge: { enabled: true, sizeUsdt: 10n * USDT, minNetUsdt: 0n } };
const edgeSell = (10n * USDT * HSK) / PRICE;

test("edge abstains when the pool fee eats the difference", () => {
  // Pool and reference agree, so either direction loses the 0.3% fee and gas.
  const m = market({ quotes: [sell(edgeSell, 9_970_000n), buy(10n * USDT, (9_970_000n * HSK) / PRICE)] });
  const d = decide(input(edgePolicy, m, { mark }));
  assert.equal(d.action === "hold" && d.code, "uneconomic");
  if (d.action === "hold") assert.ok(d.ledger!.net! < 0n);
});

test("edge trades only when the conservative net is positive", () => {
  // The pool pays 2% over the reference.
  const m = market({ quotes: [sell(edgeSell, 10_200_000n), buy(10n * USDT, (9_700_000n * HSK) / PRICE)] });
  const d = decide(input(edgePolicy, m, { mark }));
  assert.equal(d.action, "trade");
  if (d.action === "trade") {
    assert.equal(d.tokenIn, HSKSWAP.whsk);
    assert.ok(d.ledger.net! > 0n);
  }
});

test("edge refuses on a stale or missing reference", () => {
  const m = market({ quotes: [sell(edgeSell, 10_200_000n)] });
  const none = decide(input(edgePolicy, m));
  assert.equal(none.action === "hold" && none.code, "stale-mark");
  const old = decide(input(edgePolicy, m, { mark: { ...mark, fetchedAtMs: NOW - 30_001 } }));
  assert.equal(old.action === "hold" && old.code, "stale-mark");
});

test("the ledger charges both sides at the mark least favourable to the trade", () => {
  const selling = costLedger(HSKSWAP.whsk, HSK, 87_400n, market(), mark);
  assert.equal(selling.inputValue, 87_500n);
  const buying = costLedger(HSKSWAP.usdt, 87_400n, HSK, market(), mark);
  assert.equal(buying.outputValue, 87_300n);
  assert.ok(selling.networkCost > 0n);
});
