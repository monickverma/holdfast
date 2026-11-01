export type Severity = "ok" | "warn" | "critical";

export interface HealthCheck {
  name: string;
  severity: Severity;
  detail: string;
}

export interface HealthInput {
  nowMs: number;
  /** The agent's heartbeat file. Null if it has never run here. */
  heartbeat: { wallTime: string; mode: string; errors: number; missedBlocks: number; inFlight: string | null } | null;
  /** Whether an agent is meant to be running here. A read-only check does not care about the heartbeat. */
  expectAgent: boolean;
  chainId: number;
  expectedChainId: number;
  headAgeSec: number;
  rpcLatencyMs: number;
  vault?: {
    version: bigint | null;
    paused: boolean;
    agentExpiry: bigint | null;
    nowSec: bigint;
    agentGasWei: bigint;
    guardOn: boolean;
    oracleOk: boolean;
    stopArmed: boolean;
    stopReady: boolean;
    remainingHsk: bigint;
    remainingUsdt: bigint;
  };
}

/** Enough gas for about this many swaps, at the gas the fork measured and a 1 gwei price. */
const MIN_AGENT_GAS_WEI = 200_000n * 1_000_000_000n * 10n;
const HEARTBEAT_LIMIT_MS = 60_000;
const HEAD_LIMIT_SEC = 30;
const KEY_WARNING_SEC = 86_400n;

/** Pure, so every case can be tested without a chain. What it returns is what wakes someone up. */
export function healthChecks(input: HealthInput): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const add = (name: string, severity: Severity, detail: string) => checks.push({ name, severity, detail });

  add("chain", input.chainId === input.expectedChainId ? "ok" : "critical", `RPC is chain ${input.chainId}, expected ${input.expectedChainId}.`);
  add("head", input.headAgeSec <= HEAD_LIMIT_SEC ? "ok" : "critical", `Latest block is ${input.headAgeSec} s old.`);
  add("rpc", input.rpcLatencyMs <= 2_000 ? "ok" : "warn", `RPC answered in ${input.rpcLatencyMs.toFixed(0)} ms.`);

  if (input.expectAgent) {
    if (!input.heartbeat) add("agent", "critical", "No heartbeat: the agent has not run with this data directory.");
    else {
      const age = input.nowMs - Date.parse(input.heartbeat.wallTime);
      add("agent", age <= HEARTBEAT_LIMIT_MS ? "ok" : "critical", `Heartbeat is ${(age / 1000).toFixed(0)} s old, mode ${input.heartbeat.mode}, ${input.heartbeat.errors} errors, ${input.heartbeat.missedBlocks} missed blocks.`);
      if (input.heartbeat.inFlight) add("in-flight", "warn", `Intent ${input.heartbeat.inFlight} is waiting on the chain.`);
    }
  }

  const vault = input.vault;
  if (!vault) return checks;
  add("paused", vault.paused ? "warn" : "ok", vault.paused ? "The vault is paused, so the agent cannot trade." : "The vault is not paused.");
  if (vault.agentExpiry !== null) {
    const left = vault.agentExpiry - vault.nowSec;
    add("agent-key", left <= 0n ? "critical" : left < KEY_WARNING_SEC ? "warn" : "ok", left <= 0n ? "The agent key has expired or been revoked." : `The agent key has ${left} s left.`);
  }
  add("agent-gas", vault.agentGasWei >= MIN_AGENT_GAS_WEI ? "ok" : "warn", `The agent holds ${vault.agentGasWei} wei for gas.`);
  if (vault.guardOn) add("oracle", vault.oracleOk ? "ok" : "critical", vault.oracleOk ? "The price oracle answers." : "The price oracle is not answering, so the vault refuses every trade.");
  if (vault.stopArmed) add("stop", vault.stopReady ? "critical" : "ok", vault.stopReady ? "The stop has triggered and nobody has fired it. Run the keeper." : "The stop is armed and has not triggered.");
  if (vault.remainingHsk === 0n && vault.remainingUsdt === 0n) add("allowance", "warn", "The agent's lifetime allowance is spent on both tokens.");
  return checks;
}

export function worstSeverity(checks: readonly HealthCheck[]): Severity {
  if (checks.some((c) => c.severity === "critical")) return "critical";
  return checks.some((c) => c.severity === "warn") ? "warn" : "ok";
}
