// Reprice recorded quotes; never interpolate quotes or add consecutive observations as earnings.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { atomicCostUsdt, breakEvenGas } from '../arb-search.js';
const { values } = parseArgs({ options: { input: { type: 'string', default: 'evidence/arb/baseline.samples.jsonl' }, out: { type: 'string', default: 'evidence/arb/cost-replay.json' } } });
if (existsSync(values.out!)) throw new Error('output already exists');
interface Packed { block: string; spot: number; gasPriceWei: string; l1FeeWei: string; t: [number, number, number, number][] }
const [headerLine, ...lines] = readFileSync(values.input!, 'utf8').trim().split('\n');
const header = JSON.parse(headerLine!) as { routes: string[]; sizesUsdt: number[] };
const samples = lines.map(line => JSON.parse(line) as Packed);
let best: { route: string; sizeUsdt: number; block: string; grossUsdt: number; breakEvenGas: string } | null = null;
const scenarios = [50_000n, 100_000n, 150_000n, 200_000n].map(gas => ({ gas: gas.toString(), positiveSamples: 0, bestNetUsdt: -Infinity }));
for (const s of samples) {
  const cost = { gasPerLeg: 0n, gasPriceWei: BigInt(s.gasPriceWei), l1FeeWei: BigInt(s.l1FeeWei), spotPriceX18: BigInt(Math.round(s.spot * 1e6)) };
  // The highest gross quote is also best at each fixed total gas scenario.
  const top = s.t.reduce((a, b) => b[2] > a[2] ? b : a);
  const gross = BigInt(Math.round(top[2] * 1e6));
  if (!best || top[2] > best.grossUsdt) best = { route: header.routes[top[0]]!, sizeUsdt: header.sizesUsdt[top[1]]!, block: s.block, grossUsdt: top[2], breakEvenGas: breakEvenGas(gross, cost).toString() };
  for (const scenario of scenarios) {
    const net = Number(gross - atomicCostUsdt(BigInt(scenario.gas), cost)) / 1e6;
    if (net > 0) scenario.positiveSamples++;
    scenario.bestNetUsdt = Math.max(scenario.bestNetUsdt, net);
  }
}
const report = { lane: 'replay / hypothetical atomic costs; no executed trades', source: values.input, samples: samples.length, uniqueBlocks: new Set(samples.map(s => s.block)).size, best, scenarios, caveats: ['Gas budgets are hypotheses, not fork measurements.', 'Reuses the old 200-byte L1 fee approximation; new live search uses 400 bytes.', 'Repeated quotes are not cumulative profit. No fills or earnings are claimed.', 'Only the recorded routes and sizes are repriced.'] };
writeFileSync(values.out!, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
