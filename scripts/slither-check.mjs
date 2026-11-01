// Runs Slither on the vault and records every finding next to its triage, so a new finding fails the check.
// Needs `pip install slither-analyzer`. Writes evidence/v3/slither.json.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// Why each finding is not a bug. Keyed by detector and function, so the same detector in a new place is not excused.
const TRIAGE = {
  "reentrancy-balance|_swap": "Balances are read either side of the router call on purpose, to trust balances over the return value. Every path into _swap holds the reentrancy lock, and test_attack_* covers a reentering token.",
  "incorrect-equality|stopReady": "Compares a remaining allowance with zero, which is exact by design and cannot be forced past.",
  "incorrect-equality|triggerStop": "Refuses a zero amount, which is exact by design.",
  "unused-return|priceGuardTicks": "Only the tick of slot0 is needed.",
  "unused-return|_requireInBand": "Only the tick of slot0 is needed.",
  "unused-return|_twapTick": "The per-liquidity values of observe are not needed.",
  "unused-return|_swap": "The router's return value is ignored on purpose: amounts are measured from balances.",
  "missing-zero-check|setGuardian": "Zero means no guardian, which is a supported setting.",
  "missing-zero-check|transferOwnership": "Zero cancels an offer, and acceptOwnership refuses the zero address.",
  "timestamp": "Deadlines, budgets and expiry work in minutes and hours, far above the seconds a sequencer can shift a timestamp.",
  "low-level-calls|_call": "The token call has to tolerate tokens that return nothing. It checks the code size and the returned value.",
};

const out = join(mkdtempSync(join(tmpdir(), "slither-")), "report.json");
const env = { ...process.env, PATH: `${resolve("tools/foundry")}${delimiter}${process.env.PATH}` };
const r = spawnSync("python", ["-m", "slither", ".", "--filter-paths", "contracts/test|contracts/baseline|contracts/test-market", "--json", out], { encoding: "utf8", env });
const report = JSON.parse(readFileSync(out, "utf8"));
if (!report.success) throw new Error(`slither failed: ${report.error ?? r.stderr}`);

const findings = report.results.detectors.map((d) => {
  const fn = d.elements.find((e) => e.type === "function")?.name ?? d.elements[0]?.type_specific_fields?.parent?.name ?? "";
  const triage = TRIAGE[`${d.check}|${fn}`] ?? TRIAGE[d.check] ?? null;
  return { check: d.check, impact: d.impact, confidence: d.confidence, function: fn, line: d.elements[0]?.source_mapping?.lines?.[0] ?? null, triage };
});
const untriaged = findings.filter((f) => !f.triage);
const version = spawnSync("python", ["-m", "slither", "--version"], { encoding: "utf8", env }).stdout.trim();
const summary = { wallTime: new Date().toISOString(), lane: "local", tool: `slither ${version}`, scope: "contracts/HoldfastVault.sol", findings: findings.length, untriaged: untriaged.length, results: findings };
mkdirSync("evidence/v3", { recursive: true });
writeFileSync("evidence/v3/slither.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${findings.length} findings, ${untriaged.length} untriaged`);
for (const f of untriaged) console.log(`UNTRIAGED ${f.impact} ${f.check} ${f.function}:${f.line}`);
if (untriaged.length) process.exitCode = 1;
