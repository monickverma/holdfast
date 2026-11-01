import {
  concatHex,
  decodeErrorResult,
  decodeFunctionResult,
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
import { VAULT_ABI, type Head, type MarketState } from "./reader.js";
import { RpcError, type RpcClient } from "./rpc.js";
import type { Trace } from "./trace.js";

/** Well above the measured use of one swap, and cheap: unused gas is not charged. */
export const GAS_LIMIT = 500_000n;
export const INTENT_TTL_SEC = 90n;
/** How long the node may hold a sync send open before the agent falls back to polling for the receipt. */
export const SYNC_SEND_TIMEOUT_MS = 6_000;
/** How long past its deadline an intent can sit with no receipt before the vault is asked whether it ever ran. */
export const EXPIRY_GRACE_SEC = 30n;
/** How often unconfirmed bytes go out again, in case the node dropped them. The same bytes can land only once. */
const RESEND_MS = 10_000;
/** A receipt younger than this many blocks can still be undone, so it keeps being checked. */
export const REORG_WATCH_BLOCKS = 64n;

/** "sync" asks the node to answer with the receipt; "classic" sends and polls. */
export type SendMode = "sync" | "classic";

export interface ExecutorOptions {
  rpc: RpcClient;
  ledger: Ledger;
  agentKey: Hex;
  vault: Address;
  chainId: number;
  sendMode?: SendMode;
  /** Other endpoints that get the same signed bytes at the same moment. Off unless configured. */
  hedges?: RpcClient[];
}

export interface RawReceipt {
  status: Hex;
  blockNumber: Hex;
  blockHash?: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  l1Fee?: Hex;
  logs: Array<{ address: Address; topics: [Hex, ...Hex[]]; data: Hex }>;
}

export class Executor {
  sendMode: SendMode;
  readonly address: Address;
  hedgesSent = 0;
  hedgeFailures = 0;
  private readonly account: PrivateKeyAccount;
  private readonly rpc: RpcClient;
  /** Sends go here, so a read holding the shared connection cannot make a send open a new one. */
  private sendRpc: RpcClient;
  private readonly hedges: RpcClient[];
  private readonly ledger: Ledger;
  private readonly vault: Address;
  private readonly chainId: number;
  private readonly lastSent = new Map<string, number>();

  constructor(options: ExecutorOptions) {
    this.account = privateKeyToAccount(options.agentKey);
    this.address = this.account.address;
    this.rpc = options.rpc;
    this.ledger = options.ledger;
    this.vault = options.vault;
    this.chainId = options.chainId;
    this.sendMode = options.sendMode ?? "classic";
    this.sendRpc = options.rpc;
    this.hedges = options.hedges ?? [];
  }

  useSendLane(rpc: RpcClient): void {
    this.sendRpc = rpc;
  }

  /** Runs the signer over a throwaway transaction, so the first real signature is not also the first ever. Never stored. */
  warmSigner(): Promise<Hex> {
    return this.account.signTransaction({
      type: "eip1559",
      // No chain uses this ID, so these bytes could not land anywhere even if they escaped.
      chainId: 2 ** 40,
      nonce: 0,
      to: this.vault,
      data: "0x",
      value: 0n,
      gas: GAS_LIMIT,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 1n,
    });
  }

  /** The same bytes to every other endpoint. They can land only once, so a failure here changes nothing. */
  private sendHedges(rawTx: Hex): void {
    for (const hedge of this.hedges) {
      this.hedgesSent++;
      void hedge.callOnce("eth_sendRawTransaction", [rawTx]).catch(() => {
        this.hedgeFailures++;
      });
    }
  }

  /**
   * Checks receipts young enough to be undone. A flashblock receipt is a preconfirmation, so one can disappear. An
   * intent whose receipt vanished goes back to "broadcast": the same bytes go out again until its deadline, and then
   * the vault's own record settles it. Returns the intents that changed.
   */
  async reconcile(headNumber: bigint): Promise<Intent[]> {
    const changed: Intent[] = [];
    for (const intent of this.ledger.all()) {
      if ((intent.status !== "included" && intent.status !== "reverted") || intent.finalized || !intent.blockHash) continue;
      const receipt = await this.rpc.call<RawReceipt | null>("eth_getTransactionReceipt", [intent.txHash]);
      const reorgs = (intent.reorgs ?? 0) + 1;
      if (!receipt) {
        changed.push(
          this.ledger.update(intent.key, {
            status: "broadcast",
            reorgs,
            broadcastBlock: headNumber,
            blockNumber: undefined,
            blockHash: undefined,
            amountOut: undefined,
            gasUsed: undefined,
            feeWei: undefined,
            revertReason: undefined,
          }),
        );
      } else if (receipt.blockHash !== intent.blockHash) {
        changed.push(await this.record(this.ledger.update(intent.key, { reorgs }), receipt));
      } else if (headNumber - intent.blockNumber! >= REORG_WATCH_BLOCKS) {
        this.ledger.update(intent.key, { finalized: true });
      }
    }
    return changed;
  }

  /** Reserve, sign, persist, then broadcast. The signed bytes are on disk before they can reach the network. */
  async submit(key: string, decision: TradeDecision, market: MarketState, trace: Trace, pendingNonce?: number): Promise<Intent> {
    const deadline = market.head.timestamp + INTENT_TTL_SEC;
    const intentId = this.ledger.get(key)?.intentId ?? this.ledger.nextIntentId();
    const bodyHash = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
        [decision.tokenIn, decision.amountIn, decision.minOut, intentId],
      ),
    );
    const decisionBody = decisionRecord(decision, market);
    const decisionHash = keccak256(stringToHex(decisionBody));
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
        decisionBody,
        decisionHash,
      }),
    );
    if (existing) return intent;

    const nonce = await trace.span("nonce", () => this.nextNonce(pendingNonce));
    const signed = await trace.span("sign", async () => {
      // The vault ignores bytes after its arguments. These tie the transaction to the decision that made it.
      const data = concatHex([
        encodeFunctionData({
          abi: VAULT_ABI,
          functionName: "execute",
          args: [decision.tokenIn, decision.amountIn, decision.minOut, deadline, intentId],
        }),
        decisionHash,
      ]);
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
    return trace.span("broadcast", () =>
      this.sendMode === "sync" ? this.broadcastSync(signed, market.head.number) : this.broadcast(signed, market.head.number),
    );
  }

  /**
   * Sends the stored bytes and waits for the node to return the receipt. On any failure the same bytes go out the
   * classic way, which is always safe, and the normal receipt polling takes over.
   */
  private async broadcastSync(intent: Intent, headNumber: bigint): Promise<Intent> {
    let receipt: RawReceipt | null = null;
    this.lastSent.set(intent.key, Date.now());
    this.sendHedges(intent.rawTx!);
    try {
      receipt = await this.sendRpc.callOnce<RawReceipt>("eth_sendRawTransactionSync", [intent.rawTx], SYNC_SEND_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      if (error.code === -32601) this.sendMode = "classic";
      return this.broadcast(intent, headNumber);
    }
    const sent = this.ledger.update(intent.key, { status: "broadcast", broadcastBlock: headNumber });
    return receipt ? this.record(sent, receipt) : sent;
  }

  /**
   * Sends the stored signed bytes. Safe to call any number of times, because the same bytes have the same hash and
   * nonce and can land only once. Never signs anything new.
   */
  async broadcast(intent: Intent, headNumber: bigint): Promise<Intent> {
    this.lastSent.set(intent.key, Date.now());
    try {
      await this.sendRpc.callOnce("eth_sendRawTransaction", [intent.rawTx]);
    } catch (error) {
      // A node that already has these bytes, or already mined them, has done what was asked.
      const alreadyKnown = error instanceof RpcError && /already known|known transaction|nonce too low/i.test(error.message);
      if (!alreadyKnown) throw error;
    }
    return this.ledger.update(intent.key, { status: "broadcast", broadcastBlock: headNumber });
  }

  /**
   * Records the outcome if the chain has one, and otherwise keeps the intent moving, because one stuck intent would
   * hold back every later trade, stop-losses included. Returns the updated intent, or null while it is pending.
   */
  async settle(intent: Intent, head?: Head): Promise<Intent | null> {
    const receipt = await this.rpc.call<RawReceipt | null>("eth_getTransactionReceipt", [intent.txHash]);
    if (receipt) return this.record(intent, receipt);
    if (!head) return null;
    if (head.timestamp > intent.deadline + EXPIRY_GRACE_SEC && !(await this.ranOnChain(intent))) {
      return this.ledger.update(intent.key, { status: "expired" });
    }
    const due = Date.now() - (this.lastSent.get(intent.key) ?? 0) >= RESEND_MS;
    if (intent.rawTx && (intent.status === "signed" || due)) await this.broadcast(intent, head.number).catch(() => {});
    return null;
  }

  /** The vault's own record. Past the deadline, an intent it has not marked can never run. */
  private async ranOnChain(intent: Intent): Promise<boolean> {
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: "usedIntent", args: [intent.intentId] });
    const raw = await this.rpc.call<Hex>("eth_call", [{ to: this.vault, data }, "latest"]);
    return decodeFunctionResult({ abi: VAULT_ABI, functionName: "usedIntent", data: raw });
  }

  private async record(intent: Intent, receipt: RawReceipt): Promise<Intent> {
    const blockNumber = BigInt(receipt.blockNumber);
    const gasUsed = BigInt(receipt.gasUsed);
    const feeWei = gasUsed * BigInt(receipt.effectiveGasPrice) + BigInt(receipt.l1Fee ?? 0);
    const blockHash = receipt.blockHash;
    if (receipt.status !== "0x1") {
      const revertReason = await this.revertReason(intent, blockNumber);
      return this.ledger.update(intent.key, { status: "reverted", blockNumber, blockHash, gasUsed, feeWei, revertReason });
    }
    const [traded] = parseEventLogs({ abi: VAULT_ABI, eventName: "Traded", logs: receipt.logs as never });
    return this.ledger.update(intent.key, {
      status: "included",
      blockNumber,
      blockHash,
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
      // A send that fails here is not fatal: settle() sends again until the deadline, and then settles it.
      recovered.push(settled ?? (await this.broadcast(intent, headNumber).catch(() => intent)));
    }
    return recovered;
  }

  /** Whichever is higher: what the chain has seen, or what this agent has already signed. */
  private async nextNonce(pendingNonce?: number): Promise<number> {
    const chain = pendingNonce ?? Number(await this.rpc.call<string>("eth_getTransactionCount", [this.address, "pending"]));
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

/** What a decision was made from. Canonical, so anyone holding it can recompute the hash a transaction carries. */
export function decisionRecord(decision: TradeDecision, market: Pick<MarketState, "head" | "spotPriceX18">): string {
  return JSON.stringify({
    block: market.head.number.toString(),
    blockHash: market.head.hash,
    spotPriceX18: market.spotPriceX18?.toString(),
    trigger: decision.trigger,
    orderId: decision.orderId,
    tokenIn: decision.tokenIn,
    amountIn: decision.amountIn.toString(),
    quotedOut: decision.quotedOut?.toString(),
    minOut: decision.minOut.toString(),
    reason: decision.reason,
  });
}

export interface Simulation {
  /** True if the vault would accept the trade, false if it refuses, null if the node could not say. */
  ok: boolean | null;
  amountOut?: bigint;
  error?: string;
  latencyMs: number;
}

/** Asks the vault, through eth_call, what it would do with this trade from `from`. Signs nothing and sends nothing. */
export async function simulateTrade(rpc: RpcClient, vault: Address, from: Address, decision: Pick<TradeDecision, "tokenIn" | "amountIn" | "minOut">, head: Pick<Head, "timestamp">, block: string = "latest"): Promise<Simulation> {
  const data = encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "execute",
    // A fresh ID, so a used one can never be the reason given.
    args: [decision.tokenIn, decision.amountIn, decision.minOut, head.timestamp + INTENT_TTL_SEC, keccak256(stringToHex(`simulate:${performance.now()}:${Math.random()}`))],
  });
  const started = performance.now();
  try {
    const raw = await rpc.callOnce<Hex>("eth_call", [{ from, to: vault, data }, block]);
    return { ok: true, amountOut: decodeFunctionResult({ abi: VAULT_ABI, functionName: "execute", data: raw }), latencyMs: performance.now() - started };
  } catch (error) {
    const latencyMs = performance.now() - started;
    const name = error instanceof RpcError ? decodeRevert(error) : String(error);
    // A revert carries data or says so. Anything else, such as a timeout, is the node's problem and not the vault's answer.
    const refused = error instanceof RpcError && (error.data !== undefined || /revert/i.test(error.message));
    return { ok: refused ? false : null, error: name, latencyMs };
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
