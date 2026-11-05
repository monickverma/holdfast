// Replays the cross-venue round trips over a recorded shadow window. The HSKSwap legs come from the quotes recorded
// then. The other venues were not recorded, so their state is read now, and used only for a venue that provably did
// not change since the window began: no log from it, and no WHSK or USDT transfer into or out of it, in between.
// Read only: eth_getLogs and eth_call, one request at a time. It never loads a key. Fills are simulated.
//   node .test-build/src/cli/arb-replay.js --samples evidence/shadow/shadow-samples.jsonl --out evidence/v4/replay-arb-2026-11-01.json [--state-block N]
// --state-block reads the venues at block N instead of the head, and checks them only from the window's start to N. Use
// it when a venue changed after the window: N must be at or after the window's last block and before that change.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pad, toEventSelector, type Hex } from "viem";
import { ARB_GAS_PER_LEG, ARB_NOT_SAMPLED, ARB_TOKENS, arbRoutes, arbSampleFromShadow, isLocal, quoteKey, replayArb, summarizeArb, venueById, type ArbSample } from "../arb.js";
import { multicall, readOrientation, readQuotes, reservesFrom, reservesSubs } from "../arb-read.js";
import { RpcClient, untilAnswered } from "../rpc.js";
import type { ShadowSample } from "../shadow.js";
import { toJson } from "../trace.js";

process.env.NETWORK = "mainnet";
const { values } = parseArgs({ options: { samples: { type: "string" }, out: { type: "string" }, "log-chunk": { type: "string", default: "5000" }, "state-block": { type: "string" } } });
if (!values.samples || !values.out) throw new Error("--samples and --out are required");

/** Chosen before this replay ran: the scan's own sizes that the shadow run recorded, and 0.25, where the scan found the most. */
const SIZES_USDT = [0.25, 1, 5, 15];
const CAVEATS = [
  "HSKSwap legs are the quotes recorded in the window, scaled to each amount from the next larger recorded size on the same side, as replay.ts scales them. 0.25 USDT is scaled from the 1 USDT quote.",
  "The other venues' state was read after the window, at the block named below (stateCheck.readAtBlock). It is used only for venues with no log, and no WHSK or USDT transfer in or out, from the window's first block to that block; any other venue's routes are left out.",
  `Network cost is the recorded cost of 200,000 gas plus one L1 fee, scaled to ${ARB_GAS_PER_LEG} gas a leg, one transaction a leg.`,
  "Routes through WETH are not replayed: the WETH pool was not recorded.",
  "Fills are simulated, and our own fill does not move later quotes. Each opportunity is taken once, at its first sample.",
];
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");

const shadow = readFileSync(values.samples, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ShadowSample);
const firstBlock = BigInt(shadow[0]!.block);
const rpc = new RpcClient("https://mainnet.hsk.xyz");
const lastBlock = BigInt(shadow.at(-1)!.block);
const head = await untilAnswered(() => rpc.call<{ number: Hex; hash: Hex }>("eth_getBlockByNumber", [values["state-block"] ? `0x${BigInt(values["state-block"]).toString(16)}` : "latest", false]));
const headNumber = BigInt(head.number);
if (headNumber < lastBlock) throw new Error(`--state-block ${headNumber} is before the window's last block ${lastBlock}`);

