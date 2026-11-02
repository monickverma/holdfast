// Checks a vault's history against the chain and against the records its agent published. Trusts neither the agent's
// code nor its files: this imports only viem and node, so it can be read and run alone. docs/DECISION-RECORDS.md is the
// format. It answers PASS, FAIL or INCOMPLETE. Evidence that is missing is INCOMPLETE and never PASS, and PASS says what
// the evidence covers: that the records agree with the chain, not that the agent's reasoning or market view was wise.
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, decodeFunctionData, encodeAbiParameters, http, keccak256, parseAbi, parseAbiItem, slice, stringToHex, type Address, type Hex } from "viem";

export type Status = "PASS" | "FAIL" | "INCOMPLETE";
export interface Finding { severity: "FAIL" | "INCOMPLETE"; code: string; detail: string }
export interface Verdict {
  status: Status;
  findings: Finding[];
  checked: { logEntries: number; trades: number; tradesMatched: number; stops: number; anchors: number; records: number; localLogRecords: number; localLogAnchoredThrough: number };
}

export interface ChainEntry { kind: "trade" | "stop" | "anchor"; blockNumber: bigint; logIndex: number; txHash: Hex; blockTime: bigint | null; id: Hex; token: Address; amountIn: bigint; amountOut: bigint }
export interface Transfer { token: Address; from: Address; to: Address; value: bigint }
export interface TradeTx { from: Address; to: Address | null; input: Hex; success: boolean; agentAtBlock: Address | null; pinAtBlock: Hex | null; transfers: Transfer[] }
export interface PublishedRecord { decisionHash: Hex; body: string; status?: string; txHash?: Hex; amountOut?: string }
export interface MarketCheck { blockHash: Hex | null; tick: number | null }

export interface Evidence {
  chainId: number;
  vault: Address;
  tokenA: Address;
  tokenB: Address;
  version: bigint | null;
  /** Null when the vault has no on-chain log, or did not answer. */
  logHead: Hex | null;
  logCount: bigint | null;
  entries: ChainEntry[];
  /** By transaction hash. Null when the node would not give it. */
  txs: Record<string, TradeTx | null>;
  /** Null when no records were supplied. */
  records: PublishedRecord[] | null;
  /** Text of the agent's decision log. Null when not supplied. */
  localLog: string | null;
  /** By record block number. */
  market: Record<string, MarketCheck>;
  /** Anything the node refused or failed to return. */
  unavailable: string[];
}

const ZERO32: Hex = `0x${"0".repeat(64)}`;
const DOMAIN = "holdfast.decision.v3\n";
const lower = (value: string | null | undefined) => value?.toLowerCase();
const same = (a: string | null | undefined, b: string | null | undefined) => lower(a) === lower(b);

const VAULT_ABI = parseAbi([
  "function execute(address tokenIn, uint256 amountIn, uint256 minOut, uint256 deadline, bytes32 intentId) returns (uint256 amountOut)",
  "function VERSION() view returns (uint256)",
  "function logHead() view returns (bytes24)",
  "function logCount() view returns (uint64)",
  "function tokenA() view returns (address)",
  "function tokenB() view returns (address)",
  "function agent() view returns (address)",
  "function strategyPin() view returns (bytes32)",
]);
const POOL_ABI = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"]);
const TRADED = parseAbiItem("event Traded(bytes32 indexed intentId, address indexed tokenIn, uint256 amountIn, uint256 amountOut, uint256 remainingAfter)");
const STOP = parseAbiItem("event StopFired(address indexed by, address indexed tokenIn, uint256 amountIn, uint256 amountOut, int256 twapTick, uint256 remainingAfter)");
const ANCHOR = parseAbiItem("event LogAnchored(bytes32 indexed localHead, uint256 localSeq)");
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (typeof item !== "object" || item === null) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sort(record[key])]));
  };
  return JSON.stringify(sort(value));
}

export function recordHash(body: string, version: number): Hex {
  return keccak256(stringToHex(version >= 3 ? `${DOMAIN}${body}` : body));
}

export function logSeed(chainId: number, vault: Address): Hex {
  return slice(keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }], ["holdfast.log.v1", BigInt(chainId), vault])), 0, 24);
}

