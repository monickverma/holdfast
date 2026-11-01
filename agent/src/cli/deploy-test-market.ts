import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertTestMarketChain, networkProfile, testMarketFile } from "../config.js";

const AGENT_TTL_SEC = 29n * 86_400n;

export async function deployTestMarket(rpcUrl: string, key: Hex, agent?: Address, persist = true) {
  const transport = http(rpcUrl);
  const probe = createPublicClient({ transport });
  const id = await probe.getChainId();
  assertTestMarketChain(id);
  const chain = defineChain({ id, name: "Holdfast test market", nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const account = privateKeyToAccount(key);
  const client = createPublicClient({ chain, transport, pollingInterval: 100 });
  const wallet = createWalletClient({ chain, transport, account });
  const gasPrice = await client.getGasPrice();
  // Hard preflight ceiling leaves ample room for all six deployments and setup.
  const gasBudget = 20_000_000n;
  if (gasBudget * gasPrice >= 50_000_000_000_000_000n) throw new Error("Deployment budget exceeds 0.05 HSK at this gas price");
  let gas = 0n, fee = 0n;
  // The public RPC can lag behind its own receipts, returning an old nonce or estimating against a chain
  // without the last contract. So the nonce is counted here and gas limits are fixed; unused gas is refunded.
  let nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  const receipt = async (hash: Hex) => {
    const r = await client.waitForTransactionReceipt({ hash });
    gas += r.gasUsed; fee += r.gasUsed * r.effectiveGasPrice;
    if (r.status !== "success") throw new Error(`Deployment step reverted: ${hash}`);
    return r;
  };
  const artifact = (name: string) => JSON.parse(readFileSync(`out/${name === "HoldfastVault" ? "HoldfastVault" : "TestMarket"}.sol/${name}.json`, "utf8"));
  const deploy = async (name: string, args: unknown[]) => {
    const a = artifact(name);
    const r = await receipt(await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, gasPrice, gas: name === "HoldfastVault" ? 6_000_000n : 3_000_000n, nonce: nonce++ }));
    return r.contractAddress!;
  };
  const write = async (name: string, address: Address, functionName: string, args: unknown[]) => receipt(await wallet.writeContract({ address, abi: artifact(name).abi, functionName, args, gasPrice, gas: 400_000n, nonce: nonce++ }));
  const whsk = await deploy("TestToken", ["Test WHSK", "tWHSK", 18]);
  const usdt = await deploy("TestToken", ["Test USDT", "tUSDT", 6]);
  const pool = await deploy("TestPool", [whsk, usdt]);
  const router = await deploy("TestRouter", [pool]);
  const quoter = await deploy("TestQuoter", [pool]);
  const vault = await deploy("HoldfastVault", [account.address, agent ?? account.address, BigInt(Math.floor(Date.now() / 1000)) + AGENT_TTL_SEC, router, whsk, usdt, 3000]);
  for (const [token, amount] of [[whsk, 1_000_000n * 10n ** 18n], [usdt, 100_000n * 10n ** 6n]] as const) {
    await write("TestToken", token, "mint", [account.address, amount]);
    await write("TestToken", token, "approve", [pool, amount]);
  }
  await write("TestPool", pool, "seed", [1_000_000n * 10n ** 18n, 100_000n * 10n ** 6n]);
  await write("TestToken", whsk, "mint", [vault, 100n * 10n ** 18n]);
  await write("TestToken", usdt, "mint", [vault, 10n * 10n ** 6n]);
  await write("HoldfastVault", vault, "setLimits", [whsk, 10n * 10n ** 18n, 50n * 10n ** 18n, 90_000n, 50n * 10n ** 18n]);
  await write("HoldfastVault", vault, "setLimits", [usdt, 1_000_000n, 5_000_000n, 9n * 10n ** 30n, 5_000_000n]);
  const market = { generation: 3, chainId: id, whsk, usdt, pool, router, quoter, vault, gasUsed: gas.toString(), feeWei: fee.toString() };
  if (persist) { mkdirSync("data", { recursive: true }); writeFileSync(testMarketFile(), JSON.stringify(market, null, 2)); }
  console.log(`Deployment and setup: ${gas} gas, ${formatEther(fee)} HSK; at 1 gwei: ${formatEther(gas * 1_000_000_000n)} HSK`);
  return market;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes("--broadcast")) {
    console.log("DRY RUN: no transactions sent, no manifest written. Six contracts, seed with minted tokens, fund vault, set limits. Run npm run e2e:testmarket for measured local gas. Public testnet deployment not yet run.");
  } else {
    try {
      process.loadEnvFile();
    } catch {
      // A .env file is optional; the environment may already be set.
    }
    if (networkProfile().network !== "testnet") throw new Error("Set NETWORK=testnet");
    const key = process.env.OWNER_PRIVATE_KEY as Hex | undefined;
    if (!key) throw new Error("OWNER_PRIVATE_KEY must be provided in the environment");
    const agent = process.env.AGENT_PRIVATE_KEY ? privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hex).address : undefined;
    await deployTestMarket(process.env.RPC_URL ?? networkProfile().rpcUrl, key, agent);
  }
}
