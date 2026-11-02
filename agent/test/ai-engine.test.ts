// The model as the trading engine, and the edge rule's closing leg in the same pool. Every proposal goes through the
// same gates as the rules, a model that fails leaves nothing to act on, and a stop-loss never waits for it.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Hex } from "viem";
import { Agent } from "../src/agent.js";
import { BREAKER_DEFAULTS, breakerVerdict } from "../src/breaker.js";
import { HSKSWAP } from "../src/config.js";
import { decide, plannedQuotes, roundTrip, roundTripMinOut, networkCostUsdt, type DecideInput, type Inventory, type Mark, type ModelProposal, type TradeDecision } from "../src/decide.js";
import type { Intent } from "../src/ledger.js";
import { DEFAULT_AI, DEFAULT_POLICY, parsePolicy, PolicyError, serializePolicy, type Policy } from "../src/policy.js";
import type { MarketState, TokenLimits, VaultState } from "../src/reader.js";
import { buildSnapshot, parseProposal, ProposalError, signalFingerprint, Strategist, SYSTEM, type ProposalSource } from "../src/strategist.js";
import { Trace } from "../src/trace.js";

const NOW = 1_800_000_000_000;
const PRICE = 87_400n;
const HSK = 10n ** 18n;
const USDT = 10n ** 6n;
const whsk: TokenLimits = { balance: 1_000n * HSK, maxTrade: 200n * HSK, remaining: 500n * HSK, floorPriceX18: 50_000n, hourlyBudget: 300n * HSK, available: 300n * HSK };
const usdt: TokenLimits = { balance: 50n * USDT, maxTrade: 20n * USDT, remaining: 25n * USDT, floorPriceX18: 5n * HSK, hourlyBudget: 25n * USDT, available: 25n * USDT };
const vault: VaultState = { paused: false, agentExpiry: null, whsk, usdt };

function market(overrides: Partial<MarketState> = {}): MarketState {
  return {
    head: { number: 100n, hash: "0xabc", timestamp: BigInt(NOW / 1000), baseFeePerGas: 500_000_000_000n },
    sqrtPriceX96: 0n,
    tick: -300694,
    twapTick: -300694,
    liquidity: 1n,
    spotPriceX18: PRICE,
    quotes: [],
    priorityFeePerGas: 1_000_000n,
    l1FeeWei: 3_919_085_385_435n,
    vault,
    ...overrides,
  };
}
const sellQuote = (amountIn: bigint, amountOut: bigint) => ({ tokenIn: HSKSWAP.whsk as `0x${string}`, amountIn, amountOut, ticksCrossed: 0 });
const buyQuote = (amountIn: bigint, amountOut: bigint) => ({ tokenIn: HSKSWAP.usdt as `0x${string}`, amountIn, amountOut, ticksCrossed: 0 });
const mark = (ask = 87_500n, bid = 87_300n, ageMs = 0): Mark => ({ askX18: ask, bidX18: bid, fetchedAtMs: NOW - ageMs });
const aiPolicy: Policy = { ...DEFAULT_POLICY, ai: { ...DEFAULT_AI, enabled: true, maxSizeUsdt: 5n * USDT, maxInventoryUsdt: 10n * USDT } };
const input = (policy: Policy, m: MarketState, extra: Partial<DecideInput> = {}): DecideInput => ({
  market: m,
  policy,
  mark: null,
  runtime: new Map(),
  nowMs: NOW,
  maxStateAgeMs: 6_000,
  maxMarkAgeMs: 5_000,
  ...extra,
});
const code = (d: ReturnType<typeof decide>) => (d.action === "hold" ? d.code : d.action);
const proposal = (action: ModelProposal["action"], amountIn: bigint, block = 100n): ModelProposal => ({ id: `m-${block}-0`, block, action, amountIn, reason: "test" });

// The pool sells HSK at 0.0862 while the outside bid is 0.0873: a buy beats the outside price after fees and gas.
const cheapPool = market({ quotes: [buyQuote(5n * USDT, 58n * HSK)] });
const buy5 = proposal("buy", 5n * USDT);

