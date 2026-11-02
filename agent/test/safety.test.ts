// Failures the fault matrix does not reach: two paths sending at once, and a receipt a reorg takes back.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseTransaction, type Hex } from "viem";
import { auditIntent, hashInCalldata } from "../src/cli/audit.js";
import { Agent } from "../src/agent.js";
import { HSKSWAP } from "../src/config.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy.js";
import type { MarketState, TokenLimits } from "../src/reader.js";
import { Executor } from "../src/executor.js";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { VAULT_ABI } from "../src/reader.js";
import { verifyVenue } from "../src/venue.js";
import { Ledger } from "../src/ledger.js";
import { RpcClient } from "../src/rpc.js";
import { Trace } from "../src/trace.js";

const AGENT_KEY = `0x${"11".repeat(32)}` as Hex;
const HSK = 10n ** 18n;
const USDT = 10n ** 6n;
const BLOCK_A = `0x${"aa".repeat(32)}`;
const BLOCK_B = `0x${"bb".repeat(32)}`;

let handle: (call: any) => unknown | Promise<unknown>;
let server: http.Server;
let url: string;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const call = JSON.parse(Buffer.concat(chunks).toString());
      const out = await handle(call);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out instanceof Error ? { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: out.message } } : { jsonrpc: "2.0", id: call.id, result: out }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const limits: TokenLimits = { balance: 1_000n * HSK, maxTrade: 200n * HSK, remaining: 500n * HSK, floorPriceX18: 50_000n, hourlyBudget: 300n * HSK, available: 300n * HSK };
const market: MarketState = {
  head: { number: 100n, hash: BLOCK_A as Hex, timestamp: 100n, baseFeePerGas: 1n },
  sqrtPriceX96: 0n,
  tick: 0,
  twapTick: 0,
  liquidity: 1n,
  spotPriceX18: 87_400n,
  quotes: [{ tokenIn: HSKSWAP.whsk, amountIn: 100n * HSK, amountOut: 8_700_000n, ticksCrossed: 0 }],
  priorityFeePerGas: 1n,
  l1FeeWei: 0n,
  vault: { paused: false, agentExpiry: 10_000n, whsk: limits, usdt: { ...limits, balance: 50n * USDT, floorPriceX18: 5n * HSK } },
};
const policy: Policy = { ...DEFAULT_POLICY, orders: [{ id: "m", kind: "market-sell", amountIn: 100n * HSK }] };

function liveAgent() {
  return new Agent({
    config: { rpcUrl: url, chainId: 177, live: true, pollMs: 650, dataDir: mkdtempSync(join(tmpdir(), "holdfast-")), twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 30_000, poolKind: "v3", agentKey: AGENT_KEY, vault: HSKSWAP.router },
    lane: "fork",
    policy: () => policy,
    mark: () => null,
    now: () => 100_000,
  });
}
const act = (agent: Agent, market_: MarketState) => (agent as any).act(market_, market_.head, policy, new Trace(`t-${Math.random()}`, "fork"), 0, 1, undefined, "hot");

test("a poll and a frame deciding together send one trade, not two", async () => {
  const sent: string[] = [];
  handle = async (call) => {
    if (call.method === "eth_getTransactionCount") {
      // The window the race needs: the first send is waiting on its nonce while the second one decides.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return "0x7";
    }
    if (call.method === "eth_sendRawTransactionSync") {
      sent.push(call.params[0]);
      return { status: "0x1", blockNumber: "0x65", blockHash: BLOCK_A, gasUsed: "0x5", effectiveGasPrice: "0x1", logs: [] };
    }
    return new Error(`unexpected ${call.method}`);
  };
  const agent = liveAgent();
  await Promise.all([act(agent, market), act(agent, market)]);
  assert.equal(sent.length, 1, "the same order tranche went out twice");
  agent.close();
});

