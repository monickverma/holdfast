// Creates two new wallets in a local .env if none exists, then shows what each still needs. Never prints a key.
// Safe to run again: an existing .env is never overwritten.
import { existsSync, writeFileSync } from "node:fs";
import { formatUnits, parseAbi, encodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { networkProfile, MAINNET_MARKET } from "../config.js";
import { RpcClient } from "../rpc.js";

const ENV_PATH = process.env.ENV_PATH ?? ".env";
// Owner: 15 HSK of trading float plus 2 for deploy and setup. The vault gets USDT from its own first sell.
const NEED_OWNER_HSK = networkProfile().network === "testnet" ? 0.05 : 17;
// Agent: 5 swaps at about 0.0873 HSK each (174,566 gas at 500 gwei), plus margin for a revert.
const NEED_AGENT_HSK = networkProfile().network === "testnet" ? 0.05 : 1;

if (existsSync(ENV_PATH)) {
  console.log(`${ENV_PATH} already exists, so it was left unchanged.`);
} else {
  const body = `# Created by npm run setup. Back this file up somewhere private. Anyone with these keys controls the funds.
OWNER_PRIVATE_KEY=${generatePrivateKey()}
AGENT_PRIVATE_KEY=${generatePrivateKey()}
VAULT_ADDRESS=
LIVE=false
ANTHROPIC_API_KEY=
`;
  writeFileSync(ENV_PATH, body, { flag: "wx", mode: 0o600 });
  console.log(`Created ${ENV_PATH} with two new wallets.`);
}
process.loadEnvFile(ENV_PATH);

const ownerKey = process.env.OWNER_PRIVATE_KEY as Hex | undefined;
const agentKey = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
if (!ownerKey || !agentKey) throw new Error(`${ENV_PATH} needs OWNER_PRIVATE_KEY and AGENT_PRIVATE_KEY`);
const owner = privateKeyToAccount(ownerKey).address;
const agent = privateKeyToAccount(agentKey).address;

const rpc = new RpcClient(process.env.RPC_URL ?? networkProfile().rpcUrl);
const actualChain = Number(await rpc.call<string>("eth_chainId"));
if (actualChain !== networkProfile().chainId) throw new Error(`RPC chain ${actualChain} does not match profile`);
const usdtData = (who: Address) => encodeFunctionData({ abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), args: [who] });
const [ownerHsk, agentHsk, ownerUsdt] = (await rpc.batch([
  { method: "eth_getBalance", params: [owner, "latest"] },
  { method: "eth_getBalance", params: [agent, "latest"] },
  ...(networkProfile().network === "mainnet" ? [{ method: "eth_call", params: [{ to: MAINNET_MARKET.usdt, data: usdtData(owner) }, "latest"] }] : []),
])) as [string, string, string?];
rpc.close();

const hskOwner = Number(formatUnits(BigInt(ownerHsk), 18));
const hskAgent = Number(formatUnits(BigInt(agentHsk), 18));

const mark = (ok: boolean) => (ok ? "ok  " : "NEED");

console.log(`\nNetwork: HSK Chain ${networkProfile().network}, chain ID ${networkProfile().chainId}. Send only on this network.\n`);
console.log(`Owner (deploys and owns the vault): ${owner}`);
console.log(`  ${mark(hskOwner >= NEED_OWNER_HSK)} ${hskOwner} HSK, want ${NEED_OWNER_HSK}`);
if (ownerUsdt) console.log(`  info ${Number(formatUnits(BigInt(ownerUsdt), 6))} USDT, optional, token ${MAINNET_MARKET.usdt}`);
console.log(`Agent (gas only, cannot withdraw): ${agent}`);
console.log(`  ${mark(hskAgent >= NEED_AGENT_HSK)} ${hskAgent} HSK, want ${NEED_AGENT_HSK}`);

const ready = hskOwner >= NEED_OWNER_HSK && hskAgent >= NEED_AGENT_HSK;
console.log(networkProfile().network === "testnet" ? (ready ? "\nGas funded. Next: npm run deploy:testmarket (dry run). Trading float is freely minted test tokens." : "\nFund each wallet to 0.05 testnet HSK for gas.") : ready ? `\nFunded for the minimum run: 5 swaps, no tail latency claims. Next, a dry run that sends nothing:\n  npm run admin -- deploy --agent ${agent}` : "\nSend the amounts marked NEED, then run npm run setup again.");
