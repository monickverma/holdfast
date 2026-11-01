import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { RpcClient, RpcError } from "../src/rpc.js";

type Handler = (body: any, res: http.ServerResponse) => void;

let handler: Handler;
let server: http.Server;
let url: string;

const reply = (res: http.ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const echo = (call: any) => ({ jsonrpc: "2.0", id: call.id, result: call.method });

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(JSON.parse(Buffer.concat(chunks).toString()), res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  handler = (body, res) => reply(res, Array.isArray(body) ? body.map(echo) : echo(body));
});

test("callOnce honours its own timeout", async () => {
  handler = () => {};
  const client = new RpcClient(url, { timeoutMs: 60_000 });
  const started = Date.now();
  await assert.rejects(client.callOnce("slow", [], 50), RpcError);
  assert.ok(Date.now() - started < 5_000);
  client.close();
});

const calls = [
  { method: "a", params: [] },
  { method: "b", params: [] },
  { method: "c", params: [] },
];

test("batch returns one HTTP request and reuses the socket", async () => {
  const rpc = new RpcClient(url);
  assert.deepEqual(await rpc.batch(calls), ["a", "b", "c"]);
  assert.deepEqual(await rpc.batch(calls), ["a", "b", "c"]);
  assert.equal(rpc.stats.httpRequests, 2);
  assert.equal(rpc.stats.logicalCalls, 6);
  assert.equal(rpc.stats.newSockets, 1);
  assert.equal(rpc.stats.reusedSockets, 1);
  rpc.close();
});

test("reordered responses are matched by id", async () => {
  handler = (body, res) => reply(res, [...body].reverse().map(echo));
  const rpc = new RpcClient(url);
  assert.deepEqual(await rpc.batch(calls), ["a", "b", "c"]);
  rpc.close();
});

test("partial batch throws rather than returning holes", async () => {
  handler = (body, res) => reply(res, body.slice(1).map(echo));
  const rpc = new RpcClient(url, { maxRetries: 0 });
  await assert.rejects(rpc.batch(calls), /missing response id/);
  rpc.close();
});

test("one failed member fails the batch and is not retried", async () => {
  let seen = 0;
  handler = (body, res) => {
    seen++;
    reply(res, [echo(body[0]), { jsonrpc: "2.0", id: body[1].id, error: { code: 3, message: "reverted" } }, echo(body[2])]);
  };
  const rpc = new RpcClient(url);
  await assert.rejects(rpc.batch(calls), (e: RpcError) => e.code === 3 && !e.retryable);
  assert.equal(seen, 1);
  rpc.close();
});

test("throttling is counted and retried", async () => {
  let seen = 0;
  handler = (body, res) => {
    if (++seen === 1) return reply(res, {}, 429);
    reply(res, body.map(echo));
  };
  const rpc = new RpcClient(url, { retryBaseMs: 1 });
  assert.deepEqual(await rpc.batch(calls), ["a", "b", "c"]);
  assert.equal(rpc.stats.rateLimited, 1);
  assert.equal(rpc.stats.retries, 1);
  rpc.close();
});

test("timeouts surface as a retryable error", async () => {
  handler = () => {};
  const rpc = new RpcClient(url, { timeoutMs: 30, maxRetries: 0 });
  await assert.rejects(rpc.batch(calls), (e: RpcError) => e.retryable && /timeout/.test(e.message));
  rpc.close();
});

test("callOnce does not retry a call with effects", async () => {
  let seen = 0;
  handler = (_body, res) => {
    seen++;
    reply(res, {}, 500);
  };
  const rpc = new RpcClient(url, { retryBaseMs: 1 });
  await assert.rejects(rpc.callOnce("eth_sendRawTransaction", ["0x"]));
  assert.equal(seen, 1);
  rpc.close();
});
