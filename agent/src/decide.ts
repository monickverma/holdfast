import type { Address } from "viem";
import { HSKSWAP } from "./config.js";
import { breakEvenOut, DEFAULT_MAX_IMPACT_BPS, impactBps, markIsSane } from "./economics.js";
import { isSell, maySpend, type AiRule, type Order, type Policy } from "./policy.js";
import { sameAddress, tickAtSqrtPrice, type MarketState, type Quote, type QuoteRequest, type TokenLimits, type VaultState } from "./reader.js";

const E18 = 10n ** 18n;
const BPS = 10_000n;

/** Above every median measured on a fork: 133,197 to 154,878 for version 3 (evidence/v3/gas-compare.json). A sealed-block preflight replaces it with eth_estimateGas. */
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

/**
 * Net token change from one strategy's own fills. Positive hsk is HSK it holds, and usdt is then what that cost, as a
 * negative number. Negative hsk is HSK it sold and owes back, and usdt what the sale raised.
 */
export interface Inventory {
  hsk: bigint;
  usdt: bigint;
}

export const NO_INVENTORY: Inventory = { hsk: 0n, usdt: 0n };

/**
 * What a language model proposed, already turned into base units by code. It carries no authority: decide() treats it
 * as one more reason to trade and puts it through the same gates as everything else.
 */
export interface ModelProposal {
  id: string;
  /** The sealed block the model's snapshot was read at. */
  block: bigint;
  action: "buy" | "sell" | "hold";
  /** USDT micro-units for a buy, WHSK wei for a sell, zero for a hold. */
  amountIn: bigint;
  reason: string;
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
  | "strategy-not-pinned"
  | "stale-mark"
  | "bad-mark"
  | "price-impact"
  | "price-deviation"
  | "no-balance"
  | "cap-exhausted"
  | "no-limits"
  | "below-floor"
  | "uneconomic"
  | "stop-unconfirmed"
  | "requote"
  | "price-band"
  | "oracle-unavailable"
  | "preflight-refused"
  | "preflight-unverified"
  | "preflight-uneconomic"
  | "no-gas"
  | "too-soon"
  | "trade-count"
  | "model-hold"
  | "proposal-stale"
  | "proposal-refused";

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
  /** "unwind" closes the edge rule's own inventory in this pool. "model" is a model's proposal that passed every gate. */
  trigger: "stop-loss" | "limit" | "market" | "edge" | "unwind" | "model";
  orderId: string | null;
  /** The model proposal this trade carries out, so it is used once. */
  proposalId?: string;
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
  /** Net WHSK wei the edge rule has bought and not sold. Ignored when edgeInventory is given. */
  edgeInventoryHsk?: bigint;
  /** The edge rule's own fills, netted, which its unwind closes in this pool. */
  edgeInventory?: Inventory;
  /** The live model proposal, if any. Only read when the policy's ai rule is on. */
  proposal?: ModelProposal | null;
  /** The model's own fills, netted. */
  aiInventory?: Inventory;
  /** Block times, in seconds, of the trades the agent has sent. The policy's pacing counts these. */
  tradeTimes?: readonly number[];
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
  // A block from the future means this clock is wrong, and then the age above says nothing.
  if (ageMs < -input.maxStateAgeMs) return hold("stale-state", `Block ${market.head.number} is ${-ageMs} ms ahead of this clock, so its age cannot be judged.`);
  if (vault.guard && !vault.guard.oracleOk) return hold("oracle-unavailable", "The pool's price oracle did not answer, so the vault would refuse every trade. The owner can still withdraw.");

  // Stop-losses come first: protecting the position outranks every other reason to act. For the same reason, the
  // policy's pacing never holds a stop back.
  const paced = pacingProblem(input);
  const first: Decision[] = [];
  for (const order of policy.orders) {
    const decision = decideOrder(order, input, runtime.get(order.id));
    if (decision.action === "trade" && (decision.trigger === "stop-loss" || !paced)) return decision;
    first.push(decision.action === "trade" ? hold(paced!.code, `Order ${order.id}: ${paced!.reason}`, decision.ledger) : decision);
  }

