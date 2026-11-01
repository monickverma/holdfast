import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256 } from "viem";
import { analyzeInclusion, inclusionRow, inclusionSchedule, InclusionTracker, retryAfterMs } from "../src/inclusion.js";

test("inclusion schedule is balanced and repeatable across all 55 cells", () => {
  const phases = [0, 50, 90, 110, 150];
  const schedule = inclusionSchedule(phases, 10, 42);
  assert.equal(schedule.length, 550);
  assert.deepEqual(schedule, inclusionSchedule(phases, 10, 42));
  assert.notDeepEqual(schedule, inclusionSchedule(phases, 10, 43));
  for (let i = 0; i <= 10; i++) for (const phase of phases) assert.equal(schedule.filter((cell) => cell.targetIndex === i && cell.targetPhaseMs === phase).length, 10);
  assert.throws(() => inclusionSchedule([0, 0]));
  assert.throws(() => inclusionSchedule([-1]));
  assert.throws(() => inclusionSchedule([0], 0));
});

test("the first matching frame wins, including across the block boundary and a response arriving first", () => {
  const row = inclusionRow(1, { targetIndex: 10, targetPhaseMs: 0 });
  const tracker = new InclusionTracker(row, "0x1234");
  const frame = { block: 100n, index: 10, payloadId: "a", arrivedAt: 1000, logs: [], transactions: [] };
  tracker.trigger(frame, 5);
  row.responseAt = 1100;
  assert.equal(tracker.observe({ ...frame, block: 101n, index: 0, payloadId: "b", arrivedAt: 1200, transactions: [keccak256("0x1234")] }, 6), true);
  assert.equal(tracker.observe({ ...frame, transactions: ["0x1234"] }, 7), false);
  assert.equal(row.framesBetween, 1);
  assert.equal(row.inclusionBlock, "101");
  assert.equal(row.inclusionPayloadId, "b");
  assert.equal(row.responseAt - row.inclusionArrivedAt!, -100);
});

test("raw transactions match their hash and unrelated frames do not count as inclusion", () => {
  const row = inclusionRow(0, { targetIndex: 2, targetPhaseMs: 0 });
  const tracker = new InclusionTracker(row, "0x1234");
  const frame = { block: 100n, index: 2, payloadId: "a", arrivedAt: 1000, logs: [] };
  tracker.trigger(frame, 1);
  assert.equal(tracker.observe({ ...frame, index: 3, transactions: ["0xabcd"] }, 2), false);
  assert.equal(tracker.observe({ ...frame, index: 4, transactions: ["0x1234"] }, 3), true);
  assert.equal(row.transactionHash, keccak256("0x1234"));
  assert.equal(row.framesBetween, 2);
});

test("analysis retains failures, withholds small quantiles, and separates inclusion from response delay", () => {
  const rows = Array.from({ length: 8 }, (_, trial) => ({ ...inclusionRow(trial, { targetIndex: 1, targetPhaseMs: 50 }),
    triggerArrivedAt: 1000, responseAt: 1205, inclusionArrivedAt: 1200, framesBetween: 1, responseStatus: "success" }));
  rows.push({ ...rows[0]!, trial: 8, targetIndex: 9, framesBetween: 2, responseAt: 1405, inclusionArrivedAt: 1400 });
  rows.push({ ...rows[0]!, trial: 9, targetIndex: 10, responseAt: 1405 });
  const failed = { ...inclusionRow(10, { targetIndex: 9, targetPhaseMs: 50 }), responseStatus: "http 429", error: "limited" };
  const report = analyzeInclusion([...rows, failed]);
  assert.equal(report.indices[1]!.frameToResponseP50.value, 205);
  assert.equal(report.indices[1]!.inclusionToResponseP50.value, 5);
  assert.deepEqual(report.indices[9]!.framesBetween, { 2: 1 });
  assert.equal(report.indices[9]!.n, 2);
  assert.equal(report.indices[9]!.failures, 1);
  assert.equal(report.indices[9]!.frameToResponseP50.value, null);
  assert.deepEqual(report.slowCases.map((row) => row.label), ["inclusion later", "same frame, later response"]);
  assert.equal(analyzeInclusion([rows[0]!]).slowCases.length, 0);
  assert.equal(analyzeInclusion([]).indices[0]!.n, 0);
});

test("429 waits honor numeric and date Retry-After without a cap", () => {
  assert.equal(retryAfterMs("120"), 120_000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:02:00 GMT", 1000), 119_000);
  assert.equal(retryAfterMs(null), 60_000);
});
