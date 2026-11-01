import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createViewer } from "../src/cli/viewer.js";
import { HSKSWAP } from "../src/config.js";
import { quantileReport } from "../src/stats.js";

async function fixture(work: (get: (path: string, body?: unknown) => Promise<{ status: number; text: string }>, dir: string) => Promise<void>, assistant: Parameters<typeof createViewer>[0] = {}) {
  // Outside data/, so a crashed test can never show its made-up rows as evidence.
  const dir = mkdtempSync(join(tmpdir(), "holdfast-viewer-"));
  const server = createViewer({ dataDir: dir, assistant: null, vaultAddress: "", ...assistant });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const get = (path: string, body?: unknown) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, text }));
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try { await work(get, dir); }
  finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}
const jsonl = (dir: string, name: string, rows: unknown[]) => writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n"));
const trace = (lane: string, ms: number, i: number) => ({ id: `${lane}-${i}`, lane, wallTime: "saved-time", attrs: { decisionToBroadcastMs: ms }, spans: [{ stage: "state", startMs: 0, endMs: ms, ok: true }] });

test("viewer refuses raw, encoded and Windows path traversal", async () => fixture(async (get) => {
  for (const path of ["/../package.json", "/%2e%2e/package.json", "/%252e%252e/package.json", "/..%5cpackage.json", "/%00"]) assert.equal((await get(path)).status, 400);
  assert.equal((await get("/data/ledger.jsonl")).status, 404);
}));

test("viewer returns no configuration values or raw transaction fields", async () => fixture(async (get, dir) => {
  const prior = process.env.VIEWER_TEST_SENTINEL;
  process.env.VIEWER_TEST_SENTINEL = "ENV_VALUE_MUST_NOT_APPEAR";
  jsonl(dir, "ledger.jsonl", [{ key: "a", lane: "fork", status: "included", rawTx: "PRIVATE_RAW_SENTINEL", statusDetail: "CONFIG_SENTINEL" }]);
  try {
    for (const path of ["/", "/api/evidence", "/api/config", "/api/env"]) {
      const response = await get(path);
      assert.ok(!response.text.includes("ENV_VALUE_MUST_NOT_APPEAR"));
      assert.ok(!response.text.includes("CONFIG_SENTINEL"));
      assert.ok(!response.text.includes("PRIVATE_RAW_SENTINEL"));
      assert.ok(!response.text.includes("process.env"));
    }
  } finally {
    if (prior === undefined) delete process.env.VIEWER_TEST_SENTINEL;
    else process.env.VIEWER_TEST_SENTINEL = prior;
  }
}, { vaultAddress: "CONFIG_SENTINEL" }));

test("viewer keeps lane samples and same-key trades apart", async () => fixture(async (get, dir) => {
  jsonl(dir, "traces.jsonl", ["mainnet", "fork", "replay", "testnet"].flatMap((lane, index) => Array.from({ length: 6 }, (_, i) => trace(lane, (index + 1) * 100, i))));
  jsonl(dir, "ledger.jsonl", ["mainnet", "fork", "replay", "testnet"].map((lane) => ({ key: "same-key", lane, tokenIn: HSKSWAP.whsk, amountIn: "1000000000000000000", status: "included", txHash: `0x${"a".repeat(64)}` })));
  const data = JSON.parse((await get("/api/evidence")).text);
  for (const [index, lane] of data.lanes.entries()) {
    assert.deepEqual(lane.latency.decisionToBroadcastMs.P50, quantileReport(Array(6).fill((index + 1) * 100), .5));
    assert.equal(lane.trades.length, 1);
    assert.equal(lane.totals.fills, 1);
    assert.equal(lane.totals.reverts, 0);
    assert.equal(Boolean(lane.trades[0].link), ["mainnet", "testnet"].includes(lane.lane));
  }
}));

test("viewer shows the vault's revert reason and no raw revert data", async () => fixture(async (get, dir) => {
  jsonl(dir, "traces.jsonl", [trace("fork", 10, 0)]);
  jsonl(dir, "ledger.jsonl", [{ key: "a", lane: "fork", status: "reverted", revertReason: "OverTradeCap" }, { key: "b", lane: "fork", status: "included" }]);
  const [refused, filled] = JSON.parse((await get("/api/evidence")).text).lanes[1].trades;
  assert.equal(refused.reason, "OverTradeCap"); assert.equal(refused.output, "none"); assert.equal(filled.reason, null);
}));

test("viewer hides unsupported quantiles with n and the shared reason", async () => fixture(async (get, dir) => {
  jsonl(dir, "traces.jsonl", [trace("fork", 10, 0)]);
  const q = JSON.parse((await get("/api/evidence")).text).lanes[1].latency.decisionToBroadcastMs.P99;
  assert.equal(q.n, 1); assert.equal(q.value, null); assert.match(q.withheld, /below 299/);
}));

test("viewer has an empty data state and no configured vault", async () => fixture(async (get) => {
  const data = JSON.parse((await get("/api/evidence")).text);
  assert.equal(data.empty, true); assert.equal(data.attacks, null); assert.equal(data.vault.status, "No vault is set.");
  assert.match((await get("/app.js")).text, /holds no run data/);
}));

test("viewer starts normally and explains chat without a key", async () => fixture(async (get) => {
  assert.match(JSON.parse((await get("/api/evidence")).text).chat, /ANTHROPIC_API_KEY is missing/);
  const reply = await get("/api/chat", { message: "What happened?" });
  assert.equal(reply.status, 503); assert.match(reply.text, /key|KEY/);
}));

test("viewer discards policy proposals and labels answers as model output", async () => {
  await fixture(async (get) => {
    const reply = JSON.parse((await get("/api/chat", { message: "Change policy" })).text);
    assert.equal(reply.label, "Model output"); assert.match(reply.text, /existing REPL/); assert.equal(reply.policy, undefined);
  }, { assistant: { handle: async () => ({ kind: "policy", text: "Activated!" }) } });
});

test("viewer joins ledger through decision trace and gives unlinked rows the directory's only lane", async () => fixture(async (get, dir) => {
  jsonl(dir, "traces.jsonl", [trace("fork", 10, 0)]);
  jsonl(dir, "decisions.jsonl", [{ traceId: "fork-0", intent: { key: "linked" } }]);
  jsonl(dir, "ledger.jsonl", [{ key: "linked", status: "broadcast" }, { key: "unlinked", status: "reverted" }]);
  const data = JSON.parse((await get("/api/evidence")).text);
  assert.equal(data.lanes[1].trades.length, 2); assert.equal(data.lanes[1].trades[0].time, "saved-time");
  assert.equal(data.lanes[1].totals.reverts, 1); assert.equal(data.incomplete, false);
}));

test("viewer withholds an unlinked row when its directory mixes lanes", async () => fixture(async (get, dir) => {
  jsonl(dir, "traces.jsonl", [trace("fork", 10, 0), trace("mainnet", 10, 0)]);
  jsonl(dir, "ledger.jsonl", [{ key: "unlinked", status: "included" }]);
  const data = JSON.parse((await get("/api/evidence")).text);
  for (const lane of data.lanes) assert.equal(lane.trades.length, 0);
  assert.equal(data.incomplete, true);
}));