// decide(): the model proposes, the gates decide

test("with the ai rule off, a proposal is ignored and not even quoted", () => {
  const d = decide(input(DEFAULT_POLICY, cheapPool, { mark: mark(), proposal: buy5 }));
  assert.equal(code(d), "no-signal");
  assert.equal(plannedQuotes(DEFAULT_POLICY, cheapPool, new Map(), { proposal: buy5 }).length, 0);
});

test("a proposal that beats the outside price after fees and gas trades, carrying its id, at a floor that keeps the edge", () => {
  const d = decide(input(aiPolicy, cheapPool, { mark: mark(), proposal: buy5 }));
  assert.equal(d.action, "trade");
  const t = d as TradeDecision;
  assert.equal(t.trigger, "model");
  assert.equal(t.proposalId, buy5.id);
  assert.equal(t.amountIn, 5n * USDT);
  assert.ok(t.ledger.net! > 0n);
  // At the worst fill the transaction accepts, the trade still does not lose against the outside bid.
  assert.ok((t.minOut * 87_300n) / HSK >= 5n * USDT + t.ledger.networkCost);
  assert.match(t.reason, /Model: test/);
});

test("the model's hold is reported as its own reason, and no trade follows", () => {
  const d = decide(input(aiPolicy, cheapPool, { mark: mark(), proposal: { ...buy5, action: "hold", amountIn: 0n, reason: "gap is closing" } }));
  assert.equal(code(d), "model-hold");
  assert.match((d as { reason: string }).reason, /gap is closing/);
});

test("no proposal, an expired one, or one from a later block all hold", () => {
  assert.equal(code(decide(input(aiPolicy, cheapPool, { mark: mark() }))), "no-signal");
  assert.equal(code(decide(input(aiPolicy, cheapPool, { mark: mark(), proposal: proposal("buy", 5n * USDT, 69n) }))), "proposal-stale");
  assert.equal(decide(input(aiPolicy, cheapPool, { mark: mark(), proposal: proposal("buy", 5n * USDT, 70n) })).action, "trade", "30 blocks is still live");
  assert.equal(code(decide(input(aiPolicy, cheapPool, { mark: mark(), proposal: proposal("buy", 5n * USDT, 101n) }))), "proposal-stale");
});

test("a proposal that does not beat the outside price is refused, whatever the model said", () => {
  const fairPool = market({ quotes: [buyQuote(5n * USDT, 57n * HSK)] });
  assert.equal(code(decide(input(aiPolicy, fairPool, { mark: mark(), proposal: buy5 }))), "uneconomic");
});

test("a proposal that adds inventory needs a fresh, sane outside price that agrees with the pool", () => {
  assert.equal(code(decide(input(aiPolicy, cheapPool, { proposal: buy5 }))), "stale-mark");
  assert.equal(code(decide(input(aiPolicy, cheapPool, { mark: mark(87_500n, 87_300n, 6_000), proposal: buy5 }))), "stale-mark");
  assert.equal(code(decide(input(aiPolicy, cheapPool, { mark: mark(87_300n, 87_500n), proposal: buy5 }))), "bad-mark");
  assert.equal(code(decide(input(aiPolicy, cheapPool, { mark: mark(90_100n, 90_000n), proposal: buy5 }))), "mark-disagrees");
});

test("the model cannot spend more than its size, a token the policy forbids, or past its inventory", () => {
  const big = market({ quotes: [buyQuote(6n * USDT, 70n * HSK)] });
  assert.equal(code(decide(input(aiPolicy, big, { mark: mark(), proposal: proposal("buy", 6n * USDT) }))), "proposal-refused");
  const hskOnly = { ...aiPolicy, spendTokens: ["HSK" as const] };
  assert.equal(code(decide(input(hskOnly, cheapPool, { mark: mark(), proposal: buy5 }))), "proposal-refused");
  const long: Inventory = { hsk: 100n * HSK, usdt: -8n * USDT };
  assert.equal(code(decide(input(aiPolicy, cheapPool, { mark: mark(), proposal: buy5, aiInventory: long }))), "inventory-limit");
});

