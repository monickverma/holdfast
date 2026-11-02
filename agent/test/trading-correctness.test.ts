// Economics, preflight, venue checks and the audit trail. Offline: every chain answer here is a mock.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keccak256, stringToHex, type Hex } from "viem";
import { ChainedLog, GENESIS, verifyChain } from "../src/audit-log.js";
import { checkLinks, reconcileFill, unloggedTrades } from "../src/cli/audit.js";
import { HSKSWAP } from "../src/config.js";
import { costLedger, decide, type DecideInput, type Mark, type TradeDecision } from "../src/decide.js";
import { breakEvenOut, grossEdgeBps, impactBps, markIsSane, minProfitableInput } from "../src/economics.js";
import { decisionRecord, EDGE_TTL_SEC, GAS_LIMIT } from "../src/executor.js";
import type { Intent } from "../src/ledger.js";
import { DEFAULT_POLICY, parsePolicy, type Policy } from "../src/policy.js";
import { positionReport, tradingResult } from "../src/position.js";
import { judgePreflight, maxTradeCostWei, type Preflight } from "../src/preflight.js";
import { qualitySummary } from "../src/quality.js";
import type { MarketState, TokenLimits } from "../src/reader.js";
import { allowsLive, worst } from "../src/venue.js";

const HSK = 10n ** 18n;
const USDT = 10n ** 6n;

/** A small seeded generator, so a failure here reproduces exactly. Adding a property-testing package is not worth it. */
function rng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
  return (low: bigint, high: bigint) => low + ((BigInt(next()) << 32n) | BigInt(next())) % (high - low + 1n);
}

const limits: TokenLimits = { balance: 2n ** 120n, maxTrade: 2n ** 120n, remaining: 2n ** 120n, floorPriceX18: 1n, hourlyBudget: 2n ** 120n, available: 2n ** 120n };

function marketWith(buyOut: bigint, sellIn: bigint, sellOut: bigint, spot: bigint, size: bigint, baseFee = 1n, l1 = 0n): MarketState {
  return {
    head: { number: 100n, hash: `0x${"a".repeat(64)}`, timestamp: 100n, baseFeePerGas: baseFee },
    sqrtPriceX96: 0n,
    tick: 0,
    twapTick: 0,
    liquidity: 1n,
    spotPriceX18: spot,
    quotes: [
      { tokenIn: HSKSWAP.whsk, amountIn: sellIn, amountOut: sellOut, ticksCrossed: 0 },
      { tokenIn: HSKSWAP.usdt, amountIn: size, amountOut: buyOut, ticksCrossed: 0 },
    ],
    priorityFeePerGas: 1n,
    l1FeeWei: l1,
    vault: { paused: false, agentExpiry: 10_000n, whsk: limits, usdt: limits },
  };
}

test("property: no edge trade's worst allowed fill nets under the requirement, whatever the numbers", () => {
  const between = rng(20261102);
  let traded = 0;
  for (let i = 0; i < 2_000; i++) {
    const spot = between(50_000n, 500_000n);
    const size = between(1n * USDT, 1_000n * USDT);
    const minNet = between(0n, 1n * USDT);
    const bid = spot + between(0n, spot / 100n);
    const ask = bid + between(0n, bid / 100n);
    const sellIn = (size * HSK) / spot;
    // Sometimes the buy side pays above the bid, sometimes the sell side pays above the ask.
    const buyOut = (size * HSK * (10_000n + between(0n, 200n))) / bid / 10_000n;
    const sellOut = (sellIn * ask * (10_000n + between(0n, 200n))) / HSK / 10_000n;
    const market = marketWith(buyOut, sellIn, sellOut, spot, size, between(0n, 10_000_000_000n), between(0n, 10n ** 13n));
    const policy: Policy = { ...DEFAULT_POLICY, slippageBps: Number(between(0n, 500n)), edge: { enabled: true, sizeUsdt: size, minNetUsdt: minNet, maxInventoryUsdt: 2n ** 100n } };
    const mark: Mark = { askX18: ask, bidX18: bid, fetchedAtMs: 100_000 };
    const decision = decide({ market, policy, mark, runtime: new Map(), nowMs: 100_000, maxStateAgeMs: 6_000, maxMarkAgeMs: 5_000 });
    if (decision.action !== "trade") continue;
    traded++;
    assert.ok(decision.minOut <= decision.quotedOut, "must be able to fill at the quote");
    const worstFill = costLedger(decision.tokenIn, decision.amountIn, decision.minOut, market, mark);
    assert.ok(worstFill.net! > minNet, `seed run ${i}: worst fill nets ${worstFill.net}, required ${minNet}`);
  }
  assert.ok(traded > 100, `the generator produced only ${traded} trades, so this proved little`);
});

