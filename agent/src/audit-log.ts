// A local log where each record commits to the one before, so a rewrite shows. This alone proves little, because whoever
// holds the file can rebuild the whole chain. What makes it evidence is that every trade carries the head of this chain
// in its on-chain decision hash, which nobody can rebuild. Records after the newest trade are local claims only.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { keccak256, stringToHex, type Hex } from "viem";
import { toJson } from "./trace.js";

export const GENESIS: Hex = `0x${"0".repeat(64)}`;
/** Long enough for the newest whole record. */
const TAIL_BYTES = 256 * 1024;

export function linkHash(seq: number, prev: Hex, body: string): Hex {
  return keccak256(stringToHex(`${seq}|${prev}|${body}`));
}

export class ChainedLog {
  head: Hex = GENESIS;
  seq = 0;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size === 0) return;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, size - length);
    closeSync(fd);
    const text = buffer.toString("utf8");
    // A crash can leave half a line. Close it, so the next record starts on its own line.
    if (!text.endsWith("\n")) appendFileSync(path, "\n");
    for (const line of text.split("\n").reverse()) {
      const last = parse(line);
      if (last && typeof last.hash === "string" && typeof last.seq === "number") {
        this.head = last.hash as Hex;
        this.seq = last.seq + 1;
        return;
      }
    }
  }

  append(record: object): { seq: number; hash: Hex } {
    const body = toJson(record);
    const hash = linkHash(this.seq, this.head, body);
    appendFileSync(this.path, `${toJson({ seq: this.seq, prev: this.head, hash, ...JSON.parse(body) })}\n`);
    const entry = { seq: this.seq, hash };
    this.head = hash;
    this.seq++;
    return entry;
  }
}

export interface ChainCheck {
  records: number;
  /** Records from before the log was chained. They commit to nothing. */
  unchained: number;
  /** Lines that are not JSON, which a crash mid-write can leave. They are reported, not skipped silently. */
  tornLines: number;
  head: Hex;
  /** Empty means every link holds. */
  breaks: Array<{ line: number; problem: string }>;
  /** Every hash in the chain, for checking what a trade committed to. */
  hashes: Set<Hex>;
}

/** Recomputes every link. Reads the whole file, so this is for an audit and not the agent's own path. */
export function verifyChain(text: string): ChainCheck {
  const check: ChainCheck = { records: 0, unchained: 0, tornLines: 0, head: GENESIS, breaks: [], hashes: new Set() };
  let seq = 0;
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    const parsed = parse(line);
    if (!parsed) {
      check.tornLines++;
      return;
    }
    if (typeof parsed.hash !== "string") {
      check.unchained++;
      return;
    }
    check.records++;
    const { seq: claimedSeq, prev, hash, ...rest } = parsed;
    if (claimedSeq !== seq) check.breaks.push({ line: index + 1, problem: `sequence ${String(claimedSeq)}, expected ${seq}: a record was removed or added` });
    if (prev !== check.head) check.breaks.push({ line: index + 1, problem: "does not follow the record before it" });
    if (linkHash(claimedSeq as number, prev as Hex, JSON.stringify(rest)) !== hash) check.breaks.push({ line: index + 1, problem: "contents do not match its hash" });
    check.head = hash as Hex;
    check.hashes.add(hash as Hex);
    seq = (claimedSeq as number) + 1;
  });
  return check;
}

function parse(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The whole log's text, or nothing if there is no log yet. */
export function readLog(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
