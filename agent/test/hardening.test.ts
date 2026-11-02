import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent.js";
import { BREAKER_DEFAULTS, breakerVerdict } from "../src/breaker.js";
import { HSKSWAP } from "../src/config.js";
import { decide, edgeHasClosed, hourlyLossBound, trancheSize, type DecideInput, type Mark, type TradeDecision } from "../src/decide.js";
import type { Intent } from "../src/ledger.js";
import { DEFAULT_POLICY, parsePolicy, serializePolicy, type Order, type Policy } from "../src/policy.js";
import type { MarketState, TokenLimits, VaultState } from "../src/reader.js";
import { Trace } from "../src/trace.js";

const NOW = 1_800_000_000_000;
const PRICE = 87_400n;
const HSK = 10n ** 18n;
const USDT = 10n ** 6n;
const whsk: TokenLimits = { balance: 1_000n * HSK, maxTrade: 200n * HSK, remaining: 500n * HSK, floorPriceX18: 50_000n, hourlyBudget: 300n * HSK, available: 300n * HSK };
const usdt: TokenLimits = { balance: 50n * USDT, maxTrade: 20n * USDT, remaining: 25n * USDT, floorPriceX18: 5n * HSK, hourlyBudget: 25n * USDT, available: 25n * USDT };
const vault: VaultState = { paused: false, agentExpiry: BigInt(NOW / 1000) + 3_600n, whsk, usdt };

function market(overrides: Partial<MarketState> = {}): MarketState {
  return {
    head: { number: 100n, hash: "0xabc", timestamp: BigInt(NOW / 1000), baseFeePerGas: 0n },
    sqrtPriceX96: 0n,
    tick: -300694,
    twapTick: -300694,
    liquidity: 1n,
    spotPriceX18: PRICE,
    quotes: [],
    priorityFeePerGas: 0n,
    l1FeeWei: 0n,
    vault,
    ...overrides,
  };
}
const sellQuote = (amountIn: bigint, amountOut: bigint) => ({ tokenIn: HSKSWAP.whsk as `0x${string}`, amountIn, amountOut, ticksCrossed: 0 });
const buyQuote = (amountIn: bigint, amountOut: bigint) => ({ tokenIn: HSKSWAP.usdt as `0x${string}`, amountIn, amountOut, ticksCrossed: 0 });
const input = (policy: Partial<Policy>, m: MarketState, extra: Partial<DecideInput> = {}): DecideInput => ({
  market: m,
  policy: { ...DEFAULT_POLICY, ...policy },
  mark: null,
  runtime: new Map(),
  nowMs: NOW,
  maxStateAgeMs: 6_000,
  maxMarkAgeMs: 5_000,
  ...extra,
});
const code = (d: ReturnType<typeof decide>) => (d.action === "hold" ? d.code : d.action);
const stop: Order = { id: "s", kind: "stop-loss", amountIn: 100n * HSK, triggerPriceX18: 80_000n };
const crashed = market({ spotPriceX18: 70_000n, quotes: [sellQuote(100n * HSK, 7_000_000n)] });
const confirmed = new Map([["s", { filled: 0n, hitStreak: 1 }]]);

// Key expiry and the hourly budget

test("an expired key holds instead of sending a doomed transaction", () => {
  const m = market({ vault: { ...vault, agentExpiry: BigInt(NOW / 1000) }, quotes: [sellQuote(1n * HSK, 87_000n)] });
  assert.equal(code(decide(input({ orders: [{ id: "m", kind: "market-sell", amountIn: 1n * HSK }] }, m))), "key-expired");
});

test("a vault from before expiry never reads as expired", () => {
  const m = market({ vault: { ...vault, agentExpiry: null }, quotes: [sellQuote(1n * HSK, 87_000n)] });
  assert.equal(decide(input({ orders: [{ id: "m", kind: "market-sell", amountIn: 1n * HSK }] }, m)).action, "trade");
});

