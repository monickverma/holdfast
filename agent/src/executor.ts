import {
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { TradeDecision } from "./decide.js";
import type { Intent, Ledger } from "./ledger.js";
import { VAULT_ABI, type MarketState } from "./reader.js";
import { RpcError, type RpcClient } from "./rpc.js";
import type { Trace } from "./trace.js";

/** Well above the measured use of one swap, and cheap: unused gas is not charged. */
export const GAS_LIMIT = 500_000n;
export const INTENT_TTL_SEC = 90n;

export interface ExecutorOptions {
  rpc: RpcClient;
  ledger: Ledger;
  agentKey: Hex;
  vault: Address;
  chainId: number;
}

export interface RawReceipt {
  status: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  l1Fee?: Hex;
  logs: Array<{ address: Address; topics: [Hex, ...Hex[]]; data: Hex }>;
}

export class Executor {
  readonly address: Address;
  private readonly account: PrivateKeyAccount;
  private readonly rpc: RpcClient;
  private readonly ledger: Ledger;
  private readonly vault: Address;
  private readonly chainId: number;

  constructor(options: ExecutorOptions) {
    this.account = privateKeyToAccount(options.agentKey);
    this.address = this.account.address;
    this.rpc = options.rpc;
    this.ledger = options.ledger;
    this.vault = options.vault;
    this.chainId = options.chainId;
  }

  /** Reserve, sign, persist, then broadcast. The signed bytes are on disk before they can reach the network. */
  async submit(key: string, decision: TradeDecision, market: MarketState, trace: Trace): Promise<Intent> {
    const deadline = market.head.timestamp + INTENT_TTL_SEC;
    const intentId = keccak256(stringToHex(key));
    const bodyHash = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
        [decision.tokenIn, decision.amountIn, decision.minOut, intentId],
      ),
    );
    const { intent, existing } = await trace.span("reserve", () =>
      this.ledger.reserve({
        key,
        intentId,
        bodyHash,
        orderId: decision.orderId,
        tokenIn: decision.tokenIn,
        amountIn: decision.amountIn,
        minOut: decision.minOut,
        deadline,
      }),
    );
    if (existing) return intent;

    const nonce = await trace.span("nonce", () => this.nextNonce());
    const signed = await trace.span("sign", async () => {
      const data = encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "execute",
        args: [decision.tokenIn, decision.amountIn, decision.minOut, deadline, intentId],
      });
      const rawTx = await this.account.signTransaction({
        type: "eip1559",
        chainId: this.chainId,
        nonce,
        to: this.vault,
        data,
        value: 0n,
        gas: GAS_LIMIT,
        maxPriorityFeePerGas: market.priorityFeePerGas,
        maxFeePerGas: market.head.baseFeePerGas * 2n + market.priorityFeePerGas,
      });
      return this.ledger.update(key, { status: "signed", nonce, rawTx, txHash: keccak256(rawTx) });
    });
    return trace.span("broadcast", () => this.broadcast(signed, market.head.number));
  }

  /**
   * Sends the stored signed bytes. Safe to call any number of times, because the same bytes have the same hash and
   * nonce and can land only once. Never signs anything new.
   */
  async broadcast(intent: Intent, headNumber: bigint): Promise<Intent> {
    try {
      await this.rpc.callOnce("eth_sendRawTransaction", [intent.rawTx]);
    } catch (error) {
      // A node that already has these bytes, or already mined them, has done what was asked.
      const alreadyKnown = error instanceof RpcError && /already known|known transaction|nonce too low/i.test(error.message);
      if (!alreadyKnown) throw error;
    }
    return this.ledger.update(intent.key, { status: "broadcast", broadcastBlock: headNumber });
  }

  /** Records the outcome if the chain has one. Returns the updated intent, or null while it is pending. */
  async settle(intent: Intent): Promise<Intent | null> {
    const receipt = await this.rpc.call<RawReceipt | null>("eth_getTransactionReceipt", [intent.txHash]);
    if (!receipt) return null;
    const blockNumber = BigInt(receipt.blockNumber);
    const gasUsed = BigInt(receipt.gasUsed);
    const feeWei = gasUsed * BigInt(receipt.effectiveGasPrice) + BigInt(receipt.l1Fee ?? 0);
    if (receipt.status !== "0x1") {
      const revertReason = await this.revertReason(intent, blockNumber);
      return this.ledger.update(intent.key, { status: "reverted", blockNumber, gasUsed, feeWei, revertReason });
    }
    const [traded] = parseEventLogs({ abi: VAULT_ABI, eventName: "Traded", logs: receipt.logs as never });
    return this.ledger.update(intent.key, {
      status: "included",
      blockNumber,
      gasUsed,
      feeWei,
      amountOut: (traded?.args as { amountOut?: bigint } | undefined)?.amountOut ?? 0n,
    });
  }

  /** After a crash: find out what happened to anything in flight, and resend the identical bytes if the chain lost it. */
  async recover(headNumber: bigint): Promise<Intent[]> {
    const recovered: Intent[] = [];
    for (const intent of this.ledger.all()) {
      if (intent.status !== "signed" && intent.status !== "broadcast") continue;
      const settled = await this.settle(intent);
      recovered.push(settled ?? (await this.broadcast(intent, headNumber)));
    }
    return recovered;
  }

  /** Whichever is higher: what the chain has seen, or what this agent has already signed. */
  private async nextNonce(): Promise<number> {
    const chain = Number(await this.rpc.call<string>("eth_getTransactionCount", [this.address, "pending"]));
    const last = this.ledger.lastNonce();
    return last === null ? chain : Math.max(chain, last + 1);
  }

  private async revertReason(intent: Intent, blockNumber: bigint): Promise<string> {
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "execute",
      args: [intent.tokenIn, intent.amountIn, intent.minOut, intent.deadline, intent.intentId],
    });
    try {
      await this.rpc.callOnce("eth_call", [{ from: this.address, to: this.vault, data }, `0x${(blockNumber - 1n).toString(16)}`]);
      return "unknown: the call succeeds when replayed";
    } catch (error) {
      if (error instanceof RpcError) return decodeRevert(error);
      return error instanceof Error ? error.message : "unknown";
    }
  }
}

/** Names the vault's custom error from the node's revert data, or falls back to the node's message. */
export function decodeRevert(error: RpcError): string {
  const data = error.data ?? /0x[0-9a-fA-F]{8,}/.exec(error.message)?.[0];
  if (!data) return error.message;
  try {
    return decodeErrorResult({ abi: VAULT_ABI, data: data as Hex }).errorName;
  } catch {
    return error.message;
  }
}
