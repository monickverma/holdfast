// The verifier against each way history can be wrong. Offline: the evidence is built here, and the agent's own record
// code writes the records, so a difference between the two implementations fails here too. e2e-testmarket runs it against
// a real vault on a local chain.
import assert from "node:assert/strict";
import { test } from "node:test";
import { concatHex, encodeFunctionData, keccak256, parseAbi, stringToHex, type Address, type Hex } from "viem";
import { ChainedLog, readLog } from "../src/audit-log.js";
import { canonical, judge, logSeed, nextHead, recordHash, type ChainEntry, type Evidence, type PublishedRecord, type TradeTx } from "../src/cli/verify-history.js";
import { decisionHashOf, decisionRecord } from "../src/executor.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VAULT: Address = "0x1111111111111111111111111111111111111111";
const AGENT: Address = "0x2222222222222222222222222222222222222222";
const TOKEN_A: Address = "0x3333333333333333333333333333333333333333";
const TOKEN_B: Address = "0x4444444444444444444444444444444444444444";
const ROUTER: Address = "0x5555555555555555555555555555555555555555";
const POOL: Address = "0x6666666666666666666666666666666666666666";
const STRATEGY: Hex = keccak256(stringToHex("a policy"));
const ABI = parseAbi(["function execute(address tokenIn, uint256 amountIn, uint256 minOut, uint256 deadline, bytes32 intentId) returns (uint256 amountOut)"]);
const ZERO32: Hex = `0x${"0".repeat(64)}`;
const blockHashOf = (n: number): Hex => keccak256(stringToHex(`block ${n}`));

interface Built { evidence: Evidence; intents: Hex[]; hashes: Hex[]; logText: string }

/** A clean history of `count` trades, then an anchor over the whole local log. Every test below breaks one thing. */
function history(count = 2): Built {
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  const path = join(dir, "decisions.jsonl");
  const log = new ChainedLog(path);
  const records: PublishedRecord[] = [];
  const entries: ChainEntry[] = [];
  const txs: Record<string, TradeTx> = {};
  const market: Evidence["market"] = {};
  const intents: Hex[] = [];
  const hashes: Hex[] = [];
  let prev: Hex | null = null;
  for (let i = 0; i < count; i++) {
    const block = 100 + i * 10;
    const decisionAt = block - 1;
    const intentId = keccak256(stringToHex(`intent ${i}`));
    log.append({ wallTime: "t", note: `hold before trade ${i}` });
    const body = decisionRecord(
      { action: "trade", trigger: "order", orderId: `o${i}`, tokenIn: TOKEN_A, amountIn: 1_000n, minOut: 900n, quotedOut: 950n, reason: "a test", ledger: {} } as never,
      { head: { number: BigInt(decisionAt), hash: blockHashOf(decisionAt), timestamp: 5_000n + BigInt(i), baseFeePerGas: 1n }, spotPriceX18: 1n, tick: -7, twapTick: -7, liquidity: 9n } as never,
      { policyVersion: 1, mark: null, decidedAtMs: 0, logHead: log.head, logSeq: log.seq, strategyHash: STRATEGY, marketSource: POOL, readMode: "poll", preflight: null, chainId: 133, vault: VAULT, expiresAt: 6_000n, prevDecisionHash: prev, intentId, agent: AGENT },
    );
    const decisionHash = decisionHashOf(body);
    const txHash = keccak256(stringToHex(`tx ${i}`));
    const input = concatHex([encodeFunctionData({ abi: ABI, functionName: "execute", args: [TOKEN_A, 1_000n, 900n, 6_000n, intentId] }), decisionHash]);
    txs[txHash] = { from: AGENT, to: VAULT, input, success: true, agentAtBlock: AGENT, pinAtBlock: ZERO32, transfers: [
      { token: TOKEN_A, from: VAULT, to: ROUTER, value: 1_000n },
      { token: TOKEN_B, from: ROUTER, to: VAULT, value: 950n },
    ] };
    entries.push({ kind: "trade", blockNumber: BigInt(block), logIndex: 3, txHash, blockTime: 5_100n + BigInt(i), id: intentId, token: TOKEN_A, amountIn: 1_000n, amountOut: 950n });
    records.push({ decisionHash, body, status: "included", txHash, amountOut: "950" });
    market[String(decisionAt)] = { blockHash: blockHashOf(decisionAt), tick: -7 };
    intents.push(intentId);
    hashes.push(decisionHash);
    prev = decisionHash;
  }
  log.append({ wallTime: "t", note: "a hold after the trades" });
  entries.push({ kind: "anchor", blockNumber: 500n, logIndex: 0, txHash: keccak256(stringToHex("anchor")), blockTime: 6_100n, id: log.head, token: `0x${"0".repeat(40)}`, amountIn: BigInt(log.seq), amountOut: 0n });
  const logText = readLog(path);
  rmSync(dir, { recursive: true, force: true });
  const evidence: Evidence = { chainId: 133, vault: VAULT, tokenA: TOKEN_A, tokenB: TOKEN_B, version: 4n, logHead: null, logCount: null, entries, txs, records, localLog: logText, market, unavailable: [] };
  sealHead(evidence);
  return { evidence, intents, hashes, logText };
}