test("property: the cost ledger is exact in its units and charges each cost once", () => {
  const between = rng(7);
  for (let i = 0; i < 2_000; i++) {
    const spot = between(50_000n, 500_000n);
    const ask = between(50_000n, 500_000n);
    const bid = between(50_000n, ask);
    const market = marketWith(0n, 0n, 0n, spot, 0n, between(0n, 10n ** 9n));
    const mark: Mark = { askX18: ask, bidX18: bid, fetchedAtMs: 0 };
    const amountIn = between(1n, 1_000n * HSK);
    const out = between(1n, 1_000n * USDT);
    const sell = costLedger(HSKSWAP.whsk, amountIn, out, market, mark);
    assert.equal(sell.outputValue, out, "USDT received is face value");
    assert.equal(sell.net, sell.outputValue! - sell.inputValue! - sell.networkCost);
    const buy = costLedger(HSKSWAP.usdt, out, amountIn, market, mark);
    assert.equal(buy.inputValue, out, "USDT given up is face value");
    assert.equal(buy.net, buy.outputValue! - buy.inputValue! - buy.networkCost);
    // More gas can only lower the result, by exactly the extra cost.
    const dearer = costLedger(HSKSWAP.whsk, amountIn, out, market, mark, 400_000n);
    assert.ok(dearer.net! <= sell.net!);
  }
});

test("known values: units come out as documented", () => {
  // 1 HSK at 0.1 USDT: spot is 100,000 micro-USDT per 1e18 wei.
  assert.equal(impactBps(true, 10n * HSK, 1_000_000n, 100_000n), 0n);
  assert.equal(impactBps(true, 10n * HSK, 997_000n, 100_000n), 30n, "the pool's 30 bps fee alone");
  assert.equal(impactBps(false, 1_000_000n, 10n * HSK, 100_000n), 0n);
  assert.equal(impactBps(true, 10n * HSK, 1_001_000n, 100_000n), -10n, "better than spot is negative");
  assert.equal(impactBps(true, 10n * HSK, 1n, 0n), 10_000n, "no price means no claim of a good fill");
  assert.equal(breakEvenOut(true, 1_000_000n, 2_000n, 500n, 100_000n), 1_002_501n);
  assert.equal(grossEdgeBps(1_000_000n, 1_010_000n), 100n);
  assert.equal(minProfitableInput(100n, 2_000n), 200_000n, "$0.002 of gas needs $0.20 at a 1% edge");
  assert.equal(minProfitableInput(0n, 2_000n), null);
  assert.equal(minProfitableInput(-5n, 2_000n), null);
});

test("an outside price is sane only if uncrossed, positive and not very wide", () => {
  assert.equal(markIsSane({ askX18: 100_100n, bidX18: 100_000n }), true);
  assert.equal(markIsSane({ askX18: 100_000n, bidX18: 100_000n }), true);
  assert.equal(markIsSane({ askX18: 99_999n, bidX18: 100_000n }), false, "crossed");
  assert.equal(markIsSane({ askX18: 0n, bidX18: 0n }), false, "empty");
  assert.equal(markIsSane({ askX18: 104_000n, bidX18: 100_000n }), false, "400 bps wide");
});

test("a bad outside price cannot hold a stop-loss back", () => {
  const amountIn = 10n * HSK;
  const market = marketWith(0n, amountIn, 900_000n, 100_000n, 1n);
  const policy: Policy = { ...DEFAULT_POLICY, stopConfirmBlocks: 1, orders: [{ id: "stop", kind: "stop-loss", amountIn, triggerPriceX18: 100_000n }] };
  const input: DecideInput = { market, policy, mark: { askX18: 1n, bidX18: 900_000n, fetchedAtMs: 100_000 }, runtime: new Map(), nowMs: 100_000, maxStateAgeMs: 6_000, maxMarkAgeMs: 5_000 };
  assert.equal(decide(input).action, "trade");
});

