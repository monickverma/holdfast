import { networkProfile } from "../config.js";
// Live latency benchmark: a fixed schedule of small alternating swaps through the vault. Real money on mainnet.
//   bench:swaps -- --n 299 --usd 1 --interval 6 --broadcast
// Self-trades in a thin pool: report these as a benchmark, never as volume.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Agent } from "../agent.js";
import { loadConfig } from "../config.js";
import { DEFAULT_POLICY, type Policy } from "../policy.js";
import { sleep } from "../rpc.js";
import { JsonlLog } from "../trace.js";

try {
  process.loadEnvFile();
} catch {
  // A .env file is optional; the environment may already be set.
}

const { values } = parseArgs({
  options: {
    broadcast: { type: "boolean", default: false },
    n: { type: "string", default: "299" },
    usd: { type: "string", default: "1" },
    interval: { type: "string", default: "6" },
    run: { type: "string", default: `bench-${Date.now()}` },
    lane: { type: "string", default: "mainnet" },
  },
});
if (!values.broadcast) throw new Error("This sends real swaps. Add --broadcast only when you mean it.");

const n = Number(values.n);
const usdMicro = BigInt(Math.round(Number(values.usd) * 1e6));
const intervalMs = Number(values.interval) * 1000;
const dataDir = join(loadConfig().dataDir, values.run!);
mkdirSync(dataDir, { recursive: true });
const config = { ...loadConfig(), live: true, dataDir };
if (!config.vault || !config.agentKey) throw new Error("Set VAULT_ADDRESS and AGENT_PRIVATE_KEY in your local .env");

let policy: Policy = DEFAULT_POLICY;
const agent = new Agent({ config, lane: networkProfile().network === "testnet" ? "testnet" : values.lane as "mainnet" | "fork", policy: () => policy, mark: () => null });
const outcomes = new JsonlLog(join(dataDir, "schedule.jsonl"));

await agent.step(performance.now(), true);
const start = performance.now();
const counts = { sent: 0, skippedInFlight: 0, held: 0, errors: 0 };

for (let k = 0; k < n; k++) {
  const intended = start + k * intervalMs;
  while (performance.now() < intended) {
    await agent.settleInFlight();
    await sleep(Math.min(400, Math.max(0, intended - performance.now())));
  }
  await agent.settleInFlight();

  const spot = agent.lastMarket!.spotPriceX18;
  const sell = k % 2 === 0;
  const id = `b-${k}`;
  const amountIn = sell ? (usdMicro * 10n ** 18n) / spot : usdMicro;
  policy = { ...DEFAULT_POLICY, orders: [{ id, kind: sell ? "market-sell" : "market-buy", amountIn }] };

  // Nothing is dropped: a skip, hold or error is logged against its slot.
  let outcome = "error";
  if (agent.ledger.inFlight()) {
    outcome = "skipped-in-flight";
    counts.skippedInFlight++;
  } else {
    try {
      let record = await agent.step(intended, true);
      // Sizes came from balances read before the last swap settled. Retrying keeps the intended time, so the
      // extra read counts as latency.
      if (record?.decision.action === "hold" && record.decision.code === "requote") record = await agent.step(intended, true);
      if (record?.intent) {
        outcome = "sent";
        counts.sent++;
      } else {
        outcome = record?.decision.action === "hold" ? `hold:${record.decision.code}` : "no-send";
        counts.held++;
      }
    } catch (error) {
      outcome = `error:${error}`;
      counts.errors++;
    }
  }
  outcomes.append({ k, intendedOffsetMs: k * intervalMs, sell, outcome, wallTime: new Date().toISOString() });
  if ((k + 1) % 10 === 0) console.log(`${k + 1}/${n} ${JSON.stringify(counts)}`);
}

for (let i = 0; i < 60 && agent.ledger.inFlight(); i++) {
  await agent.settleInFlight();
  await sleep(500);
}
console.log(`finished ${JSON.stringify(counts)}, data in ${dataDir}\nrpc ${JSON.stringify(agent.rpc.stats)}`);
agent.close();
