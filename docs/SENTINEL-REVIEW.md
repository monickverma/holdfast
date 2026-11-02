# Holdfast and Sentinel, compared from source

Sentinel is [mesh-pch/sentinel-hashkey](https://github.com/mesh-pch/sentinel-hashkey), reviewed at commit `6840d73`. Everything claimed about it here comes from reading its source, from running our 21 tests against its contracts, or from reading its public deployments. Its README was not taken as evidence.

| Evidence | Lane | How to repeat |
| --- | --- | --- |
| [`sentinel-probes.json`](../evidence/v4/sentinel-probes.json): its own 23 tests and our 21 pass here | Local, with the mocks it ships, on solc 0.8.28 where it pins 0.8.24 | `node scripts/sentinel-probes.mjs` |
| [`sentinel-chain-check.json`](../evidence/v4/sentinel-chain-check.json): its testnet log recomputed from events, and its mainnet factory read | Live read-only | `node research/sentinel/chain-check.mjs` |
| Its Python verifier and agent | **Read only, never executed** | Claims about them are from the source, and are marked |

## What we credit Sentinel with

These are real, and Holdfast version 3 lacked the first five. Version 4 closes the first five for its own design.

| Sentinel does this | Holdfast version 3 | Holdfast version 4 |
| --- | --- | --- |
| A gapless log on chain, so an omitted trade shows | Events only, so an omission could not show | Added: `logHead`, `logCount`, cost below |
| A cumulative loss limit that trips and persists | Per-trade floor and budgets, nothing across trades | Added: a daily loss budget against the owner's mark, with a breaker |
| Limits relative to the vault's size | Absolute only | Added: a share of the balance |
| Minimum time between trades | None | Added, per token |
| A published strategy identity | Policy version off chain | Added: owner's pin, checked by the agent and verifier. The vault itself doesn't enforce it |
| A factory and registry that make setup simple | A deploy command | **Not added.** See "Decided against" |
| A commitment on chain per hold | Holds in a local log | **Not per tick.** A periodic `anchorLog` commits the whole log instead |
| A verifier anyone can run in one command | `npm run audit`, which needs local files | Added, and stricter than Sentinel's. See below |

## Hypotheses tested

"Refuted" means we expected a weakness and the source showed otherwise. Those results count against our own assumptions and are reported the same way.

| Hypothesis | Verdict | Test |
| --- | --- | --- |
| A breaker that trips in a reverting trade rolls back | **Refuted.** A lossy trade succeeds and `_trip` doesn't revert, so the halt persists | `test_SOUND_breakerPersistsAfterALossyTradeWithoutReverting` |
| A breach only seen before the trade is lost | **Confirmed.** A pre-trade breach reverts and stores nothing until someone pokes, and a recovery erases it | `SentinelProbes.t.sol` |
| Owner withdrawal depends on the oracle or the halt | **Refuted.** The owner withdraws with a stale oracle, halted, and with the strategy off | `test_SOUND_ownerWithdrawsWithStaleOracleHaltedAndStrategyOff` |
| The author's kill switch can trap funds | **Refuted for funds, confirmed for trading.** One author key stops every vault on that strategy until each owner migrates. Funds stay withdrawable | `SentinelProbes.t.sol` |
| A lying venue can fake output | **Refuted.** Balance deltas decide | `test_SOUND_aLyingVenueCannotFakeOutputOrOverspend` |
| The log can skip a trade | **Refuted.** Each executed trade advances it, and the public log recomputes | Probe, and the chain check: 30 entries, head matches |
| Decision hashes bind one decision to one trade | **Confirmed weak.** A hash can be reused across trades and holds, and a zero hash is accepted. The public log has 29 distinct hashes in 30 entries, with one reused | Probe, chain check |
| A hash proves the market it describes | **Confirmed weak.** Nothing in its verifier reads the market again. This is a limit of any hash | Source |
| NAV-relative limits can be moved by NAV | **Confirmed.** A donation or an oracle change widens the caps | `SentinelProbes.t.sol` |
| A stale oracle disables safety | **Confirmed.** It blocks the poke, and any withdrawal during an outage sets the high-water mark to 0, which erases the drawdown history | `SentinelProbes.t.sol` |
| A dust token can stop the vault | **Confirmed.** One dust transfer of a stale-priced listed token stops trades, poke, `recordHold` and resume | `SentinelProbes.t.sol` |
| The rolling 24-hour limit rolls | **Confirmed false.** It is a tumbling window, so twice the limit fits across a boundary | `SentinelProbes.t.sol` |
| Agent keys and trades expire | **Confirmed absent.** A trade ten years later passes | `SentinelProbes.t.sol` |
| The factory rejects bad settings | **Confirmed absent.** Owner equal to agent, and 100% slippage, are both accepted | `SentinelProbes.t.sol` |
| The push oracle limits movement | **Confirmed weak.** The limit is per call, so 96% in one block is possible | `SentinelProbes.t.sol` |
| The agent can also publish the price | **Confirmed, live.** `DeployDemo` makes it a publisher, and the testnet read shows `agentIsOraclePublisher: true`. It can sell under 65% of true value with all checks passing, roughly bounded by the drawdown limit, and can halt any vault on that oracle | Probe, chain check |
| A venue can poke during a swap | **Confirmed.** `pokeCircuitBreaker` is not `nonReentrant`, which allows a phantom halt and an inflated high-water mark | `SentinelProbes.t.sol` |
| The verifier passes on no evidence | **Confirmed by reading, not run.** `head_matches = ... or not entries` gives PASS with zero entries | `verifier` source, not executed |
| The verifier catches reuse and association errors | **Confirmed absent, by reading.** It dedupes hashes, matches order loosely with `<=`, and doesn't compare a record's vault, chain or parameters with the chain | Source, not executed |
| The LLM reviewer fails closed | **Confirmed false, by reading.** An unparseable answer or an exception proceeds with the trade. It can only veto or scale down, with scale clamped to at most 1, and that part is a good principle | Source, not executed |

### Vulnerability or hypothesis

| Class | Items |
| --- | --- |
| **Demonstrated against the code, on its own mocks.** Not exploited on any live vault | Agent as publisher, mid-swap poke, dust token halt, high-water mark erased during an outage, tumbling window, reusable hash, no expiry |
| **Design limits, not bugs** | The author's key reaching all vaults, the registry not binding what the agent runs, NAV caps moving with NAV |
| **Read in source, not run** | The verifier and LLM reviewer behaviour above |
| **Not applicable to real funds today** | Its mainnet factory shows `vaultCount: 0` and the registry one strategy. Its testnet run is a replay against `SimVenue` and `PushOracle`, its own mocks: 4 trades and 26 holds, returning 0.259% against a 1.996% 50/50 benchmark |

None of this is a claim that Sentinel is unsafe in use. No real money is in it, and the same is true of Holdfast.

## Comparison matrix

| Area | Sentinel | Holdfast v4 | Enforced where | Better |
| --- | --- | --- | --- | --- |
| Agent can't withdraw | Yes | Yes | On chain, both | Same |
| Owner exit with oracle down, halted | Yes | Yes, and no oracle exists to fail | On chain | Holdfast, by construction |
| Key expiry and revocation | No expiry. The owner replaces the agent with `setAgent` | Expiry at most 30 days, revoke, guardian | On chain | Holdfast |
| Trade deadline | None | At most 2 minutes | On chain | Holdfast |
| Replay protection | Trades carry no ID, so only the account nonce stops a repeat | Per-intent bitmap | On chain | Holdfast |
| Minimum time between trades | Across the whole vault | Per token, so alternating directions gives two per interval | On chain | **Sentinel** |
| Allowed venues | A list the owner can change | One immutable router | On chain | **Sentinel on flexibility**, Holdfast on having less for a stolen owner session to add |
| Per-trade cap | NAV share | Absolute, plus a share of balance | On chain | Holdfast, since donations can't move its absolute cap |
| Rolling budget | Tumbling 24 h | Continuous token bucket, hourly and daily | On chain | Holdfast |
| Lifetime cap | None in `AgentVault.sol` | Yes | On chain | Holdfast |
| Cumulative loss | Drawdown from high-water mark, needs a live oracle | Daily budget against the owner's mark, needs a fresh mark | On chain | **Different trade-off.** Sentinel's follows the market and has a manipulable feed. Holdfast's can't be pushed by a trader, but its mark goes stale and it sees only what the agent's trades lost, not price falls |
| Price sanity | Oracle floor from a feed | TWAP band on the pool, owner's floor and owner's mark | On chain | **Sentinel on independence if a real feed existed.** No HSK/USDT feed was verified on HSK Chain, so neither has one today |
| Balance-delta settlement | Yes | Yes | On chain | Same |
| Reentrancy | Lock missing on poke | Transient lock on all paths | On chain | Holdfast |
| On-chain log | Per trade and hold | Per trade, stop and periodic anchor | On chain | **Sentinel for per-tick holds**, Holdfast for cost |
| Decision record | Hash in the log entry, reusable | Hash in calldata, unique, domain-separated, canonical | Off chain, checked by the verifier | Holdfast |
| Verifier | One command, passes on nothing | One command, three answers, re-reads the market | Off chain | Holdfast |
| Multi-agent or ensemble | Yes | No | Off chain | Sentinel on features, no evidence of better results (below) |
| Setup | Factory, registry | Deploy command, admin CLI | Both | **Sentinel** |
| Backtest and evidence | Fixture, 10 bps fee, no liquidity model | Fork attack set, rehearsal, gas, mutation | Both | Holdfast on rigour |
| Mainnet deployment | Yes. Registry and factory, source-verified, with 0 vaults and 0 trades | **No.** Owner and agent keys at nonce 0 with 0 HSK, read on 2 November 2026 | Neither, a fact about the chain | **Sentinel.** Under the official rule this row decides demo selection, whatever the rest of the table says |
| Real-pool execution | None on mainnet | None on mainnet. Fork against the real router | Neither | Same: **no mainnet trade exists for either** |

**Both are missing:** an external audit, a verified independent HSK/USDT feed, real trades on HSKSwap, and evidence of profit.

## Threat model

| Attacker | Against Sentinel | Against Holdfast v4 |
| --- | --- | --- |
| Stolen agent key | Bounded by NAV caps and drawdown. Also moves the price if it is a publisher. No expiry | Bounded by trade cap, budgets, share, cooldown, floor, band and loss budget. Expires. Revocable by a guardian. Can't withdraw |
| Stolen author key | Stops every vault on the strategy, or changes the strategy with no pin | No such role |
| Stolen owner key | Total | Total. Two-step handover helps only against typos. **Use a Safe** |
| Manipulated pool | The feed helps if independent, and the demo's isn't | TWAP band and owner floor. A patient attacker can move a thin TWAP, which is why the floor exists |
| Manipulated or stale feed | Trades or halts on it, and history can be erased | No feed. A stale mark stops trades, not withdrawals |
| Malicious allowed venue | Balance deltas hold. Can poke mid-swap | Balance deltas and lock hold. The router is immutable, so it can't be added later |
| Donation | Widens NAV caps, or halts by dust | Moves the share limit only, and absolute caps still apply |
| Lying RPC | Verifier passes on empty | Verifier says `EVENTS_MISSING`, and the agent fails closed on preflight |
| Fabricating records | Reuse and association aren't checked | Fails or is incomplete. A record simply never published is INCOMPLETE, which can't be prevented |
| Prompt-injected model | Can only veto or scale, but fails open on errors | Model never signs. It drafts a policy a person approves, unknown fields are dropped or refused, and the vault's limits don't depend on it |

## Phase 5: ideas assessed, not adopted by default

| Idea | Decision | Why |
| --- | --- | --- |
| Ensemble of strategies | **No** | Sentinel's own public run returned 0.259% against a 1.996% benchmark on four trades, so it shows nothing yet. We have no data showing that it would beat one rule here. It would add risk and code without a result to justify it |
| LLM that may only reduce risk | **Principle kept, no new code** | The rule "AI output never grants spending" already holds: the model has no key and its output goes through `parsePolicy` and a person. A per-trade reviewer would add latency to a race and a paid dependency, and no live model call has been tested here at all |
| Regime detection | **No** | Nothing to fit it on: one wallet makes 94% of the swaps on the real pool |
| Client-side mirror of on-chain risk | **Already have it** | `preflight` asks the vault itself, which is stronger than a mirror |

The injection test is `a draft that ... leaves the proposal without it` in `agent/test/policy-review.test.ts`. A model told to name another router or vault, add a token, turn a guard or breaker off, raise a vault cap, or withdraw has no field to do it with. Separately, the agent's key can't do any of those on chain, whatever the model says. Raising an order's size within vault limits is possible in a draft, and is flagged for a deliberate yes. It is not prevented.

## Decided against

| Not built | Reason |
| --- | --- |
| Registry | It would add a trusted role that reaches all vaults, and its enforcement in Sentinel is nil. The owner's pin gives the identity without the role |
| Factory | A convenience with real value for many users. Holdfast has none yet, a deploy command does the job, and it would use up contract-size room. Revisit with users |
| External price feed | **Blocked by reality.** Pyth, RedStone and Supra pull candidates had no code at the guessed addresses. APRO has BTC/USD at `0x204E…360F`, and Supra's push contract at `0x58e1…3d57` has code but no `latestRoundData`, with a 6-hour heartbeat in its docs. No HSK/USDT feed could be verified. The price checks rest on the owner's mark and floor, which don't come from the pool, and the pool's TWAP, which does. Sources: [HSK oracles](https://docs.hsk.xyz/build-on-hashkey-chain/tools/oracles), [Supra networks](https://docs.supra.com/oracles/data-feeds/push-oracle/networks) |
| On-chain hold per tick | At several ticks per second it would cost gas with no trade to pay for it. The log commits them in a batch |
| NAV | Needs a price for every asset. "Withdrawal never depends on an oracle" is simplest to keep with no oracle at all |

## Backlog, as ranked and done

Ranked by security effect first, then correctness and verification strength, then cost.

| # | Weakness | Evidence | Done | Tests | Compared with baseline |
| --- | --- | --- | --- | --- | --- |
| 1 | Nothing bounded loss across trades | v3 source | `setLossGuard`, breaker | `HoldfastVaultV4.t.sol`, invariants, fork | Fork, 20 rounds, median sell: 154,900 gas on version 3 with guard, daily budget and hash, 172,896 on version 4 with every control on and a loss charged. [`gas-compare.json`](../evidence/v4/gas-compare.json) |
| 2 | An omitted trade could not show | v3 source | `logHead`, `logCount` | Same, plus the verifier | Same |
| 3 | No independent check of history | `audit` needs local files and trusts them | `verify-history` | 53 offline cases, 4 end-to-end scenarios | New |
| 4 | Records were thin and had no domain | `executor.ts` v2 body | Version 3: canonical, domain, names its trade | `verify-history.test.ts` | Old records stay checkable |
| 5 | No balance-relative limit or cooldown | v3 source | `setMandate` | `HoldfastVaultV4.t.sol` | Same as 1 |
| 6 | Holds could be rewritten | Local log alone | `anchorLog`, off unless configured | End to end | 31,884 gas per anchor, fork |
| 7 | No strategy identity | v3 source | `setStrategyPin`, agent refuses, verifier checks | End to end, offline | Off chain only |
| 8 | Setup is harder than Sentinel's | Comparison | **Open** | | |
| 9 | Independent feed | Search above | **Blocked** | | |

## Remaining risks in what was added

- **Rerun on version 4 on 2 November 2026:** 165 of 165 contract tests, 7 of 7 fork contract tests, 400 of 400 agent tests, 8 of 8 fork end-to-end, 18 of 18 test-market end-to-end, 55 of 55 mutants caught, Slither with 34 findings and 0 untriaged, the attack set with 120 of 120 contained, and the 26-step rehearsal. The attack set and rehearsal ran with the loss budget, share limit and cooldown off. The four Slither findings new on version 4 were triaged by us, not by an auditor. The verifier has not been run against the public testnet vault.
- Version 4 is not deployed anywhere public. The testnet vault is still version 3.

- The vault doesn't enforce the strategy pin. A stolen agent key ignores it, and only the verifier catches that, afterwards.
- The loss budget counts losses only against the owner's mark on the agent's own fills. A stale mark while the market rises above it sees nothing, and the band and floor are what remain.
- Stops aren't charged to the loss budget, deliberately, since a stop must fire in a crash. A stop's floor and band still bind.
- The cooldown is per token, so alternating directions gives two trades per interval.
- Anchoring is off unless configured, so a default run ends in `UNANCHORED_TAIL`.
- 120 scenarios, or any number, isn't proof that all attacks are prevented. These tests cover the attacks we thought of.
