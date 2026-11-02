import { formatUnits } from "viem";
import { inventoryOf, type Agent } from "./agent.js";
import { edgeIntents, modelIntents } from "./breaker.js";
import { hourlyLossBound } from "./decide.js";
import { serializePolicy, type Policy } from "./policy.js";
import { positionReport, tradingResult } from "./position.js";
import type { Strategist } from "./strategist.js";

const usdt = (v: bigint) => formatUnits(v, 6);
const hsk = (v: bigint) => formatUnits(v, 18);

/** Everything the model may state, computed here from chain reads and receipts. */
export function buildFacts(agent: Agent, policy: Policy, strategist?: Strategist | null): unknown {
  const market = agent.lastMarket;
  if (!market) return { status: "no chain read yet", policy: serializePolicy(policy) };
  const intents = agent.ledger.all();
  const result = tradingResult(intents, market.spotPriceX18);
  const position = positionReport(intents, market.spotPriceX18);
  const vault = market.vault;
  const inventory = (family: typeof intents) => {
    const held = inventoryOf(family);
    return { hsk: hsk(held.hsk), usdtFlow: usdt(held.usdt), worthNowUsdt: usdt((held.hsk * market.spotPriceX18) / 10n ** 18n) };
  };
  const proposal = strategist?.current();
  const used = strategist?.usage();
  return {
    block: market.head.number.toString(),
    spotUsdtPerHsk: usdt(market.spotPriceX18),
    trading: {
      filledTrades: result.fills,
      revertedTrades: result.reverts,
      netHskFromTrades: hsk(result.whskDelta),
      netUsdtFromTrades: usdt(result.usdtDelta),
      gasPaidHsk: hsk(result.gasWei),
      pnlAgainstHoldingUsdt: usdt(result.pnlUsdt),
      pnlBasis: "Fills only, valued at current spot, including gas. Deposits and withdrawals are excluded.",
    },
    position: {
      boughtHskHeld: hsk(position.inventoryHsk),
      averageCostUsdtPerHsk: position.averageCostX18 === null ? null : usdt(position.averageCostX18),
      realizedUsdt: usdt(position.realizedUsdt),
      unrealizedUsdt: usdt(position.unrealizedUsdt),
      soldFromOpeningBalanceHsk: hsk(position.soldWithoutCostBasisHsk),
      basis: position.basis,
    },
    strategies: {
      edgeRule: { on: policy.edge.enabled, closesInThisPool: policy.edge.unwind === true, inventory: inventory(edgeIntents(intents)) },
      model: {
        on: policy.ai?.enabled === true,
        engineConfigured: Boolean(strategist),
        model: strategist?.model ?? null,
        inventory: inventory(modelIntents(intents)),
        liveProposal: proposal ? { action: proposal.action, block: proposal.block.toString(), reason: proposal.reason } : null,
        callsLast24h: used?.calls ?? 0,
        costUsdLast24h: used ? used.costUsd.toFixed(4) : "0",
      },
    },
    vault: vault && {
      paused: vault.paused,
      agentKeyExpiresAtUnix: vault.agentExpiry?.toString() ?? "never: this vault predates key expiry",
      hsk: { balance: hsk(vault.whsk.balance), maxTrade: hsk(vault.whsk.maxTrade), remainingLifetime: hsk(vault.whsk.remaining), hourlyBudget: hsk(vault.whsk.hourlyBudget), budgetAvailableNow: hsk(vault.whsk.available), floorUsdtPerHsk: usdt(vault.whsk.floorPriceX18) },
      usdt: { balance: usdt(vault.usdt.balance), maxTrade: usdt(vault.usdt.maxTrade), remainingLifetime: usdt(vault.usdt.remaining), hourlyBudget: usdt(vault.usdt.hourlyBudget), budgetAvailableNow: usdt(vault.usdt.available) },
      worstCaseLossPerHourUsdt: usdt(hourlyLossBound(vault, market.spotPriceX18)),
    },
    lastDecision: agent.lastDecision && {
      block: agent.lastDecision.block.toString(),
      action: agent.lastDecision.decision.action,
      reason: agent.lastDecision.decision.reason,
      observeOnly: agent.lastDecision.observeOnly,
    },
    policy: serializePolicy(policy),
    tradingEnabled: agent.canTrade,
  };
}
