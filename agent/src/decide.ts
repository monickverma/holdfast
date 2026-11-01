import type { Address } from "viem";
import { HSKSWAP } from "./config.js";
import { isSell, type Order, type Policy } from "./policy.js";
import type { MarketState, QuoteRequest, TokenLimits, VaultState } from "./reader.js";

const E18 = 10n ** 18n;
const BPS = 10_000n;

/** Rounded up from 174,566 gas measured on one fork swap; replace with the mainnet figure once there are receipts. */
export const GAS_ESTIMATE = 200_000n;

/**
 * How far an outside price may sit from this pool before the two are treated as disagreeing. Over 992 mainnet samples
 * the pool and Gate's mid were at most 63.9 bps apart, including every sample where the edge rule wanted to trade.
 */
export const MAX_MARK_GAP_BPS = 150;
/** A stop the outside price disputes waits at most this many sealed blocks, about a minute, and then sells anyway. */
export const STOP_DISPUTE_MAX_BLOCKS = 30;
/** Budget a tranche may use is rounded down to this fraction of the hour, so its quote stays valid between blocks. */
const BUDGET_STEPS = 60n;

/** A reference price from outside this pool. Ask and bid are USDT micro-units per 1 HSK. */
export interface Mark {
  askX18: bigint;
  bidX18: bigint;
  fetchedAtMs: number;
}

export interface OrderRuntime {
  filled: bigint;
  /** Consecutive blocks a stop-loss condition has held. */
  hitStreak: number;
}

export type HoldCode =
  | "no-signal"
  | "paused"
  | "key-expired"
  | "over-budget"
  | "opportunity-taken"
  | "inventory-limit"
  | "mark-disagrees"
  | "stop-blocked"
  | "stop-disputed"
  | "breaker"
  | "stale-state"
  | "stale-mark"
  | "price-deviation"
  | "no-balance"
  | "cap-exhausted"
  | "no-limits"
  | "below-floor"
  | "uneconomic"
  | "stop-unconfirmed"
  | "requote";

export interface CostLedger {
  /** Value given up, in USDT micro-units at the conservative mark. Null when no mark exists. */
  inputValue: bigint | null;
  outputValue: bigint | null;
  networkCost: bigint;
  /** Output minus input minus network cost, conservative. */
  net: bigint | null;
}

export interface TradeDecision {
  action: "trade";
  trigger: "stop-loss" | "limit" | "market" | "edge";
  orderId: string | null;
  tokenIn: Address;
  amountIn: bigint;
  quotedOut: bigint;
  minOut: bigint;
  ledger: CostLedger;
  reason: string;
}

export interface HoldDecision {
  action: "hold";
  code: HoldCode;
  reason: string;
  ledger?: CostLedger;
}

export type Decision = TradeDecision | HoldDecision;

export interface DecideInput {
  market: MarketState;
  policy: Policy;
  mark: Mark | null;
  runtime: ReadonlyMap<string, OrderRuntime>;
  nowMs: number;
  maxStateAgeMs: number;
  maxMarkAgeMs: number;
  /** True when the state came from a flashblock frame that has not sealed. Stops never fire on these. */
  unsealed?: boolean;
  /** True from an edge trade until the gap it traded is seen to close: one fill per opportunity. */
  edgeTaken?: boolean;
  /** Net WHSK wei the edge rule has bought and not sold, which nothing closes on any other venue. */
  edgeInventoryHsk?: bigint;
}

