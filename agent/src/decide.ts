import type { Address } from "viem";
import { HSKSWAP } from "./config.js";
import { isSell, type Order, type Policy } from "./policy.js";
import type { MarketState, QuoteRequest, TokenLimits, VaultState } from "./reader.js";

const E18 = 10n ** 18n;
const BPS = 10_000n;

/** Rounded up from 174,566 gas measured on one fork swap; replace with the mainnet figure once there are receipts. */
export const GAS_ESTIMATE = 200_000n;

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
}

/** Pure and synchronous. No model and no network: everything it uses was read before it ran. */
export function decide(input: DecideInput): Decision {
  const { market, policy, runtime } = input;
  const vault = market.vault;
  if (!vault) return hold("no-limits", "No vault is configured, so there is nothing the agent may spend.");
  if (vault.paused) return hold("paused", "The vault is paused.");

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
  return min(left, limits.maxTrade, limits.remaining, limits.balance);
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
  switch (order.kind) {
    case "stop-loss": {
      const streak = state?.hitStreak ?? 0;
      if (streak + 1 < policy.stopConfirmBlocks) {
        return hold("stop-unconfirmed", `Stop ${order.id}: condition held ${streak + 1} of ${policy.stopConfirmBlocks} blocks.`, ledger);
      }
      trigger = "stop-loss";
      reason = `Stop ${order.id}: spot ${market.spotPriceX18} at or below ${order.triggerPriceX18} for ${policy.stopConfirmBlocks} blocks.`;
      break;
    }
    case "limit-sell":
    case "limit-buy": {
      const reached = selling ? fillPrice >= order.triggerPriceX18! : fillPrice <= order.triggerPriceX18!;
      if (!reached) return hold("no-signal", `Limit ${order.id}: fill price ${fillPrice} has not reached ${order.triggerPriceX18}.`, ledger);
      const deviation = Math.abs(market.tick - market.twapTick);
      if (deviation > policy.maxTwapDeviationBps) {
        return hold("price-deviation", `Limit ${order.id}: spot is ${deviation} bps from TWAP, over ${policy.maxTwapDeviationBps}.`, ledger);
      }
      trigger = "limit";
      reason = `Limit ${order.id}: fill price ${fillPrice} reached ${order.triggerPriceX18}.`;
      break;
    }
    default:
      trigger = "market";
      reason = `Market order ${order.id}.`;
  }

  return trade(trigger, order.id, tokenIn, amountIn, quote.amountOut, limits, policy, ledger, reason);
}

function decideEdge(input: DecideInput, vault: VaultState): Decision {
  const { market, policy, mark, nowMs, maxMarkAgeMs } = input;
  if (!mark) return hold("stale-mark", "No reference price yet, so the edge cannot be valued.");
  if (nowMs - mark.fetchedAtMs > maxMarkAgeMs) return hold("stale-mark", `Reference price is older than ${maxMarkAgeMs} ms.`);
  const deviation = Math.abs(market.tick - market.twapTick);
  if (deviation > policy.maxTwapDeviationBps) {
    return hold("price-deviation", `Spot is ${deviation} bps from TWAP, over ${policy.maxTwapDeviationBps}.`);
  }

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
  if (best.amountIn > best.limits.balance) return hold("no-balance", "The vault does not hold enough for the profitable side.", best.ledger);
  if (best.amountIn > best.limits.maxTrade || best.amountIn > best.limits.remaining) {
    return hold("cap-exhausted", "The profitable side exceeds a vault cap.", best.ledger);
  }
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
): Decision {
  if (limits.floorPriceX18 === 0n) return hold("no-limits", "The owner has set no price floor for this token.", ledger);
  const floor = floorOut(amountIn, limits.floorPriceX18);
  if (quotedOut < floor) {
    return hold("below-floor", `Quote ${quotedOut} is below the owner's floor ${floor}; the vault would reject it.`, ledger);
  }
  const withSlippage = (quotedOut * (BPS - BigInt(policy.slippageBps))) / BPS;
  return { action: "trade", trigger, orderId, tokenIn, amountIn, quotedOut, minOut: max(withSlippage, floor), ledger, reason };
}

function limitProblem(order: Order, limits: TokenLimits, amountIn: bigint): HoldDecision | null {
  if (amountIn > 0n) return null;
  if (limits.remaining === 0n) return hold("cap-exhausted", `Order ${order.id}: the lifetime cap is spent.`);
  if (limits.maxTrade === 0n) return hold("no-limits", `Order ${order.id}: the owner has set no trade cap for this token.`);
  return hold("no-balance", `Order ${order.id}: the vault holds none of the input token.`);
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
