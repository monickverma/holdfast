/** Nearest-rank quantile. Never interpolates, so every reported value is a real observation. */
export function nearestRank(values: readonly number[], q: number): number {
  if (values.length === 0) throw new Error("no samples");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

/** The smallest n for which a finite two-sided 95% interval for quantile q exists. */
export function minSampleForInterval(q: number): number {
  for (let n = 1; ; n++) {
    if (q ** n <= 0.025 && (1 - q) ** n <= 0.025) return n;
  }
}

export interface QuantileReport {
  n: number;
  value: number | null;
  /** Exact distribution-free 95% interval from order statistics. Null endpoint means unbounded. */
  low: number | null;
  high: number | null;
  /** Why the value is withheld, if it is. */
  withheld?: string;
}

/** Reports a quantile with its interval, and withholds it when n cannot support the claim. */
export function quantileReport(values: readonly number[], q: number): QuantileReport {
  const n = values.length;
  const needed = minSampleForOneSidedBound(q);
  if (n < needed) {
    return { n, value: null, low: null, high: null, withheld: `n=${n} is below ${needed} for P${q * 100}` };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const { lower, upper } = orderStatisticRanks(n, q);
  return {
    n,
    value: nearestRank(values, q),
    low: lower === null ? null : sorted[lower - 1]!,
    high: upper === null ? null : sorted[upper - 1]!,
  };
}

/** The smallest n where the sample maximum gives a 95% one-sided upper bound on quantile q. */
export function minSampleForOneSidedBound(q: number): number {
  return Math.ceil(Math.log(0.05) / Math.log(q));
}

/** Wilson score interval for a proportion, at 95%. */
export function wilson(successes: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.959963985;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (centre - margin) / denominator), high: Math.min(1, (centre + margin) / denominator) };
}

function orderStatisticRanks(n: number, q: number): { lower: number | null; upper: number | null } {
  let cumulative = 0;
  let lower: number | null = null;
  let upper: number | null = null;
  for (let k = 0; k <= n; k++) {
    // P(X <= k) for X ~ Binomial(n, q): the rank-k statistic lies below the quantile with this probability.
    cumulative += Math.exp(logChoose(n, k) + k * Math.log(q) + (n - k) * Math.log1p(-q));
    if (cumulative <= 0.025 && k >= 1) lower = k;
    if (cumulative >= 0.975 && upper === null) upper = k + 1 <= n ? k + 1 : null;
  }
  return { lower, upper };
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

const logFactorials: number[] = [0];
function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i++) logFactorials[i] = logFactorials[i - 1]! + Math.log(i);
  return logFactorials[n]!;
}
