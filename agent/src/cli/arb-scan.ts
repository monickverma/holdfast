// Read only, and it never loads a wallet key. At one block at a time, asks every WHSK/USDT venue on mainnet what a
// round trip would pay, for small sizes, after both venues' fees, price impact and the network cost of each swap.
//   node .test-build/src/cli/arb-scan.js --minutes 75
// Every read in a sample is pinned to one block hash, so the legs of a trip see the same state. One request at a time.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Hex } from "viem";
import { ARB_GAS_PER_LEG, ARB_NOT_SAMPLED, arbRoutes, ARB_VENUES, legCostUsdt, packSample, parseArbSamples, quoteKey, replayArb, resolveTrips, summarizeArb, tripCostUsdt, type ArbHeader, type ArbSample, type QuoteKey } from "../arb.js";
import { multicall, readOrientation, readQuotes, reservesFrom, reservesSubs, sub } from "../arb-read.js";
import { MAINNET_MARKET } from "../config.js";
import { spotPriceX18 } from "../reader.js";
import { RpcClient, sleep, untilAnswered } from "../rpc.js";
import { toJson } from "../trace.js";

const { values } = parseArgs({ options: { minutes: { type: "string", default: "75" }, out: { type: "string" }, "interval-ms": { type: "string", default: "8000" } } });
const startedAt = new Date();
const stem = values.out ?? `evidence/v4/arb-scan-${startedAt.toISOString().slice(0, 10)}`;
const samplesPath = `${stem}.samples.jsonl`;
const reportPath = `${stem}.json`;

/** Chosen before any sample was read: the task's 1, 5 and 15 USDT, and smaller ones because the other pools are small. */
const SIZES_USDT = [0.1, 0.25, 0.5, 1, 5, 15];
/** A representative signed swap, as reader.ts uses for the L1 data fee. */
const SAMPLE_TX: Hex = `0x${"a5".repeat(200)}`;

const rpc = new RpcClient("https://mainnet.hsk.xyz");
const routes = arbRoutes();
const header: ArbHeader = { routes: routes.map((r) => r.id), sizesUsdt: SIZES_USDT };

// The order of each pair's tokens never changes, so it is read once.
const firstHead = await untilAnswered(() => rpc.call<{ hash: Hex }>("eth_getBlockByNumber", ["latest", false]));
const orientation = await readOrientation(rpc, firstHead.hash);

writeFileSync(samplesPath, `${JSON.stringify(header)}\n`);

let reads = 0;
let failed = 0;
let lastFailure = "";
const rounds: number[] = [];

async function sampleOnce(): Promise<ArbSample> {
  const [block, priority] = await rpc.batch([
    { method: "eth_getBlockByNumber", params: ["latest", false] },
    { method: "eth_maxPriorityFeePerGas", params: [] },
  ]);
  const head = block as { number: Hex; hash: Hex; timestamp: Hex; baseFeePerGas?: Hex };
  const base = await multicall(rpc, head.hash, [sub(MAINNET_MARKET.pool, "slot0", []), sub(MAINNET_MARKET.gasOracle, "getL1Fee", [SAMPLE_TX]), ...reservesSubs()]);
  if (!base[0] || base[1] === null) throw new Error("pool or gas oracle did not answer");
  const reserves = reservesFrom(base.slice(2), orientation);
  const quotes = new Map<string, bigint | null>();
  const resolve = (key: QuoteKey) => quotes.get(quoteKey(key));
  const sizes = SIZES_USDT.map((s) => BigInt(Math.round(s * 1e6)));

  // Each pass reads the next quote every unfinished trip needs. Two remote legs at most, so two passes at most.
  let pass = 0;
  let resolved = resolveTrips(routes, sizes, reserves, resolve);
  while (resolved.pending.length && pass < 4) {
    await readQuotes(rpc, head.hash, resolved.pending, quotes, quoteKey);
    pass++;
    resolved = resolveTrips(routes, sizes, reserves, resolve);
  }
  rounds.push(pass);

  const [sqrtPriceX96] = base[0] as readonly [bigint];
  const spot = spotPriceX18(sqrtPriceX96);
  const cost = { gasPerLeg: ARB_GAS_PER_LEG, gasPriceWei: BigInt(head.baseFeePerGas ?? "0x0") + BigInt(priority as Hex), l1FeeWei: base[1] as bigint, spotPriceX18: spot };
  const trips = resolved.trips.map((result) => {
    const network = tripCostUsdt(routes.find((r) => r.id === result.route)!, cost);
    return { route: result.route, sizeUsdt: Number(result.sizeUsdt) / 1e6, grossUsdt: Number(result.grossUsdt) / 1e6, netUsdt: Number(result.grossUsdt - network) / 1e6 };
  });
  return { atMs: Date.now(), block: BigInt(head.number).toString(), spot: Number(spot) / 1e6, legUsdt: Number(legCostUsdt(cost)) / 1e6, gasPriceWei: cost.gasPriceWei.toString(), l1FeeWei: cost.l1FeeWei.toString(), trips };
}

