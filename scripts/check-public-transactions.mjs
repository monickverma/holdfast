// Reads the receipts of the public testnet transactions the README links to, and records what the chain says.
// Read only. The site lists these rows, so a hash that stops resolving, or a status that differs, fails this script.
//   node scripts/check-public-transactions.mjs
import { writeFileSync } from "node:fs";

const RPC = "https://testnet.hsk.xyz";
const CHAIN_ID = 133;
const ROWS = [
  { kind: "swap", label: "A benchmark swap through the vault", expected: "success", hash: "0xdfecf966a18aece26398932a56fa65a839486ac7eeee76c739526ae7e360bf2f" },
  { kind: "swap", label: "The next benchmark swap", expected: "success", hash: "0x223e00b5b1d7d2e1ca0308243bd0724ead0f8b947e1db36e667eb33989927986" },
  { kind: "refusal", label: "Zero minimum output: BelowFloor", expected: "reverted", hash: "0x9eba7bf0d3721c8f64f6c6d926871fb5432d85c1fcab6b6c78f606d4c6bfb7a0" },
  { kind: "refusal", label: "11 tWHSK, over the trade cap: OverTradeCap", expected: "reverted", hash: "0x7d41dda69fccbcf61382a40767287cbb41895b789668826c6dc7740f0aa03792" },
  { kind: "refusal", label: "The agent key withdrawing", expected: "reverted", hash: "0x276712cd2d682fa6dface8ea5bcb7273f164c5d796be58dcc2b0842ddf175b67" },
  { kind: "refusal", label: "10 tWHSK once the lifetime budget was mostly used: OverLifetimeCap", expected: "reverted", hash: "0xd660206d33904df0af39ed4d9c9fd6f0f0a914e128184b52170fbd245d062b1e" },
];

async function rpc(method, params) {
  const response = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

if (Number(await rpc("eth_chainId", [])) !== CHAIN_ID) throw new Error(`Expected chain ${CHAIN_ID}`);
let failed = 0;
const rows = [];
for (const row of ROWS) {
  const receipt = await rpc("eth_getTransactionReceipt", [row.hash]);
  const status = receipt ? (receipt.status === "0x1" ? "success" : "reverted") : "not found";
  if (status !== row.expected) failed++;
  rows.push({ ...row, status, block: receipt ? BigInt(receipt.blockNumber).toString() : null, gasUsed: receipt ? BigInt(receipt.gasUsed).toString() : null });
  console.log(`${status === row.expected ? "PASS" : "FAIL"} ${status} ${row.label}`);
}
writeFileSync("evidence/public-transactions.json", `${JSON.stringify({
  lane: "testnet",
  chainId: CHAIN_ID,
  explorer: "https://testnet-explorer.hskchain.net",
  checkedAt: new Date().toISOString(),
  vault: "0x4bfc3aff6795f7a1cccd00a95f29d24356ceee89", // the older vault, not the version 3 one
  note: "Sent to the older testnet vault in our own test market. Self-trades with free test tokens, not volume, and nothing about HSKSwap or mainnet.",
  rows,
}, null, 2)}\n`);
if (failed) process.exit(1);