export function nextHead(head: Hex, count: bigint, entry: Pick<ChainEntry, "kind" | "id" | "token" | "amountIn" | "amountOut">, blockTime: bigint): Hex {
  const kind = entry.kind === "trade" ? 1 : entry.kind === "stop" ? 2 : 3;
  return slice(keccak256(encodeAbiParameters(
    [{ type: "bytes24" }, { type: "uint64" }, { type: "uint8" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [head, count, kind, entry.id, entry.token, entry.amountIn, entry.amountOut, blockTime],
  )), 0, 24);
}

interface LocalLog { hashes: Hex[]; findings: Finding[] }

/** Recomputes the agent's own log. hashes[n] is the head after n records, so hashes[0] is the zero hash. */
function readLocalLog(text: string): LocalLog {
  const hashes: Hex[] = [ZERO32];
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], code: string, detail: string) => findings.push({ severity, code, detail });
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      add("INCOMPLETE", "LOG_TORN_LINE", `Line ${index + 1} is not whole. A crash can leave this, and so can an edit.`);
      return;
    }
    if (typeof parsed.hash !== "string") {
      add("INCOMPLETE", "LOG_UNCHAINED_LINE", `Line ${index + 1} commits to nothing.`);
      return;
    }
    const { seq, prev, hash, ...rest } = parsed;
    const expectedSeq = hashes.length - 1;
    const head = hashes[expectedSeq]!;
    if (seq !== expectedSeq) add("FAIL", "LOG_SEQUENCE_BREAK", `Line ${index + 1} says record ${String(seq)}, expected ${expectedSeq}. A record was removed, added or moved.`);
    if (prev !== head) add("FAIL", "LOG_LINK_BREAK", `Line ${index + 1} does not follow the record before it.`);
    if (keccak256(stringToHex(`${String(seq)}|${String(prev)}|${JSON.stringify(rest)}`)) !== hash) add("FAIL", "LOG_ALTERED", `Line ${index + 1} does not match its own hash.`);
    hashes.push(hash as Hex);
  });
  return { hashes, findings };
}

