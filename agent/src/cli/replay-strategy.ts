// Replays recorded mainnet samples through the real decide(), for the rules or for a live model as the engine. Reads
// one file and, for the model, calls the model; it never reads a chain or loads a wallet key. Fills are simulated.
//   node .test-build/src/cli/replay-strategy.js --engine rules --samples evidence/shadow/shadow-samples.jsonl --out evidence/v4/replay-rules-2026-11-01.json
//   node --env-file=<path to .env> .test-build/src/cli/replay-strategy.js --engine model --max-calls 40 --max-usd 0.10 ...
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { NO_MODEL_KEY } from "../nl.js";
import { DEFAULT_AI, DEFAULT_POLICY, serializePolicy, type Policy } from "../policy.js";
import { REPLAY_CAVEATS, replayStrategy, type ReplayReport } from "../replay.js";
import type { ShadowSample } from "../shadow.js";
import { strategistFromEnv } from "../strategist.js";
import { toJson } from "../trace.js";

// The samples are mainnet reads, so the addresses must be mainnet's whatever an env file says.
process.env.NETWORK = "mainnet";
// Nothing here signs, and an env file shared with the agent may hold its keys, so they are dropped before anything runs.
for (const name of ["AGENT_PRIVATE_KEY", "OWNER_PRIVATE_KEY", "GUARDIAN_PRIVATE_KEY"]) delete process.env[name];

const { values } = parseArgs({
  options: {
    engine: { type: "string", default: "rules" },
    samples: { type: "string", default: "evidence/shadow/shadow-samples.jsonl" },
    out: { type: "string" },
    "max-calls": { type: "string", default: "40" },
    "max-usd": { type: "string", default: "0.10" },
  },
});
const engine = values.engine!;
if (engine !== "rules" && engine !== "model") throw new Error("--engine must be rules or model");
const out = values.out ?? `evidence/v4/replay-${engine}.json`;
const samples = readFileSync(values.samples!, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as ShadowSample);
const span = { first: new Date(samples[0]!.atMs).toISOString(), last: new Date(samples.at(-1)!.atMs).toISOString(), hours: (samples.at(-1)!.atMs - samples[0]!.atMs) / 3_600_000 };
const OPTIONS = { maxMarkAgeMs: 5_000, maxStateAgeMs: 6_000 };
const USDT = 1_000_000n;

// Sizes and minimums chosen before this replay was run: $15 is the shadow run's own size, the median real trade here.
const rulePolicies: Record<string, Policy> = {
  "edge, $15, nothing closes it (the rule as it was)": { ...DEFAULT_POLICY, edge: { enabled: true, sizeUsdt: 15n * USDT, minNetUsdt: 0n } },
  "edge, $15, closes in this pool": { ...DEFAULT_POLICY, edge: { enabled: true, sizeUsdt: 15n * USDT, minNetUsdt: 0n, unwind: true } },
  "edge, $5, closes in this pool": { ...DEFAULT_POLICY, edge: { enabled: true, sizeUsdt: 5n * USDT, minNetUsdt: 0n, unwind: true } },
};

const base = {
  wallTime: new Date().toISOString(),
  source: values.samples,
  samplesSpan: span,
  caveats: REPLAY_CAVEATS,
};

if (engine === "rules") {
  const results: Array<{ name: string; policy: unknown } & ReplayReport> = [];
  for (const [name, policy] of Object.entries(rulePolicies)) {
    results.push({ name, policy: serializePolicy(policy), ...(await replayStrategy(samples, policy, OPTIONS)) });
  }
  write({ ...base, lane: "replay: recorded mainnet reads, simulated fills, no model", engine, results });
  for (const r of results) console.log(`${r.name}: ${r.fills.length} fills ${JSON.stringify(r.fillsByTrigger)}, net ${r.netUsdt} USDT, open ${r.openInventoryHsk} HSK`);
} else {
  let clock = samples[0]!.atMs;
  const maxCalls = Number(values["max-calls"]);
  const maxUsd = Number(values["max-usd"]);
  // What the model saw and said, each time, so its judgment can be read and not just counted.
  const answers: unknown[] = [];
  const strategist = strategistFromEnv(process.env, {
    maxUsdPerDay: maxUsd,
    now: () => clock,
    onProposal: ({ proposal, error, snapshot }) =>
      answers.push({
        block: snapshot.block,
        poolVsOutsideMidBps: snapshot.poolVsOutsideMidBps,
        edge: snapshot.edge,
        inventory: snapshot.inventory,
        ...(proposal ? { action: proposal.action, amountIn: proposal.amountIn.toString(), reason: proposal.reason } : { error }),
      }),
  });
  if (!strategist) {
    write({ ...base, lane: "replay, live model", engine, status: "BLOCKED", reason: `${NO_MODEL_KEY}, so no model was called. Nothing about the model engine's results is claimed.` });
    console.log(NO_MODEL_KEY);
    process.exit(2);
  }
  const policy: Policy = {
    ...DEFAULT_POLICY,
    ai: { ...DEFAULT_AI, enabled: true, maxSizeUsdt: 15n * USDT, maxInventoryUsdt: 15n * USDT, maxCallsPerDay: maxCalls },
  };
  const report = await replayStrategy(samples, policy, { ...OPTIONS, strategist, setClock: (ms) => (clock = ms) });
  write({
    ...base,
    lane: "replay: recorded mainnet reads, simulated fills, live model",
    engine,
    model: strategist.model,
    limits: { maxCalls, maxUsd, note: "The model was asked only when the signal changed and at most once every 30 blocks, as live." },
    policy: serializePolicy(policy),
    ...report,
    answers,
  });
  console.log(`${strategist.model}: asked ${report.model!.asked}, failed ${report.model!.failures}, $${report.model!.costUsd.toFixed(4)}; ${report.fills.length} fills ${JSON.stringify(report.fillsByTrigger)}, net ${report.netUsdt} USDT, open ${report.openInventoryHsk} HSK`);
}

function write(body: unknown): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${toJson(body).length > 2_000_000 ? toJson(body) : JSON.stringify(JSON.parse(toJson(body)), null, 1)}\n`);
  console.log(`Written to ${out}`);
}
