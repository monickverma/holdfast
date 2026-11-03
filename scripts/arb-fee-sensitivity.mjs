import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { analyzeShadow, SHADOW_DEFAULTS } from '../.test-build/src/shadow.js';
const { values } = parseArgs({ options: { out: { type: 'string', default: 'evidence/arb/fee-sensitivity.json' }, input: { type: 'string', default: 'evidence/shadow/shadow-samples.jsonl' } } });
const out = values.out;
if (existsSync(out)) throw new Error('output exists');
const input = values.input;
const all = readFileSync(input, 'utf8').trim().split('\n').map(JSON.parse);
const cut = Math.floor(all.length * .6);
const partitions = [{ name: 'first60pct', data: all.slice(0, cut) }, { name: 'last40pct', data: all.slice(cut) }];
const rows = partitions.flatMap(({ name, data }) => [0, 5, 10, 20].map(hedgeFeeBps => {
  const report = analyzeShadow(data, { ...SHADOW_DEFAULTS, hedgeFeeBps });
  return { partition: name, feeBps: hedgeFeeBps, samples: report.samples, usable: report.usable, hours: report.hours, rows: report.rows.map(r => ({ side: r.side, sizeUsdt: r.sizeUsdt, positiveSamples: r.samplesProfitable, opportunities: r.opportunities, after2s: r.afterHedgeLag })) };
}));
const result = { lane: 'historical top-of-book sensitivity; simulated, not executable returns', input, cut, caveats: ['Previously inspected data, not an untouched holdout and not evidence of out-of-sample performance.', 'No historical order-book depth, lot rounding, minimum orders, funding or rebalancing costs; optimistic hedge assumptions.', 'Each row is an alternative strategy. Never sum rows or repeatedly count one persistent spread as earnings.', 'Fee scenarios are fixed tests, not attainable fee tiers. 2s hedge uses later recorded quotes and excludes unknown gaps.', 'Only roughly 43 minutes of data; no annualized returns or statistical significance claim.'], rows };
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(rows.map(r => ({ partition: r.partition, feeBps: r.feeBps, bestAlternative: [...r.rows].sort((a, b) => b.after2s.netUsdt - a.after2s.netUsdt)[0] })), null, 2));
