import { formatUnits } from "viem";
import { isSell, type Order, type Policy } from "./policy.js";
import type { VaultState } from "./reader.js";

const POOL_FEE_BPS = 30n;
const WIDE_SLIPPAGE_BPS = 100;
const BPS = 10_000n;

export interface PolicyReview {
  /** What this policy does, in units a person reads. */
  summary: string[];
  /** Things that can lose money or remove protection. Each needs a deliberate yes. */
  risks: string[];
}

const usdt = (v: bigint) => formatUnits(v, 6);
const hsk = (v: bigint) => formatUnits(v, 18);
const orderAmount = (o: Order) => (isSell(o.kind) ? `${hsk(o.amountIn)} HSK` : `${usdt(o.amountIn)} USDT`);
const duration = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600} h` : sec % 60 === 0 ? `${sec / 60} min` : `${sec} s`);

/**
 * Written by this code and never by the model, so a person approving a model's draft sees what it does and not what
 * the model says it does. parsePolicy decides whether a policy is well formed; this says whether it is a good idea.
 */
export function reviewPolicy(next: Policy, current: Policy, spotPriceX18: bigint, vault?: VaultState): PolicyReview {
  const summary: string[] = [];
  const risks: string[] = [];
  const atSpot = `The market is at ${usdt(spotPriceX18)} USDT per HSK`;

  for (const order of next.orders) {
    const trigger = order.triggerPriceX18;
    const continues = current.orders.some((o) => o.id === order.id) ? ", continuing the current order, so what it already filled still counts" : "";
    summary.push(`${order.kind}: ${orderAmount(order)}${trigger === undefined ? ", now" : ` at ${usdt(trigger)} USDT per HSK`}${continues}`);
    const limits = vault && (isSell(order.kind) ? vault.whsk : vault.usdt);
    if (limits && order.amountIn > limits.balance) risks.push(`${order.kind} for ${orderAmount(order)} is more than the vault holds.`);
    if (order.kind === "stop-loss" && trigger !== undefined) {
      if (trigger >= spotPriceX18) risks.push(`The stop at ${usdt(trigger)} is at or above the market and would sell at once. ${atSpot}.`);
      if (vault) {
        const worstFill = (trigger * (BPS - POOL_FEE_BPS - BigInt(next.slippageBps))) / BPS;
        if (worstFill < vault.whsk.floorPriceX18) risks.push(`The stop at ${usdt(trigger)} can fill at ${usdt(worstFill)}, under the vault's floor of ${usdt(vault.whsk.floorPriceX18)}, so the vault could refuse it when it is needed.`);
      }
    }
    if (order.kind === "limit-sell" && trigger !== undefined && trigger < spotPriceX18) risks.push(`The limit sell at ${usdt(trigger)} is below the market and would fill at once. ${atSpot}.`);
    if (order.kind === "limit-buy" && trigger !== undefined && trigger > spotPriceX18) risks.push(`The limit buy at ${usdt(trigger)} is above the market and would fill at once. ${atSpot}.`);
    if (order.kind === "market-sell" || order.kind === "market-buy") risks.push(`The ${order.kind} for ${orderAmount(order)} trades as soon as you approve.`);
  }

  for (const old of current.orders) {
    if (old.kind !== "stop-loss") continue;
    const kept = next.orders.some((o) => o.kind === "stop-loss" && o.amountIn >= old.amountIn && (o.triggerPriceX18 ?? 0n) >= (old.triggerPriceX18 ?? 0n));
    if (!kept) risks.push(`This removes or weakens your stop-loss for ${orderAmount(old)} at ${usdt(old.triggerPriceX18 ?? 0n)}.`);
  }

  if (next.edge.enabled) {
    summary.push(`edge rule on: ${usdt(next.edge.sizeUsdt)} USDT per trade, net above ${usdt(next.edge.minNetUsdt)}`);
    if (!current.edge.enabled) risks.push("This turns on the edge rule. Nothing closes its trades on another venue, so they leave you holding inventory.");
    else if (next.edge.sizeUsdt > current.edge.sizeUsdt) risks.push(`This raises the edge size from ${usdt(current.edge.sizeUsdt)} to ${usdt(next.edge.sizeUsdt)} USDT.`);
  } else {
    summary.push("edge rule off");
  }

  summary.push(`spends ${next.spendTokens ? next.spendTokens.join(" and ") : "HSK and USDT"} only; the vault trades no other token`);
  const pacing = [
    next.minTradeIntervalSec === undefined ? null : `at least ${duration(next.minTradeIntervalSec)} between trades`,
    next.maxTradesPerDay === undefined ? null : `at most ${next.maxTradesPerDay} trades in any 24 hours`,
  ].filter(Boolean);
  summary.push(pacing.length ? `pacing: ${pacing.join(", ")}. A stop-loss is never held back by this` : "no pacing: the agent may trade whenever an order or the edge rule says so");
  if (current.minTradeIntervalSec !== undefined && (next.minTradeIntervalSec ?? 0) < current.minTradeIntervalSec) risks.push(`This shortens the gap between trades from ${duration(current.minTradeIntervalSec)} to ${next.minTradeIntervalSec === undefined ? "none" : duration(next.minTradeIntervalSec)}.`);
  if (current.maxTradesPerDay !== undefined && (next.maxTradesPerDay ?? Infinity) > current.maxTradesPerDay) risks.push(`This raises the daily trade count from ${current.maxTradesPerDay} to ${next.maxTradesPerDay ?? "no limit"}.`);

  summary.push(`slippage ${next.slippageBps} bps`);
  if (next.slippageBps > WIDE_SLIPPAGE_BPS && next.slippageBps > current.slippageBps) risks.push(`Slippage of ${next.slippageBps} bps invites sandwiching. It was ${current.slippageBps}.`);

  return { summary, risks };
}