/** What the vault itself would hold after these entries. */
function sealHead(evidence: Evidence): void {
  let head = logSeed(evidence.chainId, evidence.vault);
  let count = 0n;
  for (const entry of evidence.entries) {
    count++;
    head = nextHead(head, count, entry, entry.blockTime!);
  }
  evidence.logHead = head;
  evidence.logCount = count;
}

const codes = (evidence: Evidence) => judge(evidence).findings.map((f) => f.code);
function expects(evidence: Evidence, status: string, code: string): void {
  const verdict = judge(evidence);
  assert.equal(verdict.status, status, JSON.stringify(verdict.findings));
  assert.ok(verdict.findings.some((f) => f.code === code), `${code} not in ${JSON.stringify(verdict.findings.map((f) => f.code))}`);
}
const editBody = (record: PublishedRecord, edit: (body: Record<string, unknown>) => void) => {
  const body = JSON.parse(record.body) as Record<string, unknown>;
  edit(body);
  record.body = canonical(body);
  record.decisionHash = recordHash(record.body, 3);
};
const trades = (evidence: Evidence) => evidence.entries.filter((e) => e.kind === "trade");

test("a whole, consistent history passes, and says what it checked", () => {
  const { evidence } = history();
  const verdict = judge(evidence);
  assert.deepEqual(verdict.findings, []);
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.checked.trades, 2);
  assert.equal(verdict.checked.tradesMatched, 2);
  assert.equal(verdict.checked.anchors, 1);
  assert.equal(verdict.checked.localLogRecords, 3);
  assert.equal(verdict.checked.localLogAnchoredThrough, 3);
});

// Nothing there is not the same as nothing wrong

test("no history at all is never a pass", () => {
  const { evidence } = history();
  evidence.entries = [];
  evidence.logCount = 0n;
  evidence.logHead = logSeed(133, VAULT);
  evidence.records = [];
  evidence.localLog = "";
  expects(evidence, "INCOMPLETE", "NOTHING_TO_VERIFY");
});

test("a wrong starting block, or a node that hides events, is not a pass", () => {
  const { evidence } = history();
  evidence.entries = evidence.entries.slice(1);
  expects(evidence, "INCOMPLETE", "EVENTS_MISSING");
  evidence.entries = [];
  expects(evidence, "INCOMPLETE", "EVENTS_MISSING");
});

test("records or a log not supplied leave it incomplete", () => {
  let { evidence } = history();
  evidence.records = null;
  expects(evidence, "INCOMPLETE", "RECORDS_NOT_SUPPLIED");
  ({ evidence } = history());
  evidence.localLog = null;
  expects(evidence, "INCOMPLETE", "LOCAL_LOG_NOT_SUPPLIED");
});

