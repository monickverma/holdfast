# Holdfast benchmarks

Every number here names its lane (mainnet read only, fork, or testnet), its sample size and its source file in `evidence/`. Nothing has been deployed or traded on mainnet. The testnet venue is our own test market, not HSKSwap, so its prices and P&L mean nothing.

## Results

| Benchmark | Lane | Before | After | Change |
|---|---|---|---:|---:|
| Event-to-Receipt P50 | Testnet, 45 + 45 limit orders, polling then flashblock stream | 1,628.5 ms | 225.2 ms | −86.2% |
| Event-to-Receipt P90 | Same | 2,230.2 ms | 413.5 ms | −81.5% |
| Tick-to-Receipt P50 | Testnet, 72 + 72 alternating swaps | 795.0 ms | 509.3 ms | −35.9% |
| Tick-to-Receipt P90 | Same | 969.9 ms | 652.3 ms | −32.7% |
| Tick-to-Receipt P95 | Same | 1,025.9 ms | 728.7 ms | −29.0% |
| Market read P50 | Mainnet, real HSKSwap pool, read only, 400 + 400 | 364.2 ms | 203.9 ms | −44.0% |
| Market read P90 | Same | 434.9 ms | 215.6 ms | −50.4% |
| Market read P95 | Same | 453.7 ms | 218.0 ms | −52.0% |
| Market read P99 | Same | 513.6 ms | 244.9 ms | −52.3% |
| Round-Trip Budget, read then send | Protocol, confirmed by counters | 4 HTTP requests | 2 | −50% |
| Gas per swap, sell | Fork, real HSKSwap router, 20-round median | 157,470 | 130,807 | −16.9% |
| Guard Overhead, gas above a plain router swap | Same | 51,760 | 25,097 | −51.5% |

The money saved per swap is small. At 500 gwei and an assumed $0.0874/HSK, a sell falls from about $0.00688 to $0.00572 of L2 gas, before any L1 data fee.

Also measured on the faster path, all testnet:

- Tick-to-Receipt over all 368 fast swaps: P50 467.4 ms [456.7, 483.5], P95 661.0 ms [632.5, 728.7], P99 858.4 ms [754.3, 1,124.8].
- Decision to broadcast, in a separate run: 483.8 ms [474.2, 496.7] falls to 315.6 ms [263.8, 324.7] at P50, and 610.8 ms to 379.4 ms at P95, n=72 each, −35% at P50. This compares the old and new read path with the same send.

Event-to-Receipt intervals: polling P50 [1,625.6, 2,223.5], P90 [2,226.0, 2,425.0]; stream P50 [223.9, 227.0], P90 [228.8, 429.8]. P95 is withheld at n=45. Every order filled: 90 of 90 included, 0 of 90 receipts changed after sealing.

Brackets are 95% order-statistic intervals. The P95 intervals for Tick-to-Receipt touch slightly ([936.0, 1,174.1] and [637.6, 957.5]), so treat that gain as likely rather than proven. The P50 intervals are well apart.

## Safety held

A faster or cheaper vault counts only if the limits still hold. These ran against the new vault.

| Check | Lane | Result |
|---|---|---|
| Attack set | Fork | 100/100 contained, 100/100 benign completed, 0 cap violations, at most 59.99 HSK drained of a 60 HSK cap |
| Contract tests | Local | Forge 34/34, not counting the separate fork test |
| Agent unit tests | Local | 99/99 |
| End-to-end, including crash recovery | Fork | 8/8 |
| End-to-end | Local test market | 7/7 |
| Reverted benchmark swaps | Testnet | 0 of 440 |
| Refusals on chain | Testnet | `BelowFloor`, `OverTradeCap`, agent withdrawal, and `OverLifetimeCap` |
| Lifetime cap used | Testnet | 952 benchmark swaps spent 47.6 of 50 tWHSK. An order for 10 tWHSK was then refused with `OverLifetimeCap`. |

