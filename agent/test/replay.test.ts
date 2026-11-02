// The replay harness: recorded samples become markets decide() can read, and a round trip in one pool is accounted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HSKSWAP } from "../src/config.js";
import { networkCostUsdt } from "../src/decide.js";
import { DEFAULT_AI, DEFAULT_POLICY, type Policy } from "../src/policy.js";
import { marketFromSample, replayStrategy, scaledQuote } from "../src/replay.js";
import type { ShadowQuote, ShadowSample } from "../src/shadow.js";
import { Strategist } from "../src/strategist.js";

const HSK = 10n ** 18n;
const USDT = 10n ** 6n;
const at = 1_800_000_000_000;

function sample(i: number, spot: number, quotes: ShadowQuote[], ask = 0.0875, bid = 0.0873): ShadowSample {
  return { atMs: at + i * 2_000, block: String(1_000 + i), ask, bid, spot, networkUsdt: 0.0088, markAgeMs: 300, twapDeviation: 0, decision: "recorded", quotes };
}
const fair = [
  { side: "buy", sizeUsdt: 15, hsk: 171, usdt: 15 },
  { side: "sell", sizeUsdt: 15, hsk: 171.6, usdt: 14.9 },
  { side: "sell", sizeUsdt: 50, hsk: 572, usdt: 49.7 },
] as ShadowQuote[];
// The pool sells cheap: 15 USDT buys 175 HSK, worth 15.28 at the outside bid.
const cheap = [{ side: "buy", sizeUsdt: 15, hsk: 175, usdt: 15 }, ...fair.slice(1)] as ShadowQuote[];

test("a sample becomes a market whose network cost is the one recorded", () => {
  const m = marketFromSample(sample(0, 0.0874, fair), []);
  assert.equal(m.spotPriceX18, 87_400n);
  assert.equal(m.head.number, 1_000n);
  assert.ok(networkCostUsdt(m) >= 8_799n && networkCostUsdt(m) <= 8_800n);
});

test("an unrecorded size is scaled from the next larger one on its side, and a larger one has no quote", () => {
  const q = scaledQuote(sample(0, 0.0874, fair), { tokenIn: HSKSWAP.whsk, amountIn: 200n * HSK })!;
  assert.equal(q.amountOut, (200n * HSK * 49_700_000n) / (572n * HSK), "scaled from the $50 row, not the $15 one");
  assert.equal(scaledQuote(sample(0, 0.0874, fair), { tokenIn: HSKSWAP.whsk, amountIn: 600n * HSK }), null);
  assert.equal(scaledQuote(sample(0, 0.0874, fair), { tokenIn: HSKSWAP.usdt, amountIn: 5n * USDT })!.amountOut, (5n * USDT * 171n * HSK) / (15n * USDT));
});

test("the edge rule buys a cheap pool and, with unwind on, closes the round trip in the same pool at a profit", async () => {
  // Back at the usual quotes, selling 175 HSK at the $50 row's 49.7/572 a piece pays more than the 15 USDT it cost.
  const samples = [sample(0, 0.0874, fair), sample(1, 0.0874, cheap), sample(2, 0.0874, fair)];
  const policy: Policy = { ...DEFAULT_POLICY, edge: { enabled: true, sizeUsdt: 15n * USDT, minNetUsdt: 0n, unwind: true } };
  const report = await replayStrategy(samples, policy, { maxMarkAgeMs: 5_000, maxStateAgeMs: 6_000 });
  assert.deepEqual(report.fills.map((f) => [f.block, f.trigger, f.side]), [["1001", "edge", "buy"], ["1002", "unwind", "sell"]]);
  assert.equal(Number(report.openInventoryHsk), 0);
  assert.ok(Math.abs(Number(report.netUsdt) - ((175 * 49.7) / 572 - 15 - 2 * 0.0088)) < 0.0001);
  const without = await replayStrategy(samples, { ...policy, edge: { ...policy.edge, unwind: undefined } }, { maxMarkAgeMs: 5_000, maxStateAgeMs: 6_000 });
  assert.equal(without.fills.length, 1, "without unwind it only buys");
  assert.equal(Number(without.openInventoryHsk), 175, "and is left holding what it bought, valued at the outside bid, which no trade here could get");
});

test("in a replay the model is asked as live, its proposal applies from the next sample, and its trades pass decide()", async () => {
  const replies = [{ action: "buy", sizeUsdt: "15", reason: "pool 200 bps under the bid" }, { action: "hold", sizeUsdt: null, reason: "wait" }];
  let calls = 0;
  const client = { beta: { messages: { create: async () => ({ stop_reason: "end_turn", usage: { cost_usd: 0.001 }, content: [{ type: "text", text: JSON.stringify(replies[Math.min(calls++, 1)]) }] }) } } };
  let clock = at;
  const strategist = new Strategist(client as never, "fake", { maxUsdPerDay: 1, now: () => clock });
  const policy: Policy = { ...DEFAULT_POLICY, ai: { ...DEFAULT_AI, enabled: true, maxSizeUsdt: 15n * USDT, maxInventoryUsdt: 15n * USDT, minBlocksBetweenCalls: 1 } };
  const samples = [sample(0, 0.0874, cheap), sample(1, 0.0874, cheap), sample(2, 0.0874, fair)];
  const report = await replayStrategy(samples, policy, { maxMarkAgeMs: 5_000, maxStateAgeMs: 6_000, strategist, setClock: (ms) => (clock = ms) });
  assert.deepEqual(report.fills.map((f) => [f.block, f.trigger]), [["1001", "model"]]);
  assert.ok(report.model!.asked >= 2);
  assert.equal(report.model!.costUsd, report.model!.asked * 0.001);
});
