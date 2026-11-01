// End-to-end run on a local Anvil fork of mainnet with throwaway keys. Nothing reaches the real chain.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Agent } from "../src/agent.js";
import { CHAIN_ID, HSKSWAP, loadConfig } from "../src/config.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy.js";
import { VAULT_ABI, readHead, readMarket } from "../src/reader.js";
import { RpcClient, sleep } from "../src/rpc.js";
import { nearestRank } from "../src/stats.js";
import { Trace } from "../src/trace.js";

const PORT = 8599;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const HSK = 10n ** 18n;
const USDT = 10n ** 6n;
const WHSK_ABI = parseAbi(["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

const localAnvil = "tools/foundry/anvil.exe";
const anvil = spawn(existsSync(localAnvil) ? localAnvil : "anvil", ["--fork-url", "https://mainnet.hsk.xyz", "--port", String(PORT), "--block-time", "1", "--silent"], { stdio: "ignore" });

let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`PASS ${name}`);
}

try {
  const probe = new RpcClient(RPC_URL, { maxRetries: 0 });
  for (let i = 0; ; i++) {
    try {
      await probe.call("eth_chainId");
      break;
    } catch (error) {
      if (i > 60) throw error;
      await sleep(500);
    }
  }

  const chain = defineChain({
    id: CHAIN_ID,
    name: "hsk-fork",
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const client = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 200 });
  const ownerKey = generatePrivateKey();
  const agentKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const agentAddress = privateKeyToAccount(agentKey).address;
  for (const who of [owner.address, agentAddress]) await probe.call("anvil_setBalance", [who, `0x${parseEther("1000").toString(16)}`]);
  const wallet = createWalletClient({ account: owner, chain, transport: http(RPC_URL) });
  const send = async (hash: Hex) => client.waitForTransactionReceipt({ hash });

  const artifact = JSON.parse(readFileSync("out/HoldfastVault.sol/HoldfastVault.json", "utf8"));
  const deployed = await send(
    await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [owner.address, agentAddress, BigInt(Math.floor(Date.now() / 1000)) + 86_400n * 29n, HSKSWAP.router, HSKSWAP.whsk, HSKSWAP.usdt, HSKSWAP.fee],
    }),
  );
  const vault = deployed.contractAddress as Address;
  console.log(`vault deployed, gas ${deployed.gasUsed}`);

  await send(await wallet.writeContract({ address: HSKSWAP.whsk, abi: WHSK_ABI, functionName: "deposit", value: 300n * HSK }));
  await send(await wallet.writeContract({ address: HSKSWAP.whsk, abi: WHSK_ABI, functionName: "transfer", args: [vault, 300n * HSK] }));
  await send(await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "setLimits", args: [HSKSWAP.whsk, 50n * HSK, 200n * HSK, 50_000n, 200n * HSK] }));
  await send(await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "setLimits", args: [HSKSWAP.usdt, 5n * USDT, 20n * USDT, 5n * 10n ** 30n, 20n * USDT] }));

  const balance = (token: Address) => client.readContract({ address: token, abi: WHSK_ABI, functionName: "balanceOf", args: [vault] });

  let policy: Policy = DEFAULT_POLICY;
  const dataDir = mkdtempSync(join(tmpdir(), "holdfast-e2e-"));
  const base = { ...loadConfig({}), rpcUrl: RPC_URL, dataDir, vault, agentKey, pollMs: 300 };
  const makeAgent = (live: boolean) => new Agent({ config: { ...base, live }, lane: "fork", policy: () => policy, mark: () => null });

  /** Steps until `done` holds, on the same schedule the real loop uses. */
  async function stepUntil(agent: Agent, done: () => boolean | Promise<boolean>, limit = 40): Promise<void> {
    for (let i = 0; i < limit; i++) {
      await agent.step();
      if (await done()) return;
      await sleep(300);
    }
    throw new Error("condition not reached");
  }
  const settled = (agent: Agent, key: string) => () => {
    const intent = agent.ledger.get(key);
    return intent?.status === "included" || intent?.status === "reverted";
  };

  // Observe mode decides but cannot sign.
  policy = { ...DEFAULT_POLICY, version: 2, orders: [{ id: "watch", kind: "market-sell", amountIn: 10n * HSK }] };
  const observer = makeAgent(false);
  await stepUntil(observer, () => observer.lastDecision !== null && observer.lastMarket?.quotes.length === 1 && observer.lastDecision.decision.action === "trade");
  assert.equal(observer.lastDecision!.observeOnly, true);
  assert.equal(observer.ledger.all().length, 0);
  assert.equal(await balance(HSKSWAP.whsk), 300n * HSK);
  observer.close();
  ok("observe mode reaches a trade decision and sends nothing");

  // A real swap through the real router, then the order stops.
  policy = { ...DEFAULT_POLICY, version: 3, orders: [{ id: "sell", kind: "market-sell", amountIn: 10n * HSK }] };
  const agent = makeAgent(true);
  await stepUntil(agent, settled(agent, "order:3:sell:0"));
  const sold = agent.ledger.get("order:3:sell:0")!;
  assert.equal(sold.status, "included");
  assert.equal(await balance(HSKSWAP.whsk), 290n * HSK);
  assert.equal(await balance(HSKSWAP.usdt), sold.amountOut);
  assert.ok(sold.amountOut! >= sold.minOut);
  console.log(`vault swap gas ${sold.gasUsed}, fee ${sold.feeWei} wei, out ${sold.amountOut}, included ${sold.blockNumber! - sold.broadcastBlock!} blocks after broadcast`);
  for (let i = 0; i < 4; i++) {
    await agent.step();
    await sleep(400);
  }
  assert.equal(agent.ledger.all().length, 1);
  ok("market sell fills through the real router, pays the vault, and fires once");

  // The other direction, with the proceeds.
  const usdtHeld = await balance(HSKSWAP.usdt);
  policy = { ...DEFAULT_POLICY, version: 4, orders: [{ id: "buy", kind: "market-buy", amountIn: usdtHeld / 2n }] };
  await stepUntil(agent, settled(agent, "order:4:buy:0"));
  assert.equal(agent.ledger.get("order:4:buy:0")!.status, "included");
  assert.equal(await balance(HSKSWAP.usdt), usdtHeld - usdtHeld / 2n);
  ok("market buy spends USDT, including the approve and reset");

  // Stop-loss, with a trigger above the market so it holds at once. Needs two blocks to confirm.
  policy = { ...DEFAULT_POLICY, version: 5, orders: [{ id: "stop", kind: "stop-loss", amountIn: 5n * HSK, triggerPriceX18: 1_000_000n }] };
  const codes: string[] = [];
  const stopAgent = new Agent({
    config: { ...base, live: true },
    lane: "fork",
    policy: () => policy,
    mark: () => null,
    onDecision: (r) => {
      if (r.decision.action === "hold") codes.push(r.decision.code);
    },
  });
  await stepUntil(stopAgent, settled(stopAgent, "order:5:stop:0"));
  assert.equal(stopAgent.ledger.get("order:5:stop:0")!.status, "included");
  assert.ok(codes.includes("stop-unconfirmed"), codes.join());
  ok("stop-loss waits for confirmation, then sells with no model and no reference price");
  stopAgent.close();
  agent.close();

  // Crash after the signed bytes are on disk but before they reach the network.
  policy = { ...DEFAULT_POLICY, version: 6, orders: [{ id: "crash", kind: "market-sell", amountIn: 3n * HSK }] };
  const crashing = makeAgent(true);
  crashing.executor!.sendMode = "classic";
  crashing.executor!.broadcast = async () => {
    throw new Error("simulated crash");
  };
  await stepUntil(crashing, () => false, 1).catch(() => {});
  for (let i = 0; i < 20 && !crashing.ledger.get("order:6:crash:0"); i++) {
    await crashing.step().catch(() => {});
    await sleep(300);
  }
  const before = crashing.ledger.get("order:6:crash:0")!;
  assert.equal(before.status, "signed");
  const whskBefore = await balance(HSKSWAP.whsk);
  crashing.close();

  const restarted = makeAgent(true);
  const head = await readHead(restarted.rpc);
  const [recovered] = await restarted.executor!.recover(head.number);
  assert.equal(recovered!.txHash, before.txHash);
  await stepUntil(restarted, settled(restarted, "order:6:crash:0"));
  for (let i = 0; i < 4; i++) {
    await restarted.step();
    await sleep(400);
  }
  assert.equal(restarted.ledger.get("order:6:crash:0")!.status, "included");
  assert.equal(whskBefore - (await balance(HSKSWAP.whsk)), 3n * HSK);
  assert.equal(restarted.ledger.all().filter((i) => i.key.startsWith("order:6:")).length, 1);
  ok("a crash before broadcast recovers by resending identical bytes, and fills once");

  // A compromised agent bypasses every off-chain check. Only the vault is left.
  const rpc = restarted.rpc;
  const rogueHead = await readHead(rpc);
  const market = await readMarket(rpc, base, rogueHead, []);
  const rogue = {
    action: "trade" as const,
    trigger: "market" as const,
    orderId: null,
    tokenIn: HSKSWAP.whsk as Address,
    amountIn: 10n * HSK,
    quotedOut: 0n,
    minOut: 0n,
    ledger: { inputValue: null, outputValue: null, networkCost: 0n, net: null },
    reason: "attack",
  };
  const attacks: Array<[string, Partial<typeof rogue>, string]> = [
    ["zero minimum output", { minOut: 0n }, "BelowFloor"],
    ["over the trade cap", { amountIn: 51n * HSK, minOut: 51n * 50_000n }, "OverTradeCap"],
  ];
  for (const [name, change, expected] of attacks) {
    const key = `attack:${name}`;
    const intent = await restarted.executor!.submit(key, { ...rogue, ...change }, market, new Trace(key, "fork"));
    // A sync send already knows the outcome; a classic one is still waiting for it.
    assert.ok(intent.status === "broadcast" || intent.status === "reverted");
    await stepUntil(restarted, settled(restarted, key));
    const outcome = restarted.ledger.get(key)!;
    assert.equal(outcome.status, "reverted");
    assert.equal(outcome.revertReason, expected);
    ok(`vault rejects ${name} on chain, reason ${expected}`);
  }

  const agentWallet = createWalletClient({ account: privateKeyToAccount(agentKey), chain, transport: http(RPC_URL) });
  const steal = await send(await agentWallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "withdraw", args: [HSKSWAP.whsk, agentAddress, 1n], gas: 200_000n }));
  assert.equal(steal.status, "reverted");
  ok("the agent key cannot withdraw");

  const ms = readFileSync(join(dataDir, "traces.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .flatMap((t) => { const ms = t.attrs.decisionToBroadcastMs ?? t.attrs.decisionToReceiptMs; return ms ? [ms as number] : []; });
  console.log(`local fork decision-to-broadcast: n=${ms.length} P50=${nearestRank(ms, 0.5).toFixed(1)}ms max=${Math.max(...ms).toFixed(1)}ms (fork lane, not mainnet latency)`);
  restarted.close();
  probe.close();
  console.log(`\n${passed} scenarios passed`);
} finally {
  anvil.kill();
}
