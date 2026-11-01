import { keccak256, type Hex } from "viem";
import type { Frame } from "./stream.js";

/** Everything the stream showed for one block, in arrival order. */
export interface BlockFrames {
  block: bigint;
  frames: number;
  indexes: Set<number>;
  payloadIds: Set<string>;
  lastHash: Hex | null;
  transactions: Hex[];
  /** System deposits, which an abandoned payload can carry and which no trade reacts to. */
  deposits: Set<Hex>;
}

export interface SealedBlock {
  hash: Hex;
  transactions: Hex[];
}

export interface BlockDrift {
  block: bigint;
  frames: number;
  /** The last frame's block hash equals the sealed block's. This alone proves contents, order and receipts all match. */
  hashMatch: boolean;
  /** Shown in a frame, absent from the sealed block. This is the failure a frame reaction can act on. */
  vanished: number;
  /** The vanished transactions that were not system deposits. These are the ones that matter. */
  vanishedUser: Hex[];
  /** In the sealed block, never shown in a frame. */
  unseen: number;
  /** The transactions both have, in the same order. */
  orderMatch: boolean;
  payloads: number;
  /** Carries something other than the one system deposit every block has. */
  userTransactions: number;
}

/** Collects frames by block until that block has sealed. */
export class FrameLedger {
  private readonly blocks = new Map<bigint, BlockFrames>();

  add(frame: Frame): void {
    let seen = this.blocks.get(frame.block);
    if (!seen) {
      seen = { block: frame.block, frames: 0, indexes: new Set(), payloadIds: new Set(), lastHash: null, transactions: [], deposits: new Set() };
      this.blocks.set(frame.block, seen);
    }
    seen.frames++;
    seen.indexes.add(frame.index);
    if (frame.payloadId) seen.payloadIds.add(frame.payloadId);
    if (frame.blockHash) seen.lastHash = frame.blockHash;
    for (const raw of frame.transactions ?? []) {
      const hash = keccak256(raw);
      seen.transactions.push(hash);
      if (raw.startsWith("0x7e")) seen.deposits.add(hash);
    }
  }

  /** Blocks at or below this height, oldest first, removed from the ledger. */
  takeUpTo(height: bigint): BlockFrames[] {
    const ready = [...this.blocks.values()].filter((seen) => seen.block <= height).sort((a, b) => Number(a.block - b.block));
    for (const seen of ready) this.blocks.delete(seen.block);
    return ready;
  }
}

export function compareBlock(seen: BlockFrames, sealed: SealedBlock): BlockDrift {
  const inSealed = new Set(sealed.transactions);
  const inFrames = new Set(seen.transactions);
  const sharedFrames = seen.transactions.filter((hash) => inSealed.has(hash));
  const sharedSealed = sealed.transactions.filter((hash) => inFrames.has(hash));
  return {
    block: seen.block,
    frames: seen.frames,
    hashMatch: seen.lastHash === sealed.hash,
    vanished: seen.transactions.length - sharedFrames.length,
    vanishedUser: seen.transactions.filter((hash) => !inSealed.has(hash) && !seen.deposits.has(hash)),
    unseen: sealed.transactions.length - sharedSealed.length,
    orderMatch: sharedFrames.join() === sharedSealed.join(),
    payloads: seen.payloadIds.size,
    userTransactions: Math.max(0, sealed.transactions.length - 1),
  };
}
