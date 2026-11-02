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
import type { Mark, TradeDecision } from "./decide.js";
import type { Intent, Ledger } from "./ledger.js";
import { VAULT_ABI, type Head, type MarketState } from "./reader.js";
import { RpcError, type RpcClient } from "./rpc.js";
import type { Trace } from "./trace.js";

/** Well above the measured use of one swap, and cheap: unused gas is not charged. */
export const GAS_LIMIT = 500_000n;
export const INTENT_TTL_SEC = 90n;
/** An edge is priced off an outside mark no older than 5 s, so a trade still waiting after this is trading on old news. Not tuned on data. */
export const EDGE_TTL_SEC = 15n;
/** How long the node may hold a sync send open before the agent falls back to polling for the receipt. */
export const SYNC_SEND_TIMEOUT_MS = 6_000;
/** How long past its deadline an intent can sit with no receipt before the vault is asked whether it ever ran. */
export const EXPIRY_GRACE_SEC = 30n;
/** How often unconfirmed bytes go out again, in case the node dropped them. The same bytes can land only once. */
const RESEND_MS = 10_000;
/** A receipt younger than this many blocks can still be undone, so it keeps being checked. */
export const REORG_WATCH_BLOCKS = 64n;

/** More than anchorLog uses. Unused gas is not charged. */
const ANCHOR_GAS_LIMIT = 120_000n;
/** Separates a decision hash from any other hash over the same bytes. Version 3 records and later use it. */
export const DECISION_DOMAIN = "holdfast.decision.v3\n";