test("a tranche uses only the budget available, on a grid so its quote lasts", () => {
  const order: Order = { id: "m", kind: "market-sell", amountIn: 100n * HSK };
  const step = whsk.hourlyBudget / 60n;
  const limited = { ...vault, whsk: { ...whsk, available: step * 3n + 7n } };
  assert.equal(trancheSize(order, undefined, limited), step * 3n);
  const refilledABit = { ...vault, whsk: { ...whsk, available: step * 3n + 99n } };
  assert.equal(trancheSize(order, undefined, refilledABit), step * 3n, "same size next block, so the planned quote matches");
});

test("no budget right now is reported as that, not as an empty vault", () => {
  const m = market({ vault: { ...vault, whsk: { ...whsk, available: 0n } } });
  assert.equal(code(decide(input({ orders: [{ id: "m", kind: "market-sell", amountIn: 1n * HSK }] }, m))), "over-budget");
});

test("the loss bound grows when the floor is left behind the market", () => {
  const atOldPrice = hourlyLossBound({ ...vault, usdt: { ...usdt, hourlyBudget: 0n } }, PRICE);
  assert.equal(atOldPrice, (300n * HSK * (PRICE - 50_000n)) / HSK);
  const afterRally = hourlyLossBound({ ...vault, usdt: { ...usdt, hourlyBudget: 0n } }, PRICE * 2n);
  assert.ok(afterRally > atOldPrice * 2n);
});

// Bad price data

const mark = (ask: bigint, bid: bigint, ageMs = 0): Mark => ({ askX18: ask, bidX18: bid, fetchedAtMs: NOW - ageMs });
const edgePolicy = { edge: { enabled: true, sizeUsdt: 15n * USDT, minNetUsdt: 0n, maxInventoryUsdt: 1_000n * USDT } };
const edgeMarket = market({ quotes: [buyQuote(15n * USDT, 174n * HSK)] }); // Buys at about 0.0862, spot 0.0874

test("an outside price the pool's TWAP disagrees with is not an edge", () => {
  assert.equal(decide(input(edgePolicy, edgeMarket, { mark: mark(87_500n, 87_300n) })).action, "trade");
  assert.equal(code(decide(input(edgePolicy, edgeMarket, { mark: mark(91_000n, 90_800n) }))), "mark-disagrees");
});

test("a mark older than the opportunity it would price is refused", () => {
  assert.equal(code(decide(input(edgePolicy, edgeMarket, { mark: mark(87_500n, 87_300n, 5_001) }))), "stale-mark");
});

test("a market order refuses a pool far from its TWAP", () => {
  const m = market({ tick: -300694, twapTick: -300000, quotes: [sellQuote(1n * HSK, 87_000n)] });
  assert.equal(code(decide(input({ orders: [{ id: "m", kind: "market-sell", amountIn: 1n * HSK }] }, m))), "price-deviation");
});

test("a limit order's price binds the transaction, not just the decision", () => {
  const order: Order = { id: "l", kind: "limit-sell", amountIn: 100n * HSK, triggerPriceX18: 87_000n };
  const d = decide(input({ orders: [order] }, market({ quotes: [sellQuote(100n * HSK, 8_710_000n)] })));
  assert.equal(d.action, "trade");
  assert.equal((d as TradeDecision).minOut, 8_700_000n, "the 50 bps slippage alone would have accepted 8,666,450");
});

// Stop-loss against floor and bad data

test("a stop under the owner's floor says so plainly, because only a person can fix it", () => {
  const floorAbove = market({ ...crashed, vault: { ...vault, whsk: { ...whsk, floorPriceX18: 75_000n } } });
  const d = decide(input({ orders: [stop] }, floorAbove, { runtime: confirmed }));
  assert.equal(code(d), "stop-blocked");
});

test("a stop fires with no outside price at all", () => {
  assert.equal(decide(input({ orders: [stop] }, crashed, { runtime: confirmed })).action, "trade");
});

test("a stop fires on a stale outside price that says all is well", () => {
  assert.equal(decide(input({ orders: [stop] }, crashed, { runtime: confirmed, mark: mark(87_500n, 87_300n, 60_000) })).action, "trade");
});

test("a stop waits when a live outside price says only this pool moved", () => {
  assert.equal(code(decide(input({ orders: [stop] }, crashed, { runtime: confirmed, mark: mark(87_500n, 87_300n) }))), "stop-disputed");
});