  if (policy.ai?.enabled) {
    const proposed = decideProposal(input, vault, policy.ai);
    if (proposed.action === "trade" && !paced) return proposed;
    first.push(proposed.action === "trade" ? hold(paced!.code, `Model: ${paced!.reason}`, proposed.ledger) : proposed);
  }

  if (policy.edge.enabled) {
    const edge = decideEdge(input, vault);
    if (edge.action === "trade" && !paced) return edge;
    first.push(edge.action === "trade" ? hold(paced!.code, `Edge: ${paced!.reason}`, edge.ledger) : edge);
  }

  // Report the most informative refusal rather than a generic one.
  return first.find((d) => d.action === "hold" && d.code !== "no-signal") ?? first[0] ?? hold("no-signal", "No active order, and the edge rule and the model are off.");
}

/** The policy's own limits on how often the agent trades, measured in chain time. The vault may have a stricter one. */
function pacingProblem(input: DecideInput): { code: HoldCode; reason: string } | null {
  const { policy } = input;
  const now = Number(input.market.head.timestamp);
  const times = input.tradeTimes ?? [];
  if (policy.minTradeIntervalSec !== undefined && times.length > 0) {
    const since = now - Math.max(...times);
    if (since < policy.minTradeIntervalSec) return { code: "too-soon", reason: `the last trade was ${since} s ago, and the policy spaces trades ${policy.minTradeIntervalSec} s apart.` };
  }
  if (policy.maxTradesPerDay !== undefined) {
    const today = times.filter((t) => now - t < 86_400).length;
    if (today >= policy.maxTradesPerDay) return { code: "trade-count", reason: `${today} trades in the last 24 hours, and the policy allows ${policy.maxTradesPerDay}.` };
  }
  return null;
}

export interface QuoteContext {
  edgeInventory?: Inventory;
  aiInventory?: Inventory;
  proposal?: ModelProposal | null;
}

/**
 * What the model is shown each time it is asked: each side at its largest allowed size, and what closing its inventory
 * would do. Quoted with every read while the model is on, so its snapshot never needs a read of its own.
 */
export function modelProbes(policy: Policy, market: MarketState, aiInventory: Inventory = NO_INVENTORY): { buy: QuoteRequest | null; sell: QuoteRequest | null; close: QuoteRequest | null } {
  const size = policy.ai?.maxSizeUsdt ?? 0n;
  const sell = market.spotPriceX18 === 0n ? 0n : (size * E18) / market.spotPriceX18;
  return {
    buy: size > 0n && maySpend(policy, false) ? { tokenIn: HSKSWAP.usdt, amountIn: size } : null,
    sell: sell > 0n && maySpend(policy, true) ? { tokenIn: HSKSWAP.whsk, amountIn: sell } : null,
    close: unwindRequest(aiInventory, market),
  };
}

/** The inputs the next decision needs quoted. Sizes use the last known limits, and decide() rejects a mismatch. */
export function plannedQuotes(policy: Policy, market: MarketState | null, runtime: ReadonlyMap<string, OrderRuntime>, context: QuoteContext = {}): QuoteRequest[] {
  const requests: QuoteRequest[] = [];
  for (const order of policy.orders) {
    const amountIn = trancheSize(order, runtime.get(order.id), market?.vault);
    if (amountIn > 0n) requests.push({ tokenIn: orderToken(order), amountIn });
  }
  if (policy.edge.enabled && market) {
    const sell = edgeSellSize(policy, market);
    if (sell > 0n && maySpend(policy, true)) requests.push({ tokenIn: HSKSWAP.whsk, amountIn: sell });
    if (maySpend(policy, false)) requests.push({ tokenIn: HSKSWAP.usdt, amountIn: policy.edge.sizeUsdt });
    const unwind = policy.edge.unwind && context.edgeInventory ? unwindRequest(context.edgeInventory, market) : null;
    if (unwind) requests.push(unwind);
  }
  const proposal = context.proposal;
  if (policy.ai?.enabled && market) {
    const probes = modelProbes(policy, market, context.aiInventory);
    for (const probe of [probes.buy, probes.sell, probes.close]) if (probe) requests.push(probe);
  }
  if (policy.ai?.enabled && proposal && proposal.action !== "hold" && proposal.amountIn > 0n) {
    requests.push({ tokenIn: proposal.action === "sell" ? HSKSWAP.whsk : HSKSWAP.usdt, amountIn: proposal.amountIn });
  }
  return requests;
}

