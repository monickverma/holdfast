// Testnet only. Acts as a compromised agent: skips every off-chain check, so only the vault can stop these.
//   NETWORK=testnet refusals -- --broadcast
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Agent } from "../agent.js";
import { HSKSWAP, loadConfig, networkProfile } from "../config.js";
import { DEFAULT_POLICY } from "../policy.js";
import { VAULT_ABI, readHead, readMarket } from "../reader.js";
import { sleep } from "../rpc.js";
import { Trace } from "../trace.js";

try {
  process.loadEnvFile();
} catch {
  // A .env file is optional; the environment may already be set.
}

const profile = networkProfile();
if (profile.network !== "testnet") throw new Error("Set NETWORK=testnet");
const { values } = parseArgs({ options: { broadcast: { type: "boolean", default: false } } });
if (!values.broadcast) throw new Error("This sends transactions that should revert. Add --broadcast only when you mean it.");

const config = { ...loadConfig(), live: true };
if (!config.vault || !config.agentKey) throw new Error("Set AGENT_PRIVATE_KEY in your local .env and deploy the test market first");

const run = Date.now();
const HSK = 10n ** 18n;
const agent = new Agent({ config, lane: profile.lane, policy: () => DEFAULT_POLICY, mark: () => null });
const link = (hash: string) => `${profile.explorer}/tx/${hash}`;
let failed = 0;

try {
  const market = await readMarket(agent.rpc, config, await readHead(agent.rpc), []);
  const rogue = {
    action: "trade" as const,
    trigger: "market" as const,
    orderId: null,
    tokenIn: HSKSWAP.whsk as Address,
    amountIn: 10n * HSK,
    quotedOut: 0n,
    minOut: 0n,
    ledger: { inputValue: null, outputValue: null, networkCost: 0n, net: null },
    reason: "refusal demo",
  };
  const attacks: Array<[string, Partial<typeof rogue>, string]> = [
    ["zero-min-output", { minOut: 0n }, "BelowFloor"],
    ["over-trade-cap", { amountIn: 11n * HSK, minOut: 11n * 90_000n }, "OverTradeCap"],
  ];
  for (const [name, change, expected] of attacks) {
    const key = `refusal:${run}:${name}`;
    await agent.executor!.submit(key, { ...rogue, ...change }, market, new Trace(key, profile.lane));
    for (let i = 0; i < 120 && !["included", "reverted"].includes(agent.ledger.get(key)!.status); i++) {
      await agent.settleInFlight();
      await sleep(500);
    }
    const outcome = agent.ledger.get(key)!;
    const pass = outcome.status === "reverted" && outcome.revertReason === expected;
    if (!pass) failed++;
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${outcome.status}, reason ${outcome.revertReason ?? "none"}, expected ${expected}\n${link(outcome.txHash!)}`);
  }

  // Withdrawal is not an execute call, so it has no ledger row. It has its own explorer link.
  const chain = defineChain({ id: config.chainId, name: "HSK testnet", nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
  const transport = http(config.rpcUrl);
  const account = privateKeyToAccount(config.agentKey as Hex);
  const client = createPublicClient({ chain, transport, pollingInterval: 500 });
  const wallet = createWalletClient({ account, chain, transport });
  const hash = await wallet.writeContract({ address: config.vault, abi: VAULT_ABI, functionName: "withdraw", args: [HSKSWAP.whsk, account.address, 1n], gas: 200_000n, nonce: agent.ledger.lastNonce()! + 1 });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "reverted") failed++;
  console.log(`${receipt.status === "reverted" ? "PASS" : "FAIL"} agent-withdraw: ${receipt.status}\n${link(hash)}`);
} finally {
  agent.close();
}
if (failed) process.exit(1);
