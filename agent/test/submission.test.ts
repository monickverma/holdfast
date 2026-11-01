import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { encodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { Agent } from "../src/agent.js";
import { HSKSWAP } from "../src/config.js";
import type { Decision } from "../src/decide.js";
import { Trace } from "../src/trace.js";
import { Executor, SubmissionBusy } from "../src/executor.js";
import { DEFAULT_POLICY } from "../src/policy.js";

const AMOUNT = 10n ** 18n;
const word = (type: string, value: unknown): Hex => encodeAbiParameters([{ type } as never], [value] as never);

function fixture(t: TestContext) {
  let number = 100n;
  let hash: Hex = "0xabc";
  let sqrtPrice = (2n ** 96n * 10015n) / 10000n;
  const agent = new Agent({
    config: {
      rpcUrl: "http://127.0.0.1:9", chainId: 177, live: false, pollMs: 650,
      dataDir: mkdtempSync(join(tmpdir(), "holdfast-stop-")), twapWindowSec: 300,
      maxStateAgeMs: 6_000, maxMarkAgeMs: 30_000, poolKind: "v3",
      vault: HSKSWAP.router, legacyVault: true, agentKey: `0x${"11".repeat(32)}`,
    },
    lane: "fork",
    policy: () => ({ ...DEFAULT_POLICY, orders: [
      { id: "order", kind: "market-sell", amountIn: AMOUNT },
    ] }),
    mark: () => null,
    now: () => 100_000,
  });
  t.after(() => agent.close());
  agent.readMode = "pinned";
  t.mock.method(agent.rpc, "call", async (method: string) => {
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getTransactionReceipt") return null;
    if (method === "eth_getCode") return "0x";
    assert.equal(method, "eth_getBlockByNumber");
    return { number: `0x${number.toString(16)}`, hash, timestamp: "0x64", baseFeePerGas: "0x0" };
  });
  t.mock.method(agent.rpc, "batch", async () => [
    encodeAbiParameters(
      [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }],
      [sqrtPrice, 30, 0, 1, 1, 0, true],
    ),
    word("uint128", 10n ** 24n),
    encodeAbiParameters([{ type: "int56[]" }, { type: "uint160[]" }], [[0n, 9000n], [0n, 0n]]),
    word("uint256", 0n),
    encodeAbiParameters([{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }], [AMOUNT, sqrtPrice, 0, 0n]),
    word("bool", false),
    ...[100n * AMOUNT, AMOUNT, 100n * AMOUNT, 1n, 100n * AMOUNT, AMOUNT, 100n * AMOUNT, 1n].map((value) => word("uint256", value)),
    "0x0",
  ]);
  t.mock.method(agent.rpc, "callOnce", async () => ({ status: "0x1", blockNumber: "0x65", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [] }));
  return agent;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const moved = () => ({ block: 101n, index: 0, payloadId: "p", arrivedAt: performance.now(), logs: [{
  address: HSKSWAP.pool,
  topics: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67" as Hex],
  data: encodeAbiParameters(parseAbiParameters("int256,int256,uint160,uint128,int24"), [1n, -1n, (2n ** 96n * 10015n) / 10000n, 10n ** 24n, 30]),
}] });

for (const firstPath of ["poll", "stream"]) for (const stage of ["reserve", "nonce", "sign"]) {
  test(`${firstPath} owns submission while ${stage} awaits; the other path skips`, async (t) => {
    const agent = fixture(t);
    await agent.step();
    await agent.refreshWarm(agent.lastMarket!, 0);
    (agent as any).options.config.live = true;
    const entered = gate();
    const held = gate();
    const original = Trace.prototype.span;
    let paused = false;
    t.mock.method(Trace.prototype, "span", async function<T>(this: Trace, label: string, work: () => T | Promise<T>): Promise<T> {
      if (label === "sign" && stage === "sign" && !paused) { paused = true; entered.release(); await held.promise; }
      const result = await original.call(this, label, work) as T;
      if (label === stage && !paused) { paused = true; entered.release(); await held.promise; }
      return result;
    });
    const submit = t.mock.method(agent.executor!, "submit");
    const first = firstPath === "poll" ? agent.step(0, true) : agent.reactTo(moved());
    await entered.promise;
    let overlapping: number;
    try {
      if (firstPath === "poll") await agent.reactTo(moved());
      else await agent.step(0, true);
      overlapping = submit.mock.callCount();
    } finally { held.release(); }
    await first;
    assert.equal(overlapping, 1, "the second path must skip while the first owns submission");
    assert.equal(agent.ledger.all().length, 1);
  });
}

for (const stage of ["reserve", "nonce", "sign"]) {
  test(`state that changes during ${stage} cancels the attempt without counting as a failed trade`, async (t) => {
    const agent = fixture(t);
    await agent.step();
    (agent as any).options.config.live = true;
    const original = Trace.prototype.span;
    let changed = false;
    t.mock.method(Trace.prototype, "span", async function<T>(this: Trace, label: string, work: () => T | Promise<T>): Promise<T> {
      const result = await original.call(this, label, work) as T;
      if (label === stage && !changed) { changed = true; (agent as any).poolGeneration++; }
      return result;
    });
    const first = await agent.step(0, true);
    assert.equal(first?.decision.action, "hold");
    assert.deepEqual(agent.ledger.all().map((intent) => intent.status), ["cancelled"]);
    assert.equal(agent.ledger.lastNonce(), null);
    const second = await agent.step(0, true);
    assert.equal(second?.intent?.status, "included", "the next decision gets a new attempt");
    assert.equal(agent.ledger.all().length, 2);
  });
}

test("a slow polling read does not delay a reaction, and cannot submit its old decision afterward", async (t) => {
  const agent = fixture(t);
  await agent.step();
  await agent.refreshWarm(agent.lastMarket!, 0);
  (agent as any).options.config.live = true;
  const entered = gate();
  const held = gate();
  const batch = agent.rpc.batch.bind(agent.rpc);
  t.mock.method(agent.rpc, "batch", async (...args: Parameters<typeof batch>) => { entered.release(); await held.promise; return batch(...args); });
  const submit = t.mock.method(agent.executor!, "submit");
  const poll = agent.step(0, true);
  await entered.promise;
  try {
    const reaction = await agent.reactTo(moved());
    assert.equal(reaction?.intent?.status, "included");
  } finally { held.release(); }
  const stale = await poll;
  assert.equal(stale?.intent, undefined);
  assert.equal(submit.mock.callCount(), 1);
});

test("a signing exception releases both submission guards", async (t) => {
  const agent = fixture(t);
  await agent.step();
  (agent as any).options.config.live = true;
  const account = (agent.executor as any).account;
  const sign = account.signTransaction.bind(account);
  let fail = true;
  t.mock.method(account, "signTransaction", async (...args: any[]) => { if (fail) throw new Error("sign failed"); return sign(...args); });
  await assert.rejects(agent.step(0, true), /sign failed/);
  assert.equal((agent as any).submitting, false);
  assert.equal(agent.executor!.busy, false);
  fail = false;
  assert.equal((await agent.step(0, true))?.intent?.status, "included");
});

test("a break during signing prevents persistence and broadcast", async (t) => {
  const agent = fixture(t);
  await agent.step();
  (agent as any).options.config.live = true;
  const account = (agent.executor as any).account;
  const sign = account.signTransaction.bind(account);
  t.mock.method(account, "signTransaction", async (...args: any[]) => {
    const raw = await sign(...args);
    (agent as any).dropWarm(101n);
    return raw;
  });
  const send = t.mock.method(agent.rpc, "callOnce");
  const record = await agent.step(0, true);
  assert.equal(record?.decision.action, "hold");
  assert.equal(send.mock.callCount(), 0);
  assert.equal(agent.ledger.all()[0]?.rawTx, undefined);
  assert.equal(agent.executor!.busy, false);
});

test("two executors for the same signer cannot reserve concurrently", async (t) => {
  const agent = fixture(t);
  await agent.step();
  const decision = agent.lastDecision!.decision;
  assert.equal(decision.action, "trade");
  if (decision.action !== "trade") return;
  const other = new Executor({ rpc: agent.rpc, ledger: agent.ledger, agentKey: `0x${"11".repeat(32)}`, vault: HSKSWAP.router, chainId: 177 });
  const entered = gate();
  const held = gate();
  const account = (agent.executor as any).account;
  const sign = account.signTransaction.bind(account);
  t.mock.method(account, "signTransaction", async (...args: any[]) => { entered.release(); await held.promise; return sign(...args); });
  const first = agent.executor!.submit("first", decision, agent.lastMarket!, new Trace("one", "fork"), 0);
  await entered.promise;
  try {
    await assert.rejects(other.submit("second", decision, agent.lastMarket!, new Trace("two", "fork"), 0), SubmissionBusy);
    assert.equal(agent.ledger.all().length, 1);
  } finally { held.release(); }
  await first;
  assert.equal(other.busy, false);
});

test("a newer pool frame during signing supersedes the decision", async (t) => {
  const agent = fixture(t);
  await agent.step();
  (agent as any).options.config.live = true;
  const account = (agent.executor as any).account;
  const sign = account.signTransaction.bind(account);
  t.mock.method(account, "signTransaction", async (...args: any[]) => {
    const raw = await sign(...args);
    (agent as any).observeFrame(moved());
    return raw;
  });
  const send = t.mock.method(agent.rpc, "callOnce");
  const record = await agent.step(0, true);
  assert.equal(send.mock.callCount(), 0);
  assert.equal(record?.decision.action, "hold");
});
