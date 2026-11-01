import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

export type Lane = "mainnet" | "fork" | "replay" | "testnet";

export interface Span {
  stage: string;
  startMs: number;
  endMs: number;
  ok: boolean;
}

export interface TraceRecord {
  id: string;
  lane: Lane;
  wallTime: string;
  /** Monotonic time the event was meant to be handled. Latency starts here, not when a worker got free. */
  scheduledMs: number;
  spans: Span[];
  attrs: Record<string, unknown>;
}

/** Per-decision timeline on a monotonic clock, measured from intended time so queueing stays visible. */
export class Trace {
  readonly spans: Span[] = [];
  readonly attrs: Record<string, unknown> = {};
  private readonly wallTime = new Date().toISOString();

  constructor(
    readonly id: string,
    readonly lane: Lane,
    readonly scheduledMs: number = performance.now(),
  ) {}

  async span<T>(stage: string, work: () => Promise<T> | T): Promise<T> {
    const startMs = performance.now();
    let ok = false;
    try {
      const result = await work();
      ok = true;
      return result;
    } finally {
      this.spans.push({ stage, startMs, endMs: performance.now(), ok });
    }
  }

  /** Milliseconds from the scheduled time to the end of the named stage. */
  sinceScheduled(stage: string): number | undefined {
    const span = this.spans.find((s) => s.stage === stage && s.ok);
    return span && span.endMs - this.scheduledMs;
  }

  toRecord(): TraceRecord {
    return {
      id: this.id,
      lane: this.lane,
      wallTime: this.wallTime,
      scheduledMs: this.scheduledMs,
      spans: this.spans,
      attrs: this.attrs,
    };
  }
}

/** Append-only JSONL. BigInt values are written as decimal strings. */
export class JsonlLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(record: unknown): void {
    appendFileSync(this.path, `${toJson(record)}\n`);
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}