/** Pure: everything it knows is in `evidence`, so each kind of tampering can be tested without a chain. */
export function judge(evidence: Evidence): Verdict {
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], code: string, detail: string) => findings.push({ severity, code, detail });
  const checked: Verdict["checked"] = { logEntries: evidence.entries.length, trades: 0, tradesMatched: 0, stops: 0, anchors: 0, records: evidence.records?.length ?? 0, localLogRecords: 0, localLogAnchoredThrough: 0 };
  for (const what of evidence.unavailable) add("INCOMPLETE", "NODE_UNAVAILABLE", what);

  const entries = [...evidence.entries].sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  checkVaultLog(evidence, entries, add);

  const local = evidence.localLog === null ? null : readLocalLog(evidence.localLog);
  if (local) findings.push(...local.findings);
  else add("INCOMPLETE", "LOCAL_LOG_NOT_SUPPLIED", "Decisions that led to no trade cannot be checked without the agent's decision log.");
  if (local) checked.localLogRecords = local.hashes.length - 1;

  if (evidence.records === null) add("INCOMPLETE", "RECORDS_NOT_SUPPLIED", "Trades cannot be tied to decisions without the published records.");
  const byHash = new Map<string, PublishedRecord>();
  for (const record of evidence.records ?? []) {
    const earlier = byHash.get(lower(record.decisionHash)!);
    if (earlier && earlier.body !== record.body) add("FAIL", "RECORD_CONFLICT", `Two different records claim ${record.decisionHash}.`);
    byHash.set(lower(record.decisionHash)!, record);
  }

  const tradeByTx = new Map<string, Hex>();
  const usedHashes = new Map<string, Hex>();
  let previousTradeHash: Hex | null = null;
  let anchoredThrough = 0;
  const checkLocalHead = (head: unknown, seq: unknown, what: string) => {
    if (!local || typeof head !== "string" || typeof seq !== "number") return;
    if (seq >= local.hashes.length) add("INCOMPLETE", "LOG_SHORTER_THAN_COMMITTED", `${what} commits to record ${seq}, and the supplied log holds ${local.hashes.length - 1}.`);
    else if (!same(local.hashes[seq], head)) add("FAIL", "LOG_REWRITTEN", `${what} commits to a head the supplied log does not have at record ${seq}.`);
    else anchoredThrough = Math.max(anchoredThrough, seq);
  };

  for (const entry of entries) {
    if (entry.kind === "stop") {
      checked.stops++;
      continue;
    }
    if (entry.kind === "anchor") {
      checked.anchors++;
      checkLocalHead(entry.id, Number(entry.amountIn), `The anchor in ${entry.txHash}`);
      continue;
    }
    checked.trades++;
    const label = `Trade ${entry.id} in ${entry.txHash}`;
    tradeByTx.set(lower(entry.txHash)!, entry.id);
    const tx = evidence.txs[lower(entry.txHash)!] ?? null;
    if (!tx) {
      add("INCOMPLETE", "TX_UNAVAILABLE", `${label}: the node would not give the transaction.`);
      continue;
    }
    if (!tx.success) add("FAIL", "EVENT_FROM_FAILED_TX", `${label}: an event from a reverted transaction.`);
    if (tx.agentAtBlock === null) add("INCOMPLETE", "AGENT_UNKNOWN", `${label}: the node cannot say who the agent was at that block.`);
    else if (!same(tx.from, tx.agentAtBlock)) add("FAIL", "NOT_SENT_BY_AGENT", `${label}: sent by ${tx.from}, and the agent was ${tx.agentAtBlock}.`);
    checkSettlement(evidence, entry, tx, label, add);

    if (!same(tx.to, evidence.vault)) {
      add("INCOMPLETE", "CALLED_INDIRECTLY", `${label}: the transaction did not call the vault directly, so its decision hash cannot be read.`);
      continue;
    }
    let args: readonly [Address, bigint, bigint, bigint, Hex];
    try {
      const decoded = decodeFunctionData({ abi: VAULT_ABI, data: tx.input });
      if (decoded.functionName !== "execute") throw new Error("not execute");
      args = decoded.args as readonly [Address, bigint, bigint, bigint, Hex];
    } catch {
      add("FAIL", "CALLDATA_UNREADABLE", `${label}: the calldata is not an execute call.`);
      continue;
    }
    const [tokenIn, amountIn, minOut, deadline, intentId] = args;
    if (intentId !== entry.id || !same(tokenIn, entry.token)) add("FAIL", "CALLDATA_DISAGREES", `${label}: the calldata names a different intent or token.`);
    if (entry.amountIn > amountIn) add("FAIL", "SPENT_OVER_ASKED", `${label}: spent ${entry.amountIn}, asked ${amountIn}.`);
    if (entry.amountOut < minOut) add("FAIL", "OUTPUT_UNDER_MINIMUM", `${label}: received ${entry.amountOut}, minimum ${minOut}.`);
    if (entry.blockTime !== null && entry.blockTime > deadline) add("FAIL", "AFTER_DEADLINE", `${label}: included after its deadline.`);

    const bytes = (tx.input.length - 2) / 2;
    const decisionHash: Hex | null = bytes === 4 + 5 * 32 + 32 ? (`0x${tx.input.slice(-64)}` as Hex) : null;
    if (!decisionHash || decisionHash === ZERO32) {
      add("INCOMPLETE", "NO_DECISION_HASH", `${label}: carries no decision hash, so no decision can be tied to it.`);
      previousTradeHash = null;
      continue;
    }
    const firstUse = usedHashes.get(lower(decisionHash)!);
    if (firstUse) add("FAIL", "DECISION_HASH_REUSED", `${label}: reuses the decision hash of ${firstUse}.`);
    usedHashes.set(lower(decisionHash)!, entry.txHash);

    const record = byHash.get(lower(decisionHash)!);
    if (!record) {
      if (evidence.records !== null) add("INCOMPLETE", "RECORD_MISSING", `${label}: no published record has hash ${decisionHash}.`);
      previousTradeHash = decisionHash;
      continue;
    }
    if (checkRecord(evidence, entry, record, decisionHash, deadline, minOut, amountIn, tx, label, add, checkLocalHead)) checked.tradesMatched++;
    checkOrder(record, decisionHash, previousTradeHash, byHash, label, add);
    previousTradeHash = decisionHash;
  }

  // Absent from events known to be partial is a gap. Only a whole set of events can contradict a claim.
  const eventsWhole = evidence.logCount !== null && BigInt(entries.length) === evidence.logCount && evidence.unavailable.length === 0;
  for (const record of evidence.records ?? []) {
    if (record.status !== "included") continue;
    if (!record.txHash || !tradeByTx.has(lower(record.txHash)!)) add(eventsWhole || !record.txHash ? "FAIL" : "INCOMPLETE", "CLAIMED_TRADE_NOT_ON_CHAIN", `A record says ${record.decisionHash} executed in ${record.txHash ?? "no transaction"}, and the vault shows no such trade.`);
    else if (evidence.txs[lower(record.txHash)!] && !same(usedHashes.get(lower(record.decisionHash)!), record.txHash)) add("FAIL", "WRONG_TX_FOR_RECORD", `The record for ${record.decisionHash} names ${record.txHash}, which carries a different decision.`);
  }
  for (const [hash, txHash] of usedHashes) {
    const record = byHash.get(hash);
    if (record && (record.status === "reverted" || record.status === "expired" || record.status === "cancelled")) add("FAIL", "RECORD_DENIES_TRADE", `The record for ${hash} says ${record.status}, and ${txHash} executed it.`);
    if (record?.status === "included" && record.amountOut !== undefined) {
      const entry = entries.find((item) => same(item.txHash, txHash));
      if (entry && record.amountOut !== entry.amountOut.toString()) add("FAIL", "RECORD_OVERSTATES_OUTPUT", `The record for ${hash} says ${record.amountOut} out, and the vault's event says ${entry.amountOut}.`);
    }
  }

  if (local) {
    checked.localLogAnchoredThrough = anchoredThrough;
    const tail = local.hashes.length - 1 - anchoredThrough;
    if (tail > 0) add("INCOMPLETE", "UNANCHORED_TAIL", `${tail} newest log records have no on-chain commitment yet, so they could still be rewritten.`);
  }

  if (entries.length === 0 && (evidence.logCount === null || evidence.logCount === 0n)) add("INCOMPLETE", "NOTHING_TO_VERIFY", "No history was found. That is not the same as a clean history.");
  const status: Status = findings.some((f) => f.severity === "FAIL") ? "FAIL" : findings.length ? "INCOMPLETE" : "PASS";
  return { status, findings, checked };
}

