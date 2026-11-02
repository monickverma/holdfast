// Ties an on-chain trade to the decision that made it. Each trade carries a hash of its decision after its arguments, so
// the agent's log can be checked against the chain by anyone holding it, and a log cannot be rewritten later.
//   npm run audit -- <data dir>
import { join } from "node:path";
import { parseArgs } from "node:util";
import { encodeEventTopics, parseEventLogs, type Address, type Hex } from "viem";
import { decisionHashOf } from "../executor.js";
import { readLog, verifyChain, type ChainCheck } from "../audit-log.js";
import { loadConfig } from "../config.js";
import { Ledger, type Intent } from "../ledger.js";
import { VAULT_ABI } from "../reader.js";
import { RpcClient } from "../rpc.js";

/** execute(address,uint256,uint256,uint256,bytes32): a selector and five words, then the hash. */
const ARGS_HEX_LENGTH = 2 + 8 + 5 * 64;

export interface AuditResult {
  key: string;
  txHash: Hex | undefined;
  verdict: "matches" | "log-altered" | "chain-differs" | "no-hash" | "not-on-chain";
  detail?: string;
}

/** The hash a transaction's calldata carries, or null if it carries none. */
export function hashInCalldata(input: Hex): Hex | null {
  return input.length === ARGS_HEX_LENGTH + 64 ? (`0x${input.slice(ARGS_HEX_LENGTH)}` as Hex) : null;
}

export function auditIntent(intent: { key: string; txHash?: Hex; decisionBody?: string; decisionHash?: Hex }, input: Hex | null): AuditResult {
  const base = { key: intent.key, txHash: intent.txHash };
  if (!intent.decisionBody || !intent.decisionHash) return { ...base, verdict: "no-hash", detail: "This intent predates decision hashes." };
  if (decisionHashOf(intent.decisionBody) !== intent.decisionHash) return { ...base, verdict: "log-altered", detail: "The stored decision does not hash to the stored hash." };
  if (!input) return { ...base, verdict: "not-on-chain" };
  const carried = hashInCalldata(input);
  if (carried !== intent.decisionHash) return { ...base, verdict: "chain-differs", detail: `The transaction carries ${carried ?? "no hash"}.` };
  return { ...base, verdict: "matches" };
}

/** What the chain says a transaction did, as much of it as the audit compares. */
export interface ChainFill {
  success: boolean;
  blockHash?: Hex;
  /** From the vault's own Traded event for this intent. Absent if there was none. */
  amountIn?: bigint;
  amountOut?: bigint;
}

/** Where the log and the receipt disagree about the outcome. A rewritten profit shows up here. */
export function reconcileFill(intent: Pick<Intent, "status" | "amountOut" | "amountSpent" | "amountIn">, fill: ChainFill | null): string[] {
  const problems: string[] = [];
  if (!fill) {
    if (intent.status === "included" || intent.status === "reverted") problems.push(`The log says ${intent.status}, and the chain has no receipt.`);
    return problems;
  }
  if (fill.success !== (intent.status === "included")) problems.push(`The log says ${intent.status}, and the receipt says ${fill.success ? "success" : "reverted"}.`);
  if (fill.success && fill.amountOut === undefined) problems.push("The receipt has no Traded event from the vault for this intent.");
  if (fill.amountOut !== undefined && fill.amountOut !== intent.amountOut) problems.push(`The log says ${intent.amountOut} out, and the event says ${fill.amountOut}.`);
  if (fill.amountIn !== undefined && fill.amountIn !== (intent.amountSpent ?? intent.amountIn)) problems.push(`The log says ${intent.amountSpent ?? intent.amountIn} in, and the event says ${fill.amountIn}.`);
  return problems;
}

/**
 * Each decision names the one signed before it, and the head of the decision log when it was made. Those two values are
 * inside the hash the chain holds, so a trade cannot later be removed from the log, nor a logged refusal rewritten, up to
 * the newest trade.
 */
export function checkLinks(intents: readonly Pick<Intent, "key" | "decisionBody" | "decisionHash" | "status" | "rawTx">[], log: Pick<ChainCheck, "hashes">): string[] {
  const problems: string[] = [];
  let previous: Hex | null = null;
  for (const intent of intents) {
    if (!intent.decisionBody || !intent.decisionHash || intent.status === "cancelled" || !intent.rawTx) continue;
    let body: { v?: number; prevDecisionHash?: Hex | null; logHead?: Hex };
    try {
      body = JSON.parse(intent.decisionBody);
    } catch {
      problems.push(`${intent.key}: the stored decision is not JSON.`);
      continue;
    }
    if (body.v === 2) {
      if ((body.prevDecisionHash ?? null) !== previous) problems.push(`${intent.key}: names ${body.prevDecisionHash} as the decision before it, but the log's is ${previous}. A trade was removed or added.`);
      const genesis = /^0x0+$/.test(body.logHead ?? "");
      if (!genesis && body.logHead && !log.hashes.has(body.logHead)) problems.push(`${intent.key}: committed to decision log head ${body.logHead}, which is not in the log. The log was rewritten.`);
    }
    previous = intent.decisionHash;
  }
  return problems;
}

