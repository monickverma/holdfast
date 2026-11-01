import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POLICY, parsePolicy, PolicyError, serializePolicy } from "../src/policy.js";

const valid = () => serializePolicy(DEFAULT_POLICY) as Record<string, any>;

test("a serialized policy parses back unchanged", () => {
  const policy = { ...DEFAULT_POLICY, orders: [{ id: "s1", kind: "stop-loss" as const, amountIn: 5n, triggerPriceX18: 7n }] };
  assert.deepEqual(parsePolicy(serializePolicy(policy)), policy);
});

const rejected: Array<[string, (p: Record<string, any>) => void]> = [
  ["unknown top-level field", (p) => (p.recipient = "0xbad")],
  ["unknown order field", (p) => (p.orders = [{ id: "a", kind: "market-sell", amountIn: "1", recipient: "0xbad" }])],
  ["float amount", (p) => (p.orders = [{ id: "a", kind: "market-sell", amountIn: 1.5 }])],
  ["decimal string amount", (p) => (p.orders = [{ id: "a", kind: "market-sell", amountIn: "1.5" }])],
  ["negative amount", (p) => (p.orders = [{ id: "a", kind: "market-sell", amountIn: "-1" }])],
  ["zero amount", (p) => (p.orders = [{ id: "a", kind: "market-sell", amountIn: "0" }])],
  ["unknown kind", (p) => (p.orders = [{ id: "a", kind: "withdraw", amountIn: "1" }])],
  ["stop with no trigger", (p) => (p.orders = [{ id: "a", kind: "stop-loss", amountIn: "1" }])],
  ["market with a trigger", (p) => (p.orders = [{ id: "a", kind: "market-buy", amountIn: "1", triggerPriceX18: "1" }])],
  ["duplicate ids", (p) => (p.orders = [{ id: "a", kind: "market-buy", amountIn: "1" }, { id: "a", kind: "market-buy", amountIn: "1" }])],
  ["id with path characters", (p) => (p.orders = [{ id: "../x", kind: "market-buy", amountIn: "1" }])],
  ["slippage above the limit", (p) => (p.slippageBps = 501)],
  ["string slippage", (p) => (p.slippageBps = "50")],
  ["confirmation of zero blocks", (p) => (p.stopConfirmBlocks = 0)],
  ["edge with no boolean", (p) => (p.edge.enabled = "yes")],
  ["too many orders", (p) => (p.orders = Array.from({ length: 17 }, (_, i) => ({ id: `o${i}`, kind: "market-buy", amountIn: "1" })))],
];

for (const [name, mutate] of rejected) {
  test(`rejects ${name}`, () => {
    const policy = valid();
    mutate(policy);
    assert.throws(() => parsePolicy(policy), PolicyError);
  });
}

test("rejects things that are not policies", () => {
  for (const value of [null, [], "policy", 1]) assert.throws(() => parsePolicy(value), PolicyError);
});
