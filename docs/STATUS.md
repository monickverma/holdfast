# Status of the system

**Public viewer:** [mainnet](https://holdfast-09jn.onrender.com/?network=mainnet) and [testnet](https://holdfast-09jn.onrender.com/?network=testnet), with progress, source links and a [website guide](WEBSITE.md). The latest local agent/viewer/research test count is recorded separately in [site-verification.json](../evidence/progress/site-verification.json); older test counts below retain their original scope.

What was done in this round of engineering, what evidence backs it, and what is still open. "Lane" is where something ran. **On mainnet, only the version 4 deployment has run: no limits, guardian, funds or trades. A language model can now be the trading engine, inside limits code enforces, but it has never traded on any chain: it has run on recorded mainnet data only. The live chat check passes 14 of 14 requests through OpenRouter to DeepSeek V4 Pro, not a Claude model. Version 4 is deployed on mainnet and on no other public network. Version 3 is deployed on testnet but has not traded there, and its guard is off. No profit has been shown in any lane.**

## What the audit found

We did not take the README's word for anything. The vault's limits held under review, and **no critical contract bug was found** in the previous version. The weaknesses were in its design and around it.

| Severity | Finding | Fix | Evidence |
|---|---|---|---|
| High | `/api/chat` spent money on a paid model behind only an `Origin` check, which any script can send | A token off this machine, a per-client limit and a daily budget | `agent/test/viewer.test.ts`, "the paid model cannot be reached" |
| High | Nothing protected a position while the agent was offline | A stop on the vault that anyone can fire, with its own floor and band | `test_anyoneCanFireATriggeredStop`, rehearsal |
| High | A stolen key could sell into a pool pushed to the floor, with no on-chain view of the price | A band around the pool's own average, on the price the trade leaves | `test_attack_guardRefusesASaleIntoAPushedPool` |
| Medium | A poll and a flashblock frame deciding at once **really did send two trades** when we built a test for it | A synchronous send guard | `agent/test/safety.test.ts`, first test |
| Medium | A preconfirmed fill that a reorg removed kept counting | Receipts are re-checked to 64 blocks, and identical bytes go out again | `safety.test.ts`, second and third tests |
| Medium | A trade between the owner's read and write could silently change the agent's allowance | `setLimitsIfRemaining` | `test_attack_tradeBetweenReadAndWriteCannotBePapered` |
| Medium | One key could stop things only by being the owner, and a typo could lose ownership | A guardian that can only stop things, and a two-step handover | `test_attack_guardianHasNoOtherPower`, `test_ownerHandoverNeedsTheNewOwnerToAccept` |
| Medium | Our own test market had no real price history or post-swap quote, so it could not exercise any of this | Real observation history and post-swap prices | `contracts/test/TestMarket.t.sol` |
| Medium | A chat edit gave every order a new id, and fills are counted by id, so a part-filled order could re-arm to its full size. An outside review found it by reading the code, and a test confirmed it. A person still had to approve the edit, and the vault's caps still applied | A drafted order that matches a current one keeps its id, and the review shown before approval says so | `agent/test/nl.test.ts`, "cannot re-arm to full size" |
| Low | `/api/evidence` walked the disk and read the chain on each request | A short shared cache and a rate limit | `viewer.test.ts`, "do not walk the disk again" |

## Completed and tested

| Area | What now exists | Lane | Result | Evidence |
|---|---|---|---|---|
| Contract | Version 4: version 3 plus a daily loss budget with a breaker, a gapless log on chain, a share-of-balance limit, a minimum time between trades, a strategy pin and log anchoring | Local | 165 of 165 | `evidence/v4/verification.json` |
| Contract | Version 4 against the real pool and router | Fork | 7 of 7 | `evidence/v4/verification.json` |
| Agent to receipt | Version 4: observe, sell, buy, stop-loss, crash recovery, on-chain refusals | Fork | 8 of 8 | `evidence/v4/e2e.json` |
| Agent to receipt | Version 4 on our own market contracts | Local | 18 of 18 | `evidence/v4/e2e.json` |
| Agent | The model engine, the same-pool closing leg and chat sizing below, the history verifier, the chat fix below, chat-set pacing and token choice, the OpenRouter connection and its retry after a cut-off reply, and everything in the version 3 row below | Local | 453 of 453 | `agent/test/` |
| Model engine | A model proposes buy, sell or hold with a size, from a snapshot of numbers code computed. `decide()` judges each proposal with the same gates as the rules, and then the breaker, preflight and the vault. A timeout, outage or bad answer means hold. A stop-loss never waits for it. Calls are rate-limited, only made when the signal changes, and capped in calls and dollars a day. It never sees a key | Local, scripted replies | 29 tests, among them: an outage, timeout or refusal holds; a stop fires while the model throws; a proposal is used once and expires; an oversized or unknown answer is refused | `agent/test/ai-engine.test.ts` |
| Model engine | The same engine, with a live model, on recorded mainnet samples | Replay, live model: `deepseek/deepseek-v4-pro` | Two windows, 0.72 and 1.0 hours. 1 November: held all 18 answers, 1 timeout, no trade. 2 November: one sell, the same trade the rules made, then held at its inventory limit; −0.024 USDT at the end. $0.05 a window, which ran out before each window ended | `evidence/v4/replay-model-2026-11-01.json`, `replay-model-2026-11-02.json`, [BENCHMARKS.md](../BENCHMARKS.md#strategy-replay) |
| Model engine, the run before | The first 2 November run held all 19 times while a sell would have paid, saying 0 HSK inventory left nothing to sell. The prompt now says inventory is the model's own net position, not the vault's balance, a test covers it, and the run above is after the fix | Replay, live model | 0 trades, kept as found | `evidence/v4/replay-model-2026-11-02-before-prompt-fix.json` |
| Closing leg | With `unwind` on, the edge rule closes its own inventory in the same pool once the round trip nets above its minimum. This is still one pool: no second venue, so not arbitrage | Local, replay | Works in tests. On both recorded windows, closing never paid: with it on and off, the $15 rule made the same one trade, ending at −0.044 USDT on 1 November and −0.024 on 2 November | `agent/test/ai-engine.test.ts`, `replay.test.ts`, `evidence/v4/replay-rules-2026-11-01.json`, `replay-rules-2026-11-02.json` |
| Chat | Sizing, a risk appetite in words that code turns into fixed numbers, turning the model engine on or off with its sizes, the closing leg, and answers on position, P&L, inventory and the model's spend from facts code computes | Local | 7 tests | `agent/test/chat-sizing.test.ts` |
| Live model call | 14 English requests: the 8 from before (a stop-loss, a question, a missing amount, a withdrawal request, an injection, pacing, a token choice, an asset the vault cannot trade), and P&L, position, a risk appetite, the model engine on with a size, off, and the edge rule with its closing leg. P&L and position answers are checked for the exact numbers in the facts. Each draft goes through the schema, `parsePolicy` and the review | Live model, no chain: OpenRouter, `deepseek/deepseek-v4-pro` | 14 of 14, $0.0485, 2 November 2026. No Claude model has been tested live | `evidence/v4/llm-live.json` |
| Live model call, the runs before | The first 14-case run passed, but its facts said the edge rule was on while the policy said off, and the model followed the facts. We fixed the facts and ran it again: 13 of 14. The model had copied the current slippage back, which overrode the risk level asked for. Code now ignores a copied value, a test covers it, and the next run passed | Live model | 13 of 14 kept as found | `evidence/v4/llm-live-before-risk-fix.json` |
| Do the tests catch bugs | 55 deliberate bugs in the version 4 vault | Local | 55 of 55 caught | `evidence/v4/mutation-check.json` |
| Static analysis | Slither 0.11.6 on version 4 | Local | 34 findings, 0 untriaged. 4 were new on version 4 and we triaged them: one exact comparison with zero, and writes after the router call under the reentrancy lock. Our triage, not an audit | `evidence/v4/slither.json`, `scripts/slither-check.mjs` |
| Attacks | Compiled version 4 vault, real router, agent key in the attacker's hands | Fork | 120 of 120 contained, 120 of 120 normal trades completed, 0 cap violations. The loss budget, share limit and cooldown were off | `evidence/v4/attack-results.json` |
| Whole lifecycle | Version 4: deploy, limits, guard, attacks, stop, keeper, rotation, halt, withdrawal, monitor | Fork | 26 of 26 steps, with the loss budget, share limit and cooldown off | `evidence/v4/rehearsal-fork.json` |
| Mainnet procedure | Every step of [the runbook](MAINNET-RUNBOOK.md), with test keys, ending in one swap through the real router | Fork | Preflight `pass`, swap included | `evidence/v4/mainnet-dress-rehearsal-fork.json` |
| Version 4 deployment | Runbook step 2 only, with a 110% gas margin, at `0xbbd6…7d3c` | Mainnet | Deployed in block 29,657,434, 4,666,365 gas. Runtime code matches the build on a re-read; the tool's own read just after the receipt did not | `evidence/v4/mainnet-deployment.json` |

The rows below are **version 3 or earlier**, kept as they were.

| Area | What now exists | Lane | Result | Evidence |
|---|---|---|---|---|
| Contract | Version 3: guardian, handover, daily budget, price guard, stop, halt, conditional limits | Local | 129 of 129 | `evidence/v3/verification.json` |
| Contract | Stateful invariants: 7 properties, 256 runs of depth 100 | Local | Included above | `contracts/test/HoldfastVault.invariant.t.sol` |
| Contract | Against the real pool and router | Fork | 6 of 6 | `contracts/test/HoldfastVault.fork.t.sol` |
| Do the tests catch bugs | 37 deliberate bugs in the vault | Local | 37 of 37 caught | `evidence/v3/mutation-check.json` |
| Static analysis | Slither 0.11.6 | Local | 25 findings, 0 untriaged | `evidence/v3/slither.json` |
| Attacks | Compiled vault, real router, agent key in the attacker's hands | Fork | 120 of 120 attacks contained, 120 of 120 normal trades completed, 0 cap violations | `evidence/v3/attack-results.json` |
| Whole lifecycle | Deploy, limits, guard, attacks, stop, keeper, rotation, halt, withdrawal, monitor | Fork | 26 of 26 steps | `evidence/v3/rehearsal-fork.json` |
| Agent to receipt | Observe, sell, buy, stop-loss, crash recovery, on-chain refusals | Fork | 8 of 8 | `evidence/v3/e2e.json` |
| Agent to receipt | The same loop on our own market contracts | Local | 7 of 7 | `evidence/v3/e2e.json` |
| Agent | Modes, preflight, reconciliation, decision hash, position report, heartbeat, SDK, explanations, MCP | Local | 289 of 289 | `agent/test/` |
| Gas | Every version and guard setting, 20 rounds | Fork | [Table](../BENCHMARKS.md#version-3) | `evidence/v3/gas-compare.json` |
| Site | Refusal demo, vault status, charts from evidence, owner controls, phone layout, both themes | Browser, against testnet reads | Six attacks answered by the real testnet vault | Tests in `viewer.test.ts`, manual browser check |
| Owner controls | Connect, role check, preview, `eth_call` check, send | Browser, **mock wallet** | Calldata matches viem byte for byte | `viewer.test.ts` |
| Public transactions | Six testnet transactions on the older vault, re-read from their receipts | Testnet, read only | 6 of 6 match | `evidence/public-transactions.json` |
| Version 3 deployment | Runtime code against the build, six attacks by `eth_call` | Testnet | Code matches; see the file for each attack | `evidence/v3/testnet-deployment.json`, `testnet-check.json` |

## Blocked

| Item | Why | What it needs |
|---|---|---|
| Mainnet trading | Version 4 is deployed on mainnet, with deployment proven; organizer acceptance of its timing has not been confirmed. The owner key holds about 0.30 HSK and the agent key 0, too little for runbook steps 3 to 11 | About 1 HSK more on the owner for limits, guard, guardian, loss budget (0.25) and a 1 HSK float, and 0.55 HSK on the agent for one swap |

## Not done

| Item | Why |
|---|---|
| Version 4 on testnet | Not deployed. Testnet still has version 3. Mainnet has version 4, unconfigured |
| The model engine on a chain | Built and tested locally and on recorded data, but never run against a vault on any network, in simulate or live mode. Testnet needs the owner's approval for each transaction, and version 4 is not on testnet |
| Arbitrage execution | No cross-venue executor. Read-only route sizing, split-exit research, depth-aware exchange hedges and fee replay are implemented; [research and evidence](STRATEGY-RESEARCH.md). Live trading still uses one pool |
| Chat for the model's mandate and the vault's new limits | Chat sets the model's sizes and on or off. The vault's share limit, cooldown and strategy pin have no admin command and no chat control |
| Version 3 in use on testnet | Deployed at `0x9b31…1b28`, using 7,886,252 gas and 0.00789 test HSK. Guard off, no guardian, no stop armed, no swaps. The agent key holds about 0.00003 test HSK, too little to trade |
| Public chat on the site | The site is live at holdfast-09jn.onrender.com and offers both mainnet and testnet vaults. Chat there needs a model key and `CHAT_TOKEN` set in the Render dashboard, and each answer costs money |
| Demo video | None in the repository. [A script](DEMO-SCRIPT.md) is ready for the owner to record |
| Contract source verification on the explorer | Not attempted. The runtime code was compared with the build instead, and matched |
| External audit | None. Everything here is our own review |
| A real wallet on the owner controls | Tested with a mock provider in a browser |
| Preflight latency on a live network | Not measured. See [BENCHMARKS.md](../BENCHMARKS.md#version-3) |
| A price guard in `deploy-test-market` | The deploy leaves it off, and the owner turns it on with `admin -- guard`. The test-market end-to-end run therefore does not exercise the guard. The fork rehearsal does |
| Alerting and process supervision | Monitoring exits with a code, and nothing pages anyone. See [READINESS.md](READINESS.md) |
| Profit | No result on a real market. On two replay windows of under an hour, no engine ended above zero: the best result was 0, by not trading, and every trade made was worth −0.01 to −0.04 USDT at the end of its window |

## Decisions, and what we rejected

- **One contract, not several.** Authority, policy and execution in one place are easier to reason about, cheaper per swap, and need no cross-contract trust. The cost is real: version 4 takes 4.67M gas to deploy on a fork and 21,021 of the 24,576 bytes allowed, so little room is left to grow.
- **No EIP-712 mandates.** See [SECURITY.md](SECURITY.md#replay-and-stale-trades).
- **No net-asset-value daily loss limit.** See [SECURITY.md](SECURITY.md#pool-and-oracle-manipulation).
- **No keeper fee.** It would add a pot to steal and a reason to fire. The cost is that a stop may sit uncalled.
- **No Next.js.** It would add a build, a dependency tree and a looser content policy for a page that has one data source and no routing. The page ships no framework and calls nobody else.
- **No web fonts.** The page uses the reader's own fonts, so that no third party sees a visit.
- **Dependency-free MCP.** A few tools over stdio, read and simulate only, with no key. It lets another agent ask what the vault would say, which justifies it, and it cannot send anything.

## How this compares with Vyuh

We read [Vyuh](https://github.com/Sandesh13fr/vyuh) as a reference, the source and its own documents, and did not run it. **So the Vyuh column is what its code and documents say, not something we tested,** and we did not measure its gas.

| | Holdfast | Vyuh |
|---|---|---|
| Shape | One vault per deployment | A factory making vault clones |
| Policy | Fixed set in the vault | Seven pluggable policy contracts, with an EIP-712 mandate registry |
| Flexibility | **Lower.** New rule means a new vault | **Higher.** This is its main advantage |
| Attack surface and gas | **Smaller, by construction,** with no external policy calls | Larger: it computes net asset value twice per trade, by its own code |
| Pushed-price defence | A band on the price the trade leaves, on the pool's own average | A TWAP check. Its documents say a thin pool's TWAP can be moved cheaply, and accept that for a demo |
| When price falls with the agent offline | Anyone can fire a stop that **sells** into the vault, above its floor | Anyone can **halt** with an on-chain proof. It halts and does not sell |
| Agent's choice of fee tier | Fixed at deployment | The agent chooses |
| Tooling | Own stdio MCP, SDK, keeper, monitor, plain web page | MCP SDK, keeper, Ponder indexer, Next.js console, published guard SDK. **Its tooling is broader, and an indexer is something we lack** |
| Verification | Version 4: 165 contract tests and a fork end-to-end run. Version 3: 7 invariants at 25,600 calls each, 37 of 37 mutants, Slither triage, attack set, 26-step rehearsal | By its own documents, 52 Solidity tests and 4 of 4 fork tests, with deploy, indexer and console wallet flows "not yet verified" |
| Deployed | **Version 4 on mainnet, unfunded and unconfigured in the 3 November read; version 3 on testnet.** Older testnet vaults produced the historical swaps and refusals | We did not confirm a deployment |

**Where Vyuh is ahead:** flexibility, a factory that serves many users, an indexer, and a more complete-looking product. A team wanting configurable policy across many vaults would prefer it.

**Where Holdfast is ahead:** a smaller thing to trust, a defence and a stop that act rather than only halting, much deeper verification, and measured numbers from real networks with their flaws stated.

**A mismatch explained:** its documents say the relevant pools hold under $0.01 of USDT. The 0.3% WHSK/USDT pool we read holds about 4.99M WHSK and 436,795 USDT at fork block 29605306. [A later comparison](reviews/2026-11-02-repository-comparison.md) found the two projects read different pools, on different factories, so both figures are right. It did not tie either router to `app.hskswap.com`.

Neither project has been audited, and neither should hold real funds on the strength of its own tests.

## Reproduce

```bash
node scripts/record-verification.mjs --e2e
```

```bash
npm run rehearse
```

```bash
npm run attack-set
```

```bash
npm run bench:gas
```

```bash
npm run check:mutation
```

```bash
npm run check:slither
```

```bash
npm run check:transactions
```

```bash
npm run llm:live
```

```bash
node scripts/mainnet-dress-rehearsal.mjs
```

The fork commands read from the public mainnet RPC, which rate-limits. Run them one at a time, or the fork stalls.