/** Pure and synchronous. No model and no network: everything it uses was read before it ran. */
export function decide(input: DecideInput): Decision {
  const { market, policy, runtime } = input;
  const vault = market.vault;
  if (!vault) return hold("no-limits", "No vault is configured, so there is nothing the agent may spend.");
  if (vault.paused) return hold("paused", "The vault is paused.");
  if (vault.agentExpiry !== null && market.head.timestamp >= vault.agentExpiry) {
    return hold("key-expired", `The agent key expired at ${vault.agentExpiry}. Only the owner can renew it.`);
  }

  const ageMs = input.nowMs - Number(market.head.timestamp) * 1000;
  if (ageMs > input.maxStateAgeMs) {
    return hold("stale-state", `State from block ${market.head.number} is ${ageMs} ms old, over the ${input.maxStateAgeMs} ms limit.`);
  }

  // Stop-losses come first: protecting the position outranks every other reason to act.
  const first: Decision[] = [];
  for (const order of policy.orders) {
    const decision = decideOrder(order, input, runtime.get(order.id));
    if (decision.action === "trade") return decision;
    first.push(decision);
  }

  if (policy.edge.enabled) {
    const edge = decideEdge(input, vault);
    if (edge.action === "trade") return edge;
    first.push(edge);
  }

  // Report the most informative refusal rather than a generic one.
  return first.find((d) => d.action === "hold" && d.code !== "no-signal") ?? first[0] ?? hold("no-signal", "No active order and the edge rule is off.");
}

/** The inputs the next decision needs quoted. Sizes use the last known limits, and decide() rejects a mismatch. */
export function plannedQuotes(policy: Policy, market: MarketState | null, runtime: ReadonlyMap<string, OrderRuntime>): QuoteRequest[] {
  const requests: QuoteRequest[] = [];
  for (const order of policy.orders) {
    const amountIn = trancheSize(order, runtime.get(order.id), market?.vault);
    if (amountIn > 0n) requests.push({ tokenIn: orderToken(order), amountIn });
  }
  if (policy.edge.enabled && market) {
    const sell = edgeSellSize(policy, market);
    if (sell > 0n) requests.push({ tokenIn: HSKSWAP.whsk, amountIn: sell });
    requests.push({ tokenIn: HSKSWAP.usdt, amountIn: policy.edge.sizeUsdt });
  }
  return requests;
}

export function orderToken(order: Order): Address {
  return isSell(order.kind) ? HSKSWAP.whsk : HSKSWAP.usdt;
}

export function trancheSize(order: Order, state: OrderRuntime | undefined, vault: VaultState | undefined): bigint {
  const left = order.amountIn - (state?.filled ?? 0n);
  if (left <= 0n) return 0n;
  if (!vault) return left;
  const limits = isSell(order.kind) ? vault.whsk : vault.usdt;
  return min(left, limits.maxTrade, limits.remaining, limits.balance, budgetNow(limits));
}

function budgetNow(limits: TokenLimits): bigint {
  const step = limits.hourlyBudget / BUDGET_STEPS;
  if (step === 0n || limits.available === limits.hourlyBudget) return limits.available;
  return (limits.available / step) * step;
}

/**
 * The most the agent's key can lose per hour at this price, however it is used: the hourly budget, in each direction,
 * sold at the owner's floor instead of at spot. In USDT micro-units. A floor left far below the market widens this.
 */
export function hourlyLossBound(vault: VaultState, spotPriceX18: bigint): bigint {
  const sell = (vault.whsk.hourlyBudget * max(spotPriceX18 - vault.whsk.floorPriceX18, 0n)) / E18;
  const boughtWorth = (vault.usdt.hourlyBudget * vault.usdt.floorPriceX18 * spotPriceX18) / E18 / E18;
  return sell + max(vault.usdt.hourlyBudget - boughtWorth, 0n);
}

/** Distance in bps from the outside mid to the pool's TWAP, which one block's trading cannot move far. */
export function markGapBps(market: MarketState, mark: Mark): number {
  if (market.spotPriceX18 === 0n) return Infinity;
  const mid = Number(mark.askX18 + mark.bidX18) / 2;
  return Math.abs((mid / Number(market.spotPriceX18) - 1) * 10_000 + (market.tick - market.twapTick));
}

/** Whether a gap the edge rule already traded has closed. Anything short of a clear no leaves it open. */
export function edgeHasClosed(input: DecideInput): boolean {
  if (!input.market.vault) return false;
  const edge = decideEdge({ ...input, edgeTaken: false, edgeInventoryHsk: 0n }, input.market.vault);
  return edge.action === "hold" && edge.code === "uneconomic";
}