test("a read the node refused is stated", () => {
  const { evidence } = history();
  evidence.unavailable.push("Events for blocks 1 to 2 could not be read.");
  expects(evidence, "INCOMPLETE", "NODE_UNAVAILABLE");
});

test("a transaction the node will not give leaves that trade unverified", () => {
  const { evidence } = history();
  evidence.txs[trades(evidence)[0]!.txHash] = null as never;
  expects(evidence, "INCOMPLETE", "TX_UNAVAILABLE");
});

test("a block the node will not give stops the head being recomputed", () => {
  const { evidence } = history();
  evidence.entries[0]!.blockTime = null;
  expects(evidence, "INCOMPLETE", "BLOCK_UNAVAILABLE");
});

test("a vault with no on-chain log cannot pass, since an omission could not show", () => {
  const { evidence } = history();
  evidence.version = 3n;
  evidence.logHead = null;
  evidence.logCount = null;
  expects(evidence, "INCOMPLETE", "NO_ONCHAIN_LOG");
});

test("a historic read the node cannot do is stated", () => {
  const { evidence } = history();
  evidence.txs[trades(evidence)[0]!.txHash]!.agentAtBlock = null;
  expects(evidence, "INCOMPLETE", "AGENT_UNKNOWN");
  evidence.txs[trades(evidence)[0]!.txHash]!.agentAtBlock = AGENT;
  evidence.txs[trades(evidence)[0]!.txHash]!.pinAtBlock = null;
  expects(evidence, "INCOMPLETE", "PIN_UNKNOWN");
});

// The vault's log

test("a changed event breaks the head", () => {
  const { evidence } = history();
  evidence.entries[0]!.amountOut = 951n;
  const verdict = judge(evidence);
  assert.equal(verdict.status, "FAIL");
  assert.ok(verdict.findings.some((f) => f.code === "LOG_HEAD_MISMATCH"));
});

test("reordered events break the head", () => {
  const { evidence } = history();
  const [first, second] = trades(evidence);
  [first!.blockNumber, second!.blockNumber] = [second!.blockNumber, first!.blockNumber];
  expects(evidence, "FAIL", "LOG_HEAD_MISMATCH");
});

test("an event invented on top fails", () => {
  const { evidence } = history();
  evidence.entries.push({ ...evidence.entries[0]!, logIndex: 9, id: keccak256(stringToHex("invented")) });
  expects(evidence, "FAIL", "MORE_EVENTS_THAN_LOG");
});

test("a head bound to another vault or chain does not carry over", () => {
  assert.notEqual(logSeed(133, VAULT), logSeed(177, VAULT));
  assert.notEqual(logSeed(133, VAULT), logSeed(133, AGENT));
});

// Tying a trade to its decision

test("an edited record fails", () => {
  const { evidence } = history();
  evidence.records![0]!.body = evidence.records![0]!.body.replace('"a test"', '"a better story"');
  expects(evidence, "FAIL", "RECORD_ALTERED");
});

test("a record missing for a trade leaves it incomplete", () => {
  const { evidence } = history();
  evidence.records!.shift();
  expects(evidence, "INCOMPLETE", "RECORD_MISSING");
});

test("a trade with no hash, or the zero hash, is not tied to anything", () => {
  let { evidence } = history();
  const tx = evidence.txs[trades(evidence)[0]!.txHash]!;
  tx.input = tx.input.slice(0, -64) as Hex;
  assert.ok(codes(evidence).includes("NO_DECISION_HASH"));
  assert.notEqual(judge(evidence).status, "PASS");
  ({ evidence } = history());
  const zero = evidence.txs[trades(evidence)[0]!.txHash]!;
  zero.input = `${zero.input.slice(0, -64)}${"0".repeat(64)}` as Hex;
  assert.ok(codes(evidence).includes("NO_DECISION_HASH"));
  assert.notEqual(judge(evidence).status, "PASS");
});