/**
 * The trade that closes an inventory in this pool, sized to what the vault allows now. A short is bought back with 1%
 * less USDT than spot implies, so the pool's fee cannot make it overshoot into a long. That leaves a little owed.
 */
export function unwindRequest(inventory: Inventory, market: MarketState): QuoteRequest | null {
  if (inventory.hsk === 0n || market.spotPriceX18 === 0n) return null;
  const selling = inventory.hsk > 0n;
  const wanted = selling ? inventory.hsk : (-inventory.hsk * market.spotPriceX18 * 9_900n) / E18 / BPS;
  const limits = market.vault && (selling ? market.vault.whsk : market.vault.usdt);
  const amountIn = limits ? min(wanted, limits.maxTrade, limits.remaining, limits.balance, budgetNow(limits), dailyNow(limits)) : wanted;
  return amountIn > 0n ? { tokenIn: selling ? HSKSWAP.whsk : HSKSWAP.usdt, amountIn } : null;
}

/**
 * What closing part of an inventory in this pool realizes against what that part cost, after this leg's network cost,
 * in USDT micro-units. Null if the trade would not shrink the inventory without crossing to the other side.
 */
export function roundTrip(inventory: Inventory, tokenIn: Address, amountIn: bigint, amountOut: bigint, networkCost: bigint): bigint | null {
  if (sameAddress(tokenIn, HSKSWAP.whsk)) {
    if (inventory.hsk <= 0n || amountIn > inventory.hsk) return null;
    return amountOut + floorDiv(inventory.usdt * amountIn, inventory.hsk) - networkCost;
  }
  if (inventory.hsk >= 0n || amountOut > -inventory.hsk) return null;
  return floorDiv(inventory.usdt * amountOut, -inventory.hsk) - amountIn - networkCost;
}

/** The least output at which roundTrip() is at least `realized`, so the slippage allowance cannot undo the gate. */
export function roundTripMinOut(inventory: Inventory, selling: boolean, amountIn: bigint, networkCost: bigint, realized: bigint): bigint {
  if (selling) return max(realized + networkCost - floorDiv(inventory.usdt * amountIn, inventory.hsk), 0n);
  if (inventory.usdt <= 0n) return 2n ** 255n;
  return max(ceilDiv((realized + amountIn + networkCost) * -inventory.hsk, inventory.usdt), 0n);
}

export function orderToken(order: Order): Address {
  return isSell(order.kind) ? HSKSWAP.whsk : HSKSWAP.usdt;
}

export function trancheSize(order: Order, state: OrderRuntime | undefined, vault: VaultState | undefined): bigint {
  const left = order.amountIn - (state?.filled ?? 0n);
  if (left <= 0n) return 0n;
  if (!vault) return left;
  const limits = isSell(order.kind) ? vault.whsk : vault.usdt;
  return min(left, limits.maxTrade, limits.remaining, limits.balance, budgetNow(limits), dailyNow(limits));
}

function budgetNow(limits: TokenLimits): bigint {
  return onGrid(limits.available, limits.hourlyBudget);
}

/** The daily cap on the same kind of grid, for the same reason. With no cap, no limit at all. */
function dailyNow(limits: TokenLimits): bigint {
  if (!limits.dailyBudget || limits.dailyAvailable === undefined) return limits.balance;
  return onGrid(limits.dailyAvailable, limits.dailyBudget);
}

function onGrid(available: bigint, budget: bigint): bigint {
  const step = budget / BUDGET_STEPS;
  if (step === 0n || available === budget) return available;
  return (available / step) * step;
}

