// A public digest of the evidence directory. Only named files are opened and only named fields leave, so a raw result,
// a log line or a file added later can never reach the page by accident. A file that is absent reads as null.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, any>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 2_000) : null);
const digits = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? v : null);
const hash = (v: unknown) => (typeof v === "string" && /^0x[\da-fA-F]{64}$/.test(v) ? v : null);
const count = (v: unknown) => (Array.isArray(v) ? v.length : num(v));

function read(dir: string, name: string): Row | null {
  const path = join(dir, name);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 5_000_000) return null;
    const row = JSON.parse(readFileSync(path, "utf8"));
    return row && typeof row === "object" && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

const pair = (row: Row | undefined) => (row ? { sell: digits(row.sell), buy: digits(row.buy) } : null);
const quantile = (q: Row | undefined) => ({ n: num(q?.n), value: num(q?.value), low: num(q?.low), high: num(q?.high) });

export function readProof(evidenceDir: string) {
  // The newest recording wins. Older directories stay as they were, and are read only when nothing newer exists.
  const newest = (name: string) => read(evidenceDir, `v4/${name}`) ?? read(evidenceDir, `v3/${name}`);
  const verification = newest("verification.json");
  const mutation = newest("mutation-check.json");
  const venueMainnet = read(evidenceDir, "v4/venue-mainnet.json");
  const venueTestnet = read(evidenceDir, "v4/venue-testnet.json");
  const slither = newest("slither.json");
  const gas = newest("gas-compare.json");
  const rehearsal = newest("rehearsal-fork.json");
  const verifier = (["verify-local.json", "verify-testnet.json"] as const).flatMap((name) => {
    const row = read(evidenceDir, `v4/${name}`);
    if (!row) return [];
    const checked = row.checked as Row | undefined;
    return [{
      lane: name === "verify-local.json" ? "local" : "testnet", wallTime: text(row.wallTime), status: text(row.status), vaultVersion: text(row.vaultVersion),
      trades: num(checked?.trades), tradesMatched: num(checked?.tradesMatched), logEntries: num(checked?.logEntries), anchors: num(checked?.anchors),
      findings: (Array.isArray(row.findings) ? row.findings : []).slice(0, 40).map((f: Row) => ({ severity: text(f.severity), code: text(f.code), detail: text(f.detail) })),
    }];
  });
  const attacks = newest("attack-results.json")?.summary as Row | undefined;
  const e2e = newest("e2e.json");
  const llm = newest("llm-live.json");
  const latency = read(evidenceDir, "event-to-receipt/report.json");
  const transactions = read(evidenceDir, "public-transactions.json");

  return {
    verification: verification && {
      wallTime: text(verification.wallTime),
      suites: (Array.isArray(verification.suites) ? verification.suites : []).map((s: Row) => ({ name: text(s.name), lane: text(s.lane), command: text(s.command), passed: num(s.passed), failed: num(s.failed), skipped: num(s.skipped) })),
    },
    verifier,
    mutation: mutation && { wallTime: text(mutation.wallTime), lane: text(mutation.lane), mutants: count(mutation.mutants), killed: count(mutation.killed), survived: count(mutation.survived), didNotCompile: count(mutation.didNotCompile) },
    slither: slither && { wallTime: text(slither.wallTime), tool: text(slither.tool), findings: count(slither.findings), untriaged: count(slither.untriaged) },
    gas: gas && {
      wallTime: text(gas.wallTime), lane: text(gas.lane), rounds: num(gas.rounds), guardConfig: { twapWindowSec: num(gas.guardConfig?.twapWindowSec), bandTicks: num(gas.guardConfig?.bandTicks) },
      median: Object.fromEntries(["plain", "v1", "v2", "v3GuardOff", "v3GuardOn", "v3GuardDailyHash", "v4GuardOff", "v4GuardOn", "v4FullWithLossCharged"].map((arm) => [arm, pair(gas.medianGas?.[arm])])),
      deployGas: { v1: digits(gas.deployGas?.v1), v2: digits(gas.deployGas?.v2), v3: digits(gas.deployGas?.v3), v4: digits(gas.deployGas?.v4) },
      anchorLogGas: digits(gas.anchorLogGas),
      runtimeBytes: { v1: num(gas.runtimeBytes?.v1), v2: num(gas.runtimeBytes?.v2), v3: num(gas.runtimeBytes?.v3), v4: num(gas.runtimeBytes?.v4) },
    },
    rehearsal: rehearsal && {
      wallTime: text(rehearsal.wallTime), lane: text(rehearsal.lane), chainId: num(rehearsal.chainId), result: text(rehearsal.result),
      steps: (Array.isArray(rehearsal.steps) ? rehearsal.steps : []).map((s: Row) => ({ name: text(s.name), gasUsed: digits(s.gasUsed) })),
      manipulation: rehearsal.manipulationCost && {
        method: text(rehearsal.manipulationCost.method),
        rows: (Array.isArray(rehearsal.manipulationCost.rows) ? rehearsal.manipulationCost.rows : []).map((r: Row) => ({ capitalWhsk: digits(r.capitalWhsk), capitalUsd: num(r.capitalUsdApprox), ticks: num(r.ticksMoved), lossUsd: num(r.roundTripLossUsdApprox) })),
      },
    },
    attacks: attacks && {
      wallTime: text(attacks.wallTime), lane: text(attacks.lane), attacks: num(attacks.attacks?.n), contained: num(attacks.attacks?.contained), forbiddenAccepts: num(attacks.attacks?.forbiddenAccepts),
      benign: num(attacks.benign?.n), completed: num(attacks.benign?.completed), capViolations: num(attacks.capViolations),
      families: Object.entries((attacks.byFamily ?? {}) as Record<string, Row>).map(([family, r]) => ({ family, attacks: num(r.attacks), contained: num(r.contained) })),
    },
    e2e: e2e && { wallTime: text(e2e.wallTime), runs: (Array.isArray(e2e.runs) ? e2e.runs : []).map((r: Row) => ({ name: text(r.name), lane: text(r.lane), command: text(r.command), passed: num(r.passed), failed: num(r.failed) })) },
    venueRuns: [venueMainnet, venueTestnet].flatMap((v) => (v ? [{ wallTime: text(v.wallTime), lane: text(v.lane), chainId: num(v.chainId), block: text(v.block) ?? num(v.block), verdict: text(v.verdict), checks: count(v.checks) }] : [])),
    llm: llm && { wallTime: text(llm.wallTime), status: text(llm.status), reason: text(llm.reason), model: text(llm.model) },
    latency: latency && {
      lane: text(latency.lane), venue: text(latency.venue),
      poll: { attempts: num(latency.arms?.poll?.attempts), included: num(latency.arms?.poll?.included), p50: quantile(latency.arms?.poll?.p50), p90: quantile(latency.arms?.poll?.p90) },
      stream: { attempts: num(latency.arms?.stream?.attempts), included: num(latency.arms?.stream?.included), p50: quantile(latency.arms?.stream?.p50), p90: quantile(latency.arms?.stream?.p90) },
    },
    transactions: transactions && {
      lane: text(transactions.lane), chainId: num(transactions.chainId), explorer: text(transactions.explorer), checkedAt: text(transactions.checkedAt), vault: text(transactions.vault), note: text(transactions.note),
      rows: (Array.isArray(transactions.rows) ? transactions.rows : []).flatMap((r: Row) => (hash(r.hash) ? [{ hash: r.hash as string, label: text(r.label), kind: text(r.kind), expected: text(r.expected), status: text(r.status), block: digits(r.block), gasUsed: digits(r.gasUsed) }] : [])),
    },
  };
}
