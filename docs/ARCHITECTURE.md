# Holdfast architecture

Holdfast trades WHSK/USDT on HSKSwap from a vault that limits what its agent key can do. This document covers what it defends against, what each layer promises, how each layer fails, what was wrong, and what was built, in what order and why.

The contract is not audited. Nothing here claims profit. The deployed testnet vault was built from the source before these changes.

Each number names its lane and sample size: **local** (no network), **fork** (anvil over a mainnet read), **mainnet read** (no transactions), **testnet** (the old deployed vault).

## Threat model

**What we protect:** the owner's tokens in the vault, and the owner's ability to get them out.

**What we assume:** the owner's key is safe, HSKSwap's router and pool contracts do what their code says, and the chain orders transactions correctly. The sequencer can reorder and can show frames that later change.

| Attacker or fault | Can do | Limited by |
|---|---|---|
| Thief with the agent key | Sign any `execute` the vault accepts, sell at the floor into a pool they pushed, burn gas, pause | Vault: expiry, hourly budget, per-trade cap, lifetime cap, floor, token pair |
| Pool manipulator, no key | Move the price to trigger a stop or a limit | Agent: confirmation, sealed blocks, TWAP guard, outside price check |
| Bad outside price | Show an edge that does not exist, or hide a real fall | Agent: age limit, gap limit; a stale outside price never holds a stop |
| Misled chat model | Propose a bad policy | Policy parser, then a review and a longer confirmation written by code, then the vault |
| Bug in the agent | Repeat trades, stop trading, send the wrong size | Ledger, breaker, then the vault |
| Crash or lost connection | Lose track of a transaction | Write-ahead ledger with recovery |
| RPC outage or rate limit | Leave the agent blind | Backoff, then holding on stale data |

**The agent can always lose money inside its limits.** A thief selling at the floor loses the owner `input × (market − floor)`. The vault limits how fast and how much, and it cannot tell a bad sale from a good one above the floor.

