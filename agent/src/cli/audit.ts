// Ties an on-chain trade to the decision that made it. Each trade carries a hash of its decision after its arguments, so
// the agent's log can be checked against the chain by anyone holding it, and a log cannot be rewritten later.
//   npm run audit -- <data dir>
import { join } from "node:path";
import { parseArgs } from "node:util";
import { keccak256, stringToHex, type Hex } from "viem";
import { loadConfig } from "../config.js";
import { Ledger } from "../ledger.js";
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
  if (keccak256(stringToHex(intent.decisionBody)) !== intent.decisionHash) return { ...base, verdict: "log-altered", detail: "The stored decision does not hash to the stored hash." };
  if (!input) return { ...base, verdict: "not-on-chain" };
  const carried = hashInCalldata(input);
  if (carried !== intent.decisionHash) return { ...base, verdict: "chain-differs", detail: `The transaction carries ${carried ?? "no hash"}.` };
  return { ...base, verdict: "matches" };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cli/audit.ts") || process.argv[1]?.replace(/\\/g, "/").endsWith("cli/audit.js")) {
  const { positionals } = parseArgs({ allowPositionals: true });
  try {
    process.loadEnvFile();
  } catch {
    // A .env file is optional; the environment may already be set.
  }
  const config = loadConfig({ ...process.env, AGENT_PRIVATE_KEY: undefined, MODE: "observe", LIVE: undefined });
  const ledger = new Ledger(join(positionals[0] ?? config.dataDir, "ledger.jsonl"));
  const rpc = new RpcClient(config.rpcUrl);
  const results: AuditResult[] = [];
  for (const intent of ledger.all()) {
    // A cancelled intent was dropped before it was sent, so the chain has nothing to compare it with.
    if (!intent.txHash || intent.status === "cancelled") continue;
    const tx = await rpc.call<{ input: Hex } | null>("eth_getTransactionByHash", [intent.txHash]);
    results.push(auditIntent(intent, tx?.input ?? null));
  }
  ledger.close();
  rpc.close();
  console.log(JSON.stringify({ checked: results.length, matches: results.filter((r) => r.verdict === "matches").length, results }, null, 2));
  if (results.some((r) => r.verdict === "log-altered" || r.verdict === "chain-differs")) process.exitCode = 1;
}
