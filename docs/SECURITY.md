# Holdfast threat model

This covers the current source: vault version 4, and an agent in which a language model can be the trading engine. It is our own review, not an audit, and the contract has not been audited.

**Version 4 is on no public network.** Version 3 is deployed on testnet at `0x9b31…1b28` with its price guard off, no guardian and no stop armed, so those defences are not active there yet. The older testnet vault `0x4bfc…ee89` has none of them. Nothing is on mainnet.

**The model engine has never traded on any chain.** It has run against a live model on recorded mainnet data only (`evidence/v4/replay-model*.json`), and the agent tests drive it with scripted replies.

Version 4 adds to version 3: a daily loss budget valued at a price the owner sets, with a breaker that pauses the agent at half; a limit on the share of the balance one trade may spend; a minimum time between trades per token; a strategy pin; and a gapless hash-chained log of trades on chain, which the agent can anchor its own log to.

Tests named below are in `contracts/test/HoldfastVaultV4.t.sol`, `HoldfastVaultV4.invariant.t.sol`, `HoldfastVaultV3.t.sol`, `HoldfastVault.invariant.t.sol` and `agent/test/`. Results are in `evidence/v4/`, and `evidence/v3/` where a row says version 3.

## What is protected, and what is assumed

**Protected:** the owner's tokens in the vault, and the owner's ability to get them out.

**Assumed:** the owner's key is safe, HSKSwap's router and pool do what their code says, and the chain executes correctly. The sequencer is not trusted to order fairly, or to keep a preconfirmation.

**The boundary:** everything off chain is untrusted by the vault. Each row below ends at the question of what the vault still refuses.

## Summary

