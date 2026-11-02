import assert from "node:assert/strict";
import { test } from "node:test";
import { tradeTimes } from "../src/agent.js";
import { HSKSWAP } from "../src/config.js";
import { decide, plannedQuotes, type DecideInput, type Mark, type OrderRuntime } from "../src/decide.js";
import type { Intent } from "../src/ledger.js";
import { Assistant, assistantFromEnv, draftToPolicy, OPENROUTER_DEFAULT_MODEL, OPENROUTER_URL, openRouterClient, type PolicyDraft } from "../src/nl.js";
import { DEFAULT_POLICY, parsePolicy, serializePolicy, type Order, type Policy } from "../src/policy.js";
import { reviewPolicy } from "../src/policy-review.js";
import type { MarketState, TokenLimits } from "../src/reader.js";

const NOW = 1_800_000_000_000;
const NOW_SEC = NOW / 1000;
const PRICE = 87_400n;
const HSK = 10n ** 18n;
const USDT = 10n ** 6n;

const whskLimits: TokenLimits = { balance: 1_000n * HSK, maxTrade: 200n * HSK, remaining: 500n * HSK, floorPriceX18: 50_000n, hourlyBudget: 500n * HSK, available: 500n * HSK };
const usdtLimits: TokenLimits = { balance: 50n * USDT, maxTrade: 10n * USDT, remaining: 25n * USDT, floorPriceX18: 5n * HSK, hourlyBudget: 25n * USDT, available: 25n * USDT };
const sell = (amountIn: bigint, amountOut: bigint) => ({ tokenIn: HSKSWAP.whsk as `0x${string}`, amountIn, amountOut, ticksCrossed: 0 });
const buy = (amountIn: bigint, amountOut: bigint) => ({ tokenIn: HSKSWAP.usdt as `0x${string}`, amountIn, amountOut, ticksCrossed: 0 });

function market(overrides: Partial<MarketState> = {}): MarketState {
  return {
    head: { number: 100n, hash: "0xabc", timestamp: BigInt(NOW_SEC), baseFeePerGas: 500_000_000_000n },
    sqrtPriceX96: 0n, tick: -300694, twapTick: -300694, liquidity: 1n, spotPriceX18: PRICE, quotes: [],
    priorityFeePerGas: 1_000_000n, l1FeeWei: 3_919_085_385_435n,
    vault: { paused: false, agentExpiry: null, whsk: whskLimits, usdt: usdtLimits },
    ...overrides,
  };
}

const input = (policy: Partial<Policy>, m: MarketState, extra: Partial<DecideInput> = {}): DecideInput =>
  ({ market: m, policy: { ...DEFAULT_POLICY, ...policy }, mark: null, runtime: new Map(), nowMs: NOW, maxStateAgeMs: 6_000, maxMarkAgeMs: 30_000, ...extra });

const marketSell: Order = { id: "m1", kind: "market-sell", amountIn: 10n * HSK };
const stop: Order = { id: "s1", kind: "stop-loss", amountIn: 100n * HSK, triggerPriceX18: 80_000n };
const nowMarket = market({ quotes: [sell(10n * HSK, 871_000n)] });

test("pacing holds a trade until the gap has passed, in chain time", () => {
  const policy = { orders: [marketSell], minTradeIntervalSec: 3600 };
  const early = decide(input(policy, nowMarket, { tradeTimes: [NOW_SEC - 3599] }));
  assert.equal(early.action === "hold" && early.code, "too-soon");
  const later = decide(input(policy, nowMarket, { tradeTimes: [NOW_SEC - 3600] }));
  assert.equal(later.action, "trade");
  assert.equal(decide(input(policy, nowMarket)).action, "trade", "a first trade has nothing to wait for");
});

test("the daily count holds once used, and frees up as trades leave the 24 hours", () => {
  const policy = { orders: [marketSell], maxTradesPerDay: 2 };
  const full = decide(input(policy, nowMarket, { tradeTimes: [NOW_SEC - 100, NOW_SEC - 50_000] }));
  assert.equal(full.action === "hold" && full.code, "trade-count");
  const freed = decide(input(policy, nowMarket, { tradeTimes: [NOW_SEC - 100, NOW_SEC - 86_400] }));
  assert.equal(freed.action, "trade");
});

test("pacing never holds back a stop-loss", () => {
  const m = market({ spotPriceX18: 79_000n, quotes: [sell(100n * HSK, 7_800_000n)] });
  const runtime = new Map<string, OrderRuntime>([["s1", { filled: 0n, hitStreak: 1 }]]);
  const d = decide(input({ orders: [stop], minTradeIntervalSec: 86_400, maxTradesPerDay: 1 }, m, { runtime, tradeTimes: [NOW_SEC - 10] }));
  assert.equal(d.action === "trade" && d.trigger, "stop-loss");
});

