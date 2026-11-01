import { keccak256, type Hex } from "viem";
import { quantileReport } from "./stats.js";
import type { Frame } from "./stream.js";

export interface InclusionCell { targetIndex: number; targetPhaseMs: number }
export interface InclusionRow extends InclusionCell {
  trial: number;
  triggerBlock: string | null;
  triggerIndex: number | null;
  triggerPayloadId: string | null;
  triggerArrivedAt: number | null;
  sendAt: number | null;
  actualPhaseMs: number | null;
  responseAt: number | null;
  responseStatus: string | null;
  httpStatus: number | null;
  transactionHash: Hex | null;
  inclusionBlock: string | null;
  inclusionIndex: number | null;
  inclusionPayloadId: string | null;
  inclusionArrivedAt: number | null;
  framesBetween: number | null;
  receiptBlock: string | null;
  receiptTransactionIndex: number | null;
  inclusionToResponseMs: number | null;
  rateLimitWaitMs: number | null;
  error: string | null;
}

export function inclusionRow(trial: number, cell: InclusionCell): InclusionRow {
  return { trial, ...cell, triggerBlock: null, triggerIndex: null, triggerPayloadId: null, triggerArrivedAt: null,
    sendAt: null, actualPhaseMs: null, responseAt: null, responseStatus: null, httpStatus: null, transactionHash: null,
    inclusionBlock: null, inclusionIndex: null, inclusionPayloadId: null, inclusionArrivedAt: null, framesBetween: null,
    receiptBlock: null, receiptTransactionIndex: null, inclusionToResponseMs: null, rateLimitWaitMs: null, error: null };
}

/** Balanced cells, Fisher-Yates shuffled by a reproducible 32-bit generator. */
export function inclusionSchedule(phases: number[], perCell = 10, seed = 1): InclusionCell[] {
  if (!phases.length || new Set(phases).size !== phases.length || phases.some((phase) => !Number.isFinite(phase) || phase < 0)) throw new Error("phases must be distinct nonnegative milliseconds");
  if (!Number.isSafeInteger(perCell) || perCell < 1 || !Number.isSafeInteger(seed)) throw new Error("per-cell must be positive and seed must be an integer");
  const cells: InclusionCell[] = [];
  for (let targetIndex = 0; targetIndex <= 10; targetIndex++) for (const targetPhaseMs of phases) {
    for (let n = 0; n < perCell; n++) cells.push({ targetIndex, targetPhaseMs });
  }
  let state = seed >>> 0;
  for (let i = cells.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = Math.floor((state / 2 ** 32) * (i + 1));
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
  }
  return cells;
}

/** Used only by the benchmark, never on the agent's reaction path. */
export class InclusionTracker {
  private triggerSequence = 0;
  constructor(readonly row: InclusionRow, private readonly raw: Hex) { row.transactionHash = keccak256(raw); }

  trigger(frame: Frame, sequence: number): void {
    Object.assign(this.row, { triggerBlock: String(frame.block), triggerIndex: frame.index, triggerPayloadId: frame.payloadId ?? null, triggerArrivedAt: frame.arrivedAt });
    this.triggerSequence = sequence;
  }

  observe(frame: Frame, sequence: number): boolean {
    if (this.row.triggerArrivedAt === null || this.row.inclusionArrivedAt !== null) return false;
    const included = frame.transactions?.some((raw) => raw === this.raw || raw.toLowerCase() === this.row.transactionHash || keccak256(raw) === this.row.transactionHash);
    if (!included) return false;
    Object.assign(this.row, { inclusionBlock: String(frame.block), inclusionIndex: frame.index, inclusionPayloadId: frame.payloadId ?? null,
      inclusionArrivedAt: frame.arrivedAt, framesBetween: sequence - this.triggerSequence });
    return true;
  }
}

const complete = (row: InclusionRow) => row.error === null && row.responseStatus === "success" && row.framesBetween !== null && row.triggerArrivedAt !== null && row.responseAt !== null && row.inclusionArrivedAt !== null;

/** A slow response is at least 100 ms above the normal-frame P50 at the same phase, across all indices. */
export function analyzeInclusion(rows: readonly InclusionRow[], slowExtraMs = 100) {
  const summarize = (group: readonly InclusionRow[]) => {
    const good = group.filter(complete);
    const framesBetween: Record<string, number> = {};
    for (const row of group) if (row.framesBetween !== null) framesBetween[row.framesBetween] = (framesBetween[row.framesBetween] ?? 0) + 1;
    return { n: group.length, failures: group.length - good.length, framesBetween,
      frameToResponseP50: quantileReport(good.map((row) => row.responseAt! - row.triggerArrivedAt!), 0.5),
      inclusionToResponseP50: quantileReport(good.map((row) => row.responseAt! - row.inclusionArrivedAt!), 0.5) };
  };
  const phases = [...new Set(rows.map((row) => row.targetPhaseMs))].sort((a, b) => a - b);
  const baselines = phases.map((phase) => {
    const good = rows.filter((row) => row.targetPhaseMs === phase && complete(row));
    const counts = summarize(good).framesBetween;
    const mode = Object.keys(counts).map(Number).sort((a, b) => counts[b]! - counts[a]! || a - b)[0] ?? null;
    const normal = good.filter((row) => row.framesBetween === mode);
    return { phase, normalFrames: mode, frameToResponseP50: quantileReport(normal.map((row) => row.responseAt! - row.triggerArrivedAt!), 0.5) };
  });
  const slowCases = rows.filter(complete).flatMap((row) => {
    const baseline = baselines.find((entry) => entry.phase === row.targetPhaseMs)!;
    const median = baseline.frameToResponseP50.value;
    if (median === null || row.responseAt! - row.triggerArrivedAt! < median + slowExtraMs) return [];
    const label = row.framesBetween! > baseline.normalFrames! ? "inclusion later" : "same frame, later response";
    return [{ trial: row.trial, targetIndex: row.targetIndex, targetPhaseMs: row.targetPhaseMs, label }];
  });
  return {
    slowExtraMs, baselines, slowCases,
    cells: Array.from({ length: 11 }, (_, targetIndex) => phases.map((targetPhaseMs) => ({ targetIndex, targetPhaseMs,
      ...summarize(rows.filter((row) => row.targetIndex === targetIndex && row.targetPhaseMs === targetPhaseMs)) }))).flat(),
    indices: Array.from({ length: 11 }, (_, targetIndex) => ({ targetIndex, ...summarize(rows.filter((row) => row.targetIndex === targetIndex)) })),
  };
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (value !== null && value.trim() !== "") {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return 60_000;
}