function checkVaultLog(evidence: Evidence, entries: ChainEntry[], add: (severity: Finding["severity"], code: string, detail: string) => void): void {
  if (evidence.logHead === null || evidence.logCount === null) {
    add("INCOMPLETE", "NO_ONCHAIN_LOG", `Vault version ${evidence.version?.toString() ?? "unknown"} has no on-chain log, so a trade left out of the events could not be noticed.`);
    return;
  }
  const count = BigInt(entries.length);
  if (count > evidence.logCount) {
    add("FAIL", "MORE_EVENTS_THAN_LOG", `${count} events, and the vault counted ${evidence.logCount}.`);
    return;
  }
  if (count < evidence.logCount) {
    add("INCOMPLETE", "EVENTS_MISSING", `${count} events found, and the vault counted ${evidence.logCount}. Check --from-block, or the node left some out.`);
    return;
  }
  let head = logSeed(evidence.chainId, evidence.vault);
  let index = 0n;
  for (const entry of entries) {
    if (entry.blockTime === null) {
      add("INCOMPLETE", "BLOCK_UNAVAILABLE", `The node would not give the block of ${entry.txHash}, so the log head cannot be recomputed.`);
      return;
    }
    index++;
    head = nextHead(head, index, entry, entry.blockTime);
  }
  if (!same(head, evidence.logHead)) add("FAIL", "LOG_HEAD_MISMATCH", `The events recompute to ${head}, and the vault holds ${evidence.logHead}. Something was changed or reordered.`);
}

/** The tokens themselves say what moved, which a vault's own event cannot fake. */
function checkSettlement(evidence: Evidence, entry: ChainEntry, tx: TradeTx, label: string, add: (severity: Finding["severity"], code: string, detail: string) => void): void {
  const tokenOut = same(entry.token, evidence.tokenA) ? evidence.tokenB : evidence.tokenA;
  const net = (token: Address) => tx.transfers.filter((t) => same(t.token, token)).reduce((sum, t) => sum + (same(t.to, evidence.vault) ? t.value : 0n) - (same(t.from, evidence.vault) ? t.value : 0n), 0n);
  const inMoved = -net(entry.token);
  const outMoved = net(tokenOut);
  if (inMoved !== entry.amountIn) add("FAIL", "SETTLEMENT_IN_DIFFERS", `${label}: the event says ${entry.amountIn} left, and the token's transfers say ${inMoved}.`);
  if (outMoved !== entry.amountOut) add("FAIL", "SETTLEMENT_OUT_DIFFERS", `${label}: the event says ${entry.amountOut} arrived, and the token's transfers say ${outMoved}.`);
}

