// Tests claims about another project's contracts, at a pinned commit, in a throwaway directory. Only .sol sources are
// copied, and our own foundry.toml is used, so nothing from that repository configures or runs on this machine.
// Writes evidence/v4/sentinel-probes.json.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const COMMIT = "6840d73";
const dir = resolve(".probe/sentinel");
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "core.longpaths=true", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const fetchAt = (url, ref, to) => {
  if (existsSync(to)) return;
  mkdirSync(to, { recursive: true });
  git(to, "clone", "--quiet", "--depth", "200", url, ".");
  git(to, "-c", "advice.detachedHead=false", "checkout", "--quiet", ref);
};
mkdirSync(dir, { recursive: true });
fetchAt("https://github.com/mesh-pch/sentinel-hashkey", COMMIT, join(dir, "upstream"));
for (const [name, url, tag] of [["forge-std", "https://github.com/foundry-rs/forge-std", "v1.17.0"], ["openzeppelin-contracts", "https://github.com/OpenZeppelin/openzeppelin-contracts", "v5.7.0"]]) {
  const to = join(dir, "lib", name);
  if (!existsSync(to)) {
    mkdirSync(join(dir, "lib"), { recursive: true });
    git(join(dir, "lib"), "clone", "--quiet", "--depth", "1", "--branch", tag, url, name);
  }
}
cpSync(join(dir, "upstream/src"), join(dir, "src"), { recursive: true });
cpSync(join(dir, "upstream/test"), join(dir, "test"), { recursive: true });
cpSync("research/sentinel/SentinelProbes.t.sol", join(dir, "test/SentinelProbes.t.sol"));
writeFileSync(join(dir, "foundry.toml"), `[profile.default]
src = "src"
test = "test"
out = "out"
libs = ["lib"]
# Sentinel pins 0.8.24 with a ^0.8.24 pragma. This machine has 0.8.28, so gas here differs from theirs slightly.
solc = "0.8.28"
evm_version = "paris"
optimizer = true
optimizer_runs = 200
ffi = false
fs_permissions = []
remappings = ["forge-std/=lib/forge-std/src/", "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/"]
`);
const forge = existsSync("tools/foundry/forge.exe") ? resolve("tools/foundry/forge.exe") : "forge";
const run = spawnSync(forge, ["test", "--json", "--offline"], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const start = run.stdout.indexOf("{");
if (start < 0) { console.log(run.stdout.slice(-2000), run.stderr.slice(-4000)); process.exit(1); }
const report = JSON.parse(run.stdout.slice(start));
const suites = {};
const probes = [];
for (const [suite, body] of Object.entries(report)) {
  const name = suite.split(":").pop();
  const results = Object.entries(body.test_results);
  suites[name] = { passed: results.filter(([, r]) => r.status === "Success").length, failed: results.filter(([, r]) => r.status !== "Success").length };
  if (name === "SentinelProbes") for (const [test, r] of results) probes.push({ test: test.replace(/\(.*/, ""), holds: r.status === "Success", ...(r.status === "Success" ? {} : { reason: String(r.reason ?? "").slice(0, 200) }) });
}
mkdirSync("evidence/v4", { recursive: true });
writeFileSync("evidence/v4/sentinel-probes.json", `${JSON.stringify({ wallTime: new Date().toISOString(), lane: "local, against Sentinel's source with mocks it ships", compiler: "solc 0.8.28, where Sentinel pins 0.8.24", repository: "mesh-pch/sentinel-hashkey", commit: git(join(dir, "upstream"), "rev-parse", "HEAD"), probesSource: "research/sentinel/SentinelProbes.t.sol", suites, probes }, null, 2)}\n`);
for (const p of probes) console.log(`${p.holds ? "HOLDS " : "FAILED"} ${p.test}${p.reason ? `  ${p.reason}` : ""}`);
console.log(JSON.stringify(suites));