test("a preconfirmed receipt a reorg removes stops counting, and the same bytes go out again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "holdfast-"));
  const rpc = new RpcClient(url);
  const ledger = new Ledger(join(dir, "ledger.jsonl"));
  const exec = new Executor({ rpc, ledger, agentKey: AGENT_KEY, vault: HSKSWAP.router, chainId: 177, sendMode: "sync" });
  const decision = { action: "trade", trigger: "market", orderId: "m", tokenIn: HSKSWAP.whsk, amountIn: 1n, quotedOut: 1n, minOut: 1n, reason: "test" } as never;
  let receipt: unknown = { status: "0x1", blockNumber: "0x65", blockHash: BLOCK_A, gasUsed: "0x5", effectiveGasPrice: "0x1", logs: [] };
  const sent: string[] = [];
  handle = (call) => {
    if (call.method === "eth_sendRawTransactionSync") {
      sent.push(call.params[0]);
      return receipt;
    }
    if (call.method === "eth_sendRawTransaction") {
      sent.push(call.params[0]);
      return "0x01";
    }
    if (call.method === "eth_getTransactionReceipt") return receipt;
    return new Error(`unexpected ${call.method}`);
  };
  const intent = await exec.submit("k", decision, market, new Trace("t", "fork"), 9);
  assert.equal(intent.status, "included");
  assert.equal(intent.blockHash, BLOCK_A);

  // Still there, on the same block: nothing changes.
  assert.deepEqual(await exec.reconcile(102n), []);

  // Moved to another block: the new receipt is recorded.
  receipt = { status: "0x1", blockNumber: "0x66", blockHash: BLOCK_B, gasUsed: "0x5", effectiveGasPrice: "0x1", logs: [] };
  const moved = await exec.reconcile(103n);
  assert.equal(moved.length, 1);
  assert.equal(ledger.get("k")!.blockNumber, 102n);
  assert.equal(ledger.get("k")!.reorgs, 1);

  // Gone: it is in flight again, and no longer a fill.
  receipt = null;
  const gone = await exec.reconcile(104n);
  assert.equal(gone[0]!.status, "broadcast");
  assert.equal(ledger.get("k")!.amountOut, undefined);
  assert.equal(ledger.inFlight()?.key, "k");
  await exec.broadcast(ledger.get("k")!, 104n);
  assert.equal(new Set(sent).size, 1, "only ever one set of signed bytes");

  // Back, then old enough: checking stops.
  receipt = { status: "0x1", blockNumber: "0x70", blockHash: BLOCK_A, gasUsed: "0x5", effectiveGasPrice: "0x1", logs: [] };
  const settled = await exec.settle(ledger.get("k")!);
  assert.equal(settled!.status, "included");
  await exec.reconcile(112n + 64n);
  assert.equal(ledger.get("k")!.finalized, true);
  let calls = 0;
  handle = () => { calls++; return null; };
  await exec.reconcile(1000n);
  assert.equal(calls, 0, "a finalized receipt costs no more reads");

  // All of this survives a restart.
  ledger.close();
  const reopened = new Ledger(join(dir, "ledger.jsonl"));
  assert.equal(reopened.get("k")!.finalized, true);
  assert.equal(reopened.get("k")!.reorgs, 2);
  reopened.close();
  rpc.close();
});

test("a fill the reorg took back no longer counts against its order", () => {
  const agent = liveAgent();
  agent.ledger.reserve({ key: "order:1:m:0", intentId: agent.ledger.nextIntentId(), bodyHash: "0x00", orderId: "m", tokenIn: HSKSWAP.whsk, amountIn: 5n * HSK, minOut: 1n, deadline: 1n });
  agent.ledger.update("order:1:m:0", { status: "included" });
  (agent as any).rebuildRuntime();
  assert.equal(agent.runtime.get("m")!.filled, 5n * HSK);
  agent.ledger.update("order:1:m:0", { status: "broadcast" });
  (agent as any).rebuildRuntime();
  assert.equal(agent.runtime.get("m")!.filled, 0n);
  agent.close();
});

test("each trade carries the hash of its decision, and the same hash is in the ledger", async () => {
  handle = (call) => {
    if (call.method === "eth_sendRawTransactionSync") return { status: "0x1", blockNumber: "0x65", blockHash: BLOCK_A, gasUsed: "0x5", effectiveGasPrice: "0x1", logs: [] };
    return "0x7";
  };
  const agent = liveAgent();
  const { intent } = await act(agent, market);
  const parsed = parseTransaction(intent.rawTx);
  assert.equal(hashInCalldata(parsed.data as Hex), intent.decisionHash);
  assert.equal(auditIntent(intent, parsed.data as Hex).verdict, "matches");
  assert.equal(JSON.parse(intent.decisionBody).block, "100");
  agent.close();
});

