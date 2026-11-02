// Chat controls for sizing, risk appetite and autonomy, and the position facts chat answers from. The model only picks
// words and decimals; code turns them into numbers, and a person approves what the code says the policy does.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent.js";
import { buildFacts } from "../src/facts.js";
import { Assistant, draftToPolicy, RISK_LEVELS, type PolicyDraft } from "../src/nl.js";
import { DEFAULT_AI, DEFAULT_POLICY, type Policy } from "../src/policy.js";
import { reviewPolicy } from "../src/policy-review.js";
import type { MarketState } from "../src/reader.js";

const SPOT = 87_000n;
const USDT = 10n ** 6n;
const draft = (overrides: Partial<PolicyDraft> = {}): PolicyDraft => ({ orders: [], edgeEnabled: false, edgeSizeUsdt: null, edgeMinNetUsdt: null, slippageBps: null, ...overrides });

test("a risk appetite in words becomes our numbers, and an explicit slippage still wins", () => {
  const low = draftToPolicy(draft({ riskLevel: "low" }), DEFAULT_POLICY, SPOT);
  assert.equal(low.slippageBps, RISK_LEVELS.low.slippageBps);
  assert.equal(low.maxImpactBps, RISK_LEVELS.low.maxImpactBps);
  assert.equal(low.maxTwapDeviationBps, RISK_LEVELS.low.maxTwapDeviationBps);
  assert.equal(low.ai, undefined, "a risk level alone does not turn the model on");
  assert.equal(draftToPolicy(draft({ riskLevel: "low", slippageBps: 70 }), DEFAULT_POLICY, SPOT).slippageBps, 70, "a slippage the user named wins");
  // Found by the live model check: the model set riskLevel low and copied the current 50 bps back.
  assert.equal(draftToPolicy(draft({ riskLevel: "low", slippageBps: DEFAULT_POLICY.slippageBps }), DEFAULT_POLICY, SPOT).slippageBps, 30, "a copied value does not");
  const high = draftToPolicy(draft({ riskLevel: "high" }), low, SPOT);
  const review = reviewPolicy(high, low, SPOT);
  assert.ok(review.risks.some((r) => /pay up to 500 bps/.test(r)), "loosening the price checks needs a deliberate yes");
  assert.ok(review.risks.some((r) => /400 ticks/.test(r)));
});

test("turning the model engine on in chat uses small defaults, and the review says it trades without a person", () => {
  const on = draftToPolicy(draft({ aiEnabled: true }), DEFAULT_POLICY, SPOT);
  assert.deepEqual(on.ai, { ...DEFAULT_AI, enabled: true });
  const review = reviewPolicy(on, DEFAULT_POLICY, SPOT);
  assert.ok(review.summary.some((l) => /model engine on/.test(l)));
  assert.ok(review.risks.some((r) => /no person approving each trade/.test(r)));
  const off = draftToPolicy(draft({ aiEnabled: false }), on, SPOT);
  assert.equal(off.ai?.enabled, false);
  assert.equal(off.ai?.maxSizeUsdt, DEFAULT_AI.maxSizeUsdt, "turning it off keeps its bounds");
  assert.ok(reviewPolicy(off, on, SPOT).summary.some((l) => /model engine off/.test(l)));
  assert.equal(draftToPolicy(draft({ aiEnabled: null }), on, SPOT).ai?.enabled, true, "null keeps it");
});

