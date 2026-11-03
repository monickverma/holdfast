# Arbitrage research — 3 November 2026

Follow-up: [paper-based strategy research](STRATEGY-RESEARCH.md) adds split routing, exchange-depth hedging, historical fee sensitivity and an HSK carry-availability screen. The single-route results below are preserved; a later split-routing replay improves gross spread but still lacks a verified profitable execution.

The expanded search improves coverage and sizing, but has **not found an executable profitable trade**. These tools only make public chain reads. They do not load wallet keys or send transactions, and are not wired to the trading agent.

## What changed

Recovered the prior Claude research's venue definitions, quote adapters and raw 80-minute scan into this checkout. The original worktree is untouched. `agent/src/arb.ts` and `arb-read.ts` originate from that work; the search, cost replay and tests were added here. The venue evidence is `evidence/arb/venues.json`.

The earlier search had 12 cross-venue two-leg routes, two triangles and one same-pool control. The new search enumerates all 20 simple cycles among the six known venues: 12 two-leg routes and eight triangles. It excludes repeated pools so a second leg cannot reuse pre-trade reserves from the same pool. All reads within a sample are pinned to one block hash. There are 46 actual quoted sizes from 0.025 to 15 USDT, including a 0.025-USDT grid through 1 USDT. A failed quote is reported as missing, never converted into zero-cost profit.

## Measurements

Lane: **mainnet read-only quotes, no trades**. Three fresh blocks, 29669625 through 29669635, each returned 920 route/size results with no missing trips. This is a short diagnostic, not evidence of sustained returns.

Best route: HSKSwap 0.3% → Solidly 0.2%, at 0.30 USDT input. Gross after pool fees and quoted impact: **0.001938 USDT**. Estimated separate-transaction net: **−0.007230 USDT**.

| Hypothetical total atomic gas | Net USDT on best fresh quote |
|---:|---:|
| 50,000 | −0.000251 |
| 100,000 | −0.002439 |
| 150,000 | −0.004627 |
| 200,000 | −0.006815 |

The highest gas budget leaving at least one micro-USDT after the assumed L1 fee is **44,259 gas**. That is a budget for the entire transaction, not per swap. None of these atomic gas budgets has been measured on an executor. Actual calldata, approvals, token behaviour, slippage, failures and execution overhead still need fork validation if a candidate appears. The current vault cannot execute these cross-venue routes.

Repricing all **565 prior samples** with a hypothetical single 50,000-gas transaction also gives **zero positive samples**; best net is −0.000286 USDT. These repeated observations are not counted as cumulative profit. The prior replay uses its recorded synthetic 200-byte L1 fee; fresh quotes use a synthetic 400-byte payload. Both are approximations. Per-leg gas is the inherited HSKSwap benchmark, not a measurement of other venues.

Evidence: `evidence/arb/search-2026-11-03.json`, its `.samples.jsonl` (including reserves and raw quote outputs), and `evidence/arb/cost-replay.json`.

## Run again

```powershell
npm run build:agent
node .test-build/src/cli/arb-search.js --samples 3 --out evidence/arb/new-check
node .test-build/src/cli/arb-search.js --samples 450 --interval-ms 8000 --out evidence/arb/extended-check
node .test-build/src/cli/arb-cost-replay.js --input evidence/arb/baseline.samples.jsonl --out evidence/arb/new-replay
```

Output stems must be unused: evidence is never overwritten. Run only one public RPC job at a time. The extended command sleeps eight seconds between reads, so total runtime exceeds one hour. It is bounded, records every completed sample immediately, and writes a partial report on an ordinary RPC error. A forced process kill can leave only the sample file.

## What can improve profitability

Sizing did improve gross from 0.001903 to 0.001938 USDT, but cannot overcome the observed fee burden. Larger trades into these shallow pools lose more to impact. Faster scanning, flash loans or a model do not by themselves increase this quoted spread; borrowing would add a cost. Even a 0.01-USDT profit target exceeds the entire best gross spread before gas.

Use the expanded search to detect a materially larger dislocation or newly funded venue. Before enabling execution, require a positive net with a measured atomic gas budget, actual L1 calldata fees, a slippage/failure buffer and minimum profit; then validate the exact route on a fork. If this market remains unchanged, another market with deeper independent venues is needed. The evidence only covers these venues, sizes and observation windows, and does not establish that all HSK arbitrage is impossible.

No executor was deployed and no capital was spent. Contract risk limits are unchanged. Validation: TypeScript build and all 195 agent tests passed, including route coverage, historical fee arithmetic, break-even rounding and missing-quote behaviour.