/** "sync" asks the node to answer with the receipt; "classic" sends and polls. */
export type SendMode = "sync" | "classic";
export class SubmissionBusy extends Error {}
export class StaleDecision extends Error {}
const submissionOwners = new Set<string>();

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
  /** An anchor not yet seen on chain. Its bytes go out again ahead of any later nonce, so a dropped one cannot stall a trade behind it. */
  private pendingAnchor: { rawTx: Hex; nonce: number; txHash: Hex } | null = null;

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

  private get signerKey(): string { return `${this.chainId}:${this.address.toLowerCase()}`; }
  get busy(): boolean { return submissionOwners.has(this.signerKey); }

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
            amountSpent: undefined,
            outcomeUnverified: undefined,
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
  async submit(key: string, decision: TradeDecision, market: MarketState, trace: Trace, pendingNonce?: number, isCurrent: () => boolean = () => true, context?: DecisionContext): Promise<Intent> {
    if (this.busy) throw new SubmissionBusy("signer already has a submission owner");
    submissionOwners.add(this.signerKey);
    try {
      return await this.submitOwned(key, decision, market, trace, pendingNonce, isCurrent, context);
    } finally {
      submissionOwners.delete(this.signerKey);
    }
  }

  private async submitOwned(key: string, decision: TradeDecision, market: MarketState, trace: Trace, pendingNonce: number | undefined, isCurrent: () => boolean, context?: DecisionContext): Promise<Intent> {
    if (!isCurrent()) throw new StaleDecision("decision changed while preparing submission");
    // A model trade and an unwind are priced like an edge, on what the pool and the mark say now, so they expire as fast.
    const deadline = market.head.timestamp + (["edge", "unwind", "model"].includes(decision.trigger) ? EDGE_TTL_SEC : INTENT_TTL_SEC);
    const intentId = this.ledger.get(key)?.intentId ?? this.ledger.nextIntentId();
    const bodyHash = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
        [decision.tokenIn, decision.amountIn, decision.minOut, intentId],
      ),
    );
    const decisionBody = decisionRecord(decision, market, context && { ...context, chainId: this.chainId, vault: this.vault, expiresAt: deadline, prevDecisionHash: this.lastDecisionHash(), intentId, agent: this.address });
    const decisionHash = decisionHashOf(decisionBody);
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

    const check = () => {
      if (isCurrent()) return;
      this.ledger.update(key, { status: "cancelled" });
      throw new StaleDecision("decision changed while preparing submission");
    };
    check();
    const nonce = await trace.span("nonce", () => this.nextNonce(pendingNonce));
    check();
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
      check();
      return this.ledger.update(key, { status: "signed", nonce, rawTx, txHash: keccak256(rawTx) });
    });
    check();
    return trace.span("broadcast", () =>
      this.sendMode === "sync" ? this.broadcastSync(signed, market.head.number) : this.broadcast(signed, market.head.number),
    );
  }

  /**
   * Commits the local log's head to the vault's own log, so decisions that led to no trade can be checked later too. Holds
   * the submission lock only to sign and send, never for the receipt, because a stop must not wait on this.
   */
  async anchor(localHead: Hex, localSeq: number, market: Pick<MarketState, "head" | "priorityFeePerGas">): Promise<Hex> {
    if (this.busy) throw new SubmissionBusy("signer already has a submission owner");
    submissionOwners.add(this.signerKey);
    try {
      const nonce = await this.nextNonce();
      const rawTx = await this.account.signTransaction({
        type: "eip1559",
        chainId: this.chainId,
        nonce,
        to: this.vault,
        data: encodeFunctionData({ abi: VAULT_ABI, functionName: "anchorLog", args: [localHead, BigInt(localSeq)] }),
        value: 0n,
        gas: ANCHOR_GAS_LIMIT,
        maxPriorityFeePerGas: market.priorityFeePerGas,
        maxFeePerGas: market.head.baseFeePerGas * 2n + market.priorityFeePerGas,
      });
      const txHash = keccak256(rawTx);
      this.pendingAnchor = { rawTx, nonce, txHash };
      await this.sendRpc.callOnce("eth_sendRawTransaction", [rawTx]);
      return txHash;
    } finally {
      submissionOwners.delete(this.signerKey);
    }
  }

  /** True once the anchor sent last has landed, or there is none. */
  async anchorSettled(): Promise<boolean> {
    if (!this.pendingAnchor) return true;
    const receipt = await this.rpc.call<RawReceipt | null>("eth_getTransactionReceipt", [this.pendingAnchor.txHash]);
    if (receipt) this.pendingAnchor = null;
    return receipt !== null;
  }

  /** The newest decision that was signed, so each trade on chain names the one before it. Cancelled ones were never sent. */
  private lastDecisionHash(): Hex | null {
    let last: Hex | null = null;
    for (const intent of this.ledger.all()) if (intent.decisionHash && intent.rawTx && intent.status !== "cancelled") last = intent.decisionHash;
    return last;
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
    // Only the vault's own event for this intent counts. A token or router in the same transaction could emit one that looks alike.
    const traded = parseEventLogs({ abi: VAULT_ABI, eventName: "Traded", logs: receipt.logs.filter((log) => log.address.toLowerCase() === this.vault.toLowerCase()) as never })
      .map((log) => log.args as { intentId: Hex; amountIn: bigint; amountOut: bigint })
      .find((args) => args.intentId === intent.intentId);
    return this.ledger.update(intent.key, {
      status: "included",
      blockNumber,
      blockHash,
      gasUsed,
      feeWei,
      amountOut: traded?.amountOut ?? 0n,
      ...(traded ? { amountSpent: traded.amountIn, outcomeUnverified: undefined } : { outcomeUnverified: true }),
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
    const anchor = this.pendingAnchor;
    if (anchor) void this.sendRpc.callOnce("eth_sendRawTransaction", [anchor.rawTx]).catch(() => {});
    return Math.max(chain, last === null ? 0 : last + 1, anchor ? anchor.nonce + 1 : 0);
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

export interface DecisionContext {
  policyVersion: number;
  mark: Mark | null;
  decidedAtMs: number;
  /** Head of the local decision log when this was decided, so the trade commits to everything logged before it. */
  logHead: Hex;
  /** Null when this trade was not asked about first: a frame's trade is racing the next flashblock. */
  preflight: Simulation & { gasEstimate?: bigint } | null;
  chainId?: number;
  vault?: Address;
  expiresAt?: bigint;
  prevDecisionHash?: Hex | null;
  intentId?: Hex;
  agent?: Address;
  /** Length of the local decision log, so a verifier knows which of its records logHead names. */
  logSeq?: number;
  /** Hash of the policy this ran, which the owner can pin on the vault. */
  strategyHash?: Hex;
  /** The pool this read. A verifier can read it again at the same block. */
  marketSource?: Address;
  readMode?: string;
}

/** One spelling for one value: keys sorted, no spaces, nothing undefined. The verifier refuses any other spelling. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => [key, sortKeys(record[key])]));
}

/** The hash a transaction carries. Records from before version 3 hashed their bytes with no domain, and stay checkable. */
export function decisionHashOf(body: string): Hex {
  let version: unknown;
  try {
    version = (JSON.parse(body) as { v?: unknown }).v;
  } catch {
    version = undefined;
  }
  return keccak256(stringToHex(typeof version === "number" && version >= 3 ? `${DECISION_DOMAIN}${body}` : body));
}

/** What a decision was made from. Canonical, so anyone holding it can recompute the hash a transaction carries. */
export function decisionRecord(decision: TradeDecision, market: Pick<MarketState, "head" | "spotPriceX18"> & Partial<MarketState>, context?: DecisionContext & Required<Pick<DecisionContext, "chainId" | "vault" | "expiresAt" | "prevDecisionHash" | "intentId" | "agent">>): string {
  const body = {
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
  };
  if (!context) return JSON.stringify(body);
  return canonicalJson({
    ...body,
    v: 3,
    intentId: context.intentId,
    agent: context.agent,
    logSeq: context.logSeq ?? null,
    strategyHash: context.strategyHash ?? null,
    marketSource: context.marketSource ?? null,
    readMode: context.readMode ?? null,
    // What the agent believed its limits were. A commitment to its view, not proof the view was right.
    riskCommitment: market.vault ? keccak256(stringToHex(canonicalJson(market.vault))) : null,
    chainId: context.chainId,
    vault: context.vault,
    prevDecisionHash: context.prevDecisionHash,
    logHead: context.logHead,
    policyVersion: context.policyVersion,
    blockTime: market.head.timestamp.toString(),
    expiresAt: context.expiresAt.toString(),
    tick: market.tick,
    twapTick: market.twapTick,
    liquidity: market.liquidity?.toString(),
    mark: context.mark ? { askX18: context.mark.askX18.toString(), bidX18: context.mark.bidX18.toString(), ageMs: context.decidedAtMs - context.mark.fetchedAtMs } : null,
    ledger: { inputValue: decision.ledger?.inputValue?.toString() ?? null, outputValue: decision.ledger?.outputValue?.toString() ?? null, networkCost: decision.ledger?.networkCost?.toString() ?? null, net: decision.ledger?.net?.toString() ?? null },
    preflight: context.preflight ? { ok: context.preflight.ok, amountOut: context.preflight.amountOut?.toString() ?? null, gasEstimate: context.preflight.gasEstimate?.toString() ?? null } : null,
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