function checkRecord(evidence: Evidence, entry: ChainEntry, record: PublishedRecord, decisionHash: Hex, deadline: bigint, minOut: bigint, amountIn: bigint, tx: TradeTx, label: string, add: (severity: Finding["severity"], code: string, detail: string) => void, checkLocalHead: (head: unknown, seq: unknown, what: string) => void): boolean {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(record.body) as Record<string, unknown>;
  } catch {
    add("FAIL", "RECORD_UNREADABLE", `${label}: its record is not JSON.`);
    return false;
  }
  const version = typeof body.v === "number" ? body.v : 0;
  if (recordHash(record.body, version) !== lower(decisionHash)) {
    add("FAIL", "RECORD_ALTERED", `${label}: the record does not hash to what the transaction carries.`);
    return false;
  }
  if (version < 3) {
    add("INCOMPLETE", "OLD_RECORD_FORMAT", `${label}: record version ${version} does not name its vault, intent and agent, so it cannot be tied to this trade alone.`);
    return false;
  }
  if (canonical(body) !== record.body) add("FAIL", "NOT_CANONICAL", `${label}: the record is not in its one allowed spelling.`);
  const expected: Array<[string, unknown, unknown]> = [
    ["chainId", body.chainId, evidence.chainId], ["vault", lower(body.vault as string), lower(evidence.vault)], ["intentId", body.intentId, entry.id],
    ["agent", lower(body.agent as string), lower(tx.from)], ["tokenIn", lower(body.tokenIn as string), lower(entry.token)], ["amountIn", body.amountIn, amountIn.toString()],
    ["minOut", body.minOut, minOut.toString()], ["expiresAt", body.expiresAt, deadline.toString()],
  ];
  let matches = true;
  for (const [field, stated, actual] of expected) {
    if (stated === actual) continue;
    matches = false;
    add("FAIL", "RECORD_DISAGREES", `${label}: the record's ${field} is ${String(stated)}, and the chain says ${String(actual)}.`);
  }
  if (tx.pinAtBlock === null) add("INCOMPLETE", "PIN_UNKNOWN", `${label}: the node cannot say which strategy was pinned at that block.`);
  else if (!/^0x0+$/.test(tx.pinAtBlock) && !same(tx.pinAtBlock, body.strategyHash as string)) {
    matches = false;
    add("FAIL", "STRATEGY_NOT_PINNED", `${label}: ran strategy ${String(body.strategyHash)} while the owner had pinned ${tx.pinAtBlock}.`);
  }
  // A hash proves a record was not changed afterward, not that it was true. So read the market it claims to have seen.
  const blockText = String(body.block);
  if (BigInt(blockText) > entry.blockNumber) add("FAIL", "DECIDED_AFTER_EXECUTION", `${label}: the record names block ${blockText}, later than the trade.`);
  const seen = evidence.market[blockText];
  const sealed = body.readMode !== "stream";
  if (!seen || seen.blockHash === null || seen.tick === null) add("INCOMPLETE", "MARKET_NOT_CHECKABLE", `${label}: the node cannot show the market at block ${blockText}.`);
  else {
    if (!same(seen.blockHash, body.blockHash as string)) add(sealed ? "FAIL" : "INCOMPLETE", "MARKET_BLOCK_DIFFERS", `${label}: the record's block hash is not the chain's block ${blockText}.`);
    if (seen.tick !== body.tick) add(sealed ? "FAIL" : "INCOMPLETE", "MARKET_TICK_DIFFERS", `${label}: the record saw tick ${String(body.tick)}, and the pool at block ${blockText} says ${seen.tick}.`);
  }
  checkLocalHead(body.logHead, body.logSeq, label);
  return matches;
}

