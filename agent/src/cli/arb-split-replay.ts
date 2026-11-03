import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { splitSell } from '../arb-research.js';
import { venueById, type PairReserves } from '../arb.js';
import { atomicCostUsdt, breakEvenGas } from '../arb-search.js';
const { values } = parseArgs({ options: { input: { type: 'string', default: 'evidence/arb/search-2026-11-03.samples.jsonl' }, out: { type: 'string', default: 'evidence/arb/split-replay.json' } } });
if (existsSync(values.out!)) throw new Error('output exists');
const rows = readFileSync(values.input!, 'utf8').trim().split('\n').map(line => {
  const s = JSON.parse(line) as { block: string; cost: Record<string, string>; reserves: Record<string, { token0: PairReserves['token0']; reserve0: string; reserve1: string }>; quotes: Record<string, string | null> };
  const reserves = (id: string): PairReserves => ({ token0: s.reserves[id]!.token0, reserve0: BigInt(s.reserves[id]!.reserve0), reserve1: BigInt(s.reserves[id]!.reserve1) });
  const cost = { gasPerLeg: BigInt(s.cost.gasPerLeg!), gasPriceWei: BigInt(s.cost.gasPriceWei!), l1FeeWei: BigInt(s.cost.l1FeeWei!), spotPriceX18: BigInt(s.cost.spotPriceX18!) };
  const candidates = Object.entries(s.quotes).flatMap(([key, output]) => {
    const [venue, tokenIn, input] = key.split(':');
    if (tokenIn !== 'USDT' || !['hskswap-30', 'dodo-dvm'].includes(venue!) || !output) return [];
    // One buy quote for the TOTAL input: never sum two routes that reuse an unchanged buy pool.
    const allocation = splitSell(BigInt(output), venueById('solidly-20'), reserves('solidly-20'), venueById('hyperindex-30'), reserves('hyperindex-30'));
    const gross = allocation.outUsdt - BigInt(input!);
    return [{ buyVenue: venue, inputMicroUsdt: input, ...allocation, grossMicroUsdt: gross, breakEvenGas: breakEvenGas(gross, cost), scenarios: [50000n, 100000n, 150000n, 200000n].map(gas => ({ gas, netMicroUsdt: gross - atomicCostUsdt(gas, cost) })) }];
  }).sort((a, b) => a.grossMicroUsdt > b.grossMicroUsdt ? -1 : 1);
  return { block: s.block, testedAllocations: candidates.length, best: candidates[0] };
});
const report = { lane: 'replay; shared buy with split sell; no trades', source: values.input, method: 'One HSKSwap/DODO buy quote, then marginal-price allocation between Solidly and Hyperindex with integer output re-evaluation.', caveats: ['Gas budgets are hypothetical for the whole transaction, NOT fork estimates.', 'Finite recorded buy-size grid, only these two sell pools; not a global optimum certificate.', 'L1 fee copied from 400-byte approximation; actual bundle calldata is unmeasured.', 'Continuous optimum uses floating-point research arithmetic; integer reserve formulas evaluate candidates.'], rows };
const json = JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
writeFileSync(values.out!, json + '\n');
console.log(json);
