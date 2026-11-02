import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, toFunctionSelector, toHex, type Hex } from "viem";
import { createViewer, readEvidence } from "../src/cli/viewer.js";
import { HSKSWAP } from "../src/config.js";
import { DEMO_ATTACKS, runDemo } from "../src/demo.js";
import { readProof } from "../src/proof.js";
import { VAULT_ABI } from "../src/reader.js";
import { quantileReport } from "../src/stats.js";

async function fixture(work: (get: (path: string, body?: unknown) => Promise<{ status: number; text: string }>, dir: string) => Promise<void>, assistant: Parameters<typeof createViewer>[0] = {}) {
  // Outside data/, so a crashed test can never show its made-up rows as evidence.
  const dir = mkdtempSync(join(tmpdir(), "holdfast-viewer-"));
  const server = createViewer({ dataDir: dir, assistant: null, vaultAddress: "", evidenceDir: dir, ...assistant });
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
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}
const jsonl = (dir: string, name: string, rows: unknown[]) => writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n"));
const rawGet = (port: number, path: string, headers: Record<string, string> = {}, body?: string) => new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
  const req = request({ hostname: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, text, headers: res.headers }));
  });
  req.on("error", reject); req.end(body);
});
const withServer = async (options: Parameters<typeof createViewer>[0], work: (port: number) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "holdfast-viewer-"));
  const server = createViewer({ dataDir: dir, assistant: null, vaultAddress: "", evidenceDir: dir, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await work((server.address() as { port: number }).port); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
};
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
  assert.match(JSON.parse((await get("/api/evidence")).text).chat, /No model key is set/);
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

test("every response carries the security headers and the health check says nothing", async () => withServer({}, async (port) => {
  const health = await rawGet(port, "/healthz");
  assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.text), { ok: true });
  const page = await rawGet(port, "/");
  assert.match(String(page.headers["content-security-policy"]), /script-src 'self'; style-src 'self'/);
  assert.doesNotMatch(String(page.headers["content-security-policy"]), /unsafe|https?:/);
  assert.equal(page.headers["x-content-type-options"], "nosniff"); assert.equal(page.headers["x-frame-options"], "DENY"); assert.equal(page.headers["referrer-policy"], "no-referrer");
}));