function report(): void {
  const { samples } = parseArbSamples(readFileSync(samplesPath, "utf8"));
  const summary = summarizeArb(samples);
  const body = {
    lane: "mainnet read-only, no trades",
    startedAt: startedAt.toISOString(),
    updatedAt: new Date().toISOString(),
    rpc: "https://mainnet.hsk.xyz",
    chainId: 177,
    samplesFile: samplesPath,
    method: "Each sample: the latest block's hash, then Multicall3 eth_calls pinned to that hash: HSKSwap slot0, the L1 gas oracle, the constant-product pairs' reserves, and every quote each trip needs, by the HSKSwap QuoterV2 and DODO's own query functions. Constant-product legs are computed from reserves with the fee each pair charges",
    venues: ARB_VENUES,
    notSampled: ARB_NOT_SAMPLED,
    assumptions: {
      gasPerLeg: `${ARB_GAS_PER_LEG}, the median HSKSwap router swap on a fork (evidence/v3/gas-compare.json). The other venues' swaps were not measured and are charged the same`,
      transactions: "One transaction per leg, at the block's base fee plus eth_maxPriorityFeePerGas, plus one L1 data fee per leg for a 200-byte transaction. An atomic contract would save one 21,000 intrinsic charge and one L1 fee per extra leg; no such contract exists here",
      fills: "Quotes, not fills. Nothing was sent. A trip's net is what both venues quoted at that block, less network cost",
      opportunities: "Consecutive samples in which some trip nets above zero are one opportunity, valued at its first sample, because a real fill closes the gap",
    },
    sizesUsdt: SIZES_USDT,
    reads,
    failedReads: failed,
    lastFailure,
    quotePasses: rounds.length ? { max: Math.max(...rounds) } : null,
    ...summary,
    replay: { lane: "replay", note: "The strategy that takes each opportunity once, at its first sample. Simulated from quotes; not money earned", atZero: replayArb(samples, 0) },
  };
  writeFileSync(reportPath, `${JSON.stringify(JSON.parse(toJson(body)), null, 1)}\n`);
}

const endAt = Date.now() + Number(values.minutes) * 60_000;
const intervalMs = Number(values["interval-ms"]);
let reportedAt = Date.now();
while (Date.now() < endAt) {
  const began = Date.now();
  try {
    const sample = await sampleOnce();
    reads++;
    appendFileSync(samplesPath, `${JSON.stringify(packSample(sample, header))}\n`);
  } catch (error) {
    failed++;
    lastFailure = String(error).slice(0, 200);
  }
  if (Date.now() - reportedAt > 60_000) {
    report();
    reportedAt = Date.now();
  }
  // A random offset, so samples do not lock onto the block cycle.
  await sleep(Math.max(0, intervalMs + Math.random() * 1_000 - (Date.now() - began)));
}
report();
const final = JSON.parse(readFileSync(reportPath, "utf8"));
console.log(JSON.stringify({ samples: final.samples, hours: final.hours, samplesWithPositiveNet: final.samplesWithPositiveNet, samplesWithPositiveGross: final.samplesWithPositiveGross, best: final.best, replay: final.replay.atZero.netUsdt, failedReads: failed }, null, 1));
rpc.close();
process.exit(0);