test("one decision hash used for two trades fails", () => {
  const { evidence } = history();
  const [first, second] = trades(evidence);
  const a = evidence.txs[first!.txHash]!;
  const b = evidence.txs[second!.txHash]!;
  b.input = `${b.input.slice(0, -64)}${a.input.slice(-64)}` as Hex;
  expects(evidence, "FAIL", "DECISION_HASH_REUSED");
});

test("a record that hashes correctly but describes another trade fails", () => {
  for (const [field, value] of [["vault", AGENT], ["chainId", 177], ["agent", VAULT], ["tokenIn", TOKEN_B], ["amountIn", "2000"], ["minOut", "1"], ["expiresAt", "7000"]] as const) {
    const { evidence, hashes } = history(1);
    const record = evidence.records![0]!;
    editBody(record, (body) => { body[field] = value; });
    const tx = evidence.txs[trades(evidence)[0]!.txHash]!;
    tx.input = `${tx.input.slice(0, -64)}${record.decisionHash.slice(2)}` as Hex;
    assert.notEqual(record.decisionHash, hashes[0]);
    const verdict = judge(evidence);
    assert.equal(verdict.status, "FAIL", field);
    assert.ok(verdict.findings.some((f) => f.code === "RECORD_DISAGREES" && f.detail.includes(field)), `${field}: ${JSON.stringify(verdict.findings)}`);
  }
});

test("a record swapped between two trades fails", () => {
  const { evidence } = history();
  const [first, second] = trades(evidence);
  const a = evidence.txs[first!.txHash]!;
  const b = evidence.txs[second!.txHash]!;
  const [hashA, hashB] = [a.input.slice(-64), b.input.slice(-64)];
  a.input = `${a.input.slice(0, -64)}${hashB}` as Hex;
  b.input = `${b.input.slice(0, -64)}${hashA}` as Hex;
  assert.equal(judge(evidence).status, "FAIL");
});

test("a record naming the wrong transaction fails", () => {
  const { evidence } = history();
  const [one, two] = evidence.records!;
  [one!.txHash, two!.txHash] = [two!.txHash!, one!.txHash!];
  expects(evidence, "FAIL", "WRONG_TX_FOR_RECORD");
});

test("trades put in a different order than their records say fails", () => {
  const { evidence } = history(3);
  const [, second, third] = evidence.records!;
  const body = JSON.parse(third!.body) as Record<string, unknown>;
  // The third names the first as the one before it, skipping the second.
  editBody(third!, (b) => { b.prevDecisionHash = (JSON.parse(second!.body) as { prevDecisionHash: Hex }).prevDecisionHash; });
  assert.notEqual(body.prevDecisionHash, (JSON.parse(third!.body) as { prevDecisionHash: Hex }).prevDecisionHash);
  const tx = evidence.txs[third!.txHash!]!;
  tx.input = `${tx.input.slice(0, -64)}${third!.decisionHash.slice(2)}` as Hex;
  expects(evidence, "FAIL", "REORDERED");
});

test("an earlier decision no record shows cannot be walked through", () => {
  const { evidence } = history(3);
  const [, , third] = evidence.records!;
  editBody(third!, (b) => { b.prevDecisionHash = keccak256(stringToHex("a decision nobody published")); });
  const tx = evidence.txs[third!.txHash!]!;
  tx.input = `${tx.input.slice(0, -64)}${third!.decisionHash.slice(2)}` as Hex;
  expects(evidence, "INCOMPLETE", "ORDER_NOT_CHECKABLE");
});

test("a decision that never executed may sit between two trades", () => {
  const { evidence } = history(2);
  const [first, second] = evidence.records!;
  const reverted: PublishedRecord = { decisionHash: keccak256(stringToHex("placeholder")), body: "", status: "reverted" };
  reverted.body = canonical({ v: 3, prevDecisionHash: first!.decisionHash, note: "reverted" });
  reverted.decisionHash = recordHash(reverted.body, 3);
  editBody(second!, (b) => { b.prevDecisionHash = reverted.decisionHash; });
  const tx = evidence.txs[second!.txHash!]!;
  tx.input = `${tx.input.slice(0, -64)}${second!.decisionHash.slice(2)}` as Hex;
  evidence.records!.push(reverted);
  assert.equal(judge(evidence).status, "PASS", JSON.stringify(judge(evidence).findings));
});