Zero failures do not prove there can never be one. For 0 of 440, the 95% Wilson upper bound is 0.87%. For 0 of 100, it is 3.70%.

## What we changed

Stage timings from the same testnet run. Medians of separate stages do not add up to the median of the whole path.

| Stage | Before, P50 ms | After, P50 ms | Change made |
|---|---:|---:|---|
| Head | 127.2 | merged into read | |
| State | 139.6 | 183.3 (read) | One atomic `eth_call` through Multicall3 returns head checks and pool state, batched with the nonce |
| Decide | 1.5 | 1.0 | |
| Reserve (ledger) | 6.8 | 3.1 | |
| Nonce | 108.3 | 0.0 | Comes back in the read batch |
| Sign | 4.1 | 3.8 | |
| Send | 112.6 | 263.6 | `eth_sendRawTransactionSync` returns the receipt, so this stage now includes confirmation |

Local work is under 10 ms of the path, about 2%. The network is the rest, which is why the work went into removing round trips and not into faster code. This is Amdahl's law applied to a measured breakdown.

The state read refuses to mix blocks. Multicall reports the block it ran on and the parent hash, and if they do not match the block returned in the same batch, the agent falls back to the old pinned read. On mainnet that happened 0 times in 400 reads (Wilson upper 0.95%). On testnet it happened 0 times in 368. Every fifth atomic read on mainnet was compared with a pinned read of the same block: 0 mismatches in 80.

If the sync send fails, the agent resends the identical signed bytes the classic way. The same transaction cannot land twice.

Gas came from four contract changes:

- limits packed into one storage slot
- a Permit2-style bitmap for used intent IDs
- a transient-storage reentrancy lock
- resetting the router allowance only when a swap leaves some of it unspent

The cost:

- Deployment takes 99,363 more gas, repaid after about 4 swaps.
- The first swap in each 256-intent bitmap word costs about 17,100 more gas. The median above does not show this.
- Per-trade and lifetime limits now stop at 72 bits, about 4,722 tokens with 18 decimals. Larger values are refused, not truncated.

## Reacting to flashblocks

Tick-to-Receipt starts from a schedule. A trader cares about something else: how long after the market moves does the trade land? Event-to-Receipt measures that. Another wallet moves the pool past an armed limit order, and the clock starts when the first flashblock showing the move reaches this process.

Polling can only act once a read shows the move, and the `latest` state it reads moved only about once per block. So the wait is mostly the 2-second block. The stream shows the move within about 200 ms.

Stream alone would not be enough. We sent 360 plain transfers, 72 at each of five points in the flashblock cycle, and found a send window:

| Sent | Send P50 | Send P90 | Receipt after the frame |
|---|---:|---:|---:|
| Right after the frame | 204.9 ms | 238.0 ms | about 205 ms |
| 50 ms after | 150.9 ms | 187.2 ms | about 200 ms |
| 100 ms after | 297.6 ms | 340.4 ms | about 400 ms |
| 150 ms after | 249.2 ms | 447.2 ms | about 400 ms |
| Random moment | 223.2 ms | 309.5 ms | |

Reading state first takes about 130 ms or more, which would miss the window every time. So the agent decides from the frame itself: the pool's new state comes from the frame's logs, quotes are worked out locally, and vault limits come from the last full read. Local stages take about 20 ms. In the benchmark, 39 of 45 stream trades landed in the 200–400 ms bucket and 6 took 400 ms or more, which is why P90 is 413.5 ms while P50 is 225.2 ms.

Safeguards:

- **Local quotes.** On mainnet read-only checks, the local Uniswap V3 math matched the real HSKSwap Quoter exactly in 250 of 250 comparisons across 25 blocks, at sizes up to 10 WHSK and 1 USDT (Wilson lower bound 98.5%). A swap that could reach another initialized tick is refused locally and goes to the Quoter.
- **On-chain limits.** No contract changed. The vault still checks every trade, whichever path produced it.
- **Stop-losses.** Confirmation still counts sealed-block reads, so one unsealed frame cannot fire a stop.
- **Fallback.** Polling keeps running if the stream drops. The stream is off unless `STREAM=true`.