| Threat | Worst case with version 4 | Largest remaining weakness |
|---|---|---|
| [Misled or malicious model](#misled-or-malicious-model) | In chat, a bad policy the owner approved. As the engine, bad timing inside the owner's model limits, then the vault's | An owner who approves without reading; an outside price that is wrong but passes its checks |
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

The model has two roles, and they are defended differently.

**In chat** (`agent/src/nl.ts`), it drafts a policy that a person approves.

- **Impact.** A harmful policy, such as larger sizes, a looser price check, or the model engine turned on.
- **Defences.** The model only yields a typed draft. Code does every unit conversion, turns a risk appetite in words into fixed numbers (`RISK_LEVELS`), and `agent/src/policy.ts` parses and bounds the result. `agent/src/policy-review.ts` writes the review the person reads, and asks for a longer confirmation for anything risky, including turning the model engine on or raising its sizes (`chat-sizing.test.ts`).
- **Measured.** 14 of 14 live requests through OpenRouter to `deepseek/deepseek-v4-pro`, including P&L and position answers checked against the facts given, a risk appetite, model sizing and autonomy (`evidence/v4/llm-live.json`, 2 November 2026). The run before it found a real bug: the model copied the current slippage back, and that overrode the risk level the user asked for. It was fixed in code and tested (`evidence/v4/llm-live-before-risk-fix.json`). No Claude model has been tested live.

**As the trading engine** (`agent/src/strategist.ts`), when the policy's `ai` rule is on, it proposes trades that no person approves one by one.

- **Impact.** The model buys or sells at a bad time, or tries to trade more, or something else, than it may.
- **Attack path.** Plain error, a provider compromise, or a market state that misleads it.
- **Defences, in order.**
  - The model sees a snapshot of numbers that code computed, with no address, key or transaction (`ai-engine.test.ts`, "no address or key"). It can only answer buy, sell or hold with a size. `parseProposal` rejects any other field, any size above the policy's, and anything malformed.
  - It is asked after a decision, in the background, on sealed blocks only. The path from a block to a trade never waits for it, and each trace still records 0 model calls on that path.
  - A proposal lives `proposalTtlBlocks` blocks and is used once. A timeout, an outage, a cut-off or malformed answer, or a refusal clears it, and no proposal means hold (`ai-engine.test.ts`, "an outage, a timeout").
  - `decide()` judges it with the same arithmetic as the rules. A trade that adds inventory must beat the outside price after the pool fee and gas, valued on the side worst for it, and stay inside `maxInventoryUsdt`. A trade that closes inventory is judged on the round trip in this pool, and may lose at most `maxUnwindLossUsdt`, zero by default. The policy's token choice, pacing, TWAP and impact checks, and the vault's caps and budgets apply as for any trade. The transaction's minimum output is set so the worst accepted fill still meets the gate.
  - The agent's breaker counts model trades as their own family, with the edge rule's hourly count and loss limit.
  - Preflight, the strategy pin and then the vault, whose limits hold whatever the agent believes.
  - A stop-loss is decided before any proposal and never waits for one. A strategist that throws does not touch it (`ai-engine.test.ts`, "does not stop a stop-loss").
  - Calls are capped by the policy (`minBlocksBetweenCalls`, `maxCallsPerDay`), only made when the signal changes, and capped in dollars by the operator (`AI_MAX_USD_PER_DAY`, default $0.50).
- **Weaknesses.** Every gate that adds inventory trusts the outside price from Gate. Its age, spread and distance from the pool are checked, but a wrong price inside those checks could show an edge that is not there, for up to `maxSizeUsdt` a trade and `maxInventoryUsdt` in all. The model can also simply wait too long, or close at the worst moment the owner's loss allowance permits. **It has never traded on a chain.** Its only live runs are on recorded mainnet data: in two windows it made one trade, the one the rules made (`evidence/v4/replay-model-*.json`). The first run found that it misread its own inventory as the vault's balance and so never sold; the prompt was fixed and that run is kept. A model can misread its input in ways no gate catches, and then it only trades less than it could.

## Prompt injection

- **Impact and path.** Text in a question or in a data feed tries to steer the model. The viewer feeds evidence into its chat context, so a poisoned evidence file reaches the model.
- **Defences.** The same as above. The model engine's snapshot holds only numbers computed by code, and the reason it gives back is cut to 300 printable characters before anyone reads it. Chat on the viewer can only answer: a policy reply is discarded and replaced with fixed text (`viewer.test.ts`, "viewer discards policy proposals"). Answers are labelled model output.
- **Weaknesses.** A model answer can still say something false to a reader. It cannot move funds.

## Stolen agent key

- **Impact.** The thief can call `execute` directly and skip every off-chain check, selling at the worst price the vault allows.
- **Attack path.** A leaked `.env`, a compromised host, or a malicious dependency in the agent process.
- **Defences.** On chain, in `execute` (`HoldfastVault.sol:269`): the token pair, a per-trade cap, hourly and daily budgets with a continuous refill, a lifetime cap, a floor, the price band, a deadline, one-time intent IDs, and expiry at most 30 days away. Version 4 adds a share-of-balance limit (`test_shareOfBalanceLimitsATradeBelowTheAbsoluteCap`, `test_aDonationCannotLiftATradeAboveTheAbsoluteCap`), a minimum time between trades per token (`test_cooldownSpacesTradesPerTokenAndAddsNoWayRound`), and a daily loss budget valued at the owner's mark, which refuses a trade whose worst allowed fill would exceed it and pauses the agent once half is used (`test_aTradeWhoseWorstFillWouldExceedTheBudgetIsRefusedBeforeAnyCall`, `test_theBreakerPersistsBecauseTheTradeThatTripsItSucceeds`, `testFuzz_theLossChargedNeverExceedsTheBudget`). The agent cannot withdraw (`testFuzz_agentNeverGainsWithdrawalPower`). A guardian can end the key in the same block without being able to take anything (`test_revokeEndsTheKeyInTheSameBlock`, `test_attack_guardianHasNoOtherPower`). A stolen key cannot use up the stop's allowance or block it by pausing (`test_attack_stolenKeySpendingItsBudgetLeavesTheStopAllowance`, `test_attack_stolenKeyPausingDoesNotBlockTheStop`).
- **Measured.** Attack set on a fork against the compiled version 4 vault: 120 of 120 contained, 0 cap violations, `evidence/v4/attack-results.json`. **The loss budget, share limit and cooldown were off in that run**, so it measures the version 3 limits inside version 4; those three are covered by the forge tests above. Rehearsal on version 4, same settings: `evidence/v4/rehearsal-fork.json`.
- **Weaknesses.** The loss budget is only as good as the owner's mark: it is a price the owner posts, not one read from the pool, so a pushed pool cannot widen it, but a mark left behind the market can. A stale mark refuses the agent, never the owner (`test_aStaleMarkRefusesTheAgentAndNotTheOwner`). Without the loss guard, the loss is real and is what the owner configured: `input × (market − floor)`, at the budget rate, until the key is ended. In the attack set, 60 HSK sold into a pushed pool lost $2.23 on one run. With no guardian and an absent owner, it continues until a limit runs out.
- **Further mitigation.** Set a guardian, run `npm run monitor` on a schedule, and keep the floor close to the market.

## Stolen owner key

- **Impact.** Total. The owner can withdraw everything.
- **Defences.** Ownership transfer needs the new owner to accept (`test_ownerHandoverNeedsTheNewOwnerToAccept`), which only stops mistakes. The owner can be a contract, so a Safe works, and the vault needs no signature support for that. Nothing here defends against a thief who holds the owner's key.
- **Considered and declined.** A withdrawal delay. It would slow the owner's escape in exactly the emergency the vault exists for, and a multisig answers the same threat without that cost.

## Pool and oracle manipulation

- **Impact.** With the agent's trades, a pushed pool lets a thief sell at a bad price up to the floor. With the stop, a pushed average could fire a sale the market did not call for.
- **Attack path.** Trade the pool to a price and hold it there, for one block against spot or for a whole window against the average.
- **Defences.** Optional guard, `setPriceGuard` (`HoldfastVault.sol:733`): every trade must leave the pool within a band of its own time-weighted average, using the price after the swap (`_requireInBand`, `:492`). It fails closed when the oracle cannot answer (`test_guardFailsClosedWhenTheOracleFails`). It is one-sided, because a sale into a pool pushed up is good for the vault (`test_guardIsOneSided`). A stop reads the average, not spot (`test_attack_spotAloneCannotFireAStop`), checks its own band after the swap (`test_attack_sandwichedStopIsRefusedByItsBand`), and never sells under its own floor (`test_attack_stopNeverSellsUnderItsOwnFloor`).
- **Measured cost of pushing the real pool** (fork, `evidence/v3/rehearsal-fork.json`, selling then buying straight back with no other trader acting): 120 ticks costs about $16, 396 about $52, 1,165 about $153 and 3,645 about $481, on a pool holding about 4.99M WHSK and 436,795 USDT.
- **Weaknesses.** **That is a low cost, and a floor on the true cost.** Holding a price for a whole window also pays arbitrageurs, which a fork with no other traders cannot measure, so we do not know the real figure. The pool's traders are thin (462 swaps in 7 days, 94% from one wallet, `evidence/market/`), so an attacker might not be arbitraged quickly. **The guard should be read as raising the cost of an attack and not as preventing it, and the floor stays the real backstop.** The band check uses the post-swap price from the pool, so a single large trade is stopped, but a slow push over many blocks moves the average with it. The guard is off until the owner turns it on, and `deploy-test-market` does not turn it on.
- **Further mitigation.** A second on-chain price source would need a second deep market to read, and we did not survey for one. A larger pool would improve this more than any code.
- **Considered and declined.** A daily loss limit priced from this pool. It would inherit this weakness. Version 4's loss budget is priced at a mark the owner posts instead, so the pool cannot move it, at the cost of the owner keeping the mark current.

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
- **Defences.** Model trades have their own ledger keys (`ai:N`), so each is counted once and its inventory apart from the rules'. A write-ahead ledger signs before sending and recovers by resending identical bytes (`e2e-fork`, "a crash before broadcast recovers"). **We reproduced a real duplicate send in a test:** a poll and a flashblock frame deciding together sent two trades. The `sending` guard and `sendEpoch` in `agent.ts` now refuse it (`safety.test.ts`, "a poll and a frame deciding together send one trade"). A breaker stops repeated failures (`breaker.ts`). `eth_call` preflight skips a doomed send and saves its gas, except on stream frames, where it would miss the latency window.
- **Weaknesses.** Nothing restarts the process. The heartbeat file lets `npm run monitor -- --agent` notice, and a person or a supervisor must act.

## Keeper failure and downtime

- **Impact.** The agent's own stop-loss does not run while it is offline.
- **Defences.** A stop on the vault that **anyone** can fire once the average crosses its trigger (`triggerStop`, `HoldfastVault.sol:293`), with `npm run keeper` to call it. The caller chooses nothing and is paid nothing, and proceeds stay in the vault (`test_anyoneCanFireATriggeredStop`). An expired or stolen key does not block it (`test_expiredKeyDoesNotBlockTheStop`).
- **Weaknesses.** **No payment means no one is obliged to call it.** The owner must run a keeper, or accept that it fires only when someone cares. A stop also fails when its sale is refused by its own floor or band, by design, so in a real crash it may sell nothing. It sells one tranche at a time, so it can lose on each.

## Accounting and limit resets

- **Impact.** A limit that resets or doubles would break every promise above.
- **Attack path.** Trade around a budget reset, trade between the owner's read and write, or change limits to refresh a budget.
- **Defences.** Continuous refill, not a fixed grid, so no double spend at a boundary (`testFuzz_dailySpendStaysInsideItsEnvelope`). Spend is kept across limit changes (`test_dailyBudgetKeepsWhatWasSpent`). `setLimitsIfRemaining` refuses if a trade happened since the owner read (`test_attack_tradeBetweenReadAndWriteCannotBePapered`). Amounts come from balances, not from the router's return value (`test_attack_feeOnTransferOutputIsMeasuredByBalance`). Stateful invariants hold across 25,600 calls each (`invariant_agentSpendStaysInsideEveryCap`, `invariant_lifetimeAccountingIsExact`, and five more).
- **How we tested the tests.** On version 4, 55 of 55 deliberate bugs in the vault were caught, `evidence/v4/mutation-check.json`. Slither 0.11.6 reports 34 findings, each triaged in `scripts/slither-check.mjs`, `evidence/v4/slither.json`; 4 were new on version 4. This is our triage, not an audit. Version 3's run, 37 of 37 and 25 findings, is in `evidence/v3/`.
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