export function floorOut(amountIn: bigint, floorPriceX18: bigint): bigint {
  return (amountIn * floorPriceX18 + E18 - 1n) / E18;
}

/** Network cost in USDT micro-units at spot, using the estimated gas plus the L1 data fee. */
export function networkCostUsdt(market: MarketState): bigint {
  const wei = GAS_ESTIMATE * (market.head.baseFeePerGas + market.priorityFeePerGas) + market.l1FeeWei;
  return (wei * market.spotPriceX18 + E18 - 1n) / E18;
}

/**
 * Values a trade against the outside reference, on the side least favourable to it: HSK given up is worth the ask,
 * HSK received is worth the bid. USDT is taken at face value.
 */
export function costLedger(tokenIn: Address, amountIn: bigint, amountOut: bigint, market: MarketState, mark: Mark | null): CostLedger {
  const networkCost = networkCostUsdt(market);
  if (!mark) return { inputValue: null, outputValue: null, networkCost, net: null };
  const selling = tokenIn.toLowerCase() === HSKSWAP.whsk.toLowerCase();
  const inputValue = selling ? (amountIn * mark.askX18 + E18 - 1n) / E18 : amountIn;
  const outputValue = selling ? amountOut : (amountOut * mark.bidX18) / E18;
  return { inputValue, outputValue, networkCost, net: outputValue - inputValue - networkCost };
}

function decideOrder(order: Order, input: DecideInput, state: OrderRuntime | undefined): Decision {
  const { market, policy, mark } = input;
  const vault = market.vault!;
  const selling = isSell(order.kind);
  const limits = selling ? vault.whsk : vault.usdt;
  const tokenIn = orderToken(order);

  if (order.amountIn - (state?.filled ?? 0n) <= 0n) return hold("no-signal", `Order ${order.id} is complete.`);

  // Evaluate the trigger before reporting limits, so an idle order never reads as a problem.
  const stopHit = order.kind === "stop-loss" && market.spotPriceX18 <= order.triggerPriceX18!;
  if (order.kind === "stop-loss" && !stopHit) {
    return hold("no-signal", `Stop ${order.id}: spot ${market.spotPriceX18} is above trigger ${order.triggerPriceX18}.`);
  }

  const amountIn = trancheSize(order, state, vault);
  const blocked = limitProblem(order, limits, amountIn);
  if (blocked) return blocked;

  const quote = market.quotes.find((q) => q.amountIn === amountIn && q.tokenIn.toLowerCase() === tokenIn.toLowerCase());
  if (!quote) return hold("requote", `Order ${order.id}: limits changed, so the quote for ${amountIn} will come next block.`);

  // Execution price including fee and impact, in USDT micro-units per 1 HSK.
  const fillPrice = selling ? (quote.amountOut * E18) / amountIn : (amountIn * E18) / max(quote.amountOut, 1n);
  const ledger = costLedger(tokenIn, amountIn, quote.amountOut, market, mark);

  let trigger: TradeDecision["trigger"];
  let reason: string;
  // A limit order's price is a promise, so it also binds what the transaction accepts.
  let limitOut = 0n;
  switch (order.kind) {
    case "stop-loss": {
      const streak = state?.hitStreak ?? 0;
      if (input.unsealed) return hold("stop-unconfirmed", `Stop ${order.id}: waits for a sealed block; this frame has not sealed.`, ledger);
      if (streak + 1 < policy.stopConfirmBlocks) {
        return hold("stop-unconfirmed", `Stop ${order.id}: condition held ${streak + 1} of ${policy.stopConfirmBlocks} blocks.`, ledger);
      }
      // A thin pool can be pushed through a stop to buy the sale cheaply. A live outside price well above the trigger
      // says so. Stale or missing outside data never holds a stop back, and neither does a dispute that lasts.
      if (mark && input.nowMs - mark.fetchedAtMs <= input.maxMarkAgeMs && streak < STOP_DISPUTE_MAX_BLOCKS) {
        const disputedAbove = (order.triggerPriceX18! * BigInt(10_000 + MAX_MARK_GAP_BPS)) / BPS;
        if (mark.bidX18 > disputedAbove) {
          return hold("stop-disputed", `Stop ${order.id}: pool is at the trigger but the outside bid is ${mark.bidX18}; held ${streak + 1} of ${STOP_DISPUTE_MAX_BLOCKS} blocks.`, ledger);
        }
      }
      trigger = "stop-loss";
      reason = `Stop ${order.id}: spot ${market.spotPriceX18} at or below ${order.triggerPriceX18} for ${policy.stopConfirmBlocks} blocks.`;
      break;
    }
    case "limit-sell":
    case "limit-buy": {
      limitOut = selling ? floorOut(amountIn, order.triggerPriceX18!) : (amountIn * E18) / order.triggerPriceX18!;
      if (quote.amountOut < limitOut) return hold("no-signal", `Limit ${order.id}: fill price ${fillPrice} has not reached ${order.triggerPriceX18}.`, ledger);
      const deviation = Math.abs(market.tick - market.twapTick);
      if (deviation > policy.maxTwapDeviationBps) {
        return hold("price-deviation", `Limit ${order.id}: spot is ${deviation} bps from TWAP, over ${policy.maxTwapDeviationBps}.`, ledger);
      }
      trigger = "limit";
      reason = `Limit ${order.id}: fill price ${fillPrice} reached ${order.triggerPriceX18}.`;
      break;
    }
    default: {
      const deviation = Math.abs(market.tick - market.twapTick);
      if (deviation > policy.maxTwapDeviationBps) {
        return hold("price-deviation", `Market order ${order.id}: spot is ${deviation} bps from TWAP, over ${policy.maxTwapDeviationBps}.`, ledger);
      }
      trigger = "market";
      reason = `Market order ${order.id}.`;
    }
  }

  const decision = trade(trigger, order.id, tokenIn, amountIn, quote.amountOut, limits, policy, ledger, reason, limitOut);
  if (order.kind === "stop-loss" && decision.action === "hold" && decision.code === "below-floor") {
    return hold("stop-blocked", `Stop ${order.id} cannot sell: the price is under the owner's floor, so the vault would refuse. Only the owner can act now, by lowering the floor or withdrawing.`, ledger);
  }
  return decision;
}

