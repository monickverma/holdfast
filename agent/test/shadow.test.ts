import assert from "node:assert/strict";
import { test } from "node:test";
import { type Address, type Hex } from "viem";
import { HSKSWAP } from "../src/config.js";
import { costLedger, decide, type Mark } from "../src/decide.js";
import { compareBlock, FrameLedger } from "../src/drift.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import type { MarketState } from "../src/reader.js";
import { analyzeShadow, netUsdt, OPEN_LIMITS, replayEdgeFills, SHADOW_DEFAULTS, toShadowQuote, type ShadowSample } from "../src/shadow.js";
import { decodeFrame, type Frame } from "../src/stream.js";

const E18 = 10n ** 18n;

test("the report's valuation equals the agent's own ledger when the venue charges nothing", () => {
  const mark: Mark = { askX18: 88_000n, bidX18: 87_000n, fetchedAtMs: 0 };
  const market = { head: { baseFeePerGas: 0n }, priorityFeePerGas: 0n, l1FeeWei: 0n, spotPriceX18: 88_000n } as unknown as MarketState;
  for (const [tokenIn, amountIn, amountOut] of [
    [HSKSWAP.whsk, 100n * E18, 8_900_000n],
    [HSKSWAP.usdt, 8_900_000n, 103n * E18],
  ] as Array<[Address, bigint, bigint]>) {
    const ledger = costLedger(tokenIn, amountIn, amountOut, market, mark);
    const quote = toShadowQuote({ tokenIn, amountIn, amountOut, ticksCrossed: 0 }, 9);
    assert.ok(Math.abs(netUsdt(quote, 0.088, 0.087, 0, 0) - Number(ledger.net) / 1e6) < 1e-6);
  }
});

test("the venue's fee is charged on the leg closed there", () => {
  const sell = { side: "sell" as const, sizeUsdt: 10, hsk: 100, usdt: 10 };
  assert.ok(Math.abs(netUsdt(sell, 0.09, 0.09, 0.01, 20) - (10 - 9 * 1.002 - 0.01)) < 1e-9);
  const buy = { side: "buy" as const, sizeUsdt: 10, hsk: 120, usdt: 10 };
  assert.ok(Math.abs(netUsdt(buy, 0.09, 0.09, 0.01, 20) - (120 * 0.09 * 0.998 - 10 - 0.01)) < 1e-9);
});

/** A $10 sell of 100 HSK. An ask below 0.1 pays, and a lower ask pays more. */
function sample(atSec: number, ask: number, overrides: Partial<ShadowSample> = {}): ShadowSample {
  return { atMs: atSec * 1000, block: String(atSec), ask, bid: ask, spot: 0.1, networkUsdt: 0, markAgeMs: 0, twapDeviation: 0, decision: "uneconomic", quotes: [{ side: "sell", sizeUsdt: 10, hsk: 100, usdt: 10 }], ...overrides };
}
const options = { ...SHADOW_DEFAULTS, hedgeFeeBps: 0, delaysMs: [0, 2_000], hedgeLagMs: 2_000 };

test("an opportunity that lasts many samples counts as one fill", () => {
  const report = analyzeShadow([sample(0, 0.11), sample(1, 0.09), sample(2, 0.09), sample(3, 0.09), sample(4, 0.11), sample(5, 0.08), sample(6, 0.11)], options);
  const row = report.rows[0]!;
  assert.equal(row.samplesProfitable, 4);
  assert.equal(row.opportunities, 2);
  // 100 HSK bought back at 0.09 for $9 pays $1, and at 0.08 pays $2.
  assert.ok(Math.abs(row.arms[0]!.netUsdt - 3) < 1e-9);
  assert.equal(row.arms[0]!.trades, 2);
});

test("a waiting arm trades only if the opportunity still pays when it looks again", () => {
  const row = analyzeShadow([sample(0, 0.09), sample(1, 0.09), sample(2, 0.11), sample(3, 0.11)], options).rows[0]!;
  assert.equal(row.arms[0]!.trades, 1);
  assert.equal(row.arms[1]!.trades, 0);
  assert.equal(row.arms[1]!.netUsdt, 0);
});

test("the close uses the later price, so a move against the trade is a loss", () => {
  const row = analyzeShadow([sample(0, 0.09), sample(1, 0.09), sample(2, 0.12)], options).rows[0]!;
  assert.equal(row.afterHedgeLag.trades, 1);
  assert.equal(row.afterHedgeLag.losers, 1);
  assert.ok(Math.abs(row.afterHedgeLag.netUsdt - (10 - 12)) < 1e-9);
});

test("a hole in the samples ends an opportunity, and an arm that cannot see its moment is unknown", () => {
  const row = analyzeShadow([sample(0, 0.09), sample(100, 0.09)], options).rows[0]!;
  assert.equal(row.opportunities, 2);
  assert.equal(row.arms[1]!.unknown, 2);
  assert.equal(row.afterHedgeLag.trades, 0);
});

test("a stale outside price or a price far from TWAP is not usable", () => {
  const report = analyzeShadow([sample(0, 0.09, { markAgeMs: 10_000 }), sample(1, 0.09, { twapDeviation: 500 })], options);
  assert.equal(report.usable, 0);
  assert.equal(report.samples, 2);
  assert.equal(report.rows.length, 0);
});

