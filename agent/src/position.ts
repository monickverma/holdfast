import { HSKSWAP } from "./config.js";
import type { Intent } from "./ledger.js";
import { sameAddress } from "./reader.js";

const E18 = 10n ** 18n;

export interface TradingResult {
  fills: number;
  reverts: number;
  /** Net token change from fills alone, so deposits and withdrawals do not read as profit. */
  whskDelta: bigint;
  usdtDelta: bigint;
  gasWei: bigint;
  /** Result against simply holding, valued at the given price, in USDT micro-units. Includes gas. */
  pnlUsdt: bigint;
}

/** Computed from receipts in the ledger. The model reports these numbers and never produces them. */
export function tradingResult(intents: readonly Intent[], priceX18: bigint): TradingResult {
  const result: TradingResult = { fills: 0, reverts: 0, whskDelta: 0n, usdtDelta: 0n, gasWei: 0n, pnlUsdt: 0n };
  for (const intent of intents) {
    if (intent.feeWei !== undefined) result.gasWei += intent.feeWei;
    if (intent.status === "reverted") result.reverts++;
    if (intent.status !== "included") continue;
    result.fills++;
    const out = intent.amountOut ?? 0n;
    const spent = intent.amountSpent ?? intent.amountIn;
    if (sameAddress(intent.tokenIn, HSKSWAP.whsk)) {
      result.whskDelta -= spent;
      result.usdtDelta += out;
    } else {
      result.usdtDelta -= spent;
      result.whskDelta += out;
    }
  }
  result.pnlUsdt = result.usdtDelta + ((result.whskDelta - result.gasWei) * priceX18) / E18;
  return result;
}

export interface PositionReport {
  fills: number;
  reverts: number;
  /** HSK the agent has bought and not yet sold, and what those cost on average. */
  inventoryHsk: bigint;
  averageCostX18: bigint | null;
  /** On sales of HSK the agent bought itself, against what it paid. USDT micro-units. */
  realizedUsdt: bigint;
  /** On the inventory, at the given price. USDT micro-units. */
  unrealizedUsdt: bigint;
  /** HSK sold from the vault's opening balance. Its cost is not on chain, so it counts toward neither result. */
  soldWithoutCostBasisHsk: bigint;
  /** What those sales paid. */
  proceedsWithoutCostBasisUsdt: bigint;
  gasWei: bigint;
  basis: string;
}

/** Average-cost accounting from receipts, oldest first. It reports what it cannot know instead of assuming a cost. */
export function positionReport(intents: readonly Intent[], priceX18: bigint): PositionReport {
  const report: PositionReport = {
    fills: 0,
    reverts: 0,
    inventoryHsk: 0n,
    averageCostX18: null,
    realizedUsdt: 0n,
    unrealizedUsdt: 0n,
    soldWithoutCostBasisHsk: 0n,
    proceedsWithoutCostBasisUsdt: 0n,
    gasWei: 0n,
    basis: "Fills from receipts at average cost, valued at the given price. Deposits, withdrawals and gas are not in the results; gas is shown apart.",
  };
  let costUsdt = 0n;
  const settled = intents.filter((i) => i.feeWei !== undefined || i.status === "included").slice().sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)));
  for (const intent of settled) {
    if (intent.feeWei !== undefined) report.gasWei += intent.feeWei;
    if (intent.status === "reverted") report.reverts++;
    if (intent.status !== "included") continue;
    report.fills++;
    const out = intent.amountOut ?? 0n;
    const spent = intent.amountSpent ?? intent.amountIn;
    if (!sameAddress(intent.tokenIn, HSKSWAP.whsk)) {
      report.inventoryHsk += out;
      costUsdt += spent;
      continue;
    }
    const matched = spent < report.inventoryHsk ? spent : report.inventoryHsk;
    if (spent > 0n && matched > 0n) {
      const cost = report.inventoryHsk === matched ? costUsdt : (costUsdt * matched) / report.inventoryHsk;
      const proceeds = (out * matched) / spent;
      report.realizedUsdt += proceeds - cost;
      costUsdt -= cost;
      report.inventoryHsk -= matched;
    }
    const unmatched = spent - matched;
    if (unmatched > 0n) {
      report.soldWithoutCostBasisHsk += unmatched;
      report.proceedsWithoutCostBasisUsdt += (out * unmatched) / spent;
    }
  }
  if (report.inventoryHsk > 0n) {
    report.averageCostX18 = (costUsdt * E18) / report.inventoryHsk;
    report.unrealizedUsdt = (report.inventoryHsk * priceX18) / E18 - costUsdt;
  }
  return report;
}
