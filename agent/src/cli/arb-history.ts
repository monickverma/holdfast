// How long, since the small pairs last changed, a round trip between them and HSKSwap would have paid. Their reserves
// have not moved since then, so a trip's value depended only on HSKSwap's price, which every Swap event records.
// Read only: eth_getLogs and eth_call, one request at a time. It never loads a key. Nothing here is a fill.
//   node .test-build/src/cli/arb-history.js --out evidence/v4/arb-history-2026-11-03.json
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pad, toEventSelector, type Hex } from "viem";
import { ARB_ATOMIC_GAS, ARB_GAS_PER_LEG, ARB_TOKENS, arbRoutes, atomicTripCostUsdt, legCostUsdt, resolveTrips, spotResolver, venueById } from "../arb.js";
import { multicall, readOrientation, reservesFrom, reservesSubs } from "../arb-read.js";
import { MAINNET_MARKET } from "../config.js";
import { spotPriceX18 } from "../reader.js";
import { RpcClient, untilAnswered } from "../rpc.js";
import { toJson } from "../trace.js";

/** The later of the two pairs' last swaps on the explorer: Hyperindex, 16 October 2026. Solidly's was block 28,910,007. */
const LAST_CHANGE = "28913951";
const { values } = parseArgs({ options: { out: { type: "string" }, from: { type: "string", default: LAST_CHANGE }, "log-chunk": { type: "string", default: "5000" }, "gas-price-gwei": { type: "string", default: "500.001" }, "l1-fee-wei": { type: "string", default: "24704148481954" } } });
if (!values.out) throw new Error("--out is required");

const SIZES_USDT = [0.1, 0.25, 0.5, 1, 5, 15];
const PAIRS = ["solidly-20", "hyperindex-30"].map(venueById);
const SWAP = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)");
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const rpc = new RpcClient("https://mainnet.hsk.xyz");
const chunk = BigInt(values["log-chunk"]!);
const gasPriceWei = BigInt(Math.round(Number(values["gas-price-gwei"]) * 1e9));
const l1FeeWei = BigInt(values["l1-fee-wei"]!);