test("the agent's real decision trades under the shadow's limits when the edge pays", () => {
  const market = {
    head: { number: 1n, hash: "0x", timestamp: 100n, baseFeePerGas: 0n },
    tick: 0,
    twapTick: 0,
    spotPriceX18: 100_000n,
    priorityFeePerGas: 0n,
    l1FeeWei: 0n,
    quotes: [{ tokenIn: HSKSWAP.whsk, amountIn: 150n * E18, amountOut: 15_000_000n, ticksCrossed: 0 }],
    vault: { paused: false, agentExpiry: null, whsk: OPEN_LIMITS, usdt: OPEN_LIMITS },
  } as unknown as MarketState;
  const policy = { ...DEFAULT_POLICY, edge: { enabled: true, sizeUsdt: 15_000_000n, minNetUsdt: 0n } };
  const decision = decide({ market, policy, mark: { askX18: 99_000n, bidX18: 98_800n, fetchedAtMs: 100_000 }, runtime: new Map(), nowMs: 100_000, maxStateAgeMs: 6_000, maxMarkAgeMs: 30_000 });
  assert.equal(decision.action, "trade");
});

test("the replay counts one fill per gap, then applies the inventory limit", () => {
  const point = (atMs: number, net: boolean, block: string): ShadowSample => ({ atMs, block, ask: 0.1, bid: 0.1, spot: 0.09, networkUsdt: 0, markAgeMs: 0, twapDeviation: 0, decision: "x", quotes: [{ side: "buy", sizeUsdt: 15, hsk: net ? 200 : 100, usdt: 15 }] });
  const samples = [point(0, true, "1"), point(2_000, true, "2"), point(4_000, true, "2"), point(6_000, false, "3"), point(8_000, true, "4")];
  const replay = replayEdgeFills(samples, 15);
  assert.equal(replay.oncePerBlock.fills, 3);
  assert.equal(replay.oncePerOpportunity.fills, 2);
  assert.equal(replay.withInventoryLimit.fills, 1);
  assert.equal(replay.oncePerBlock.inventoryUsdt, 45);
  assert.equal(replay.withInventoryLimit.inventoryUsdt, 15);
});

const HASH = `0x${"ab".repeat(32)}` as Hex;
const OTHER = `0x${"cd".repeat(32)}` as Hex;
const frame = (index: number, transactions: Hex[], blockHash: Hex = HASH): Frame => ({ block: 7n, index, logs: [], arrivedAt: 0, payloadId: "0x1", blockHash, transactions });

test("frames that match the sealed block show no drift", async () => {
  const { keccak256 } = await import("viem");
  const ledger = new FrameLedger();
  ledger.add(frame(0, ["0x01"]));
  ledger.add(frame(1, ["0x02"]));
  const [seen] = ledger.takeUpTo(7n);
  const drift = compareBlock(seen!, { hash: HASH, transactions: [keccak256("0x01"), keccak256("0x02")] });
  assert.deepEqual({ ...drift, block: undefined }, { block: undefined, frames: 2, hashMatch: true, vanished: 0, vanishedUser: [], unseen: 0, orderMatch: true, payloads: 1, userTransactions: 1 });
  assert.equal(ledger.takeUpTo(7n).length, 0, "a block is taken once");
});

test("a transaction shown in a frame but missing from the sealed block is counted", async () => {
  const { keccak256 } = await import("viem");
  const ledger = new FrameLedger();
  ledger.add(frame(0, ["0x01"]));
  ledger.add(frame(1, ["0x02"], OTHER));
  const drift = compareBlock(ledger.takeUpTo(7n)[0]!, { hash: HASH, transactions: [keccak256("0x01"), keccak256("0x03")] });
  assert.equal(drift.hashMatch, false);
  assert.equal(drift.vanished, 1);
  assert.deepEqual(drift.vanishedUser, [keccak256("0x02")]);
  assert.equal(drift.unseen, 1);
});

test("a system deposit from an abandoned payload is not a vanished user transaction", async () => {
  const { keccak256 } = await import("viem");
  const ledger = new FrameLedger();
  ledger.add(frame(0, ["0x7e01"]));
  ledger.add({ ...frame(0, ["0x7e02"]), payloadId: "0x2" });
  const drift = compareBlock(ledger.takeUpTo(7n)[0]!, { hash: HASH, transactions: [keccak256("0x7e02")] });
  assert.equal(drift.vanished, 1);
  assert.deepEqual(drift.vanishedUser, []);
});

test("a changed order is counted, and a second payload for one block is visible", async () => {
  const { keccak256 } = await import("viem");
  const ledger = new FrameLedger();
  ledger.add(frame(0, ["0x01", "0x02"]));
  ledger.add({ ...frame(1, []), payloadId: "0x2" });
  const drift = compareBlock(ledger.takeUpTo(7n)[0]!, { hash: HASH, transactions: [keccak256("0x02"), keccak256("0x01")] });
  assert.equal(drift.orderMatch, false);
  assert.equal(drift.payloads, 2);
});

test("a frame carries what the check needs", () => {
  const decoded = decodeFrame(JSON.stringify({ index: 2, payload_id: "0x9", diff: { block_hash: HASH, transactions: ["0x01"] }, metadata: { block_number: 5 } }));
  assert.equal(decoded.payloadId, "0x9");
  assert.equal(decoded.blockHash, HASH);
  assert.deepEqual(decoded.transactions, ["0x01"]);
});