What this leaves open:

- **The polling baseline reads `latest`.** Polling the `pending` tag might shorten it. We did not test that.
- **The clock starts at frame arrival,** not when the mover's transaction executed. Both arms miss the same earlier time.
- **The agent acts on a preconfirmation.** A frame that never sealed could trigger a trade on a move that did not happen. We saw no receipt change, but we did not test a frame disappearing.
- **The mainnet path has not traded.** The test market emits no Swap event, so testnet used its token transfers and constant-product math. Decoding a real V3 Swap log is covered only by unit tests with a built log.
- **Other gaps.** Stream reconnection was not exercised: the run had 0 reconnects. The trigger is a limit order crossed by a large deliberate move in a thin market.

## How the metrics were chosen

We used existing methods in this order, and an earlier step can veto a later one:

1. **Evidence and constraints.** Missing proof stays missing, and lanes are never merged.
2. **Kano gates.** Must-pass safety checks come before any ranking.
3. **Goal-Question-Metric.** A metric stays only if it drives a build decision. This dropped raw test counts, peak throughput and annualised Sharpe over short windows.
4. **SRE SLI definitions and Goodhart guardrails.** Speed is paired with correctness, and cost with successful trades.
5. **Weighted-sum ranking (MCDA).** Equal weights, then a stability check over 20,000 sampled weightings and a TOPSIS cross-check.

No controlled study shows that one prioritisation method beats another, and these scores are our own judgment, so the order is a tool and not a measurement.

| Rank | Metric | Score | Our result |
|---:|---|---:|---|
| 1 | Maximum contained loss | 8.40 | 59.99 of 60 HSK, fork |
| 2 | Audit trace completeness | 8.00 | Traces, ledger and receipts are recorded per trade; not scored as a percentage |
| 3 | Correct task completion | 7.93 | 440/440 testnet swaps; 100/100 benign on fork |
| 4 | Recovery completion | 7.93 | Crash recovery passes on fork; a single scenario, not a rate |
| 5 | Pinned quote agreement | 7.93 | 0 mismatches in 80 mainnet blocks |
| 6 | Net economic result | 7.80 | **Not measured.** Testnet prices mean nothing |
| 7 | Scheduled deadline compliance | 7.73 | **Not measured** as a rate |
| 8 | Benign false-refusal rate | 7.67 | 0/100 on fork |
| 9 | Revert and expiry rate | 7.67 | 0/440 on testnet |
| 10 | Eligible fill ratio | 7.53 | 440/440, own test market only; unstable in the sensitivity check, so supporting evidence only |

Speed and cost lead the table at the top by choice, because they are the engineering this work set out to do. That choice overrides the ranked order for presentation only. A fast result that fails a safety gate would not count.

## Named benchmarks

These are our labels for the definitions below. They are not registered trademarks and have not been cleared as such.

- **Event-to-Receipt.** First flashblock showing a pool move reaching this process, to a receipt in hand for the order it triggered.
- **Tick-to-Receipt.** Scheduled event time to a receipt in hand, on an open-loop schedule so a slow trade cannot hide the delay it causes to the next one.
- **Round-Trip Budget.** HTTP requests between deciding to read and holding a receipt, on the path with no fallback.
- **Guard Overhead.** Gas for a vault swap minus gas for a plain router swap in the same blocks.
- **Atomic Tick Miss Rate.** Share of one-request reads refused because the state and head came from different blocks.
- **Preconfirmation Drift.** Fast receipts that changed status or block after sealing. Result: 0 of 440, Wilson upper 0.87%, checked once about 6 seconds or more after the last swap. This does not cover later reorganisations or finality.

## Method

