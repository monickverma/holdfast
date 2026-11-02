// Read-only check of everything the agent depends on. Sends no transaction. Exits 1 unless the venue check passes.
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { getAddress, type Address } from "viem";
import type { TradeDecision } from "../decide.js";
import { DEFAULT_POLICY } from "../policy.js";
import { judgePreflight, preflightTrade } from "../preflight.js";
import { HSKSWAP, loadConfig } from "../config.js";
import { readHead, readMarket } from "../reader.js";
import { RpcClient } from "../rpc.js";
import { nearestRank } from "../stats.js";
import { allowsLive, verifyVenue } from "../venue.js";

const { values } = parseArgs({ options: { out: { type: "string" }, agent: { type: "string" } } });
const config = loadConfig();
const rpc = new RpcClient(config.rpcUrl);

const report = await verifyVenue(rpc, config, values.agent as Address | undefined);
console.log(`rpc      ${config.rpcUrl}`);
console.log(`chain    ${report.chainId}  block ${report.block}`);
for (const check of report.checks) console.log(`${check.status.padEnd(10)} ${check.name.padEnd(30)} ${check.detail}`);
console.log(`verdict  ${report.verdict}`);
const save = (extra: Record<string, unknown> = {}) => {
  if (values.out) writeFileSync(values.out, `${JSON.stringify({ wallTime: new Date().toISOString(), lane: "live read only", rpc: config.rpcUrl, ...report, ...extra }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
};
save();
if (!allowsLive(report)) {
  rpc.close();
  process.exit(1);
}

const quoteRequests = [
  { tokenIn: HSKSWAP.whsk, amountIn: 10n ** 19n },
  { tokenIn: HSKSWAP.usdt, amountIn: 10n ** 6n },
];
const samples: number[] = [];
let market;
for (let i = 0; i < Number(process.env.PREFLIGHT_N ?? 12); i++) {
  const head = await readHead(rpc);
  const start = performance.now();
  market = await readMarket(rpc, config, head, quoteRequests);
  samples.push(performance.now() - start);
  await new Promise((resolve) => setTimeout(resolve, 650));
}
if (!market) throw new Error("no reads ran");

const [sell, buy] = market.quotes;
console.log(`block    ${market.head.number} ${market.head.hash}`);
console.log(`price    ${Number(market.spotPriceX18) / 1e6} USDT per HSK, tick ${market.tick}, twap tick ${market.twapTick}`);
console.log(`quote    10 WHSK -> ${Number(sell!.amountOut) / 1e6} USDT`);
console.log(`quote    1 USDT -> ${Number(buy!.amountOut) / 1e18} WHSK`);
console.log(`fees     base ${market.head.baseFeePerGas} tip ${market.priorityFeePerGas} l1 ${market.l1FeeWei} wei`);
console.log(`pinned batch  n=${samples.length} P50=${nearestRank(samples, 0.5).toFixed(1)}ms max=${Math.max(...samples).toFixed(1)}ms`);
console.log(`rpc stats     ${JSON.stringify(rpc.stats)}`);
if (market.vault) console.log(`vault    ${config.vault} ${JSON.stringify(market.vault, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);

// One real question for a real trade: what the vault and the node say if this agent sold 10 WHSK now. Only eth_call, eth_estimateGas and eth_getBalance.
if (config.vault && values.agent) {
  const decision: TradeDecision = { action: "trade", trigger: "market", orderId: null, tokenIn: HSKSWAP.whsk, amountIn: sell!.amountIn ?? 10n ** 19n, quotedOut: sell!.amountOut, minOut: (sell!.amountOut * 99n) / 100n, ledger: {} as TradeDecision["ledger"], reason: "read-only preflight sample" };
  const timings: number[] = [];
  let answer = await preflightTrade(rpc, config.vault, getAddress(values.agent), decision, market.head);
  for (let i = 0; i < Number(process.env.PREFLIGHT_TRADE_N ?? 8); i++) {
    const start = performance.now();
    answer = await preflightTrade(rpc, config.vault, getAddress(values.agent), decision, market.head);
    timings.push(performance.now() - start);
  }
  const verdict = judgePreflight(decision, answer, market, null, DEFAULT_POLICY);
  for (const check of verdict.checks) console.log(`${String(check.ok).padEnd(10)} ${check.source.padEnd(14)} ${check.name.padEnd(14)} ${check.detail ?? ""}`);
  console.log(`trade    ${verdict.hold ? `held: ${verdict.hold.code}: ${verdict.hold.reason}` : "would go out"}`);
  console.log(`latency  n=${timings.length} P50=${nearestRank(timings, 0.5).toFixed(1)}ms max=${Math.max(...timings).toFixed(1)}ms`);
  save({ tradePreflight: { sentNothing: true, amountIn: decision.amountIn, minOut: decision.minOut, block: market.head.number, vaultSaid: answer.ok, amountOut: answer.amountOut, gasEstimate: answer.gasEstimate, balanceWei: answer.balanceWei, checks: verdict.checks, held: verdict.hold && { code: verdict.hold.code, reason: verdict.hold.reason }, latencyMs: { n: timings.length, p50: nearestRank(timings, 0.5), max: Math.max(...timings) } } });
}
rpc.close();
