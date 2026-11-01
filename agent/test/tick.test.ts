import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encodeAbiParameters, encodeFunctionResult, keccak256, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HSKSWAP } from "../src/config.js";
import { Executor } from "../src/executor.js";
import { Ledger } from "../src/ledger.js";
import { readTick, type MarketState } from "../src/reader.js";
import { RpcClient } from "../src/rpc.js";
import { Trace } from "../src/trace.js";

const AGGREGATE = parseAbi([
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns (Result[] returnData)",
]);
const PARENT = `0x${"ab".repeat(32)}` as Hex;

const word = (type: string, value: unknown): Hex => encodeAbiParameters([{ type } as never], [value] as never);
const slot0 = encodeAbiParameters(
  [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }],
  [2n ** 96n, 0, 0, 1, 1, 0, true],
);
const observe = encodeAbiParameters(
  [{ type: "int56[]" }, { type: "uint160[]" }],
  [[0n, 0n], [0n, 0n]],
);

let handle: (call: any) => unknown;
let server: http.Server;
let url: string;
const seen: any[][] = [];

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const list = Array.isArray(body) ? body : [body];
      seen.push(list);
      const replies = list.map((call) => {
        const out = handle(call);
        return out instanceof Error
          ? { jsonrpc: "2.0", id: call.id, error: { code: (out as any).code ?? -32000, message: out.message } }
          : { jsonrpc: "2.0", id: call.id, result: out };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

/** A node whose latest block is `head`, while the multicall ran on block `ranOn`. */
function node(head: bigint, ranOn: bigint, parent: Hex = PARENT) {
  handle = (call) => {
    if (call.method === "eth_getBlockByNumber") {
      return { number: `0x${head.toString(16)}`, hash: `0x${"cd".repeat(32)}`, parentHash: PARENT, timestamp: "0x64", baseFeePerGas: "0x3b9aca00" };
    }
    if (call.method === "eth_maxPriorityFeePerGas") return "0x1";
    if (call.method === "eth_getTransactionCount") return "0x2a";
    if (call.method === "eth_call") {
      const results = [word("uint256", ranOn), word("bytes32", parent), slot0, word("uint128", 5n), observe, word("uint256", 7n)];
      return encodeFunctionResult({
        abi: AGGREGATE,
        functionName: "aggregate3",
        result: results.map((returnData) => ({ success: true, returnData })),
      });
    }
    throw new Error(`unexpected ${call.method}`);
  };
}

const config = { twapWindowSec: 300 };
const AGENT_KEY = `0x${"11".repeat(32)}` as Hex;

test("one round trip returns the head, state and nonce", async () => {
  node(10n, 10n);
  const rpc = new RpcClient(url);
  seen.length = 0;
  const tick = await readTick(rpc, config, [], privateKeyToAccount(AGENT_KEY).address);
  assert.equal(seen.length, 1, "exactly one HTTP request");
  assert.equal(tick!.market.head.number, 10n);
  assert.equal(tick!.market.liquidity, 5n);
  assert.equal(tick!.market.l1FeeWei, 7n);
  assert.equal(tick!.pendingNonce, 42);
  rpc.close();
});

test("state from another block is refused, not used", async () => {
  node(10n, 11n);
  const rpc = new RpcClient(url);
  assert.equal(await readTick(rpc, config, []), null);
  rpc.close();
});

test("state on a different fork at the same height is refused", async () => {
  node(10n, 10n, `0x${"ee".repeat(32)}`);
  const rpc = new RpcClient(url);
  assert.equal(await readTick(rpc, config, []), null);
  rpc.close();
});

function executor(rpc: RpcClient) {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "holdfast-")), "ledger.jsonl"));
  const exec = new Executor({ rpc, ledger, agentKey: AGENT_KEY, vault: HSKSWAP.router, chainId: 133, sendMode: "sync" });
  return { exec, ledger };
}
const decision = { action: "trade", tokenIn: HSKSWAP.whsk, amountIn: 1n, minOut: 1n, orderId: "o" } as never;
const market = { head: { number: 1n, hash: "0x", timestamp: 100n, baseFeePerGas: 1n }, priorityFeePerGas: 1n } as unknown as MarketState;
const receipt = { status: "0x1", blockNumber: "0x2", gasUsed: "0x5", effectiveGasPrice: "0x1", logs: [] };

test("sync send records the receipt it returns, without a nonce request", async () => {
  const methods: string[] = [];
  handle = (call) => {
    methods.push(call.method);
    return receipt;
  };
  const rpc = new RpcClient(url);
  const { exec, ledger } = executor(rpc);
  const intent = await exec.submit("k", decision, market, new Trace("t", "testnet"), 9);
  assert.deepEqual(methods, ["eth_sendRawTransactionSync"]);
  assert.equal(intent.status, "included");
  assert.equal(intent.nonce, 9);
  assert.equal(intent.blockNumber, 2n);
  ledger.close();
  rpc.close();
});

test("a node without sync send falls back to the same signed bytes", async () => {
  const sent: Array<[string, string]> = [];
  handle = (call) => {
    sent.push([call.method, call.params[0]]);
    if (call.method === "eth_sendRawTransactionSync") return Object.assign(new Error("method not found"), { code: -32601 });
    return keccak256(call.params[0]);
  };
  const rpc = new RpcClient(url);
  const { exec, ledger } = executor(rpc);
  const intent = await exec.submit("k", decision, market, new Trace("t", "testnet"), 9);
  assert.deepEqual(sent.map(([m]) => m), ["eth_sendRawTransactionSync", "eth_sendRawTransaction"]);
  assert.equal(sent[0]![1], sent[1]![1], "identical bytes, so it can land only once");
  assert.equal(intent.status, "broadcast");
  assert.equal(exec.sendMode, "classic", "does not retry the missing method");
  ledger.close();
  rpc.close();
});

test("a sync timeout resends the same bytes and leaves the intent in flight", async () => {
  const sent: string[] = [];
  handle = (call) => {
    sent.push(call.params[0]);
    if (call.method === "eth_sendRawTransactionSync") return Object.assign(new Error("timed out waiting for receipt"), { code: 4 });
    return keccak256(call.params[0]);
  };
  const rpc = new RpcClient(url);
  const { exec, ledger } = executor(rpc);
  const intent = await exec.submit("k", decision, market, new Trace("t", "testnet"), 9);
  assert.equal(sent[0], sent[1]);
  assert.equal(intent.status, "broadcast");
  assert.equal(ledger.inFlight()?.key, "k", "polling takes over");
  assert.equal(exec.sendMode, "sync");
  ledger.close();
  rpc.close();
});