const head = await untilAnswered(() => rpc.call<{ number: Hex; hash: Hex }>("eth_getBlockByNumber", ["latest", false]));
const headNumber = BigInt(head.number);
const getLogs = (filter: object, from: bigint, to: bigint) => rpc.call<Array<{ address: string; blockNumber: Hex; logIndex: Hex; data: Hex; topics: Hex[] }>>("eth_getLogs", [{ ...filter, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);

// The window starts after the later pair's last change, as the explorer lists it. The scan below proves nothing touched
// either pair since: no log from them, and no WHSK or USDT transfer in or out. The first hit ends the window there, and
// the pairs' reserves are read at the block before it.
const fromBlock = BigInt(values.from!) + 1n;
const pairAddresses = PAIRS.map((p) => p.address);
const padded = pairAddresses.map((a) => pad(a));
const touchingFilters = [
  { address: pairAddresses },
  { address: [ARB_TOKENS.WHSK, ARB_TOKENS.USDT], topics: [TRANSFER, padded] },
  { address: [ARB_TOKENS.WHSK, ARB_TOKENS.USDT], topics: [TRANSFER, null, padded] },
];

// Every HSKSwap price since then: the price each swap left, which holds until the next one.
const swaps: Array<{ block: bigint; spot: bigint }> = [];
let logRequests = 0;
let endBlock = headNumber;
let changedAt: { block: string; transactions: string[] } | null = null;
for (let from = fromBlock; from <= endBlock; from += chunk) {
  let to = from + chunk - 1n < endBlock ? from + chunk - 1n : endBlock;
  for (const filter of touchingFilters) {
    const hits = await getLogs(filter, from, to);
    logRequests++;
    if (!hits.length) continue;
    const first = hits.reduce((min, l) => (BigInt(l.blockNumber) < min ? BigInt(l.blockNumber) : min), to + 1n);
    if (first - 1n < endBlock) {
      endBlock = first - 1n;
      changedAt = { block: first.toString(), transactions: [] };
    }
  }
  if (changedAt) {
    const block = BigInt(changedAt.block);
    for (const filter of touchingFilters) {
      for (const log of (await getLogs(filter, block, block + 1n)) as Array<{ transactionHash?: string }>) {
        if (log.transactionHash && !changedAt.transactions.includes(log.transactionHash)) changedAt.transactions.push(log.transactionHash);
      }
    }
    to = endBlock;
  }
  if (to >= from) {
    const logs = await getLogs({ address: MAINNET_MARKET.pool, topics: [SWAP] }, from, to);
    logRequests++;
    for (const log of logs) swaps.push({ block: BigInt(log.blockNumber), spot: spotPriceX18(BigInt(`0x${log.data.slice(2 + 64 * 2, 2 + 64 * 3)}`)) });
  }
  if (changedAt) break;
}

// The pairs as they stood through the whole window: read at its last block, from the node's history.
const endHead = await rpc.call<{ hash: Hex }>("eth_getBlockByNumber", [`0x${endBlock.toString(16)}`, false]);
const orientation = await readOrientation(rpc, endHead.hash);
const reserves = reservesFrom(await multicall(rpc, endHead.hash, reservesSubs()), orientation);
for (const id of [...reserves.keys()]) if (!PAIRS.some((p) => p.id === id)) reserves.delete(id);

const routes = arbRoutes().filter((r) => r.legs.every((leg) => leg.venue === "hskswap-30" || PAIRS.some((p) => p.id === leg.venue)) && r.id !== "hskswap-30>hskswap-30");
const sizes = SIZES_USDT.map((s) => BigInt(Math.round(s * 1e6)));
let blocksCovered = 0n;
let blocksPositiveGross = 0n;
let blocksPositiveNet = 0n;
let blocksPositiveAtomic = 0n;
// Each stretch in which a route paid after gas, by either way of paying for it.
const stretches: Array<{ fromBlock: string; toBlock: string; spot: number; bestNetTwoTx: number; bestNetAtomic: number }> = [];
let best: { block: string; route: string; sizeUsdt: number; grossUsdt: number; netUsdt: number; spot: number } | null = null;
let minSpot: bigint | null = null;
let maxSpot: bigint | null = null;
swaps.forEach((swap, i) => {
  const until = i + 1 < swaps.length ? swaps[i + 1]!.block : endBlock + 1n;
  const blocks = until - swap.block;
  if (blocks <= 0n) return;
  const legUsdt = legCostUsdt({ gasPerLeg: ARB_GAS_PER_LEG, gasPriceWei, l1FeeWei, spotPriceX18: swap.spot });
  const { trips } = resolveTrips(routes, sizes, reserves, spotResolver(swap.spot));
  let gross = false;
  let net = false;
  let bestTwoTx: bigint | null = null;
  let bestAtomic: bigint | null = null;
  for (const trip of trips) {
    const tripNet = trip.grossUsdt - 2n * legUsdt;
    const atomicNet = trip.grossUsdt - atomicTripCostUsdt(trip.route, { gasPriceWei, l1FeeWei, spotPriceX18: swap.spot });
    if (trip.grossUsdt > 0n) gross = true;
    if (tripNet > 0n) net = true;
    if (bestTwoTx === null || tripNet > bestTwoTx) bestTwoTx = tripNet;
    if (bestAtomic === null || atomicNet > bestAtomic) bestAtomic = atomicNet;
    if (!best || Number(tripNet) / 1e6 > best.netUsdt) best = { block: swap.block.toString(), route: trip.route, sizeUsdt: Number(trip.sizeUsdt) / 1e6, grossUsdt: Number(trip.grossUsdt) / 1e6, netUsdt: Number(tripNet) / 1e6, spot: Number(swap.spot) / 1e6 };
  }
  blocksCovered += blocks;
  if (gross) blocksPositiveGross += blocks;
  if (net) blocksPositiveNet += blocks;
  if (bestAtomic !== null && bestAtomic > 0n) blocksPositiveAtomic += blocks;
  if (net || (bestAtomic !== null && bestAtomic > 0n)) {
    stretches.push({ fromBlock: swap.block.toString(), toBlock: (until - 1n).toString(), spot: Number(swap.spot) / 1e6, bestNetTwoTx: Number(bestTwoTx) / 1e6, bestNetAtomic: Number(bestAtomic) / 1e6 });
  }
  minSpot = minSpot === null || swap.spot < minSpot ? swap.spot : minSpot;
  maxSpot = maxSpot === null || swap.spot > maxSpot ? swap.spot : maxSpot;
});

const body = {
  lane: "mainnet read-only, no trades; historical logs, HSKSwap leg priced from spot",
  wallTime: new Date().toISOString(),
  method: "From the block after the pairs last changed until either changed again: proof that neither changed in between, and every HSKSwap Swap event's closing price, held until the next. Each price is run through every route between HSKSwap and those pairs, at each size, with the pairs' reserves read at the window's last block",
  caveats: [
    "HSKSwap's leg is its spot less its 0.3% fee, with no price impact. A real quote is worse by the impact, so this flatters every trip.",
    `Network cost is ${values["gas-price-gwei"]} gwei, the base-fee floor the scan saw, for ${ARB_GAS_PER_LEG} gas a leg, plus an L1 fee of ${values["l1-fee-wei"]} wei a leg, the scan's first reading and above any it saw later. Both were taken as constant over the window. The L1 fee is under 0.1% of the leg's cost, so its exact value does not matter here.`,
    "Blocks are weighted equally; a price holds from one swap to the next. The stretch before the first swap in the window is left out.",
    "Two costs: one transaction a leg at the scan's 104,740 gas, and one atomic transaction at the gas another contract's real round trips used (atomicGas). A route between the two small pairs is charged the Solidly figure; none was measured.",
  ],
  headAtRun: headNumber.toString(),
  windowEndBlock: endBlock.toString(),
  windowEndedBy: changedAt ?? "the head: neither pair changed",
  lastChangeOnExplorer: values.from,
  fromBlock: fromBlock.toString(),
  pairsUntouched: "No log from either pair, and no WHSK or USDT transfer into or out of either, from fromBlock to windowEndBlock",
  atomicGas: ARB_ATOMIC_GAS,
  logRequests,
  swaps: swaps.length,
  spotRange: minSpot === null ? null : { min: Number(minSpot) / 1e6, max: Number(maxSpot) / 1e6 },
  reserves: Object.fromEntries(reserves),
  routes: routes.map((r) => r.id),
  sizesUsdt: SIZES_USDT,
  blocksCovered: blocksCovered.toString(),
  blocksWithPositiveGross: blocksPositiveGross.toString(),
  blocksWithPositiveNet: blocksPositiveNet.toString(),
  blocksWithPositiveNetAtomic: blocksPositiveAtomic.toString(),
  positiveStretches: stretches,
  positiveSpan: stretches.length ? { fromBlock: stretches[0]!.fromBlock, toBlock: stretches.at(-1)!.toBlock } : null,
  best,
};
writeFileSync(values.out, `${JSON.stringify(JSON.parse(toJson(body)), null, 1)}\n`);
console.log(JSON.stringify({ fromBlock: body.fromBlock, windowEndBlock: body.windowEndBlock, windowEndedBy: body.windowEndedBy, swaps: body.swaps, blocksWithPositiveNetAtomic: body.blocksWithPositiveNetAtomic, stretches: stretches.length, spotRange: body.spotRange, blocksCovered: body.blocksCovered, blocksWithPositiveNet: body.blocksWithPositiveNet, best }, null, 1));
rpc.close();
process.exit(0);