test("maxImpactBps is checked by the policy parser", () => {
  const base = { version: 1, orders: [], edge: { enabled: false, sizeUsdt: "1", minNetUsdt: "0" }, slippageBps: 50, maxTwapDeviationBps: 200, stopConfirmBlocks: 2 };
  assert.equal(parsePolicy(base).maxImpactBps, undefined);
  assert.equal(parsePolicy({ ...base, maxImpactBps: 100 }).maxImpactBps, 100);
  assert.throws(() => parsePolicy({ ...base, maxImpactBps: 0 }));
  assert.throws(() => parsePolicy({ ...base, maxImpactBps: 1.5 }));
  assert.throws(() => parsePolicy({ ...base, maxImpactBps: "100" }));
});

// Preflight

const market = marketWith(0n, 0n, 0n, 100_000n, 0n);
const need = maxTradeCostWei(market);
const trade = (trigger: TradeDecision["trigger"], over: Partial<TradeDecision> = {}): TradeDecision => ({
  action: "trade",
  trigger,
  orderId: trigger === "edge" ? null : "o",
  tokenIn: HSKSWAP.whsk,
  amountIn: 10n * HSK,
  quotedOut: 1_000_000n,
  minOut: 990_000n,
  ledger: { inputValue: null, outputValue: null, networkCost: 0n, net: null },
  reason: "test",
  ...over,
});
const answered = (over: Partial<Preflight> = {}): Preflight => ({ ok: true, amountOut: 1_000_000n, latencyMs: 1, gasEstimate: 150_000n, balanceWei: need, ...over });
const judge = (decision: TradeDecision, answer: Preflight, mark: Mark | null = null, policy: Policy = DEFAULT_POLICY) => judgePreflight(decision, answer, market, mark, policy);

test("preflight passes only when every authoritative answer is in and good", () => {
  const verdict = judge(trade("market"), answered());
  assert.equal(verdict.hold, null);
  assert.deepEqual(verdict.checks.map((c) => [c.name, c.source, c.ok]), [
    ["vault-call", "authoritative", true],
    ["min-output", "authoritative", true],
    ["gas-estimate", "authoritative", true],
    ["gas-limit", "analytical", true],
    ["gas-balance", "analytical", true],
  ]);
});

test("the vault's refusal stops every kind of trade, stop-loss included", () => {
  for (const trigger of ["market", "limit", "edge", "stop-loss"] as const) {
    assert.equal(judge(trade(trigger), answered({ ok: false, error: "BelowFloor" })).hold?.code, "preflight-refused", trigger);
  }
});

test("when the node cannot answer, nothing goes out except a stop-loss", () => {
  for (const trigger of ["market", "limit", "edge"] as const) {
    assert.equal(judge(trade(trigger), answered({ ok: null, error: "timeout" })).hold?.code, "preflight-unverified", trigger);
    assert.equal(judge(trade(trigger), answered({ gasEstimate: undefined })).hold?.code, "preflight-unverified", trigger);
    assert.equal(judge(trade(trigger), answered({ balanceWei: undefined })).hold?.code, "preflight-unverified", trigger);
  }
  assert.equal(judge(trade("stop-loss"), answered({ ok: null, error: "timeout" })).hold, null);
  assert.equal(judge(trade("stop-loss"), answered({ gasEstimate: undefined })).hold, null);
});

test("a vault answer under the trade's own minimum holds, even though the call succeeded", () => {
  assert.equal(judge(trade("market"), answered({ amountOut: 989_999n })).hold?.code, "preflight-refused");
  assert.equal(judge(trade("market"), answered({ amountOut: undefined })).hold?.code, "preflight-refused");
});

test("gas: over the signed limit, or too little to be accepted, holds a stop-loss as well", () => {
  assert.equal(judge(trade("stop-loss"), answered({ gasEstimate: GAS_LIMIT + 1n })).hold?.code, "preflight-refused");
  assert.equal(judge(trade("stop-loss"), answered({ balanceWei: need - 1n })).hold?.code, "no-gas");
  assert.equal(judge(trade("stop-loss"), answered({ balanceWei: need })).hold, null);
});

