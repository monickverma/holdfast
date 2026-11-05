import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atomicCostUsdt, breakEvenGas, SEARCH_SIZES, searchRoutes } from '../src/arb-search.js';
import { resolveTrips, solidlyAmountOut, v2AmountOut, walkRoute, type PairReserves } from '../src/arb.js';

test('all 20 simple cycles are continuous, with eight triangles and no repeated pool', () => {
  const routes = searchRoutes();
  assert.equal(routes.length, 20);
  assert.equal(new Set(routes.map(r => r.id)).size, 20);
  assert.equal(routes.filter(r => r.legs.length === 3).length, 8);
  for (const r of routes) {
    assert.equal(r.legs[0]!.tokenIn, 'USDT');
    assert.equal(r.legs.at(-1)!.tokenOut, 'USDT');
    assert.equal(new Set(r.legs.map(l => l.venue)).size, r.legs.length);
    for (let i = 1; i < r.legs.length; i++) assert.equal(r.legs[i]!.tokenIn, r.legs[i - 1]!.tokenOut);
  }
  assert.ok(routes.some(r => r.id === 'hskswap-weth-30>hyperindex-weth-30>dodo-dvm'));
  assert.equal(SEARCH_SIZES.length, 46);
});

test('integer fee formulas reproduce previously recorded swaps to one micro-USDT', () => {
  assert.equal(v2AmountOut(5_965_116_992_802_736_632n, 423_682_585_232_166_610_435n, 38_667_770n, 3000n), 535_265n);
  assert.equal(solidlyAmountOut(9_059_087_387_555_757_694n, 484_590_505_046_926_654_337n, 44_823_321n, 2000n), 820_949n);
});

const cost = { gasPerLeg: 104740n, gasPriceWei: 500001000000n, l1FeeWei: 12290277133355n, spotPriceX18: 87520n };
test('break-even budget leaves positive integer net, next gas unit does not', () => {
  for (const gross of [1n, 100n, 1938n, 1000000n]) {
    const gas = breakEvenGas(gross, cost);
    if (gas >= 21000n) {
      assert.ok(gross - atomicCostUsdt(gas, cost) > 0n);
      assert.ok(gross - atomicCostUsdt(gas + 1n, cost) <= 0n);
    }
  }
  assert.equal(breakEvenGas(-1n, cost), 0n);
  assert.ok(atomicCostUsdt(50000n, cost) > 1938n);
  assert.throws(() => atomicCostUsdt(20000n, cost));
  assert.throws(() => breakEvenGas(1n, { ...cost, gasPriceWei: 0n }));
});

test('a missing or reverted quote never becomes a completed profitable trip', () => {
  const route = searchRoutes().find(r => r.id === 'hskswap-30>solidly-20')!;
  const reserves = new Map<string, PairReserves>([['solidly-20', { token0: 'WHSK', reserve0: 500n * 10n ** 18n, reserve1: 45000000n }]]);
  assert.equal(walkRoute(route, 300000n, reserves, () => null), null);
  const pending = resolveTrips([route], [300000n], reserves, () => undefined);
  assert.equal(pending.trips.length, 0);
  assert.equal(pending.pending.length, 1);
  assert.equal(walkRoute(route, 300000n, new Map(), () => 3n * 10n ** 18n), null);
});