// Which venues are the same now as when the window began.
const candidates = ["solidly-20", "hyperindex-30", "dodo-dvm"].map(venueById);
const addresses = candidates.map((v) => v.address.toLowerCase());
const padded = addresses.map((a) => pad(a as Hex));
const touched = new Map<string, number>(addresses.map((a) => [a, 0]));
const chunk = BigInt(values["log-chunk"]!);
const filters = [
  { address: addresses },
  ...[ARB_TOKENS.WHSK, ARB_TOKENS.USDT].flatMap((token) => [
    { address: token, topics: [TRANSFER, padded] },
    { address: token, topics: [TRANSFER, null, padded] },
  ]),
];
let logRequests = 0;
for (let from = firstBlock; from <= headNumber; from += chunk) {
  const to = from + chunk - 1n < headNumber ? from + chunk - 1n : headNumber;
  for (const filter of filters) {
    const logs = await rpc.call<Array<{ address: string; topics: Hex[] }>>("eth_getLogs", [{ ...filter, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
    logRequests++;
    for (const log of logs) {
      const hits = new Set([log.address.toLowerCase(), ...log.topics.slice(1, 3).map((t) => `0x${t.slice(26)}`.toLowerCase())]);
      for (const address of addresses) if (hits.has(address)) touched.set(address, touched.get(address)! + 1);
    }
  }
}
const unchanged = new Set(candidates.filter((v) => touched.get(v.address.toLowerCase()) === 0).map((v) => v.id));
const routes = arbRoutes().filter((r) => r.legs.every((leg) => leg.venue === "hskswap-30" || unchanged.has(leg.venue)));

const orientation = await readOrientation(rpc, head.hash);
const reserves = reservesFrom(await multicall(rpc, head.hash, reservesSubs()), orientation);
for (const id of [...reserves.keys()]) if (!unchanged.has(id)) reserves.delete(id);

const dodo = new Map<string, bigint | null>();
let samples: ArbSample[] = [];
for (let pass = 0; pass < 3; pass++) {
  const built = shadow.map((s) => arbSampleFromShadow(s, routes, SIZES_USDT, reserves, dodo, ARB_GAS_PER_LEG));
  samples = built.map((b) => b.sample);
  const pending = [...new Map(built.flatMap((b) => b.pending).map((k) => [quoteKey(k), k])).values()];
  if (!pending.length) break;
  await readQuotes(rpc, head.hash, pending, dodo, quoteKey, 400);
}

const summary = summarizeArb(samples);
const body = {
  lane: "replay",
  wallTime: new Date().toISOString(),
  source: values.samples,
  window: { first: new Date(shadow[0]!.atMs).toISOString(), last: new Date(shadow.at(-1)!.atMs).toISOString(), firstBlock: shadow[0]!.block, lastBlock: shadow.at(-1)!.block },
  caveats: CAVEATS,
  stateCheck: {
    lane: "mainnet read-only, no trades",
    readAtBlock: headNumber.toString(),
    fromBlock: firstBlock.toString(),
    logRequests,
    venues: candidates.map((v) => ({ id: v.id, address: v.address, logsAndTransfers: touched.get(v.address.toLowerCase()), usedInReplay: unchanged.has(v.id) })),
    reservesAtRead: Object.fromEntries([...reserves].map(([id, r]) => [id, r])),
    dodoQuotesRead: dodo.size,
  },
  notReplayed: [...ARB_NOT_SAMPLED, { address: venueById("hyperindex-weth-30").address, what: "The WETH triangle", why: "The WETH/USDT pool was not recorded in the window" }],
  routes: routes.map((r) => r.id),
  localVenues: routes.flatMap((r) => r.legs.map((l) => venueById(l.venue))).filter(isLocal).map((v) => v.id).filter((id, i, all) => all.indexOf(id) === i),
  sizesUsdt: SIZES_USDT,
  ...summary,
  replay: { note: "Each opportunity taken once, at its first sample, at the size that paid most then. Simulated; not money earned", atZero: replayArb(samples, 0) },
};
writeFileSync(values.out, `${JSON.stringify(JSON.parse(toJson(body)), null, 1)}\n`);
console.log(JSON.stringify({ out: values.out, samples: summary.samples, stateCheck: body.stateCheck.venues, samplesWithPositiveGross: summary.samplesWithPositiveGross, samplesWithPositiveNet: summary.samplesWithPositiveNet, best: summary.best, replayNet: body.replay.atZero.netUsdt }, null, 1));
rpc.close();
process.exit(0);
