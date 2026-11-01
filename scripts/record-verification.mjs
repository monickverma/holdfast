// Runs the suites, counts what each one reports, and writes the counts to evidence/v3. The site's numbers come from here,
// so a number on the page was printed by a test run and not typed by a person. Exits 1 if any suite failed.
//   node scripts/record-verification.mjs            contracts, fork tests and agent tests
//   node scripts/record-verification.mjs --e2e      also the end-to-end runs (needs anvil and mainnet RPC reads)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const run = (command, env = {}) => {
  const started = Date.now();
  const result = spawnSync(command, { shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env } });
  return { output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`, status: result.status, seconds: Math.round((Date.now() - started) / 1000) };
};

function forge(name, lane, command, env) {
  const { output, seconds } = run(command, env);
  const match = /Ran \d+ test suites?.*?(\d+) tests? passed, (\d+) failed, (\d+) skipped/.exec(output);
  if (!match) { console.log(output.slice(-2000)); throw new Error(`${name}: no summary line`); }
  return { name, lane, command, passed: Number(match[1]), failed: Number(match[2]), skipped: Number(match[3]), seconds };
}

function nodeTest(name, lane, command) {
  const { output, seconds } = run(command);
  const count = (label) => { const m = new RegExp(`^[ℹ#] ${label} (\\d+)`, "m").exec(output); if (!m) throw new Error(`${name}: no ${label} line`); return Number(m[1]); };
  return { name, lane, command, passed: count("pass"), failed: count("fail"), skipped: count("skipped"), seconds };
}

function scenarios(name, lane, command) {
  const { output, status, seconds } = run(command);
  const passed = (output.match(/^PASS /gm) ?? []).length;
  const failed = (output.match(/^FAIL /gm) ?? []).length + (status === 0 ? 0 : 1);
  return { name, lane, command, passed, failed, seconds };
}

mkdirSync("evidence/v3", { recursive: true });
const suites = [
  forge("contracts", "local", "node scripts/forge.mjs test --offline --no-match-contract Fork"),
  // Without FORK_TESTS these return at once and pass, so they are kept out of the local count and run for real here.
  forge("fork", "fork", "node scripts/forge.mjs test --match-contract Fork", { FORK_TESTS: "true" }),
  nodeTest("agent", "local", "npm run -s test:agent:local"),
];
writeFileSync("evidence/v3/verification.json", `${JSON.stringify({ wallTime: new Date().toISOString(), suites }, null, 2)}\n`);
for (const s of suites) console.log(`${s.failed ? "FAIL" : "PASS"} ${s.name}: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped, ${s.seconds} s`);

let failed = suites.reduce((sum, s) => sum + s.failed, 0);
if (process.argv.includes("--e2e")) {
  const runs = [
    scenarios("fork end to end", "fork", "npm run -s e2e:fork"),
    scenarios("test market end to end", "local", "npm run -s e2e:testmarket"),
  ];
  writeFileSync("evidence/v3/e2e.json", `${JSON.stringify({ wallTime: new Date().toISOString(), runs }, null, 2)}\n`);
  for (const r of runs) console.log(`${r.failed ? "FAIL" : "PASS"} ${r.name}: ${r.passed} passed, ${r.failed} failed, ${r.seconds} s`);
  failed += runs.reduce((sum, r) => sum + r.failed, 0);
}
if (existsSync("evidence/v3/llm-live.json")) console.log(`Live model call: ${JSON.parse(readFileSync("evidence/v3/llm-live.json", "utf8")).status}`);
if (failed) process.exit(1);
