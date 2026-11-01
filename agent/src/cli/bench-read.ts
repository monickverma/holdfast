// Paired read benchmark: the three-round-trip pinned path against the one-round-trip atomic path, alternating on a
// fixed schedule so both see the same network. Reads only, so it can run against mainnet and the real HSKSwap pool.
//   bench:read -- --n 400 --interval 1 --run reads-mainnet
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import { HSKSWAP, loadConfig, networkProfile } from "../config.js";
import { readHead, readMarket, readTick, type MarketState } from "../reader.js";
import { RpcClient, RpcError, sleep } from "../rpc.js";
import { quantileReport, wilson } from "../stats.js";
import { JsonlLog, toJson } from "../trace.js";

try {
  process.loadEnvFile();
} catch {
  // A .env file is optional; the environment may already be set.
}

const { values } = parseArgs({
  options: {
    n: { type: "string", default: "400" },
    interval: { type: "string", default: "1" },
    run: { type: "string", default: `reads-${Date.now()}` },
    // Random offset per slot. A fixed interval that is a multiple of the block or flashblock time always samples the
    // same phase, which biases anything that waits for the next one.
    "jitter-ms": { type: "string", default: "0" },
    // Every this many atomic reads, read the same block the pinned way and compare every value.
    "verify-every": { type: "string", default: "10" },
  },
});

const perArm = Number(values.n);
const intervalMs = Number(values.interval) * 1000;
const verifyEvery = Number(values["verify-every"]);
const profile = networkProfile();
const config = loadConfig();
const dataDir = join(config.dataDir, values.run!);
mkdirSync(dataDir, { recursive: true });
const samples = new JsonlLog(join(dataDir, "read-samples.jsonl"));
const rpc = new RpcClient(config.rpcUrl);

const agent = process.env.AGENT_PRIVATE_KEY ? privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`).address : undefined;
const quotes = [{ tokenIn: HSKSWAP.whsk, amountIn: 10n ** 18n }];

/** The values a decision depends on. Fee fields are excluded: the node's suggestion is not tied to a block. */
const comparable = (m: MarketState) =>
  toJson({ sqrtPriceX96: m.sqrtPriceX96, tick: m.tick, twapTick: m.twapTick, liquidity: m.liquidity, quotes: m.quotes, l1FeeWei: m.l1FeeWei, vault: m.vault });

const arms: Record<string, number[]> = { pinned: [], atomic: [] };
const failures: Record<string, string[]> = { pinned: [], atomic: [] };
let atomicMisses = 0;
let verified = 0;
let verifyMismatches = 0;
let atomicDone = 0;

await rpc.call("eth_chainId");
const start = performance.now();
for (let k = 0; k < perArm * 2; k++) {
  const intended = start + k * intervalMs + Math.random() * Number(values["jitter-ms"]);
  const wait = intended - performance.now();
  if (wait > 0) await sleep(wait);

  const arm = k % 2 === 0 ? "pinned" : "atomic";
  const before = rpc.stats.httpRequests;
  let latencyMs: number | null = null;
  let miss = false;
  let tickMarket: MarketState | null = null;
  try {
    if (arm === "pinned") {
      const head = await readHead(rpc);
      await readMarket(rpc, config, head, quotes);
      if (agent) await rpc.call("eth_getTransactionCount", [agent, "pending"]);
    } else {
      const tick = await readTick(rpc, config, quotes, agent);
      if (tick) tickMarket = tick.market;
      else {
        // A miss really costs the fallback, so the sample includes it.
        miss = true;
        atomicMisses++;
        const head = await readHead(rpc);
        await readMarket(rpc, config, head, quotes);
        if (agent) await rpc.call("eth_getTransactionCount", [agent, "pending"]);
      }
    }
    latencyMs = performance.now() - intended;
    arms[arm]!.push(latencyMs);
  } catch (error) {
    failures[arm]!.push(String(error));
    if (error instanceof RpcError && /http (429|403)/.test(error.message)) {
      console.log(`rate limited at slot ${k}; stopping with what was collected`);
      samples.append({ k, arm, error: String(error), wallTime: new Date().toISOString() });
      break;
    }
  }
  samples.append({ k, arm, latencyMs, miss, httpRequests: rpc.stats.httpRequests - before, wallTime: new Date().toISOString() });

  if (tickMarket && ++atomicDone % verifyEvery === 0) {
    try {
      const pinned = await readMarket(rpc, config, tickMarket.head, quotes);
      verified++;
      if (comparable(pinned) !== comparable(tickMarket)) {
        verifyMismatches++;
        samples.append({ k, verifyMismatch: true, atomic: comparable(tickMarket), pinned: comparable(pinned) });
      }
    } catch (error) {
      samples.append({ k, verifyError: String(error) });
    }
  }
  if ((k + 1) % 50 === 0) console.log(`${k + 1}/${perArm * 2} misses ${atomicMisses} verified ${verified} mismatches ${verifyMismatches}`);
}

const summarize = (data: number[]) => ({ n: data.length, p50: quantileReport(data, 0.5), p95: quantileReport(data, 0.95), p99: quantileReport(data, 0.99) });
const report = {
  lane: profile.lane,
  venue: profile.network === "mainnet" ? "HSKSwap WHSK/USDT, read only" : "own test market",
  loadModel: `open loop, one slot every ${intervalMs} ms plus up to ${values["jitter-ms"]} ms random offset, arms alternating`,
  window: { end: new Date().toISOString() },
  pinned: { ...summarize(arms.pinned!), failures: failures.pinned!.length },
  atomic: { ...summarize(arms.atomic!), failures: failures.atomic!.length },
  atomicMisses: { count: atomicMisses, of: arms.atomic!.length, wilson95: arms.atomic!.length ? wilson(atomicMisses, arms.atomic!.length) : null },
  equivalence: { blocksCompared: verified, mismatches: verifyMismatches, wilson95: verified ? wilson(verifyMismatches, verified) : null },
  rpc: rpc.stats,
};
writeFileSync(join(dataDir, "read-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ pinned: report.pinned.p50, atomic: report.atomic.p50, pinnedP95: report.pinned.p95, atomicP95: report.atomic.p95, misses: report.atomicMisses, equivalence: report.equivalence }, null, 1));
rpc.close();