test("the vault's own limits still apply to a proposal that passed everything else", () => {
  const poor = market({ quotes: cheapPool.quotes, vault: { ...vault, usdt: { ...usdt, balance: 4n * USDT } } });
  assert.equal(code(decide(input(aiPolicy, poor, { mark: mark(), proposal: buy5 }))), "no-balance");
  const spent = market({ quotes: cheapPool.quotes, vault: { ...vault, usdt: { ...usdt, available: 1n * USDT } } });
  assert.equal(code(decide(input(aiPolicy, spent, { mark: mark(), proposal: buy5 }))), "over-budget");
  const deviated = market({ quotes: cheapPool.quotes, tick: -300694 + 500 });
  assert.equal(code(decide(input(aiPolicy, deviated, { mark: mark(), proposal: buy5 }))), "price-deviation");
});

test("closing the model's inventory is judged on the round trip in this pool, and needs no outside price", () => {
  const long: Inventory = { hsk: 58n * HSK, usdt: -5n * USDT };
  const sell58 = proposal("sell", 58n * HSK);
  const profit = market({ quotes: [sellQuote(58n * HSK, 5_200_000n)] });
  const closed = decide(input(aiPolicy, profit, { proposal: sell58, aiInventory: long }));
  assert.equal(code(closed), "trade");
  assert.match((closed as TradeDecision).reason, /closes inventory/);
  const loss = market({ quotes: [sellQuote(58n * HSK, 5_000_000n)] });
  assert.equal(code(decide(input(aiPolicy, loss, { proposal: sell58, aiInventory: long }))), "uneconomic");
  const tolerant = { ...aiPolicy, ai: { ...aiPolicy.ai!, maxUnwindLossUsdt: 200_000n } };
  const accepted = decide(input(tolerant, loss, { proposal: sell58, aiInventory: long }));
  assert.equal(code(accepted), "trade", "a loss the owner allowed for closes");
  const cost = networkCostUsdt(loss);
  assert.ok(roundTrip(long, HSKSWAP.whsk, 58n * HSK, (accepted as TradeDecision).minOut, cost)! >= -200_000n, "and the worst accepted fill stays inside it");
});

test("selling more than the model holds counts as opening a short, so it needs the outside price", () => {
  const long: Inventory = { hsk: 10n * HSK, usdt: -1n * USDT };
  const profit = market({ quotes: [sellQuote(58n * HSK, 5_200_000n)] });
  assert.equal(code(decide(input(aiPolicy, profit, { proposal: proposal("sell", 58n * HSK), aiInventory: long }))), "stale-mark");
});

test("a stop-loss outranks a model proposal and fires with the model saying buy", () => {
  const policy: Policy = { ...aiPolicy, stopConfirmBlocks: 1, orders: [{ id: "s", kind: "stop-loss", amountIn: 100n * HSK, triggerPriceX18: 80_000n }] };
  const crashed = market({ spotPriceX18: 70_000n, quotes: [sellQuote(100n * HSK, 7_000_000n), ...cheapPool.quotes] });
  const d = decide(input(policy, crashed, { proposal: buy5 }));
  assert.equal(d.action === "trade" && d.trigger, "stop-loss");
});

test("the policy's pacing holds a model trade, as it holds every trade but a stop", () => {
  const paced = { ...aiPolicy, minTradeIntervalSec: 600 };
  const d = decide(input(paced, cheapPool, { mark: mark(), proposal: buy5, tradeTimes: [NOW / 1000 - 60] }));
  assert.equal(code(d), "too-soon");
});

