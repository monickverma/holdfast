// The v3 vault's reads, and the tooling around it: explanations, position, health, audit, the SDK and the MCP server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { keccak256, stringToHex, type Hex } from "viem";
import { assertChainForBroadcast } from "../src/chain-guard.js";
import { auditIntent, hashInCalldata } from "../src/cli/audit.js";
import { HSKSWAP, agentMode, loadConfig } from "../src/config.js";
import { decide, trancheSize, type DecideInput } from "../src/decide.js";
import { HOLD_REASONS, VAULT_ERRORS, explainError } from "../src/explain.js";
import type { Intent } from "../src/ledger.js";
import { handleMcp, TOOLS } from "../src/mcp.js";
import { healthChecks, worstSeverity, type HealthInput } from "../src/monitor.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { positionReport } from "../src/position.js";
import { VAULT_ABI, tickAtSqrtPrice, type MarketState, type TokenLimits, type VaultState } from "../src/reader.js";
import { IntentError, parseIntent, validatePolicy } from "../src/sdk.js";

const HSK = 10n ** 18n;
const USDT = 10n ** 6n;
const NOW = 1_800_000_000_000;

// Explanations

test("every error the vault can return has a plain explanation", () => {
  const source = readFileSync("contracts/HoldfastVault.sol", "utf8");
  const declared = [...source.matchAll(/^\s*error (\w+)\(/gm)].map((m) => m[1]!);
  assert.ok(declared.length > 20);
  for (const name of declared) assert.ok(VAULT_ERRORS[name], `${name} has no explanation`);
});

test("every error in the agent's ABI is one the vault declares, so a revert always decodes", () => {
  const source = readFileSync("contracts/HoldfastVault.sol", "utf8");
  const declared = new Set([...source.matchAll(/^\s*error (\w+)\(/gm)].map((m) => m[1]!));
  const known = new Set(VAULT_ABI.filter((x) => x.type === "error").map((x) => (x as { name: string }).name));
  for (const name of declared) assert.ok(known.has(name), `${name} is missing from VAULT_ABI`);
});

test("every hold code the decision can return has an explanation", () => {
  const source = readFileSync("agent/src/decide.ts", "utf8");
  const block = /export type HoldCode =([\s\S]*?);/.exec(source)![1]!;
  const codes = [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
  assert.ok(codes.length >= 20);
  for (const code of codes) assert.ok(HOLD_REASONS[code as keyof typeof HOLD_REASONS], `${code} has no explanation`);
});

test("a node's wording around an error name is still understood, and an unknown one is not guessed at", () => {
  assert.equal(explainError("execution reverted: custom error PriceOutOfBand()").meaning, VAULT_ERRORS.PriceOutOfBand!.meaning);
  assert.match(explainError("something else").meaning, /did not name/);
});

// Decisions against a v3 vault

const whsk: TokenLimits = { balance: 1_000n * HSK, maxTrade: 200n * HSK, remaining: 500n * HSK, floorPriceX18: 50_000n, hourlyBudget: 300n * HSK, available: 300n * HSK };
const usdt: TokenLimits = { balance: 50n * USDT, maxTrade: 20n * USDT, remaining: 25n * USDT, floorPriceX18: 5n * HSK, hourlyBudget: 25n * USDT, available: 25n * USDT };
const baseVault: VaultState = { paused: false, agentExpiry: BigInt(NOW / 1000) + 3_600n, whsk, usdt };
/** The sqrt price at a tick, near enough for these tests. */
const sqrtAt = (tick: number) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 48)) * 2n ** 48n;
const TWAP = -300_000;

function market(vault: VaultState, afterTick: number, amountIn = 10n * HSK): MarketState {
  return {
    head: { number: 100n, hash: "0xabc", timestamp: BigInt(NOW / 1000), baseFeePerGas: 0n },
    sqrtPriceX96: sqrtAt(TWAP),
    tick: TWAP,
    twapTick: TWAP,
    liquidity: 1n,
    spotPriceX18: 87_400n,
    quotes: [{ tokenIn: HSKSWAP.whsk, amountIn, amountOut: (amountIn * 87_000n) / HSK, ticksCrossed: 0, sqrtPriceAfter: sqrtAt(afterTick) }],
    priorityFeePerGas: 0n,
    l1FeeWei: 0n,
    vault,
  };
}
const inputFor = (m: MarketState): DecideInput => ({
  market: m,
  policy: { ...DEFAULT_POLICY, orders: [{ id: "m", kind: "market-sell", amountIn: 10n * HSK }] },
  mark: null,
  runtime: new Map(),
  nowMs: NOW,
  maxStateAgeMs: 6_000,
  maxMarkAgeMs: 5_000,
});
const code = (d: ReturnType<typeof decide>) => (d.action === "hold" ? d.code : d.action);
const guarded: VaultState = { ...baseVault, guard: { windowSec: 600, bandTicks: 100, oracleOk: true, twapTick: TWAP } };

test("the tick worked out from a price matches the pool's own, near enough to hold ahead of the vault", () => {
  for (const tick of [-300_677, -1, 0, 1, 887_000]) assert.ok(Math.abs(tickAtSqrtPrice(sqrtAt(tick)) - tick) <= 1, `tick ${tick}`);
});

test("a sale that stays inside the band goes ahead", () => {
  assert.equal(code(decide(inputFor(market(guarded, TWAP - 99)))), "trade");
});

test("a sale that would leave the band holds, and costs no gas", () => {
  assert.equal(code(decide(inputFor(market(guarded, TWAP - 150)))), "price-band");
});

test("a band is one-sided, so a sale into a rising pool is fine", () => {
  assert.equal(code(decide(inputFor(market(guarded, TWAP + 500)))), "trade");
});

test("a dead oracle holds, because the vault would refuse every trade", () => {
  assert.equal(code(decide(inputFor(market({ ...guarded, guard: { ...guarded.guard!, oracleOk: false } }, TWAP)))), "oracle-unavailable");
});

test("a vault with no guard ignores the band", () => {
  assert.equal(code(decide(inputFor(market(baseVault, TWAP - 5000)))), "trade");
});

test("a tranche fits the daily budget, on a grid, and a spent one reads as what it is", () => {
  const step = (60n * HSK) / 60n;
  const vault: VaultState = { ...baseVault, whsk: { ...whsk, dailyBudget: 60n * HSK, dailyAvailable: step * 4n + 7n } };
  assert.equal(trancheSize({ id: "m", kind: "market-sell", amountIn: 100n * HSK }, undefined, vault), step * 4n);
  const spent: VaultState = { ...baseVault, whsk: { ...whsk, dailyBudget: 60n * HSK, dailyAvailable: 3n } };
  const decision = decide(inputFor(market(spent, TWAP)));
  assert.equal(code(decision), "over-budget");
  assert.match((decision as { reason: string }).reason, /daily/);
});

test("no daily cap means no limit from it", () => {
  const vault: VaultState = { ...baseVault, whsk: { ...whsk, dailyBudget: 0n, dailyAvailable: 2n ** 72n - 1n } };
  assert.equal(trancheSize({ id: "m", kind: "market-sell", amountIn: 100n * HSK }, undefined, vault), 100n * HSK);
});

// Modes

test("modes are explicit, LIVE=true keeps working, and the two cannot disagree", () => {
  assert.equal(agentMode({}), "observe");
  assert.equal(agentMode({ LIVE: "true" }), "live");
  assert.equal(agentMode({ MODE: "simulate" }), "simulate");
  assert.throws(() => agentMode({ MODE: "simulate", LIVE: "true" }), /disagree/);
  assert.throws(() => agentMode({ MODE: "yolo" }), /MODE/);
  assert.equal(loadConfig({ MODE: "simulate" }).live, false, "simulate can never send");
  assert.equal(loadConfig({ MODE: "live" }).live, true);
  assert.equal(loadConfig({ VAULT_GENERATION: "3" }).guardedVault, true);
  assert.equal(loadConfig({}).guardedVault, false);
});

test("mainnet needs its own flag, and the wrong chain is refused either way", () => {
  assert.throws(() => assertChainForBroadcast(177, 177, false), /confirm-mainnet/);
  assert.doesNotThrow(() => assertChainForBroadcast(177, 177, true));
  assert.doesNotThrow(() => assertChainForBroadcast(133, 133, false));
  assert.throws(() => assertChainForBroadcast(177, 133, true), /configured for 133/);
});

// Position

const fill = (over: Partial<Intent>): Intent => ({ key: `k${Math.random()}`, intentId: "0x00", bodyHash: "0x00", status: "included", orderId: null, tokenIn: HSKSWAP.usdt, amountIn: 0n, minOut: 0n, deadline: 0n, feeWei: 1n, blockNumber: 1n, ...over });

test("a buy then a sale realizes the difference, at average cost", () => {
  const report = positionReport(
    [
      fill({ tokenIn: HSKSWAP.usdt, amountIn: 8n * USDT, amountOut: 100n * HSK, blockNumber: 1n }),
      fill({ tokenIn: HSKSWAP.usdt, amountIn: 10n * USDT, amountOut: 100n * HSK, blockNumber: 2n }),
      fill({ tokenIn: HSKSWAP.whsk, amountIn: 100n * HSK, amountOut: 12n * USDT, blockNumber: 3n }),
    ],
    100_000n,
  );
  assert.equal(report.fills, 3);
  assert.equal(report.realizedUsdt, 3n * USDT, "sold at 0.12 against an average cost of 0.09");
  assert.equal(report.inventoryHsk, 100n * HSK);
  assert.equal(report.averageCostX18, 90_000n);
  assert.equal(report.unrealizedUsdt, 1n * USDT, "100 HSK worth 0.10 against 0.09");
  assert.equal(report.gasWei, 3n);
});

test("HSK sold from the opening balance is not called profit, because its cost is unknown", () => {
  const report = positionReport([fill({ tokenIn: HSKSWAP.whsk, amountIn: 10n * HSK, amountOut: 1n * USDT })], 100_000n);
  assert.equal(report.realizedUsdt, 0n);
  assert.equal(report.soldWithoutCostBasisHsk, 10n * HSK);
  assert.equal(report.proceedsWithoutCostBasisUsdt, 1n * USDT);
});

test("a sale larger than the inventory splits into what has a cost and what does not", () => {
  const report = positionReport(
    [
      fill({ tokenIn: HSKSWAP.usdt, amountIn: 1n * USDT, amountOut: 10n * HSK, blockNumber: 1n }),
      fill({ tokenIn: HSKSWAP.whsk, amountIn: 20n * HSK, amountOut: 4n * USDT, blockNumber: 2n }),
    ],
    100_000n,
  );
  assert.equal(report.realizedUsdt, 1n * USDT);
  assert.equal(report.soldWithoutCostBasisHsk, 10n * HSK);
  assert.equal(report.proceedsWithoutCostBasisUsdt, 2n * USDT);
  assert.equal(report.inventoryHsk, 0n);
  assert.equal(report.averageCostX18, null);
});

test("a reverted trade pays gas and moves no position", () => {
  const report = positionReport([fill({ status: "reverted", amountIn: 5n * USDT, feeWei: 9n })], 100_000n);
  assert.equal(report.fills, 0);
  assert.equal(report.reverts, 1);
  assert.equal(report.gasWei, 9n);
  assert.equal(report.inventoryHsk, 0n);
});

// Health

const healthy: HealthInput = {
  nowMs: NOW,
  heartbeat: { wallTime: new Date(NOW - 5_000).toISOString(), mode: "live", errors: 0, missedBlocks: 0, inFlight: null },
  expectAgent: true,
  chainId: 177,
  expectedChainId: 177,
  headAgeSec: 2,
  rpcLatencyMs: 100,
  vault: { version: 3n, paused: false, agentExpiry: 1_000_000n, nowSec: 1_000n, agentGasWei: 10n ** 18n, guardOn: true, oracleOk: true, stopArmed: true, stopReady: false, remainingHsk: 1n, remainingUsdt: 1n },
};
const severity = (over: Partial<HealthInput>) => worstSeverity(healthChecks({ ...healthy, ...over }));
const withVault = (over: Partial<NonNullable<HealthInput["vault"]>>) => severity({ vault: { ...healthy.vault!, ...over } });

test("a healthy setup reads as healthy", () => {
  assert.equal(severity({}), "ok");
});

test("what should wake someone up does, and what can wait does not", () => {
  assert.equal(severity({ chainId: 133 }), "critical", "wrong chain");
  assert.equal(severity({ headAgeSec: 120 }), "critical", "no new blocks");
  assert.equal(severity({ heartbeat: null }), "critical", "agent never ran");
  assert.equal(severity({ heartbeat: { ...healthy.heartbeat!, wallTime: new Date(NOW - 120_000).toISOString() } }), "critical", "agent stopped");
  assert.equal(withVault({ agentExpiry: 500n }), "critical", "key expired");
  assert.equal(withVault({ oracleOk: false }), "critical", "oracle down");
  assert.equal(withVault({ stopReady: true }), "critical", "a stop nobody fired");
  assert.equal(withVault({ paused: true }), "warn", "paused");
  assert.equal(withVault({ agentExpiry: 2_000n }), "warn", "key expiring");
  assert.equal(withVault({ agentGasWei: 1n }), "warn", "out of gas soon");
  assert.equal(severity({ rpcLatencyMs: 5_000 }), "warn", "slow RPC");
  assert.equal(severity({ expectAgent: false, heartbeat: null }), "ok", "no agent expected");
});

// Audit

const body = '{"block":"1"}';
const hash = keccak256(stringToHex(body));
const calldata = (suffix: string): Hex => `0x${"ab".repeat(4)}${"00".repeat(160)}${suffix}` as Hex;

test("a transaction that carries its decision's hash checks out", () => {
  assert.equal(hashInCalldata(calldata(hash.slice(2))), hash);
  assert.equal(auditIntent({ key: "k", decisionBody: body, decisionHash: hash }, calldata(hash.slice(2))).verdict, "matches");
});

test("a rewritten log is caught, and so is a transaction carrying something else", () => {
  assert.equal(auditIntent({ key: "k", decisionBody: '{"block":"2"}', decisionHash: hash }, calldata(hash.slice(2))).verdict, "log-altered");
  assert.equal(auditIntent({ key: "k", decisionBody: body, decisionHash: hash }, calldata("cd".repeat(32))).verdict, "chain-differs");
  assert.equal(auditIntent({ key: "k", decisionBody: body, decisionHash: hash }, calldata("")).verdict, "chain-differs");
  assert.equal(auditIntent({ key: "k", decisionBody: body, decisionHash: hash }, null).verdict, "not-on-chain");
  assert.equal(auditIntent({ key: "k" }, calldata("")).verdict, "no-hash");
});

// SDK

test("an intent is checked strictly, and nothing is coerced", () => {
  assert.deepEqual(parseIntent({ side: "sell", amount: "1.5" }), { side: "sell", amount: "1.5" });
  for (const bad of [
    null,
    [],
    "sell",
    { side: "sell" },
    { side: "short", amount: "1" },
    { side: "sell", amount: 1 },
    { side: "sell", amount: "0" },
    { side: "sell", amount: "-1" },
    { side: "sell", amount: "1e18" },
    { side: "sell", amount: "1", to: "0xdead" },
    { side: "sell", amount: "1", slippageBps: 501 },
    { side: "sell", amount: "1", minOut: 0 },
  ]) {
    assert.throws(() => parseIntent(bad), IntentError, JSON.stringify(bad));
  }
});

test("a policy is validated by the agent's own parser", () => {
  assert.deepEqual(validatePolicy({ nonsense: true }).ok, false);
  const good = { version: 2, orders: [], edge: { enabled: false, sizeUsdt: "1", minNetUsdt: "0" }, slippageBps: 50, maxTwapDeviationBps: 200, stopConfirmBlocks: 2 };
  assert.equal(validatePolicy(good).ok, true);
});

// MCP

const fakeClient = { status: async () => ({ block: "1" }), simulate: async (i: unknown) => ({ ok: false, error: "PriceOutOfBand", simulatedOnly: true, asked: i }) } as never;
const textOf = (reply: any) => JSON.parse(reply.result.content[0].text);

test("the server introduces itself and lists only read-only tools", async () => {
  const init = (await handleMcp(fakeClient, { id: 1, method: "initialize" })) as any;
  assert.equal(init.result.serverInfo.name, "holdfast");
  const list = (await handleMcp(fakeClient, { id: 2, method: "tools/list" })) as any;
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), TOOLS.map((t) => t.name));
  for (const tool of TOOLS) assert.doesNotMatch(tool.name, /send|execute|withdraw|sign|set_|broadcast/);
});