test("the same content in another spelling fails", () => {
  const { evidence } = history(1);
  const record = evidence.records![0]!;
  record.body = JSON.stringify(JSON.parse(record.body), null, 1);
  record.decisionHash = recordHash(record.body, 3);
  const tx = evidence.txs[trades(evidence)[0]!.txHash]!;
  tx.input = `${tx.input.slice(0, -64)}${record.decisionHash.slice(2)}` as Hex;
  expects(evidence, "FAIL", "NOT_CANONICAL");
});

test("a domain is what separates a record hash from a plain hash of the same bytes", () => {
  const { evidence } = history(1);
  const record = evidence.records![0]!;
  assert.notEqual(recordHash(record.body, 3), keccak256(stringToHex(record.body)));
  const tx = evidence.txs[trades(evidence)[0]!.txHash]!;
  tx.input = `${tx.input.slice(0, -64)}${keccak256(stringToHex(record.body)).slice(2)}` as Hex;
  record.decisionHash = keccak256(stringToHex(record.body));
  expects(evidence, "FAIL", "RECORD_ALTERED");
});

test("two records claiming one hash fail", () => {
  const { evidence } = history(1);
  evidence.records!.push({ ...evidence.records![0]!, body: `${evidence.records![0]!.body} ` });
  assert.ok(codes(evidence).includes("RECORD_CONFLICT"));
});

test("an old record format cannot pass, since it does not name its trade", () => {
  const { evidence } = history(1);
  const record = evidence.records![0]!;
  record.body = JSON.stringify({ v: 2, block: "99" });
  record.decisionHash = recordHash(record.body, 2);
  const tx = evidence.txs[trades(evidence)[0]!.txHash]!;
  tx.input = `${tx.input.slice(0, -64)}${record.decisionHash.slice(2)}` as Hex;
  expects(evidence, "INCOMPLETE", "OLD_RECORD_FORMAT");
});

// Misleading success

test("a trade the records claim and the chain does not show fails", () => {
  const { evidence } = history(1);
  evidence.records!.push({ decisionHash: keccak256(stringToHex("x")), body: "{}", status: "included", txHash: keccak256(stringToHex("nowhere")) });
  expects(evidence, "FAIL", "CLAIMED_TRADE_NOT_ON_CHAIN");
});

test("a record claiming success with no transaction fails", () => {
  const { evidence } = history(1);
  evidence.records!.push({ decisionHash: keccak256(stringToHex("x")), body: "{}", status: "included" });
  expects(evidence, "FAIL", "CLAIMED_TRADE_NOT_ON_CHAIN");
});

test("a record saying a trade failed, when it executed, fails", () => {
  const { evidence } = history(1);
  evidence.records![0]!.status = "reverted";
  expects(evidence, "FAIL", "RECORD_DENIES_TRADE");
});

test("an overstated output fails", () => {
  const { evidence } = history(1);
  evidence.records![0]!.amountOut = "999999";
  expects(evidence, "FAIL", "RECORD_OVERSTATES_OUTPUT");
});

test("a failed trade with an honest record is fine, and does not count as a trade", () => {
  const { evidence } = history(1);
  evidence.records!.push({ decisionHash: keccak256(stringToHex("x")), body: canonical({ v: 3 }), status: "reverted", txHash: keccak256(stringToHex("reverted")) });
  const verdict = judge(evidence);
  assert.equal(verdict.status, "PASS", JSON.stringify(verdict.findings));
  assert.equal(verdict.checked.trades, 1);
});

// What moved

