// Mandate Loss Envelope: the compiled vault bytecode against the real router on a local fork. Each case starts from
// the same snapshot. Attacks hold the agent key, so nothing off-chain helps: only the vault stands in the way.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, parseEther, stringToHex, keccak256, TransactionReceiptNotFoundError, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, HSKSWAP } from "../src/config.js";
import { VAULT_ABI } from "../src/reader.js";
import { RpcClient, sleep } from "../src/rpc.js";
import { wilson } from "../src/stats.js";

const SEEDS = Number(process.env.SEEDS ?? 20);
const PORT = 8597;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const HSK = 10n ** 18n;
const MAX_TRADE = 20n * HSK;
const LIFETIME = 60n * HSK;
const HOURLY = 20n * HSK;
const KEY_TTL = 86_400n;
const FLOOR = 50_000n; // 0.05 USDT per HSK, well under the market, so benign trades pass
const FUNDING = 500n * HSK;
const GAS = 700_000n;
// Fixed fees: reverting a snapshot can leave the fork's next base fee above what a fresh estimate would offer.
const FEES = { maxFeePerGas: 5_000_000_000_000n, maxPriorityFeePerGas: 1_000_000n };

const ERC20 = parseAbi([
  "function deposit() payable",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const ROUTER = parseAbi([
  "struct P { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(P p) payable returns (uint256)",
]);

const localAnvil = "tools/foundry/anvil.exe";
const anvil = spawn(existsSync(localAnvil) ? localAnvil : "anvil", ["--fork-url", "https://mainnet.hsk.xyz", "--port", String(PORT), "--gas-limit", "100000000", "--compute-units-per-second", "150", "--fork-retry-backoff", "2000", "--retries", "20", "--silent"], { stdio: "ignore" });

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface CaseResult {
  family: string;
  variant: string;
  seed: number;
  kind: "attack" | "benign";
  /** Tokens that left the vault during the case, in wei. */
  drained: string;
  capViolation: boolean;
  success: boolean;
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
  const chain = defineChain({ id: CHAIN_ID, name: "hsk-fork", nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
  const client = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 20 });
  const owner = privateKeyToAccount(generatePrivateKey());
  const agentAccount = privateKeyToAccount(generatePrivateKey());
  for (const who of [owner.address, agentAccount.address]) await probe.call("anvil_setBalance", [who, `0x${parseEther("5000").toString(16)}`]);
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(RPC_URL) });
  const agentWallet = createWalletClient({ account: agentAccount, chain, transport: http(RPC_URL) });
  // Polls the receipt directly. Anvil mines only on a transaction, so waitForTransactionReceipt, which checks when it
  // sees a new block, can miss a mined transaction and hang until its timeout.
  const wait = async (hash: Hex) => {
    const deadline = Date.now() + 60_000;
    while (true) {
      try {
        return await client.getTransactionReceipt({ hash });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError) || Date.now() > deadline) throw error;
      }
      await sleep(20);
    }
  };

  const artifact = JSON.parse(readFileSync("out/HoldfastVault.sol/HoldfastVault.json", "utf8"));
  const deployed = await wait(await ownerWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner.address, agentAccount.address, (await client.getBlock()).timestamp + KEY_TTL, HSKSWAP.router, HSKSWAP.whsk, HSKSWAP.usdt, HSKSWAP.fee] }));
  const vault = deployed.contractAddress as Address;
  await wait(await ownerWallet.writeContract({ address: HSKSWAP.whsk, abi: ERC20, functionName: "deposit", value: FUNDING }));
  await wait(await ownerWallet.writeContract({ address: HSKSWAP.whsk, abi: ERC20, functionName: "transfer", args: [vault, FUNDING] }));
  await wait(await ownerWallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "setLimits", args: [HSKSWAP.whsk, MAX_TRADE, LIFETIME, FLOOR, HOURLY] }));
  const snapshot = async () => probe.call<string>("evm_snapshot");
  const revert = async (id: string) => probe.call("evm_revert", [id]);

  const vaultBalance = () => client.readContract({ address: HSKSWAP.whsk, abi: ERC20, functionName: "balanceOf", args: [vault] });
  const remaining = () => client.readContract({ address: vault, abi: VAULT_ABI, functionName: "remaining", args: [HSKSWAP.whsk] });
  const timestamp = async () => (await client.getBlock()).timestamp;
  const minOutFor = (amount: bigint) => (amount * FLOOR + HSK - 1n) / HSK;
  const id = (label: string) => keccak256(stringToHex(label));

  /** Sends as the agent, with fixed gas so a doomed call still lands and reverts on chain. */
  const asAgent = async (to: Address, abi: Abi, functionName: string, args: unknown[]) =>
    wait(await agentWallet.sendTransaction({ to, data: encodeFunctionData({ abi, functionName, args }), gas: GAS, ...FEES }));
  const execute = async (amount: bigint, minOut: bigint, deadline: bigint, intent: Hex) =>
    asAgent(vault, VAULT_ABI as Abi, "execute", [HSKSWAP.whsk, amount, minOut, deadline, intent]);

  const results: CaseResult[] = [];
  const record = async (family: string, variant: string, seed: number, kind: "attack" | "benign", before: bigint, success: boolean) => {
    const drained = before - (await vaultBalance());
    const left = await remaining();
    results.push({ family, variant, seed, kind, drained: drained.toString(), capViolation: left > LIFETIME || drained > LIFETIME, success });
  };
  const amountFor = (rand: () => number) => HSK + (BigInt(Math.floor(rand() * 1e9)) * (MAX_TRADE - HSK)) / 1_000_000_000n;

  const passTime = async (seconds: bigint) => {
    await probe.call("evm_increaseTime", [`0x${seconds.toString(16)}`]);
    await probe.call("evm_mine");
  };

  type Attack = (rand: () => number, seed: number) => Promise<{ variant: string; reverted: boolean }>;
  const families: Record<string, Attack> = {
    "recipient-substitution": async (rand, seed) => {
      const amount = amountFor(rand);
      switch (seed % 4) {
        case 0:
          return { variant: "withdraw to the agent", reverted: (await asAgent(vault, VAULT_ABI as Abi, "withdraw", [HSKSWAP.whsk, agentAccount.address, amount])).status === "reverted" };
        case 1:
          return { variant: "pull from the vault directly", reverted: (await asAgent(HSKSWAP.whsk, ERC20 as Abi, "transferFrom", [vault, agentAccount.address, amount])).status === "reverted" };
        case 2: {
          // Router pull using any allowance the vault left behind, paying the attacker.
          const params = { tokenIn: HSKSWAP.whsk, tokenOut: HSKSWAP.usdt, fee: HSKSWAP.fee, recipient: agentAccount.address, amountIn: amount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
          return { variant: "use the router with the vault's allowance", reverted: (await asAgent(HSKSWAP.router, ROUTER as Abi, "exactInputSingle", [params])).status === "reverted" };
        }
        default:
          return { variant: "replace the agent with an attacker", reverted: (await asAgent(vault, VAULT_ABI as Abi, "setAgent", ["0x000000000000000000000000000000000000bad1", (await timestamp()) + 60n])).status === "reverted" };
      }
    },
    "amount-inflation": async (rand, seed) => {
      const deadline = (await timestamp()) + 60n;
      if (seed % 2 === 0) {
        const amount = MAX_TRADE + 1n + BigInt(Math.floor(rand() * 1e18));
        return { variant: "over the trade cap", reverted: (await execute(amount, minOutFor(amount), deadline, id(`over-${seed}`))).status === "reverted" };
      }
      const amount = amountFor(rand);
      return { variant: "below the price floor", reverted: (await execute(amount, minOutFor(amount) - 1n, deadline, id(`floor-${seed}`))).status === "reverted" };
    },
    "nonce-replay": async (rand, seed) => {
      const amount = amountFor(rand);
      const intent = id(`replay-${seed}`);
      const deadline = (await timestamp()) + 60n;
      const first = await execute(amount, minOutFor(amount), deadline, intent);
      assert.equal(first.status, "success");
      const changed = seed % 2 === 0;
      const second = changed ? HSK : amount;
      return { variant: changed ? "changed payload, same intent" : "exact replay", reverted: (await execute(second, minOutFor(second), deadline, intent)).status === "reverted" };
    },
    "expiry-policy-reset": async (rand, seed) => {
      const amount = amountFor(rand);
      const now = await timestamp();
      switch (seed % 4) {
        case 0:
          return { variant: "expired deadline", reverted: (await execute(amount, minOutFor(amount), now - 1n, id(`old-${seed}`))).status === "reverted" };
        case 1:
          return { variant: "deadline too far ahead", reverted: (await execute(amount, minOutFor(amount), now + 100_000n, id(`far-${seed}`))).status === "reverted" };
        case 2:
          return { variant: "agent raises its own caps", reverted: (await asAgent(vault, VAULT_ABI as Abi, "setLimits", [HSKSWAP.whsk, 2n ** 71n, 2n ** 71n, 0n, 2n ** 71n])).status === "reverted" };
        default: {
          await asAgent(vault, VAULT_ABI as Abi, "pause", []);
          return { variant: "agent unpauses after a pause", reverted: (await asAgent(vault, VAULT_ABI as Abi, "unpause", [])).status === "reverted" };
        }
      }
    },
  };

  // A stolen key, given time. These only became possible to refuse with key expiry and the hourly budget.
  families["stolen-key-over-time"] = async (rand, seed) => {
    const amount = amountFor(rand);
    switch (seed % 5) {
      case 0:
        await passTime(KEY_TTL);
        return { variant: "trade after the key expired", reverted: (await execute(amount, minOutFor(amount), (await timestamp()) + 60n, id(`late-${seed}`))).status === "reverted" };
      case 1:
        await passTime(KEY_TTL);
        return { variant: "pause after the key expired", reverted: (await asAgent(vault, VAULT_ABI as Abi, "pause", [])).status === "reverted" };
      case 2: {
        await wait(await ownerWallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "setAgent", args: [owner.address, (await timestamp()) + 60n], ...FEES }));
        return { variant: "trade after the owner replaced the key", reverted: (await execute(amount, minOutFor(amount), (await timestamp()) + 60n, id(`old-key-${seed}`))).status === "reverted" };
      }
      case 3: {
        const first = await execute(HOURLY, minOutFor(HOURLY), (await timestamp()) + 60n, id(`burst-${seed}`));
        assert.equal(first.status, "success");
        return { variant: "second trade right after spending the whole budget", reverted: (await execute(HSK, minOutFor(HSK), (await timestamp()) + 60n, id(`burst2-${seed}`))).status === "reverted" };
      }
      default: {
        const first = await execute(HOURLY, minOutFor(HOURLY), (await timestamp()) + 60n, id(`wait-${seed}`));
        assert.equal(first.status, "success");
        await passTime(900n);
        const over = HOURLY / 4n + 2n * HSK;
        return { variant: "after 15 minutes, more than 15 minutes of budget", reverted: (await execute(over, minOutFor(over), (await timestamp()) + 60n, id(`wait2-${seed}`))).status === "reverted" };
      }
    }
  };

  for (const [family, attack] of Object.entries(families)) {
    for (let seed = 0; seed < SEEDS; seed++) {
      const saved = await snapshot();
      const before = await vaultBalance();
      const { variant, reverted } = await attack(prng(seed * 7919 + family.length), seed);
      await record(family, variant, seed, "attack", before, reverted);
      await revert(saved);

      // The matched benign case: same seed, a valid trade that must succeed.
      const benignSaved = await snapshot();
      const benignBefore = await vaultBalance();
      const amount = amountFor(prng(seed * 7919 + family.length));
      const receipt = await execute(amount, minOutFor(amount), (await timestamp()) + 60n, id(`benign-${family}-${seed}`));
      await record(family, "valid trade", seed, "benign", benignBefore, receipt.status === "success");
      await revert(benignSaved);
    }
    console.log(`${family}: done`);
  }

  // Concurrency: 32 trades in one block, each valid alone, whose sum is far over the lifetime cap.
  const family = "concurrent-spend";
  await probe.call("evm_setAutomine", [false]);
  for (let seed = 0; seed < SEEDS; seed++) {
    const saved = await snapshot();
    const before = await vaultBalance();
    const rand = prng(seed + 1);
    const deadline = (await timestamp()) + 60n;
    let nonce = await client.getTransactionCount({ address: agentAccount.address });
    const hashes: Hex[] = [];
    for (let i = 0; i < 32; i++) {
      const amount = amountFor(rand);
      hashes.push(await agentWallet.sendTransaction({ to: vault, data: encodeFunctionData({ abi: VAULT_ABI as Abi, functionName: "execute", args: [HSKSWAP.whsk, amount, minOutFor(amount), deadline, id(`race-${seed}-${i}`)] }), gas: GAS, ...FEES, nonce: nonce++ }));
    }
    await probe.call("evm_mine");
    await Promise.all(hashes.map(wait));
    const spent = before - (await vaultBalance());
    assert.ok(spent <= HOURLY, `spent ${spent}`);
    assert.equal(await remaining(), LIFETIME - spent);
    results.push({ family, variant: "32 trades in one block, over the cap", seed, kind: "attack", drained: spent.toString(), capViolation: spent > HOURLY, success: spent <= HOURLY });
    await revert(saved);

    const benignSaved = await snapshot();
    const benignBefore = await vaultBalance();
    let benignNonce = await client.getTransactionCount({ address: agentAccount.address });
    const benign: Hex[] = [];
    for (let i = 0; i < 3; i++) {
      const amount = 5n * HSK;
      benign.push(await agentWallet.sendTransaction({ to: vault, data: encodeFunctionData({ abi: VAULT_ABI as Abi, functionName: "execute", args: [HSKSWAP.whsk, amount, minOutFor(amount), deadline, id(`ok-${seed}-${i}`)] }), gas: GAS, ...FEES, nonce: benignNonce++ }));
    }
    await probe.call("evm_mine");
    const receipts = await Promise.all(benign.map(wait));
    await record(family, "3 trades in one block, under the cap", seed, "benign", benignBefore, receipts.every((r) => r.status === "success"));
    await revert(benignSaved);
  }
  await probe.call("evm_setAutomine", [true]);
  console.log(`${family}: done`);

  // What the key can actually lose. "Drained" above is tokens that left the vault, and the USDT they bought came back.
  // Here the attacker holds the agent key and capital: push the pool down to just above the floor, make the vault sell
  // into it, and measure the sale against the market price before the push. The budget is the only difference between arms.
  const sandwich = async (budget: bigint) => {
    const saved = await snapshot();
    await wait(await ownerWallet.writeContract({ address: vault, abi: VAULT_ABI, functionName: "setLimits", args: [HSKSWAP.whsk, MAX_TRADE, LIFETIME, FLOOR, budget], ...FEES }));
    const pool = [{ type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }] }] as const;
    const [sqrtBefore] = await client.readContract({ address: HSKSWAP.pool, abi: pool, functionName: "slot0" });
    const spotBefore = (sqrtBefore * sqrtBefore * HSK) >> 192n;
    // One percent above the floor, so a vault sale of this size still clears it.
    const target = (FLOOR * 101n) / 100n;
    const limit = BigInt(Math.floor(Math.sqrt(Number(target) / 1e18) * 2 ** 96));
    const capital = 3_000_000n * HSK;
    await probe.call("anvil_setBalance", [agentAccount.address, `0x${(capital + parseEther("5000")).toString(16)}`]);
    await wait(await agentWallet.writeContract({ address: HSKSWAP.whsk, abi: ERC20, functionName: "deposit", value: capital, ...FEES }));
    await wait(await agentWallet.writeContract({ address: HSKSWAP.whsk, abi: ERC20, functionName: "approve", args: [HSKSWAP.router, capital], ...FEES }));
    const params = { tokenIn: HSKSWAP.whsk, tokenOut: HSKSWAP.usdt, fee: HSKSWAP.fee, recipient: agentAccount.address, amountIn: capital, amountOutMinimum: 0n, sqrtPriceLimitX96: limit };
    assert.equal((await asAgent(HSKSWAP.router, ROUTER as Abi, "exactInputSingle", [params])).status, "success");

    const usdtBefore = await client.readContract({ address: HSKSWAP.usdt, abi: ERC20, functionName: "balanceOf", args: [vault] });
    const whskBefore = await vaultBalance();
    const deadline = (await timestamp()) + 60n;
    let fills = 0;
    for (let i = 0; i < 4; i++) {
      const receipt = await execute(MAX_TRADE, minOutFor(MAX_TRADE), deadline, id(`sandwich-${budget}-${i}`));
      if (receipt.status === "success") fills++;
    }
    const sold = whskBefore - (await vaultBalance());
    const received = (await client.readContract({ address: HSKSWAP.usdt, abi: ERC20, functionName: "balanceOf", args: [vault] })) - usdtBefore;
    const fair = (sold * spotBefore) / HSK;
    await revert(saved);
    return { budgetHsk: Number(budget) / 1e18, fills, soldHsk: Number(sold) / 1e18, marketValueUsdt: Number(fair) / 1e6, receivedUsdt: Number(received) / 1e6, lostUsdt: Number(fair - received) / 1e6, boundUsdt: Number((sold * (spotBefore - FLOOR)) / HSK) / 1e6 };
  };
  const sandwichArms = { budgetEqualsLifetimeCap: await sandwich(LIFETIME), budgetSetToOneThird: await sandwich(HOURLY) };
  console.log(`sandwich: ${JSON.stringify(sandwichArms)}`);

  const attacks = results.filter((r) => r.kind === "attack");
  const benign = results.filter((r) => r.kind === "benign");
  const contained = attacks.filter((r) => r.success).length;
  const completed = benign.filter((r) => r.success).length;
  // A replay's first trade and a race's fills are legitimate spending, so the bound is the cap, not zero.
  const maxDrained = attacks.reduce((m, r) => (BigInt(r.drained) > m ? BigInt(r.drained) : m), 0n);
  const summary = {
    lane: "fork",
    note: "New vault source, with key expiry and the hourly budget. Compiled bytecode on a local fork against the real router. Not a mainnet run and not an audit. Reentrancy needs a hostile router, so it is covered in the Foundry suite, not here.",
    wallTime: new Date().toISOString(),
    attacks: { n: attacks.length, contained, forbiddenAccepts: attacks.length - contained, wilson95ForForbidden: wilson(attacks.length - contained, attacks.length) },
    benign: { n: benign.length, completed, wilson95: wilson(completed, benign.length) },
    capViolations: results.filter((r) => r.capViolation).length,
    maxDrainedHsk: Number(maxDrained) / 1e18,
    lifetimeCapHsk: Number(LIFETIME) / 1e18,
    hourlyBudgetHsk: Number(HOURLY) / 1e18,
    keyTtlSeconds: Number(KEY_TTL),
    drainedMeans: "Tokens that left the vault in one case, not value lost. The swap proceeds stay in the vault as USDT. See sandwich for value lost.",
    sandwich: sandwichArms,
    byFamily: Object.fromEntries([...new Set(results.map((r) => r.family))].map((f) => [f, { attacks: attacks.filter((r) => r.family === f).length, contained: attacks.filter((r) => r.family === f && r.success).length, benignCompleted: benign.filter((r) => r.family === f && r.success).length }])),
  };
  mkdirSync("data", { recursive: true });
  writeFileSync("data/attack-results.json", JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  probe.close();
} finally {
  anvil.kill();
}
