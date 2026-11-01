import assert from "node:assert/strict";
import { test } from "node:test";
import { Assistant, draftToPolicy, type LlmUsageRecord, type PolicyDraft } from "../src/nl.js";
import { DEFAULT_POLICY } from "../src/policy.js";

const SPOT = 100_000n; // 0.1 USDT per HSK

const draft = (overrides: Partial<PolicyDraft> = {}): PolicyDraft => ({
  orders: [],
  edgeEnabled: false,
  edgeSizeUsdt: null,
  edgeMinNetUsdt: null,
  slippageBps: null,
  ...overrides,
});

function fakeClient(reply: unknown, extra: Record<string, unknown> = {}) {
  const calls: any[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: unknown) => {
          calls.push(params);
          return {
            stop_reason: "end_turn",
            usage: { input_tokens: 1000, output_tokens: 100 },
            content: [{ type: "text", text: typeof reply === "string" ? reply : JSON.stringify(reply) }],
            ...extra,
          };
        },
      },
    },
  };
  return { client: client as never, calls };
}

test("decimal amounts become exact base units", () => {
  const policy = draftToPolicy(
    draft({ orders: [{ kind: "stop-loss", amount: "12.5", amountToken: "HSK", triggerUsdtPerHsk: "0.08" }] }),
    DEFAULT_POLICY,
    SPOT,
  );
  assert.equal(policy.orders[0]!.amountIn, 12_500_000_000_000_000_000n);
  assert.equal(policy.orders[0]!.triggerPriceX18, 80_000n);
  assert.equal(policy.version, DEFAULT_POLICY.version + 1);
});

test("a sell sized in USDT converts at spot, in integers", () => {
  const policy = draftToPolicy(draft({ orders: [{ kind: "market-sell", amount: "5", amountToken: "USDT", triggerUsdtPerHsk: null }] }), DEFAULT_POLICY, SPOT);
  assert.equal(policy.orders[0]!.amountIn, 50n * 10n ** 18n);
});

test("a policy reply is validated and not activated", async () => {
  const { client } = fakeClient({ kind: "policy", text: "Stop at 0.08.", draft: draft({ orders: [{ kind: "stop-loss", amount: "10", amountToken: "HSK", triggerUsdtPerHsk: "0.08" }] }) });
  const reply = await new Assistant(client).handle("stop at 0.08", {}, DEFAULT_POLICY, SPOT);
  assert.equal(reply.kind, "policy");
  assert.equal(reply.policy!.orders.length, 1);
});

const hostile: Array<[string, unknown]> = [
  ["a negative amount", { kind: "policy", text: "", draft: draft({ orders: [{ kind: "market-sell", amount: "-5", amountToken: "HSK", triggerUsdtPerHsk: null }] }) }],
  ["scientific notation", { kind: "policy", text: "", draft: draft({ orders: [{ kind: "market-sell", amount: "1e30", amountToken: "HSK", triggerUsdtPerHsk: null }] }) }],
  ["a stop with no trigger", { kind: "policy", text: "", draft: draft({ orders: [{ kind: "stop-loss", amount: "1", amountToken: "HSK", triggerUsdtPerHsk: null }] }) }],
  ["a market order with a trigger", { kind: "policy", text: "", draft: draft({ orders: [{ kind: "market-buy", amount: "1", amountToken: "USDT", triggerUsdtPerHsk: "0.1" }] }) }],
  ["an invented order kind", { kind: "policy", text: "", draft: draft({ orders: [{ kind: "withdraw", amount: "1", amountToken: "HSK", triggerUsdtPerHsk: null } as never] }) }],
  ["slippage over the limit", { kind: "policy", text: "", draft: draft({ slippageBps: 9000 }) }],
  ["no draft", { kind: "policy", text: "", draft: null }],
];
for (const [name, reply] of hostile) {
  test(`model output with ${name} changes nothing`, async () => {
    const { client } = fakeClient(reply);
    const result = await new Assistant(client).handle("x", {}, DEFAULT_POLICY, SPOT);
    assert.equal(result.kind, "refused");
    assert.equal(result.policy, undefined);
  });
}

test("garbage, refusal and truncation change nothing", async () => {
  for (const [reply, extra] of [["not json", {}], ["{}", { stop_reason: "refusal" }], ["{}", { stop_reason: "max_tokens" }]] as const) {
    const { client } = fakeClient(reply, extra);
    const result = await new Assistant(client).handle("x", {}, DEFAULT_POLICY, SPOT);
    assert.equal(result.kind, "refused");
  }
});

test("usage and cost are recorded for every call", async () => {
  const { client, calls } = fakeClient({ kind: "answer", text: "ok", draft: null });
  const records: LlmUsageRecord[] = [];
  await new Assistant(client, "claude-opus-5-5", (r) => records.push(r)).handle("x", { a: 1 }, DEFAULT_POLICY, SPOT);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.costUsd, (1000 * 4 + 100 * 20) / 1e6);
  assert.match(calls[0].messages[0].content, /FACTS/);
});
