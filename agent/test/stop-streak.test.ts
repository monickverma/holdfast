import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { encodeAbiParameters, parseAbiParameters, type Hex } from "viem";
import { Agent } from "../src/agent.js";
import { HSKSWAP } from "../src/config.js";
import type { Decision } from "../src/decide.js";
import { DEFAULT_POLICY } from "../src/policy.js";

const AMOUNT = 10n ** 18n;
const word = (type: string, value: unknown): Hex => encodeAbiParameters([{ type } as never], [value] as never);

function fixture(t: TestContext, confirmations = 3) {
  let number = 100n;
  let hash: Hex = "0xabc";
  let sqrtPrice = 2n ** 96n;
  const agent = new Agent({
    config: {
      rpcUrl: "http://127.0.0.1:9", chainId: 177, live: false, pollMs: 650,
      dataDir: mkdtempSync(join(tmpdir(), "holdfast-stop-")), twapWindowSec: 300,
      maxStateAgeMs: 6_000, maxMarkAgeMs: 30_000, poolKind: "v3",
      vault: HSKSWAP.router, legacyVault: true,
    },
    lane: "fork",
    policy: () => ({ ...DEFAULT_POLICY, stopConfirmBlocks: confirmations, orders: [
      { id: "stop", kind: "stop-loss", amountIn: AMOUNT, triggerPriceX18: AMOUNT },
    ] }),
    mark: () => null,
    now: () => 100_000,
  });
  t.after(() => agent.close());
  agent.readMode = "pinned";
  t.mock.method(agent.rpc, "call", async (method: string) => {
    if (method === "eth_getCode") return "0x";
    assert.equal(method, "eth_getBlockByNumber");
    return { number: `0x${number.toString(16)}`, hash, timestamp: "0x64", baseFeePerGas: "0x0" };
  });
  t.mock.method(agent.rpc, "batch", async () => [
    encodeAbiParameters(
      [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }],
      [sqrtPrice, 0, 0, 1, 1, 0, true],
    ),
    word("uint128", 1n),
    encodeAbiParameters([{ type: "int56[]" }, { type: "uint160[]" }], [[0n, 0n], [0n, 0n]]),
    word("uint256", 0n),
    encodeAbiParameters([{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }], [AMOUNT, sqrtPrice, 0, 0n]),
    word("bool", false),
    ...[100n * AMOUNT, AMOUNT, 100n * AMOUNT, 1n, 100n * AMOUNT, AMOUNT, 100n * AMOUNT, 1n].map((value) => word("uint256", value)),
    "0x0",
  ]);
  return {
    agent,
    head: (next: bigint, nextHash: Hex, above = false) => {
      number = next;
      hash = nextHash;
      sqrtPrice = above ? 2n ** 97n : 2n ** 96n;
    },
    streak: () => agent.runtime.get("stop")!.hitStreak,
  };
}

test("repeated stream fallbacks count the same sealed block once", async (t) => {
  const { agent, streak } = fixture(t);
  const streaks: number[] = [];
  const actions: string[] = [];
  for (let i = 0; i < 4; i++) {
    const record = await agent.reactTo({ block: 101n, index: i, logs: [], arrivedAt: 0 });
    streaks.push(streak());
    actions.push(record!.decision.action);
  }
  assert.equal(agent.localQuoteMisses, 4);
  assert.deepEqual(streaks, [0, 0, 0, 0]);
  assert.deepEqual(actions, ["hold", "hold", "hold", "hold"]);
});

function unconfirmed(decision: Decision) {
  assert.equal(decision.action === "hold" && decision.code, "stop-unconfirmed");
}

for (const confirmations of [1, 2, 3]) {
  test(`distinct sealed blocks trigger on block ${confirmations}, with only earlier blocks in hitStreak`, async (t) => {
    const { agent, head, streak } = fixture(t, confirmations);
    for (let i = 0; i < confirmations; i++) {
      head(100n + BigInt(i), `0x${100 + i}`);
      const record = await agent.step();
      assert.equal(streak(), i);
      if (i + 1 < confirmations) unconfirmed(record!.decision);
      else assert.equal(record!.decision.action, "trade");
      const repeated = await agent.step(0, true);
      assert.equal(streak(), i);
      assert.deepEqual(repeated!.decision, record!.decision);
    }
  });
}

test("a price above the trigger resets the streak, including on a repeated hash", async (t) => {
  const { agent, head, streak } = fixture(t);
  await agent.step();
  head(101n, "0xdef");
  await agent.step();
  assert.equal(streak(), 1);
  head(101n, "0xdef", true);
  const reset = await agent.step(0, true);
  assert.equal(streak(), 0);
  assert.equal(reset!.decision.action === "hold" && reset!.decision.code, "no-signal");
  for (let i = 0; i < 3; i++) {
    head(102n + BigInt(i), `0x${102 + i}`);
    const record = await agent.step();
    assert.equal(streak(), i);
    if (i < 2) unconfirmed(record!.decision);
    else assert.equal(record!.decision.action, "trade");
  }
});

test("a different hash at the same height counts, but replaying an earlier hash does not", async (t) => {
  const { agent, head, streak } = fixture(t);
  await agent.step();
  head(100n, "0xdef");
  unconfirmed((await agent.step())!.decision);
  assert.equal(streak(), 1);
  head(100n, "0xabc");
  unconfirmed((await agent.step(0, true))!.decision);
  assert.equal(streak(), 1);
  head(101n, "0x123");
  assert.equal((await agent.step())!.decision.action, "trade");
  assert.equal(streak(), 2);
});

test("unsealed frames cannot trigger a stop even after enough sealed blocks", async (t) => {
  const { agent, head, streak } = fixture(t, 2);
  await agent.step();
  await agent.refreshWarm(agent.lastMarket!);
  const frame = {
    block: 102n, index: 1, arrivedAt: 0,
    logs: [{
      address: HSKSWAP.pool,
      topics: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67" as Hex],
      data: encodeAbiParameters(parseAbiParameters("int256, int256, uint160, uint128, int24"),
        [1n, -1n, (2n ** 96n * 9985n) / 10000n, 10n ** 24n, -30]),
    }],
  };
  for (let i = 0; i < 3; i++) {
    unconfirmed((await agent.reactTo(frame))!.decision);
    assert.equal(streak(), 0);
  }
  head(101n, "0xdef");
  assert.equal((await agent.step())!.decision.action, "trade");
  await agent.refreshWarm(agent.lastMarket!);
  unconfirmed((await agent.reactTo(frame))!.decision);
  assert.equal(streak(), 1);
  assert.equal(agent.localQuoteMisses, 0);
  assert.equal(agent.rpc.stats.httpRequests, 0);
});
