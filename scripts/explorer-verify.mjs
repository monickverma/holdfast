// Source verification on the explorer. It only reads and prints unless --submit is given, because submitting publishes
// the source to a third party.
//   node scripts/explorer-verify.mjs <vault address> [--chain 133]            is it verified? what would be sent?
//   node scripts/explorer-verify.mjs <vault address> --chain 133 --submit     needs the constructor arguments from the chain
import { spawnSync } from "node:child_process";

const address = process.argv[2];
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) {
  console.error("Usage: node scripts/explorer-verify.mjs <vault address> [--chain 133] [--submit] [--constructor-args 0x..]");
  process.exit(2);
}
const flag = (name) => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1]; };
const chain = flag("--chain") ?? "133";
const explorers = { 133: "https://testnet-explorer.hskchain.net", 177: "https://hsk.blockscout.com" };
const explorer = explorers[chain];
if (!explorer) throw new Error(`No explorer known for chain ${chain}`);

const response = await fetch(`${explorer}/api/v2/smart-contracts/${address}`, { signal: AbortSignal.timeout(20_000) }).catch((error) => ({ ok: false, status: String(error) }));
const body = response.ok ? await response.json() : null;
const verified = body?.is_verified === true || body?.is_fully_verified === true;
console.log(`${explorer}/address/${address}`);
console.log(`verified on the explorer: ${response.ok ? verified : `unknown (${response.status})`}`);
const args = ["verify-contract", address, "contracts/HoldfastVault.sol:HoldfastVault", "--chain", chain, "--verifier", "blockscout", "--verifier-url", `${explorer}/api/`, "--compiler-version", "0.8.28"];
if (flag("--constructor-args")) args.push("--constructor-args", flag("--constructor-args"));
console.log(`would run: node scripts/forge.mjs ${args.join(" ")}`);
if (!process.argv.includes("--submit")) {
  console.log("Not submitted. Add --submit to publish the source.");
  process.exit(verified ? 0 : 1);
}
const result = spawnSync("node", ["scripts/forge.mjs", ...args], { stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
