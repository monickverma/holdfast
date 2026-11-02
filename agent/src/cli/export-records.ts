// Writes what the agent's ledger knows about each signed decision, for verify-history to check against the chain. Leaves
// out the signed bytes and everything else a verifier has no use for. Reads local files and sends nothing.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../ledger.js";

export function exportRecords(dataDir: string, out: string): number {
  const ledger = new Ledger(join(dataDir, "ledger.jsonl"));
  const lines: string[] = [];
  for (const intent of ledger.all()) {
    if (!intent.decisionBody || !intent.decisionHash || !intent.rawTx || intent.status === "cancelled") continue;
    lines.push(JSON.stringify({ decisionHash: intent.decisionHash, body: intent.decisionBody, status: intent.status, txHash: intent.txHash, ...(intent.status === "included" ? { amountOut: intent.amountOut?.toString() } : {}) }));
  }
  ledger.close();
  writeFileSync(out, lines.length ? `${lines.join("\n")}\n` : "");
  return lines.length;
}

if (process.argv[1]?.replace(/\\/g, "/").match(/cli\/export-records\.(ts|js)$/)) {
  const [dataDir, out] = process.argv.slice(2);
  if (!dataDir || !out) {
    console.error("usage: export-records <data dir> <out.jsonl>");
    process.exitCode = 2;
  } else {
    console.log(`${exportRecords(dataDir, out)} records written to ${out}. Then: npm run verify:history -- --rpc URL --vault 0x... --from-block N --records ${out} --log ${join(dataDir, "decisions.jsonl")}`);
  }
}