test("the paid model cannot be reached from off this machine without the token", async () => {
  let calls = 0;
  const assistant = { handle: async () => { calls++; return { kind: "answer" as const, text: "Paid answer" }; } };
  const question = JSON.stringify({ message: "What happened?" });
  const asProxied = (port: number) => ({ Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" });
  await withServer({ assistant, chatToken: "" }, async (port) => {
    assert.equal((await rawGet(port, "/api/chat", asProxied(port), question)).status, 403);
    assert.equal(JSON.parse((await rawGet(port, "/api/evidence", { "X-Forwarded-For": "203.0.113.9" })).text).chatOpen, false);
    assert.equal(calls, 0);
  });
  await withServer({ assistant, chatToken: "right-token" }, async (port) => {
    assert.equal((await rawGet(port, "/api/chat", { ...asProxied(port), Authorization: "Bearer wrong-token" }, question)).status, 403);
    assert.equal((await rawGet(port, "/api/chat", asProxied(port), question)).status, 403);
    assert.equal(calls, 0);
    assert.equal((await rawGet(port, "/api/chat", { ...asProxied(port), Authorization: "Bearer right-token" }, question)).status, 200);
    assert.equal(calls, 1);
  });
});

test("chat has a per-client limit and a daily budget, and refuses before calling the model", async () => {
  let calls = 0;
  const assistant = { handle: async () => { calls++; return { kind: "answer" as const, text: "Answer" }; } };
  const headers = (port: number) => ({ Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" });
  const question = JSON.stringify({ message: "Why?" });
  await withServer({ assistant, limits: { chat: 2 } }, async (port) => {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await rawGet(port, "/api/chat", headers(port), question)).status);
    assert.deepEqual(codes, [200, 200, 429]); assert.equal(calls, 2);
  });
  calls = 0;
  await withServer({ assistant, chatDailyLimit: 1 }, async (port) => {
    const codes = [];
    for (let i = 0; i < 2; i++) codes.push((await rawGet(port, "/api/chat", headers(port), question)).status);
    assert.deepEqual(codes, [200, 429]); assert.equal(calls, 1);
  });
});

test("the API is rate limited per client, using the address the proxy saw", async () => withServer({ limits: { api: 2 } }, async (port) => {
  const hit = (forwarded: string) => rawGet(port, "/api/proof", { "X-Forwarded-For": forwarded });
  assert.equal((await hit("198.51.100.1")).status, 200);
  assert.equal((await hit("198.51.100.1")).status, 200);
  assert.equal((await hit("198.51.100.1")).status, 429);
  // A client cannot escape by adding its own entry, because the proxy's entry is last.
  assert.equal((await hit("1.2.3.4, 198.51.100.1")).status, 429);
  assert.equal((await hit("198.51.100.2")).status, 200);
}));

test("repeat requests within the cache window do not walk the disk again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "holdfast-viewer-"));
  const server = createViewer({ dataDir: dir, assistant: null, vaultAddress: "", evidenceDir: dir, cacheMs: 60_000 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(JSON.parse((await rawGet(port, "/api/evidence")).text).empty, true);
    jsonl(dir, "traces.jsonl", [trace("fork", 10, 0)]);
    assert.equal(JSON.parse((await rawGet(port, "/api/evidence")).text).empty, true);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("the proof digest passes only named fields, and an absent file is null", async () => withServer({}, async (port) => {
  const empty = JSON.parse((await rawGet(port, "/api/proof")).text);
  assert.equal(empty.gas, null); assert.equal(empty.mutation, null); assert.equal(empty.llm, null);
}));

test("the verifier's answer reaches the page as written, with each result in its own lane", () => {
  const dir = mkdtempSync(join(tmpdir(), "holdfast-proof-"));
  try {
    mkdirSync(join(dir, "v4"));
    assert.deepEqual(readProof(dir).verifier, []);
    writeFileSync(join(dir, "v4/verify-testnet.json"), JSON.stringify({ wallTime: "t", status: "INCOMPLETE", vaultVersion: "3", checked: { trades: 0, tradesMatched: 0, logEntries: 0, anchors: 0 }, findings: [{ severity: "INCOMPLETE", code: "NO_ONCHAIN_LOG", detail: "d", extra: "SECRET_SENTINEL" }], rpc: "SECRET_SENTINEL" }));
    const [row] = readProof(dir).verifier;
    assert.equal(row!.lane, "testnet");
    assert.equal(row!.status, "INCOMPLETE");
    assert.equal(row!.findings[0]!.code, "NO_ONCHAIN_LOG");
    assert.ok(!JSON.stringify(row).includes("SECRET_SENTINEL"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the proof digest drops everything it was not told to pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "holdfast-proof-"));
  try {
    mkdirSync(join(dir, "v3"));
    writeFileSync(join(dir, "v3/mutation-check.json"), JSON.stringify({ wallTime: "t", lane: "local", mutants: 3, killed: 3, survived: [], didNotCompile: [], privateKey: "SECRET_SENTINEL", results: ["SECRET_SENTINEL"] }));
    writeFileSync(join(dir, "v3/rehearsal-fork.json"), JSON.stringify({ lane: "fork", result: "ok", ownerKey: "SECRET_SENTINEL", steps: [{ name: "deploy", gasUsed: "1", detail: "SECRET_SENTINEL" }] }));
    writeFileSync(join(dir, "public-transactions.json"), JSON.stringify({ lane: "testnet", rows: [{ hash: "not a hash", label: "SECRET_SENTINEL" }, { hash: `0x${"a".repeat(64)}`, label: "ok", raw: "SECRET_SENTINEL" }] }));
    const proof = readProof(dir);
    assert.ok(!JSON.stringify(proof).includes("SECRET_SENTINEL"));
    assert.deepEqual(proof.mutation, { wallTime: "t", lane: "local", mutants: 3, killed: 3, survived: 0, didNotCompile: 0 });
    assert.equal(proof.transactions!.rows.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const context = { vault: "0x1111111111111111111111111111111111111111", agent: "0x2222222222222222222222222222222222222222", owner: "0x3333333333333333333333333333333333333333", tokenIn: "0x4444444444444444444444444444444444444444", maxTrade: 10n ** 19n, spendable: 10n ** 18n, timestamp: 1_000n } as const;
const selectorOf = (name: string) => toFunctionSelector(`${name}()`);

test("a demo reports the error the node returned, not the one it expected", async () => {
  const reply = await runDemo("agent-withdraw", context, 5n, async () => ({ error: { message: "execution reverted", data: selectorOf("IsPaused") } }));
  assert.equal(reply.refused, true); assert.equal(reply.error, "IsPaused"); assert.equal(reply.expected, "NotOwner"); assert.equal(reply.matchedExpected, false);
  const right = await runDemo("agent-withdraw", context, 5n, async () => ({ error: { message: "execution reverted", data: selectorOf("NotOwner") } }));
  assert.equal(right.matchedExpected, true); assert.equal(right.from, context.agent); assert.match(right.meaning!, /owner/i);
});

test("a demo that does not revert says so, and a dead node is not a refusal", async () => {
  const passed = await runDemo("stranger-withdraw", context, 5n, async () => ({ result: "0x" }));
  assert.equal(passed.refused, false); assert.equal(passed.error, null);
  await assert.rejects(runDemo("stranger-withdraw", context, 5n, async () => ({ error: { message: "upstream unavailable" } })));
  const silent = await runDemo("stranger-withdraw", context, 5n, async () => ({ error: { message: "execution reverted" } }));
  assert.equal(silent.refused, true); assert.equal(silent.error, null); assert.equal(silent.matchedExpected, false);
});

test("the demo sends each attack's own call, pinned to the block, and takes no input from the visitor", async () => {
  const seen: unknown[][] = [];
  await runDemo("over-cap", context, 255n, async (method, params) => { seen.push([method, params]); return { error: { message: "revert", data: selectorOf("OverTradeCap") } }; });
  const [method, params] = seen[0] as [string, [{ from: string; to: string; data: string }, string]];
  assert.equal(method, "eth_call"); assert.equal(params[1], "0xff"); assert.equal(params[0].from, context.agent); assert.equal(params[0].to, context.vault);
  const decoded = decodeFunctionData({ abi: VAULT_ABI, data: params[0].data as Hex });
  assert.equal(decoded.functionName, "execute"); assert.equal((decoded.args as readonly unknown[])[1], context.maxTrade + 1n);
});

test("an unknown attack is not found, and a demo with no vault runs nothing", async () => withServer({}, async (port) => {
  assert.equal((await rawGet(port, "/api/demo/drop-tables")).status, 404);
  const list = JSON.parse((await rawGet(port, "/api/demo")).text);
  assert.equal(list.available, false); assert.equal(list.attacks.length, Object.keys(DEMO_ATTACKS).length);
  assert.equal((await rawGet(port, "/api/demo/agent-withdraw")).status, 503);
}));

test("the wallet module's calldata matches viem, byte for byte", async () => {
  const wallet = await import(pathToFileURL(join(process.cwd(), "web/wallet.js")).href);
  const a = getAddress("0x1234567890abcdef1234567890abcdef12345678");
  const b = getAddress("0xabcdef0123456789abcdef0123456789abcdef01");
  for (const name of ["pause", "unpause", "halt", "revokeAgent", "disarmStop"] as const) assert.equal(wallet.encodeCall(name, []), encodeFunctionData({ abi: VAULT_ABI, functionName: name }));
  assert.equal(wallet.encodeCall("withdraw", [a, b, 123456789012345678901234567890n]), encodeFunctionData({ abi: VAULT_ABI, functionName: "withdraw", args: [a, b, 123456789012345678901234567890n] }));
  assert.equal(wallet.encodeCall("setAgent", [a, 1_800_000_000n]), encodeFunctionData({ abi: VAULT_ABI, functionName: "setAgent", args: [a, 1_800_000_000n] }));
  assert.throws(() => wallet.encodeCall("withdraw", ["not an address", b, 1n]));
  // The checksum is the only thing between a typo and a real withdrawal, so it is checked against viem across many addresses.
  for (let i = 1; i < 300; i++) {
    const address = getAddress(keccak256(toHex(i)).slice(0, 42));
    assert.equal(wallet.checksumOk(address), true, address);
    const body = address.slice(2);
    const at = [...body].findIndex((ch) => /[a-fA-F]/.test(ch));
    const flipped = `0x${body.slice(0, at)}${body[at] === body[at]!.toUpperCase() ? body[at]!.toLowerCase() : body[at]!.toUpperCase()}${body.slice(at + 1)}`;
    if (flipped !== flipped.toLowerCase() && flipped.slice(2) !== flipped.slice(2).toUpperCase()) assert.equal(wallet.checksumOk(flipped), false, flipped);
  }
  assert.equal(wallet.checksumOk(a.toLowerCase()), true);
  assert.throws(() => wallet.encodeCall("withdraw", [`0x${"aB".repeat(20)}`, b, 1n]), /checksum/);
  assert.throws(() => wallet.encodeCall("withdraw", [a, b, -1n]));
  assert.throws(() => wallet.encodeCall("execute", []));
  assert.equal(wallet.parseAmount("1.5", 18), 1_500_000_000_000_000_000n);
  assert.equal(wallet.parseAmount("0.000001", 6), 1n);
  assert.throws(() => wallet.parseAmount("0.0000001", 6));
  assert.throws(() => wallet.parseAmount("1e5", 18));
});

test("the wallet module knows every role's controls and offers an agent none", async () => {
  const wallet = await import(pathToFileURL(join(process.cwd(), "web/wallet.js")).href);
  const vault = { version: 3, owner: "0xAA00000000000000000000000000000000000000", guardian: "0xbb00000000000000000000000000000000000000", agent: "0xcc00000000000000000000000000000000000000" };
  assert.equal(wallet.roleOf("0xaa00000000000000000000000000000000000000", vault), "owner");
  assert.equal(wallet.roleOf("0xBB00000000000000000000000000000000000000", vault), "guardian");
  assert.equal(wallet.roleOf("0xCC00000000000000000000000000000000000000", vault), "agent");
  assert.equal(wallet.roleOf("0xdd00000000000000000000000000000000000000", vault), "none");
  assert.ok(wallet.controlsFor("owner", 3).some((c: { id: string }) => c.id === "withdraw"));
  assert.ok(!wallet.controlsFor("guardian", 3).some((c: { id: string }) => ["withdraw", "unpause", "renew"].includes(c.id)));
  assert.deepEqual(wallet.controlsFor("agent", 3).map((c: { id: string }) => c.id), ["pause"]);
  assert.deepEqual(wallet.controlsFor("none", 3), []);
  // An older vault has no halt or revoke, so the page does not offer them.
  assert.ok(!wallet.controlsFor("owner", null).some((c: { id: string }) => ["halt", "revoke", "disarm"].includes(c.id)));
});
test("the venue route serves what was read, and shares one read among visitors", async () => {
  let reads = 0;
  await withServer({ venue: async () => { reads++; return { lane: "testnet", verdict: "warn", checks: [{ name: "guardian", status: "warn", source: "authoritative", detail: "No guardian is set." }], market: { tick: 1 } }; } }, async (port) => {
    const first = await rawGet(port, "/api/venue");
    const second = await rawGet(port, "/api/venue");
    assert.equal(first.status, 200);
    assert.equal(JSON.parse(first.text).verdict, "warn");
    assert.equal(second.status, 200);
    assert.equal(reads, 1);
  });
});

test("expected against realized and refusals reach the page by named field, and nothing else does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "holdfast-quality-"));
  const WHSK = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1";
  jsonl(dir, "traces.jsonl", [{ id: "t1", lane: "fork", wallTime: "w", attrs: { decisionToBroadcastMs: 5 }, spans: [] }, { id: "t2", lane: "fork", wallTime: "w", attrs: {}, spans: [] }, { id: "t3", lane: "fork", wallTime: "w", attrs: {}, spans: [] }]);
  jsonl(dir, "ledger.jsonl", [{ key: "k", lane: "fork", intentId: "0x1", bodyHash: "0x1", orderId: "o", tokenIn: WHSK.toLowerCase() === HSKSWAP.whsk.toLowerCase() ? WHSK : HSKSWAP.whsk, amountIn: "1000", minOut: "90", deadline: "1", status: "included", amountOut: "98", txHash: `0x${"a".repeat(64)}`, rawTx: "0xSIGNEDBYTES", decisionBody: JSON.stringify({ quotedOut: "100", spotPriceX18: "100000", secretNote: "do-not-show" }) }]);
  jsonl(dir, "decisions.jsonl", [
    { traceId: "t1", wallTime: "w", intent: { key: "k" }, decision: { action: "trade" } },
    { traceId: "t2", wallTime: "w2", block: "7", decision: { action: "hold", code: "preflight-unverified", reason: "The node could not say." } },
    { traceId: "t3", wallTime: "w3", decision: { action: "hold", code: "no-order", reason: "Nothing to do." } },
  ]);
  const fork = readEvidence(dir).lanes.find((l) => l.lane === "fork")!;
  assert.equal(fork.quality.fills, 1);
  assert.equal(fork.quality.rows[0]!.slippageBps, "200");
  assert.equal(fork.quality.rows[0]!.realizedNetUsdt, null, "no outside price was recorded, so no net is shown");
  assert.deepEqual(fork.refusals, [{ time: "w2", block: "7", code: "preflight-unverified", reason: "The node could not say." }]);
  assert.deepEqual(fork.holds, { "preflight-unverified": 1, "no-order": 1 });
  const wire = JSON.stringify(fork);
  assert.ok(!wire.includes("SIGNEDBYTES") && !wire.includes("do-not-show"));
  rmSync(dir, { recursive: true, force: true });
});

test("the newest recording is shown, and an older directory is only a fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "holdfast-proof-"));
  mkdirSync(join(dir, "v3")); mkdirSync(join(dir, "v4"));
  const suite = (passed: number) => JSON.stringify({ wallTime: "t", suites: [{ name: "agent", lane: "local", command: "c", passed, failed: 0, skipped: 0 }] });
  writeFileSync(join(dir, "v3/verification.json"), suite(1));
  assert.equal(readProof(dir).verification!.suites[0]!.passed, 1);
  writeFileSync(join(dir, "v4/verification.json"), suite(2));
  assert.equal(readProof(dir).verification!.suites[0]!.passed, 2);
  rmSync(dir, { recursive: true, force: true });
});