test("an event overstating what arrived fails against the token's own transfers", () => {
  const { evidence } = history(1);
  evidence.txs[trades(evidence)[0]!.txHash]!.transfers[1]!.value = 10n;
  expects(evidence, "FAIL", "SETTLEMENT_OUT_DIFFERS");
});

test("more taken from the vault than the event says fails", () => {
  const { evidence } = history(1);
  evidence.txs[trades(evidence)[0]!.txHash]!.transfers[0]!.value = 5_000n;
  expects(evidence, "FAIL", "SETTLEMENT_IN_DIFFERS");
});

test("tokens a router pays back count against what left", () => {
  const { evidence } = history(1);
  const entry = trades(evidence)[0]!;
  const tx = evidence.txs[entry.txHash]!;
  tx.transfers[0]!.value = 1_500n;
  tx.transfers.push({ token: TOKEN_A, from: ROUTER, to: VAULT, value: 500n });
  assert.equal(judge(evidence).status, "PASS", JSON.stringify(judge(evidence).findings));
});

test("a trade sent by someone other than the agent fails", () => {
  const { evidence } = history(1);
  evidence.txs[trades(evidence)[0]!.txHash]!.from = ROUTER;
  expects(evidence, "FAIL", "NOT_SENT_BY_AGENT");
});

test("an event from a reverted transaction fails", () => {
  const { evidence } = history(1);
  evidence.txs[trades(evidence)[0]!.txHash]!.success = false;
  expects(evidence, "FAIL", "EVENT_FROM_FAILED_TX");
});

test("output under the signed minimum fails", () => {
  const { evidence } = history(1);
  const entry = trades(evidence)[0]!;
  entry.amountOut = 100n;
  evidence.txs[entry.txHash]!.transfers[1]!.value = 100n;
  evidence.records![0]!.amountOut = "100";
  sealHead(evidence);
  expects(evidence, "FAIL", "OUTPUT_UNDER_MINIMUM");
});

test("a trade running a strategy other than the pinned one fails", () => {
  const { evidence } = history(1);
  evidence.txs[trades(evidence)[0]!.txHash]!.pinAtBlock = keccak256(stringToHex("another policy"));
  expects(evidence, "FAIL", "STRATEGY_NOT_PINNED");
});

test("the pinned strategy passes", () => {
  const { evidence } = history(1);
  evidence.txs[trades(evidence)[0]!.txHash]!.pinAtBlock = STRATEGY;
  assert.equal(judge(evidence).status, "PASS");
});

// A hash of a fabricated market is still fabricated

test("a market the chain did not have fails, even with every hash correct", () => {
  const { evidence } = history(1);
  const [block] = Object.keys(evidence.market);
  evidence.market[block!]!.tick = 500;
  expects(evidence, "FAIL", "MARKET_TICK_DIFFERS");
});

test("a block the chain did not have fails", () => {
  const { evidence } = history(1);
  const [block] = Object.keys(evidence.market);
  evidence.market[block!]!.blockHash = keccak256(stringToHex("another block"));
  expects(evidence, "FAIL", "MARKET_BLOCK_DIFFERS");
});

test("a market that cannot be read again is stated, not assumed", () => {
  const { evidence } = history(1);
  const [block] = Object.keys(evidence.market);
  evidence.market[block!] = { blockHash: null, tick: null };
  expects(evidence, "INCOMPLETE", "MARKET_NOT_CHECKABLE");
});

test("a frame's market can differ from the sealed block, so it is a gap and not a lie", () => {
  const { evidence } = history(1);
  const record = evidence.records![0]!;
  editBody(record, (b) => { b.readMode = "stream"; });
  const tx = evidence.txs[trades(evidence)[0]!.txHash]!;
  tx.input = `${tx.input.slice(0, -64)}${record.decisionHash.slice(2)}` as Hex;
  const [block] = Object.keys(evidence.market);
  evidence.market[block!]!.tick = 500;
  expects(evidence, "INCOMPLETE", "MARKET_TICK_DIFFERS");
});

