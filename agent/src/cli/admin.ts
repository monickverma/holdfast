// Owner actions, signed by your own key from .env. Dry run by default; add --broadcast to send.
//   deploy   --agent <address>
//   limits   --max-trade-hsk 150 --lifetime-hsk 2000 --max-trade-usdt 12 --lifetime-usdt 160 --band-bps 500
//   fund     --hsk 100 --usdt 10
//   withdraw --token whsk|usdt --amount 1.5 --to <address>
//   pause | unpause
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  http,
  parseAbi,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, HSKSWAP, loadConfig } from "../config.js";
import { readHead, readMarket, VAULT_ABI } from "../reader.js";
import { RpcClient } from "../rpc.js";

try {
  process.loadEnvFile();
} catch {
  // A .env file is optional; the environment may already be set.
}

const TOKEN_ABI = parseAbi(["function deposit() payable", "function transfer(address,uint256) returns (bool)"]);
const E18 = 10n ** 18n;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    broadcast: { type: "boolean", default: false },
    agent: { type: "string" },
    "max-trade-hsk": { type: "string", default: "150" },
    "lifetime-hsk": { type: "string", default: "2000" },
    "max-trade-usdt": { type: "string", default: "12" },
    "lifetime-usdt": { type: "string", default: "160" },
    "band-bps": { type: "string", default: "500" },
    hsk: { type: "string" },
    usdt: { type: "string" },
    token: { type: "string" },
    amount: { type: "string" },
    to: { type: "string" },
  },
});

const config = loadConfig();
const key = process.env.OWNER_PRIVATE_KEY as Hex | undefined;
if (!key) throw new Error("Set OWNER_PRIVATE_KEY in your local .env");
const owner = privateKeyToAccount(key);
const chain = defineChain({
  id: config.chainId,
  name: config.chainId === CHAIN_ID ? "HSK Chain" : "chain",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(config.rpcUrl), pollingInterval: 500 });
const wallet = createWalletClient({ account: owner, chain, transport: http(config.rpcUrl) });

interface Step {
  label: string;
  to?: Address;
  data: Hex;
  value?: bigint;
}

function vaultAddress(): Address {
  if (!config.vault) throw new Error("Set VAULT_ADDRESS in your local .env");
  return config.vault;
}

function vaultCall(label: string, functionName: string, args: unknown[]): Step {
  return { label, to: vaultAddress(), data: encodeFunctionData({ abi: VAULT_ABI as Abi, functionName, args }) };
}

/** Sends in order, or in a dry run estimates each one against the live chain and sends nothing. */
async function run(steps: Step[]): Promise<void> {
  const gasPrice = await client.getGasPrice();
  const balance = await client.getBalance({ address: owner.address });
  console.log(`owner ${owner.address}, balance ${formatEther(balance)} HSK, gas price ${gasPrice} wei`);
  for (const step of steps) {
    const call = { account: owner.address, data: step.data, ...(step.to ? { to: step.to } : {}), ...(step.value ? { value: step.value } : {}) };
    if (!values.broadcast) {
      try {
        const gas = await client.estimateGas(call as never);
        console.log(`would send: ${step.label}, gas ${gas}, about ${formatEther(gas * gasPrice)} HSK`);
      } catch (error) {
        const first = String(error instanceof Error ? error.message : error).split("\n")[0];
        console.log(`would send: ${step.label}, estimate failed: ${first}`);
      }
      continue;
    }
    const hash = await wallet.sendTransaction({ ...call, account: owner, chain } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`${receipt.status === "success" ? "ok" : "REVERTED"}: ${step.label}, block ${receipt.blockNumber}, gas ${receipt.gasUsed}, tx ${hash}`);
    if (receipt.status !== "success") throw new Error(`${step.label} reverted`);
    if (receipt.contractAddress) {
      console.log(`\nVAULT_ADDRESS=${receipt.contractAddress}\nPut that line in your .env. Explorer: https://hsk.blockscout.com/address/${receipt.contractAddress}`);
      console.log(`Verify source: node scripts/forge.mjs verify-contract ${receipt.contractAddress} contracts/HoldfastVault.sol:HoldfastVault --verifier blockscout --verifier-url https://hsk.blockscout.com/api/ --chain ${config.chainId} --compiler-version 0.8.28 --num-of-optimizations 2000 --evm-version cancun --constructor-args $(tools/foundry/cast abi-encode "constructor(address,address,address,address,address,uint24)" ${owner.address} ${values.agent} ${HSKSWAP.router} ${HSKSWAP.whsk} ${HSKSWAP.usdt} ${HSKSWAP.fee})`);
    }
  }
  if (!values.broadcast) console.log("\nDry run: nothing was sent. Add --broadcast to send.");
}

