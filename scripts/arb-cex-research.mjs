// Public market data only. No account API, wallet loading, signing, or order placement.
// Build first: npm run build:agent
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { RpcClient, sleep } from '../.test-build/src/rpc.js';
import { MAINNET_MARKET } from '../.test-build/src/config.js';
import { spotPriceX18 } from '../.test-build/src/reader.js';
import { ARB_VENUES, isLocal, localAmountOut, quoteKey, legCostUsdt } from '../.test-build/src/arb.js';
import { multicall, readOrientation, readQuotes, reservesFrom, reservesSubs, sub } from '../.test-build/src/arb-read.js';
import { evaluateHedge } from '../.test-build/src/arb-research.js';
const { values } = parseArgs({ options: { out: { type: 'string', default: 'evidence/arb/cex-research' }, samples: { type: 'string', default: '3' } } });
const count = Number(values.samples), stem = values.out;
if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('invalid samples');
if (existsSync(`${stem}.json`) || existsSync(`${stem}.samples.jsonl`)) throw new Error('output exists');
mkdirSync(dirname(stem), { recursive: true });
const json = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2);
async function get(path) {
  const startMs = Date.now();
  const response = await fetch(`https://api.gateio.ws/api/v4/${path}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`public exchange HTTP ${response.status}`);
  const body = await response.json();
  return { startMs, receivedMs: Date.now(), body };
}
const book = () => get('spot/order_book?currency_pair=HSK_USDT&limit=100&with_id=true');
const levels = rows => rows.map(([price, amount]) => ({ price: Number(price), amount: Number(amount) }));
const rpc = new RpcClient('https://mainnet.hsk.xyz', { timeoutMs: 20000, maxRetries: 1 });
const samples = [];
let pair, currency;
try {
  pair = await get('spot/currency_pairs/HSK_USDT');
  currency = await get('spot/currencies/HSK');
  if (pair.body.trade_status !== 'tradable') throw new Error('pair is not tradable');
  if (BigInt(await rpc.call('eth_chainId')) !== 177n) throw new Error('wrong chain');
  const venues = ARB_VENUES.filter(v => v.pair.includes('WHSK') && v.pair.includes('USDT'));
  for (let i = 0; i < count; i++) {
    const before = await book();
    const head = await rpc.call('eth_getBlockByNumber', ['latest', false]);
    const priority = BigInt(await rpc.call('eth_maxPriorityFeePerGas'));
    const orientation = await readOrientation(rpc, head.hash);
    const base = await multicall(rpc, head.hash, [sub(MAINNET_MARKET.pool, 'slot0', []), sub(MAINNET_MARKET.gasOracle, 'getL1Fee', [`0x${'a5'.repeat(400)}`]), ...reservesSubs()]);
    if (base.some(v => v === null)) throw new Error('incomplete state');
    const reserves = reservesFrom(base.slice(2), orientation);
    const requests = venues.flatMap(v => [
      ...[1, 3, 5, 10, 15].map(size => ({ venue: v.id, tokenIn: 'USDT', amountIn: BigInt(size) * 1000000n })),
      ...[10, 35, 50, 100, 170].map(size => ({ venue: v.id, tokenIn: 'WHSK', amountIn: BigInt(size) * 10n ** 18n })),
    ]);
    const quotes = new Map();
    await readQuotes(rpc, head.hash, requests.filter(q => !isLocal(venues.find(v => v.id === q.venue))), quotes, quoteKey, 80);
    const cost = { gasPerLeg: 200000n, gasPriceWei: BigInt(head.baseFeePerGas) + priority, l1FeeWei: base[1], spotPriceX18: spotPriceX18(base[0][0]) };
    const after = await book();
    const spanMs = after.receivedMs - before.startMs;
    // Check server response timestamp, not last order-book mutation (an unchanged book can still be current).
    const freshness = [before, after].every(b => Number.isFinite(b.body.current) && Math.abs(b.receivedMs - b.body.current) < 5000);
    const usable = freshness && spanMs <= 10000 && Math.abs(after.receivedMs - Number(BigInt(head.timestamp)) * 1000) <= 15000;
    const results = [];
    let missingQuotes = 0;
    for (const request of requests) {
      const venue = venues.find(v => v.id === request.venue);
      const output = isLocal(venue) ? localAmountOut(venue, reserves.get(venue.id), request.tokenIn, request.amountIn) : quotes.get(quoteKey(request));
      if (output == null || output <= 0n) { missingQuotes++; continue; }
      const buy = request.tokenIn === 'USDT';
      const hsk = Number(buy ? output : request.amountIn) / 1e18, usdt = Number(buy ? request.amountIn : output) / 1e6;
      for (const feeBps of [0, 10, 20]) for (const bufferBps of [0, 10]) {
        const evaluations = [before, after].map(b => evaluateHedge({ dexSide: buy ? 'buy' : 'sell', hsk, usdt, bids: levels(b.body.bids), asks: levels(b.body.asks), feeBps, bufferBps, gasUsdt: Number(legCostUsdt(cost)) / 1e6, minBase: Number(pair.body.min_base_amount ?? 0), minQuote: Number(pair.body.min_quote_amount ?? 0), amountPrecision: pair.body.amount_precision }));
        const eligible = usable && evaluations.every(e => e.eligible);
        results.push({ venue: venue.id, dexSide: buy ? 'buy' : 'sell', hsk, usdt, feeBps, bufferBps, eligible, evaluations, conservativeNetUsdt: eligible ? Math.min(...evaluations.map(e => e.netUsdt)) : null });
      }
    }
    const eligible = results.filter(r => r.eligible).sort((a, b) => b.conservativeNetUsdt - a.conservativeNetUsdt);
    const baseline = eligible.filter(r => r.feeBps === 20 && r.bufferBps === 10);
    const sample = { at: new Date().toISOString(), block: BigInt(head.number).toString(), blockHash: head.hash, usable, freshness, spanMs, before, after, cost, missingQuotes, quotes: Object.fromEntries(quotes), reserves: Object.fromEntries(reserves), results, bestAt20BpsFee10BpsBuffer: baseline[0] ?? null, bestZeroFeeZeroBuffer: eligible.find(r => r.feeBps === 0 && r.bufferBps === 0) ?? null };
    samples.push(sample);
    appendFileSync(`${stem}.samples.jsonl`, JSON.stringify(sample, (_, v) => typeof v === 'bigint' ? v.toString() : v) + '\n');
    console.log(json({ block: sample.block, usable, freshness, spanMs, best: sample.bestAt20BpsFee10BpsBuffer, bestZeroFee: sample.bestZeroFeeZeroBuffer }));
    if (i + 1 < count) await sleep(5000);
  }
} finally {
  rpc.close();
  const report = { lane: 'public quotes and displayed order-book depth; non-atomic hedge simulation; no trades', completed: samples.length === count, pair, currency, assumptions: ['Both endpoints are observed before and after the pinned DEX quote; worst endpoint net is used. This is not an execution guarantee.', 'Fees of 0/10/20 bps are scenarios, not verified account fees. Fee charged in quote currency assumed.', '200000 gas per DEX leg is a scenario, plus synthetic 400-byte L1 fee; wrapping and rebalancing costs excluded.', 'Requires pre-funded inventories on both venues. Funding, withdrawals, bridge risk, failed hedge, inventory risk and capital cost remain unmeasured.', 'Whole-unit rounding and public minimum orders enforced; residual HSK receives no profit credit.', 'Freshness rejects clock skew over 5s, acquisition span over 10s or block age over 15s.'], samples: samples.map(s => ({ block: s.block, usable: s.usable, missingQuotes: s.missingQuotes, spanMs: s.spanMs, best: s.bestAt20BpsFee10BpsBuffer, bestZeroFee: s.bestZeroFeeZeroBuffer })) };
  writeFileSync(`${stem}.json`, json(report) + '\n');
}
