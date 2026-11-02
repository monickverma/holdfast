// What one decision and one log line cost, in microseconds, on this machine. Compare runs on the same machine only.
//   npx tsx scripts/bench-decision.mjs [path to a source tree, default .]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tree = resolve(process.argv[2] ?? ".");
const load = (file) => import(pathToFileURL(join(tree, "agent/src", file)).href);
const { decide } = await load("decide.ts");
const { HSKSWAP } = await load("config.ts");
const { DEFAULT_POLICY } = await load("policy.ts");
const { JsonlLog } = await load("trace.ts");
const chained = await load("audit-log.ts").catch(() => null);

const HSK = 10n ** 18n; const USDT = 10n ** 6n;
const limits = { balance: 1_000n * HSK, maxTrade: 1_000n * HSK, remaining: 1_000n * HSK, floorPriceX18: 1n, hourlyBudget: 1_000n * HSK, available: 1_000n * HSK };
const usdtLimits = { balance: 1_000n * USDT, maxTrade: 1_000n * USDT, remaining: 1_000n * USDT, floorPriceX18: 1n, hourlyBudget: 1_000n * USDT, available: 1_000n * USDT };
const spot = 100_000n;
const market = (buyOut) => ({
  head: { number: 100n, hash: `0x${"a".repeat(64)}`, timestamp: 100n, baseFeePerGas: 1n }, sqrtPriceX96: 0n, tick: 0, twapTick: 0, liquidity: 1n, spotPriceX18: spot,
  quotes: [{ tokenIn: HSKSWAP.whsk, amountIn: (15n * USDT * HSK) / spot, amountOut: 14_900_000n, ticksCrossed: 0 }, { tokenIn: HSKSWAP.usdt, amountIn: 15n * USDT, amountOut: buyOut, ticksCrossed: 0 }],
  priorityFeePerGas: 1n, l1FeeWei: 0n, vault: { paused: false, agentExpiry: 10_000n, whsk: limits, usdt: usdtLimits },
});
const policy = { ...DEFAULT_POLICY, edge: { enabled: true, sizeUsdt: 15n * USDT, minNetUsdt: 0n, maxInventoryUsdt: 100n * USDT } };
const input = (buyOut) => ({ market: market(buyOut), policy, mark: { askX18: 100_300n, bidX18: 100_100n, fetchedAtMs: 100_000 }, runtime: new Map(), nowMs: 100_000, maxStateAgeMs: 6_000, maxMarkAgeMs: 30_000 });

function microseconds(n, work) {
  for (let i = 0; i < n / 10; i++) work(i); // Warm up the JIT first.
  const samples = [];
  for (let round = 0; round < 7; round++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < n; i++) work(i);
    samples.push(Number(process.hrtime.bigint() - start) / 1000 / n);
  }
  return samples.sort((a, b) => a - b)[3];
}

const dir = mkdtempSync(join(tmpdir(), "holdfast-bench-"));
const trade = input(160n * HSK); const hold = input(100n * HSK);
const record = { wallTime: "2026-01-01T00:00:00.000Z", block: "100", blockHash: `0x${"a".repeat(64)}`, decision: { action: "hold", code: "no-edge", reason: "Nothing clears the required net." }, policyVersion: 1, observeOnly: false, traceId: "t" };
const plain = new JsonlLog(join(dir, "plain.jsonl"));
const chain = chained ? new chained.ChainedLog(join(dir, "chain.jsonl")) : null;
const result = {
  tree: process.argv[2] ?? ".", decisions: { outcomeOfTradeInput: decide(trade).action, outcomeOfHoldInput: decide(hold).action },
  decideTradeUs: microseconds(100_000, () => decide(trade)), decideHoldUs: microseconds(100_000, () => decide(hold)),
  plainLogAppendUs: microseconds(2_000, () => plain.append(record)), chainedLogAppendUs: chain ? microseconds(2_000, () => chain.append(record)) : null,
};
plain.close?.(); chain?.close?.();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(result));