function decideEdge(input: DecideInput, vault: VaultState): Decision {
  const { market, policy, mark, nowMs, maxMarkAgeMs } = input;
  if (!mark) return hold("stale-mark", "No reference price yet, so the edge cannot be valued.");
  if (nowMs - mark.fetchedAtMs > maxMarkAgeMs) return hold("stale-mark", `Reference price is older than ${maxMarkAgeMs} ms.`);
  const deviation = Math.abs(market.tick - market.twapTick);
  if (deviation > policy.maxTwapDeviationBps) {
    return hold("price-deviation", `Spot is ${deviation} bps from TWAP, over ${policy.maxTwapDeviationBps}.`);
  }
  // All of an edge's value comes from the outside price, so an outside price that disagrees with the pool is not an edge.
  const gap = markGapBps(market, mark);
  if (gap > MAX_MARK_GAP_BPS) return hold("mark-disagrees", `Reference price is ${gap.toFixed(0)} bps from the pool's TWAP, over ${MAX_MARK_GAP_BPS}.`);

  const sides: Array<{ tokenIn: Address; amountIn: bigint; limits: TokenLimits }> = [
    { tokenIn: HSKSWAP.whsk, amountIn: edgeSellSize(policy, market), limits: vault.whsk },
    { tokenIn: HSKSWAP.usdt, amountIn: policy.edge.sizeUsdt, limits: vault.usdt },
  ];

  let best: { tokenIn: Address; amountIn: bigint; out: bigint; limits: TokenLimits; ledger: CostLedger } | null = null;
  for (const side of sides) {
    const quote = market.quotes.find((q) => q.amountIn === side.amountIn && q.tokenIn.toLowerCase() === side.tokenIn.toLowerCase());
    if (!quote) continue;
    const ledger = costLedger(side.tokenIn, side.amountIn, quote.amountOut, market, mark);
    if (!best || ledger.net! > best.ledger.net!) best = { ...side, out: quote.amountOut, ledger };
  }
  if (!best) return hold("requote", "No quote for the edge size at this block.");

  if (best.ledger.net! <= policy.edge.minNetUsdt) {
    return hold("uneconomic", `Best side nets ${best.ledger.net} micro-USDT after fees and gas, not above ${policy.edge.minNetUsdt}.`, best.ledger);
  }
  if (input.edgeTaken) return hold("opportunity-taken", "The edge already traded this gap, and the gap has not closed.", best.ledger);
  const held = ((input.edgeInventoryHsk ?? 0n) * market.spotPriceX18) / E18;
  const afterTrade = best.tokenIn === HSKSWAP.usdt ? held + policy.edge.sizeUsdt : held - policy.edge.sizeUsdt;
  if (abs(afterTrade) > abs(held) && abs(afterTrade) > (policy.edge.maxInventoryUsdt ?? policy.edge.sizeUsdt)) {
    return hold("inventory-limit", `Nothing closes an edge trade on another venue, and this one would hold ${afterTrade} micro-USDT of HSK, over the limit.`, best.ledger);
  }
  if (best.amountIn > best.limits.balance) return hold("no-balance", "The vault does not hold enough for the profitable side.", best.ledger);
  if (best.amountIn > best.limits.maxTrade || best.amountIn > best.limits.remaining) {
    return hold("cap-exhausted", "The profitable side exceeds a vault cap.", best.ledger);
  }
  if (best.amountIn > best.limits.available) return hold("over-budget", "The profitable side exceeds what the hourly budget allows now.", best.ledger);
  const reason = `Edge: conservative net ${best.ledger.net} micro-USDT after fees and gas.`;
  return trade("edge", null, best.tokenIn, best.amountIn, best.out, best.limits, policy, best.ledger, reason);
}

