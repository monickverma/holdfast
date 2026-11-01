// Read only, with a throwaway key. Swaps on the real pool can be many minutes apart, so this asks what the send path
// costs when it has not run for a while.
//   bench:cold -- --mode local --run cold-local
//   bench:cold -- --mode network --minutes 25 --run cold-network
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { encodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../config.js";
import { RpcClient, sleep, untilAnswered } from "../rpc.js";
import { nearestRank, quantileReport } from "../stats.js";
import { decodeFrame, lastSwap, v3Quote } from "../stream.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "local" },
    minutes: { type: "string", default: "25" },
    run: { type: "string", default: `cold-${Date.now()}` },
    once: { type: "boolean", default: false },
    processes: { type: "string", default: "20" },
  },
});

const POOL = "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc";
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const account = privateKeyToAccount(generatePrivateKey());
const frameJson = JSON.stringify({
  index: 3,
  metadata: {
    block_number: 500,
    receipts: { "0xaa": { Eip1559: { logs: [{ address: POOL, topics: [SWAP], data: encodeAbiParameters(parseAbiParameters("int256, int256, uint160, uint128, int24"), [1n, -1n, (2n ** 96n * 10015n) / 10000n, 10n ** 24n, 30]) }] } } },
  },
});

/** Everything between a frame arriving and the bytes being ready, on throwaway data. */
async function hotPath(): Promise<{ decodeMs: number; signMs: number }> {
  const start = performance.now();
  const frame = decodeFrame(frameJson);
  const state = lastSwap(frame, POOL)!;
  v3Quote(state, true, 10n ** 15n, 3000);
  const decoded = performance.now();
  await account.signTransaction({ type: "eip1559", chainId: 2 ** 40, nonce: 1, to: POOL as Hex, data: "0x1234", value: 0n, gas: 500_000n, maxPriorityFeePerGas: 1n, maxFeePerGas: 1n });
  return { decodeMs: decoded - start, signMs: performance.now() - decoded };
}

const describe = (series: number[]) => ({ n: series.length, p50: series.length ? nearestRank(series, 0.5) : null, p90: quantileReport(series, 0.9) });

if (values.once) {
  console.log(JSON.stringify(await hotPath()));
  process.exit(0);
}

const dir = join(loadConfig({ NETWORK: "mainnet" }).dataDir, values.run!);
mkdirSync(dir, { recursive: true });

if (values.mode === "local") {
  // Cold: the first run in a new process, where nothing has been compiled.
  const cold: Array<{ decodeMs: number; signMs: number }> = [];
  for (let i = 0; i < Number(values.processes); i++) {
    const child = spawnSync(process.execPath, [process.argv[1]!, "--once"], { encoding: "utf8" });
    cold.push(JSON.parse(child.stdout.trim().split("\n").at(-1)!));
  }
  // Warm: after many runs. Idle: the same warmed process after each pause, which is what the real pool's gaps look like.
  for (let i = 0; i < 500; i++) await hotPath();
  const warm: Array<{ decodeMs: number; signMs: number }> = [];
  for (let i = 0; i < 200; i++) warm.push(await hotPath());
  const idle: Record<string, Array<{ decodeMs: number; signMs: number }>> = {};
  for (const pauseMs of [5_000, 30_000]) {
    idle[pauseMs] = [];
    for (let i = 0; i < 10; i++) {
      await sleep(pauseMs);
      idle[pauseMs].push(await hotPath());
    }
  }
  const total = (rows: Array<{ decodeMs: number; signMs: number }>) => rows.map((row) => row.decodeMs + row.signMs);
  const body = { cold: describe(total(cold)), warm: describe(total(warm)), idle: Object.fromEntries(Object.entries(idle).map(([pause, rows]) => [pause, describe(total(rows))])), coldSignMs: describe(cold.map((row) => row.signMs)), warmSignMs: describe(warm.map((row) => row.signMs)) };
  writeFileSync(join(dir, "cold-local.json"), JSON.stringify(body, null, 1));
  console.log(JSON.stringify(body));
  process.exit(0);
}

// Network: one client per pause, so their sockets cannot keep each other warm.
const { rpcUrl } = loadConfig({ NETWORK: "mainnet" });
const endAt = Date.now() + Number(values.minutes) * 60_000;
const series: Record<string, { ms: number[]; newSockets: number }> = {};

async function idleLoop(pauseMs: number) {
  const rpc = new RpcClient(rpcUrl, { maxRetries: 0 });
  await untilAnswered(() => rpc.call("eth_blockNumber"));
  const row = (series[`pause-${pauseMs / 1000}s`] = { ms: [] as number[], newSockets: 0 });
  while (Date.now() < endAt) {
    await sleep(pauseMs + Math.random() * Math.min(pauseMs / 5, 500));
    const before = rpc.stats.newSockets;
    const start = performance.now();
    try {
      await rpc.call("eth_blockNumber");
      row.ms.push(performance.now() - start);
      row.newSockets += rpc.stats.newSockets - before;
    } catch {
      // Counted by its absence from n; a failed read says nothing about warm or cold time.
    }
  }
  rpc.close();
}

/** A send arriving while a read holds the connection, sharing one pool or on its own warm lane. */
async function laneLoop() {
  const shared = new RpcClient(rpcUrl, { maxRetries: 0 });
  const lane = new RpcClient(rpcUrl, { maxRetries: 0 });
  await untilAnswered(() => Promise.all([shared.call("eth_blockNumber"), lane.call("eth_blockNumber")]));
  const sharedRow = (series["send-shared-pool"] = { ms: [] as number[], newSockets: 0 });
  const laneRow = (series["send-own-lane"] = { ms: [] as number[], newSockets: 0 });
  let readsSeen = 0;
  while (Date.now() < endAt) {
    await sleep(5_000 + Math.random() * 2_000);
    // Long idle pauses close spare sockets on many servers, which is the case that matters here.
    if (readsSeen++ % 10 === 0) await sleep(30_000);
    const read = shared.call("eth_blockNumber");
    const startedAt = performance.now();
    const beforeShared = shared.stats.newSockets;
    const beforeLane = lane.stats.newSockets;
    try {
      const [sharedDone, laneDone] = await Promise.all([
        shared.call("eth_blockNumber").then(() => performance.now() - startedAt),
        lane.call("eth_blockNumber").then(() => performance.now() - startedAt),
        read,
      ]);
      sharedRow.ms.push(sharedDone);
      laneRow.ms.push(laneDone);
      sharedRow.newSockets += shared.stats.newSockets - beforeShared;
      laneRow.newSockets += lane.stats.newSockets - beforeLane;
    } catch {
      // As above.
    }
  }
  shared.close();
  lane.close();
}

function report() {
  writeFileSync(join(dir, "cold-network.json"), JSON.stringify(Object.fromEntries(Object.entries(series).map(([name, row]) => [name, { ...describe(row.ms), newSockets: row.newSockets }])), null, 1));
}
const reporter = setInterval(report, 30_000);
await Promise.all([idleLoop(5_000), idleLoop(30_000), idleLoop(120_000), laneLoop()]);
clearInterval(reporter);
report();
process.exit(0);