Arms alternate in one window, so both see the same network. Timing starts at the scheduled moment, not when the worker is free (coordinated omission). Quantiles use nearest rank. P99 appears only at n≥299, and a finite interval needs n≥368. The reported sample size for each comparison is the alternating window, not the larger pool.

**A flaw we found and fixed.** The first runs used a 3-second interval against 200 ms flashblocks, and a 1-second read interval against 2-second blocks. Each sample therefore hit the same point in the block cycle, which made receipt times bimodal and made a zero miss rate meaningless. We added a random offset to every slot and reran. Those biased runs are not in the results above, except decision to broadcast, which does not wait on a block. It is kept in `evidence/testnet-swaps-phase-locked/` and is the only source for the hot-classic arm.

**A flaw we caught in the comparison.** The 368-swap arm's overall P50 (467.4 ms) looks better than its 72 alternating swaps (509.3 ms), because most of it ran after the alternating window. The headline uses the alternating figure.

## What this does not show

- **Mainnet confirmation is untested.** Our wallets hold no mainnet HSK. `eth_sendRawTransactionSync` is recognised by the mainnet RPC, but no transaction has gone through it there. A mainnet flashblock stream does exist at `wss://mainnet-flashblocks.hsk.xyz/ws`: 247 frames in 45 seconds, about 200 ms apart, with block numbers matching mainnet. That suggests similar confirmation times, but it does not prove them. The mainnet read results above do carry over.
- **Every number went through Cloudflare WARP on this machine.** We have no direct-connection baseline, so the tunnel's share of the time is unknown.
- **The swaps are self-trades in a thin test market.** They are not volume, and nothing here claims profit.
- **A receipt here is a flashblock preconfirmation,** not a sealed or finalised block.
- **One machine, one RPC endpoint, one afternoon.** Moving closer to the RPC should cut more, since the network dominates, but that is not measured. Intervals assume independent samples, and network delays can be correlated.
- **The USD figures use an assumed price and exclude L1 data fees.** The contract is not audited.

## Reproduce

Set `NETWORK=testnet` for `bench:swaps`, `report` and `bench:react`. `bench:read` and `check:quotes` read mainnet. Swaps need test HSK and enough vault limit.

```sh
npm run bench:swaps -- --n 440 --usd 0.01 --interval 3 --jitter-ms 2000 --run bench-jitter --arms pinned-classic,hot-sync --paired-slots 144 --broadcast
npm run report -- data/testnet/bench-jitter
npm run bench:read -- --n 400 --interval 2 --jitter-ms 1900 --verify-every 5 --run reads-mainnet-jitter
npm run bench:gas
npm run bench:react -- --n 90 --run react --broadcast
npm run check:quotes -- --rounds 25 --run quotes-mainnet
npm run attack-set
```

## Evidence files

| File | Contents |
|---|---|
| `evidence/event-to-receipt/report.json`, `react-samples.jsonl` | Polling against the stream, with every sample |
| `evidence/event-to-receipt/quote-check.json` | Local V3 math against the real Quoter |
| `evidence/next-steps/send-phase.json` | Send time across the flashblock cycle |
| `evidence/next-steps/read-parts.json` | Read time by method, transport and endpoint |
| `evidence/testnet-swaps/report.json` | Randomised-phase swap run |
| `evidence/testnet-swaps/paired-window.json` | Each arm's quantiles, split at the end of the alternating window |
| `evidence/testnet-swaps/preconfirmation-check.json` | Receipts re-read after sealing |
| `evidence/testnet-swaps-phase-locked/report.json` | Earlier run; use decision to broadcast only |
| `evidence/mainnet-reads/read-report.json` | Randomised-phase mainnet reads |
| `evidence/sync-send-probe.json` | Sync send against polling, n=15 each, plain self-transfers |
| `evidence/gas-compare.json` | Fork gas for the plain router and both vaults |
| `evidence/attack-results.json` | Attack set on the new vault |
| `evidence/testnet-deployment.json` | Deployed testnet addresses |