test("a stop fires when the outside price confirms the fall", () => {
  assert.equal(decide(input({ orders: [stop] }, crashed, { runtime: confirmed, mark: mark(70_500n, 70_300n) })).action, "trade");
});

test("a dispute cannot hold a stop for long", () => {
  const long = new Map([["s", { filled: 0n, hitStreak: 30 }]]);
  assert.equal(decide(input({ orders: [stop] }, crashed, { runtime: long, mark: mark(87_500n, 87_300n) })).action, "trade");
});

// A frame that never seals (item 9)

test("a false frame cannot fire a stop, even with one-block confirmation", () => {
  // The frame shows a crash. If it never seals, the pool is still at 0.0874, so this sale would have filled: its minOut
  // comes from the crashed quote, and the real output is higher. A false stop is not saved by a revert.
  const policy = { orders: [stop], stopConfirmBlocks: 1 };
  const onFrame = decide(input(policy, crashed));
  assert.equal(onFrame.action, "trade", "without the rule it fires");
  const realOut = (100n * HSK * PRICE) / HSK;
  assert.ok(realOut >= (onFrame as TradeDecision).minOut, "and it would fill: principal sold on a move that never happened");
  assert.equal(code(decide(input(policy, crashed, { unsealed: true }))), "stop-unconfirmed");
});

test("a false frame on a limit order only reverts: the real output misses minOut", () => {
  const order: Order = { id: "l", kind: "limit-sell", amountIn: 100n * HSK, triggerPriceX18: 90_000n };
  const onFrame = decide(input({ orders: [order] }, market({ spotPriceX18: 90_100n, quotes: [sellQuote(100n * HSK, 9_010_000n)] }), { unsealed: true }));
  assert.equal(onFrame.action, "trade");
  const realOut = (100n * HSK * PRICE) / HSK;
  assert.ok(realOut < (onFrame as TradeDecision).minOut, "reverts, costing gas and no principal");
});

// One fill per opportunity, and inventory (items 10 and 18)

test("the edge does not trade the same gap twice", () => {
  assert.equal(code(decide(input(edgePolicy, edgeMarket, { mark: mark(87_500n, 87_300n), edgeTaken: true }))), "opportunity-taken");
});

test("only a clear no reopens the edge: bad data leaves the gap counted as open", () => {
  const uneconomic = market({ quotes: [buyQuote(15n * USDT, 170n * HSK)] });
  assert.equal(edgeHasClosed(input(edgePolicy, uneconomic, { mark: mark(87_500n, 87_300n) })), true);
  assert.equal(edgeHasClosed(input(edgePolicy, edgeMarket, { mark: mark(87_500n, 87_300n) })), false);
  assert.equal(edgeHasClosed(input(edgePolicy, uneconomic, { mark: mark(87_500n, 87_300n, 9_000) })), false, "stale");
  assert.equal(edgeHasClosed(input(edgePolicy, uneconomic)), false, "no mark");
});

test("with nothing closing the other leg, the edge holds at most its limit, and may still reduce", () => {
  const capped = { edge: { enabled: true, sizeUsdt: 15n * USDT, minNetUsdt: 0n } };
  const m = mark(87_500n, 87_300n);
  assert.equal(decide(input(capped, edgeMarket, { mark: m })).action, "trade", "first trade fits a limit of one trade's worth");
  const holding = (15n * USDT * HSK) / PRICE;
  assert.equal(code(decide(input(capped, edgeMarket, { mark: m, edgeInventoryHsk: holding }))), "inventory-limit");
  const sellSide = market({ quotes: [sellQuote(holding, 15_500_000n)] });
  assert.equal(decide(input(capped, sellSide, { mark: m, edgeInventoryHsk: holding })).action, "trade");
});

test("an edge limit in a stored policy survives parsing, and old policies still parse", () => {
  const policy: Policy = { ...DEFAULT_POLICY, edge: { enabled: true, sizeUsdt: 1n, minNetUsdt: 0n, maxInventoryUsdt: 5n } };
  assert.equal(parsePolicy(serializePolicy(policy)).edge.maxInventoryUsdt, 5n);
  assert.equal(parsePolicy(serializePolicy(DEFAULT_POLICY)).edge.maxInventoryUsdt, undefined);
});

