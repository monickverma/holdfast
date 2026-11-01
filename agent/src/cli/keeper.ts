// Fires the vault's stop once its TWAP has crossed the trigger. Anyone can run this, and any key will do: the caller
// chooses nothing and is paid nothing, and can only waste its own gas. Dry run by default.
//   npm run keeper                       check once and report what would happen
//   npm run keeper -- --watch            keep checking
//   npm run keeper -- --watch --broadcast   send, signing with KEEPER_PRIVATE_KEY
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodeRevert } from "../executor.js";
import { explainError } from "../explain.js";
import { assertChainForBroadcast } from "../chain-guard.js";
import { loadConfig, networkProfile } from "../config.js";
import { VAULT_ABI } from "../reader.js";
import { RpcError, sleep } from "../rpc.js";

try {
  process.loadEnvFile();
} catch {
  // A .env file is optional; the environment may already be set.
}

const { values } = parseArgs({
  options: {
    broadcast: { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
    "interval-ms": { type: "string", default: "5000" },
    "confirm-mainnet": { type: "boolean", default: false },
  },
});

const config = loadConfig({ ...process.env, AGENT_PRIVATE_KEY: undefined, MODE: "observe", LIVE: undefined });
if (!config.vault) throw new Error("Set VAULT_ADDRESS, or deploy the test market.");
const vault: Address = config.vault;
const chain = defineChain({ id: config.chainId, name: "HSK Chain", nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 0 }) });

const rawKey = process.env.KEEPER_PRIVATE_KEY as Hex | undefined;
if (values.broadcast && !rawKey) throw new Error("--broadcast needs KEEPER_PRIVATE_KEY. Use a key that holds only gas.");
const account = values.broadcast ? privateKeyToAccount(rawKey!) : undefined;
const wallet = account && createWalletClient({ account, chain, transport: http(config.rpcUrl) });
if (values.broadcast) assertChainForBroadcast(await client.getChainId(), config.chainId, values["confirm-mainnet"]!);

const log = (record: Record<string, unknown>) => console.log(JSON.stringify({ wallTime: new Date().toISOString(), network: networkProfile().network, ...record }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

async function tick(): Promise<void> {
  const ready = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "stopReady" });
  if (!ready) return log({ action: "wait", reason: "The stop is not ready." });
  try {
    // A preview, from the address that would send. A refusal here costs nothing.
    const { result } = await client.simulateContract({ address: vault, abi: VAULT_ABI, functionName: "triggerStop", account: account?.address ?? vault });
    if (!wallet) return log({ action: "would-fire", amountOut: result, dryRun: true });
    const hash = await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "triggerStop", chain, account: account! });
    const receipt = await client.waitForTransactionReceipt({ hash });
    log({ action: "fired", status: receipt.status, hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
  } catch (error) {
    const name = error instanceof RpcError ? decodeRevert(error) : /(?:reverted with the following signature|reason: |Error: )\s*(\w+)/.exec(String(error))?.[1] ?? String(error).split("\n")[0]!;
    log({ action: "refused", error: name, explanation: explainError(name) });
  }
}

do {
  await tick().catch((error) => log({ action: "error", error: String(error).split("\n")[0] }));
  if (values.watch) await sleep(Number(values["interval-ms"]));
} while (values.watch);
