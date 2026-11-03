// Read-only research. No wallet, env file, signer, approvals or broadcast method.
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import type { Hex } from 'viem';
import { ARB_GAS_PER_LEG, ARB_NOT_SAMPLED, ARB_VENUES, quoteKey, resolveTrips, tripCostUsdt, type QuoteKey, type LegCost, type TripResult, type PairReserves } from '../arb.js';
import { multicall, readOrientation, readQuotes, reservesFrom, reservesSubs, sub } from '../arb-read.js';
import { atomicCostUsdt, breakEvenGas, searchRoutes, SEARCH_SIZES } from '../arb-search.js';
import { MAINNET_MARKET } from '../config.js';
import { spotPriceX18 } from '../reader.js';
import { RpcClient, sleep } from '../rpc.js';

const { values } = parseArgs({ options: { samples: { type: 'string', default: '3' }, 'interval-ms': { type: 'string', default: '8000' }, out: { type: 'string', default: 'evidence/arb/search' } } });
const count = Number(values.samples), interval = Number(values['interval-ms']);
if (!Number.isInteger(count) || count < 1 || count > 10000 || !Number.isFinite(interval) || interval < 0) throw new Error('invalid sample count or interval');
const stem = values.out!;
if (existsSync(`${stem}.json`) || existsSync(`${stem}.samples.jsonl`)) throw new Error('choose a new output stem; evidence is never overwritten');
mkdirSync(dirname(stem), { recursive: true });
const rpc = new RpcClient('https://mainnet.hsk.xyz', { timeoutMs: 20000, maxRetries: 1 });
const routes = searchRoutes();
const json = (v: unknown) => JSON.stringify(v, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
interface SearchTrip extends TripResult { separateNetUsdt: bigint; breakEvenGas: bigint; scenarios: { gas: bigint; netUsdt: bigint }[] }
interface SearchSample { at: string; block: string; blockHash: Hex; cost: LegCost; expectedQuotes: number; successfulTrips: number; missingTrips: number; reserves: Record<string, PairReserves>; quotes: Record<string, bigint | null>; trips: SearchTrip[] }
const samples: SearchSample[] = [];
try {
  if (BigInt(await rpc.call<string>('eth_chainId')) !== 177n) throw new Error('wrong chain');
  for (let n = 0; n < count; n++) {
    const head = await rpc.call<{ number: Hex; hash: Hex; baseFeePerGas: Hex }>('eth_getBlockByNumber', ['latest', false]);
    const priority = BigInt(await rpc.call<string>('eth_maxPriorityFeePerGas'));
    const orientation = await readOrientation(rpc, head.hash);
    const base = await multicall(rpc, head.hash, [sub(MAINNET_MARKET.pool, 'slot0', []), sub(MAINNET_MARKET.gasOracle, 'getL1Fee', [`0x${'a5'.repeat(400)}`]), ...reservesSubs()]);
    if (!base[0] || base[1] === null || base.slice(2).some(v => v === null)) throw new Error('incomplete state');
    const reserves = reservesFrom(base.slice(2), orientation);
    const quotes = new Map<string, bigint | null>();
    const resolve = (key: QuoteKey) => quotes.get(quoteKey(key));
    let resolved = resolveTrips(routes, SEARCH_SIZES, reserves, resolve);
    for (let pass = 0; resolved.pending.length && pass < 4; pass++) {
      await readQuotes(rpc, head.hash, resolved.pending, quotes, quoteKey, 80);
      resolved = resolveTrips(routes, SEARCH_SIZES, reserves, resolve);
    }
    if (resolved.pending.length) throw new Error('unresolved quotes');
    const cost = { gasPerLeg: ARB_GAS_PER_LEG, gasPriceWei: BigInt(head.baseFeePerGas) + priority, l1FeeWei: base[1] as bigint, spotPriceX18: spotPriceX18((base[0] as bigint[])[0]!) };
    const trips = resolved.trips.map(t => {
      const route = routes.find(r => r.id === t.route)!;
      return { ...t, separateNetUsdt: t.grossUsdt - tripCostUsdt(route, cost), breakEvenGas: breakEvenGas(t.grossUsdt, cost), scenarios: [50_000n, 100_000n, 150_000n, 200_000n].map(gas => ({ gas, netUsdt: t.grossUsdt - atomicCostUsdt(gas, cost) })) };
    }).sort((a, b) => a.grossUsdt > b.grossUsdt ? -1 : a.grossUsdt < b.grossUsdt ? 1 : 0);
    const sample = { at: new Date().toISOString(), block: BigInt(head.number).toString(), blockHash: head.hash, cost, expectedQuotes: routes.length * SEARCH_SIZES.length, successfulTrips: trips.length, missingTrips: routes.length * SEARCH_SIZES.length - trips.length, reserves: Object.fromEntries(reserves), quotes: Object.fromEntries(quotes), trips };
    samples.push(sample);
    appendFileSync(`${stem}.samples.jsonl`, JSON.stringify(sample, (_, v) => typeof v === 'bigint' ? v.toString() : v) + '\n');
    console.log(json({ sample: n + 1, block: sample.block, successfulTrips: trips.length, best: trips[0] }));
    if (n + 1 < count) await sleep(interval);
  }
} finally {
  rpc.close();
  const report = { lane: 'mainnet read-only quotes; hypothetical atomic gas sensitivity, no trades', completed: samples.length === count, requestedSamples: count, samples: samples.length, routes, sizesMicroUsdt: SEARCH_SIZES, venues: ARB_VENUES, excluded: ARB_NOT_SAMPLED, assumptions: ['Amounts are integer micro-USDT, gas in units, network costs in wei.', '50k/100k/150k/200k atomic gas are scenarios, NOT measured execution.', 'Single 400-byte synthetic L1 payload; actual calldata and execution gas must be measured on a fork.', 'Separate transactions use 104740 gas per leg from prior HSKSwap benchmark, unmeasured on other venues.', 'Fixed venue fees inherited from previous event validation; verify execution before trading.', 'Quotes are not fills; sequential samples are not cumulative profit.', 'Finite size grid and known venues only; this is not an exhaustive market proof.'], bestBySample: samples.map(s => ({ block: s.block, missingTrips: s.missingTrips, best: s.trips[0] })) };
  writeFileSync(`${stem}.json`, json(report) + '\n');
}
