// A read-only way in for other programs. It holds no key and sends nothing, so nothing that uses it can move funds.
import { formatUnits, parseUnits, type Address } from "viem";
import { HSKSWAP, type Config } from "./config.js";
import { floorOut, type TradeDecision } from "./decide.js";
import { simulateTrade, type Simulation } from "./executor.js";
import { explainError, type Explanation } from "./explain.js";
import type { Intent } from "./ledger.js";
import { parsePolicy, PolicyError, type Policy } from "./policy.js";
import { readHead, readMarket, VAULT_ABI, type MarketState } from "./reader.js";
import { encodeFunctionData, decodeFunctionResult, type Hex } from "viem";
import { positionReport, type PositionReport } from "./position.js";
import { RpcClient } from "./rpc.js";

export type IntentSide = "sell" | "buy";

/** One trade someone wants to try, in human units. Everything else about it is the vault's to decide. */
export interface TradeIntent {
  side: IntentSide;
  /** Decimal string of the input token: HSK for a sell, USDT for a buy. */
  amount: string;
  /** Decimal string of the least the trade may pay out. Omit to quote the market and apply `slippageBps`. */
  minOut?: string;
  /** Used only without `minOut`. Defaults to 50, and may not be above 500. */
  slippageBps?: number;
}

export class IntentError extends Error {}

const DECIMAL = /^\d{1,30}(\.\d{1,18})?$/;
const FIELDS = new Set(["side", "amount", "minOut", "slippageBps"]);

/** Refuses anything unknown or loosely typed, rather than coercing it. A model's output comes through here too. */
export function parseIntent(input: unknown): TradeIntent {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new IntentError("An intent must be an object.");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!FIELDS.has(key)) throw new IntentError(`Unknown field: ${key}.`);
  if (raw.side !== "sell" && raw.side !== "buy") throw new IntentError('side must be "sell" or "buy".');
  if (typeof raw.amount !== "string" || !DECIMAL.test(raw.amount) || /^0*(\.0*)?$/.test(raw.amount)) throw new IntentError("amount must be a positive decimal string.");
  const intent: TradeIntent = { side: raw.side, amount: raw.amount };
  if (raw.minOut !== undefined) {
    if (typeof raw.minOut !== "string" || !DECIMAL.test(raw.minOut)) throw new IntentError("minOut must be a decimal string.");
    intent.minOut = raw.minOut;
  }
  if (raw.slippageBps !== undefined) {
    if (typeof raw.slippageBps !== "number" || !Number.isInteger(raw.slippageBps) || raw.slippageBps < 0 || raw.slippageBps > 500) throw new IntentError("slippageBps must be a whole number from 0 to 500.");
    intent.slippageBps = raw.slippageBps;
  }
  return intent;
}

export function validatePolicy(input: unknown): { ok: true; policy: Policy } | { ok: false; error: string } {
  try {
    return { ok: true, policy: parsePolicy(input) };
  } catch (error) {
    if (error instanceof PolicyError) return { ok: false, error: error.message };
    throw error;
  }
}

export interface SimulationReport extends Simulation {
  explanation?: Explanation;
  tokenIn: Address;
  amountIn: string;
  minOut: string;
  /** What the vault would pay, in the output token. */
  amountOutReadable?: string;
  block: string;
  simulatedOnly: true;
}

export class HoldfastClient {
  private readonly rpc: RpcClient;

  constructor(private readonly config: Pick<Config, "rpcUrl" | "vault" | "twapWindowSec" | "legacyVault" | "guardedVault"> & { agentAddress?: Address }) {
    this.rpc = new RpcClient(config.rpcUrl);
  }

  close(): void {
    this.rpc.close();
  }

  async market(): Promise<MarketState> {
    return readMarket(this.rpc, this.config, await readHead(this.rpc), []);
  }

  /** Vault state as a plain object, with amounts as decimal strings. */
  async status(): Promise<unknown> {
    const market = await this.market();
    const vault = market.vault;
    const side = (limits: NonNullable<typeof vault>["whsk"], decimals: number) => ({
      balance: formatUnits(limits.balance, decimals),
      maxTrade: formatUnits(limits.maxTrade, decimals),
      remainingLifetime: formatUnits(limits.remaining, decimals),
      hourlyBudget: formatUnits(limits.hourlyBudget, decimals),
      availableNow: formatUnits(limits.available, decimals),
      ...(limits.dailyBudget ? { dailyBudget: formatUnits(limits.dailyBudget, decimals), dailyAvailable: formatUnits(limits.dailyAvailable!, decimals) } : {}),
    });
    return {
      block: market.head.number.toString(),
      spotUsdtPerHsk: formatUnits(market.spotPriceX18, 6),
      tick: market.tick,
      vault: vault && {
        address: this.config.vault,
        paused: vault.paused,
        agentExpiresAtUnix: vault.agentExpiry?.toString() ?? null,
        priceGuard: vault.guard ?? null,
        hsk: side(vault.whsk, 18),
        usdt: side(vault.usdt, 6),
      },
    };
  }

  /** Asks the vault what it would do with this trade, as its agent. Nothing is signed or sent. */
  async simulate(input: unknown): Promise<SimulationReport> {
    const intent = parseIntent(input);
    if (!this.config.vault) throw new IntentError("No vault is configured.");
    const selling = intent.side === "sell";
    const tokenIn = selling ? HSKSWAP.whsk : HSKSWAP.usdt;
    const amountIn = parseUnits(intent.amount, selling ? 18 : 6);
    const head = await readHead(this.rpc);
    const market = await readMarket(this.rpc, this.config, head, [{ tokenIn, amountIn }]);
    const quoted = market.quotes[0]!.amountOut;
    const minOut = intent.minOut !== undefined ? parseUnits(intent.minOut, selling ? 6 : 18) : (quoted * BigInt(10_000 - (intent.slippageBps ?? 50))) / 10_000n;
    const decision: Pick<TradeDecision, "tokenIn" | "amountIn" | "minOut"> = { tokenIn, amountIn, minOut };
    const from = this.config.agentAddress ?? (await this.agentAddress());
    const result = await simulateTrade(this.rpc, this.config.vault, from, decision, head);
    return {
      ...result,
      ...(result.error ? { explanation: explainError(result.error) } : {}),
      tokenIn,
      amountIn: amountIn.toString(),
      minOut: minOut.toString(),
      ...(result.amountOut !== undefined ? { amountOutReadable: formatUnits(result.amountOut, selling ? 6 : 18) } : {}),
      block: head.number.toString(),
      simulatedOnly: true,
    };
  }

  private async agentAddress(): Promise<Address> {
    const raw = await this.rpc.call<Hex>("eth_call", [{ to: this.config.vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "agent" }) }, "latest"]);
    return decodeFunctionResult({ abi: VAULT_ABI, functionName: "agent", data: raw });
  }

  /** From the agent's own ledger, valued at the current price. */
  async position(intents: readonly Intent[]): Promise<PositionReport> {
    return positionReport(intents, (await this.market()).spotPriceX18);
  }
}

export { explainError, floorOut };
