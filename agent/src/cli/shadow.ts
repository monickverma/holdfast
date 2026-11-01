// Read only, and it never loads a wallet key. Runs the real decision code against the real HSKSwap pool and a real
// outside price, and records what the agent would have done. Nothing is sent, so these are simulated results.
//   shadow -- --minutes 90 --run shadow-mainnet
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseUnits } from "viem";
import { HSKSWAP, loadConfig, networkProfile } from "../config.js";
import { decide, plannedQuotes } from "../decide.js";
import { MarkFeed } from "../mark.js";
import { DEFAULT_POLICY, type Policy } from "../policy.js";
import { readTick, type MarketState, type QuoteRequest } from "../reader.js";
import { RpcClient, sleep, untilAnswered } from "../rpc.js";
import { analyzeShadow, OPEN_LIMITS, SHADOW_DEFAULTS, toShadowSample, type ShadowSample } from "../shadow.js";
import { JsonlLog } from "../trace.js";

const { values } = parseArgs({ options: { minutes: { type: "string", default: "90" }, run: { type: "string", default: `shadow-${Date.now()}` } } });
if (networkProfile().network !== "mainnet") throw new Error("This reads the real pool, so it needs NETWORK=mainnet");

const config = { ...loadConfig({ NETWORK: "mainnet" }), vault: undefined };
const rpc = new RpcClient(config.rpcUrl);
const dir = join(config.dataDir, values.run!);
mkdirSync(dir, { recursive: true });
const samplesPath = join(dir, "shadow-samples.jsonl");
const samples = new JsonlLog(samplesPath);

// Chosen before any data was collected: $15 is the median size real traders use on this pool. The others show sensitivity.
const POLICY: Policy = { ...DEFAULT_POLICY, edge: { enabled: true, sizeUsdt: 15_000_000n, minNetUsdt: 0n } };
const SIZES = [1, 5, 15, 50, 150];
const NO_RUNTIME = new Map();

const marks = new MarkFeed(1_000);
marks.start();
while (!marks.latest) await sleep(100);

let seed = await untilAnswered(() => readTick(rpc, config, []));
while (!seed) seed = await untilAnswered(() => readTick(rpc, config, []));
let last: MarketState = seed.market;
// Sell sizes are fixed in HSK at the starting price, so a row always means the same trade.
const startPrice = Number(last.spotPriceX18) / 1e6;
const fixed: QuoteRequest[] = SIZES.flatMap((usdt) => [
  { tokenIn: HSKSWAP.whsk, amountIn: parseUnits((usdt / startPrice).toFixed(6), 18) },
  { tokenIn: HSKSWAP.usdt, amountIn: BigInt(usdt) * 1_000_000n },
]);
const sizeOf = SIZES.flatMap((usdt) => [usdt, usdt]);

const endAt = Date.now() + Number(values.minutes) * 60_000;
let reads = 0;
let refused = 0;
let failed = 0;
let lastFailure = "";
let reportedAt = Date.now();

function report(): void {
  const all = readFileSync(samplesPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ShadowSample);
  const body = {
    lane: "mainnet, read only, simulated fills",
    venue: "HSKSwap WHSK/USDT against the Gate HSK/USDT top of book",
    policy: "Edge rule at $15, chosen before collecting data",
    assumptions: { hedgeFeeBps: "Assumed 20 bps taker fee on the outside venue", gas: "200,000 gas at the current base fee, plus the L1 fee" },
    reads,
    refusedStraddledReads: refused,
    failedReads: failed,
    lastFailure,
    markFailures: marks.failures,
    ...analyzeShadow(all),
    noHedgeFee: analyzeShadow(all, { ...SHADOW_DEFAULTS, hedgeFeeBps: 0 }).rows,
  };
  writeFileSync(join(dir, "shadow-report.json"), JSON.stringify(body, null, 1));
}

while (Date.now() < endAt) {
  const startedAt = Date.now();
  try {
    const requests = [...fixed, ...plannedQuotes(POLICY, last, NO_RUNTIME)];
    const tick = await readTick(rpc, config, requests);
    reads++;
    if (!tick) refused++;
    else if (marks.latest) {
      last = tick.market;
      const now = Date.now();
      const decision = decide({
        market: { ...tick.market, vault: { paused: false, agentExpiry: null, whsk: OPEN_LIMITS, usdt: OPEN_LIMITS } },
        policy: POLICY,
        mark: marks.latest,
        runtime: NO_RUNTIME,
        nowMs: now,
        maxStateAgeMs: config.maxStateAgeMs,
        maxMarkAgeMs: config.maxMarkAgeMs,
      });
      samples.append(toShadowSample(tick.market, marks.latest, sizeOf, now, decision.action === "trade" ? "trade" : decision.code));
    }
  } catch (error) {
    failed++;
    lastFailure = String(error).slice(0, 200);
  }
  if (Date.now() - reportedAt > 60_000) {
    report();
    reportedAt = Date.now();
  }
  // A random offset, so samples do not lock onto the block cycle. This is a public RPC, so one read per block is plenty.
  await sleep(Math.max(0, 2_000 + Math.random() * 500 - (Date.now() - startedAt)));
}
report();
console.log(readFileSync(join(dir, "shadow-report.json"), "utf8"));
marks.stop();
rpc.close();
process.exit(0);