test("a tool answers, and a simulation says it is one", async () => {
  const reply = await handleMcp(fakeClient, { id: 3, method: "tools/call", params: { name: "holdfast_simulate_trade", arguments: { side: "sell", amount: "1" } } });
  assert.equal(textOf(reply).simulatedOnly, true);
  const explained = await handleMcp(fakeClient, { id: 4, method: "tools/call", params: { name: "holdfast_explain", arguments: { code: "price-band" } } });
  assert.match(textOf(explained).meaning, /band/);
});

test("bad input gets an error result, a failed read leaks nothing, and a notification gets no answer", async () => {
  const bad = (await handleMcp(fakeClient, { id: 5, method: "tools/call", params: { name: "holdfast_simulate_trade", arguments: { side: "sell", amount: "1", to: "0xdead" } } })) as any;
  assert.equal(bad.result.isError, true);
  const failing = { status: async () => { throw new Error("https://rpc.example/secret-key failed"); }, simulate: async () => ({}) } as never;
  const originalError = console.error;
  console.error = () => {};
  const failed = (await handleMcp(failing, { id: 6, method: "tools/call", params: { name: "holdfast_status" } })) as any;
  console.error = originalError;
  assert.equal(failed.result.isError, true);
  assert.doesNotMatch(JSON.stringify(failed), /secret-key/);
  assert.equal(await handleMcp(fakeClient, { method: "notifications/initialized" }), null);
  assert.equal(((await handleMcp(fakeClient, { id: 7, method: "unknown" })) as any).error.code, -32601);
});
