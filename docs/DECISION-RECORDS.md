# Decision records and how to check them

Enough to write your own verifier. `agent/src/cli/verify-history.ts` is one implementation. It imports only viem and node, and none of the agent's code.

## What this can and cannot prove

| It can show | It cannot show |
| --- | --- |
| Every trade, stop and anchor the vault counted is present, in order (version 4 only) | That the decision was wise |
| What left and arrived, from the tokens' own Transfer logs | That a mark or a model's reasoning was right |
| A record was not changed after its transaction was signed | That a record was honest when written, beyond the checks below |
| The block hash and pool tick the record claims match the chain at that block | Anything about market data other than that block and tick |
| A local log was not rewritten up to its newest on-chain commitment | Anything about log records after that commitment |

A hash of an invented market is still invented. That is why the verifier reads the pool again at the record's block, not only the hash.

## Three commitments

**The vault's log (version 4).** `logHead` is a `bytes24` and `logCount` a `uint64`, kept in one storage slot.

```
seed = bytes24(keccak256(abi.encode("holdfast.log.v1", chainid, vault)))
head = bytes24(keccak256(abi.encode(head, count, kind, id, token, amountIn, amountOut, block.timestamp)))
```

`count` is the entry's number, starting at 1. Events are taken in (block, logIndex) order.

| Kind | Event | id | token | amountIn | amountOut |
| --- | --- | --- | --- | --- | --- |
| 1 trade | `Traded` | intent ID | token sold | what really left the vault | what really arrived |
| 2 stop | `StopFired` | zero | token sold | what really left the vault | what really arrived |
| 3 anchor | `LogAnchored` | local log head | zero | local log length | 0 |

**The transaction.** The vault ignores bytes after `execute`'s arguments. The agent appends the 32-byte decision hash there, so the hash sits in the signed calldata without costing a storage write.

**The local log.** `decisions.jsonl` holds one JSON object per tick, holds included. For record `seq`, `hash = keccak256("{seq}|{prev}|{body}")`, where `body` is the object's JSON without `seq`, `prev` and `hash`. The first `prev` is the zero hash. A log's "head at n" is the hash of record n-1, and at 0 it is the zero hash.

Anyone holding the file can rebuild those links. Each trade's record names the head at that moment, and `anchorLog` commits a head on chain. Only those can't be rebuilt.

## The record

Version 3 is one JSON object with its keys sorted at every level, no spaces, integers as decimal strings, and no undefined values. There is one allowed spelling, and the verifier refuses any other.

```
decisionHash = keccak256("holdfast.decision.v3\n" + body)
```

| Field | Means |
| --- | --- |
| `v` | 3 |
| `chainId`, `vault`, `intentId`, `agent` | What this record may be matched to |
| `tokenIn`, `amountIn`, `minOut`, `expiresAt` | The intent, exactly as sent |
| `quotedOut`, `ledger`, `mark` | What it expected and what it was valued against |
| `block`, `blockHash`, `blockTime`, `tick`, `twapTick`, `liquidity`, `spotPriceX18`, `marketSource`, `readMode` | The market it saw. `readMode` of `stream` means a flashblock frame, which a sealed block can differ from |
| `policyVersion`, `strategyHash` | The policy. `strategyHash` is `keccak256` of the policy's canonical JSON, which the owner can pin |
| `riskCommitment` | Hash of the vault limits it believed. A commitment to its view, not proof the view was right |
| `preflight` | The vault's answer before sending, or null. Frame trades skip it |
| `prevDecisionHash` | The decision signed before this one, executed or not |
| `logHead`, `logSeq` | The local log at this moment |
| `trigger`, `orderId`, `reason` | Why |

Records from before version 3 hash their bytes with no domain and stay checkable by `npm run audit`, but they don't name their vault or intent, so they can't reach PASS.

## Running it

```bash
npm run -s export:records -- data/testnet records.jsonl
```

```bash
npm run -s verify:history -- --rpc https://testnet.hsk.xyz --vault 0x... --from-block 123 --records records.jsonl --log data/testnet/decisions.jsonl --out report.json
```

Everything is read at one pinned block (`--to-block`, or the head when it starts). Exit code 0 is PASS, 1 is FAIL and 2 is INCOMPLETE. A run that could not start also exits 2. The node must serve historic state, or the checks that need it say so.

## The answers

**PASS** means every check below ran and agreed.

**FAIL** means the evidence contradicts itself.