/** The vault's price guard, asked ahead of time from the quote's post-swap price, so a refusal costs no gas. */
function bandProblem(id: string, tokenIn: Address, quote: Quote, vault: VaultState, ledger: CostLedger): HoldDecision | null {
  if (!vault.guard || quote.sqrtPriceAfter === undefined) return null;
  const gap = tickAtSqrtPrice(quote.sqrtPriceAfter) - vault.guard.twapTick;
  const selling = tokenIn.toLowerCase() === HSKSWAP.whsk.toLowerCase();
  if (selling ? gap >= -vault.guard.bandTicks : gap <= vault.guard.bandTicks) return null;
  return hold("price-band", `${id}: this trade would leave the pool ${Math.abs(gap)} ticks from its TWAP, past the vault's band of ${vault.guard.bandTicks}.`, ledger);
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
export function networkCostUsdt(market: MarketState, gas: bigint = GAS_ESTIMATE): bigint {
  const wei = gas * (market.head.baseFeePerGas + market.priorityFeePerGas) + market.l1FeeWei;
  return (wei * market.spotPriceX18 + E18 - 1n) / E18;
}

/**
 * Values a trade against the outside reference, on the side least favourable to it: HSK given up is worth the ask,
 * HSK received is worth the bid. USDT is taken at face value.
 */
export function costLedger(tokenIn: Address, amountIn: bigint, amountOut: bigint, market: MarketState, mark: Mark | null, gas: bigint = GAS_ESTIMATE): CostLedger {
  const networkCost = networkCostUsdt(market, gas);
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
      if (mark && markIsSane(mark) && input.nowMs - mark.fetchedAtMs <= input.maxMarkAgeMs && streak < STOP_DISPUTE_MAX_BLOCKS) {
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
      const impact = impactBps(selling, amountIn, quote.amountOut, market.spotPriceX18);
      const maxImpact = BigInt(policy.maxImpactBps ?? DEFAULT_MAX_IMPACT_BPS);
      if (impact > maxImpact) return hold("price-impact", `Market order ${order.id}: this size pays ${impact} bps against spot, over ${maxImpact}.`, ledger);
      trigger = "market";
      reason = `Market order ${order.id}.`;
    }
  }

  const outOfBand = bandProblem(`Order ${order.id}`, tokenIn, quote, vault, ledger);
  if (outOfBand) return outOfBand;
  const decision = trade(trigger, order.id, tokenIn, amountIn, quote.amountOut, limits, policy, ledger, reason, limitOut);
  if (order.kind === "stop-loss" && decision.action === "hold" && decision.code === "below-floor") {
    return hold("stop-blocked", `Stop ${order.id} cannot sell: the price is under the owner's floor, so the vault would refuse. Only the owner can act now, by lowering the floor or withdrawing.`, ledger);
  }
  return decision;
}