**Not defended:** nothing protects a position while the agent is offline, except the owner withdrawing. A price under the floor blocks stop-losses as well as thieves. Both are in [Open problems](#open-problems).

## Layers

```
 owner ──── limits, expiry, pause, withdraw ───────────────┐
 chat ─ model ─ policy parser ─ review ─ owner says yes    │
                     │                                     ▼
 data ─ reader, mark ─► decide (pure) ─► breaker ─► executor ─► vault ─► router
                                                      ledger    (the only hard limit)
```

### 1. Vault: `contracts/HoldfastVault.sol`

The only layer that holds if everything above it is compromised.

| Invariant | Enforced at | Proved by |
|---|---|---|
| The key can only swap the pair through the router, back into the vault | `HoldfastVault.sol:165` | Forge, attack set |
| An expired or replaced key can do nothing, including pause | `HoldfastVault.sol:165`, `:242` | Forge, attack set |
| Expiry is at most 30 days away | `HoldfastVault.sol:259` | Forge |
| Spend over any T seconds ≤ budget × (1 + T/3600), unless the owner raises the budget | `HoldfastVault.sol:184`, `:206` | Forge fuzz |
| Spend ≤ per-trade cap and lifetime cap | `HoldfastVault.sol:184` | Forge, attack set |
| Changing a limit never adds a second budget: what was spent in the last hour stays spent, and only a raise adds room | `HoldfastVault.sol:267` | Forge |
| A failed trade spends nothing | Revert | Forge |
| An intent runs once | `HoldfastVault.sol:165` | Forge, attack set |
| The owner can withdraw at any time, with any agent state | Owner functions take no agent state | Forge |

**Failure modes.** A floor left behind the market widens the loss a thief can take, and `hourlyLossBound` (`decide.ts:173`) reports this. An expired key stops trading, stop-losses included, which is the point of failing closed; `npm run admin -- renew` renews it. The hourly budget can delay a stop too, as tranches then wait for refill.

### 2. Decision: `agent/src/decide.ts`

A pure function from market, policy and state to one trade or one reason to hold. It has no I/O, so every rule is unit tested. It never overrides the vault, and it holds rather than send a transaction it knows will revert.

| Invariant | Where |
|---|---|
| A key that has expired holds | `decide.ts:110` |
| A stop never fires on an unsealed frame | `decide.ts:249` |
| A stop is never held by a stale or missing outside price | `decide.ts:258` |
| An outside dispute holds a stop for at most 30 blocks | `decide.ts:18`, `:258` |
| A limit's price binds `minOut`, not just the decision | `decide.ts:267` |
| Market orders and the edge refuse a pool far from its TWAP | Same file; stops are exempt, because a real crash looks the same |
| One edge fill per gap, up to one trade's worth of inventory | `decide.ts:323`, `:327` |
| A stop under the floor says so, instead of sending a doomed transaction | `decide.ts:289` |

### 3. Execution: `agent/src/executor.ts`, `ledger.ts`, `breaker.ts`

Every send goes through a ledger written before anything leaves the machine.

| Invariant | Where |
|---|---|
| A stuck transaction cannot block the agent for ever: past its deadline plus 30 s, with the vault's `usedIntent` false, it expires | `executor.ts:24`, `:196` |
| A transaction that ran but has no receipt never expires, because that would repeat a fill | `executor.ts:196` |
| Recovery resends the same signed bytes, and never signs anything new | `executor.ts:234` |
| An expired intent gives up its nonce | `ledger.ts:66` |
| Three failures in a row latch the breaker on limits, market orders and the edge, until the owner resets it | `breaker.ts:26` |
| A stop is never latched off: it backs off, up to 64 blocks | `breaker.ts:26` |
| The edge has hourly trade and loss caps | `breaker.ts:26` |

### 4. Data: `agent/src/reader.ts`, `mark.ts`, `rpc.ts`

| Invariant | Where |
|---|---|
| All market values come from one atomic read at one block, or the read is rejected | `reader.ts` |
| A 429 pauses reads for as long as `Retry-After` says, up to 60 s, and for up to 16 s by our own backoff with no header | `rpc.ts:112` |
| Transaction sends are not held by a read pause | `rpc.ts` |
| Overdue polls are dropped, not sent in a burst | `agent.ts:147` |
| A trade drops the warm state, so the next decision sees the vault's new limits | `agent.ts:311` |

**Failure mode, on purpose:** during a pause the agent is blind. Holding on stale data is safer than trading on it, but a stop cannot fire then.

### 5. Model interface: `agent/src/nl.ts`, `policy-review.ts`, `main.ts`

The model never touches the trading loop. It can only propose a policy. `decide` is pure, so a prompt cannot reach it except through a policy the owner approved. The facts it reads are computed numbers and internal strings, so market data carries no text into the prompt.

| Invariant | Where |
|---|---|
| A malformed draft changes nothing | `nl.ts`, `policy.ts` |
| The approval text comes from code, in tokens, never from the model's words | `policy-review.ts:24` |
| A risky change needs "yes, I accept the risks", not "yes" | `main.ts:66` |
| Whatever is approved, the vault still limits it | Layer 1 |

**Limit:** a person can still approve a bad change. The review makes it harder to do by accident.

## What was built, in order

Ranked by the loss each fix bounds and by what later work depends on.

| # | Fix | Why this rank | Before → after | Lane, n |
|---|---|---|---|---|
| 1 | Key expiry and hourly budget | The only limit that holds if the agent is compromised. Comes first because it changes the contract, and everything else assumes it | Stolen key, sold into a pool pushed to the floor: 60 HSK sold, $2.23 lost → 20 HSK sold, $0.74 lost, with the budget at a third of the cap. Time the key works: no end → at most 30 days. **Cost: gas above a plain swap 25,097 → 28,375 (+13%), deploy 1,368,813 → 1,707,771 (+25%)** | Fork. Loss: one run per arm. Attack set: 120/120 contained, 120/120 benign completed. Gas: median of 20 rounds |
| 2 | One fill per gap, inventory limit, breaker | The confirmed way the running agent could lose real money: repeat fills with no closing leg | At $15: 53 → 11 → 1 fills, $795 → $165 → $15 held. At $150: 153 → 8 → 1, $22,950 → $1,200 → $150 | Mainnet read replay, 992 samples, simulated, no outside fee |
| 3 | Stuck transaction, nonce gap, failed send, recovery throw | A wedged agent blocks stops as well as trades, so it outranks the price guards. Found by this review | Dropped transaction: blocked every trade for ever → free 30 s past its deadline. 17 fault tests pass, covering crash at reserved, signed and broadcast against fill, revert, unknown, refused and never landed | Local, fake node |
| 4 | Stop against floor, stop guards, limit price, outside price guards | Wrong trades on bad data, with the worst one a stop sold on a frame that never sealed | One false frame fired a stop at confirm=1 → held. Limit could fill up to 50 bps past its price → exact. 0 of 992 samples refused by the gap guard. Mark age limit 30 s → 5 s refuses 0 → 31 of 992 (3.1%) | Local tests; mainnet read replay, 992 samples |
| 5 | Rate limit handling, overdue polls, warm state | Costs availability rather than funds | Requests during a 10 s limit 38 → 4. **Recovery is slower with no header: 10.1 → 16.9 s** | Local simulation, one run per arm |
| 6 | Chat review, offline harness | The vault and parser already limit it, so it adds the least | Approval text: raw base units and a plain yes → tokens, risks, and a longer yes for risky changes. 12 of 12 harmful drafts flagged and 11 of 11 malformed replies refused. We wrote the cases ourselves | Local, scripted replies, **no model ran** |

## The 20 items, corrected

| # | Claim in the list | What the code and evidence say | Decision |
|---|---|---|---|
| 1 | Loss inside limits: 59.99 of 60 HSK "drained" | **Wrong word.** The attack set measured tokens that left the vault in one case, and the USDT they bought came back. Real loss is input × (market − floor), about $2.24 for 60 HSK at floor 0.05 and market 0.0874. Measured with the agent key and a pool pushed to 1% above the floor: 60 HSK worth $5.26 sold for $3.02, a loss of $2.23 against a bound of $2.26, on a fork, one run. The attacker's own costs are not counted | Measured; reported live as `worstCaseLossPerHourUsdt` |
| 2 | No loss-rate limit | True; only a lifetime cap existed | Built, merged with 4 |
| 3 | Key blast radius | True; a stolen key worked for ever | Built |
| 4 | No slow-drain limit | Same as 2 | Built with 2 |
| 5 | Fixed permissions | The key can only `execute` and `pause`. Nothing to fix; an expired key can no longer pause | Dropped |
| 6 | Memory attacks | `decide` is pure and has no memory. The real surface is the chat layer proposing a policy | Reframed into 7 |
| 7 | Prompt attacks, no live test | The approval showed raw base units, which was bad. Live test not possible: no API key, and we will not ask anyone to spend | Review built; offline harness only |
| 8 | Bad price data | True: 30 s mark age, no second check, no TWAP guard on market orders. Evidence: pool against Gate P50 18, P99 55, max 64 bps. Mark age P50 567 ms, max 28.9 s | Built. **Unproven against a real attack:** the pool's spot did not move in those 992 samples |
| 9 | False trigger on an unsealed frame | **Half wrong, and worse than stated elsewhere.** A false high price mostly reverts, costing gas. A false *low* price fires a stop that **fills**, since the real output clears `minOut`. The old claim "one unsealed frame cannot fire a stop" was false at `stopConfirm=1` | Built, with a test for each case |
| 10 | Repeated trades | True: the key was `edge:${head.number}`, so one gap could fill every block. Same-block repeats would also throw | Built |
| 11 | Wrong-state recovery | **Worse than stated.** Four bugs: a dropped transaction wedged the agent for ever, stops included; a nonce gap followed; a failed send was never retried without a restart; a recovery error killed start-up | Built, with fault matrix |
| 12 | Network tail | Two endpoints: P90 96.6 against 99.9 and 168.0 ms, n=100, one run. Too little to act on | No build |
| 13 | Send window | The stream sends about 20 ms after a frame | No build |
| 14 | Stale vault limits on the fast path | True, but costs one revert, about $0.006. Window about one poll | Built, small |
| 15 | Gas | Gas above a plain swap went up, 25,097 → 28,375, fork, median of 20 rounds. Expiry and the budget cost 3,278 gas per swap, and we accept that. The 17,100 extra for the first swap per bitmap word was not re-measured | Reported |
| 16 | RPC load and 429 | True: no `Retry-After`, in-line retries at 250 and 500 ms, and a burst of overdue polls after a stall | Built |
| 17 | Weak edge | True: 0 opportunities at a 20 bps outside fee, mainnet read, 43 minutes | No build, no profit claim |
| 18 | Close risk | True: no exchange code exists, so edge trades stay open | Inventory limit built; closing leg not built |
| 19 | Ignored flow | 94% one wallet, 2.8 swaps per hour, moves P50 1.35 bps, max 13.56 bps. A run of about 27 swaps moves about 36 bps, under a 60 bps round trip. This is an estimate from aggregates, not a backtest | No build |
| 20 | Fixed sizes | Sizing cannot help while the edge is 0 | No build |

**Missed by the list:**

- **The floor blocks a stop in a crash.** On chain, a crash and a manipulation look the same, so we kept the floor and rejected a two-tier floor and an on-chain TWAP (thin pool, gas cost). The agent now raises `stop-blocked` with an alert, and a stop that could hit this needs the longer confirmation.
- **Nothing protects a position while the agent is offline.** Not fixed.
- The four recovery bugs in item 11.
- A limit could fill up to 50 bps past its price. Fixed.

## Independent review of the contract

A separate agent reviewed the contract diff and wrote throwaway tests against a mock router. This is not an audit, and it does not show the contract is safe.

| Finding | Severity | Outcome |
|---|---|---|
| `setLimits` refilled the bucket, so a key could front-run the owner tightening a limit: 200 spent at T=0 against a budget of 100 | Medium, proved | **Fixed**, with four tests. Lowering and then raising the budget adds the raise, since that is the owner's decision |
| `setLimits` sets `remaining` as an absolute value, so a trade landing between the owner's read and write can exceed what they meant to approve | Medium, proved. Older than this change | **Not fixed.** Changing the signature would touch every caller at the deadline. Pause before changing limits |
| `Traded` reports `amountIn` on a partial pull, while both counters charge the full amount | Low, proved. Older than this change | Not fixed. It errs in the owner's favour, but overstates spend to readers of the event |
| The owner cannot expire a key at once: revoking needs a replacement and a future expiry | Info | Not fixed. `pause` covers the emergency |
| A live key can pause again after each unpause, blocking trading | Design limit | Not fixed. Replace the key |
| Nothing requires the two floors to multiply to at least 1, so a key can churn A→B→A at a loss each cycle | Design limit | Not fixed. Only the caps limit it. Set floors with this in mind |

It found nothing in truncating casts, refill overflow, bricking through `setLimits`, floor rounding in either direction, state kept after a revert, expired-key behaviour, the TTL boundary, intent replay or reentrancy.

## Open problems

| Problem | Why open |
|---|---|
| No keeper for stops while the agent is offline | Needs another always-on service and key |
| A stop can be blocked by the floor in a crash | Needs a price the vault can trust, which this thin pool cannot give |
| No closing leg for edge trades | No exchange code; would need exchange keys |
| One outside price source | A second venue would only help after a real disagreement is seen |
| A replaced-underpriced transaction only clears at its deadline | No fee-bump cancel |
| No live model test | No API key |
| Testnet may not meet the mainnet rule | The user cannot fund mainnet |

## Sources

Read in full or in the relevant part:

- [Safe AllowanceModule](https://raw.githubusercontent.com/safe-global/safe-modules/main/modules/allowances/contracts/AllowanceModule.sol): resets on a fixed grid, which allows twice the allowance around a reset. Reason for a continuous refill.
- [Zodiac Roles allowances](https://docs.roles.gnosisguild.org/general/allowances): refill, period and cap in one stored allowance.
- [EIP-4337](https://eips.ethereum.org/EIPS/eip-4337): 6-byte `validUntil`, with 0 meaning no limit. [Smart Sessions TimeFramePolicy](https://raw.githubusercontent.com/erc7579/smartsessions/main/contracts/external/policies/TimeFramePolicy.sol) does the same. We have no "never" value and a 30-day maximum, so forgetting fails closed.
- [Base flashblocks specification](https://docs.base.org/specifications/flashblocks.md): says applications should have fallback logic for critical operations. This is Base's, not HSK's.
- [SEC Release 34-70694, Knight Capital](https://www.sec.gov/litigation/admin/2013/34-70694.pdf): 4 million executions in about 45 minutes and a $460M loss, with no pre-set capital limits tied to automated controls. Reason for the breaker.
- [Google SRE, Handling Overload](https://sre.google/sre-book/handling-overload/): client-side throttling and retry budgets.
- [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585): 429 and `Retry-After`.
- [Greshake et al., arXiv 2302.12173](https://arxiv.org/abs/2302.12173): indirect prompt injection. Reason the model only proposes.
- [Liquity price oracles](https://www.liquity.org/blog/price-oracles-in-liquity): rules for choosing between two price sources.

## Reproduce

```sh
npm run typecheck
npm run test:agent:local
npm run test:contracts
npm run e2e:fork
npm run attack-set
npm run bench:gas
npm run replay:edge
npm run bench:limit -- --run rate-limit
```

Evidence is in `evidence/hardening/`, `evidence/attack-results.json` and `evidence/gas-compare.json`.
