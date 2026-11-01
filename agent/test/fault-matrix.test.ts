// Crash at each point in an intent's life, against each thing the chain might then say. Each cell asks the same three
// questions: does it reach a truthful state, does the agent keep working, and did only one set of signed bytes ever go out.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encodeFunctionResult, type Hex } from "viem";
import { HSKSWAP } from "../src/config.js";
import { Executor } from "../src/executor.js";
import { Ledger } from "../src/ledger.js";
import { VAULT_ABI, type Head, type MarketState } from "../src/reader.js";
import { RpcClient } from "../src/rpc.js";
import { Trace } from "../src/trace.js";

const AGENT_KEY = `0x${"11".repeat(32)}` as Hex;
const OK_RECEIPT = { status: "0x1", blockNumber: "0x2", gasUsed: "0x5", effectiveGasPrice: "0x1", logs: [] };
const REVERTED_RECEIPT = { ...OK_RECEIPT, status: "0x0" };

interface Chain {
  receipt: unknown;
  /** What the vault's usedIntent says. */
  used: boolean;
  sendFails: boolean;
  pendingNonce: number;
}
let chain: Chain;
const sent: string[] = [];
let server: http.Server;
let url: string;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const call = JSON.parse(Buffer.concat(chunks).toString());
      const answer = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
      const fail = (message: string) => res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message } }));
      if (call.method === "eth_sendRawTransaction") {
        sent.push(call.params[0]);
        return chain.sendFails ? fail("node refused") : answer("0x01");
      }
      if (call.method === "eth_getTransactionReceipt") return answer(chain.receipt);
      if (call.method === "eth_getTransactionCount") return answer(`0x${chain.pendingNonce.toString(16)}`);
      if (call.method === "eth_call") {
        const selector = call.params[0].data.slice(0, 10);
        // usedIntent(bytes32); anything else is the revert-reason replay.
        if (selector === "0x6e9a38d3" || call.params[1] === "latest") return answer(encodeFunctionResult({ abi: VAULT_ABI, functionName: "usedIntent", result: chain.used }));
        return fail("reverted");
      }
      fail(`unexpected ${call.method}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const decision = { action: "trade", tokenIn: HSKSWAP.whsk, amountIn: 1n, minOut: 1n, orderId: "o" } as never;
const market = { head: { number: 1n, hash: "0x", timestamp: 100n, baseFeePerGas: 1n }, priorityFeePerGas: 1n } as unknown as MarketState;
const headAt = (timestamp: bigint): Head => ({ number: 50n, hash: "0x" as Hex, timestamp, baseFeePerGas: 1n });
// The deadline is 100 + 90 and the grace 30, so this head is past both.
const beforeDeadline = headAt(150n);
const pastDeadline = headAt(221n);

type CrashPoint = "reserved" | "signed" | "broadcast";

/** Runs the agent up to a crash point and returns a fresh process's view of the same ledger file. */
async function crashAt(point: CrashPoint): Promise<{ exec: Executor; ledger: Ledger; rpc: RpcClient; raw?: string; path: string }> {
  sent.length = 0;
  const path = join(mkdtempSync(join(tmpdir(), "holdfast-")), "ledger.jsonl");
  const rpc = new RpcClient(url, { maxRetries: 0 });
  const dying = new Ledger(path);
  const exec = new Executor({ rpc, ledger: dying, agentKey: AGENT_KEY, vault: HSKSWAP.router, chainId: 133, sendMode: "classic" });
  if (point === "reserved") {
    dying.reserve({ key: "k", intentId: dying.nextIntentId(), bodyHash: "0x00", orderId: "o", tokenIn: HSKSWAP.whsk, amountIn: 1n, minOut: 1n, deadline: 190n });
  } else {
    chain = { receipt: null, used: false, sendFails: point === "signed", pendingNonce: 7 };
    await exec.submit("k", decision, market, new Trace("t", "fork"), 7).catch(() => {});
  }
  dying.close();
  const raw = sent[0];
  const ledger = new Ledger(path);
  return { exec: new Executor({ rpc, ledger, agentKey: AGENT_KEY, vault: HSKSWAP.router, chainId: 133, sendMode: "classic" }), ledger, rpc, ...(raw ? { raw } : {}), path };
}

const finish = ({ ledger, rpc }: { ledger: Ledger; rpc: RpcClient }) => {
  ledger.close();
  rpc.close();
};
const oneSetOfBytes = () => assert.ok(new Set(sent).size <= 1, "a recovery never signs anything new");

for (const point of ["signed", "broadcast"] as const) {
  test(`crash at ${point}, then the chain has a fill: recorded as included`, async () => {
    const run = await crashAt(point);
    chain = { receipt: OK_RECEIPT, used: true, sendFails: false, pendingNonce: 8 };
    await run.exec.recover(50n);
    assert.equal(run.ledger.get("k")!.status, "included");
    assert.equal(run.ledger.inFlight(), undefined);
    oneSetOfBytes();
    finish(run);
  });

  test(`crash at ${point}, then the chain has a revert: recorded as reverted`, async () => {
    const run = await crashAt(point);
    chain = { receipt: REVERTED_RECEIPT, used: false, sendFails: false, pendingNonce: 8 };
    await run.exec.recover(50n);
    assert.equal(run.ledger.get("k")!.status, "reverted");
    assert.equal(run.ledger.inFlight(), undefined);
    finish(run);
  });

  test(`crash at ${point}, then the chain knows nothing: the same bytes go out again`, async () => {
    const run = await crashAt(point);
    chain = { receipt: null, used: false, sendFails: false, pendingNonce: 7 };
    await run.exec.recover(50n);
    assert.equal(run.ledger.get("k")!.status, "broadcast");
    assert.ok(sent.length >= 1);
    oneSetOfBytes();
    finish(run);
  });

  test(`crash at ${point}, then the node refuses the resend: start-up survives and it stays in flight`, async () => {
    const run = await crashAt(point);
    chain = { receipt: null, used: false, sendFails: true, pendingNonce: 7 };
    await run.exec.recover(50n);
    assert.equal(run.ledger.inFlight()?.key, "k");
    oneSetOfBytes();
    finish(run);
  });

  test(`crash at ${point}, then it never lands: past its deadline it expires and the agent is free again`, async () => {
    const run = await crashAt(point);
    chain = { receipt: null, used: false, sendFails: false, pendingNonce: 7 };
    const settled = await run.exec.settle(run.ledger.inFlight()!, pastDeadline);
    assert.equal(settled?.status, "expired");
    assert.equal(run.ledger.inFlight(), undefined);
    finish(run);
  });

  test(`crash at ${point}, then the vault shows it ran but the node has no receipt: it does not expire`, async () => {
    const run = await crashAt(point);
    chain = { receipt: null, used: true, sendFails: false, pendingNonce: 8 };
    assert.equal(await run.exec.settle(run.ledger.inFlight()!, pastDeadline), null);
    assert.equal(run.ledger.inFlight()?.key, "k", "calling it expired would resell an order that already filled");
    finish(run);
  });
}

test("crash at reserved: nothing was signed, so nothing is sent and nothing is in flight", async () => {
  const run = await crashAt("reserved");
  chain = { receipt: null, used: false, sendFails: false, pendingNonce: 7 };
  await run.exec.recover(50n);
  assert.equal(sent.length, 0);
  assert.equal(run.ledger.inFlight(), undefined);
  assert.equal(run.ledger.get("k")!.status, "reserved");
  finish(run);
});

test("a send that failed is retried on the next settle, with no restart", async () => {
  const run = await crashAt("signed");
  chain = { receipt: null, used: false, sendFails: false, pendingNonce: 7 };
  assert.equal(run.ledger.get("k")!.status, "signed");
  await run.exec.settle(run.ledger.inFlight()!, beforeDeadline);
  assert.equal(run.ledger.get("k")!.status, "broadcast");
  oneSetOfBytes();
  finish(run);
});

test("unconfirmed bytes are not resent on every poll", async () => {
  const run = await crashAt("signed");
  chain = { receipt: null, used: false, sendFails: false, pendingNonce: 7 };
  const before = sent.length;
  await run.exec.settle(run.ledger.inFlight()!, beforeDeadline);
  await run.exec.settle(run.ledger.inFlight()!, beforeDeadline);
  assert.equal(sent.length, before + 1);
  finish(run);
});

test("an expired intent frees its nonce, so the next trade is not stuck behind a gap", async () => {
  const run = await crashAt("broadcast");
  chain = { receipt: null, used: false, sendFails: false, pendingNonce: 7 };
  await run.exec.settle(run.ledger.inFlight()!, pastDeadline);
  assert.equal(run.ledger.lastNonce(), null);
  const next = await run.exec.submit("k2", decision, market, new Trace("t2", "fork"));
  assert.equal(next.nonce, 7);
  finish(run);
});

test("a signed intent that is still live keeps its nonce", async () => {
  const run = await crashAt("broadcast");
  assert.equal(run.ledger.lastNonce(), 7);
  finish(run);
});
