// Owner actions, signed by your own key from .env. Dry run by default; add --broadcast to send.
//   deploy   --agent <address> --days 7
//   renew    --days 7, or --agent <address> to replace the key. Recheck the floors with `limits` when you do.
//   limits   --max-trade-hsk 150 --lifetime-hsk 2000 --hourly-hsk 300 --max-trade-usdt 12 --lifetime-usdt 160 --hourly-usdt 24 --band-bps 500
//   fund     --hsk 100 --usdt 10
//   withdraw --token whsk|usdt --amount 1.5 --to <address>
//   pause | unpause
//   guard    --window 600 --band-ticks 100, or --window 0 to turn it off
//   daily    --token whsk|usdt --amount 400, or --amount 0 to remove the cap
//   guardian --address <address>, or the zero address to remove it
//   loss     --mark 0.087 --amount 1 --max-age 86400, a daily loss budget in USDT against your own price, or --mark 0 to turn it off
//   stop     --token whsk --trigger-price 0.08 --tranche 50 --total 200 --floor-price 0.05 --band-ticks 500 --cooldown 300
//   disarm | halt | revoke
//   offer-ownership --to <address>, then accept-ownership signed by that address
// On mainnet, --broadcast also needs --confirm-mainnet.
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
import { assertChainForBroadcast, explorerFor } from "../chain-guard.js";
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
    "confirm-mainnet": { type: "boolean", default: false },
    agent: { type: "string" },
    window: { type: "string" },
    "band-ticks": { type: "string" },
    address: { type: "string" },
    "trigger-price": { type: "string" },
    tranche: { type: "string" },
    total: { type: "string" },
    "floor-price": { type: "string" },
    cooldown: { type: "string", default: "300" },
    "max-trade-hsk": { type: "string", default: "150" },
    "lifetime-hsk": { type: "string", default: "2000" },
    "max-trade-usdt": { type: "string", default: "12" },
    "lifetime-usdt": { type: "string", default: "160" },
    "hourly-hsk": { type: "string", default: "300" },
    "hourly-usdt": { type: "string", default: "24" },
    days: { type: "string", default: "7" },
    "band-bps": { type: "string", default: "500" },
    hsk: { type: "string" },
    usdt: { type: "string" },
    token: { type: "string" },
    amount: { type: "string" },
    to: { type: "string" },
    mark: { type: "string" },
    "max-age": { type: "string", default: "86400" },
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
  const rpcChainId = await client.getChainId();
  // A dry run on the wrong chain would estimate against the wrong vault, so this holds for both.
  if (rpcChainId !== config.chainId) throw new Error(`The RPC is chain ${rpcChainId}, but this run is configured for ${config.chainId}. Nothing was sent.`);
  if (values.broadcast) assertChainForBroadcast(rpcChainId, config.chainId, values["confirm-mainnet"]!);
  console.log(`chain ${rpcChainId}${rpcChainId === CHAIN_ID ? " (mainnet, real funds)" : ""}`);
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
      const explorer = explorerFor(config.chainId);
      console.log(`\nVAULT_ADDRESS=${receipt.contractAddress}\nVAULT_GENERATION=3\nPut those lines in your .env.${explorer ? ` Explorer: ${explorer}/address/${receipt.contractAddress}` : ""}`);
      if (explorer) console.log(`Verify source: node scripts/forge.mjs verify-contract ${receipt.contractAddress} contracts/HoldfastVault.sol:HoldfastVault --verifier blockscout --verifier-url ${explorer}/api/ --chain`);
      if (explorer) console.log(`  ${config.chainId} --compiler-version 0.8.28 --num-of-optimizations 2000 --evm-version cancun --constructor-args $(tools/foundry/cast abi-encode "constructor(address,address,uint256,address,address,address,uint24)" ${owner.address} ${values.agent} ${deployExpiry} ${HSKSWAP.router} ${HSKSWAP.whsk} ${HSKSWAP.usdt} ${HSKSWAP.fee})`);
    }
  }
  if (!values.broadcast) console.log("\nDry run: nothing was sent. Add --broadcast to send.");
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** USDT per HSK, as the pool's tick. WHSK is token0, and the tick counts USDT micro-units per wei. */
function tickForPrice(price: string): number {
  const perWei = Number(price) * 1e6 / 1e18;
  return Math.floor(Math.log(perWei) / Math.log(1.0001));
}

const required = (name: keyof typeof values): string => {
  const value = values[name];
  if (typeof value !== "string") throw new Error(`--${name} is required`);
  return value;
};

const expiryFromNow = (): bigint => BigInt(Math.floor(Date.now() / 1000)) + BigInt(Number(required("days")) * 86_400);
let deployExpiry = 0n;