const required = (name: keyof typeof values): string => {
  const value = values[name];
  if (typeof value !== "string") throw new Error(`--${name} is required`);
  return value;
};

switch (positionals[0]) {
  case "deploy": {
    const agent = required("agent") as Address;
    if (agent.toLowerCase() === owner.address.toLowerCase()) throw new Error("The agent must be a different key from the owner.");
    const artifact = JSON.parse(readFileSync("out/HoldfastVault.sol/HoldfastVault.json", "utf8"));
    const data = encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [owner.address, agent, HSKSWAP.router, HSKSWAP.whsk, HSKSWAP.usdt, HSKSWAP.fee],
    });
    await run([{ label: "deploy HoldfastVault", data }]);
    break;
  }
  case "limits": {
    const rpc = new RpcClient(config.rpcUrl);
    const market = await readMarket(rpc, { twapWindowSec: config.twapWindowSec }, await readHead(rpc), []);
    rpc.close();
    const band = 10_000n - BigInt(required("band-bps"));
    const sellFloor = (market.spotPriceX18 * band) / 10_000n;
    const buyFloor = ((E18 * E18) / market.spotPriceX18) * band / 10_000n;
    console.log(`spot ${market.spotPriceX18} micro-USDT per HSK. Floors: sell at ${sellFloor}, buy at ${buyFloor} (out per 1e18 in).`);
    await run([
      vaultCall("set WHSK limits", "setLimits", [HSKSWAP.whsk, parseUnits(required("max-trade-hsk"), 18), parseUnits(required("lifetime-hsk"), 18), sellFloor]),
      vaultCall("set USDT limits", "setLimits", [HSKSWAP.usdt, parseUnits(required("max-trade-usdt"), 6), parseUnits(required("lifetime-usdt"), 6), buyFloor]),
    ]);
    break;
  }
  case "fund": {
    const vault = vaultAddress();
    const steps: Step[] = [];
    if (values.hsk) {
      const amount = parseUnits(values.hsk, 18);
      if (process.env.NETWORK === "testnet") throw new Error("Test WHSK is freely minted; use deploy-test-market, never wrap native HSK");
      steps.push({ label: `wrap ${values.hsk} HSK`, to: HSKSWAP.whsk, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "deposit" }), value: amount });
      steps.push({ label: `send ${values.hsk} WHSK to the vault`, to: HSKSWAP.whsk, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "transfer", args: [vault, amount] }) });
    }
    if (values.usdt) {
      steps.push({ label: `send ${values.usdt} USDT to the vault`, to: HSKSWAP.usdt, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "transfer", args: [vault, parseUnits(values.usdt, 6)] }) });
    }
    await run(steps);
    break;
  }
  case "withdraw": {
    const isWhsk = required("token") === "whsk";
    const amount = parseUnits(required("amount"), isWhsk ? 18 : 6);
    await run([vaultCall(`withdraw ${values.amount} ${values.token}`, "withdraw", [isWhsk ? HSKSWAP.whsk : HSKSWAP.usdt, required("to"), amount])]);
    break;
  }
  case "pause":
    await run([vaultCall("pause", "pause", [])]);
    break;
  case "unpause":
    await run([vaultCall("unpause", "unpause", [])]);
    break;
  default:
    throw new Error("Commands: deploy, limits, fund, withdraw, pause, unpause");
}