| Code | What it found |
| --- | --- |
| `LOG_HEAD_MISMATCH` | The events do not recompute to the vault's head: changed or reordered |
| `MORE_EVENTS_THAN_LOG` | More events than the vault counted |
| `EVENT_FROM_FAILED_TX` | An event attributed to a reverted transaction |
| `NOT_SENT_BY_AGENT` | The sender was not the agent at that block |
| `CALLDATA_UNREADABLE`, `CALLDATA_DISAGREES` | The call is not `execute`, or names another intent or token |
| `SPENT_OVER_ASKED`, `OUTPUT_UNDER_MINIMUM`, `AFTER_DEADLINE` | The trade broke its own terms |
| `SETTLEMENT_IN_DIFFERS`, `SETTLEMENT_OUT_DIFFERS` | The token transfers disagree with the event |
| `DECISION_HASH_REUSED` | One decision used for two trades |
| `RECORD_ALTERED`, `RECORD_UNREADABLE`, `RECORD_CONFLICT`, `NOT_CANONICAL` | The record is not what was committed, or not in its one spelling |
| `RECORD_DISAGREES` | The record hashes correctly but describes another trade |
| `STRATEGY_NOT_PINNED` | The trade ran a strategy other than the one pinned at that block |
| `DECIDED_AFTER_EXECUTION` | The record names a block later than its trade |
| `MARKET_BLOCK_DIFFERS`, `MARKET_TICK_DIFFERS` | A sealed read does not match the chain at that block |
| `REORDERED` | The chain of earlier decisions does not reach the trade before it |
| `CLAIMED_TRADE_NOT_ON_CHAIN`, `WRONG_TX_FOR_RECORD`, `RECORD_DENIES_TRADE`, `RECORD_OVERSTATES_OUTPUT` | The records misstate what happened |
| `LOG_SEQUENCE_BREAK`, `LOG_LINK_BREAK`, `LOG_ALTERED`, `LOG_REWRITTEN` | The local log was changed |

**INCOMPLETE** means something needed is missing. It is never reported as success.

| Code | What is missing |
| --- | --- |
| `NOTHING_TO_VERIFY` | No history at all, which is not a clean history |
| `NO_ONCHAIN_LOG` | A vault before version 4, where an omitted trade could not be noticed |
| `EVENTS_MISSING` | Fewer events than the vault counted: a late `--from-block`, or the node left some out |
| `NODE_UNAVAILABLE`, `TX_UNAVAILABLE`, `BLOCK_UNAVAILABLE`, `AGENT_UNKNOWN`, `PIN_UNKNOWN`, `MARKET_NOT_CHECKABLE` | The node would not answer |
| `RECORDS_NOT_SUPPLIED`, `RECORD_MISSING`, `LOCAL_LOG_NOT_SUPPLIED` | Files not given, or a record not published |
| `NO_DECISION_HASH`, `CALLED_INDIRECTLY` | The transaction carries no readable commitment |
| `OLD_RECORD_FORMAT`, `ORDER_NOT_CHECKABLE` | A record too old to tie down, or an earlier decision nobody published |
| `LOG_SHORTER_THAN_COMMITTED`, `UNANCHORED_TAIL`, `LOG_TORN_LINE`, `LOG_UNCHAINED_LINE` | Log records the chain has no commitment for, or a chain commitment the log can't meet |

A `MARKET_*` difference on a `stream` record is INCOMPLETE instead of FAIL, because a frame really can differ from the sealed block. So fabrication in a stream record can't reach PASS, but it isn't called a lie either.

A claimed trade missing from events known to be partial is INCOMPLETE. Only a whole set of events can contradict a claim.

## Limits

- **The newest records are usually unanchored.** A running agent appends every tick, so its log normally ends in `UNANCHORED_TAIL`. Anchoring pays gas and is off unless `ANCHOR_INTERVAL_SEC` is set. Trades are unaffected, because they commit to the log directly and the vault counts them.
- **Publishing can be withheld.** An agent that publishes no records gets INCOMPLETE, not FAIL. The verifier can't force publication, and it doesn't pretend to.
- **The node is trusted for what it returns.** A dishonest node can hide events (which shows as `EVENTS_MISSING` on version 4) or lie outright. Run it against a node you trust, or against two.
- **Only the tick is checked.** `mark`, `liquidity`, `quotedOut` and `riskCommitment` are commitments the verifier doesn't re-derive.