function decideEdge(input: DecideInput, vault: VaultState): Decision {
  const { market, policy, mark, nowMs, maxMarkAgeMs } = input;
  const inventory = input.edgeInventory ?? { hsk: input.edgeInventoryHsk ?? 0n, usdt: 0n };
  // Closing in this pool is judged on this pool's prices and the inventory's own cost, so it needs no outside price.
  const unwind = policy.edge.unwind && input.edgeInventory ? decideUnwind(input, vault, input.edgeInventory) : null;
  if (unwind?.action === "trade") return unwind;
  if (!mark) return hold("stale-mark", "No reference price yet, so the edge cannot be valued.");
  if (nowMs - mark.fetchedAtMs > maxMarkAgeMs) return hold("stale-mark", `Reference price is older than ${maxMarkAgeMs} ms.`);
  if (!markIsSane(mark)) return hold("bad-mark", `Reference price is not usable: bid ${mark.bidX18}, ask ${mark.askX18}.`);
  const deviation = Math.abs(market.tick - market.twapTick);
  if (deviation > policy.maxTwapDeviationBps) {
    return hold("price-deviation", `Spot is ${deviation} bps from TWAP, over ${policy.maxTwapDeviationBps}.`);
  }
  // All of an edge's value comes from the outside price, so an outside price that disagrees with the pool is not an edge.
  const gap = markGapBps(market, mark);
  if (gap > MAX_MARK_GAP_BPS) return hold("mark-disagrees", `Reference price is ${gap.toFixed(0)} bps from the pool's TWAP, over ${MAX_MARK_GAP_BPS}.`);

  const sides: Array<{ tokenIn: Address; amountIn: bigint; limits: TokenLimits }> = [
    ...(maySpend(policy, true) ? [{ tokenIn: HSKSWAP.whsk, amountIn: edgeSellSize(policy, market), limits: vault.whsk }] : []),
    ...(maySpend(policy, false) ? [{ tokenIn: HSKSWAP.usdt, amountIn: policy.edge.sizeUsdt, limits: vault.usdt }] : []),
  ];

  let best: { tokenIn: Address; amountIn: bigint; out: bigint; limits: TokenLimits; ledger: CostLedger; quote: Quote } | null = null;
  for (const side of sides) {
    const quote = market.quotes.find((q) => q.amountIn === side.amountIn && q.tokenIn.toLowerCase() === side.tokenIn.toLowerCase());
    if (!quote) continue;
    const ledger = costLedger(side.tokenIn, side.amountIn, quote.amountOut, market, mark);
    if (!best || ledger.net! > best.ledger.net!) best = { ...side, out: quote.amountOut, ledger, quote };
  }
  if (!best) return hold("requote", "No quote for the edge size at this block.");

  if (best.ledger.net! <= policy.edge.minNetUsdt) {
    return hold("uneconomic", `Best side nets ${best.ledger.net} micro-USDT after fees and gas, not above ${policy.edge.minNetUsdt}.`, best.ledger);
  }
  if (input.edgeTaken) return hold("opportunity-taken", "The edge already traded this gap, and the gap has not closed.", best.ledger);
  const held = (inventory.hsk * market.spotPriceX18) / E18;
  const afterTrade = best.tokenIn === HSKSWAP.usdt ? held + policy.edge.sizeUsdt : held - policy.edge.sizeUsdt;
  if (abs(afterTrade) > abs(held) && abs(afterTrade) > (policy.edge.maxInventoryUsdt ?? policy.edge.sizeUsdt)) {
    const closing = policy.edge.unwind ? `It waits to close in this pool: ${unwind?.reason ?? "no closing quote yet."}` : "Nothing closes an edge trade on another venue.";
    return hold("inventory-limit", `This one would hold ${afterTrade} micro-USDT of HSK, over the limit. ${closing}`, best.ledger);
  }
  if (best.amountIn > best.limits.balance) return hold("no-balance", "The vault does not hold enough for the profitable side.", best.ledger);
  if (best.amountIn > best.limits.maxTrade || best.amountIn > best.limits.remaining) {
    return hold("cap-exhausted", "The profitable side exceeds a vault cap.", best.ledger);
  }
  if (best.amountIn > best.limits.available) return hold("over-budget", "The profitable side exceeds what the hourly budget allows now.", best.ledger);
  if (best.limits.dailyBudget && best.amountIn > dailyNow(best.limits)) return hold("over-budget", "The profitable side exceeds what the daily budget allows now.", best.ledger);
  const outOfBand = bandProblem("Edge", best.tokenIn, best.quote, vault, best.ledger);
  if (outOfBand) return outOfBand;
  const reason = `Edge: conservative net ${best.ledger.net} micro-USDT after fees and gas.`;
  // The slippage allowance must not spend the edge: the worst fill this transaction accepts still clears the required net.
  const breakEven = breakEvenOut(best.tokenIn !== HSKSWAP.usdt, best.ledger.inputValue!, best.ledger.networkCost, policy.edge.minNetUsdt, mark.bidX18);
  return trade("edge", null, best.tokenIn, best.amountIn, best.out, best.limits, policy, best.ledger, reason, breakEven);
}