test("a paced order does not hide a stop listed after it", () => {
  const m = market({ spotPriceX18: 79_000n, quotes: [sell(10n * HSK, 787_000n), sell(100n * HSK, 7_800_000n)] });
  const runtime = new Map<string, OrderRuntime>([["s1", { filled: 0n, hitStreak: 1 }]]);
  const d = decide(input({ orders: [marketSell, stop], maxTradesPerDay: 1, maxImpactBps: 5_000 }, m, { runtime, tradeTimes: [NOW_SEC - 10] }));
  assert.equal(d.action === "trade" && d.orderId, "s1");
});

test("the edge rule spends only the tokens the policy allows", () => {
  const mark: Mark = { askX18: 87_500n, bidX18: 87_300n, fetchedAtMs: NOW };
  const edgeSell = (10n * USDT * HSK) / PRICE;
  // The sell side pays 2% over the reference. With HSK not spendable, that side is never taken.
  const m = market({ quotes: [sell(edgeSell, 10_200_000n), buy(10n * USDT, (9_700_000n * HSK) / PRICE)] });
  const edge = { edge: { enabled: true, sizeUsdt: 10n * USDT, minNetUsdt: 0n } };
  assert.equal(decide(input(edge, m, { mark })).action, "trade");
  const usdtOnly = decide(input({ ...edge, spendTokens: ["USDT"] }, m, { mark }));
  assert.equal(usdtOnly.action === "hold" && usdtOnly.code, "uneconomic");
  const quoted = plannedQuotes({ ...DEFAULT_POLICY, ...edge, spendTokens: ["USDT"] }, m, new Map());
  assert.deepEqual(quoted.map((q) => q.tokenIn), [HSKSWAP.usdt]);
});

test("a policy cannot hold an order that spends a token it does not allow", () => {
  const base = serializePolicy({ ...DEFAULT_POLICY, orders: [stop] }) as Record<string, unknown>;
  assert.throws(() => parsePolicy({ ...base, spendTokens: ["USDT"] }), /spends HSK, which spendTokens does not allow/);
  assert.deepEqual(parsePolicy({ ...base, spendTokens: ["HSK"] }).spendTokens, ["HSK"]);
  for (const bad of [[], ["ETH"], ["HSK", "HSK"], "HSK"]) assert.throws(() => parsePolicy({ ...base, spendTokens: bad }), /spendTokens/);
  assert.throws(() => parsePolicy({ ...base, minTradeIntervalSec: 0 }), /minTradeIntervalSec/);
  assert.throws(() => parsePolicy({ ...base, maxTradesPerDay: 1.5 }), /maxTradesPerDay/);
});

const draft = (overrides: Partial<PolicyDraft> = {}): PolicyDraft => ({ orders: [], edgeEnabled: false, edgeSizeUsdt: null, edgeMinNetUsdt: null, slippageBps: null, ...overrides });

test("chat sets, keeps and removes pacing and the token choice", () => {
  const set = draftToPolicy(draft({ minTradeIntervalSec: 3600, maxTradesPerDay: 4, spendTokens: ["HSK"] }), DEFAULT_POLICY, PRICE);
  assert.equal(set.minTradeIntervalSec, 3600); assert.equal(set.maxTradesPerDay, 4); assert.deepEqual(set.spendTokens, ["HSK"]);
  const kept = draftToPolicy(draft({ minTradeIntervalSec: null, maxTradesPerDay: null, spendTokens: null }), set, PRICE);
  assert.equal(kept.minTradeIntervalSec, 3600); assert.equal(kept.maxTradesPerDay, 4); assert.deepEqual(kept.spendTokens, ["HSK"]);
  const removed = draftToPolicy(draft({ minTradeIntervalSec: 0, maxTradesPerDay: 0, spendTokens: ["USDT", "HSK"] }), set, PRICE);
  assert.equal(removed.minTradeIntervalSec, undefined); assert.equal(removed.maxTradesPerDay, undefined); assert.equal(removed.spendTokens, undefined);
  assert.throws(() => draftToPolicy(draft({ spendTokens: ["USDT"], orders: [{ kind: "stop-loss", amount: "1", amountToken: "HSK", triggerUsdtPerHsk: "0.08" }] }), DEFAULT_POLICY, PRICE), /spendTokens/);
});

test("the review a person approves states the pacing and flags loosening it", () => {
  const strict = { ...DEFAULT_POLICY, minTradeIntervalSec: 3600, maxTradesPerDay: 2, spendTokens: ["HSK" as const] };
  const { summary } = reviewPolicy(strict, DEFAULT_POLICY, PRICE);
  assert.ok(summary.includes("spends HSK only; the vault trades no other token"));
  assert.ok(summary.some((s) => s.startsWith("pacing: at least 1 h between trades, at most 2 trades in any 24 hours")));
  const { risks } = reviewPolicy(DEFAULT_POLICY, strict, PRICE);
  assert.ok(risks.some((r) => r.includes("shortens the gap between trades from 1 h to none")));
  assert.ok(risks.some((r) => r.includes("raises the daily trade count from 2 to no limit")));
});