function preflightAgent() {
  return new Agent({
    config: { rpcUrl: url, chainId: 177, live: true, mode: "live", preflight: true, pollMs: 650, dataDir: mkdtempSync(join(tmpdir(), "holdfast-")), twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 30_000, poolKind: "v3", agentKey: AGENT_KEY, vault: HSKSWAP.router },
    lane: "fork",
    policy: () => policy,
    mark: () => null,
    now: () => 100_000,
  });
}
const AMOUNT_OUT = `0x${(8_700_000n).toString(16).padStart(64, "0")}`;

test("a send that finishes during another decision's preflight supersedes that decision", async () => {
  const sent: string[] = [];
  let preflights = 0;
  handle = async (call) => {
    if (call.method === "eth_call") {
      // The second decision is still waiting for the vault's answer when the first one has sent and finished.
      if (++preflights === 2) await new Promise((resolve) => setTimeout(resolve, 150));
      return AMOUNT_OUT;
    }
    if (call.method === "eth_estimateGas") return "0x24000";
    if (call.method === "eth_getBalance") return `0x${(10n ** 18n).toString(16)}`;
    if (call.method === "eth_getTransactionCount") return "0x7";
    if (call.method === "eth_sendRawTransactionSync") {
      sent.push(call.params[0]);
      return { status: "0x1", blockNumber: "0x65", blockHash: BLOCK_A, gasUsed: "0x5", effectiveGasPrice: "0x1", logs: [] };
    }
    return new Error(`unexpected ${call.method}`);
  };
  const agent = preflightAgent();
  const [first, second] = await Promise.all([act(agent, market), act(agent, market)]);
  assert.equal(sent.length, 1);
  assert.equal(first.intent?.status, "included");
  assert.equal(second.decision.code, "stale-state");
  assert.equal(second.intent, undefined);
  agent.close();
});

test("a pool change during preflight stops the trade before anything is signed", async () => {
  const methods: string[] = [];
  let agent: Agent;
  handle = (call) => {
    methods.push(call.method);
    if (call.method === "eth_call") {
      (agent as any).poolGeneration++;
      return AMOUNT_OUT;
    }
    if (call.method === "eth_estimateGas") return "0x24000";
    if (call.method === "eth_getBalance") return `0x${(10n ** 18n).toString(16)}`;
    return new Error(`unexpected ${call.method}`);
  };
  agent = preflightAgent();
  const record = await act(agent, market);
  assert.equal(record.decision.code, "stale-state");
  assert.deepEqual(methods.sort(), ["eth_call", "eth_estimateGas", "eth_getBalance"]);
  assert.deepEqual(agent.ledger.all(), [], "nothing is reserved for a trade that never started");
  agent.close();
});

test("a node that cannot answer the preflight stops a market order from going out", async () => {
  const sent: string[] = [];
  handle = (call) => {
    if (call.method.startsWith("eth_sendRaw")) sent.push(call.method);
    return new Error("upstream connect error");
  };
  const agent = preflightAgent();
  const record = await act(agent, market);
  assert.equal(record.decision.code, "preflight-unverified");
  assert.deepEqual(sent, []);
  assert.equal(record.simulated.ok, null);
  agent.close();
});

test("a stop-loss goes out even when the node cannot answer the preflight, because the vault still checks it", async () => {
  const sent: string[] = [];
  handle = (call) => {
    if (call.method === "eth_getTransactionCount") return "0x7";
    if (call.method === "eth_sendRawTransactionSync") {
      sent.push(call.params[0]);
      return { status: "0x1", blockNumber: "0x65", blockHash: BLOCK_A, gasUsed: "0x5", effectiveGasPrice: "0x1", logs: [] };
    }
    return new Error("upstream connect error");
  };
  const stopPolicy: Policy = { ...DEFAULT_POLICY, stopConfirmBlocks: 1, orders: [{ id: "s", kind: "stop-loss", amountIn: 100n * HSK, triggerPriceX18: 90_000n }] };
  const agent = new Agent({
    config: { rpcUrl: url, chainId: 177, live: true, mode: "live", preflight: true, pollMs: 650, dataDir: mkdtempSync(join(tmpdir(), "holdfast-")), twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 30_000, poolKind: "v3", agentKey: AGENT_KEY, vault: HSKSWAP.router },
    lane: "fork",
    policy: () => stopPolicy,
    mark: () => null,
    now: () => 100_000,
  });
  const record = await (agent as any).act(market, market.head, stopPolicy, new Trace("t-stop", "fork"), 0, 1, undefined, "hot");
  assert.equal(sent.length, 1);
  assert.equal(record.simulated.ok, null, "the record says it went out unverified");
  agent.close();
});

