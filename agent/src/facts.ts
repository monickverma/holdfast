import { formatUnits } from "viem";
import type { Agent } from "./agent.js";
import { serializePolicy, type Policy } from "./policy.js";
import { tradingResult } from "./position.js";

const usdt = (v: bigint) => formatUnits(v, 6);
const hsk = (v: bigint) => formatUnits(v, 18);

/** Everything the model may state, computed here from chain reads and receipts. */
export function buildFacts(agent: Agent, policy: Policy): unknown {
  const market = agent.lastMarket;
  if (!market) return { status: "no chain read yet", policy: serializePolicy(policy) };
  const result = tradingResult(agent.ledger.all(), market.spotPriceX18);
  const vault = market.vault;
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
    vault: vault && {
      paused: vault.paused,
      hsk: { balance: hsk(vault.whsk.balance), maxTrade: hsk(vault.whsk.maxTrade), remainingLifetime: hsk(vault.whsk.remaining), floorUsdtPerHsk: usdt(vault.whsk.floorPriceX18) },
      usdt: { balance: usdt(vault.usdt.balance), maxTrade: usdt(vault.usdt.maxTrade), remainingLifetime: usdt(vault.usdt.remaining) },
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
