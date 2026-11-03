import { ARB_VENUES, type ArbRoute, type ArbToken, type ArbVenue, type LegCost } from './arb.js';

/** Simple cycles only: no repeated pool or intermediate token, so quotes do not reuse changed reserves. */
export function searchRoutes(venues: readonly ArbVenue[] = ARB_VENUES): ArbRoute[] {
  const out: ArbRoute[] = [];
  function visit(token: ArbToken, legs: ArbRoute['legs'], seen: Set<ArbToken>): void {
    if (legs.length >= 3) return;
    for (const venue of venues) {
      if (!venue.pair.includes(token) || legs.some(l => l.venue === venue.id)) continue;
      const next = venue.pair.find(t => t !== token)!;
      const path = [...legs, { venue: venue.id, tokenIn: token, tokenOut: next }];
      if (next === 'USDT') {
        if (path.length >= 2) out.push({ id: path.map(l => l.venue).join('>'), legs: path });
      } else if (!seen.has(next)) visit(next, path, new Set([...seen, next]));
    }
  }
  visit('USDT', [], new Set(['USDT']));
  return out;
}

/** Integer, conservative fee calculation for a hypothetical SINGLE transaction. Gas is a scenario, not a measurement. */
export function atomicCostUsdt(gas: bigint, cost: LegCost): bigint {
  if (gas < 21_000n || cost.gasPriceWei <= 0n || cost.spotPriceX18 <= 0n || cost.l1FeeWei < 0n) throw new Error('invalid cost assumptions');
  return ((gas * cost.gasPriceWei + cost.l1FeeWei) * cost.spotPriceX18 + 10n ** 18n - 1n) / 10n ** 18n;
}

/** Largest whole gas budget that leaves strictly positive net, after one L1 fee. */
export function breakEvenGas(gross: bigint, cost: LegCost): bigint {
  if (cost.gasPriceWei <= 0n || cost.spotPriceX18 <= 0n || cost.l1FeeWei < 0n) throw new Error('invalid cost assumptions');
  if (gross <= 0n) return 0n;
  const weiBudget = ((gross - 1n) * 10n ** 18n) / cost.spotPriceX18 - cost.l1FeeWei;
  return weiBudget > 0n ? weiBudget / cost.gasPriceWei : 0n;
}

/** Fine grid below $1, then increasing sizes; no interpolation of executable quotes. */
export const SEARCH_SIZES = [...Array.from({ length: 40 }, (_, i) => BigInt(i + 1) * 25_000n), 1_500_000n, 2_000_000n, 3_000_000n, 5_000_000n, 10_000_000n, 15_000_000n];