test("an edge that no longer pays at the vault's output and real gas holds, whatever the quote said", () => {
  const mark: Mark = { askX18: 100_000n, bidX18: 100_000n, fetchedAtMs: 0 };
  const policy: Policy = { ...DEFAULT_POLICY, edge: { enabled: true, sizeUsdt: 1n, minNetUsdt: 0n } };
  const edge = trade("edge");
  assert.equal(judge(edge, answered({ amountOut: 1_500_000n }), mark, policy).hold, null);
  const verdict = judge(edge, answered({ amountOut: 1_000_000n, gasEstimate: 150_000n }), mark, policy);
  assert.equal(verdict.hold?.code, "preflight-uneconomic");
  assert.equal(verdict.checks.at(-1)?.source, "analytical");
});

test("arithmetic cannot overturn a refusal: a great local number still holds", () => {
  const mark: Mark = { askX18: 100_000n, bidX18: 100_000n, fetchedAtMs: 0 };
  const great = trade("edge", { quotedOut: 9_000_000n, ledger: { inputValue: 1n, outputValue: 9_000_000n, networkCost: 0n, net: 8_999_999n } });
  assert.equal(judge(great, answered({ ok: false, error: "OverTradeCap" }), mark).hold?.code, "preflight-refused");
});

// Venue

test("the venue verdict is the worst of its checks, and an unanswered check blocks live", () => {
  assert.equal(worst([{ status: "pass" }, { status: "warn" }]), "warn");
  assert.equal(worst([{ status: "pass" }, { status: "unverified" }, { status: "warn" }]), "unverified");
  assert.equal(worst([{ status: "unverified" }, { status: "fail" }]), "fail");
  assert.equal(worst([]), "unverified", "no checks at all is not a pass");
  assert.equal(allowsLive({ verdict: "pass" }), true);
  assert.equal(allowsLive({ verdict: "warn" }), true);
  assert.equal(allowsLive({ verdict: "unverified" }), false);
  assert.equal(allowsLive({ verdict: "fail" }), false);
});

// The chained log

const tempLog = () => join(mkdtempSync(join(tmpdir(), "holdfast-chain-")), "decisions.jsonl");

test("a chained log verifies, and survives a restart without breaking the chain", () => {
  const path = tempLog();
  const first = new ChainedLog(path);
  first.append({ a: 1n });
  first.append({ b: "two" });
  const restarted = new ChainedLog(path);
  assert.equal(restarted.seq, 2);
  assert.equal(restarted.head, first.head);
  restarted.append({ c: 3 });
  const check = verifyChain(readFileSync(path, "utf8"));
  assert.deepEqual(check.breaks, []);
  assert.equal(check.records, 3);
  assert.equal(check.head, restarted.head);
});

test("editing, removing or reordering a record is detected", () => {
  const path = tempLog();
  const log = new ChainedLog(path);
  for (let i = 0; i < 4; i++) log.append({ i, reason: `decision ${i}` });
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const edited = [...lines];
  edited[1] = edited[1]!.replace("decision 1", "decision X");
  assert.ok(verifyChain(edited.join("\n")).breaks.length > 0, "edited");
  assert.ok(verifyChain(lines.filter((_, i) => i !== 1).join("\n")).breaks.length > 0, "removed");
  assert.ok(verifyChain([lines[0], lines[2], lines[1], lines[3]].join("\n")).breaks.length > 0, "reordered");
});

test("a line torn by a crash is reported, and the chain carries on from the last whole record", () => {
  const path = tempLog();
  const log = new ChainedLog(path);
  log.append({ a: 1 });
  appendFileSync(path, '{"seq":1,"prev":"0xabc');
  const restarted = new ChainedLog(path);
  assert.equal(restarted.head, log.head);
  restarted.append({ b: 2 });
  const check = verifyChain(readFileSync(path, "utf8"));
  assert.deepEqual(check.breaks, []);
  assert.equal(check.tornLines, 1);
  assert.equal(check.records, 2);
});

test("records from before chaining are counted apart, and the chain starts after them", () => {
  const path = tempLog();
  writeFileSync(path, '{"wallTime":"old","block":"1"}\n');
  const log = new ChainedLog(path);
  assert.equal(log.head, GENESIS);
  log.append({ a: 1 });
  const check = verifyChain(readFileSync(path, "utf8"));
  assert.equal(check.unchained, 1);
  assert.equal(check.records, 1);
  assert.deepEqual(check.breaks, []);
});