/** The edge rule's closing leg: sell what it bought, or buy back what it sold, once the round trip nets above its minimum. */
function decideUnwind(input: DecideInput, vault: VaultState, inventory: Inventory): Decision {
  const { market, policy } = input;
  const request = unwindRequest(inventory, market);
  if (!request) return hold("no-signal", "The edge rule holds nothing to close.");
  const selling = sameAddress(request.tokenIn, HSKSWAP.whsk);
  if (!maySpend(policy, selling)) return hold("no-signal", `Closing needs the agent to spend ${selling ? "HSK" : "USDT"}, which the policy does not allow.`);
  const quote = findQuote(market, request.tokenIn, request.amountIn);
  if (!quote) return hold("requote", "Closing size changed, so its quote will come next block.");
  const deviation = Math.abs(market.tick - market.twapTick);
  if (deviation > policy.maxTwapDeviationBps) return hold("price-deviation", `Closing: spot is ${deviation} bps from TWAP, over ${policy.maxTwapDeviationBps}.`);
  const networkCost = networkCostUsdt(market);
  const realized = roundTrip(inventory, request.tokenIn, request.amountIn, quote.amountOut, networkCost);
  const ledger = costLedger(request.tokenIn, request.amountIn, quote.amountOut, market, input.mark);
  if (realized === null) return hold("no-signal", "The closing quote would cross to the other side, so it was not used.", ledger);
  if (realized <= policy.edge.minNetUsdt) return hold("uneconomic", `Closing in this pool now would realize ${realized} micro-USDT after fees and gas, not above ${policy.edge.minNetUsdt}.`, ledger);
  const limits = selling ? vault.whsk : vault.usdt;
  const outOfBand = bandProblem("Closing", request.tokenIn, quote, vault, ledger);
  if (outOfBand) return outOfBand;
  const reason = `Closing the edge rule's inventory in this pool realizes ${realized} micro-USDT after fees and gas.`;
  const minOut = roundTripMinOut(inventory, selling, request.amountIn, networkCost, policy.edge.minNetUsdt + 1n);
  return trade("unwind", null, request.tokenIn, request.amountIn, quote.amountOut, limits, policy, ledger, reason, minOut);
}

/**
 * A model's proposal, judged by the same arithmetic as the rules. A trade that closes the model's own inventory is held
 * to its round trip in this pool. One that opens or adds must beat the outside price after fees and gas, like the
 * edge rule, and stay inside the inventory limit. Nothing here trusts what the model said about prices.
 */
