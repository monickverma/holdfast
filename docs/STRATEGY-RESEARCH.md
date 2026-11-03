# Research-backed arbitrage and profitability assessment

Research date: 3 November 2026. Scope: Holdfast, HSKSwap and possible exchange hedges. No transactions, exchange orders, account connections or funding changes were made.

**The research produced a better routing strategy, but not a demonstrated profitable execution.** Splitting the exit across two pools increases the best recorded gross spread by 31.2%. Exchange hedging and funding carry were also investigated rather than assuming that on-chain cycles are the only possible strategy.

## Primary literature and its application

| Paper | Relevant result or method | Application here |
|---|---|---|
| Angeris, Chitra, Evans & Boyd, [Optimal Routing for Constant Function Market Makers](https://arxiv.org/pdf/2204.05238), 2022 | Routes can be optimized jointly; fixed activation costs change which pools should be used. Section 5 explicitly includes fixed transaction costs. | Implemented a specialized shared-buy, split-sell experiment. A general solver and all-market optimality certificate are not implemented. |
| Diamandis, Resnick, Chitra & Angeris, [An Efficient Algorithm for Optimal Routing Through Constant Function Market Makers](https://arxiv.org/pdf/2302.04938), 2023 | Decomposition and marginal-price conditions make CFMM routing tractable, including aggregate markets. | Used equal marginal outputs for a two-pool continuous allocation, then re-evaluated candidates with integer reserve formulas. This is our adaptation, not a reproduction of the complete solver. |
| Escudero, Lara & Sama, [Optimal Routing across Constant Function Market Makers with Gas Fees](https://arxiv.org/html/2603.02844v1), 2026 preprint | Fixed costs create activation thresholds and enlarge regions where no trade is optimal. | Retained gas sensitivity and a break-even budget. Its general theorems have not been used to certify this heterogeneous market. |
| Wu, Sui, Thiery & Pai, [Measuring CEX-DEX Extracted Value and Searcher Profitability](https://arxiv.org/html/2507.13023v1), 2025 | Liquidity and hedge timing matter; estimated extracted value is not the same as an observable trader's realized P&L. Ethereum-specific observations do not establish HSK returns. | Built a depth-aware public CEX/DEX probe and tested delayed hedges in recorded data. Did not transplant reported Ethereum returns or optimize hedge delay on the same data. |
| Hautsch, Scheuch & Voigt, [Building Trust Takes Time](https://arxiv.org/abs/1812.00595), revised 2023, published 2024 | Settlement delays expose cross-exchange arbitrage to price risk; centralized settlement substitutes counterparty exposure. Abstract and publication summary reviewed. | Treat exchange hedging as non-atomic and dependent on pre-funded inventory. Transfers are not assumed instantaneous or free. |
| Milionis, Moallemi, Roughgarden & Zhang, [Automated Market Making and Loss-Versus-Rebalancing](https://arxiv.org/html/2208.06046v6), revised 2026 | LP fees coexist with adverse selection losses and market exposure. | Liquidity provision is a separate strategy requiring fee-minus-loss accounting. Do not call pool fee revenue net profit. |
| Schmeling, Schrimpf & Todorov, [Crypto Carry](https://www.bis.org/publications/working-paper-1087-crypto-carry), 2023 | Spot/futures basis can support carry trades, but margin and liquidation frictions limit deployment. BIS research summary reviewed. | Screened HSK derivative availability before constructing any carry backtest. Findings on BTC/ETH are not evidence of an HSK opportunity. |
| He, Manela, Ross & von Wachter, [Fundamentals of Perpetual Futures](https://arxiv.org/abs/2212.06888), revised 2026 | Perpetuals have no fixed-maturity convergence guarantee; funding and trading costs enter valuation. Abstract reviewed. | A displayed funding number on an inactive contract is not investable yield. No rate was annualized into promised returns. |
| Bailey, Borwein, López de Prado & Zhu, [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf), 2015 | Selecting apparently successful backtests can create false evidence of skill; ordinary holdouts are not a general cure. | Used explicit fee scenarios and reported chronological deterioration. No statistical significance or untouched out-of-sample claim; PBO/CSCV itself was not implemented. |

These sources identify mechanisms and constraints. They do not supply a transferable guarantee that a specific token, venue or account will earn money.

## Experiment 1: one buy, two sell pools

Instead of choosing one round trip, buy WHSK once through HSKSwap and divide it between Solidly and Hyperindex. Each sale uses a different pool. Importantly, the buy quote is for the **combined input**: summing two independently quoted cycles that reuse the same initial reserves would overstate returns.

For two constant-product sell curves, our continuous research allocation matches their marginal outputs. We compare that allocation and nearby integer candidates with the all-in-one-pool alternatives. Actual reserve formulas then calculate the output. This is a limited numerical heuristic with exact output re-evaluation, not a global optimality proof.

Replayed at the three previously recorded blocks 29669625, 29669630 and 29669635, with 92 recorded buy quote candidates per block:

| Quantity | Result |
|---|---:|
| Best combined USDT input | 0.450000 |
| Total USDT output | 0.452542 |
| Gross spread after pool fees and quoted impact | 0.002542 |
| Prior best single route gross | 0.001938 |
| Gross improvement | 31.17% |
| Maximum total gas for positive net under recorded fee approximation | 58,062 |
| Net at hypothetical 50,000 total gas | +0.000353 USDT |
| Net at hypothetical 100,000 total gas | −0.001835 USDT |
| Net at hypothetical 150,000 total gas | −0.004023 USDT |

The positive 50,000-gas scenario is **not a measured executable profit**. This is one buy plus two sells, with transfers and contract overhead still to measure. It has only 0.000353 USDT of modeled margin before slippage or failures. No executor or full transaction gas measurement exists. The synthetic 400-byte L1 fee could also differ from real calldata.

Evidence: [split-replay.json](../evidence/arb/split-replay.json). Implementation: `agent/src/arb-research.ts`, `agent/src/cli/arb-split-replay.ts`.

## Experiment 2: hedge against exchange depth

Built a public-data probe for all four direct WHSK/USDT DEX venues against Gate's HSK/USDT order book. It checks both directions, five sizes per direction, and fee/buffer scenarios. It uses displayed depth rather than a midpoint, enforces public minimum orders and quantity precision, and values residual dust at zero. Books are fetched before and after a block-pinned DEX read; the lower endpoint net is retained. Freshness checks and maximum acquisition spans reject mismatched observations. This cannot eliminate movement or failed execution between observations.

Gate's public metadata reported a 3-USDT minimum notional and whole-HSK quantity precision. Actual account fees are unknown, so 0/10/20-basis-point fees are explicitly hypothetical. The public `fee` field is deprecated and is not treated as proof of an account's fee tier. API field meanings are documented in [Gate Spot API](https://www.gate.com/docs/developers/apiv4/en/spot/).

Three fresh, usable blocks (29669911, 29669914, 29669918) showed no eligible positive hedge among the tested sizes. Best at a 20-bp fee and 10-bp buffer: **−0.03309745 USDT**. Even zero fee and zero buffer gave a best result of **−0.023890 USDT**. These are short observations, not a conclusion about all future spreads.

Costs include a 200,000-gas DEX-leg scenario and synthetic L1 fee. Wrapping, rebalancing, transfers, capital charges and hedge-failure losses are not included, so they would need to be added before execution. Pre-funded HSK and USDT inventory is assumed. Fee settlement in quote currency is assumed. Contract, account and inventory limits remain unverified.

Evidence: [cex-research-2026-11-03.json](../evidence/arb/cex-research-2026-11-03.json) and its raw `.samples.jsonl`. Implementation: `scripts/arb-cex-research.mjs`.

## Experiment 3: can lower fees rescue the historical signal?

Used **992 raw observations over 43.41 minutes on 1 November**, split chronologically at observation 595. This raw file has more observations than the older report's 981; the new analysis reads the raw file. Both segments were already available for inspection, so the later segment is not an untouched test set.

For the same 150-USDT buy strategy, with a hypothetical 5-bp exchange fee and a two-second hedge delay:

| Segment | Simulated hedges with observed later quotes | Simulated net |
|---|---:|---:|
| First 60% | 7 | +0.148032 USDT |
| Last 40% | 5 | −0.174533 USDT |

The positive result reverses in the later segment. At 20 bps, there were no positive entry quotes in either segment. Fee levels change which observations trigger entry, so P&L need not vary monotonically with fees. Other scenarios and sizes, including losses, are preserved in the artifact; the table does not choose different strategies for the two segments.

This replay is optimistic: historical data lacks depth, lot rounding, minimum-order enforcement and rebalancing costs. It is a diagnostic for a fragile signal, not a trading recommendation. It does not justify upgrading an account or paying for a fee tier. Unknown delayed hedges are not treated as zero-cost successful fills.

Evidence: [fee-sensitivity.json](../evidence/arb/fee-sensitivity.json). Implementation: `scripts/arb-fee-sensitivity.mjs`.

## Experiment 4: funding carry availability

Gate's public HSK_USDT perpetual metadata returned **`status: delisted`**, `in_delisting: true`, zero positions and no funding observations from the requested history endpoint. Its stale mark price and indicative funding fields must not be compared to current spot prices as an executable basis. This rejects this specific instrument, not carry strategies on every venue.

Evidence: [hsk-carry-screen.json](../evidence/arb/hsk-carry-screen.json). The [Gate Futures API](https://www.gate.com/docs/developers/apiv4/en/futures/) documents contract and funding metadata. No leverage or derivative position was opened.

## Priorities after these tests

1. **Keep split routing in research.** The improvement is measured at the quote level. Only consider an executor after a larger spread survives actual transaction gas, calldata fees and an explicit profit buffer. A tiny positive result under an arbitrary gas budget is not enough.
2. **Collect event-driven exchange-depth evidence.** A multi-day series covering changing prices is more informative than more snapshots of an unchanged shallow pool. Preserve both venue timestamps, depth, candidate quantity, fee assumptions, two-second and longer hedge outcomes, and all rejected observations. Freeze rules before evaluating the next window. This collection has not been started as an unattended job.
3. **Broaden venue or asset coverage if profitability outranks HSK-only scope.** A liquid spot/derivative carry screen or low-fee spot hedge is a research candidate, not an identified profitable position. Verify active instruments, minimum capital, actual fees, borrow/funding history and stress losses before ranking them. No new market or capital commitment has been assumed here.
4. **Do not substitute passive LP or directional ML for arbitrage.** Those require separate inventories, benchmarks and loss accounting. The previously recorded HSKSwap volume is too limited to infer attractive LP income, and this short price series cannot support a credible predictive-model validation.

## Reproduce and validate

```powershell
npm run build:agent
node .test-build/src/cli/arb-split-replay.js --out evidence/arb/split-new.json
node scripts/arb-cex-research.mjs --samples 3 --out evidence/arb/cex-new
node scripts/arb-fee-sensitivity.mjs --out evidence/arb/fee-new.json
node --test --test-isolation=none .test-build/test/*.test.js
```

The scripts deliberately refuse to overwrite existing artifacts; choose unused output paths. Run public-RPC work serially. These are research tools using floating-point quantities for book analysis; their outputs must never be used directly to construct orders.

TypeScript build passed. **200 agent tests passed**, including depth exhaustion, minimum orders, quantity rounding, malformed books, inventory conservation and a dense-grid cross-check of the split allocation. All additions remain research-only; no trading gate or vault limit was relaxed.