test("model sizing in chat keeps the inventory at least one trade, and a risk level scales it", () => {
  const on = draftToPolicy(draft({ aiEnabled: true }), DEFAULT_POLICY, SPOT);
  const bigger = draftToPolicy(draft({ aiMaxSizeUsdt: "20" }), on, SPOT);
  assert.equal(bigger.ai?.maxSizeUsdt, 20n * USDT);
  assert.equal(bigger.ai?.maxInventoryUsdt, 20n * USDT);
  assert.ok(reviewPolicy(bigger, on, SPOT).risks.some((r) => /raises the model's largest trade from 5 to 20/.test(r)));
  assert.equal(draftToPolicy(draft({ riskLevel: "high" }), bigger, SPOT).ai?.maxInventoryUsdt, 80n * USDT);
  assert.equal(draftToPolicy(draft({ aiMaxSizeUsdt: "2", aiMaxInventoryUsdt: "3" }), on, SPOT).ai?.maxInventoryUsdt, 3n * USDT);
  assert.throws(() => draftToPolicy(draft({ aiMaxSizeUsdt: "5", aiMaxInventoryUsdt: "1" }), on, SPOT), /at least ai.maxSizeUsdt/);
  assert.throws(() => draftToPolicy(draft({ aiMaxSizeUsdt: "-5" }), on, SPOT), /not a positive decimal/);
});

test("the edge rule's closing leg is set in chat, and an edit keeps its inventory limit", () => {
  const withLimit: Policy = { ...DEFAULT_POLICY, edge: { ...DEFAULT_POLICY.edge, maxInventoryUsdt: 3n * USDT } };
  const on = draftToPolicy(draft({ edgeEnabled: true, edgeUnwind: true }), withLimit, SPOT);
  assert.equal(on.edge.unwind, true);
  assert.equal(on.edge.maxInventoryUsdt, 3n * USDT);
  assert.ok(reviewPolicy(on, withLimit, SPOT).summary.some((l) => /closes its own trades in this pool/.test(l)));
  assert.equal(draftToPolicy(draft({ edgeEnabled: true }), on, SPOT).edge.unwind, true, "absent keeps it");
  assert.equal(draftToPolicy(draft({ edgeEnabled: true, edgeUnwind: false }), on, SPOT).edge.unwind, undefined);
});

test("a draft written before these fields existed changes none of them", () => {
  const before = draftToPolicy(draft(), DEFAULT_POLICY, SPOT);
  assert.equal(before.ai, undefined);
  assert.equal(before.edge.unwind, undefined);
  assert.equal(before.maxImpactBps, undefined);
});

test("the model's reply with the new fields goes through the schema and the parser", async () => {
  const sent: unknown[] = [];
  const reply = { kind: "policy", text: "Model engine on, careful.", draft: { ...draft({ riskLevel: "low", aiEnabled: true, aiMaxSizeUsdt: "3", aiMaxInventoryUsdt: null, edgeUnwind: null }), minTradeIntervalSec: null, maxTradesPerDay: null, spendTokens: null } };
  const client = { beta: { messages: { create: async (p: unknown) => (sent.push(p), { stop_reason: "end_turn", usage: {}, content: [{ type: "text", text: JSON.stringify(reply) }] }) } } };
  const result = await new Assistant(client as never, "m").handle("let the AI trade on its own, carefully, 3 USDT a trade", {}, DEFAULT_POLICY, SPOT);
  assert.equal(result.kind, "policy");
  assert.equal(result.policy?.ai?.enabled, true);
  assert.equal(result.policy?.ai?.maxInventoryUsdt, 3n * USDT, "low risk holds one trade's worth");
  const schema = JSON.stringify(sent[0]);
  for (const field of ["riskLevel", "aiEnabled", "aiMaxSizeUsdt", "aiMaxInventoryUsdt", "edgeUnwind"]) assert.match(schema, new RegExp(field));
});

test("chat's facts carry the position, each strategy's inventory, and the model engine's spend", () => {
  const agent = new Agent({
    config: { rpcUrl: "http://127.0.0.1:9", chainId: 177, live: false, pollMs: 650, dataDir: mkdtempSync(join(tmpdir(), "holdfast-facts-")), twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 5_000, poolKind: "v3" },
    lane: "fork",
    policy: () => DEFAULT_POLICY,
    mark: () => null,
  });
  agent.lastMarket = { head: { number: 5n, hash: "0x1", timestamp: 1n, baseFeePerGas: 1n }, sqrtPriceX96: 0n, tick: 0, twapTick: 0, liquidity: 1n, spotPriceX18: SPOT, quotes: [], priorityFeePerGas: 0n, l1FeeWei: 0n } as MarketState;
  const strategist = { model: "deepseek/deepseek-v4-pro", current: () => null, usage: () => ({ calls: 3, costUsd: 0.0042 }) };
  const facts = buildFacts(agent, { ...DEFAULT_POLICY, ai: { ...DEFAULT_AI, enabled: true } }, strategist as never) as Record<string, any>;
  assert.equal(facts.position.boughtHskHeld, "0");
  assert.equal(facts.strategies.model.on, true);
  assert.equal(facts.strategies.model.callsLast24h, 3);
  assert.equal(facts.strategies.model.costUsdLast24h, "0.0042");
  assert.equal(facts.strategies.edgeRule.inventory.hsk, "0");
  agent.close();
});