/** Each record names the decision signed before it. Decisions that never executed sit between trades, so walk through them. */
function checkOrder(record: PublishedRecord, decisionHash: Hex, previous: Hex | null, byHash: Map<string, PublishedRecord>, label: string, add: (severity: Finding["severity"], code: string, detail: string) => void): void {
  const prevOf = (item: PublishedRecord): Hex | null | undefined => {
    try {
      return (JSON.parse(item.body) as { prevDecisionHash?: Hex | null }).prevDecisionHash;
    } catch {
      return undefined;
    }
  };
  let cursor = prevOf(record);
  if (cursor === undefined) return;
  const seen = new Set<string>([lower(decisionHash)!]);
  while (cursor && !same(cursor, previous)) {
    if (seen.has(lower(cursor)!)) break;
    seen.add(lower(cursor)!);
    const step = byHash.get(lower(cursor)!);
    if (!step) {
      add("INCOMPLETE", "ORDER_NOT_CHECKABLE", `${label}: names earlier decision ${cursor}, and no record has it.`);
      return;
    }
    cursor = prevOf(step);
  }
  if (previous && !same(cursor, previous)) add("FAIL", "REORDERED", `${label}: its chain of earlier decisions does not reach the trade before it on chain.`);
}

export interface CollectOptions { rpcUrl: string; vault: Address; fromBlock: bigint; toBlock?: bigint; records: PublishedRecord[] | null; localLog: string | null; chunk?: bigint; pool?: Address }

/** Reads everything at one pinned block. A failed read becomes a stated gap, never an empty answer. */
export async function collect(options: CollectOptions): Promise<Evidence & { pinnedBlock: bigint }> {
  const client = createPublicClient({ transport: http(options.rpcUrl, { timeout: 20_000, retryCount: 2 }) });
  const chainId = await client.getChainId();
  const pinnedBlock = options.toBlock ?? (await client.getBlockNumber());
  const unavailable: string[] = [];
  const read = async <T>(address: Address, functionName: string, blockNumber: bigint): Promise<T | null> => {
    try {
      return (await client.readContract({ address, abi: VAULT_ABI, functionName: functionName as never, blockNumber } as never)) as T;
    } catch {
      return null;
    }
  };
  const version = await read<bigint>(options.vault, "VERSION", pinnedBlock);
  const [tokenA, tokenB, head, count] = await Promise.all([read<Address>(options.vault, "tokenA", pinnedBlock), read<Address>(options.vault, "tokenB", pinnedBlock), read<Hex>(options.vault, "logHead", pinnedBlock), read<bigint>(options.vault, "logCount", pinnedBlock)]);
  if (!tokenA || !tokenB) unavailable.push(`${options.vault} did not answer as a vault at block ${pinnedBlock}.`);

  const rows: Array<Omit<ChainEntry, "blockTime">> = [];
  const chunk = options.chunk ?? 5_000n;
  for (let from = options.fromBlock; from <= pinnedBlock; from += chunk) {
    const to = from + chunk - 1n > pinnedBlock ? pinnedBlock : from + chunk - 1n;
    try {
      const [traded, stops, anchors] = await Promise.all([
        client.getLogs({ address: options.vault, event: TRADED, fromBlock: from, toBlock: to }),
        client.getLogs({ address: options.vault, event: STOP, fromBlock: from, toBlock: to }),
        client.getLogs({ address: options.vault, event: ANCHOR, fromBlock: from, toBlock: to }),
      ]);
      for (const l of traded) rows.push({ kind: "trade", blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash, id: l.args.intentId!, token: l.args.tokenIn!, amountIn: l.args.amountIn!, amountOut: l.args.amountOut! });
      for (const l of stops) rows.push({ kind: "stop", blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash, id: ZERO32, token: l.args.tokenIn!, amountIn: l.args.amountIn!, amountOut: l.args.amountOut! });
      for (const l of anchors) rows.push({ kind: "anchor", blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash, id: l.args.localHead!, token: `0x${"0".repeat(40)}`, amountIn: l.args.localSeq!, amountOut: 0n });
    } catch {
      unavailable.push(`Events for blocks ${from} to ${to} could not be read.`);
    }
  }

  const blockTimes = new Map<bigint, bigint | null>();
  const timeOf = async (number: bigint) => {
    if (!blockTimes.has(number)) blockTimes.set(number, await client.getBlock({ blockNumber: number }).then((b) => b.timestamp).catch(() => null));
    return blockTimes.get(number)!;
  };
  const entries: ChainEntry[] = [];
  for (const row of rows) entries.push({ ...row, blockTime: await timeOf(row.blockNumber) });

  const txs: Record<string, TradeTx | null> = {};
  for (const row of rows) {
    if (row.kind !== "trade") continue;
    try {
      const [tx, receipt] = await Promise.all([client.getTransaction({ hash: row.txHash }), client.getTransactionReceipt({ hash: row.txHash })]);
      const transfers: Transfer[] = [];
      for (const log of receipt.logs) {
        if (log.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" || log.topics.length !== 3) continue;
        transfers.push({ token: log.address, from: `0x${log.topics[1]!.slice(26)}`, to: `0x${log.topics[2]!.slice(26)}`, value: BigInt(log.data) });
      }
      txs[row.txHash.toLowerCase()] = { from: tx.from, to: tx.to, input: tx.input, success: receipt.status === "success", agentAtBlock: await read<Address>(options.vault, "agent", row.blockNumber), pinAtBlock: (version ?? 0n) >= 4n ? await read<Hex>(options.vault, "strategyPin", row.blockNumber) : ZERO32, transfers };
    } catch {
      txs[row.txHash.toLowerCase()] = null;
    }
  }

  const market: Record<string, MarketCheck> = {};
  for (const record of options.records ?? []) {
    let body: { block?: unknown; marketSource?: unknown; v?: unknown };
    try {
      body = JSON.parse(record.body) as typeof body;
    } catch {
      continue;
    }
    if (typeof body.block !== "string" || typeof body.v !== "number" || body.v < 3 || market[body.block]) continue;
    const number = BigInt(body.block);
    const pool = (typeof body.marketSource === "string" ? body.marketSource : options.pool) as Address | undefined;
    const [block, slot0] = await Promise.all([
      client.getBlock({ blockNumber: number }).catch(() => null),
      pool ? client.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0", blockNumber: number }).catch(() => null) : Promise.resolve(null),
    ]);
    market[body.block] = { blockHash: block?.hash ?? null, tick: slot0 ? slot0[1] : null };
  }

  return {
    chainId, vault: options.vault, tokenA: tokenA ?? `0x${"0".repeat(40)}`, tokenB: tokenB ?? `0x${"0".repeat(40)}`, version,
    logHead: head, logCount: count, entries, txs, records: options.records, localLog: options.localLog, market, unavailable, pinnedBlock,
  };
}

export function parseRecords(text: string): PublishedRecord[] {
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as PublishedRecord);
}

