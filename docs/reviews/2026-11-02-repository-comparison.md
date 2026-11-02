# Repository comparison: Holdfast, Sentinel, Vyuh and HSK Perps

Written on 2 November 2026 by a separate review session, against commit `197c8b2`, the content of `main` at merge `44275a8`. It is the session's report as given, with only this header added and links made to work from this folder. Scores and chances are its judgment, not measurements. A later commit can make any of this out of date.

**Sentinel wins today, because it's the only one of the four with contracts on mainnet. Holdfast is the strongest project (66 vs 54), but as it stands it forfeits demo selection under the official rule.** That rule is a pass/fail gate, so a higher score doesn't get Holdfast past it.

The fix is cheap: deploying Holdfast is estimated at about 2.34 HSK, roughly $0.20 at the pool price. The official page showed about 10 hours left when I read it.

## Official criteria
From the [DoraHacks page](https://dorahacks.io/hackathon/hskchainindia/detail):
- **Gate:** projects that haven't deployed on mainnet are "automatically deemed to have forfeited their eligibility for demo selection". Winners must also be on mainnet to claim a prize.
- **Selection:** "completeness, technical maturity and innovation", with no published weights, so the weights below are mine. Using recommended products earns extra points, and teams who can demo in Mumbai get priority.
- **Track 1:** a closed trading loop on HSKSwap with no manual steps, sustained profit under risk controls and a stop-loss, and a natural-language interface.
- **Deadline conflict:** the timer says Nov 2, 21:30 IST, but the notices section still says Nov 1. Confirm with the organizers.

## Scores
These are my judgment, not measurements. I fixed the metrics and weights before scoring.

| Metric | Weight | Holdfast | Sentinel | Vyuh | HSK Perps |
|---|---:|---:|---:|---:|---:|
| Fit to problem statement | 20 | 7 | 4 | 6.5 | 2 |
| On-chain execution | 20 | 4 | 6 | 1 | 2 |
| Security enforced on chain | 15 | 8.5 | 6.5 | 6 | 1.5 |
| Tests and evidence | 15 | 9 | 5 | 5.5 | 5 |
| Trading usefulness | 10 | 5 | 3 | 3 | 2 |
| Product and demo readiness | 12 | 5 | 7 | 6.5 | 4 |
| Engineering quality | 8 | 8 | 6.5 | 7 | 6 |
| **Total / 100** | | **65.7** | **53.9** | **48.7** | **29.4** |
| **Passes mainnet gate?** | | **No** | **Yes** | **No evidence** | **No** |

**On-chain execution, kept apart:**

| | Mainnet | Testnet | Simulated or fork |
|---|---|---|---|
| Holdfast | Nothing; owner and agent keys have 0 transactions and 0 HSK | Agent key has sent 1,218 transactions, on its own test market | Runs against the real router on a fork, by its own evidence |
| Sentinel | Registry and factory, source-verified, 0 vaults, 0 trades | 30 log entries, on its own mock venue and oracle | Local replay |
| Vyuh | None found | None found | 4 fork tests, by its own docs |
| HSK Perps | Nothing; 0 transactions and 0 HSK | 1 contract, 1 signal published | Fixture data from another chain |

## Chances
These are rough estimates for a top-3 finish in Track 1. I haven't read the rest of the field: 27 builds across both tracks, with the list hidden during review.

| Project | Today | If it deploys on mainnet | Confidence |
|---|---|---|---|
| Sentinel | 20–30% | Already has | Medium |
| Holdfast | Under 5%, unless organizers waive the rule | 25–35%, and the favourite of these four | Medium |
| Vyuh | Under 5% | 15–25% | Low; it may have deployed without publishing it |
| HSK Perps | About 1% | About 2% | High |

## Why each one lands where it does
**Sentinel: wins on eligibility, weak on the track itself.**
- It has a good pitch, a demo video and a real on-chain vault design.
- It has no HSKSwap code and no chat interface, so it misses two explicit track requirements.
- Its demo agent can also publish the oracle price ([`DeployDemo.s.sol:41`](https://github.com/mesh-pch/sentinel-hashkey/blob/6840d73/script/DeployDemo.s.sol#L41)).
- Its "live" trading ran only against its own mock venue. A judge who digs in will see the mainnet contracts have never held a vault.

**Holdfast: the deepest engineering and evidence, but it loses in these places:**
- **Mainnet:** nothing is deployed, and this one fact outweighs everything else.
- **Demo:** the repo has no video and the README has no site URL. `holdfast.onrender.com`, which I guessed from `render.yaml`, returned 503 "Service Suspended", and it may not even be yours.
- **Chat:** it has never run against a live model ([`llm-live.json`](../../evidence/v3/llm-live.json) says `BLOCKED`), yet the track explicitly requires it.
- **AI role:** the trading loop is rules, and the model sits outside it. That is good security but a weak answer to "AI agent as its core engine".
- **Profit:** your own evidence found 0 opportunities with an assumed 20 bps outside fee. That honesty is good, but the track asks for sustained profit.
- **Version drift:** the code at HEAD is vault version 4, which isn't deployed anywhere public, while [`README.md`](../../README.md) and [`STATUS.md`](../STATUS.md) still describe version 3.

**Vyuh: the best-looking product, not yet real on chain.**
- It has the most polished site, the Arena jailbreak idea, and an LLM that actually proposes trades.
- Its repo has no deployed addresses, and its submission file still says TODO for them.
- Its agent and its mainnet price oracle use a pool holding **$0.006 of USDT** ([`Deploy.s.sol:40`](https://github.com/Sandesh13fr/vyuh/blob/7524ab6/contracts/script/Deploy.s.sol#L40)). A price that thin could be moved for pennies, which undermines its USD-priced checks. I got this from reading the code, not from running an attack.

**HSK Perps: effectively off-track.**
- This looks like the repo you meant by "HSK Prep": it's a Track 1 entry.
- Its engine and order path target Somnia's testnet ([`config.py:7-13`](https://github.com/9xj89gzrtw-hue/hsk-perps-trading-agent/blob/0585364/agent/config.py#L7-L13), [`place.mjs:13-20`](https://github.com/9xj89gzrtw-hue/hsk-perps-trading-agent/blob/0585364/bridge/place.mjs#L13-L20)). That contradicts its claim that the perp venue runs on chain 177.
- Its contract only publishes signals and limits nothing. It does disclose that 155 of its 264 tests were inherited from earlier work.

## What would change Holdfast's rank most, in order
1. **Deploy on mainnet before the deadline.** You don't need a trade to pass the gate, as Sentinel shows, and this alone moves Holdfast to first of these four. [The dry run](../../evidence/v4/deploy-dry-run-mainnet.txt) reserves about 2.34 HSK and shows the owner holding 0. The remaining problem is getting HSK onto that key, not the amount.
2. **Make one real swap through HSKSwap once deployed.** None of the four has done this, so it would be a clear lead over the others.
3. **Add a 2–3 minute demo video and a live site link.** This is your cheapest gap against Sentinel and Vyuh.
4. **Run the chat once against a live model.** This closes the most visible hole against the track text.
5. **Align the README and `STATUS.md` with version 4,** and add a mainnet row to [`SENTINEL-REVIEW.md`](../SENTINEL-REVIEW.md). The Sentinel flaws I checked in that review are accurate, but its comparison table omits the row Holdfast loses, and a judge would notice.

## What I checked and couldn't check
- **Sentinel, Vyuh and HSK Perps:** I read the source and checked the chain, but ran none of their code, as you asked. Their test results are their own claims.
- **Holdfast tests:** on a clean copy, 397 of 397 agent tests and the typecheck passed.
- **Holdfast contract tests:** I couldn't run these because Foundry isn't installed here, so the claimed 165 passes are unconfirmed. The latest recorded run predates version 4.
- **Holdfast's pool as HSKSwap:** `0x4ff5…` holds about $436,700 of USDT, far more than Vyuh's pool, but I didn't tie it to `app.hskswap.com`. This also explains the mismatch noted in `STATUS.md`: the two projects read different pools, on different factories.
- **Vyuh's deployment:** the explorer search only finds verified contract names, and the testnet search didn't work, so an unpublished deployment is possible.
- **Other unknowns:** I couldn't tell whether any of the four has actually submitted, or which teams can attend Mumbai in person.
