// Turns raw traces and receipts into the reported numbers. Withholds any quantile its sample cannot support.
//   report -- data/bench-123 [--hsk-usd 0.0874]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { formatUnits } from "viem";
import { quantileReport, wilson, type QuantileReport } from "../stats.js";
import type { TraceRecord } from "../trace.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "hsk-usd": { type: "string", default: "0.0874" } } });
const dir = positionals[0] ?? "data";

const jsonl = <T>(name: string): T[] => {
  const path = join(dir, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
};

const latest = new Map<string, Record<string, string | number | undefined>>();
for (const intent of jsonl<Record<string, string | number | undefined>>("ledger.jsonl")) latest.set(String(intent.key), intent);
const intents = [...latest.values()];
const traces = jsonl<TraceRecord>("traces.jsonl");
if (new Set([...traces.map(t => t.lane), ...intents.flatMap(i => i.lane ? [String(i.lane)] : [])]).size > 1) throw new Error("Mixed lanes refused: report each run directory separately");
const sent = traces.filter((t) => typeof t.attrs.decisionToBroadcastMs === "number");

const quantiles = (samples: number[]) => ({ n: samples.length, p50: quantileReport(samples, 0.5), p95: quantileReport(samples, 0.95), p99: quantileReport(samples, 0.99) });
const fmt = (q: QuantileReport) => (q.value === null ? `withheld (${q.withheld})` : `${q.value.toFixed(1)} [${q.low?.toFixed(1) ?? "-inf"}, ${q.high?.toFixed(1) ?? "+inf"}]`);

const stages: Record<string, ReturnType<typeof quantiles>> = {};
for (const stage of [...new Set(sent.flatMap((t) => t.spans.map((s) => s.stage)))]) {
  stages[stage] = quantiles(sent.flatMap((t) => t.spans.filter((s) => s.stage === stage && s.ok).map((s) => s.endMs - s.startMs)));
}

const filled = intents.filter((i) => i.status === "included");
const reverted = intents.filter((i) => i.status === "reverted");
const settled = filled.length + reverted.length;
const inclusionBlocks = [...filled, ...reverted].flatMap((i) => (i.blockNumber !== undefined && i.broadcastBlock !== undefined ? [Number(BigInt(i.blockNumber) - BigInt(i.broadcastBlock))] : []));
const feeWei = intents.reduce((sum, i) => sum + BigInt(i.feeWei ?? 0), 0n);
const hskUsd = Number(values["hsk-usd"]);
const feeHsk = Number(formatUnits(feeWei, 18));
const llm = jsonl<{ costUsd: number; latencyMs: number }>("llm.jsonl");
const decisions = jsonl<{ decision?: { action?: string; code?: string } }>("decisions.jsonl");
const holdCodes: Record<string, number> = {};
for (const d of decisions) {
  if (d.decision?.action === "hold") holdCodes[d.decision.code ?? "?"] = (holdCodes[d.decision.code ?? "?"] ?? 0) + 1;
}
const schedule = jsonl<{ outcome: string }>("schedule.jsonl");
const outcomes: Record<string, number> = {};
for (const s of schedule) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;

const report = {
  lane: [...new Set(traces.map((t) => t.lane))],
  window: { first: traces[0]?.wallTime, last: traces.at(-1)?.wallTime },
  decisionToBroadcastMs: quantiles(sent.map((t) => t.attrs.decisionToBroadcastMs as number)),
  stageServiceMs: stages,
  inclusionBlocks: quantiles(inclusionBlocks),
  fills: filled.length,
  reverts: reverted.length,
  revertRate: settled ? { count: reverted.length, of: settled, wilson95: wilson(reverted.length, settled) } : null,
  scheduleOutcomes: outcomes,
  modelCallsInExecutionPath: traces.reduce((sum, t) => sum + Number(t.attrs.modelCalls ?? 0), 0),
  networkCost: {
    totalHsk: feeHsk,
    totalUsdAtAssumedPrice: feeHsk * hskUsd,
    perFillUsd: filled.length ? (feeHsk * hskUsd) / filled.length : null,
    hskUsdAssumed: hskUsd,
  },
  llmOutsideExecutionPath: { calls: llm.length, costUsd: llm.reduce((sum, r) => sum + r.costUsd, 0) },
  holdsByCode: holdCodes,
  decisions: decisions.length,
};
writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));

console.log(`lane ${report.lane.join(",")}, ${report.window.first} to ${report.window.last}`);
console.log(`decision-to-broadcast ms, nearest rank [95% interval], n=${report.decisionToBroadcastMs.n}`);
console.log(`  P50 ${fmt(report.decisionToBroadcastMs.p50)}\n  P95 ${fmt(report.decisionToBroadcastMs.p95)}\n  P99 ${fmt(report.decisionToBroadcastMs.p99)}`);
for (const [stage, q] of Object.entries(stages)) console.log(`  stage ${stage.padEnd(10)} P50 ${fmt(q.p50)}`);
console.log(`inclusion blocks n=${report.inclusionBlocks.n}: P50 ${fmt(report.inclusionBlocks.p50)}, P95 ${fmt(report.inclusionBlocks.p95)}`);
console.log(`fills ${report.fills}, reverts ${report.reverts}, schedule ${JSON.stringify(outcomes)}`);
console.log(`network cost ${feeHsk} HSK, about $${report.networkCost.totalUsdAtAssumedPrice.toFixed(4)} at an assumed $${hskUsd}/HSK. Model calls on the execution path: ${report.modelCallsInExecutionPath}.`);

if (report.lane.includes("testnet")) console.log("Own test market, not HSKSwap. Testnet prices, USD conversions and P&L have no economic meaning.");