const tradedLog = (address: string, intentId: Hex, amountIn: bigint, amountOut: bigint) => ({
  address,
  topics: encodeEventTopics({ abi: VAULT_ABI, eventName: "Traded", args: { intentId, tokenIn: HSKSWAP.whsk } }),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [amountIn, amountOut, 0n]),
});

test("only the vault's own event for this intent counts as the outcome", async () => {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "holdfast-")), "ledger.jsonl"));
  const rpc = new RpcClient("http://127.0.0.1:9");
  const executor = new Executor({ rpc, ledger, agentKey: AGENT_KEY, vault: HSKSWAP.router, chainId: 177 });
  const intentId = `0x${"1".repeat(64)}` as Hex;
  const other = `0x${"2".repeat(64)}` as Hex;
  const reserve = (key: string, id: Hex) => ledger.reserve({ key, intentId: id, bodyHash: id, orderId: "o", tokenIn: HSKSWAP.whsk, amountIn: 100n, minOut: 1n, deadline: 1n }).intent;
  const receipt = (logs: unknown[]) => ({ status: "0x1", blockNumber: "0x65", blockHash: BLOCK_A, gasUsed: "0x5", effectiveGasPrice: "0x1", logs });

  const forged = await (executor as any).record(reserve("forged", intentId), receipt([tradedLog(HSKSWAP.whsk, intentId, 100n, 999_999n)]));
  assert.equal(forged.amountOut, 0n, "an event from another contract is ignored");
  assert.equal(forged.outcomeUnverified, true);

  const elsewhere = await (executor as any).record(reserve("elsewhere", intentId), receipt([tradedLog(HSKSWAP.router, other, 100n, 999_999n)]));
  assert.equal(elsewhere.outcomeUnverified, true, "the vault's event for another intent is not this trade's");

  const partial = await (executor as any).record(reserve("partial", intentId), receipt([tradedLog(HSKSWAP.router, intentId, 40n, 90n)]));
  assert.equal(partial.amountOut, 90n);
  assert.equal(partial.amountSpent, 40n, "a thin pool took less than asked");
  assert.equal(partial.outcomeUnverified, undefined);
  ledger.close();
  rpc.close();
});

/** Answers the venue's reads as a correct market would, apart from whatever `over` changes. */
function venueHandler(over: Record<string, unknown> = {}) {
  const abi = parseAbi(["function decimals() view returns (uint8)", "function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)"]);
  void abi;
  const word = (value: bigint | string) => `0x${(typeof value === "string" ? value.slice(2) : value.toString(16)).padStart(64, "0")}`;
  const selectors: Record<string, string> = { "0x313ce567": "decimals", "0x0dfe1681": "token0", "0xd21220a7": "token1", "0xddca3f43": "fee" };
  return (call: any) => {
    if (call.method === "eth_chainId") return over.chainId ?? "0x85";
    if (call.method === "eth_blockNumber") return "0x10";
    if (call.method === "eth_getCode") return over[`code:${call.params[0].toLowerCase()}`] ?? "0x6000";
    if (call.method === "eth_call") {
      const name = selectors[call.params[0].data.slice(0, 10)];
      if (over[`${name}Fails`]) return new Error("execution reverted");
      if (name === "decimals") return word(call.params[0].to.toLowerCase() === HSKSWAP.usdt.toLowerCase() ? BigInt((over.usdtDecimals as number) ?? 6) : 18n);
      if (name === "token0") return word((over.token0 as string) ?? HSKSWAP.whsk);
      if (name === "token1") return word(HSKSWAP.usdt);
      if (name === "fee") return word(BigInt(HSKSWAP.fee));
    }
    return new Error(`unexpected ${call.method}`);
  };
}
const venueConfig = { chainId: 133, poolKind: "constant-product" as const };

test("venue check: a correct market passes", async () => {
  handle = venueHandler();
  const rpc = new RpcClient(url);
  const report = await verifyVenue(rpc, venueConfig);
  rpc.close();
  assert.equal(report.verdict, "pass", JSON.stringify(report.checks.filter((c) => c.status !== "pass")));
  assert.ok(report.checks.every((c) => c.source === "authoritative"));
});