test("while the model is on, every read quotes both sides at its size, its closing trade and its proposal", () => {
  const long: Inventory = { hsk: 58n * HSK, usdt: -5n * USDT };
  const requests = plannedQuotes(aiPolicy, cheapPool, new Map(), { aiInventory: long, proposal: proposal("buy", 3n * USDT) });
  assert.deepEqual(requests.map((r) => [r.tokenIn === HSKSWAP.usdt ? "buy" : "sell", r.amountIn]), [
    ["buy", 5n * USDT],
    ["sell", (5n * USDT * HSK) / PRICE],
    ["sell", 58n * HSK],
    ["buy", 3n * USDT],
  ]);
});

test("the round-trip floor is exact: one unit under it realizes less than required", () => {
  const long: Inventory = { hsk: 58n * HSK, usdt: -5_000_001n };
  const min = roundTripMinOut(long, true, 29n * HSK, 8_000n, 10n);
  assert.ok(roundTrip(long, HSKSWAP.whsk, 29n * HSK, min, 8_000n)! >= 10n);
  assert.ok(roundTrip(long, HSKSWAP.whsk, 29n * HSK, min - 1n, 8_000n)! < 10n);
  const short: Inventory = { hsk: -171n * HSK, usdt: 15_000_007n };
  const minBack = roundTripMinOut(short, false, 14_000_000n, 8_000n, 10n);
  assert.ok(roundTrip(short, HSKSWAP.usdt, 14_000_000n, minBack, 8_000n)! >= 10n);
  assert.ok(roundTrip(short, HSKSWAP.usdt, 14_000_000n, minBack - 1n, 8_000n)! < 10n);
});

// The edge rule's closing leg

const unwindPolicy: Policy = { ...DEFAULT_POLICY, edge: { enabled: true, sizeUsdt: 15n * USDT, minNetUsdt: 0n, unwind: true } };

test("with unwind on, the edge rule sells what it bought once the round trip pays, with no outside price", () => {
  const long: Inventory = { hsk: 171n * HSK, usdt: -15n * USDT };
  const m = market({ quotes: [sellQuote(171n * HSK, 15_200_000n)] });
  const d = decide(input(unwindPolicy, m, { edgeInventory: long, edgeInventoryHsk: long.hsk }));
  assert.equal(d.action === "trade" && d.trigger, "unwind");
  assert.ok(roundTrip(long, HSKSWAP.whsk, 171n * HSK, (d as TradeDecision).minOut, networkCostUsdt(m))! > 0n);
});

test("with unwind on, a short is bought back with a little less than spot implies, so it cannot flip long", () => {
  const short: Inventory = { hsk: -171n * HSK, usdt: 15n * USDT };
  const spend = (171n * HSK * PRICE * 9_900n) / HSK / 10_000n;
  assert.equal(plannedQuotes(unwindPolicy, market(), new Map(), { edgeInventory: short }).at(-1)!.amountIn, spend);
  const d = decide(input(unwindPolicy, market({ quotes: [buyQuote(spend, 170n * HSK)] }), { edgeInventory: short }));
  assert.equal(d.action === "trade" && d.trigger, "unwind");
  const over = decide(input(unwindPolicy, market({ quotes: [buyQuote(spend, 172n * HSK)] }), { edgeInventory: short }));
  assert.notEqual(over.action === "trade" && over.trigger, "unwind");
});

test("a closing trade that would lose waits, and the inventory limit says it is waiting to close", () => {
  const long: Inventory = { hsk: 171n * HSK, usdt: -15n * USDT };
  const m = market({ quotes: [sellQuote(171n * HSK, 14_800_000n), buyQuote(15n * USDT, 172n * HSK)] });
  const d = decide(input(unwindPolicy, m, { mark: mark(), edgeInventory: long }));
  assert.equal(code(d), "inventory-limit");
  assert.match((d as { reason: string }).reason, /waits to close in this pool/);
  const off = decide(input({ ...unwindPolicy, edge: { ...unwindPolicy.edge, unwind: undefined } }, m, { mark: mark(), edgeInventory: long }));
  assert.match((off as { reason: string }).reason, /Nothing closes an edge trade/);
});