switch (positionals[0]) {
  case "deploy": {
    const agent = required("agent") as Address;
    if (agent.toLowerCase() === owner.address.toLowerCase()) throw new Error("The agent must be a different key from the owner.");
    const artifact = JSON.parse(readFileSync("out/HoldfastVault.sol/HoldfastVault.json", "utf8"));
    deployExpiry = expiryFromNow();
    const data = encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [owner.address, agent, deployExpiry, HSKSWAP.router, HSKSWAP.whsk, HSKSWAP.usdt, HSKSWAP.fee],
    });
    await run([{ label: "deploy HoldfastVault", data }]);
    break;
  }
  case "renew": {
    const current = await client.readContract({ address: vaultAddress(), abi: VAULT_ABI, functionName: "agent" });
    await run([vaultCall(`trust the agent key for ${values.days} more days`, "setAgent", [values.agent ?? current, expiryFromNow()])]);
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
    // Conditional on what was just read, on a vault that can do that: a trade landing first must not be overwritten.
    const version = await client.readContract({ address: vaultAddress(), abi: VAULT_ABI, functionName: "VERSION" }).catch(() => 0n);
    const limit = async (label: string, token: Address, args: [bigint, bigint, bigint, bigint]) => {
      if (version < 3n) return vaultCall(label, "setLimits", [token, ...args]);
      const expected = await client.readContract({ address: vaultAddress(), abi: VAULT_ABI, functionName: "remaining", args: [token] });
      return vaultCall(label, "setLimitsIfRemaining", [token, ...args, expected]);
    };
    await run([
      await limit("set WHSK limits", HSKSWAP.whsk, [parseUnits(required("max-trade-hsk"), 18), parseUnits(required("lifetime-hsk"), 18), sellFloor, parseUnits(required("hourly-hsk"), 18)]),
      await limit("set USDT limits", HSKSWAP.usdt, [parseUnits(required("max-trade-usdt"), 6), parseUnits(required("lifetime-usdt"), 6), buyFloor, parseUnits(required("hourly-usdt"), 6)]),
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
  case "guard": {
    const window = Number(required("window"));
    if (window === 0) {
      await run([vaultCall("turn off the price guard, which also disarms the stop", "setPriceGuard", [ZERO, 0, 0])]);
      break;
    }
    await run([vaultCall(`guard: stay within ${required("band-ticks")} ticks of the ${window} s TWAP`, "setPriceGuard", [HSKSWAP.pool, window, Number(required("band-ticks"))])]);
    break;
  }
  case "daily": {
    const isWhsk = required("token") === "whsk";
    await run([vaultCall(`daily budget of ${required("amount")} ${values.token}`, "setDailyBudget", [isWhsk ? HSKSWAP.whsk : HSKSWAP.usdt, parseUnits(required("amount"), isWhsk ? 18 : 6)])]);
    break;
  }
  case "guardian":
    await run([vaultCall(`guardian ${required("address")}`, "setGuardian", [required("address")])]);
    break;
  case "loss": {
    if (Number(required("mark")) === 0) {
      await run([vaultCall("turn off the loss guard", "setLossGuard", [0n, 0n, 0])]);
      break;
    }
    await run([vaultCall(`loss budget: ${required("amount")} USDT a day against a mark of ${required("mark")}, good for ${required("max-age")} s`, "setLossGuard", [parseUnits(required("mark"), 6), parseUnits(required("amount"), 6), Number(required("max-age"))])]);
    break;
  }
  case "stop": {
    if (required("token") !== "whsk") throw new Error("A stop here sells WHSK. A stop on the other side has no trigger price in these units yet: call armStop directly.");
    const trigger = tickForPrice(required("trigger-price"));
    const floor = parseUnits(required("floor-price"), 6);
    const total = parseUnits(required("total"), 18);
    console.log(`trigger ${required("trigger-price")} USDT per HSK is tick ${trigger}. The worst this sells at is ${required("floor-price")}, for ${required("total")} HSK.`);
    await run([vaultCall("arm the stop", "armStop", [HSKSWAP.whsk, trigger, parseUnits(required("tranche"), 18), total, floor, Number(required("band-ticks")), Number(required("cooldown"))])]);
    break;
  }
  case "disarm":
    await run([vaultCall("disarm the stop", "disarmStop", [])]);
    break;
  case "halt":
    await run([vaultCall("halt: pause and disarm", "halt", [])]);
    break;
  case "revoke":
    await run([vaultCall("end the agent key now", "revokeAgent", [])]);
    break;
  case "offer-ownership":
    await run([vaultCall(`offer ownership to ${required("to")}`, "transferOwnership", [required("to")])]);
    break;
  case "accept-ownership":
    await run([vaultCall("accept ownership", "acceptOwnership", [])]);
    break;
  default:
    throw new Error("Commands: deploy, renew, limits, fund, withdraw, pause, unpause, guard, daily, guardian, loss, stop, disarm, halt, revoke, offer-ownership, accept-ownership");
}