test("venue check: each wrong answer fails, and names itself", async () => {
  for (const [over, name] of [
    [{ chainId: "0xb1" }, "chain id"],
    [{ [`code:${HSKSWAP.pool.toLowerCase()}`]: "0x" }, "pool code"],
    [{ usdtDecimals: 18 }, "usdt decimals"],
    [{ token0: HSKSWAP.usdt }, "pool token0"],
  ] as const) {
    handle = venueHandler(over);
    const rpc = new RpcClient(url);
    const report = await verifyVenue(rpc, venueConfig);
    rpc.close();
    assert.equal(report.verdict, "fail", name);
    assert.equal(report.checks.find((c) => c.status === "fail")?.name, name);
  }
});

test("venue check: a read nobody answered is unverified, which is not a pass", async () => {
  handle = venueHandler({ decimalsFails: true });
  const rpc = new RpcClient(url);
  const report = await verifyVenue(rpc, venueConfig);
  rpc.close();
  assert.equal(report.verdict, "unverified");
});

test("a live agent will not start on a venue that fails its check, and sends nothing", async () => {
  const sent: string[] = [];
  const base = venueHandler({ usdtDecimals: 18 });
  handle = (call) => {
    if (call.method.startsWith("eth_sendRaw")) sent.push(call.method);
    return base(call);
  };
  const agent = new Agent({
    config: { rpcUrl: url, chainId: 133, live: true, mode: "live", preflight: true, pollMs: 650, dataDir: mkdtempSync(join(tmpdir(), "holdfast-")), twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 30_000, poolKind: "constant-product", agentKey: AGENT_KEY, vault: HSKSWAP.router },
    lane: "fork",
    policy: () => policy,
    mark: () => null,
    now: () => 100_000,
  });
  await assert.rejects(agent.run(), /Venue check fail/);
  assert.deepEqual(sent, []);
  agent.close();
});

test("a preflight the vault refuses sends nothing and costs no gas", async () => {
  const sent: string[] = [];
  handle = (call) => {
    if (call.method === "eth_call") return Object.assign(new Error("execution reverted"), { rpcData: "0x" });
    if (call.method.startsWith("eth_sendRaw")) sent.push(call.method);
    return new Error(`unexpected ${call.method}`);
  };
  const agent = new Agent({
    config: { rpcUrl: url, chainId: 177, live: true, mode: "live", preflight: true, pollMs: 650, dataDir: mkdtempSync(join(tmpdir(), "holdfast-")), twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 30_000, poolKind: "v3", agentKey: AGENT_KEY, vault: HSKSWAP.router },
    lane: "fork",
    policy: () => policy,
    mark: () => null,
    now: () => 100_000,
  });
  const record = await act(agent, market);
  assert.equal(record.decision.action, "hold");
  assert.equal(record.decision.code, "preflight-refused");
  assert.equal(record.simulated.ok, false);
  assert.deepEqual(sent, []);
  agent.close();
});

test("simulate mode asks the vault, has no way to send, and needs no key", async () => {
  const methods: string[] = [];
  handle = (call) => {
    methods.push(call.method);
    if (call.method === "eth_call" && call.params[0].data.startsWith("0xf5ff5c76")) return `0x${"00".repeat(12)}${"11".repeat(20)}`;
    if (call.method === "eth_call") return `0x${(870_000).toString(16).padStart(64, "0")}`;
    return new Error(`unexpected ${call.method}`);
  };
  const agent = new Agent({
    config: { rpcUrl: url, chainId: 177, live: false, mode: "simulate", pollMs: 650, dataDir: mkdtempSync(join(tmpdir(), "holdfast-")), twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 30_000, poolKind: "v3", vault: HSKSWAP.router },
    lane: "fork",
    policy: () => policy,
    mark: () => null,
    now: () => 100_000,
  });
  assert.equal(agent.canTrade, false);
  assert.equal(agent.executor, undefined);
  const record = await act(agent, market);
  assert.equal(record.simulated.ok, true);
  assert.equal(record.simulated.amountOut, 870_000n);
  assert.equal(record.intent, undefined);
  assert.equal(record.observeOnly, true);
  assert.ok(methods.every((m) => !m.startsWith("eth_sendRaw")));
  agent.close();
});
