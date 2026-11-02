// The exact commands of docs/MAINNET-RUNBOOK.md, on a local Anvil fork of mainnet, with Anvil's public test keys.
// Nothing reaches a public network: the only outside calls are reads of the gas price and the L1 fee.
// Costs below are this run's gas at the price read from mainnet, because a fork charges its own price.
// Run `npm run build:agent` and `node scripts/forge.mjs build --offline` first. Writes evidence/v4/mainnet-dress-rehearsal-fork.json.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAINNET = "https://mainnet.hsk.xyz";
const PORT = 8610;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const GAS_ORACLE = "0x420000000000000000000000000000000000000F";
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const GUARDIAN = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const rpc = async (url, method, params = []) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};

// getL1Fee(bytes), for the deployment's bytes. The vault's constructor arguments add a few hundred bytes more.
const artifact = JSON.parse(readFileSync("out/HoldfastVault.sol/HoldfastVault.json", "utf8"));
const code = artifact.bytecode.object.slice(2);
const padded = code.padEnd(Math.ceil(code.length / 64) * 64, "0");
const l1FeeCall = `0x49948e0e${(32).toString(16).padStart(64, "0")}${(code.length / 2).toString(16).padStart(64, "0")}${padded}`;
const gasPriceWei = BigInt(await rpc(MAINNET, "eth_gasPrice"));
const deployL1FeeWei = BigInt(await rpc(MAINNET, "eth_call", [{ to: GAS_ORACLE, data: l1FeeCall }, "latest"]));

const dir = mkdtempSync(join(tmpdir(), "holdfast-dress-"));
const record = join(dir, "vault.json");
const local = "tools/foundry/anvil.exe";
const anvil = spawn(existsSync(local) ? local : "anvil", ["--fork-url", MAINNET, "--port", String(PORT), "--block-time", "1", "--silent"], { stdio: "ignore" });
const env = { ...process.env, NETWORK: "mainnet", RPC_URL, OWNER_PRIVATE_KEY: OWNER_KEY, AGENT_PRIVATE_KEY: AGENT_KEY, VAULT_GENERATION: "4", DATA_DIR: dir, MODE: "", LIVE: "", ANTHROPIC_API_KEY: "" };

const steps = [];
function run(name, script, args, extra = {}) {
  const r = spawnSync("node", [`.test-build/src/cli/${script}.js`, ...args], { encoding: "utf8", env: { ...env, ...extra } });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  console.log(`--- ${name}\n${output}`);
  if (r.status !== 0) throw new Error(`${name} exited ${r.status}`);
  const gas = [...output.matchAll(/^(?:ok: .*, gas (\d+),|included: .*, gas (\d+),)/gm)].map((m) => Number(m[1] ?? m[2]));
  const step = { name, command: `${script} ${args.join(" ")}`, gasUsed: gas.reduce((a, b) => a + b, 0), output: output.trim() };
  steps.push(step);
  return step;
}

try {
  for (let i = 0; ; i++) {
    try {
      await rpc(RPC_URL, "eth_chainId");
      break;
    } catch (error) {
      if (i > 120) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const confirm = ["--broadcast", "--confirm-mainnet"];
  run("deploy dry run", "deploy-vault", ["--owner", OWNER, "--agent", AGENT]);
  run("deploy", "deploy-vault", ["--owner", OWNER, "--agent", AGENT, "--out", record, ...confirm]);
  const deployed = JSON.parse(readFileSync(record, "utf8"));
  steps.at(-1).gasUsed = Number(deployed.gasUsed);
  const vaultEnv = { VAULT_ADDRESS: deployed.vault };
  Object.assign(env, vaultEnv);
  const limits = run("limits", "admin", ["limits", "--max-trade-hsk", "1", "--lifetime-hsk", "2", "--hourly-hsk", "2", "--max-trade-usdt", "0.1", "--lifetime-usdt", "0.2", "--hourly-usdt", "0.2", ...confirm]);
  const spot = Number(/^spot (\d+) micro-USDT/m.exec(limits.output)[1]) / 1e6;
  run("daily budget", "admin", ["daily", "--token", "whsk", "--amount", "2", ...confirm]);
  run("price guard", "admin", ["guard", "--window", "600", "--band-ticks", "100", ...confirm]);
  run("guardian", "admin", ["guardian", "--address", GUARDIAN, ...confirm]);
  run("loss budget", "admin", ["loss", "--mark", String(spot), "--amount", "1", "--max-age", "86400", ...confirm]);
  run("fund", "admin", ["fund", "--hsk", "1", ...confirm]);
  run("preflight", "preflight", ["--agent", AGENT]);
  run("swap preview", "swap-once", ["sell", "1"]);
  const swap = run("swap", "swap-once", ["sell", "1", ...confirm]);
  if (!/^included:/m.test(swap.output)) throw new Error("the swap was not included");

  const totalGas = (who) => steps.filter((s) => who(s.name)).reduce((sum, s) => sum + BigInt(s.gasUsed), 0n);
  const ownerGas = totalGas((n) => n !== "swap");
  const agentGas = totalGas((n) => n === "swap");
  const hsk = (wei) => Number(wei) / 1e18;
  const report = {
    wallTime: new Date().toISOString(),
    lane: "fork",
    chainId: 177,
    note: "A local Anvil fork of HSK mainnet with Anvil's public test keys. Hashes exist only on the fork. Nothing was broadcast to a public network. Gas price and L1 fee are mainnet reads.",
    vaultOnFork: deployed.vault,
    runtimeMatchesBuild: deployed.runtimeMatchesBuild,
    gasPriceWei: gasPriceWei.toString(),
    deployL1FeeWei: deployL1FeeWei.toString(),
    ownerGas: ownerGas.toString(),
    agentGas: agentGas.toString(),
    costHskAtThatPrice: { ownerGas: hsk(ownerGas * gasPriceWei), deployL1Fee: hsk(deployL1FeeWei), agentGas: hsk(agentGas * gasPriceWei) },
    steps: steps.map(({ output, ...step }) => ({ ...step, output: output.split("\n").filter((line) => !/^(owner|chain) /.test(line)).slice(-6).join("\n") })),
  };
  mkdirSync("evidence/v4", { recursive: true });
  writeFileSync("evidence/v4/mainnet-dress-rehearsal-fork.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ gasPriceWei: report.gasPriceWei, ownerGas: report.ownerGas, agentGas: report.agentGas, cost: report.costHskAtThatPrice }, null, 2));
} finally {
  anvil.kill();
}