// The audit

const body = (prev: Hex | null, logHead: Hex) => JSON.stringify({ v: 2, prevDecisionHash: prev, logHead });
const hashOf = (text: string) => keccak256(stringToHex(text));

test("decision links: a removed trade or a rewritten log is named, and an intact one is clean", () => {
  const head1 = `0x${"1".repeat(64)}` as Hex;
  const b1 = body(null, GENESIS);
  const h1 = hashOf(b1);
  const b2 = body(h1, head1);
  const h2 = hashOf(b2);
  const b3 = body(h2, head1);
  const rows = [
    { key: "a", decisionBody: b1, decisionHash: h1, status: "included" as const, rawTx: "0x1" as Hex },
    { key: "b", decisionBody: b2, decisionHash: h2, status: "included" as const, rawTx: "0x2" as Hex },
    { key: "c", decisionBody: b3, decisionHash: hashOf(b3), status: "included" as const, rawTx: "0x3" as Hex },
  ];
  const log = { hashes: new Set<Hex>([head1]) };
  assert.deepEqual(checkLinks(rows, log), []);
  assert.match(checkLinks([rows[0]!, rows[2]!], log)[0]!, /removed or added/);
  assert.match(checkLinks(rows, { hashes: new Set() })[0]!, /rewritten/);
});

test("decision links: old decisions without links, and cancelled ones, do not count against it", () => {
  const old = JSON.stringify({ block: "1" });
  const h = hashOf(old);
  const b = body(h, GENESIS);
  const rows = [
    { key: "old", decisionBody: old, decisionHash: h, status: "included" as const, rawTx: "0x1" as Hex },
    { key: "dropped", decisionBody: body(h, GENESIS), decisionHash: hashOf("x"), status: "cancelled" as const },
    { key: "new", decisionBody: b, decisionHash: hashOf(b), status: "included" as const, rawTx: "0x2" as Hex },
  ];
  assert.deepEqual(checkLinks(rows as never, { hashes: new Set() }), []);
});

test("reconciliation names every way a log can disagree with a receipt", () => {
  const logged = { status: "included" as const, amountIn: 100n, amountOut: 90n };
  assert.deepEqual(reconcileFill(logged, { success: true, amountIn: 100n, amountOut: 90n }), []);
  assert.match(reconcileFill(logged, { success: true, amountIn: 100n, amountOut: 95n })[0]!, /90 out/);
  assert.match(reconcileFill(logged, { success: false })[0]!, /reverted/);
  assert.match(reconcileFill(logged, null)[0]!, /no receipt/);
  assert.match(reconcileFill(logged, { success: true })[0]!, /no Traded event/);
  assert.match(reconcileFill(logged, { success: true, amountIn: 70n, amountOut: 90n })[0]!, /100 in/);
  assert.deepEqual(reconcileFill({ ...logged, amountSpent: 70n }, { success: true, amountIn: 70n, amountOut: 90n }), []);
  assert.deepEqual(reconcileFill({ status: "broadcast" as const, amountIn: 1n, amountOut: undefined }, null), []);
});

test("a trade on chain that the log leaves out is found", () => {
  const known = `0x${"a".repeat(64)}` as Hex;
  const hidden = `0x${"b".repeat(64)}` as Hex;
  const tx = `0x${"c".repeat(64)}` as Hex;
  assert.deepEqual(unloggedTrades([{ intentId: known, transactionHash: tx }, { intentId: hidden, transactionHash: tx }], [{ intentId: known }]), [tx]);
});

// The decision body