function decideProposal(input: DecideInput, vault: VaultState, ai: AiRule): Decision {
  const { market, policy, mark, proposal } = input;
  if (!proposal) return hold("no-signal", "No model proposal is live.");
  const age = market.head.number - proposal.block;
  if (age < 0n || age > BigInt(ai.proposalTtlBlocks)) {
    return hold("proposal-stale", `Model proposal ${proposal.id} was made at block ${proposal.block}, ${age} blocks from this one; it lives ${ai.proposalTtlBlocks}.`);
  }
  if (proposal.action === "hold") return hold("model-hold", `Model: ${proposal.reason}`);
  const id = `Model proposal ${proposal.id}`;
  const selling = proposal.action === "sell";
  if (!maySpend(policy, selling)) return hold("proposal-refused", `${id}: the policy does not let the agent spend ${selling ? "HSK" : "USDT"}.`);
  const value = selling ? (proposal.amountIn * market.spotPriceX18) / E18 : proposal.amountIn;
  // A sell was sized in HSK at the snapshot's price, so a small move since then is allowed for.
  if (proposal.amountIn <= 0n || value > ai.maxSizeUsdt + ai.maxSizeUsdt / 50n) {
    return hold("proposal-refused", `${id} spends ${value} micro-USDT, over the policy's ${ai.maxSizeUsdt} per model trade.`);
  }
  const deviation = Math.abs(market.tick - market.twapTick);
  if (deviation > policy.maxTwapDeviationBps) return hold("price-deviation", `${id}: spot is ${deviation} bps from TWAP, over ${policy.maxTwapDeviationBps}.`);
  const tokenIn = selling ? HSKSWAP.whsk : HSKSWAP.usdt;
  const limits = selling ? vault.whsk : vault.usdt;
  const quote = findQuote(market, tokenIn, proposal.amountIn);
  if (!quote) return hold("requote", `${id}: its quote will come next block.`);
  const impact = impactBps(selling, proposal.amountIn, quote.amountOut, market.spotPriceX18);
  const maxImpact = BigInt(policy.maxImpactBps ?? DEFAULT_MAX_IMPACT_BPS);
  if (impact > maxImpact) return hold("price-impact", `${id} pays ${impact} bps against spot, over ${maxImpact}.`);

  const inventory = input.aiInventory ?? NO_INVENTORY;
  const networkCost = networkCostUsdt(market);
  const ledger = costLedger(tokenIn, proposal.amountIn, quote.amountOut, market, mark);
  const realized = roundTrip(inventory, tokenIn, proposal.amountIn, quote.amountOut, networkCost);
  let limitOut: bigint;
  let reason: string;
  if (realized !== null) {
    if (realized < -ai.maxUnwindLossUsdt) return hold("uneconomic", `${id} closes inventory at ${realized} micro-USDT, a larger loss than the policy's ${ai.maxUnwindLossUsdt}.`, ledger);
    limitOut = roundTripMinOut(inventory, selling, proposal.amountIn, networkCost, -ai.maxUnwindLossUsdt);
    reason = `${id} closes inventory in this pool for ${realized} micro-USDT after fees and gas. Model: ${proposal.reason}`;
  } else {
    if (!mark) return hold("stale-mark", `${id} adds inventory, and there is no outside price to value it against.`, ledger);
    if (input.nowMs - mark.fetchedAtMs > input.maxMarkAgeMs) return hold("stale-mark", `${id}: the outside price is older than ${input.maxMarkAgeMs} ms.`, ledger);
    if (!markIsSane(mark)) return hold("bad-mark", `${id}: the outside price is not usable: bid ${mark.bidX18}, ask ${mark.askX18}.`, ledger);
    const gap = markGapBps(market, mark);
    if (gap > MAX_MARK_GAP_BPS) return hold("mark-disagrees", `${id}: the outside price is ${gap.toFixed(0)} bps from the pool's TWAP, over ${MAX_MARK_GAP_BPS}.`, ledger);
    if (ledger.net! <= ai.minEdgeUsdt) return hold("uneconomic", `${id} nets ${ledger.net} micro-USDT against the outside price after fees and gas, not above ${ai.minEdgeUsdt}.`, ledger);
    const held = (inventory.hsk * market.spotPriceX18) / E18;
    const after = selling ? held - value : held + value;
    if (abs(after) > abs(held) && abs(after) > ai.maxInventoryUsdt) {
      return hold("inventory-limit", `${id} would leave the model holding ${after} micro-USDT of HSK, over the policy's ${ai.maxInventoryUsdt}.`, ledger);
    }
    limitOut = breakEvenOut(selling, ledger.inputValue!, networkCost, ai.minEdgeUsdt, mark.bidX18);
    reason = `${id} nets ${ledger.net} micro-USDT against the outside price after fees and gas. Model: ${proposal.reason}`;
  }
  if (proposal.amountIn > limits.balance) return hold("no-balance", `${id}: the vault does not hold enough.`, ledger);
  if (proposal.amountIn > limits.maxTrade || proposal.amountIn > limits.remaining) return hold("cap-exhausted", `${id} exceeds a vault cap.`, ledger);
  if (proposal.amountIn > limits.available) return hold("over-budget", `${id} exceeds what the hourly budget allows now.`, ledger);
  if (limits.dailyBudget && proposal.amountIn > dailyNow(limits)) return hold("over-budget", `${id} exceeds what the daily budget allows now.`, ledger);
  const outOfBand = bandProblem(id, tokenIn, quote, vault, ledger);
  if (outOfBand) return outOfBand;
  const decision = trade("model", null, tokenIn, proposal.amountIn, quote.amountOut, limits, policy, ledger, reason, limitOut);
  return decision.action === "trade" ? { ...decision, proposalId: proposal.id } : decision;
}

function findQuote(market: MarketState, tokenIn: Address, amountIn: bigint): Quote | undefined {
  return market.quotes.find((q) => q.amountIn === amountIn && sameAddress(q.tokenIn, tokenIn));
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
  if (limits.dailyBudget && dailyNow(limits) === 0n) return hold("over-budget", `Order ${order.id}: the daily budget has no room yet.`);
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

/** Rounds toward minus infinity, so a cost that is a negative number never rounds in the trade's favour. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b);
}