test("a decision dated after its own trade fails", () => {
  const { evidence } = history(1);
  const record = evidence.records![0]!;
  editBody(record, (b) => { b.block = "9999"; });
  const tx = evidence.txs[trades(evidence)[0]!.txHash]!;
  tx.input = `${tx.input.slice(0, -64)}${record.decisionHash.slice(2)}` as Hex;
  evidence.market["9999"] = { blockHash: JSON.parse(record.body).blockHash as Hex, tick: -7 };
  expects(evidence, "FAIL", "DECIDED_AFTER_EXECUTION");
});

// The local log

test("a rewritten local log fails against the anchor", () => {
  const { evidence } = history();
  const lines = evidence.localLog!.trim().split("\n");
  const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  evidence.localLog = `${lines.slice(0, -1).join("\n")}\n${JSON.stringify({ ...last, note: "rewritten" })}\n`;
  const verdict = judge(evidence);
  assert.equal(verdict.status, "FAIL");
  assert.ok(verdict.findings.some((f) => f.code === "LOG_ALTERED"));
});

test("a whole log rebuilt from scratch, with valid links, still fails against the chain", () => {
  const { evidence } = history();
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  const path = join(dir, "d.jsonl");
  const log = new ChainedLog(path);
  log.append({ wallTime: "t", note: "a different past" });
  log.append({ wallTime: "t", note: "a different past" });
  log.append({ wallTime: "t", note: "a different past" });
  evidence.localLog = readLog(path);
  rmSync(dir, { recursive: true, force: true });
  expects(evidence, "FAIL", "LOG_REWRITTEN");
});

test("a removed record fails", () => {
  const { evidence } = history();
  const lines = evidence.localLog!.trim().split("\n");
  evidence.localLog = `${[lines[0], lines[2]].join("\n")}\n`;
  expects(evidence, "FAIL", "LOG_SEQUENCE_BREAK");
});

test("a log cut short of what the chain committed is not a pass", () => {
  const { evidence } = history();
  const lines = evidence.localLog!.trim().split("\n");
  evidence.localLog = `${lines.slice(0, 1).join("\n")}\n`;
  const verdict = judge(evidence);
  assert.notEqual(verdict.status, "PASS");
  assert.ok(verdict.findings.some((f) => f.code === "LOG_SHORTER_THAN_COMMITTED"));
});

test("records after the newest commitment are stated, not trusted", () => {
  const { evidence } = history();
  const extra = JSON.parse(evidence.localLog!.trim().split("\n").at(-1)!) as { hash: Hex; seq: number };
  const body = { wallTime: "t", note: "a hold nothing has committed yet" };
  const seq = extra.seq + 1;
  const hash = keccak256(stringToHex(`${seq}|${extra.hash}|${JSON.stringify(body)}`));
  evidence.localLog += `${JSON.stringify({ seq, prev: extra.hash, hash, ...body })}\n`;
  expects(evidence, "INCOMPLETE", "UNANCHORED_TAIL");
});

test("a torn or unchained line is stated", () => {
  const { evidence } = history();
  evidence.localLog = `${evidence.localLog}{"half a li\n`;
  expects(evidence, "INCOMPLETE", "LOG_TORN_LINE");
  const again = history().evidence;
  again.localLog = `${again.localLog}{"wallTime":"old"}\n`;
  expects(again, "INCOMPLETE", "LOG_UNCHAINED_LINE");
});

// The two implementations

test("this verifier and the agent spell and hash a record the same way", () => {
  const { evidence } = history(1);
  const record = evidence.records![0]!;
  assert.equal(canonical(JSON.parse(record.body)), record.body);
  assert.equal(recordHash(record.body, 3), decisionHashOf(record.body));
  assert.equal(JSON.parse(record.body).v, 3);
});

test("a legacy record with no context keeps its plain hash, so old intents stay checkable", () => {
  const body = JSON.stringify({ block: "1" });
  assert.equal(decisionHashOf(body), keccak256(stringToHex(body)));
  assert.equal(recordHash(body, 0), decisionHashOf(body));
});