test("the closing leg obeys the policy's choice of token", () => {
  const long: Inventory = { hsk: 171n * HSK, usdt: -15n * USDT };
  const usdtOnly = { ...unwindPolicy, spendTokens: ["USDT" as const] };
  const d = decide(input(usdtOnly, market({ quotes: [sellQuote(171n * HSK, 15_200_000n)] }), { edgeInventory: long }));
  assert.notEqual(d.action, "trade");
});

// Policy

test("an ai rule survives parsing, rejects anything unknown, and must leave room for one trade", () => {
  const parsed = parsePolicy(serializePolicy(aiPolicy));
  assert.deepEqual(parsed.ai, aiPolicy.ai);
  assert.equal(parsePolicy(serializePolicy(unwindPolicy)).edge.unwind, true);
  assert.equal(parsePolicy(serializePolicy(DEFAULT_POLICY)).ai, undefined, "old policies still parse");
  const raw = serializePolicy(aiPolicy) as { ai: Record<string, unknown> };
  assert.throws(() => parsePolicy({ ...raw, ai: { ...raw.ai, withdraw: true } }), PolicyError);
  assert.throws(() => parsePolicy({ ...raw, ai: { ...raw.ai, maxInventoryUsdt: "1" } }), /at least ai.maxSizeUsdt/);
  assert.throws(() => parsePolicy({ ...raw, ai: { ...raw.ai, maxSizeUsdt: "-1" } }), PolicyError);
  assert.throws(() => parsePolicy({ ...raw, ai: { ...raw.ai, maxCallsPerDay: 1e9 } }), PolicyError);
});

// The breaker

const settled = (key: string, extra: Partial<Intent> = {}): Intent =>
  ({ key, intentId: "0x00", bodyHash: "0x00", status: "included", orderId: null, tokenIn: HSKSWAP.usdt, amountIn: 5n * USDT, amountOut: (5n * USDT * HSK) / PRICE, minOut: 1n, deadline: 1n, blockNumber: 100n, broadcastBlock: 100n, ...extra }) as Intent;

test("model trades have their own hourly count and loss limit, apart from the edge rule's", () => {
  const six = Array.from({ length: 6 }, (_, i) => settled(`ai:${i}`));
  const verdict = (trigger: TradeDecision["trigger"], intents: Intent[]) => breakerVerdict({ action: "trade", trigger } as TradeDecision, intents, 200n, PRICE, BREAKER_DEFAULTS);
  assert.match(verdict("model", six) ?? "", /model trades in the last hour/);
  assert.equal(verdict("edge", six), null);
  const losing = [settled("ai:0", { amountIn: 20n * USDT, amountOut: 10n * HSK })];
  assert.match(verdict("model", losing) ?? "", /model trades are down/);
  assert.equal(verdict("unwind", losing), null, "closing is not latched by losses");
});

// The strategist: parsing, failure, cadence and budget

const ai = aiPolicy.ai!;

test("only a well-formed proposal inside the size limit parses, and code does the unit conversion", () => {
  const p = parseProposal(JSON.stringify({ action: "sell", sizeUsdt: "4.37", reason: "pool rich" }), 9n, PRICE, ai, "x");
  assert.equal(p.amountIn, (4_370_000n * HSK) / PRICE);
  assert.equal(parseProposal(JSON.stringify({ action: "buy", sizeUsdt: "5", reason: "r" }), 9n, PRICE, ai, "x").amountIn, 5n * USDT);
  assert.equal(parseProposal(JSON.stringify({ action: "hold", sizeUsdt: null, reason: "r" }), 9n, PRICE, ai, "x").amountIn, 0n);
  for (const bad of [
    "not json",
    JSON.stringify([]),
    JSON.stringify({ action: "buy", sizeUsdt: "5.01", reason: "over the limit" }),
    JSON.stringify({ action: "buy", sizeUsdt: "-1", reason: "r" }),
    JSON.stringify({ action: "buy", sizeUsdt: "0", reason: "r" }),
    JSON.stringify({ action: "buy", sizeUsdt: 5, reason: "a number, not a string" }),
    JSON.stringify({ action: "withdraw", sizeUsdt: "1", reason: "r" }),
    JSON.stringify({ action: "buy", sizeUsdt: "1", reason: "r", to: "0x000000000000000000000000000000000000dEaD" }),
  ]) {
    assert.throws(() => parseProposal(bad, 9n, PRICE, ai, "x"), ProposalError, bad);
  }
});

