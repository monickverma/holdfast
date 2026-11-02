// The checks a trade passes just before it is signed. "authoritative" means a real contract or node answered.
// "analytical" means our own arithmetic on values read earlier. Arithmetic can add a refusal but can never overturn one.
import { encodeFunctionData, keccak256, stringToHex, type Address, type Hex } from "viem";
import { costLedger, type HoldDecision, type Mark, type TradeDecision } from "./decide.js";
import { GAS_LIMIT, INTENT_TTL_SEC, simulateTrade, type Simulation } from "./executor.js";
import type { Policy } from "./policy.js";
import { VAULT_ABI, type Head, type MarketState } from "./reader.js";
import type { RpcClient } from "./rpc.js";

export interface PreflightCheck {
  name: "vault-call" | "min-output" | "gas-estimate" | "gas-limit" | "gas-balance" | "economics";
  source: "authoritative" | "analytical";
  /** Null means nobody could say. */
  ok: boolean | null;
  detail?: string;
}

/** The vault's answer, plus what the node says the trade would cost and what the sender holds. */
export interface Preflight extends Simulation {
  gasEstimate?: bigint;
  balanceWei?: bigint;
  checks?: PreflightCheck[];
}

/** The most a node will demand up front for a trade, in wei: the signed gas limit at the signed fee cap, plus the L1 fee. */
export function maxTradeCostWei(market: Pick<MarketState, "head" | "priorityFeePerGas" | "l1FeeWei">): bigint {
  return GAS_LIMIT * maxFeePerGas(market) + market.l1FeeWei;
}

export function maxFeePerGas(market: Pick<MarketState, "head" | "priorityFeePerGas">): bigint {
  return market.head.baseFeePerGas * 2n + market.priorityFeePerGas;
}

/** Asks the vault and the node. Signs nothing and sends nothing. A failed question leaves its answer undefined. */
export async function preflightTrade(rpc: RpcClient, vault: Address, from: Address, decision: Pick<TradeDecision, "tokenIn" | "amountIn" | "minOut">, head: Pick<Head, "timestamp">): Promise<Preflight> {
  const data: Hex = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "execute",
    args: [decision.tokenIn, decision.amountIn, decision.minOut, head.timestamp + INTENT_TTL_SEC, keccak256(stringToHex(`estimate:${performance.now()}:${Math.random()}`))],
  });
  const [simulation, gas, balance] = await Promise.all([
    simulateTrade(rpc, vault, from, decision, head),
    rpc.callOnce<string>("eth_estimateGas", [{ from, to: vault, data }]).catch(() => undefined),
    rpc.callOnce<string>("eth_getBalance", [from, "latest"]).catch(() => undefined),
  ]);
  return {
    ...simulation,
    ...(gas === undefined ? {} : { gasEstimate: BigInt(gas) }),
    ...(balance === undefined ? {} : { balanceWei: BigInt(balance) }),
  };
}

export interface PreflightVerdict {
  /** Null means the trade may go out. */
  hold: HoldDecision | null;
  checks: PreflightCheck[];
}

/**
 * Fails closed. Anything not positively verified holds the trade, with one exception: a stop-loss goes out when the
 * node could not answer, because the vault enforces every limit anyway and a stop that waits for a healthy node is
 * not a stop. A definite refusal holds a stop as well, since sending it would only burn gas.
 */
export function judgePreflight(decision: TradeDecision, answer: Preflight, market: MarketState, mark: Mark | null, policy: Policy): PreflightVerdict {
  const checks: PreflightCheck[] = [];
  const isStop = decision.trigger === "stop-loss";
  const hold = (code: HoldDecision["code"], reason: string): PreflightVerdict => ({ hold: { action: "hold", code, reason, ledger: decision.ledger }, checks });
  const unverified = (what: string): PreflightVerdict => (isStop ? { hold: null, checks } : hold("preflight-unverified", `${what}, so the trade was not sent.`));

  checks.push({ name: "vault-call", source: "authoritative", ok: answer.ok, ...(answer.error ? { detail: answer.error } : {}) });
  if (answer.ok === false) return hold("preflight-refused", `The vault would refuse this trade: ${answer.error}.`);
  if (answer.ok === null) return unverified(`The node could not say whether the vault accepts this trade (${answer.error})`);

  const enough = answer.amountOut !== undefined && answer.amountOut >= decision.minOut;
  checks.push({ name: "min-output", source: "authoritative", ok: enough, detail: `${answer.amountOut} against a minimum of ${decision.minOut}` });
  if (!enough) return hold("preflight-refused", `The vault's answer of ${answer.amountOut} is under the trade's minimum of ${decision.minOut}.`);

  checks.push({ name: "gas-estimate", source: "authoritative", ok: answer.gasEstimate !== undefined, ...(answer.gasEstimate === undefined ? {} : { detail: answer.gasEstimate.toString() }) });
  if (answer.gasEstimate === undefined) return unverified("The node gave no gas estimate");
  const fits = answer.gasEstimate <= GAS_LIMIT;
  checks.push({ name: "gas-limit", source: "analytical", ok: fits, detail: `${answer.gasEstimate} against ${GAS_LIMIT}` });
  if (!fits) return hold("preflight-refused", `The node estimates ${answer.gasEstimate} gas, over the ${GAS_LIMIT} this agent signs for.`);

  const need = maxTradeCostWei(market);
  checks.push({ name: "gas-balance", source: "analytical", ok: answer.balanceWei === undefined ? null : answer.balanceWei >= need, detail: `${answer.balanceWei} wei held, ${need} needed up front` });
  if (answer.balanceWei === undefined) return unverified("The node did not report the agent's gas balance");
  if (answer.balanceWei < need) return hold("no-gas", `The agent holds ${answer.balanceWei} wei of gas, and a node needs ${need} up front to accept the trade.`);

  if (decision.trigger === "edge" && mark) {
    const actual = costLedger(decision.tokenIn, decision.amountIn, answer.amountOut!, market, mark, answer.gasEstimate);
    const pays = actual.net! > policy.edge.minNetUsdt;
    checks.push({ name: "economics", source: "analytical", ok: pays, detail: `net ${actual.net} micro-USDT at the vault's output and the node's gas` });
    if (!pays) return hold("preflight-uneconomic", `At the vault's own output and the node's gas estimate this nets ${actual.net} micro-USDT, not above ${policy.edge.minNetUsdt}.`);
  }
  return { hold: null, checks };
}
