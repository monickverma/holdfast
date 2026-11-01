import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import { toJson } from "./trace.js";

/** "expired" means its deadline passed and the vault shows it never ran, so it can never move funds. */
/** "cancelled" means the agent dropped it before sending, because the state it was decided on changed. It is not a failed trade. */
export type IntentStatus = "reserved" | "signed" | "broadcast" | "included" | "reverted" | "expired" | "cancelled";

export interface Intent {
  /** Stable logical name: the same work always has the same key. */
  key: string;
  intentId: Hex;
  /** Hash of everything the transaction commits to. */
  bodyHash: Hex;
  status: IntentStatus;
  orderId: string | null;
  tokenIn: Address;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
  nonce?: number;
  rawTx?: Hex;
  txHash?: Hex;
  broadcastBlock?: bigint;
  blockNumber?: bigint;
  amountOut?: bigint;
  gasUsed?: bigint;
  /** Execution plus L1 fee, in wei, from the receipt. */
  feeWei?: bigint;
  revertReason?: string;
}

const BIGINT_FIELDS = ["amountIn", "minOut", "deadline", "broadcastBlock", "blockNumber", "amountOut", "gasUsed", "feeWei"] as const;

export class IntentConflict extends Error {}

/**
 * Durable record of every intent. Each change is written and synced before the action it describes, so a crash at
 * any point leaves enough to tell what happened. The file is append-only and replayed on start.
 */
export class Ledger {
  private readonly intents = new Map<string, Intent>();
  private readonly fd: number;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) this.replay(path);
    this.fd = openSync(path, "a");
  }

  get(key: string): Intent | undefined {
    return this.intents.get(key);
  }

  all(): Intent[] {
    return [...this.intents.values()];
  }

  /** The intent awaiting a chain outcome, if any. */
  inFlight(): Intent | undefined {
    return this.all().find((i) => i.status === "signed" || i.status === "broadcast");
  }

  /** Highest nonce this agent has signed, or null. An expired intent's nonce may never be used, so it is free again. */
  lastNonce(): number | null {
    let last: number | null = null;
    for (const intent of this.intents.values()) {
      if (intent.status !== "expired" && intent.status !== "cancelled" && intent.nonce !== undefined && (last === null || intent.nonce > last)) last = intent.nonce;
    }
    return last;
  }

  /**
   * An unused intent ID that shares the vault's bitmap word with the last one, so marking it costs 5,000 gas rather
   * than 22,100. A fresh random word every 256 intents, and for each new ledger, so separate runs cannot collide.
   */
  nextIntentId(): Hex {
    const last = [...this.intents.values()].at(-1)?.intentId;
    if (last && /^0x[0-9a-f]{64}$/.test(last) && !last.endsWith("ff")) {
      return `0x${(BigInt(last) + 1n).toString(16).padStart(64, "0")}`;
    }
    return `0x${randomBytes(31).toString("hex")}00`;
  }

  /**
   * Records new work. The same key with the same body returns the earlier record so the caller does not act twice;
   * the same key with a different body is refused.
   */
  reserve(intent: Omit<Intent, "status">): { intent: Intent; existing: boolean } {
    const prior = this.intents.get(intent.key);
    if (prior) {
      if (prior.bodyHash !== intent.bodyHash) throw new IntentConflict(`intent ${intent.key} already exists with a different body`);
      return { intent: prior, existing: true };
    }
    return { intent: this.write({ ...intent, status: "reserved" }), existing: false };
  }

  update(key: string, change: Partial<Intent>): Intent {
    const prior = this.intents.get(key);
    if (!prior) throw new Error(`unknown intent ${key}`);
    return this.write({ ...prior, ...change });
  }

  close(): void {
    closeSync(this.fd);
  }

  private write(intent: Intent): Intent {
    writeSync(this.fd, `${toJson(intent)}\n`);
    fsyncSync(this.fd);
    this.intents.set(intent.key, intent);
    return intent;
  }

  private replay(path: string): void {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Only a crash mid-append can do this, and that record's action never began.
        continue;
      }
      for (const field of BIGINT_FIELDS) {
        if (typeof parsed[field] === "string") parsed[field] = BigInt(parsed[field]);
      }
      const intent = parsed as unknown as Intent;
      this.intents.set(intent.key, intent);
    }
  }
}
