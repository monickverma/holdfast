// The whole mainnet procedure, on a local fork of mainnet, with throwaway keys: preflight, deploy, configure, simulate,
// trade through the real router, attack the real pool, fire the stop with the keeper, then every emergency action.
// Nothing reaches the real chain. Transaction hashes in the report exist only on the fork.
// Writes evidence/v3/rehearsal-fork.json. Run with `npm run rehearse`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Agent } from "../src/agent.js";
import { auditIntent } from "../src/cli/audit.js";
import { CHAIN_ID, HSKSWAP, loadConfig } from "../src/config.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy.js";
import { VAULT_ABI } from "../src/reader.js";
import { RpcClient, sleep } from "../src/rpc.js";

const PORT = 8603;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const HSK = 10n ** 18n;
const USDT = 10n ** 6n;
const WINDOW = 600;
const BAND = 100;
const ERC20 = parseAbi(["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const ROUTER = parseAbi(["struct P { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }", "function exactInputSingle(P p) payable returns (uint256)", "function factory() view returns (address)"]);
const POOL = parseAbi(["function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)", "function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function factory() view returns (address)", "function liquidity() view returns (uint128)"]);

const localAnvil = "tools/foundry/anvil.exe";
const anvil = spawn(existsSync(localAnvil) ? localAnvil : "anvil", ["--fork-url", "https://mainnet.hsk.xyz", "--port", String(PORT), "--block-time", "1", "--silent"], { stdio: "ignore" });

interface Step {
  name: string;
  tx?: Hex;
  gasUsed?: string;
  detail?: unknown;
}
const steps: Step[] = [];
const report: Record<string, unknown> = { wallTime: new Date().toISOString(), lane: "fork", chainId: CHAIN_ID, note: "A local Anvil fork of HSK mainnet. Hashes exist only on the fork. Nothing was broadcast to any public network.", steps };
const ok = (name: string, detail?: Omit<Step, "name">) => {
  steps.push({ name, ...detail });
  console.log(`PASS ${name}`);
};
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

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
  const chain = defineChain({ id: CHAIN_ID, name: "hsk-fork", nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
  const client = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 200 });
  const keys = { owner: generatePrivateKey(), agent: generatePrivateKey(), guardian: generatePrivateKey(), keeper: generatePrivateKey(), attacker: generatePrivateKey(), nextAgent: generatePrivateKey() };
  const accounts = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<keyof typeof keys, ReturnType<typeof privateKeyToAccount>>;
  for (const account of Object.values(accounts)) await probe.call("anvil_setBalance", [account.address, `0x${parseEther("2000000").toString(16)}`]);
  const walletOf = (who: keyof typeof keys) => createWalletClient({ account: accounts[who], chain, transport: http(RPC_URL) });
  const owner = walletOf("owner");
  const wait = (hash: Hex) => client.waitForTransactionReceipt({ hash });

  // 1. Preflight: everything the deployment assumes, checked against the chain before anything is signed.
  const rpcChain = await client.getChainId();
  assert.equal(rpcChain, CHAIN_ID);
  for (const [name, address] of Object.entries({ router: HSKSWAP.router, pool: HSKSWAP.pool, whsk: HSKSWAP.whsk, usdt: HSKSWAP.usdt })) {
    assert.notEqual(await client.getCode({ address: address as Address }), undefined, `${name} has no code`);
  }
  const poolAddress = HSKSWAP.pool as Address;
  const [routerFactory, poolFactory, token0, token1, poolFee, slot0, liquidity] = await Promise.all([
    client.readContract({ address: HSKSWAP.router as Address, abi: ROUTER, functionName: "factory" }),
    client.readContract({ address: poolAddress, abi: POOL, functionName: "factory" }),
    client.readContract({ address: poolAddress, abi: POOL, functionName: "token0" }),
    client.readContract({ address: poolAddress, abi: POOL, functionName: "token1" }),
    client.readContract({ address: poolAddress, abi: POOL, functionName: "fee" }),
    client.readContract({ address: poolAddress, abi: POOL, functionName: "slot0" }),
    client.readContract({ address: poolAddress, abi: POOL, functionName: "liquidity" }),
  ]);
  assert.equal(routerFactory, poolFactory, "the router and pool come from different factories");
  assert.equal(token0.toLowerCase(), HSKSWAP.whsk.toLowerCase());
  assert.equal(token1.toLowerCase(), HSKSWAP.usdt.toLowerCase());
  assert.equal(poolFee, HSKSWAP.fee);
  assert.ok(slot0[3] >= WINDOW / 10, "too few oracle observations for this window");
  const reservesAtStart = await Promise.all([client.readContract({ address: HSKSWAP.whsk as Address, abi: ERC20, functionName: "balanceOf", args: [poolAddress] }), client.readContract({ address: HSKSWAP.usdt as Address, abi: ERC20, functionName: "balanceOf", args: [poolAddress] })]);
  ok("preflight: chain, code, factory, tokens, fee and oracle all check out", { detail: { chainId: rpcChain, factory: routerFactory, tick: slot0[1], observationCardinality: slot0[3], liquidity, poolWhsk: reservesAtStart[0], poolUsdt: reservesAtStart[1], forkBlock: await client.getBlockNumber() } });

  // 2. Deploy and configure, with conservative limits.
  const artifact = JSON.parse(readFileSync("out/HoldfastVault.sol/HoldfastVault.json", "utf8"));
  const deployed = await wait(await owner.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [accounts.owner.address, accounts.agent.address, (await client.getBlock()).timestamp + 7n * 86_400n, HSKSWAP.router, HSKSWAP.whsk, HSKSWAP.usdt, HSKSWAP.fee] }));
  const vault = deployed.contractAddress as Address;
  ok("deploy", { tx: deployed.transactionHash, gasUsed: String(deployed.gasUsed), detail: { vault, runtimeBytes: artifact.deployedBytecode.object.length / 2 - 1 } });

  const as = async (who: keyof typeof keys, functionName: string, args: unknown[] = []) => {
    const r = await wait(await walletOf(who).writeContract({ address: vault, abi: VAULT_ABI, functionName, args, gas: 1_000_000n } as never));
    return r;
  };
  const owned = async (label: string, functionName: string, args: unknown[]) => {
    const r = await as("owner", functionName, args);
    assert.equal(r.status, "success", label);
    ok(label, { tx: r.transactionHash, gasUsed: String(r.gasUsed) });
  };
  await owned("limits, conditional on what was read: 10 HSK a trade, 20 an hour, 40 a day, 60 ever, floor 0.05", "setLimitsIfRemaining", [HSKSWAP.whsk, 10n * HSK, 60n * HSK, 50_000n, 20n * HSK, 0n]);
  await owned("the daily budget", "setDailyBudget", [HSKSWAP.whsk, 40n * HSK]);
  await owned("a guardian, which can stop things and nothing else", "setGuardian", [accounts.guardian.address]);
  await owned(`the price guard: within ${BAND} ticks of a ${WINDOW} s TWAP`, "setPriceGuard", [poolAddress, WINDOW, BAND]);
  await wait(await owner.writeContract({ address: HSKSWAP.whsk as Address, abi: ERC20, functionName: "deposit", value: 300n * HSK }));
  await wait(await owner.writeContract({ address: HSKSWAP.whsk as Address, abi: ERC20, functionName: "transfer", args: [vault, 300n * HSK] }));
  const balance = (token: string, who: Address = vault) => client.readContract({ address: token as Address, abi: ERC20, functionName: "balanceOf", args: [who] });
  assert.equal(await balance(HSKSWAP.whsk), 300n * HSK);
  ok("fund the vault with 300 WHSK");

  // 3. The agent in each mode.
  let policy: Policy = { ...DEFAULT_POLICY, version: 2, orders: [{ id: "sell", kind: "market-sell", amountIn: 5n * HSK }] };
  const dataDir = mkdtempSync(join(tmpdir(), "holdfast-rehearse-"));
  const base = { ...loadConfig({ VAULT_GENERATION: "3" }), rpcUrl: RPC_URL, dataDir, vault, pollMs: 300, maxStateAgeMs: 120_000 };
  const makeAgent = (mode: "observe" | "simulate" | "live") =>
    new Agent({ config: { ...base, mode, live: mode === "live", preflight: true, ...(mode === "live" ? { agentKey: keys.agent } : {}) }, lane: "fork", policy: () => policy, mark: () => null });
  const stepUntil = async (agent: Agent, done: () => boolean, limit = 40) => {
    for (let i = 0; i < limit; i++) {
      await agent.step();
      if (done()) return;
      await sleep(300);
    }
    throw new Error(`not reached: ${JSON.stringify(agent.lastDecision?.decision, big)}`);
  };

  const simulator = makeAgent("simulate");
  await stepUntil(simulator, () => simulator.lastDecision?.simulated !== undefined);
  const simulated = simulator.lastDecision!.simulated!;
  assert.equal(simulated.ok, true);
  assert.equal(simulator.executor, undefined, "no key is loaded to simulate");
  assert.equal(simulator.ledger.all().length, 0);
  assert.equal(await balance(HSKSWAP.whsk), 300n * HSK, "a simulation moved funds");
  simulator.close();
  ok("simulate mode: the vault's real answer, by eth_call, with no key loaded and no funds moved", { detail: { amountOut: simulated.amountOut, latencyMsToLocalFork: simulated.latencyMs } });

  const live = makeAgent("live");
  await stepUntil(live, () => live.ledger.get("order:2:sell:0")?.status === "included");
  const fill = live.ledger.get("order:2:sell:0")!;
  assert.equal(await balance(HSKSWAP.whsk), 295n * HSK);
  assert.equal(await balance(HSKSWAP.usdt), fill.amountOut);
  const onChain = await client.getTransaction({ hash: fill.txHash! });
  const audit = auditIntent(fill, onChain.input);
  assert.equal(audit.verdict, "matches", "the decision hash");
  ok("live: a market sell through the real router, preflighted, whose calldata carries its decision's hash", { tx: fill.txHash!, gasUsed: String(fill.gasUsed), detail: { amountOut: fill.amountOut, audit: audit.verdict, decision: JSON.parse(fill.decisionBody!) } });

  // 4. A real push of the real pool. The attacker holds the agent key.
  const attacker = walletOf("attacker");
  const pushDown = async (amount: bigint) => {
    await wait(await attacker.writeContract({ address: HSKSWAP.whsk as Address, abi: ERC20, functionName: "deposit", value: amount }));
    await wait(await attacker.writeContract({ address: HSKSWAP.whsk as Address, abi: ERC20, functionName: "approve", args: [HSKSWAP.router, amount] }));
    const r = await wait(await attacker.writeContract({ address: HSKSWAP.router as Address, abi: ROUTER, functionName: "exactInputSingle", args: [{ tokenIn: HSKSWAP.whsk as Address, tokenOut: HSKSWAP.usdt as Address, fee: HSKSWAP.fee, recipient: accounts.attacker.address, amountIn: amount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }));
    assert.equal(r.status, "success", "push");
  };
  const tickNow = async () => (await client.readContract({ address: poolAddress, abi: POOL, functionName: "slot0" }))[1];
  const pushed = await probe.call<string>("evm_snapshot");
  const tickBefore = await tickNow();
  await pushDown(300_000n * HSK);
  const tickPushed = await tickNow();
  assert.ok(tickBefore - tickPushed > BAND, "the push was too small to test anything");
  // Waits on the agent's own read of the pushed pool, and asserts it never sends.
  policy = { ...policy, version: 3, orders: [{ id: "into-push", kind: "market-sell", amountIn: 5n * HSK }] };
  await stepUntil(live, () => live.lastDecision?.decision.action === "hold" && live.lastDecision.decision.code === "price-deviation");
  const firstReason = live.lastDecision!.decision.reason;
  // A policy a model or a person left wide does not get past the vault's own band, which the agent asks about first.
  policy = { ...policy, version: 4, maxTwapDeviationBps: 2_000, orders: [{ id: "into-push", kind: "market-sell", amountIn: 5n * HSK }] };
  await stepUntil(live, () => live.lastDecision?.decision.action === "hold" && live.lastDecision.decision.code === "price-band");
  assert.equal(live.ledger.all().length, 1, "the agent sent into the push");
  ok("attack: with the pool really pushed, the agent holds twice over and sends nothing", { detail: { ticksPushed: tickBefore - tickPushed, ownCheck: firstReason, vaultBand: live.lastDecision!.decision.reason } });

  const stolenKey = walletOf("agent");
  const { timestamp } = await client.getBlock();
  const raw = await wait(await stolenKey.sendTransaction({ to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "execute", args: [HSKSWAP.whsk as Address, 5n * HSK, 250_000n, timestamp + 60n, `0x${"77".repeat(32)}`] }), gas: 500_000n }));
  assert.equal(raw.status, "reverted", "the vault itself should refuse");
  assert.equal(await balance(HSKSWAP.whsk), 295n * HSK);
  ok("attack: a thief with the agent key skips the agent and goes straight to the vault, which refuses on chain", { tx: raw.transactionHash, gasUsed: String(raw.gasUsed) });

  const agentWithdraw = await as("agent", "withdraw", [HSKSWAP.whsk, accounts.agent.address, 1n]);
  assert.equal(agentWithdraw.status, "reverted");
  ok("attack: the agent key cannot withdraw", { tx: agentWithdraw.transactionHash });
  live.close();
  await probe.call("evm_revert", [pushed]);
  const beforeStop = await probe.call<string>("evm_snapshot");

  // 5. The stop, on the real pool: a push does not fire it, a held price does, and the keeper needs no trust.
  const trigger = (await tickNow()) - 200;
  await owned("arm the stop: 200 ticks down, 10 HSK a tranche, 30 in all, floor 0.03", "armStop", [HSKSWAP.whsk, trigger, 10n * HSK, 30n * HSK, 30_000n, 20_000, 300]);
  const keeperEnv = { ...process.env, RPC_URL, CHAIN_ID: String(CHAIN_ID), VAULT_ADDRESS: vault, VAULT_GENERATION: "3", NETWORK: "mainnet", KEEPER_PRIVATE_KEY: keys.keeper, DATA_DIR: dataDir };
  const keeper = (...args: string[]) => {
    const r = spawnSync(process.execPath, [".test-build/src/cli/keeper.js", ...args], { encoding: "utf8", env: keeperEnv, timeout: 60_000 });
    return { status: r.status, last: JSON.parse(r.stdout.trim().split("\n").at(-1) || "{}"), stderr: r.stderr };
  };
  assert.equal(keeper().last.action, "wait");
  await pushDown(300_000n * HSK);
  assert.equal(await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "stopReady" }), false);
  assert.equal(keeper().last.action, "wait", "one push should not fire a stop");
  ok("the keeper waits: one real push crossed the trigger at spot, and not on the TWAP");

  await probe.call("evm_increaseTime", [WINDOW + 5]);
  await probe.call("evm_mine", []);
  assert.equal(await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "stopReady" }), true);
  const dry = keeper();
  assert.equal(dry.last.action, "would-fire", JSON.stringify(dry));
  assert.equal(await balance(HSKSWAP.whsk), 295n * HSK, "a dry run moved funds");
  ok("the keeper's dry run reports what it would do, and moves nothing", { detail: dry.last });
  const refusedWithoutFlag = keeper("--broadcast");
  assert.notEqual(refusedWithoutFlag.status, 0);
  assert.match(refusedWithoutFlag.stderr, /confirm-mainnet/);
  assert.equal(await balance(HSKSWAP.whsk), 295n * HSK);
  ok("the keeper refuses to send on chain 177 without --confirm-mainnet");
  const usdtBefore = await balance(HSKSWAP.usdt);
  const fired = keeper("--broadcast", "--confirm-mainnet");
  assert.equal(fired.last.action, "fired", JSON.stringify(fired));
  assert.equal(await balance(HSKSWAP.whsk), 285n * HSK);
  assert.ok((await balance(HSKSWAP.usdt)) > usdtBefore, "proceeds stay in the vault");
  assert.equal(await balance(HSKSWAP.usdt, accounts.keeper.address), 0n, "the keeper was paid");
  ok("after the price held for the window, a stranger's key fired the stop and the vault kept the proceeds", { tx: fired.last.hash, gasUsed: fired.last.gasUsed });
  const cooling = await client.simulateContract({ address: vault, abi: VAULT_ABI, functionName: "triggerStop", account: accounts.keeper.address }).then(() => "no refusal", (e) => String(e));
  assert.match(cooling, /StopCoolingDown/);
  ok("the stop then waits out its cooldown");

  // 6. Emergency procedures, each from the key meant to use it.
  const nextAgent = accounts.nextAgent.address;
  await owned("rotate the agent key", "setAgent", [nextAgent, (await client.getBlock()).timestamp + 86_400n]);
  const oldKey = await as("agent", "pause");
  assert.equal(oldKey.status, "reverted");
  ok("the old agent key no longer does anything, not even pause", { tx: oldKey.transactionHash });
  const revoked = await as("guardian", "revokeAgent");
  assert.equal(revoked.status, "success");
  ok("the guardian ends the agent key", { tx: revoked.transactionHash, gasUsed: String(revoked.gasUsed) });
  const halted = await as("guardian", "halt");
  assert.equal(halted.status, "success");
  assert.equal(await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "paused" }), true);
  ok("the guardian halts: trading and the stop both end", { tx: halted.transactionHash, gasUsed: String(halted.gasUsed) });
  const guardianTake = await as("guardian", "withdraw", [HSKSWAP.whsk, accounts.guardian.address, 1n]);
  assert.equal(guardianTake.status, "reverted");
  const guardianResume = await as("guardian", "unpause");
  assert.equal(guardianResume.status, "reverted");
  ok("the guardian can neither take funds nor restart anything");

  // The oracle's answer must not matter here: the owner leaves with the pool still pushed and the vault halted.
  const whskLeft = await balance(HSKSWAP.whsk);
  const usdtLeft = await balance(HSKSWAP.usdt);
  const outW = await as("owner", "withdraw", [HSKSWAP.whsk, accounts.owner.address, whskLeft]);
  const outU = await as("owner", "withdraw", [HSKSWAP.usdt, accounts.owner.address, usdtLeft]);
  assert.equal(outW.status, "success");
  assert.equal(outU.status, "success");
  assert.equal(await balance(HSKSWAP.whsk), 0n);
  assert.equal(await balance(HSKSWAP.usdt), 0n);
  ok("the owner withdraws everything, from a halted vault with a revoked key", { tx: outW.transactionHash, gasUsed: String(outW.gasUsed), detail: { whsk: whskLeft, usdt: usdtLeft } });

  const monitor = spawnSync(process.execPath, [".test-build/src/cli/monitor.js"], { encoding: "utf8", env: { ...keeperEnv, KEEPER_PRIVATE_KEY: "" }, timeout: 60_000 });
  const health = JSON.parse(monitor.stdout);
  assert.equal(health.overall, "critical");
  assert.ok(health.checks.some((c: { name: string; severity: string }) => c.name === "agent-key" && c.severity === "critical"));
  assert.equal(monitor.status, 2);
  ok("the monitor reports the revoked key as critical, and exits 2", { detail: health.checks });

  // 7. What pushing this pool costs, measured on this fork. Each size starts from the same state and sells, then buys back.
  const manipulation = [];
  await probe.call("evm_revert", [beforeStop]);
  const fairTick = await tickNow();
  for (const capital of [30_000n, 100_000n, 300_000n, 1_000_000n]) {
    const snap = await probe.call<string>("evm_snapshot");
    const usdtBeforePush = await balance(HSKSWAP.usdt, accounts.attacker.address);
    const whskBeforePush = await balance(HSKSWAP.whsk, accounts.attacker.address);
    await pushDown(capital * HSK);
    const ticks = fairTick - (await tickNow());
    const got = (await balance(HSKSWAP.usdt, accounts.attacker.address)) - usdtBeforePush;
    await wait(await attacker.writeContract({ address: HSKSWAP.usdt as Address, abi: ERC20, functionName: "approve", args: [HSKSWAP.router, got] }));
    const back = await wait(await attacker.writeContract({ address: HSKSWAP.router as Address, abi: ROUTER, functionName: "exactInputSingle", args: [{ tokenIn: HSKSWAP.usdt as Address, tokenOut: HSKSWAP.whsk as Address, fee: HSKSWAP.fee, recipient: accounts.attacker.address, amountIn: got, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] }));
    assert.equal(back.status, "success");
    const returned = (await balance(HSKSWAP.whsk, accounts.attacker.address)) - whskBeforePush;
    const lostWhsk = capital * HSK - returned;
    const spot = 1.0001 ** fairTick * 1e12;
    manipulation.push({ capitalWhsk: capital.toString(), capitalUsdApprox: Math.round(Number(capital) * spot), ticksMoved: ticks, roundTripLossWhsk: (Number(lostWhsk) / 1e18).toFixed(2), roundTripLossUsdApprox: Number(((Number(lostWhsk) / 1e18) * spot).toFixed(2)) });
    await probe.call("evm_revert", [snap]);
  }
  report.manipulationCost = { method: "Sell into the real pool on a fork and buy straight back, with no other trader acting. This is the floor on the cost: holding a price for a whole TWAP window adds arbitrage losses, which a fork with no other traders cannot measure.", poolTickAtStart: fairTick, rows: manipulation };
  console.log(JSON.stringify(report.manipulationCost, big, 2));
  ok("measured what it costs to push this pool");

  report.result = `${steps.length} steps passed`;
  mkdirSync("evidence/v3", { recursive: true });
  writeFileSync("evidence/v3/rehearsal-fork.json", `${JSON.stringify(report, big, 2)}\n`);
  console.log(`\n${steps.length} steps passed. Written to evidence/v3/rehearsal-fork.json`);
  probe.close();
} finally {
  anvil.kill();
}