const USAGE = "usage: verify-history --rpc URL --vault 0x... --from-block N [--to-block N] [--records file.jsonl] [--log decisions.jsonl] [--out file.json] [--chunk N]";

export async function runVerify(argv: string[]): Promise<number> {
  const option = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const [rpcUrl, vault, from] = [option("rpc"), option("vault"), option("from-block")];
  if (!rpcUrl || !vault || !/^0x[0-9a-fA-F]{40}$/.test(vault) || !from || !/^\d+$/.test(from)) {
    console.error(USAGE);
    // The same code as a gap: a run that could not start has verified nothing.
    return 2;
  }
  const load = (path: string | undefined, what: string): string | null => {
    if (!path) return null;
    try {
      return readFileSync(path, "utf8");
    } catch {
      console.error(`Could not read ${what} at ${path}.`);
      return null;
    }
  };
  const recordsText = load(option("records"), "records");
  const evidence = await collect({ rpcUrl, vault: vault as Address, fromBlock: BigInt(from), ...(option("to-block") ? { toBlock: BigInt(option("to-block")!) } : {}), ...(option("chunk") ? { chunk: BigInt(option("chunk")!) } : {}), records: recordsText === null ? null : parseRecords(recordsText), localLog: load(option("log"), "the decision log") });
  const verdict = judge(evidence);
  const report = { wallTime: new Date().toISOString(), lane: "read only", chainId: evidence.chainId, vault, vaultVersion: evidence.version?.toString() ?? null, fromBlock: from, pinnedBlock: evidence.pinnedBlock.toString(), ...verdict, scope: "PASS means every record agrees with the chain and nothing is missing. It does not mean the decisions were good, or that any market view beyond the checked block and tick was true." };
  const out = option("out");
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  return verdict.status === "PASS" ? 0 : verdict.status === "FAIL" ? 1 : 2;
}

if (process.argv[1]?.replace(/\\/g, "/").match(/cli\/verify-history\.(ts|js)$/)) {
  process.exitCode = await runVerify(process.argv.slice(2));
}
