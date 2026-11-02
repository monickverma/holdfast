// Each test here failed on the code as it stood before the fix. See docs/ENGINEERING-REPORT.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HSKSWAP } from "../src/config.js";
import { costLedger, decide, type DecideInput, type Mark } from "../src/decide.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy.js";
import type { MarketState, TokenLimits } from "../src/reader.js";

const HSK = 10n ** 18n;
const USDT = 10n ** 6n;
const limits: TokenLimits = { balance: 1_000n * HSK, maxTrade: 1_000n * HSK, remaining: 1_000n * HSK, floorPriceX18: 1n, hourlyBudget: 1_000n * HSK, available: 1_000n * HSK };
const usdtLimits: TokenLimits = { balance: 1_000n * USDT, maxTrade: 1_000n * USDT, remaining: 1_000n * USDT, floorPriceX18: 1n, hourlyBudget: 1_000n * USDT, available: 1_000n * USDT };

function market(buyOut: bigint, spot = 100_000n): MarketState {
  return {
    head: { number: 100n, hash: `0x${"a".repeat(64)}`, timestamp: 100n, baseFeePerGas: 1n },
    sqrtPriceX96: 0n,
    tick: 0,
    twapTick: 0,
    liquidity: 1n,
    spotPriceX18: spot,
    quotes: [
      { tokenIn: HSKSWAP.whsk, amountIn: (15n * USDT * HSK) / spot, amountOut: 14_900_000n, ticksCrossed: 0 },
      { tokenIn: HSKSWAP.usdt, amountIn: 15n * USDT, amountOut: buyOut, ticksCrossed: 0 },
    ],
    priorityFeePerGas: 1n,
    l1FeeWei: 0n,
    vault: { paused: false, agentExpiry: 10_000n, whsk: limits, usdt: usdtLimits },
  };
}
const edgePolicy: Policy = { ...DEFAULT_POLICY, edge: { enabled: true, sizeUsdt: 15n * USDT, minNetUsdt: 0n, maxInventoryUsdt: 100n * USDT } };
const input = (m: MarketState, mark: Mark | null, over: Partial<DecideInput> = {}): DecideInput => ({ market: m, policy: edgePolicy, mark, runtime: new Map(), nowMs: 100_000, maxStateAgeMs: 6_000, maxMarkAgeMs: 5_000, ...over });
const goodMark: Mark = { askX18: 100_300n, bidX18: 100_100n, fetchedAtMs: 100_000 };

test("a crossed outside price cannot create an edge", () => {
  // Same midpoint as the pool, so the agreement check passes, but the ask of 1 values the HSK sold at almost nothing.
  const crossed: Mark = { askX18: 1n, bidX18: 200_000n, fetchedAtMs: 100_000 };
  const decision = decide(input(market(150n * HSK), crossed));
  assert.equal(decision.action, "hold");
  assert.equal(decision.action === "hold" && decision.code, "bad-mark");
});

test("a zero outside price cannot create an edge", () => {
  const decision = decide(input(market(150n * HSK), { askX18: 0n, bidX18: 0n, fetchedAtMs: 100_000 }));
  assert.equal(decision.action, "hold");
});

test("an edge trade's worst allowed fill still clears the required net", () => {
  // The quote nets a few cents, far less than the 50 bps of slippage the policy would otherwise allow.
  const m = market(150_500_000_000_000_000_000n);
  const decision = decide(input(m, goodMark));
  assert.equal(decision.action, "trade");
  if (decision.action !== "trade") return;
  const atQuote = costLedger(decision.tokenIn, decision.amountIn, decision.quotedOut, m, goodMark);
  assert.ok(atQuote.net! > 0n && atQuote.net! < (15n * USDT * 50n) / 10_000n, "the fixture must be a thin edge");
  const atWorst = costLedger(decision.tokenIn, decision.amountIn, decision.minOut, m, goodMark);
  assert.ok(atWorst.net! > edgePolicy.edge.minNetUsdt, `worst allowed fill nets ${atWorst.net}`);
  assert.ok(decision.minOut <= decision.quotedOut, "the trade must still be able to fill at its quote");
});

test("a clock far behind the chain does not make old state look fresh", () => {
  const decision = decide(input(market(150n * HSK), goodMark, { nowMs: 50_000 }));
  assert.equal(decision.action === "hold" && decision.code, "stale-state");
});

test("a market order that would move the pool far from spot holds", () => {
  const amountIn = 10n * HSK;
  const m = market(150n * HSK);
  // 10 HSK at spot is 1 USDT. This quote pays half of that, and the floor of 1 would allow it.
  m.quotes = [{ tokenIn: HSKSWAP.whsk, amountIn, amountOut: 500_000n, ticksCrossed: 40 }];
  const policy: Policy = { ...DEFAULT_POLICY, orders: [{ id: "big", kind: "market-sell", amountIn }] };
  const decision = decide(input(m, null, { policy }));
  assert.equal(decision.action === "hold" && decision.code, "price-impact");
});

test("a stop-loss is not held back by the impact limit: getting out outranks the price", () => {
  const amountIn = 10n * HSK;
  const m = market(150n * HSK);
  m.quotes = [{ tokenIn: HSKSWAP.whsk, amountIn, amountOut: 500_000n, ticksCrossed: 40 }];
  const policy: Policy = { ...DEFAULT_POLICY, stopConfirmBlocks: 1, orders: [{ id: "stop", kind: "stop-loss", amountIn, triggerPriceX18: 200_000n }] };
  const decision = decide(input(m, null, { policy }));
  assert.equal(decision.action, "trade");
});
