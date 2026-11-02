export type OrderKind = "stop-loss" | "limit-sell" | "limit-buy" | "market-sell" | "market-buy";

export interface Order {
  id: string;
  kind: OrderKind;
  /** Input amount in base units: WHSK wei for sells, USDT micro-units for buys. */
  amountIn: bigint;
  /** USDT micro-units per 1 HSK. Absent only on market orders. */
  triggerPriceX18?: bigint;
}

export interface EdgeRule {
  enabled: boolean;
  /** Input per trade in USDT micro-units, converted to WHSK at spot for sells. */
  sizeUsdt: bigint;
  /** Required conservative net result after fees and gas, in USDT micro-units. */
  minNetUsdt: bigint;
  /** The most HSK the rule may hold or owe, valued in USDT micro-units. Absent means one trade's worth. */
  maxInventoryUsdt?: bigint;
}

export interface Policy {
  version: number;
  orders: Order[];
  edge: EdgeRule;
  slippageBps: number;
  maxTwapDeviationBps: number;
  stopConfirmBlocks: number;
  /** Most a market order may pay against spot, fee included. Absent means DEFAULT_MAX_IMPACT_BPS. Stops ignore it. */
  maxImpactBps?: number;
  /** Least time between two trades the agent sends, in chain seconds. Absent means no spacing. Stops ignore it. */
  minTradeIntervalSec?: number;
  /** Most trades the agent sends in any 24 hours of chain time. Absent means no count. Stops ignore it. */
  maxTradesPerDay?: number;
  /** Which of the pool's two tokens the agent may spend. Absent means both. The vault trades no other token. */
  spendTokens?: SpendToken[];
}

export type SpendToken = "HSK" | "USDT";

export const DEFAULT_POLICY: Policy = {
  version: 1,
  orders: [],
  edge: { enabled: false, sizeUsdt: 1_000_000n, minNetUsdt: 0n },
  slippageBps: 50,
  maxTwapDeviationBps: 200,
  stopConfirmBlocks: 2,
};

const SELL_KINDS: ReadonlySet<OrderKind> = new Set(["stop-loss", "limit-sell", "market-sell"]);
const TRIGGERED_KINDS: ReadonlySet<OrderKind> = new Set(["stop-loss", "limit-sell", "limit-buy"]);
const ALL_KINDS: ReadonlySet<string> = new Set(["stop-loss", "limit-sell", "limit-buy", "market-sell", "market-buy"]);

export function isSell(kind: OrderKind): boolean {
  return SELL_KINDS.has(kind);
}

/** Whether this policy lets the agent spend the token: HSK for a sell, USDT for a buy. */
export function maySpend(policy: Pick<Policy, "spendTokens">, sell: boolean): boolean {
  return !policy.spendTokens || policy.spendTokens.includes(sell ? "HSK" : "USDT");
}

export class PolicyError extends Error {}

/**
 * The only way model output or a stored file becomes a Policy. Anything unknown, loosely typed or out of range is
 * rejected rather than coerced. Amounts arrive as decimal strings of base units so no float ever touches them.
 */
