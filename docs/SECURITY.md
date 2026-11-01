# Holdfast threat model

This covers the current source, vault version 3. It is our own review, not an audit, and the contract has not been audited.

**Version 3 is deployed on testnet at `0x9b31…1b28` with its price guard off, no guardian and no stop armed, so those defences are not active there yet.** The older testnet vault `0x4bfc…ee89` has none of them.

Tests named below are in `contracts/test/HoldfastVaultV3.t.sol`, `contracts/test/HoldfastVault.invariant.t.sol` and `agent/test/`. Results are in `evidence/v3/`.

## What is protected, and what is assumed

**Protected:** the owner's tokens in the vault, and the owner's ability to get them out.

**Assumed:** the owner's key is safe, HSKSwap's router and pool do what their code says, and the chain executes correctly. The sequencer is not trusted to order fairly, or to keep a preconfirmation.

**The boundary:** everything off chain is untrusted by the vault. Each row below ends at the question of what the vault still refuses.

## Summary

| Threat | Worst case with version 3 | Largest remaining weakness |
|---|---|---|
| [Misled or malicious model](#misled-or-malicious-model) | A bad policy the owner approved, bounded by the vault | An owner who approves without reading |
| [Prompt injection](#prompt-injection) | The same | The same |
| [Stolen agent key](#stolen-agent-key) | Sales at the floor up to the budgets, until the key is ended | The loss rate is the owner's chosen floor and budget |
| [Stolen owner key](#stolen-owner-key) | **Everything in the vault** | Not defended. Use a multisig as the owner |
| [Pool and oracle manipulation](#pool-and-oracle-manipulation) | Trades allowed, or a stop fired, at a price held away for a whole window | Thin pool. Costs measured below are a floor |
| [Sandwich and MEV](#sandwich-and-mev) | A trade clears at the worst price its band and floor allow | No private transaction path |
| [RPC failure, lying RPC, delay](#rpc-failure-lying-rpc-delay) | The agent holds, or trades on a bad view inside the limits | One public endpoint |
| [Reorg and lost preconfirmation](#reorg-and-lost-preconfirmation) | A fill disappears and the agent resends | Reorgs tested with a mock chain, not observed live |
| [Agent crash, duplicate sends, partial failure](#agent-crash-duplicate-sends-partial-failure) | A held position while the process is down | Needs someone to restart it |
| [Keeper failure and downtime](#keeper-failure-and-downtime) | The stop does not fire until someone calls it | No keeper is running today |
| [Accounting and limit resets](#accounting-and-limit-resets) | None found | Not audited |
| [Malicious tokens and reentrancy](#malicious-tokens-and-reentrancy) | A hostile token stops its own trades | Pair is fixed at deployment, so choose it well |
| [Replay and stale trades](#replay-and-stale-trades) | None found | Intent IDs are stored forever, a small state cost |
| [Gas griefing and denial of service](#gas-griefing-and-denial-of-service) | The agent's gas is drained, or a stop's caller loses gas | The agent key's gas is outside every token cap |
| [Malicious API clients](#malicious-api-clients) | Rate-limited reads | Per-address limits are only as good as the address |
| [Frontend and wallet](#frontend-and-wallet) | A compromised server could offer a bad transaction | The wallet's own screen is the final check |
| [Server, environment and deployment](#server-environment-and-deployment) | A misconfigured limit or a wrong address | Checklist in [READINESS.md](READINESS.md), and a person must follow it |

## Misled or malicious model

- **Impact.** The model proposes a harmful policy, such as larger sizes or a worse floor.
- **Attack path.** A manipulated conversation, a provider compromise, or plain error.
- **Defences.** The model only yields a typed policy, which `agent/src/policy.ts` parses and bounds. `agent/src/policy-review.ts` writes a code-generated review and asks for a longer confirmation for risky changes, and the owner must say yes. No model runs in the trading path: `decide` is a pure function, and each trace records model calls, which are 0 in the execution path. The vault then applies its own limits whatever the policy says.
- **Weaknesses.** The owner can approve something bad. **No live model call has been tested**: `npm run llm:live` records `BLOCKED` because no API key is available, so this path is proven with scripted replies only.
- **Further mitigation.** Run `npm run llm:live` with a key before relying on chat.

## Prompt injection

- **Impact and path.** Text in a question or in a data feed tries to steer the model. The viewer feeds evidence into its chat context, so a poisoned evidence file reaches the model.
- **Defences.** The same as above. Chat on the viewer can only answer: a policy reply is discarded and replaced with fixed text (`viewer.test.ts`, "viewer discards policy proposals"). Answers are labelled model output.
- **Weaknesses.** A model answer can still say something false to a reader. It cannot move funds.

## Stolen agent key

- **Impact.** The thief can call `execute` directly and skip every off-chain check, selling at the worst price the vault allows.
- **Attack path.** A leaked `.env`, a compromised host, or a malicious dependency in the agent process.
- **Defences.** On chain, in `execute` (`HoldfastVault.sol:218`): the token pair, a per-trade cap, hourly and daily budgets with a continuous refill, a lifetime cap, a floor, the price band, a deadline, one-time intent IDs, and expiry at most 30 days away. The agent cannot withdraw (`testFuzz_agentNeverGainsWithdrawalPower`). A guardian can end the key in the same block without being able to take anything (`test_revokeEndsTheKeyInTheSameBlock`, `test_attack_guardianHasNoOtherPower`). A stolen key cannot use up the stop's allowance or block it by pausing (`test_attack_stolenKeySpendingItsBudgetLeavesTheStopAllowance`, `test_attack_stolenKeyPausingDoesNotBlockTheStop`).
- **Measured.** Attack set on a fork: `evidence/v3/attack-results.json`. Rehearsal: a thief skipping the agent was refused on chain (`evidence/v3/rehearsal-fork.json`).
- **Weaknesses.** The loss is real and is what the owner configured: `input × (market − floor)`, at the budget rate, until the key is ended. In the attack set, 60 HSK sold into a pushed pool lost $2.23 on one run. With no guardian and an absent owner, it continues until a limit runs out.
- **Further mitigation.** Set a guardian, run `npm run monitor` on a schedule, and keep the floor close to the market.

## Stolen owner key

- **Impact.** Total. The owner can withdraw everything.
- **Defences.** Ownership transfer needs the new owner to accept (`test_ownerHandoverNeedsTheNewOwnerToAccept`), which only stops mistakes. The owner can be a contract, so a Safe works, and the vault needs no signature support for that. Nothing here defends against a thief who holds the owner's key.
- **Considered and declined.** A withdrawal delay. It would slow the owner's escape in exactly the emergency the vault exists for, and a multisig answers the same threat without that cost.

## Pool and oracle manipulation

- **Impact.** With the agent's trades, a pushed pool lets a thief sell at a bad price up to the floor. With the stop, a pushed average could fire a sale the market did not call for.
- **Attack path.** Trade the pool to a price and hold it there, for one block against spot or for a whole window against the average.
- **Defences.** Optional guard, `setPriceGuard` (`HoldfastVault.sol:587`): every trade must leave the pool within a band of its own time-weighted average, using the price after the swap (`_requireInBand`, `:383`). It fails closed when the oracle cannot answer (`test_guardFailsClosedWhenTheOracleFails`). It is one-sided, because a sale into a pool pushed up is good for the vault (`test_guardIsOneSided`). A stop reads the average, not spot (`test_attack_spotAloneCannotFireAStop`), checks its own band after the swap (`test_attack_sandwichedStopIsRefusedByItsBand`), and never sells under its own floor (`test_attack_stopNeverSellsUnderItsOwnFloor`).
- **Measured cost of pushing the real pool** (fork, `evidence/v3/rehearsal-fork.json`, selling then buying straight back with no other trader acting): 120 ticks costs about $16, 396 about $52, 1,165 about $153 and 3,645 about $481, on a pool holding about 4.99M WHSK and 436,795 USDT.
- **Weaknesses.** **That is a low cost, and a floor on the true cost.** Holding a price for a whole window also pays arbitrageurs, which a fork with no other traders cannot measure, so we do not know the real figure. The pool's traders are thin (462 swaps in 7 days, 94% from one wallet, `evidence/market/`), so an attacker might not be arbitraged quickly. **The guard should be read as raising the cost of an attack and not as preventing it, and the floor stays the real backstop.** The band check uses the post-swap price from the pool, so a single large trade is stopped, but a slow push over many blocks moves the average with it. The guard is off until the owner turns it on, and `deploy-test-market` does not turn it on.
- **Further mitigation.** A second on-chain price source would need a second deep market to read, and we did not survey for one. A larger pool would improve this more than any code.
- **Considered and declined.** A net-asset-value daily loss limit in the vault. It needs a trustworthy price for the same pool, so it inherits this weakness, and the band with the daily budget already bounds it.

## Sandwich and MEV

- **Impact.** A trade fills worse than quoted.
- **Attack path.** A sequencer or a fast searcher brackets the transaction.
- **Defences.** `minOut` from the agent, a floor from the vault, and the band on the price the trade leaves. An attacker holding the agent key could set a low `minOut`, so only the floor and band apply then: measured above. The agent sells in small sizes, and `test_attack_guardRefusesASaleIntoAPushedPool` covers the push.
- **Weaknesses.** We know of no private transaction route on this chain, though we did not survey for one, so assume anything sent is visible.

## RPC failure, lying RPC, delay

- **Impact.** The agent stops seeing the market, or sees a false one.
- **Defences.** Backoff, and holding on stale data (`agent/src/rpc.ts`, `decide.ts`). The agent reads through one atomic multicall, so a read cannot mix blocks. The vault reads the pool itself, so a lying node cannot get a trade past the band or floor. `chain-guard.ts` refuses to broadcast if the node's chain ID differs from the expected one. `monitor` flags a stale head and slow reads.
- **Weaknesses.** One public endpoint, rate-limited, with no fallback in the trading path. A lying node can make the agent hold, or trade inside its limits.

## Reorg and lost preconfirmation

- **Impact.** A receipt seen on a flashblock can disappear, so the agent counts a fill that did not happen.
- **Defences.** `executor.reconcile` re-checks each receipt's block hash until it is 64 blocks deep (`REORG_WATCH_BLOCKS`). If it changed, the fill stops counting and the identical signed bytes go out again, and `rebuildRuntime` removes a fill that left the ledger (`safety.test.ts`, "a preconfirmed receipt a reorg removes stops counting").
- **Measured.** On testnet, 0 of 440 fast receipts changed after sealing, and on mainnet 410 of 410 frames matched sealed blocks. That says this is rare, not that it cannot happen. The code path is exercised with a mock chain only.

## Agent crash, duplicate sends, partial failure

- **Impact.** A crash can lose track of a transaction, and two paths can act on one signal.
- **Defences.** A write-ahead ledger signs before sending and recovers by resending identical bytes (`e2e-fork`, "a crash before broadcast recovers"). **We reproduced a real duplicate send in a test:** a poll and a flashblock frame deciding together sent two trades. The `sending` guard and `sendEpoch` in `agent.ts` now refuse it (`safety.test.ts`, "a poll and a frame deciding together send one trade"). A breaker stops repeated failures (`breaker.ts`). `eth_call` preflight skips a doomed send and saves its gas, except on stream frames, where it would miss the latency window.
- **Weaknesses.** Nothing restarts the process. The heartbeat file lets `npm run monitor -- --agent` notice, and a person or a supervisor must act.

## Keeper failure and downtime

- **Impact.** The agent's own stop-loss does not run while it is offline.
- **Defences.** A stop on the vault that **anyone** can fire once the average crosses its trigger (`triggerStop`, `HoldfastVault.sol:239`), with `npm run keeper` to call it. The caller chooses nothing and is paid nothing, and proceeds stay in the vault (`test_anyoneCanFireATriggeredStop`). An expired or stolen key does not block it (`test_expiredKeyDoesNotBlockTheStop`).
- **Weaknesses.** **No payment means no one is obliged to call it.** The owner must run a keeper, or accept that it fires only when someone cares. A stop also fails when its sale is refused by its own floor or band, by design, so in a real crash it may sell nothing. It sells one tranche at a time, so it can lose on each.

## Accounting and limit resets

- **Impact.** A limit that resets or doubles would break every promise above.
- **Attack path.** Trade around a budget reset, trade between the owner's read and write, or change limits to refresh a budget.
- **Defences.** Continuous refill, not a fixed grid, so no double spend at a boundary (`testFuzz_dailySpendStaysInsideItsEnvelope`). Spend is kept across limit changes (`test_dailyBudgetKeepsWhatWasSpent`). `setLimitsIfRemaining` refuses if a trade happened since the owner read (`test_attack_tradeBetweenReadAndWriteCannotBePapered`). Amounts come from balances, not from the router's return value (`test_attack_feeOnTransferOutputIsMeasuredByBalance`). Stateful invariants hold across 25,600 calls each (`invariant_agentSpendStaysInsideEveryCap`, `invariant_lifetimeAccountingIsExact`, and five more).
- **How we tested the tests.** 37 of 37 deliberate bugs in the vault were caught, `evidence/v3/mutation-check.json`. Slither reports 25 findings, each triaged in `scripts/slither-check.mjs`, `evidence/v3/slither.json`.
- **Weaknesses.** Limits stop at 72 bits, about 4,722 tokens with 18 decimals, and the vault refuses larger rather than cutting them. Not audited.

## Malicious tokens and reentrancy

- **Defences.** A reentrancy lock on every path that swaps, an allowance reset after each swap (`invariant_routerNeverKeepsAnAllowance`), and calls that tolerate tokens returning nothing and check code size. A token that returns false fails loudly (`test_attack_tokenThatReturnsFalseFailsLoudly`), and one that reverts blocks its own trades but not other withdrawals (`test_attack_tokenThatRevertsOnTransferBlocksTradesNotOtherWithdrawals`).
- **Weaknesses.** Router and tokens are immutable. A hostile choice at deployment cannot be fixed, only abandoned by withdrawing.

## Replay and stale trades

- **Defences.** One-time intent IDs, a deadline at most 120 seconds away (`MAX_INTENT_TTL`), and the agent's ledger.
- **EIP-712 mandates: considered and declined.** A signed-mandate design lets a relayer act for the owner. Here the owner can already send directly, a Safe works as owner, and the guardian covers relayed emergencies. A signature path would add domain, nonce and replay surface for no use we have.

## Gas griefing and denial of service

- **Impact.** A thief with the key can burn its gas on reverts. Anyone can call `triggerStop` and revert at their own cost.
- **Defences.** No loop depends on outside input. The stop's caller pays and chooses nothing. `monitor` warns on low agent gas. Bytes after the ABI arguments are ignored (`test_bytesAfterTheArgumentsAreIgnored`), so the decision hash cannot change behaviour.
- **Weaknesses.** The agent key's gas is outside every token cap. Keep little on it.

## Malicious API clients

- **Impact.** Exhaust the server or its RPC quota, read something private, or run up model costs.
- **Defences, in `agent/src/cli/viewer.ts`.** Before this work, `/api/chat` called a paid model with only a browser `Origin` check, which any script can send: **the highest-severity finding in this review, in the server rather than the contract.** Now a visitor off this machine must hold `CHAT_TOKEN`, compared in constant time, and without one public chat does not exist. There is also a per-client limit and a daily budget, counted before the call. All API reads are rate limited and cached, so a burst costs one disk walk and one set of RPC reads. Attacks are named presets: a visitor supplies no address, amount or calldata, so the endpoint cannot act as an RPC proxy. `/api/proof` passes named fields from named files only, and a test plants a secret in those files and checks it never appears. Request and header timeouts apply, and static files are an allowlist. Each of these has a test in `viewer.test.ts`.
- **Weaknesses.** Per-client limits use the address the proxy reports, so a botnet gets past them, and only the global caches and the budget still hold. There is no edge protection on the free Render plan.

## Frontend and wallet

- **Impact.** A compromised page could show one thing and ask the wallet to sign another.
- **Defences.** A strict policy with no inline script or style and no outside origin, so nothing third party can run. No keys on the page. `web/wallet.js` builds calldata with no dependencies, and a test compares every encoding with viem byte for byte. A mixed-case address with a bad checksum is refused (Keccak checked against viem), since a typo in a withdrawal is otherwise permanent. Each action shows what it will do and asks the wallet's node what the vault would say first. The site never sends without the wallet's own confirmation. Network and generation are labelled, and each result names the lane it came from.
- **Weaknesses.** Tested in a real browser with a **mock** wallet (`window.ethereum`), not with a real one on a real chain. Anyone who controls the server controls the page, and then the wallet's own screen is the last check.

## Server, environment and deployment

- **Impact.** A wrong address, a wrong chain, or a key in the wrong process.
- **Defences.** The viewer reads only named variables from `.env`, so wallet keys never enter it. `admin` and `keeper` check the chain ID and refuse chain 177 without `--confirm-mainnet` (rehearsal, "the keeper refuses to send on chain 177"). `deploy-test-market` refuses chain 177. The vault's constructor refuses addresses with no code (`test_constructorRefusesAddressesWithoutCode`). `setLimitsIfRemaining` makes a limit change depend on what the owner read.
- **Weaknesses.** Keys in `.env` on one machine, unencrypted. A hardware wallet or a Safe as owner is the answer, and the agent key should hold only gas. See [READINESS.md](READINESS.md).
