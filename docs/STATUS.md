# Status of the system

What was done in this round of engineering, what evidence backs it, and what is still open. "Lane" is where something ran. **Nothing has run on mainnet, and no live model call has been tested. The source is vault version 4, which is on no public network. Version 3 is deployed on testnet but has not traded there, and its guard is off.**

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
| Low | `/api/evidence` walked the disk and read the chain on each request | A short shared cache and a rate limit | `viewer.test.ts`, "do not walk the disk again" |

## Completed and tested

| Area | What now exists | Lane | Result | Evidence |
|---|---|---|---|---|
| Contract | Version 4: version 3 plus a daily loss budget with a breaker, a gapless log on chain, a share-of-balance limit, a minimum time between trades, a strategy pin and log anchoring | Local | 165 of 165 | `evidence/v4/verification.json` |
| Contract | Version 4 against the real pool and router | Fork | 7 of 7 | `evidence/v4/verification.json` |
| Agent to receipt | Version 4: observe, sell, buy, stop-loss, crash recovery, on-chain refusals | Fork | 8 of 8 | `evidence/v4/e2e.json` |
| Agent to receipt | Version 4 on our own market contracts | Local | 18 of 18 | `evidence/v4/e2e.json` |
| Agent | The history verifier and everything in the version 3 row below | Local | 398 of 398 | `agent/test/`, `evidence/v4/verification.json` |
| Mainnet procedure | Every step of [the runbook](MAINNET-RUNBOOK.md), with test keys, ending in one swap through the real router | Fork | Preflight `pass`, swap included | `evidence/v4/mainnet-dress-rehearsal-fork.json` |

The rows below are **version 3 or earlier**. On version 4, the attack set, the final mutation check, the rehearsal and Slither have not been rerun.

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
| Live model call | `ANTHROPIC_API_KEY` is empty, and no local model is installed. `npm run llm:live` writes `BLOCKED` to `evidence/v4/llm-live.json`. **We make no claim that the LLM integration works end to end.** Only scripted replies are tested | A key, then that one command |
| Mainnet | The team chose testnet, for lack of funds. Under the official rule, a project not deployed on mainnet forfeits demo selection, and winners must be on mainnet to claim. Owner and agent keys hold 0 HSK at nonce 0 | The owner's decision and funds: 2.83 HSK for deployment alone, about 4.2 HSK with one swap. [The runbook](MAINNET-RUNBOOK.md) is ready and rehearsed on a fork only |

## Not done

| Item | Why |
|---|---|
| Version 4 on any public network | Not deployed. Testnet still has version 3, and mainnet has nothing |
| AI in the trading loop | Not built, deliberately. The loop is rules. The model only answers and drafts, which is a weak answer to a track asking for an AI agent as its core engine |
| Version 3 in use on testnet | Deployed at `0x9b31…1b28`, using 7,886,252 gas and 0.00789 test HSK. Guard off, no guardian, no stop armed, no swaps. The agent key holds about 0.00003 test HSK, too little to trade |
| Deploying the site | `render.yaml` is written and no public link is live. `holdfast.onrender.com`, a guess from it, returned 503 "Service Suspended" on 2 November 2026. Changing the site is the owner's call |
| Demo video | None in the repository. [A script](DEMO-SCRIPT.md) is ready for the owner to record |
| Contract source verification on the explorer | Not attempted. The runtime code was compared with the build instead, and matched |
| External audit | None. Everything here is our own review |
| A real wallet on the owner controls | Tested with a mock provider in a browser |
| Preflight latency on a live network | Not measured. See [BENCHMARKS.md](../BENCHMARKS.md#version-3) |
| A price guard in `deploy-test-market` | The deploy leaves it off, and the owner turns it on with `admin -- guard`. The test-market end-to-end run therefore does not exercise the guard. The fork rehearsal does |
| Alerting and process supervision | Monitoring exits with a code, and nothing pages anyone. See [READINESS.md](READINESS.md) |
| Profit | No result on a real market. The shadow and market evidence suggest little edge today, and the latency numbers do not change that |

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
| Deployed | Older vault on testnet, 1,050 swaps and refusals on chain. **Version 3 deployed on testnet, no swaps yet** | We did not confirm a deployment |

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