// The breaker

const settled = (key: string, status: Intent["status"], block = 100n, extra: Partial<Intent> = {}): Intent => ({
  key,
  intentId: "0x00",
  bodyHash: "0x00",
  status,
  orderId: null,
  tokenIn: HSKSWAP.usdt,
  amountIn: 15n * USDT,
  minOut: 1n,
  deadline: 1n,
  blockNumber: block,
  broadcastBlock: block,
  ...extra,
});
const tradeOf = (trigger: TradeDecision["trigger"]) => ({ action: "trade", trigger }) as TradeDecision;
const verdict = (trigger: TradeDecision["trigger"], intents: Intent[], head = 200n) => breakerVerdict(tradeOf(trigger), intents, head, PRICE, BREAKER_DEFAULTS);
const threeFailed = [settled("a", "reverted"), settled("b", "reverted"), settled("c", "expired")];

test("three failures in a row stop limits, market orders and the edge", () => {
  for (const trigger of ["limit", "market", "edge"] as const) assert.match(verdict(trigger, threeFailed) ?? "", /failed in a row/);
  assert.equal(verdict("limit", threeFailed.slice(1)), null);
  assert.equal(verdict("limit", [...threeFailed, settled("d", "included")]), null, "a fill ends the run");
});

test("a failing stop is never latched off, but backs off", () => {
  assert.equal(verdict("stop-loss", threeFailed, 200n), null);
  assert.match(verdict("stop-loss", threeFailed, 103n) ?? "", /waits until block 104/);
  assert.equal(verdict("stop-loss", threeFailed, 104n), null);
  const many = Array.from({ length: 20 }, (_, i) => settled(`k${i}`, "reverted"));
  assert.match(verdict("stop-loss", many, 110n) ?? "", /waits until block 164/, "capped at 64 blocks");
});

test("edge trades per hour are capped, and old ones stop counting", () => {
  const six = Array.from({ length: 6 }, (_, i) => settled(`edge:${i}`, "included", 100n, { amountOut: (15n * USDT * HSK) / PRICE }));
  assert.match(verdict("edge", six, 200n) ?? "", /edge trades in the last hour/);
  assert.equal(verdict("edge", six, 100n + 1_800n), null);
  assert.equal(verdict("limit", six, 200n), null, "a fixed order is not capped");
});

test("edge losses at the current price stop the edge and nothing else", () => {
  const bad = [settled("edge:0", "included", 100n, { amountOut: (15n * USDT * HSK) / 200_000n })];
  assert.match(verdict("edge", bad) ?? "", /edge trades are down/);
  assert.equal(verdict("limit", bad), null);
});

// The live loop against the shadow's count

function liveAgent() {
  const dataDir = mkdtempSync(join(tmpdir(), "holdfast-"));
  return new Agent({
    config: { rpcUrl: "http://127.0.0.1:9", chainId: 177, live: true, pollMs: 650, dataDir, twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 5_000, poolKind: "v3", agentKey: `0x${"11".repeat(32)}`, vault: HSKSWAP.router },
    lane: "fork",
    policy: () => DEFAULT_POLICY,
    mark: () => mark(87_500n, 87_300n),
    now: () => NOW,
  });
}

