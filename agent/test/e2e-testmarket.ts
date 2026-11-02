// Local Anvil only. Public default Anvil test keys; never use with real funds.
import { deployTestMarket } from "../src/cli/deploy-test-market.js";
import { runDeploy } from "../src/cli/deploy-vault.js";
import { exportRecords } from "../src/cli/export-records.js";
import { collect, judge, parseRecords } from "../src/cli/verify-history.js";
import { strategyHashOf } from "../src/agent.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const PORT = 8601;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const HSK = 10n ** 18n;
const USDT = 10n ** 6n;
const WHSK_ABI = parseAbi(["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

const localAnvil = "tools/foundry/anvil.exe";
const anvil = spawn(existsSync(localAnvil) ? localAnvil : "anvil", ["--chain-id", "31337", "--gas-price", "1000000000", "--port", String(PORT), "--block-time", "1", "--silent"], { stdio: "ignore" });

anvil.on("error", (error) => { console.error(error); process.exit(1); });
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
    id: 31337,
    name: "hsk-fork",
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const client = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 200 });
  const ownerKey: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const agentKey: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const owner = privateKeyToAccount(ownerKey);
  const agentAddress = privateKeyToAccount(agentKey).address;
  for (const who of [owner.address, agentAddress]) await probe.call("anvil_setBalance", [who, `0x${parseEther("0.1").toString(16)}`]);
  const wallet = createWalletClient({ account: owner, chain, transport: http(RPC_URL) });
  const send = async (hash: Hex) => client.waitForTransactionReceipt({ hash });

  // Outside data/: a local chain must never replace the public manifest or appear as testnet evidence.
  const dataDir = mkdtempSync(join(tmpdir(), "holdfast-testmarket-"));
  process.env.TEST_MARKET_FILE = join(dataDir, "market.json");
  process.env.TEST_MARKET_LOCAL = "1";
  const deployed = await deployTestMarket(RPC_URL, ownerKey, agentAddress);
  const vault = deployed.vault;
  process.env.NETWORK = "testnet";

  const balance = (token: Address) => client.readContract({ address: token, abi: WHSK_ABI, functionName: "balanceOf", args: [vault] });

  let policy: Policy = DEFAULT_POLICY;
  mkdirSync("data", { recursive: true });
  const base = { ...loadConfig({ NETWORK: "testnet", CHAIN_ID: "31337" }), rpcUrl: RPC_URL, dataDir, vault, agentKey, pollMs: 300 };
  const makeAgent = (live: boolean) => new Agent({ config: { ...base, live }, lane: "testnet", policy: () => policy, mark: () => null });

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
  assert.equal(await balance(HSKSWAP.whsk), 100n * HSK);
  observer.close();
  ok("observe mode reaches a trade decision and sends nothing");

  // A real swap through the test router, then the order stops.
  policy = { ...DEFAULT_POLICY, version: 3, orders: [{ id: "sell", kind: "market-sell", amountIn: 10n * HSK }] };
  const agent = makeAgent(true);
  await stepUntil(agent, settled(agent, "order:3:sell:0"));
  const sold = agent.ledger.get("order:3:sell:0")!;
  assert.equal(sold.status, "included");
  assert.equal(await balance(HSKSWAP.whsk), 90n * HSK);
  assert.equal(await balance(HSKSWAP.usdt), 10n * USDT + sold.amountOut!);
  assert.ok(sold.amountOut! >= sold.minOut);
  console.log(`vault swap gas ${sold.gasUsed}, fee ${sold.feeWei} wei, out ${sold.amountOut}, included ${sold.blockNumber! - sold.broadcastBlock!} blocks after broadcast`);
  for (let i = 0; i < 4; i++) {
    await agent.step();
    await sleep(400);
  }
  assert.equal(agent.ledger.all().length, 1);
  ok("market sell fills through the test router, pays the vault, and fires once");

  // The other direction, with the proceeds.
  const usdtHeld = await balance(HSKSWAP.usdt);
  const buyAmount = 500_000n;
  policy = { ...DEFAULT_POLICY, version: 4, orders: [{ id: "buy", kind: "market-buy", amountIn: buyAmount }] };
  await stepUntil(agent, settled(agent, "order:4:buy:0"));
  assert.equal(agent.ledger.get("order:4:buy:0")!.status, "included");
  assert.equal(await balance(HSKSWAP.usdt), usdtHeld - buyAmount);
  ok("market buy spends USDT, including the approve and reset");

  // Stop-loss, with a trigger above the market so it holds at once. Needs two blocks to confirm.
  policy = { ...DEFAULT_POLICY, version: 5, orders: [{ id: "stop", kind: "stop-loss", amountIn: 5n * HSK, triggerPriceX18: 1_000_000n }] };
  const codes: string[] = [];
  const stopAgent = new Agent({
    config: { ...base, live: true },
    lane: "testnet",
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

  // A policy other than the pinned one holds, and the pinned one trades. Both through the real agent loop.
  const pinnedConfig = { ...base, live: true, pinnedStrategy: true };
  const heldCodes: string[] = [];
  policy = { ...DEFAULT_POLICY, version: 6, orders: [{ id: "pinned", kind: "market-sell", amountIn: 1n * HSK }] };
  const pinned = new Agent({ config: pinnedConfig, lane: "testnet", policy: () => policy, mark: () => null, onDecision: (r) => { if (r.decision.action === "hold") heldCodes.push(r.decision.code); } });
  await send(await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "setStrategyPin", args: [`0x${"ab".repeat(32)}`] }));
  await stepUntil(pinned, () => heldCodes.includes("strategy-not-pinned"));
  assert.equal(pinned.ledger.get("order:6:pinned:0"), undefined);
  ok("a policy the owner did not pin holds and signs nothing");
  pinned.close();
  await send(await wallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "setStrategyPin", args: [strategyHashOf(policy)] }));
  const pinnedAgain = new Agent({ config: pinnedConfig, lane: "testnet", policy: () => policy, mark: () => null });
  await stepUntil(pinnedAgain, settled(pinnedAgain, "order:6:pinned:0"));
  assert.equal(pinnedAgain.ledger.get("order:6:pinned:0")!.status, "included");
  ok("the pinned policy trades");
  pinnedAgain.close();

  // Anchoring through the agent's own loop, then the independent verifier against everything this chain has done so far.
  const logCount = () => client.readContract({ address: vault, abi: VAULT_ABI, functionName: "logCount" });
  const countBefore = await logCount();
  const anchorer = new Agent({ config: { ...base, live: true, anchorIntervalSec: 1 }, lane: "testnet", policy: () => policy, mark: () => null });
  await stepUntil(anchorer, () => anchorer.anchorsSent > 0);
  for (let i = 0; i < 40 && (await logCount()) === countBefore; i++) await sleep(250);
  assert.equal(await logCount(), countBefore + 1n);
  ok("the agent commits its local log to the vault");
  anchorer.close();

  const recordsPath = join(dataDir, "records.jsonl");
  assert.ok(exportRecords(dataDir, recordsPath) >= 4);
  const logPath = join(dataDir, "decisions.jsonl");
  const verify = async (records: string, log: string, fromBlock = 0n, address: Address = vault) => {
    const evidence = await collect({ rpcUrl: RPC_URL, vault: address, fromBlock, records: parseRecords(records), localLog: log });
    return judge(evidence);
  };
  const recordsText = readFileSync(recordsPath, "utf8");
  const logText = readFileSync(logPath, "utf8");
  const clean = await verify(recordsText, logText);
  assert.equal(clean.status, "PASS", JSON.stringify(clean.findings));
  assert.ok(clean.checked.trades >= 4 && clean.checked.tradesMatched === clean.checked.trades, JSON.stringify(clean.checked));
  console.log(`verifier on the local vault: ${JSON.stringify(clean.checked)}`);
  mkdirSync("evidence/v4", { recursive: true });
  writeFileSync("evidence/v4/verify-local.json", `${JSON.stringify({ wallTime: new Date().toISOString(), lane: "local", where: "A vault on a local Anvil chain with a test market, not a public network.", ...clean }, null, 2)}\n`);
  ok("the verifier passes a real history: events, receipts, transfers, records, market reads and the local log");

  const lines = recordsText.trim().split("\n");
  const edited = JSON.parse(lines[0]!) as { body: string };
  edited.body = edited.body.replace(/"reason":"[^"]*"/, '"reason":"a better story"');
  assert.equal((await verify([JSON.stringify(edited), ...lines.slice(1)].join("\n"), logText)).status, "FAIL");
  const claimed = JSON.parse(lines[0]!) as { amountOut: string };
  claimed.amountOut = "1";
  assert.equal((await verify([JSON.stringify(claimed), ...lines.slice(1)].join("\n"), logText)).status, "FAIL");
  const logLines = logText.trim().split("\n");
  assert.equal((await verify(recordsText, `${logLines.slice(1).join("\n")}\n`)).status, "FAIL");
  ok("the verifier fails an edited record, an overstated output and a log with a record removed");

  assert.equal((await verify(lines.slice(1).join("\n"), logText)).status, "INCOMPLETE");
  assert.equal((await verify(recordsText, logText, await client.getBlockNumber())).status, "INCOMPLETE");
  const tailed = join(dataDir, "tail.jsonl");
  writeFileSync(tailed, logText);
  const lastLine = JSON.parse(logLines.at(-1)!) as { hash: Hex; seq: number };
  const { keccak256, stringToHex } = await import("viem");
  const tailBody = { wallTime: "later", note: "not committed" };
  appendFileSync(tailed, `${JSON.stringify({ seq: lastLine.seq + 1, prev: lastLine.hash, hash: keccak256(stringToHex(`${lastLine.seq + 1}|${lastLine.hash}|${JSON.stringify(tailBody)}`)), ...tailBody })}\n`);
  const tail = await verify(recordsText, readFileSync(tailed, "utf8"));
  assert.equal(tail.status, "INCOMPLETE");
  assert.ok(tail.findings.some((f) => f.code === "UNANCHORED_TAIL"));
  ok("the verifier says incomplete for a missing record, a late starting block and an uncommitted tail");

  const restarted = makeAgent(true);
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
    ["over the trade cap", { amountIn: 11n * HSK, minOut: 11n * 90_000n }, "OverTradeCap"],
  ];
  for (const [name, change, expected] of attacks) {
    const key = `attack:${name}`;
    const intent = await restarted.executor!.submit(key, { ...rogue, ...change }, market, new Trace(key, "testnet"));
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

  // The deployment command, against a real node: a dry run sends nothing, and a broadcast is checked and recorded.
  const deployEnv = { NETWORK: "testnet", CHAIN_ID: "31337", RPC_URL: RPC_URL, VAULT_GENERATION: "3" };
  const deployArgs = ["--owner", owner.address, "--agent", agentAddress];
  const deployRecord = join(dataDir, "vault-deployment.json");
  const nonceBefore = await client.getTransactionCount({ address: owner.address });
  assert.equal(await runDeploy(deployArgs, deployEnv), 0);
  assert.equal(await client.getTransactionCount({ address: owner.address }), nonceBefore);
  ok("a deployment dry run sends nothing");
  assert.equal(await runDeploy([...deployArgs, "--broadcast"], deployEnv), 1);
  assert.equal(await runDeploy([...deployArgs, "--broadcast", "--out", deployRecord], { ...deployEnv, OWNER_PRIVATE_KEY: agentKey }), 1);
  assert.equal(await client.getTransactionCount({ address: owner.address }), nonceBefore);
  ok("a broadcast with no key, or with a key that is not the owner's, sends nothing");
  assert.equal(await runDeploy([...deployArgs, "--broadcast", "--out", deployRecord], { ...deployEnv, OWNER_PRIVATE_KEY: ownerKey }), 0);
  const deployment = JSON.parse(readFileSync(deployRecord, "utf8"));
  assert.equal(deployment.status, "verified");
  assert.equal(deployment.runtimeMatchesBuild, true);
  assert.ok(deployment.immutableSlotsMasked > 0);
  assert.equal(await client.readContract({ address: deployment.vault, abi: VAULT_ABI, functionName: "agent" }), agentAddress);
  ok("a broadcast deploys, matches its runtime code to the build, and records it");
  const recorded = readFileSync(deployRecord, "utf8");
  assert.equal(await runDeploy([...deployArgs, "--broadcast", "--out", deployRecord], { ...deployEnv, OWNER_PRIVATE_KEY: ownerKey }), 1);
  assert.equal(readFileSync(deployRecord, "utf8"), recorded);
  ok("a deployment record is never replaced");

  const nothing = await verify("", "", 0n, deployment.vault);
  assert.equal(nothing.status, "INCOMPLETE");
  assert.ok(nothing.findings.some((f) => f.code === "NOTHING_TO_VERIFY"));
  ok("the verifier does not pass a vault with no history");

  const ms = readFileSync(join(dataDir, "traces.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .flatMap((t) => { const ms = t.attrs.decisionToBroadcastMs ?? t.attrs.decisionToReceiptMs; return ms ? [ms as number] : []; });
  console.log(`local test-market decision to send or receipt: n=${ms.length} P50=${nearestRank(ms, 0.5).toFixed(1)}ms max=${Math.max(...ms).toFixed(1)}ms (local Anvil testnet lane, not public-network latency)`);
  console.log(`Trading/refusal gas total: ${restarted.ledger.all().reduce((n, i) => n + (i.gasUsed ?? 0n), 0n)}`);
  restarted.close();
  probe.close();
  console.log(`\n${passed} scenarios passed`);
} finally {
  anvil.kill();
}
