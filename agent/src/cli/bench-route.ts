// Read only. Measures the network route as it is right now, so two runs can be compared: tunnel on against tunnel off,
// and what racing a second endpoint would add. It reports the route's state and never changes it.
//   bench:route -- --label warp-on --n 300 --second https://hashkey.drpc.org
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { readTick } from "../reader.js";
import { RpcClient, sleep, untilAnswered } from "../rpc.js";
import { nearestRank, quantileReport } from "../stats.js";
import { FlashblockStream } from "../stream.js";

const { values } = parseArgs({ options: { label: { type: "string", default: "route" }, n: { type: "string", default: "300" }, second: { type: "string" } } });

async function routeState(): Promise<Record<string, string>> {
  try {
    const text = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(5_000) })).text();
    return Object.fromEntries(text.split("\n").filter((line) => /^(warp|colo|loc)=/.test(line)).map((line) => line.split("=") as [string, string]));
  } catch {
    return { warp: "unknown" };
  }
}

const config = loadConfig({ NETWORK: "mainnet" });
const primary = new RpcClient(config.rpcUrl, { maxRetries: 0 });
const second = values.second ? new RpcClient(values.second, { maxRetries: 0 }) : null;
const reader = new RpcClient(config.rpcUrl, { maxRetries: 0 });
const before = await routeState();

let lastFrame = 0;
const frameGaps: number[] = [];
const stream = new FlashblockStream(config.flashblocksUrl!, (frame) => {
  if (lastFrame) frameGaps.push(frame.arrivedAt - lastFrame);
  lastFrame = frame.arrivedAt;
});
await stream.start(120_000);

const timed = async (rpc: RpcClient, run: (rpc: RpcClient) => Promise<unknown>) => {
  const start = performance.now();
  await run(rpc);
  return performance.now() - start;
};
const head = (rpc: RpcClient) => rpc.call("eth_blockNumber");

await untilAnswered(() => head(primary));
if (second) await head(second).catch(() => null);
const primaryMs: number[] = [];
const secondMs: number[] = [];
const fasterOfTwo: number[] = [];
const readMs: number[] = [];
let failures = 0;
for (let i = 0; i < Number(values.n); i++) {
  // A random offset, so samples do not lock onto the block cycle.
  await sleep(2_000 + Math.random() * 1_000);
  try {
    const [a, b, read] = await Promise.all([timed(primary, head), second ? timed(second, head) : null, timed(reader, (rpc) => readTick(rpc, config, []))]);
    primaryMs.push(a);
    readMs.push(read);
    if (b !== null) {
      secondMs.push(b);
      fasterOfTwo.push(Math.min(a, b));
    }
  } catch {
    failures++;
  }
}
const describe = (series: number[]) => (series.length ? { n: series.length, p50: nearestRank(series, 0.5), p90: quantileReport(series, 0.9), p99: quantileReport(series, 0.99) } : null);
const body = {
  label: values.label,
  lane: "mainnet, read only",
  routeBefore: before,
  routeAfter: await routeState(),
  primary: describe(primaryMs),
  second: values.second ? { url: new URL(values.second).host, ...describe(secondMs) } : null,
  fasterOfTwo: describe(fasterOfTwo),
  atomicRead: describe(readMs),
  frameGapMs: describe(frameGaps),
  failures,
};
const dir = join(config.dataDir, `route-${values.label}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "route.json"), JSON.stringify(body, null, 1));
console.log(JSON.stringify(body));
stream.close();
process.exit(0);
