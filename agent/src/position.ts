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
    if (sameAddress(intent.tokenIn, HSKSWAP.whsk)) {
      result.whskDelta -= intent.amountIn;
      result.usdtDelta += out;
    } else {
      result.usdtDelta -= intent.amountIn;
      result.whskDelta += out;
    }
  }
  result.pnlUsdt = result.usdtDelta + ((result.whskDelta - result.gasWei) * priceX18) / E18;
  return result;
}