test("live, a gap held for five blocks gets one fill, and a later gap gets another", async () => {
  const agent = liveAgent();
  const submitted: string[] = [];
  agent.executor!.submit = async (key, decision) => {
    submitted.push(key);
    const reserved = agent.ledger.reserve({ key, intentId: `0x${String(submitted.length).padStart(64, "0")}`, bodyHash: `0x${submitted.length}`, orderId: null, tokenIn: decision.tokenIn, amountIn: decision.amountIn, minOut: decision.minOut, deadline: 1n }).intent;
    return agent.ledger.update(reserved.key, { status: "included", amountOut: 174n * HSK, blockNumber: 100n, broadcastBlock: 100n, feeWei: 0n });
  };
  const policy = { ...DEFAULT_POLICY, ...edgePolicy };
  const act = (m: MarketState) => (agent as any).act(m, m.head, policy, new Trace("t", "fork"), 0, 1, 0, "hot");
  const inBlock = (m: MarketState, n: bigint) => ({ ...m, head: { ...m.head, number: n } });
  const decisions = [];
  for (let n = 100n; n < 105n; n++) decisions.push(code((await act(inBlock(edgeMarket, n))).decision));
  assert.deepEqual(decisions, ["trade", "opportunity-taken", "opportunity-taken", "opportunity-taken", "opportunity-taken"]);
  assert.deepEqual(submitted, ["edge:0"]);
  await act(inBlock(market({ quotes: [buyQuote(15n * USDT, 170n * HSK)] }), 105n));
  await act(inBlock(edgeMarket, 106n));
  assert.deepEqual(submitted, ["edge:0", "edge:1"]);
  agent.close();
});

test("after a restart the edge assumes the last gap is still open", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "holdfast-"));
  const config = { rpcUrl: "http://127.0.0.1:9", chainId: 177, live: true, pollMs: 650, dataDir, twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 5_000, poolKind: "v3" as const, agentKey: `0x${"11".repeat(32)}` as const, vault: HSKSWAP.router as `0x${string}` };
  const first = new Agent({ config, lane: "fork", policy: () => DEFAULT_POLICY, mark: () => null });
  first.ledger.reserve({ key: "edge:0", intentId: "0x00", bodyHash: "0x00", orderId: null, tokenIn: HSKSWAP.usdt, amountIn: 1n, minOut: 1n, deadline: 1n });
  first.close();
  const second = new Agent({ config, lane: "fork", policy: () => DEFAULT_POLICY, mark: () => null });
  assert.equal((second as any).edgeTaken, true);
  second.close();
});

test("the owner's reset of the breaker survives a restart", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "holdfast-"));
  const config = { rpcUrl: "http://127.0.0.1:9", chainId: 177, live: true, pollMs: 650, dataDir, twapWindowSec: 300, maxStateAgeMs: 6_000, maxMarkAgeMs: 5_000, poolKind: "v3" as const, agentKey: `0x${"11".repeat(32)}` as const, vault: HSKSWAP.router as `0x${string}` };
  const first = new Agent({ config, lane: "fork", policy: () => DEFAULT_POLICY, mark: () => null });
  for (const key of ["a", "b", "c"]) {
    first.ledger.reserve({ key, intentId: "0x00", bodyHash: "0x00", orderId: "o", tokenIn: HSKSWAP.usdt, amountIn: 1n, minOut: 1n, deadline: 1n });
    first.ledger.update(key, { status: "reverted", blockNumber: 1n });
  }
  const trade = { action: "trade", trigger: "limit" } as TradeDecision;
  const apply = (agent: Agent) => (agent as any).applyBreaker(trade, market());
  assert.equal(apply(first).action, "hold");
  first.resetBreaker();
  assert.equal(apply(first).action, "trade");
  first.close();
  const second = new Agent({ config, lane: "fork", policy: () => DEFAULT_POLICY, mark: () => null });
  assert.equal(apply(second).action, "trade");
  second.close();
});

// Overdue polls

test("after a stall the loop resumes on time and does not fire its overdue polls in a burst", async () => {
  const agent = liveAgent();
  (agent as any).rpc.call = async () => "0xb1";
  (agent as any).executor.recover = async () => [];
  (agent as any).checkVenue = async () => ({ chainId: 177, block: "1", verdict: "pass", checks: [] });
  (agent as any).options.config.pollMs = 50;
  const startedAt: number[] = [];
  (agent as any).step = async () => {
    startedAt.push(performance.now());
    if (startedAt.length === 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (startedAt.length === 5) (agent as any).stopping = true;
  };
  await agent.run();
  assert.ok(agent.skippedTicks >= 15, `skipped ${agent.skippedTicks}`);
  const gaps = startedAt.slice(2).map((at, i) => at - startedAt[i + 1]!);
  for (const gap of gaps) assert.ok(gap >= 25, `polls ${gap} ms apart; the old loop sent 20 with no gap`);
  agent.close();
});