function fakeClient(reply: () => unknown) {
  const seen: Array<{ system: string; messages: Array<{ content: string }> }> = [];
  const create = async (params: never) => {
    seen.push(params);
    return reply();
  };
  return { seen, client: { beta: { messages: { create } } } as never };
}
const answer = (body: unknown, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text", text: JSON.stringify(body) }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 80, cost_usd: 0.001 }, ...extra });

test("the model sees computed numbers and no address or key, and its answer becomes the live proposal", async () => {
  const { seen, client } = fakeClient(() => answer({ action: "buy", sizeUsdt: "5", reason: "pool 130 bps under the bid" }));
  const strategist = new Strategist(client, "test-model", { maxUsdPerDay: 1, now: () => NOW });
  const p = await strategist.ask(input(aiPolicy, cheapPool, { mark: mark() }));
  assert.equal(p?.action, "buy");
  assert.equal(strategist.current()?.id, p?.id);
  const sent = JSON.stringify(seen[0]);
  assert.doesNotMatch(sent, /0x[0-9a-fA-F]{40}/, "no address");
  assert.doesNotMatch(sent, /0x[0-9a-fA-F]{64}/, "no key or hash");
  const snapshot = buildSnapshot(input(aiPolicy, cheapPool, { mark: mark() }), []);
  assert.ok(Number((snapshot.edge as { buyNetUsdtAtMaxSize: string }).buyNetUsdtAtMaxSize) > 0, "the model is shown what the gate will compute");
  strategist.consume(p!.id);
  assert.equal(strategist.current(), null, "a proposal is used once");
});

// Found by the replay on 2 November: with sellNetUsdtAtMaxSize positive, the model held 19 times, saying 0 HSK inventory
// left nothing to sell. Inventory is the model's own net position; the vault's balance is what a sell spends.
test("the model is told that zero inventory does not stop a sell, and is shown the vault's balance a sell spends", () => {
  assert.match(SYSTEM, /not what the vault holds/);
  assert.match(SYSTEM, /with an inventory of zero you can still sell/);
  const snapshot = buildSnapshot(input(aiPolicy, cheapPool, { mark: mark() }), []);
  assert.equal((snapshot.inventory as { hsk: string }).hsk, "0");
  assert.ok(Number((snapshot.limits as { vault: { hskBalance: string } }).vault.hskBalance) > 0);
});

test("an outage, a timeout, a cut-off or a bad answer leaves no proposal, and clears the old one", async () => {
  let reply: () => unknown = () => answer({ action: "buy", sizeUsdt: "5", reason: "ok" });
  const { client } = fakeClient(() => reply());
  const strategist = new Strategist(client, "m", { maxUsdPerDay: 1, timeoutMs: 20, now: () => NOW });
  const at = input(aiPolicy, cheapPool, { mark: mark() });
  assert.ok(await strategist.ask(at));
  for (const failure of [
    () => {
      throw new Error("503 from the provider");
    },
    () => new Promise(() => {}),
    () => answer({ action: "buy", sizeUsdt: "5", reason: "ok" }, { stop_reason: "max_tokens" }),
    () => answer({ action: "buy", sizeUsdt: "500", reason: "too big" }),
    () => ({ content: [{ type: "text", text: "Sure! Buy now." }], stop_reason: "end_turn" }),
  ]) {
    reply = failure;
    assert.equal(await strategist.ask(at), null);
    assert.equal(strategist.current(), null);
  }
  assert.equal(strategist.failures, 5);
  assert.equal(code(decide({ ...at, proposal: strategist.current() })), "no-signal", "and with no proposal, the agent holds");
});

test("consider() never waits for the model, and asks only when cadence, budget and a changed signal allow", async () => {
  let release: () => void = () => {};
  const { seen, client } = fakeClient(() => new Promise((resolve) => (release = () => resolve(answer({ action: "hold", sizeUsdt: null, reason: "quiet" })))));
  const strategist = new Strategist(client, "m", { maxUsdPerDay: 0.0025, quietBlocks: 1_000, now: () => NOW });
  const at = (block: bigint, m = mark()) => input(aiPolicy, market({ head: { ...cheapPool.head, number: block }, quotes: cheapPool.quotes }), { mark: m });
  assert.equal(strategist.consider(input(DEFAULT_POLICY, cheapPool, { mark: mark() })), "off");
  assert.equal(strategist.consider(at(100n)), "asked", "returned while the model is still thinking");
  assert.equal(strategist.consider(at(101n)), "in-flight");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(strategist.current()?.action, "hold");
  assert.equal(strategist.consider(at(110n)), "too-soon");
  assert.equal(strategist.consider(at(130n)), "no-change", "same signal, so no call");
  assert.equal(strategist.consider(at(130n, mark(88_000n, 87_800n))), "asked", "the gap moved a step");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(strategist.consider(at(200n, mark(88_500n, 88_300n))), "asked");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(strategist.consider(at(300n, mark(89_000n, 88_800n))), "budget", "three calls at $0.001 reach $0.0025");
  assert.equal(seen.length, 3);
  const capped = new Strategist(fakeClient(() => answer({ action: "hold", sizeUsdt: null, reason: "q" })).client, "m", { maxUsdPerDay: 1, now: () => NOW });
  const once = { ...aiPolicy, ai: { ...ai, maxCallsPerDay: 1 } };
  assert.equal(capped.consider(input(once, cheapPool, { mark: mark() })), "asked");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capped.consider(input(once, market({ head: { ...cheapPool.head, number: 500n } }), { mark: mark(90_000n, 89_800n) })), "call-limit");
});

