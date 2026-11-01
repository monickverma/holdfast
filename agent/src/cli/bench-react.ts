// Event-to-Receipt on the testnet market. Another wallet moves the pool past an armed limit order, and the clock starts
// when the first flashblock showing that move reaches this process. Testnet only: free tokens and self-trades.
//   NETWORK=testnet bench:react -- --n 120 --run react --broadcast
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Agent, type DecisionRecord } from "../agent.js";
import { HSKSWAP, loadConfig, networkProfile } from "../config.js";
import { DEFAULT_POLICY, type Policy } from "../policy.js";
import { readTick } from "../reader.js";
import { sleep } from "../rpc.js";
import { JsonlLog } from "../trace.js";

process.loadEnvFile();
if (networkProfile().network !== "testnet") throw new Error("Set NETWORK=testnet");
const { values } = parseArgs({
  options: {
    broadcast: { type: "boolean", default: false },
    n: { type: "string", default: "120" },
    run: { type: "string", default: `react-${Date.now()}` },
    // A trial gives up after this long, and the failure is recorded against its slot.
    "timeout-ms": { type: "string", default: "8000" },
  },
});
if (!values.broadcast) throw new Error("This sends testnet swaps. Add --broadcast only when you mean it.");

const base = loadConfig();
const dataDir = join(base.dataDir, values.run!);
mkdirSync(dataDir, { recursive: true });
const config = { ...base, live: true, dataDir };
const moverKey = process.env.OWNER_PRIVATE_KEY as Hex;
if (!config.vault || !config.agentKey || !moverKey) throw new Error("Needs the deployed test market and both local wallet keys");

const E18 = 10n ** 18n;
const POOL_ABI = parseAbi(["function swap(address input, uint256 amount, address recipient, uint256 minimum) returns (uint256)"]);
const TOKEN_ABI = parseAbi(["function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount) returns (bool)", "function allowance(address, address) view returns (uint256)"]);
const mover = privateKeyToAccount(moverKey);
const chain = defineChain({ id: config.chainId, name: "HSK testnet", nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(config.rpcUrl) });
const wallet = createWalletClient({ account: mover, chain, transport: http(config.rpcUrl) });

let policy: Policy = DEFAULT_POLICY;
const agent = new Agent({ config, lane: "testnet", policy: () => policy, mark: () => null });
const samples = new JsonlLog(join(dataDir, "react-samples.jsonl"));

// The moves are large against the limit price and small against the pool. Tokens are free to mint on this market.
const MOVE_USDT = 800n * 10n ** 6n;
const MOVE_WHSK = 8_000n * E18;
const ORDER_WHSK = 2n * 10n ** 16n;
const ORDER_USDT = 2_000n;
// The public RPC can return a stale nonce right after a receipt, so this counts its own.
let moverNonce = await client.getTransactionCount({ address: mover.address, blockTag: "pending" });
for (const [token, amount] of [[HSKSWAP.whsk, 2_000_000n * E18], [HSKSWAP.usdt, 200_000n * 10n ** 6n]] as const) {
  const allowance = await client.readContract({ address: token, abi: TOKEN_ABI, functionName: "allowance", args: [mover.address, HSKSWAP.pool] });
  if (allowance > 0n) continue;
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: TOKEN_ABI, functionName: "mint", args: [mover.address, amount], nonce: moverNonce++ }) });
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: TOKEN_ABI, functionName: "approve", args: [HSKSWAP.pool, 2n ** 255n], nonce: moverNonce++ }) });
}

let waitingForFrame: ((arrivedAt: number, frame: Parameters<Agent["reactTo"]>[0]) => void) | null = null;
const stream = agent.openStream((frame) => waitingForFrame?.(frame.arrivedAt, frame));
await stream.start();

/** A full read at the head, which frame reactions then build on. */
async function refresh(): Promise<void> {
  const tick = await readTick(agent.rpc, config, policy.orders.map((o) => ({ tokenIn: o.kind === "limit-sell" ? HSKSWAP.whsk : HSKSWAP.usdt, amountIn: o.amountIn })), agent.executor!.address);
  if (tick) {
    agent.lastMarket = tick.market;
    await agent.refreshWarm(tick.market, tick.pendingNonce);
  }
}
await refresh();

