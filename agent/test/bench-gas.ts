// Gas per swap on a local fork of mainnet, through the real HSKSwap router, in the same blocks: a plain router swap,
// each earlier vault, and the current vault with its guard off and on. Throwaway keys; nothing reaches the real chain.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { concatHex, createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, parseEther, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, HSKSWAP } from "../src/config.js";
import { Ledger } from "../src/ledger.js";
import { VAULT_ABI } from "../src/reader.js";
import { RpcClient, sleep } from "../src/rpc.js";

const PORT = 8597;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const HSK = 10n ** 18n;
const ROUNDS = 20;
const TOKEN_ABI = parseAbi(["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"]);
const ROUTER_ABI = parseAbi([
  "struct Params { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(Params params) payable returns (uint256 amountOut)",
]);

const localAnvil = "tools/foundry/anvil.exe";
const anvil = spawn(existsSync(localAnvil) ? localAnvil : "anvil", ["--fork-url", "https://mainnet.hsk.xyz", "--port", String(PORT), "--block-time", "1", "--silent"], { stdio: "ignore" });

const median = (values: bigint[]) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(values.length / 2)]!;

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
  const owner = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  for (const who of [owner.address, agent.address]) await probe.call("anvil_setBalance", [who, `0x${parseEther("10000").toString(16)}`]);
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(RPC_URL) });
  const agentWallet = createWalletClient({ account: agent, chain, transport: http(RPC_URL) });
  const wait = (hash: Hex) => client.waitForTransactionReceipt({ hash });

  const deployVault = async (file: string, name: string) => {
    const artifact = JSON.parse(readFileSync(`out/${file}/${name}.json`, "utf8"));
    const current = name !== "HoldfastVaultV1";
    const receipt = await wait(await ownerWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: current ? [owner.address, agent.address, BigInt(Math.floor(Date.now() / 1000)) + 86_400n * 29n, HSKSWAP.router, HSKSWAP.whsk, HSKSWAP.usdt, HSKSWAP.fee] : [owner.address, agent.address, HSKSWAP.router, HSKSWAP.whsk, HSKSWAP.usdt, HSKSWAP.fee] }));
    const vault = receipt.contractAddress as Address;
    await wait(await ownerWallet.writeContract({ address: HSKSWAP.whsk, abi: TOKEN_ABI, functionName: "deposit", value: 300n * HSK }));
    await wait(await ownerWallet.writeContract({ address: HSKSWAP.whsk, abi: TOKEN_ABI, functionName: "transfer", args: [vault, 300n * HSK] }));
    await wait(await ownerWallet.writeContract({ address: vault, abi: artifact.abi, functionName: "setLimits", args: [HSKSWAP.whsk, 50n * HSK, 200n * HSK, 50_000n, ...(current ? [200n * HSK] : [])] }));
    await wait(await ownerWallet.writeContract({ address: vault, abi: artifact.abi, functionName: "setLimits", args: [HSKSWAP.usdt, 5n * 10n ** 6n, 20n * 10n ** 6n, 5n * 10n ** 30n, ...(current ? [20n * 10n ** 6n] : [])] }));
    return { vault, deployGas: receipt.gasUsed, runtimeBytes: artifact.deployedBytecode.object.length / 2 - 1 };
  };
  const v1 = await deployVault("HoldfastVaultV1.sol", "HoldfastVaultV1");
  const v2 = await deployVault("HoldfastVaultV2.sol", "HoldfastVaultV2");
  const v3 = await deployVault("HoldfastVault.sol", "HoldfastVault");
  const v3Guard = await deployVault("HoldfastVault.sol", "HoldfastVault");
  const v3Full = await deployVault("HoldfastVault.sol", "HoldfastVault");
  const WINDOW = 600;
  for (const target of [v3Guard.vault, v3Full.vault]) {
    await wait(await ownerWallet.writeContract({ address: target, abi: VAULT_ABI, functionName: "setPriceGuard", args: [HSKSWAP.pool, WINDOW, 500] }));
  }
  await wait(await ownerWallet.writeContract({ address: v3Full.vault, abi: VAULT_ABI, functionName: "setDailyBudget", args: [HSKSWAP.whsk, 200n * HSK] }));
  await wait(await ownerWallet.writeContract({ address: v3Full.vault, abi: VAULT_ABI, functionName: "setDailyBudget", args: [HSKSWAP.usdt, 20n * 10n ** 6n] }));

  // A plain wallet swap with allowances already set: the cost with no vault at all.
  await wait(await agentWallet.writeContract({ address: HSKSWAP.whsk, abi: TOKEN_ABI, functionName: "deposit", value: 300n * HSK }));
  await wait(await agentWallet.writeContract({ address: HSKSWAP.whsk, abi: TOKEN_ABI, functionName: "approve", args: [HSKSWAP.router, 2n ** 255n] }));
  await wait(await agentWallet.writeContract({ address: HSKSWAP.usdt, abi: TOKEN_ABI, functionName: "approve", args: [HSKSWAP.router, 2n ** 255n] }));

  const SELL = 1n * HSK;
  const BUY = 50_000n;
  const execute = async (vault: Address, tokenIn: Address, amountIn: bigint, minOut: bigint, intentId: Hex) => {
    const { timestamp } = await client.getBlock();
    return wait(await agentWallet.writeContract({ address: vault, abi: VAULT_ABI as Abi, functionName: "execute", args: [tokenIn, amountIn, minOut, timestamp + 60n, intentId], gas: 500_000n }));
  };
  /** As the agent really sends it: with the decision's hash after the arguments. */
  const executeWithHash = async (vault: Address, tokenIn: Address, amountIn: bigint, minOut: bigint, intentId: Hex) => {
    const { timestamp } = await client.getBlock();
    const data = concatHex([encodeFunctionData({ abi: VAULT_ABI, functionName: "execute", args: [tokenIn, amountIn, minOut, timestamp + 60n, intentId] }), `0x${randomBytes(32).toString("hex")}`]);
    return wait(await agentWallet.sendTransaction({ to: vault, data, gas: 500_000n }));
  };
  const plain = async (tokenIn: Address, tokenOut: Address, amountIn: bigint) =>
    wait(await agentWallet.writeContract({ address: HSKSWAP.router, abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{ tokenIn, tokenOut, fee: HSKSWAP.fee, recipient: agent.address, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }], gas: 500_000n }));

  const ledger = new Ledger(`${process.env.TEMP ?? "."}/holdfast-gas-${Date.now()}.jsonl`);
  const nextV2Id = () => {
    const intentId = ledger.nextIntentId();
    ledger.reserve({ key: intentId, intentId, bodyHash: "0x00", orderId: null, tokenIn: HSKSWAP.whsk, amountIn: 0n, minOut: 0n, deadline: 0n });
    return intentId;
  };
  const results: Record<string, Record<string, bigint[]>> = { plain: { sell: [], buy: [] }, v1: { sell: [], buy: [] }, v2: { sell: [], buy: [] }, v3GuardOff: { sell: [], buy: [] }, v3GuardOn: { sell: [], buy: [] }, v3GuardDailyHash: { sell: [], buy: [] } };
  const checkStatus = (label: string, receipt: { status: string }) => {
    if (receipt.status !== "success") throw new Error(`${label} reverted`);
  };

  // Set up each direction once so the rounds compare like with like: the first buy of a wallet pays to create balances.
  checkStatus("seed", await plain(HSKSWAP.whsk, HSKSWAP.usdt, SELL));
  for (const vault of [v1.vault, v2.vault, v3.vault, v3Guard.vault, v3Full.vault]) {
    checkStatus("seed", await execute(vault, HSKSWAP.whsk, SELL, 50_000n, `0x${randomBytes(32).toString("hex")}`));
  }

  for (let round = 0; round < ROUNDS; round++) {
    const sellPlain = await plain(HSKSWAP.whsk, HSKSWAP.usdt, SELL);
    const sellV1 = await execute(v1.vault, HSKSWAP.whsk, SELL, 50_000n, `0x${randomBytes(32).toString("hex")}`);
    const sellV2 = await execute(v2.vault, HSKSWAP.whsk, SELL, 50_000n, nextV2Id());
    const buyPlain = await plain(HSKSWAP.usdt, HSKSWAP.whsk, BUY);
    const buyV1 = await execute(v1.vault, HSKSWAP.usdt, BUY, 3n * 10n ** 17n, `0x${randomBytes(32).toString("hex")}`);
    const buyV2 = await execute(v2.vault, HSKSWAP.usdt, BUY, 3n * 10n ** 17n, nextV2Id());
    const sellV3 = await execute(v3.vault, HSKSWAP.whsk, SELL, 50_000n, nextV2Id());
    const sellGuard = await execute(v3Guard.vault, HSKSWAP.whsk, SELL, 50_000n, nextV2Id());
    const sellFull = await executeWithHash(v3Full.vault, HSKSWAP.whsk, SELL, 50_000n, nextV2Id());
    const buyV3 = await execute(v3.vault, HSKSWAP.usdt, BUY, 3n * 10n ** 17n, nextV2Id());
    const buyGuard = await execute(v3Guard.vault, HSKSWAP.usdt, BUY, 3n * 10n ** 17n, nextV2Id());
    const buyFull = await executeWithHash(v3Full.vault, HSKSWAP.usdt, BUY, 3n * 10n ** 17n, nextV2Id());
    for (const [label, receipt] of Object.entries({ sellPlain, sellV1, sellV2, buyPlain, buyV1, buyV2, sellV3, sellGuard, sellFull, buyV3, buyGuard, buyFull })) checkStatus(label, receipt);
    results.v3GuardOff!.sell!.push(sellV3.gasUsed);
    results.v3GuardOff!.buy!.push(buyV3.gasUsed);
    results.v3GuardOn!.sell!.push(sellGuard.gasUsed);
    results.v3GuardOn!.buy!.push(buyGuard.gasUsed);
    results.v3GuardDailyHash!.sell!.push(sellFull.gasUsed);
    results.v3GuardDailyHash!.buy!.push(buyFull.gasUsed);
    results.plain!.sell!.push(sellPlain.gasUsed);
    results.plain!.buy!.push(buyPlain.gasUsed);
    results.v1!.sell!.push(sellV1.gasUsed);
    results.v1!.buy!.push(buyV1.gasUsed);
    results.v2!.sell!.push(sellV2.gasUsed);
    results.v2!.buy!.push(buyV2.gasUsed);
  }
  ledger.close();

  const summary = {
    lane: "fork",
    note: "Local fork of mainnet through the real HSKSwap router. Median gas per swap, including 21,000 intrinsic and calldata; L1 data fee excluded because a fork has no oracle state to charge it.",
    rounds: ROUNDS,
    wallTime: new Date().toISOString(),
    deployGas: { v1: v1.deployGas, v2: v2.deployGas, v3: v3.deployGas },
    runtimeBytes: { v1: v1.runtimeBytes, v2: v2.runtimeBytes, v3: v3.runtimeBytes },
    guardConfig: { twapWindowSec: WINDOW, bandTicks: 500 },
    medianGas: Object.fromEntries(Object.entries(results).map(([arm, sides]) => [arm, { sell: median(sides.sell!), buy: median(sides.buy!) }])),
  };
  mkdirSync("evidence/v3", { recursive: true });
  writeFileSync("evidence/v3/gas-compare.json", JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(readFileSync("evidence/v3/gas-compare.json", "utf8"));
  probe.close();
} finally {
  anvil.kill();
}