/** Traded events on chain whose intent the log does not hold: trades someone left out, or another key trading. */
export function unloggedTrades(events: readonly { intentId: Hex; transactionHash: Hex }[], intents: readonly Pick<Intent, "intentId">[]): Hex[] {
  const known = new Set(intents.map((i) => i.intentId.toLowerCase()));
  return events.filter((e) => !known.has(e.intentId.toLowerCase())).map((e) => e.transactionHash);
}

const LOG_CHUNK_BLOCKS = 5_000n;

async function tradedEvents(rpc: RpcClient, vault: Address, fromBlock: bigint): Promise<{ intentId: Hex; transactionHash: Hex }[]> {
  const latest = BigInt(await rpc.call<string>("eth_blockNumber"));
  const topics = encodeEventTopics({ abi: VAULT_ABI, eventName: "Traded" });
  const events: { intentId: Hex; transactionHash: Hex }[] = [];
  for (let from = fromBlock; from <= latest; from += LOG_CHUNK_BLOCKS) {
    const to = from + LOG_CHUNK_BLOCKS - 1n < latest ? from + LOG_CHUNK_BLOCKS - 1n : latest;
    const logs = await rpc.call<never[]>("eth_getLogs", [{ address: vault, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
    for (const log of parseEventLogs({ abi: VAULT_ABI, eventName: "Traded", logs }) as unknown as { args: { intentId: Hex }; transactionHash: Hex }[]) {
      events.push({ intentId: log.args.intentId, transactionHash: log.transactionHash });
    }
  }
  return events;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/audit.ts") || process.argv[1]?.replace(/\\/g, "/").endsWith("cli/audit.js")) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { "from-block": { type: "string" } } });
  try {
    process.loadEnvFile();
  } catch {
    // A .env file is optional; the environment may already be set.
  }
  const config = loadConfig({ ...process.env, AGENT_PRIVATE_KEY: undefined, MODE: "observe", LIVE: undefined });
  const dir = positionals[0] ?? config.dataDir;
  const ledger = new Ledger(join(dir, "ledger.jsonl"));
  const rpc = new RpcClient(config.rpcUrl);
  const results: Array<AuditResult & { outcome?: string[] }> = [];
  for (const intent of ledger.all()) {
    // A cancelled intent was dropped before it was sent, so the chain has nothing to compare it with.
    if (!intent.txHash || intent.status === "cancelled") continue;
    const tx = await rpc.call<{ input: Hex } | null>("eth_getTransactionByHash", [intent.txHash]);
    const receipt = await rpc.call<{ status: Hex; blockHash: Hex; logs: never[] } | null>("eth_getTransactionReceipt", [intent.txHash]);
    const traded = receipt && config.vault
      ? (parseEventLogs({ abi: VAULT_ABI, eventName: "Traded", logs: (receipt.logs as { address: Address }[]).filter((l) => l.address.toLowerCase() === config.vault!.toLowerCase()) as never[] }) as unknown as { args: { intentId: Hex; amountIn: bigint; amountOut: bigint } }[]).find((l) => l.args.intentId === intent.intentId)
      : undefined;
    const fill: ChainFill | null = receipt && { success: receipt.status === "0x1", blockHash: receipt.blockHash, ...(traded ? { amountIn: traded.args.amountIn, amountOut: traded.args.amountOut } : {}) };
    results.push({ ...auditIntent(intent, tx?.input ?? null), outcome: reconcileFill(intent, fill) });
  }
  const log = verifyChain(readLog(join(dir, "decisions.jsonl")));
  const links = checkLinks(ledger.all(), log);
  const events = values["from-block"] && config.vault ? await tradedEvents(rpc, config.vault, BigInt(values["from-block"])) : null;
  const unlogged = events ? unloggedTrades(events, ledger.all()) : null;
  ledger.close();
  rpc.close();
  const outcomeProblems = results.flatMap((r) => r.outcome ?? []);
  console.log(JSON.stringify({
    onChain: {
      evidence: "Immutable. Anyone can re-read it.",
      trades: results.length,
      hashesMatch: results.filter((r) => r.verdict === "matches").length,
      outcomeProblems,
      tradedEventsNotInTheLog: unlogged ?? "not checked: pass --from-block",
      linkProblems: links,
    },
    local: {
      evidence: "This machine's log. It proves nothing alone. Records after the newest trade are not committed to the chain.",
      decisionRecords: log.records,
      fromBeforeChaining: log.unchained,
      tornLines: log.tornLines,
      head: log.head,
      breaks: log.breaks,
    },
    results,
  }, null, 2));
  if (results.some((r) => r.verdict === "log-altered" || r.verdict === "chain-differs") || outcomeProblems.length || links.length || log.breaks.length || unlogged?.length) process.exitCode = 1;
}
