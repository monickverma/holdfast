import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHedge, splitSell, sweepBook, type HedgeInputs } from '../src/arb-research.js';
import { localAmountOut, venueById, type PairReserves } from '../src/arb.js';

test('depth is consumed level by level; insufficient depth is unknown, not filled at the top', () => {
  assert.equal(sweepBook([{ price: 2, amount: 1 }, { price: 1, amount: 4 }], 3), 4);
  assert.equal(sweepBook([{ price: 2, amount: 1 }], 3), null);
  assert.throws(() => sweepBook([{ price: NaN, amount: 5 }], 2));
});
const base: HedgeInputs = { dexSide: 'buy', hsk: 40.7, usdt: 3, bids: [{ price: .1, amount: 100 }], asks: [{ price: .101, amount: 100 }], feeBps: 20, bufferBps: 10, gasUsdt: .01, minBase: 1, minQuote: 3, amountPrecision: 0 };
test('buy hedge rounds sold HSK down and credits no dust; all costs are subtracted', () => {
  const r = evaluateHedge(base);
  assert.ok(r.eligible);
  assert.equal(r.quantity, 40);
  assert.ok(Math.abs(r.dustHsk - .7) < 1e-10);
  assert.ok(Math.abs(r.netUsdt - .978) < 1e-10);
});
test('sell hedge replaces all inventory with quantity rounded up', () => {
  const r = evaluateHedge({ ...base, dexSide: 'sell', usdt: 5 });
  assert.ok(r.eligible);
  assert.equal(r.quantity, 41);
  assert.ok(r.netUsdt < 5 - 41 * .101);
});
test('minimum orders, missing depth, malformed and crossed books cannot become candidates', () => {
  assert.equal(evaluateHedge({ ...base, hsk: 20 }).eligible, false);
  assert.equal(evaluateHedge({ ...base, bids: [{ price: .1, amount: 2 }] }).eligible, false);
  assert.throws(() => evaluateHedge({ ...base, asks: [{ price: .09, amount: 100 }] }));
  assert.throws(() => evaluateHedge({ ...base, bids: [{ price: .09, amount: 100 }, { price: .1, amount: 10 }] }));
  assert.throws(() => evaluateHedge({ ...base, gasUsdt: NaN }));
});
const a = venueById('solidly-20'), b = venueById('hyperindex-30');
const ra: PairReserves = { token0: 'WHSK', reserve0: 493631474259707300516n, reserve1: 44002372n };
const rb: PairReserves = { token0: 'WHSK', reserve0: 429647702224969347067n, reserve1: 38132505n };
test('split allocation conserves inventory and matches a dense independent grid to micro-USDT precision', () => {
  const amount = 5n * 10n ** 18n;
  const result = splitSell(amount, a, ra, b, rb);
  assert.equal(result.aIn + result.bIn, amount);
  assert.ok(result.aIn > 0n && result.bIn > 0n);
  let bestGrid = 0n;
  for (let i = 0n; i <= 10000n; i++) {
    const input = amount * i / 10000n;
    const out = localAmountOut(a, ra, 'WHSK', input) + localAmountOut(b, rb, 'WHSK', amount - input);
    if (out > bestGrid) bestGrid = out;
  }
  assert.ok(result.outUsdt >= bestGrid - 2n);
  assert.ok(result.outUsdt > localAmountOut(a, ra, 'WHSK', amount));
  assert.ok(result.outUsdt > localAmountOut(b, rb, 'WHSK', amount));
  assert.throws(() => splitSell(amount, a, ra, a, ra));
});
