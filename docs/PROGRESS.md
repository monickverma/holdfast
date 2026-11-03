# Holdfast progress audit — 3 November 2026

**Website update:** [Open the viewer](https://holdfast-09jn.onrender.com) and use its mainnet/testnet selector. The release changes consolidate the research with the deployed-v4 source and expose the measurements, criteria and comparison below. [Latest validation](../evidence/progress/site-verification.json) and [website guide](WEBSITE.md). The original audit below records the state at the time it ran; its 463-test result and scores remain historical.

**Engineering is strong; sustained profitable trading is not demonstrated.** Stopping major feature expansion is reasonable. Deployment configuration, release consolidation and operational validation remain. No funds were spent on this audit, no model was called, and no public transaction or exchange order was submitted.

## What is implemented

The latest Claude worktree has the v4 guarded vault, a model-proposal engine with deterministic checks, chat controls, monitoring/keeper tools and replay tooling. Our additions implement read-only cross-venue quotes, route enumeration, finer sizing, split-exit allocation, exchange-depth hedge screening and fee/gas replay diagnostics. They **do not implement a cross-venue transaction executor**, and have not been connected to live trading.

This workspace started at `9be6f67`, older than the Claude worktree's `5d6a9cda39dfc1bdfb48d9fde48e746434cfd6c6` (the merge containing mainnet deployment). A clean tracked-file archive of that newer revision was extracted to `.audit/holdfast-v4`, with only our research source and tests overlaid. It built and passed **463/463 local agent tests**. The 200/200 result from the older workspace is a separate run and must not be added to 463. The historical 453/453 claim refers to an earlier source state; `verification.json` itself records an earlier 413/413 run.

At the time of the original integration check, the combined copy had not been committed, merged, deployed or substituted for either original checkout. That check verified compatibility, not release completion. The subsequent website release consolidates the same research files with the v4 source; its own validation is recorded separately. File hashes and the exact base commit are in [v4-integration.json](../evidence/progress/v4-integration.json). No wallet files or private environment configuration were copied into the integration snapshot.

## Fresh mainnet checks

At block **29,670,325**, chain **177**, public reads confirmed:

| Item | Observation |
|---|---|
| Vault | `0xbbd6f3df289a2fde6b5dd8edea19b827e0d07d3c` |
| Contract version / runtime bytes | 4 / 21,021 |
| Deployment receipt | Successful; block 29,657,434; 4,666,365 gas |
| Trade events since deployment | **0** |
| Vault WHSK / USDT / native HSK | **0 / 0 / 0** |
| WHSK and USDT maximum trade caps | **0 / 0** |
| Guardian | Unset |
| Price guard / loss guard | Off / off |
| Agent native HSK | **0** |
| Owner native HSK | About **0.299409** |
| Explorer source verified | **No** |

The zero caps currently prevent trading. The existence of the contract does not mean its configured protections are active or it has traded. Deployment time in the recorded receipt is 2 November 2026 at 23:26:43 UTC (3 November at 04:56:43 IST). Claude's review flagged it as later than the listed deadlines. No organizer acceptance or rejection has been verified here. The public hackathon page was not retrievable through the web tool during this audit.

Evidence: [mainnet-2026-11-03.json](../evidence/progress/mainnet-2026-11-03.json); [deployment transaction](https://hsk.blockscout.com/tx/0x24d61d8021a549b45680db3108431d661bf488294783b9f59bc7ba2c39e3be34). `scripts/audit-mainnet-readonly.mjs` contains the read-only procedure.

## Scores: judgments, not percentages complete

The first two columns reproduce the original council review and the later rescore recovered from the local Claude session report. The last column is this audit's judgment. Ten means a strong, demonstrated fulfilment of that criterion, not merely code existing. These are **not official judging scores, calibrated probabilities, or a security audit**.

| Criterion /10 | Original council | Claude after deployment | Current assessment | Remaining limit |
|---|---:|---:|---:|---|
| Mainnet requirement / eligibility | 0 | 5 | **5** | Deployment confirmed; timing acceptance unknown and vault unconfigured |
| Closed-loop automation | 5 | 6 | **6** | Rule-based fork runs exist; model-driven chain execution unproven |
| AI as core engine | 1 | 4 | **4** | Model proposes behind gates; evidence is local and replay |
| Arbitrage and spreads | 2 | 2 | **3** | Better measured search and split routing; no cross-venue executor or fill |
| Sustained profitability | 0 | 0 | **0** | No realized positive P&L; hypothetical/replay results do not establish it |
| Risk control and stop-loss | 7 | 8 | **8** | Strong code and test evidence; no external audit or continuously operating keeper |
| Natural-language interface | 2 | 6 | **6** | Live model requests passed; public-site chat and full owner workflow remain incomplete |
| Completeness | 3 | 5 | **5** | Much built; consolidation, funded configuration and end-to-end product operation remain |
| Technical maturity | 7 | 8 | **8** | Combined local suite passes; production reliability and deployed protections unproven |
| Innovation | 4 | 5 | **5** | Guarded model proposals and verifiable decision logs; research routing is an established method |
| **Unweighted total /100** | **31** | **49** | **50** | Summary of this rubric only |

Thus the broad track assessment is approximately **5/10**, while engineering strength is approximately **8/10**. These answer different questions. We do not turn the 50/100 rubric sum into “50% of the coding remains.” The small numerical change since Claude's later review reflects the still-missing execution/profit evidence, not a lack of engineering work.

Deployment itself is a completed milestone. Its score above is lower because the row includes the broader mainnet requirement and unresolved eligibility, not because the deployment is only half finished.

## What the competitor comparison actually said

The separate historical repository comparison used different weights and scored Holdfast **65.7/100**, Sentinel **53.9**, Vyuh **48.7**, and HSK Perps **29.4**. Holdfast led that four-project engineering comparison by **11.8 points** over Sentinel even before its deployment. It was still marked down for the mainnet gate.

Those are historical reviewer judgments from 2 November, not a current leaderboard. The competitors were not rerun or freshly re-audited here, and other entries were outside the comparison. Deployment and model/chat improvements address several previously identified gaps, but they do not establish a current prize probability. The 65.7 score must not be compared directly with the different rubric's 50.

## Evidence counts and their limits

| Evidence | Count | Provenance |
|---|---:|---|
| v4 plus new research agent tests | **463/463** | Run in this audit, isolated local copy |
| v4 Solidity tests | **165/165** | Recorded Claude artifact, not rerun here |
| v4 fork contract tests | **7/7** | Recorded artifact |
| Fork agent-to-receipt scenarios | **8/8** | Recorded artifact; not live model chain trading |
| Local end-to-end scenarios | **18/18** | Recorded artifact |
| Hand-picked mutation tests | **55/55 caught** | Recorded artifact; not exhaustive bug coverage |
| Attack set | **120/120 contained** | Recorded fork artifact; loss budget, share limit and cooldown were off |
| Benign trades during attack suite | **120/120 completed** | Recorded fork artifact |
| Static analysis | **34 findings; 0 untriaged** | Project's Slither triage; not 34 independent audit approvals |
| Live chat requests | **14/14 passed** | Recorded OpenRouter/DeepSeek run; not repeated here |
| Mainnet v4 trade events | **0** | Fresh public chain read |

The recorded artifacts were read from the newer Claude worktree under `evidence/v4/`. Passing test cases do not establish a percentage probability of safety or profitability.

## What remains without spending money

The integration compatibility check and this consolidated audit were completed first. The subsequent website release consolidates the tested additions, aligns the deployment and AI claims, and exposes the evidence. Submission/demo preparation and operational validation remain separate work. Explorer source verification and additional local failure/recovery tests are also useful. Public reads and local/fork testing need no trading capital, although endpoint availability and rate limits can constrain them.

No paid model calls, mainnet configuration, funded swaps or deployment changes are planned under this audit. A live model-on-chain run, active keeper operation and real net-profit evidence remain unproven. They can wait; they should not be represented as completed.

Recommendation: **freeze major feature expansion and treat this as a strong engineering prototype ready for final packaging, with trading performance still experimental.** There is no need to spend money just to make a completion score look higher.