test("the signal fingerprint moves with the gap, the paying side and the inventory, not with noise", () => {
  const base = signalFingerprint(buildSnapshot(input(aiPolicy, cheapPool, { mark: mark() }), []));
  assert.equal(signalFingerprint(buildSnapshot(input(aiPolicy, cheapPool, { mark: mark(87_502n, 87_302n) }), [])), base);
  assert.notEqual(signalFingerprint(buildSnapshot(input(aiPolicy, cheapPool, { mark: mark(), aiInventory: { hsk: HSK, usdt: -1n } }), [])), base);
  assert.notEqual(signalFingerprint(buildSnapshot(input(aiPolicy, cheapPool, {}), [])), base);
});

// The agent: proposals reach the chain only through act(), and nothing the model does reaches a stop

const AGENT_KEY = `0x${"11".repeat(32)}` as Hex;
const BLOCK = `0x${"aa".repeat(32)}` as Hex;
let server: http.Server;
let url: string;
let sent: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const call = JSON.parse(Buffer.concat(chunks).toString());
      let result: unknown;
      if (call.method === "eth_getTransactionCount") result = "0x1";
      else if (call.method === "eth_sendRawTransactionSync") {
        sent.push(call.params[0]);
        result = { status: "0x1", blockNumber: "0x65", blockHash: BLOCK, gasUsed: "0x5", effectiveGasPrice: "0x1", logs: [] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: `unexpected ${call.method}` } } : { jsonrpc: "2.0", id: call.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const chainMarket = (overrides: Partial<MarketState> = {}): MarketState =>
  market({ head: { number: 100n, hash: BLOCK, timestamp: 100n, baseFeePerGas: 1n }, priorityFeePerGas: 1n, l1FeeWei: 0n, vault: { ...vault, agentExpiry: 10_000n }, ...overrides });

function agentWith(policy: Policy, strategist: ProposalSource, markNow: Mark | null) {
  return new Agent({
    config: { rpcUrl: url, chainId: 177, live: true, pollMs: 650, dataDir: mkdtempSync(join(tmpdir(), "holdfast-ai-")), twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 5_000, poolKind: "v3", agentKey: AGENT_KEY, vault: HSKSWAP.router },
    lane: "fork",
    policy: () => policy,
    mark: () => markNow,
    now: () => 100_000,
    strategist,
  });
}
const act = (agent: Agent, policy: Policy, m: MarketState) => (agent as any).act(m, m.head, policy, new Trace(`t-${Math.random()}`, "fork"), 0, 1, undefined, "hot");

test("a model proposal that passes the gates is sent once, under its own key, and the model is told about the block after", async () => {
  sent = [];
  const live = proposal("buy", 5n * USDT);
  const consumed: string[] = [];
  const considered: bigint[] = [];
  let current: ModelProposal | null = live;
  const strategist: ProposalSource = {
    current: () => current,
    consider: (i) => {
      considered.push(i.market.head.number);
      return "asked";
    },
    consume: (id) => {
      consumed.push(id);
      current = null;
    },
  };
  const agent = agentWith(aiPolicy, strategist, { askX18: 87_500n, bidX18: 87_300n, fetchedAtMs: 100_000 });
  const record = await act(agent, aiPolicy, chainMarket({ quotes: cheapPool.quotes }));
  assert.equal(record.decision.action, "trade");
  assert.equal(record.decision.trigger, "model");
  assert.equal(record.proposal.id, live.id);
  assert.equal(record.intent.key, "ai:0");
  assert.deepEqual(consumed, [live.id]);
  assert.deepEqual(considered, [100n], "asked after deciding, not before");
  const again = await act(agent, aiPolicy, chainMarket({ quotes: cheapPool.quotes }));
  assert.equal(again.decision.action, "hold", "a used proposal does not trade twice");
  assert.equal(sent.length, 1);
  agent.close();
});

test("a strategist that throws and has nothing to say does not stop a stop-loss", async () => {
  sent = [];
  const policy: Policy = { ...aiPolicy, stopConfirmBlocks: 1, orders: [{ id: "s", kind: "stop-loss", amountIn: 100n * HSK, triggerPriceX18: 80_000n }] };
  const broken: ProposalSource = {
    current: () => null,
    consider: () => {
      throw new Error("model provider is down");
    },
    consume: () => {},
  };
  const agent = agentWith(policy, broken, null);
  const record = await act(agent, policy, chainMarket({ spotPriceX18: 70_000n, quotes: [sellQuote(100n * HSK, 7_000_000n)] }));
  assert.equal(record.decision.trigger, "stop-loss");
  assert.match(record.intent.key, /^order:/);
  assert.equal(sent.length, 1);
  assert.equal(agent.errors, 1, "the strategist's failure is logged");
  agent.close();
});

test("observing only, a model proposal is decided and recorded but nothing is signed", async () => {
  sent = [];
  const strategist: ProposalSource = { current: () => proposal("buy", 5n * USDT), consider: () => "asked", consume: () => assert.fail("nothing was sent, so nothing is used") };
  const agent = new Agent({
    config: { rpcUrl: url, chainId: 177, live: false, pollMs: 650, dataDir: mkdtempSync(join(tmpdir(), "holdfast-ai-")), twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 5_000, poolKind: "v3" },
    lane: "fork",
    policy: () => aiPolicy,
    mark: () => ({ askX18: 87_500n, bidX18: 87_300n, fetchedAtMs: 100_000 }),
    now: () => 100_000,
    strategist,
  });
  const record = await act(agent, aiPolicy, chainMarket({ quotes: cheapPool.quotes }));
  assert.equal(record.decision.trigger, "model");
  assert.equal(record.observeOnly, true);
  assert.equal(sent.length, 0);
  agent.close();
});