const counts: Record<string, number> = {};
const timeoutMs = Number(values["timeout-ms"]);
// Each pair runs in a random order, so neither arm always trades at the price the other one left behind.
let pollFirst = true;
for (let k = 0; k < Number(values.n); k++) {
  if (k % 2 === 0) pollFirst = Math.random() < 0.5;
  const arm = k % 2 === 0 === pollFirst ? "poll" : "stream";
  const up = Math.floor(k / 2) % 2 === 0;
  let outcome = "timeout";
  let receiptMs: number | null = null;
  let frameIndex: number | null = null;
  let detail: unknown = null;
  try {
    // Arm a limit order halfway between the fill price now and the fill price after the move.
    await sleep(2_500 + Math.random() * 2_000);
    await agent.settleInFlight();
    await refresh();
    const market = agent.lastMarket!;
    const id = `r-${k}`;
    const order = up
      ? { id, kind: "limit-sell" as const, amountIn: ORDER_WHSK, triggerPriceX18: (market.spotPriceX18 * 1004n) / 1000n }
      : { id, kind: "limit-buy" as const, amountIn: ORDER_USDT, triggerPriceX18: (market.spotPriceX18 * 996n) / 1000n };
    policy = { ...DEFAULT_POLICY, slippageBps: 300, orders: [order] };
    await refresh();

    const seen = new Promise<{ arrivedAt: number; frame: Parameters<Agent["reactTo"]>[0] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frame showed the move")), timeoutMs);
      waitingForFrame = (arrivedAt, frame) => {
        clearTimeout(timer);
        waitingForFrame = null;
        resolve({ arrivedAt, frame });
      };
    });
    const moveNonce = moverNonce++;
    void wallet
      .writeContract({
        address: HSKSWAP.pool,
        abi: POOL_ABI,
        functionName: "swap",
        args: up ? [HSKSWAP.usdt, MOVE_USDT, mover.address, 1n] : [HSKSWAP.whsk, MOVE_WHSK, mover.address, 1n],
        nonce: moveNonce,
        gas: 200_000n,
      })
      .catch((error) => console.log(`move ${k} failed: ${String(error).slice(0, 200)}`));

    const { arrivedAt, frame } = await seen;
    frameIndex = frame.index;
    const deadline = arrivedAt + timeoutMs;
    let record: DecisionRecord | null = null;
    if (arm === "stream") {
      record = await agent.reactTo(frame);
      // A frame that cannot trigger yet falls through to the same timeout as a poll that never sees the move.
    } else {
      // What the loop does today: on a fixed timeline, read then decide, until the read shows the move.
      const startGrid = performance.now();
      for (let tick = 0; performance.now() < deadline; tick++) {
        const wait = startGrid + tick * config.pollMs - performance.now();
        if (wait > 0) await sleep(wait);
        record = await agent.step(performance.now(), true);
        if (record?.intent) break;
      }
    }
    if (record?.intent) {
      receiptMs = performance.now() - arrivedAt;
      outcome = record.intent.status;
      detail = { quotedOut: record.decision.action === "trade" ? record.decision.quotedOut : null, amountOut: record.intent.amountOut, tx: record.intent.txHash, block: record.intent.blockNumber };
    } else {
      outcome = record?.decision.action === "hold" ? `hold:${record.decision.code}` : "no-send";
      detail = record?.decision;
    }
  } catch (error) {
    outcome = `error:${String(error).slice(0, 160)}`;
    waitingForFrame = null;
    moverNonce = await client.getTransactionCount({ address: mover.address, blockTag: "pending" });
  }
  policy = DEFAULT_POLICY;
  counts[`${arm}:${outcome.split(":")[0]}`] = (counts[`${arm}:${outcome.split(":")[0]}`] ?? 0) + 1;
  samples.append({ k, arm, up, outcome, eventToReceiptMs: receiptMs, frameIndex, detail, wallTime: new Date().toISOString() });
  if ((k + 1) % 10 === 0) console.log(`${k + 1}/${values.n} ${JSON.stringify(counts)}`);
}

await sleep(6_000);
let checked = 0;
let changed = 0;
for (const intent of agent.ledger.all()) {
  if (intent.status !== "included" && intent.status !== "reverted") continue;
  const sealed = await agent.rpc.call<{ status: string; blockNumber: string } | null>("eth_getTransactionReceipt", [intent.txHash]);
  checked++;
  if (!sealed || BigInt(sealed.blockNumber) !== intent.blockNumber || (sealed.status === "0x1") !== (intent.status === "included")) changed++;
  await sleep(50);
}
writeFileSync(join(dataDir, "preconfirmation-check.json"), JSON.stringify({ checked, changed, checkedAt: new Date().toISOString() }));
console.log(`finished ${JSON.stringify(counts)}; preconfirmations changed ${changed} of ${checked}; local quote misses ${agent.localQuoteMisses}; stream frames ${stream.frames}, reconnects ${stream.reconnects}`);
stream.close();
agent.close();
process.exit(0);
