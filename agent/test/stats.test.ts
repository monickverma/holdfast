import assert from "node:assert/strict";
import { test } from "node:test";
import { minSampleForInterval, minSampleForOneSidedBound, nearestRank, quantileReport, wilson } from "../src/stats.js";

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

test("nearest rank returns a real observation", () => {
  assert.equal(nearestRank([5, 1, 3], 0.5), 3);
  assert.equal(nearestRank(range(100), 0.95), 95);
  assert.equal(nearestRank(range(100), 0.99), 99);
});

test("sample size thresholds match the brief", () => {
  assert.equal(minSampleForOneSidedBound(0.95), 59);
  assert.equal(minSampleForOneSidedBound(0.99), 299);
  assert.equal(minSampleForInterval(0.95), 72);
  assert.equal(minSampleForInterval(0.99), 368);
});

test("P99 is withheld below 299 samples", () => {
  const report = quantileReport(range(298), 0.99);
  assert.equal(report.value, null);
  assert.match(report.withheld!, /below 299/);
  assert.equal(quantileReport(range(299), 0.99).value, 297);
});

test("a finite interval needs enough samples at the tail", () => {
  assert.equal(quantileReport(range(299), 0.99).high, null);
  assert.notEqual(quantileReport(range(368), 0.99).high, null);
});

test("wide interval ranks match the brief at n=1000", () => {
  const report = quantileReport(range(1000), 0.99);
  // Brief: P99 confidence ranks 4 to 18 from the top.
  assert.ok(report.low! >= 1000 - 18 && report.low! <= 1000 - 17, `low=${report.low}`);
  assert.ok(report.high! >= 1000 - 4 && report.high! <= 1000 - 3, `high=${report.high}`);
});

test("wilson upper bound for 0 of 100 is about 3.7 percent", () => {
  const { low, high } = wilson(0, 100);
  assert.equal(low, 0);
  assert.ok(Math.abs(high - 0.037) < 0.001);
});
