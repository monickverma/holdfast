import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Agent } from "../src/agent.js";
import { toEventSelector } from "viem";
import { HSKSWAP } from "../src/config.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { decodeFrame, type Frame } from "../src/stream.js";

function fixture(t: TestContext) {
  const agent = new Agent({
    config: { rpcUrl: "http://127.0.0.1:9", flashblocksUrl: "ws://offline", chainId: 177, live: false, pollMs: 650,
      dataDir: mkdtempSync(join(tmpdir(), "holdfast-stream-")), twapWindowSec: 300, maxStateAgeMs: 6000, maxMarkAgeMs: 5000, poolKind: "v3" },
    lane: "fork", policy: () => DEFAULT_POLICY, mark: () => null,
  });
  t.after(() => agent.close());
  const state = agent as any;
  state.warm = { market: { head: { number: 99n } } };
  return { agent, state, observe: (frame: Frame) => state.observeFrame(frame) };
}

const frame = (index: number, block = 100n, payloadId = `payload-${block}`): Frame => ({ block, index, payloadId, arrivedAt: 0, logs: [] });

test("ambiguous logs discard the agent's warm base", (t) => {
  const { state, observe } = fixture(t);
  observe({ ...frame(0), logsOrdered: false });
  assert.equal(state.warm, null);
});

for (const [kind, next] of [
  ["index-gap", frame(2)], ["repeated-index", frame(0)], ["payload-change", frame(1, 100n, "replacement")],
  ["missing-first", frame(1, 101n)], ["block-gap", frame(0, 102n)], ["out-of-order", frame(0, 99n)],
] as const) {
  test(`${kind} discards warm state and counts the break`, (t) => {
    const { state, observe } = fixture(t);
    observe(frame(0));
    observe(next);
    assert.equal(state.warm, null);
    assert.equal(state.streamBreaks[kind], 1);
  });
}

test("frames 0 through 10 across several blocks retain the warm base", (t) => {
  const { state, observe } = fixture(t);
  const warm = state.warm;
  for (let block = 100n; block < 104n; block++) for (let index = 0; index <= 10; index++) observe(frame(index, block));
  assert.equal(state.warm, warm);
  assert.equal(Object.values(state.streamBreaks ?? {}).reduce((sum: number, count) => sum + Number(count), 0), 0);
});

for (const kind of ["malformed", "reconnect"] as const) {
  test(`${kind} from the socket discards warm state`, async (t) => {
    const { agent, state } = fixture(t);
    let socket: any;
    class Socket {
      constructor() { socket = this; }
      close() {}
    }
    const original = globalThis.WebSocket;
    globalThis.WebSocket = Socket as any;
    t.after(() => { globalThis.WebSocket = original; });
    const stream = agent.openStream(() => {});
    t.after(() => stream.close());
    const opened = stream.start();
    socket.onopen();
    await opened;
    if (kind === "malformed") socket.onmessage({ data: "{" });
    else socket.onclose();
    assert.equal(state.warm, null);
    assert.equal(state.streamBreaks[kind], 1);
  });
}

test("invalid frame index fails decoding", () => {
  assert.throws(() => decodeFrame(JSON.stringify({ index: -1, metadata: { block_number: 100 } })));
});

test("a refresh awaiting reserves cannot restore state after a break", async (t) => {
  const { agent, state, observe } = fixture(t);
  state.options.config.poolKind = "constant-product";
  let release!: (values: string[]) => void;
  t.mock.method(agent.rpc, "batch", () => new Promise<string[]>((resolve) => { release = resolve; }));
  observe(frame(0));
  const refreshing = agent.refreshWarm({ head: { number: 101n } } as any);
  observe(frame(2));
  release(["0x64", "0x64"]);
  await refreshing;
  assert.equal(state.warm, null);
});

test("a broken frame takes the sealed fallback", async (t) => {
  const { agent, state, observe } = fixture(t);
  observe(frame(0));
  observe(frame(2));
  const fallback = t.mock.method(agent, "step", async () => null);
  await agent.reactTo(frame(2));
  assert.equal(state.warm, null);
  assert.equal(fallback.mock.callCount(), 1);
});

for (const event of ["Mint(address,address,int24,int24,uint128,uint256,uint256)", "Burn(address,int24,int24,uint128,uint256,uint256)"]) {
  test(`${event.split("(")[0]} on the configured pool discards liquidity and reads sealed state`, async (t) => {
    const { agent, state, observe } = fixture(t);
    const changed = { ...frame(0), logs: [{ address: HSKSWAP.pool, topics: [toEventSelector(event)], data: "0x" as const }] };
    assert.equal(observe(changed), true);
    assert.equal(state.warm, null);
    const fallback = t.mock.method(agent, "step", async () => null);
    await agent.reactTo(changed);
    assert.equal(fallback.mock.callCount(), 1);
  });
}

test("liquidity events on another pool leave warm state alone", (t) => {
  const { state, observe } = fixture(t);
  const warm = state.warm;
  observe({ ...frame(0), logs: [{ address: HSKSWAP.router, topics: [toEventSelector("Burn(address,int24,int24,uint128,uint256,uint256)")], data: "0x" }] });
  assert.equal(state.warm, warm);
});