test("the decision the chain commits to carries what it was made from", () => {
  const edge = trade("edge", { ledger: { inputValue: 1n, outputValue: 2n, networkCost: 3n, net: 4n } });
  const mark: Mark = { askX18: 101n, bidX18: 100n, fetchedAtMs: 1_000 };
  const parsed = JSON.parse(decisionRecord(edge, { ...market, tick: 5, twapTick: 6 }, {
    policyVersion: 9, mark, decidedAtMs: 3_000, logHead: GENESIS, preflight: { ok: true, amountOut: 7n, latencyMs: 1, gasEstimate: 8n },
    chainId: 133, vault: HSKSWAP.router, expiresAt: 115n, prevDecisionHash: null, intentId: `0x${"11".repeat(32)}`, agent: HSKSWAP.router,
  }));
  assert.equal(parsed.v, 3);
  assert.equal(parsed.chainId, 133);
  assert.equal(parsed.policyVersion, 9);
  assert.equal(parsed.expiresAt, "115");
  assert.deepEqual(parsed.mark, { askX18: "101", bidX18: "100", ageMs: 2_000 });
  assert.equal(parsed.ledger.net, "4");
  assert.equal(parsed.preflight.gasEstimate, "8");
  assert.equal(parsed.tick, 5);
  assert.equal(parsed.twapTick, 6);
  assert.equal(EDGE_TTL_SEC < 90n, true, "an edge goes stale sooner than an order");
});

test("a decision from before version 2 still produces the same bytes, so old hashes still verify", () => {
  const text = decisionRecord(trade("market"), market);
  assert.equal(JSON.parse(text).v, undefined);
  assert.ok(text.startsWith('{"block":"100"'));
});

// Realized results

const fill = (over: Partial<Intent>): Intent => ({
  key: "k",
  intentId: `0x${"1".repeat(64)}`,
  bodyHash: `0x${"2".repeat(64)}`,
  status: "included",
  orderId: "o",
  tokenIn: HSKSWAP.whsk,
  amountIn: 10n * HSK,
  minOut: 990_000n,
  deadline: 200n,
  amountOut: 995_000n,
  feeWei: 10n ** 15n,
  gasUsed: 150_000n,
  ...over,
});

test("P&L uses what the vault actually spent, not what the order asked for", () => {
  const partial = fill({ amountSpent: 4n * HSK, amountOut: 400_000n, feeWei: 0n });
  const result = tradingResult([partial], 100_000n);
  assert.equal(result.whskDelta, -4n * HSK);
  assert.equal(result.usdtDelta, 400_000n);
  const report = positionReport([fill({ tokenIn: HSKSWAP.usdt, amountIn: 1_000_000n, amountSpent: 500_000n, amountOut: 5n * HSK, feeWei: 0n })], 100_000n);
  assert.equal(report.inventoryHsk, 5n * HSK);
  assert.equal(report.averageCostX18, 100_000n, "cost is the half that was spent");
});

test("execution quality: expected from the decision, realized from the receipt", () => {
  const decisionBody = JSON.stringify({ v: 2, quotedOut: "1000000", spotPriceX18: "100000", ledger: { net: "5000" }, mark: { askX18: "99000", bidX18: "98000" }, preflight: { gasEstimate: "150000" } });
  const summary = qualitySummary([
    fill({ decisionBody }),
    fill({ key: "gone", status: "reverted", amountOut: undefined }),
    fill({ key: "late", status: "expired", amountOut: undefined }),
    fill({ key: "dropped", status: "cancelled", amountOut: undefined }),
    fill({ key: "unknown", outcomeUnverified: true }),
  ]);
  assert.equal(summary.reverted, 1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.unverifiedOutcomes, 1);
  assert.equal(summary.fills, 2);
  assert.equal(summary.fillsWithExpectation, 1);
  const row = summary.rows[0]!;
  assert.equal(row.slippageBps, 50n, "995,000 against a quote of 1,000,000");
  assert.equal(row.allowanceUsedBps, 5_000n, "half way from the quote to the minimum");
  assert.equal(row.costToSpotBps, 50n);
  assert.equal(row.expectedNetUsdt, 5_000n);
  // 10 HSK at the 99,000 ask is 990,000 given up, 995,000 received, less 0.001 HSK of gas at spot.
  assert.equal(row.realizedNetUsdt, 995_000n - 990_000n - 100n);
  assert.equal(summary.rows[1]!.slippageBps, null, "no recorded quote, so no claim");
  assert.match(summary.definition, /not profit/);
});

test("execution quality with no fills claims nothing", () => {
  const summary = qualitySummary([]);
  assert.equal(summary.fills, 0);
  assert.equal(summary.meanSlippageBps, null);
  assert.equal(summary.realizedNetUsdt, null);
});
