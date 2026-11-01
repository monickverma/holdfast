// Health of the chain, the vault and the agent, for a person or a cron job. Reads only, and loads no key.
// Exits 0 if healthy, 1 on a warning, 2 on something critical.
//   npm run monitor                   vault and chain
//   npm run monitor -- --agent        and the agent's heartbeat
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPublicClient, http, type Address } from "viem";
import { HSKSWAP, loadConfig, networkProfile } from "../config.js";
import { healthChecks, worstSeverity, type HealthInput } from "../monitor.js";
import { VAULT_ABI } from "../reader.js";

try {
  process.loadEnvFile();
} catch {
  // A .env file is optional; the environment may already be set.
}

const { values } = parseArgs({ options: { agent: { type: "boolean", default: false } } });
const config = loadConfig({ ...process.env, AGENT_PRIVATE_KEY: undefined, MODE: "observe", LIVE: undefined });
const client = createPublicClient({ transport: http(config.rpcUrl, { timeout: 10_000, retryCount: 0 }) });

const started = performance.now();
const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
const rpcLatencyMs = performance.now() - started;
const nowSec = BigInt(Math.floor(Date.now() / 1000));
const heartbeatPath = join(config.dataDir, "heartbeat.json");

const input: HealthInput = {
  nowMs: Date.now(),
  heartbeat: existsSync(heartbeatPath) ? JSON.parse(readFileSync(heartbeatPath, "utf8")) : null,
  expectAgent: values.agent!,
  chainId,
  expectedChainId: config.chainId,
  headAgeSec: Number(nowSec - block.timestamp),
  rpcLatencyMs,
};

if (config.vault) {
  const address: Address = config.vault;
  const read = <T>(functionName: string, args: unknown[] = []) => client.readContract({ address, abi: VAULT_ABI, functionName, args } as never) as Promise<T>;
  const optional = <T>(promise: Promise<T>) => promise.catch(() => null);
  const [version, paused, agentExpiry, agent, window, ticks, stop, ready, remainingHsk, remainingUsdt] = await Promise.all([
    optional(read<bigint>("VERSION")),
    read<boolean>("paused"),
    optional(read<number>("agentExpiry")),
    read<Address>("agent"),
    optional(read<number>("twapWindow")),
    optional(read<readonly [boolean, number, number]>("priceGuardTicks")),
    optional(read<readonly [bigint, bigint, number, number, number, boolean, boolean]>("stop")),
    optional(read<boolean>("stopReady")),
    read<bigint>("remaining", [HSKSWAP.whsk]),
    read<bigint>("remaining", [HSKSWAP.usdt]),
  ]);
  input.vault = {
    version,
    paused,
    agentExpiry: agentExpiry === null ? null : BigInt(agentExpiry),
    // The chain's clock, which is the one the vault checks expiry against.
    nowSec: block.timestamp,
    agentGasWei: await client.getBalance({ address: agent }),
    guardOn: (window ?? 0) !== 0,
    oracleOk: ticks?.[0] ?? false,
    stopArmed: stop?.[5] ?? false,
    stopReady: ready ?? false,
    remainingHsk,
    remainingUsdt,
  };
}

const checks = healthChecks(input);
const overall = worstSeverity(checks);
console.log(JSON.stringify({ wallTime: new Date().toISOString(), network: networkProfile().network, vault: config.vault ?? null, overall, checks }, null, 2));
process.exitCode = overall === "critical" ? 2 : overall === "warn" ? 1 : 0;