function trade(
  trigger: TradeDecision["trigger"],
  orderId: string | null,
  tokenIn: Address,
  amountIn: bigint,
  quotedOut: bigint,
  limits: TokenLimits,
  policy: Policy,
  ledger: CostLedger,
  reason: string,
  limitOut = 0n,
): Decision {
  if (limits.floorPriceX18 === 0n) return hold("no-limits", "The owner has set no price floor for this token.", ledger);
  const floor = floorOut(amountIn, limits.floorPriceX18);
  if (quotedOut < floor) {
    return hold("below-floor", `Quote ${quotedOut} is below the owner's floor ${floor}; the vault would reject it.`, ledger);
  }
  const withSlippage = (quotedOut * (BPS - BigInt(policy.slippageBps))) / BPS;
  return { action: "trade", trigger, orderId, tokenIn, amountIn, quotedOut, minOut: max(max(withSlippage, floor), limitOut), ledger, reason };
}

function limitProblem(order: Order, limits: TokenLimits, amountIn: bigint): HoldDecision | null {
  if (amountIn > 0n) return null;
  if (limits.remaining === 0n) return hold("cap-exhausted", `Order ${order.id}: the lifetime cap is spent.`);
  if (limits.maxTrade === 0n) return hold("no-limits", `Order ${order.id}: the owner has set no trade cap for this token.`);
  if (limits.balance === 0n) return hold("no-balance", `Order ${order.id}: the vault holds none of the input token.`);
  return hold("over-budget", `Order ${order.id}: the hourly budget has no room yet.`);
}

function edgeSellSize(policy: Policy, market: MarketState): bigint {
  return market.spotPriceX18 === 0n ? 0n : (policy.edge.sizeUsdt * E18) / market.spotPriceX18;
}

function hold(code: HoldCode, reason: string, ledger?: CostLedger): HoldDecision {
  return ledger ? { action: "hold", code, reason, ledger } : { action: "hold", code, reason };
}

function min(first: bigint, ...rest: bigint[]): bigint {
  return rest.reduce((a, b) => (b < a ? b : a), first);
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function abs(a: bigint): bigint {
  return a < 0n ? -a : a;
}