export function parsePolicy(input: unknown): Policy {
  const root = record(input, "policy");
  allowKeys(root, ["version", "orders", "edge", "slippageBps", "maxTwapDeviationBps", "stopConfirmBlocks", "maxImpactBps", "minTradeIntervalSec", "maxTradesPerDay", "spendTokens"], "policy");
  const orders = root.orders;
  if (!Array.isArray(orders) || orders.length > 16) throw new PolicyError("orders must be a list of at most 16");
  const parsed = orders.map(parseOrder);
  if (new Set(parsed.map((o) => o.id)).size !== parsed.length) throw new PolicyError("order ids must be unique");

  const edge = record(root.edge, "edge");
  allowKeys(edge, ["enabled", "sizeUsdt", "minNetUsdt", "maxInventoryUsdt"], "edge");
  if (typeof edge.enabled !== "boolean") throw new PolicyError("edge.enabled must be true or false");

  const spendTokens = root.spendTokens === undefined ? undefined : tokens(root.spendTokens);
  // Refused here rather than held later, so the person approving sees the conflict before it is active.
  parsed.forEach((order, i) => {
    if (spendTokens && !maySpend({ spendTokens }, isSell(order.kind))) {
      throw new PolicyError(`orders[${i}] spends ${isSell(order.kind) ? "HSK" : "USDT"}, which spendTokens does not allow`);
    }
  });

  return {
    version: int(root.version, "version", 1, 1_000_000),
    orders: parsed,
    edge: {
      enabled: edge.enabled,
      sizeUsdt: amount(edge.sizeUsdt, "edge.sizeUsdt", true),
      minNetUsdt: amount(edge.minNetUsdt, "edge.minNetUsdt", false),
      ...(edge.maxInventoryUsdt === undefined ? {} : { maxInventoryUsdt: amount(edge.maxInventoryUsdt, "edge.maxInventoryUsdt", false) }),
    },
    slippageBps: int(root.slippageBps, "slippageBps", 0, 500),
    maxTwapDeviationBps: int(root.maxTwapDeviationBps, "maxTwapDeviationBps", 1, 2_000),
    stopConfirmBlocks: int(root.stopConfirmBlocks, "stopConfirmBlocks", 1, 30),
    ...(root.maxImpactBps === undefined ? {} : { maxImpactBps: int(root.maxImpactBps, "maxImpactBps", 1, 5_000) }),
    ...(root.minTradeIntervalSec === undefined ? {} : { minTradeIntervalSec: int(root.minTradeIntervalSec, "minTradeIntervalSec", 1, 7 * 86_400) }),
    ...(root.maxTradesPerDay === undefined ? {} : { maxTradesPerDay: int(root.maxTradesPerDay, "maxTradesPerDay", 1, 10_000) }),
    ...(spendTokens === undefined ? {} : { spendTokens }),
  };
}

function tokens(value: unknown): SpendToken[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2 || value.some((t) => t !== "HSK" && t !== "USDT") || new Set(value).size !== value.length) {
    throw new PolicyError("spendTokens must list HSK, USDT or both, once each");
  }
  return value as SpendToken[];
}

export function serializePolicy(policy: Policy): unknown {
  return JSON.parse(JSON.stringify(policy, (_key, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function parseOrder(input: unknown, index: number): Order {
  const name = `orders[${index}]`;
  const order = record(input, name);
  allowKeys(order, ["id", "kind", "amountIn", "triggerPriceX18"], name);
  if (typeof order.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(order.id)) {
    throw new PolicyError(`${name}.id must be 1 to 40 of a-z, 0-9 and hyphen`);
  }
  if (typeof order.kind !== "string" || !ALL_KINDS.has(order.kind)) throw new PolicyError(`${name}.kind is not valid`);
  const kind = order.kind as OrderKind;
  const parsed: Order = { id: order.id, kind, amountIn: amount(order.amountIn, `${name}.amountIn`, true) };
  if (TRIGGERED_KINDS.has(kind)) {
    parsed.triggerPriceX18 = amount(order.triggerPriceX18, `${name}.triggerPriceX18`, true);
  } else if (order.triggerPriceX18 !== undefined) {
    throw new PolicyError(`${name} is a market order and takes no trigger`);
  }
  return parsed;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PolicyError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function allowKeys(value: Record<string, unknown>, keys: string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new PolicyError(`${name} has unknown field ${key}`);
  }
}

function amount(value: unknown, name: string, positive: boolean): bigint {
  if (typeof value !== "string" || !/^\d{1,40}$/.test(value)) throw new PolicyError(`${name} must be a decimal string of base units`);
  const parsed = BigInt(value);
  if (positive && parsed === 0n) throw new PolicyError(`${name} must be above zero`);
  return parsed;
}

function int(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new PolicyError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}