test("only trades that were sent count toward pacing", () => {
  const intent = (status: Intent["status"], blockTime: number) => ({ status, decisionBody: JSON.stringify({ blockTime: String(blockTime) }) }) as Intent;
  const times = tradeTimes([intent("included", 1), intent("reverted", 2), intent("broadcast", 3), intent("signed", 4), intent("cancelled", 5), intent("expired", 6), intent("reserved", 7)]);
  assert.deepEqual(times, [1, 2, 3, 4]);
});

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("OpenRouter gets the schema as a strict format, and its reply goes through the same parser", async () => {
  const reply = { kind: "policy", text: "Paced.", draft: { ...draft({ maxTradesPerDay: 2 }), minTradeIntervalSec: null, spendTokens: null } };
  const { fetcher, calls } = fakeFetch(200, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 900, completion_tokens: 80, cost: 0.0052 } });
  const usage: number[] = [];
  const result = await new Assistant(openRouterClient("sk-or-test", fetcher), OPENROUTER_DEFAULT_MODEL, (r) => usage.push(r.costUsd)).handle("twice a day", {}, DEFAULT_POLICY, PRICE);
  assert.equal(result.kind, "policy");
  assert.equal(result.policy!.maxTradesPerDay, 2);
  assert.deepEqual(usage, [0.0052], "the billed cost is recorded");
  assert.equal(calls[0]!.url, OPENROUTER_URL);
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer sk-or-test");
  const sent = JSON.parse(String(calls[0]!.init.body));
  assert.equal(sent.model, OPENROUTER_DEFAULT_MODEL);
  assert.equal(sent.messages[0].role, "system");
  assert.match(sent.messages[1].content, /MESSAGE\ntwice a day/);
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.deepEqual(sent.response_format.json_schema.schema.required, ["kind", "text", "draft"]);
  assert.equal(sent.provider.require_parameters, true);
});

test("an OpenRouter cut-off or refusal changes no policy, and an error is raised", async () => {
  const cut = fakeFetch(200, { choices: [{ finish_reason: "length", message: { content: "{\"kind\":" } }] });
  assert.equal((await new Assistant(openRouterClient("k", cut.fetcher)).handle("x", {}, DEFAULT_POLICY, PRICE)).kind, "refused");
  const refused = fakeFetch(200, { choices: [{ finish_reason: "stop", message: { content: null, refusal: "no" } }] });
  assert.equal((await new Assistant(openRouterClient("k", refused.fetcher)).handle("x", {}, DEFAULT_POLICY, PRICE)).kind, "refused");
  const failed = fakeFetch(401, { error: { message: "No auth credentials found" } });
  await assert.rejects(new Assistant(openRouterClient("k", failed.fetcher)).handle("x", {}, DEFAULT_POLICY, PRICE), /OpenRouter answered 401: No auth credentials found/);
});

test("a reply cut off once is asked again with a larger budget, and cut off twice is refused", async () => {
  const answer = { kind: "answer", text: "Zero.", draft: null };
  const replies = [{ stop_reason: "max_tokens", text: "{\"kind\":" }, { stop_reason: "end_turn", text: JSON.stringify(answer) }];
  const budgets: number[] = [];
  const usage: Array<{ retried?: boolean; outputTokens: number }> = [];
  const client = (queue: typeof replies) => ({ beta: { messages: { create: async (params: { max_tokens: number }) => {
    budgets.push(params.max_tokens);
    const next = queue.shift()!;
    return { stop_reason: next.stop_reason, usage: { input_tokens: 500, output_tokens: 300 }, content: [{ type: "text", text: next.text }] };
  } } } }) as never;

  const saved = await new Assistant(client([...replies]), "m", (r) => usage.push(r)).handle("trades?", {}, DEFAULT_POLICY, PRICE);
  assert.equal(saved.kind, "answer");
  assert.deepEqual(budgets, [4_000, 16_000]);
  assert.equal(usage[0]!.retried, true);
  assert.equal(usage[0]!.outputTokens, 600, "both calls are counted");

  budgets.length = 0;
  const twice = await new Assistant(client([replies[0]!, replies[0]!, replies[1]!])).handle("trades?", {}, DEFAULT_POLICY, PRICE);
  assert.equal(twice.kind, "refused");
  assert.match(twice.text, /cut off twice/);
  assert.deepEqual(budgets, [4_000, 16_000], "never a third call");
});

test("the OpenRouter key is preferred when both are set, and no key means no assistant", () => {
  assert.equal(assistantFromEnv({}), null);
  assert.ok(assistantFromEnv({ OPENROUTER_API_KEY: "k", ANTHROPIC_API_KEY: "a" }) instanceof Assistant);
  assert.ok(assistantFromEnv({ ANTHROPIC_API_KEY: "a" }) instanceof Assistant);
});
