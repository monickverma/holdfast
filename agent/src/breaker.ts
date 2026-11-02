import type { TradeDecision } from "./decide.js";
import type { Intent } from "./ledger.js";
import { tradingResult } from "./position.js";

export interface BreakerLimits {
  /** Edge trades allowed per hour. Orders have a fixed size, so only the edge rule can repeat without end. */
  maxEdgeTradesPerHour: number;
  /** Failed trades in a row before everything but a stop-loss waits for the owner. */
  maxConsecutiveFailures: number;
  /** Loss on edge trades at the current price, in USDT micro-units, before the edge rule waits for the owner. */
  maxEdgeLossUsdt: bigint;
}

export const BREAKER_DEFAULTS: BreakerLimits = { maxEdgeTradesPerHour: 6, maxConsecutiveFailures: 3, maxEdgeLossUsdt: 5_000_000n };

const BLOCKS_PER_HOUR = 1_800n;
const MAX_STOP_BACKOFF_POWER = 6;

export const isEdgeKey = (key: string): boolean => key.startsWith("edge:");
export const edgeIntents = (intents: readonly Intent[]): Intent[] => intents.filter((i) => isEdgeKey(i.key));
/** Trades a model proposed. Their own family, so the model's inventory and losses are counted apart from the rules'. */
export const isModelKey = (key: string): boolean => key.startsWith("ai:");
export const modelIntents = (intents: readonly Intent[]): Intent[] => intents.filter((i) => isModelKey(i.key));

/**
 * Why this trade must not go out, or null. Works from the ledger alone, so it survives a restart. A stop-loss is never
 * latched off, since it is what protects the position, but a stop that keeps failing retries less and less often.
 */
export function breakerVerdict(decision: TradeDecision, intents: readonly Intent[], headNumber: bigint, spotPriceX18: bigint, limits: BreakerLimits): string | null {
  const failures = trailingFailures(intents);
  if (decision.trigger === "stop-loss") {
    if (failures.length === 0) return null;
    const newest = failures[0]!;
    const retryAt = (newest.blockNumber ?? newest.broadcastBlock ?? 0n) + 2n ** BigInt(Math.min(failures.length - 1, MAX_STOP_BACKOFF_POWER));
    return headNumber < retryAt ? `Stop retry waits until block ${retryAt} after ${failures.length} failed in a row.` : null;
  }
  if (failures.length >= limits.maxConsecutiveFailures) return `Breaker: ${failures.length} trades failed in a row. The owner must reset it.`;
  // Closing the edge rule's inventory is not latched by its losses, since it only fires when the round trip pays.
  if (decision.trigger !== "edge" && decision.trigger !== "model") return null;

  // A model's trades are held to the same count and the same loss as the edge rule's, counted on their own.
  const family = decision.trigger === "model" ? "model" : "edge";
  const own = family === "model" ? modelIntents(intents) : edgeIntents(intents);
  const recent = own.filter((i) => i.broadcastBlock !== undefined && i.broadcastBlock + BLOCKS_PER_HOUR > headNumber).length;
  if (recent >= limits.maxEdgeTradesPerHour) return `Breaker: ${recent} ${family} trades in the last hour, at the limit of ${limits.maxEdgeTradesPerHour}.`;
  const { pnlUsdt } = tradingResult(own, spotPriceX18);
  if (pnlUsdt < -limits.maxEdgeLossUsdt) return `Breaker: ${family} trades are down ${-pnlUsdt} micro-USDT at the current price. The owner must reset it.`;
  return null;
}

/** The unbroken run of failures ending at the newest settled trade, newest first. */
function trailingFailures(intents: readonly Intent[]): Intent[] {
  const run: Intent[] = [];
  for (let i = intents.length - 1; i >= 0; i--) {
    const { status } = intents[i]!;
    if (status === "included") break;
    if (status === "reverted" || status === "expired") run.push(intents[i]!);
  }
  return run;
}
