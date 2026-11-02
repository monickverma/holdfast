// Is this the market we think it is? Every check reads the chain, signs nothing, and records who answered.
// A check nobody could answer is not a pass: `verdict` is "unverified", and a live agent will not start on it.
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, type Abi, type Address, type Hex } from "viem";
import { CODE_HASHES, HSKSWAP, type Config } from "./config.js";
import { maxTradeCostWei } from "./preflight.js";
import { sameAddress, VAULT_ABI } from "./reader.js";
import type { RpcClient } from "./rpc.js";

const VENUE_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function factory() view returns (address)",
  "function getPool(address, address, uint24) view returns (address)",
  "function decimals() view returns (uint8)",
  "function router() view returns (address)",
  "function tokenA() view returns (address)",
  "function tokenB() view returns (address)",
  "function poolFee() view returns (uint24)",
  "function balanceOf(address) view returns (uint256)",
]);

export type CheckStatus = "pass" | "warn" | "fail" | "unverified";

export interface VenueCheck {
  name: string;
  status: CheckStatus;
  /** Always a chain read here. The field keeps the report honest if a check is ever added that is not. */
  source: "authoritative" | "analytical";
  detail: string;
}

export interface VenueReport {
  chainId: number | null;
  block: string | null;
  /** The first of fail, unverified, warn, pass that any check reached. Only "pass" and "warn" allow live trading. */
  verdict: CheckStatus;
  checks: VenueCheck[];
}

const WHSK_DECIMALS = 18;
const USDT_DECIMALS = 6;

/** Worst first, so the report's verdict is the worst of its checks. */
const SEVERITY: CheckStatus[] = ["fail", "unverified", "warn", "pass"];

export function worst(checks: readonly Pick<VenueCheck, "status">[]): CheckStatus {
  for (const status of SEVERITY) if (checks.some((c) => c.status === status)) return status;
  return "unverified";
}

export const allowsLive = (report: Pick<VenueReport, "verdict">): boolean => report.verdict === "pass" || report.verdict === "warn";

export async function verifyVenue(rpc: RpcClient, config: Pick<Config, "chainId" | "vault" | "agentKey" | "legacyVault" | "guardedVault" | "agentAddress" | "poolKind">, agentAddress?: Address): Promise<VenueReport> {
  const checks: VenueCheck[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, source: "authoritative", detail });
  const read = async <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T | undefined> => {
    try {
      const raw = await rpc.call<Hex>("eth_call", [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, "latest"]);
      return decodeFunctionResult({ abi, functionName, data: raw }) as T;
    } catch {
      return undefined;
    }
  };
  /** One comparison: unanswered is unverified, different is a failure. */
  const expect = (name: string, actual: unknown, wanted: unknown) => {
    if (actual === undefined) return add(name, "unverified", "No answer from the chain.");
    const same = typeof actual === "string" && typeof wanted === "string" ? actual.toLowerCase() === wanted.toLowerCase() : actual === wanted;
    add(name, same ? "pass" : "fail", same ? `${String(actual)}` : `Read ${String(actual)}, expected ${String(wanted)}.`);
  };

  let chainId: number | null = null;
  let block: string | null = null;
  try {
    chainId = Number(await rpc.call<string>("eth_chainId"));
    block = BigInt(await rpc.call<string>("eth_blockNumber")).toString();
    expect("chain id", chainId, config.chainId);
  } catch {
    add("chain id", "unverified", "The RPC did not answer.");
    return { chainId, block, verdict: "unverified", checks };
  }

  const contracts: Record<string, Address> = { router: HSKSWAP.router, quoter: HSKSWAP.quoter, pool: HSKSWAP.pool, whsk: HSKSWAP.whsk, usdt: HSKSWAP.usdt };
  if (config.vault) contracts.vault = config.vault;
  for (const [name, address] of Object.entries(contracts)) {
    try {
      const code = await rpc.call<Hex>("eth_getCode", [address, "latest"]);
      if (code === "0x") {
        add(`${name} code`, "fail", `No contract at ${address}.`);
        continue;
      }
      const pinned = chainId === 177 ? CODE_HASHES[name] : undefined;
      if (!pinned) add(`${name} code`, "pass", `${(code.length - 2) / 2} bytes at ${address}.`);
      else add(`${name} code`, keccak256(code) === pinned ? "pass" : "fail", keccak256(code) === pinned ? `Matches the pinned hash at ${address}.` : `Hash ${keccak256(code)} differs from the pinned ${pinned}.`);
    } catch {
      add(`${name} code`, "unverified", "The RPC did not answer.");
    }
  }

  expect("whsk decimals", await read<number>(HSKSWAP.whsk, VENUE_ABI, "decimals"), WHSK_DECIMALS);
  expect("usdt decimals", await read<number>(HSKSWAP.usdt, VENUE_ABI, "decimals"), USDT_DECIMALS);
  expect("pool token0", await read<Address>(HSKSWAP.pool, VENUE_ABI, "token0"), HSKSWAP.whsk);
  expect("pool token1", await read<Address>(HSKSWAP.pool, VENUE_ABI, "token1"), HSKSWAP.usdt);
  expect("pool fee", await read<number>(HSKSWAP.pool, VENUE_ABI, "fee"), HSKSWAP.fee);

  // The test market has no factory. On a real V3 venue the factory is what says this pool belongs to this pair.
  if (config.poolKind === "v3") {
    const factory = await read<Address>(HSKSWAP.pool, VENUE_ABI, "factory");
    if (factory === undefined) add("pool factory", "unverified", "The pool did not name a factory.");
    else {
      expect("factory lists this pool", await read<Address>(factory, VENUE_ABI, "getPool", [HSKSWAP.whsk, HSKSWAP.usdt, HSKSWAP.fee]), HSKSWAP.pool);
      expect("router's factory", await read<Address>(HSKSWAP.router, VENUE_ABI, "factory"), factory);
    }
  }

  if (config.vault) await checkVault(config.vault, config, chainId, read, expect, add, rpc, agentAddress);
  return { chainId, block, verdict: worst(checks), checks };
}

/** The vault must be wired to this venue, and its settings must be ones a person would want. */
async function checkVault(
  vault: Address,
  config: Pick<Config, "legacyVault" | "guardedVault">,
  chainId: number,
  read: <T>(address: Address, abi: Abi, functionName: string, args?: unknown[]) => Promise<T | undefined>,
  expect: (name: string, actual: unknown, wanted: unknown) => void,
  add: (name: string, status: CheckStatus, detail: string) => void,
  rpc: RpcClient,
  agentAddress?: Address,
): Promise<void> {
  expect("vault router", await read<Address>(vault, VENUE_ABI, "router"), HSKSWAP.router);
  expect("vault token A", await read<Address>(vault, VENUE_ABI, "tokenA"), HSKSWAP.whsk);
  expect("vault token B", await read<Address>(vault, VENUE_ABI, "tokenB"), HSKSWAP.usdt);
  expect("vault fee", await read<number>(vault, VENUE_ABI, "poolFee"), HSKSWAP.fee);

  const owner = await read<Address>(vault, VAULT_ABI as Abi, "owner");
  const agent = await read<Address>(vault, VAULT_ABI as Abi, "agent");
  if (agentAddress) expect("this key is the vault's agent", agent, agentAddress);
  if (owner === undefined || agent === undefined) add("owner and agent are separate", "unverified", "The vault did not answer.");
  else add("owner and agent are separate", sameAddress(owner, agent) ? "fail" : "pass", sameAddress(owner, agent) ? "One key is both, so a stolen agent key could withdraw everything." : `Owner ${owner}, agent ${agent}.`);

  const paused = await read<boolean>(vault, VAULT_ABI as Abi, "paused");
  if (paused === undefined) add("trading open", "unverified", "The vault did not answer.");
  else add("trading open", paused ? "warn" : "pass", paused ? "The vault is paused." : "Not paused.");

  if (!config.legacyVault) {
    const expiry = await read<number>(vault, VAULT_ABI as Abi, "agentExpiry");
    const now = Math.floor(Date.now() / 1000);
    if (expiry === undefined) add("agent key valid", "unverified", "The vault did not answer.");
    else add("agent key valid", Number(expiry) > now ? "pass" : "fail", `Expires at ${Number(expiry)}, now ${now}.`);
  }

  for (const [symbol, token] of [["whsk", HSKSWAP.whsk], ["usdt", HSKSWAP.usdt]] as const) {
    const [maxTrade, floor] = await Promise.all([read<bigint>(vault, VAULT_ABI as Abi, "maxTrade", [token]), read<bigint>(vault, VAULT_ABI as Abi, "floorPriceX18", [token])]);
    if (maxTrade === undefined || floor === undefined) add(`${symbol} limits`, "unverified", "The vault did not answer.");
    else if (maxTrade === 0n) add(`${symbol} limits`, "warn", "No trade cap is set, so this token cannot be traded.");
    else add(`${symbol} limits`, floor === 0n ? "fail" : "pass", floor === 0n ? "A cap with no floor lets the agent sell at any price." : `Cap ${maxTrade}, floor ${floor}.`);
  }

  if (config.guardedVault) {
    const [guardian, window] = await Promise.all([read<Address>(vault, VAULT_ABI as Abi, "guardian"), read<number>(vault, VAULT_ABI as Abi, "twapWindow")]);
    const onMainnet = chainId === 177;
    if (guardian === undefined) add("guardian", "unverified", "The vault did not answer.");
    else add("guardian", /^0x0+$/.test(guardian) ? (onMainnet ? "fail" : "warn") : "pass", /^0x0+$/.test(guardian) ? "No guardian is set." : guardian);
    if (window === undefined) add("price guard", "unverified", "The vault did not answer.");
    else add("price guard", window === 0 ? (onMainnet ? "fail" : "warn") : "pass", window === 0 ? "The guard is off, so a stolen key could sell into a pushed pool down to the floor." : `On, over ${window} s.`);
  }

  const version = await read<bigint>(vault, VAULT_ABI as Abi, "VERSION");
  if (version !== undefined && version >= 4n) {
    const onMainnet = chainId === 177;
    const [lossOn, terms, pin] = await Promise.all([read<boolean>(vault, VAULT_ABI as Abi, "lossGuardOn"), read<readonly [bigint, bigint, number, number]>(vault, VAULT_ABI as Abi, "lossTerms"), read<Hex>(vault, VAULT_ABI as Abi, "strategyPin")]);
    if (lossOn === undefined || terms === undefined) add("loss guard", "unverified", "The vault did not answer.");
    else if (!lossOn) add("loss guard", onMainnet ? "fail" : "warn", "No daily loss budget is set, so nothing on chain bounds losses across trades.");
    else {
      const [mark, budget, maxAge, setAt] = terms;
      const stale = maxAge !== 0 && Math.floor(Date.now() / 1000) > setAt + maxAge;
      add("loss guard", stale ? "warn" : "pass", stale ? `The owner's mark is older than ${maxAge} s, so the vault refuses trades until it is reset. Withdrawals still work.` : `Mark ${mark}, budget ${budget} a day.`);
    }
    if (pin !== undefined) add("strategy pin", "pass", /^0x0+$/.test(pin) ? "None. Any policy the agent loads may trade." : `Trades need the policy with hash ${pin}.`);
  }
  if (agentAddress) {
    try {
      const [balance, gasPrice] = await Promise.all([rpc.call<string>("eth_getBalance", [agentAddress, "latest"]), rpc.call<string>("eth_gasPrice")]);
      const need = maxTradeCostWei({ head: { baseFeePerGas: BigInt(gasPrice), number: 0n, hash: "0x", timestamp: 0n }, priorityFeePerGas: 0n, l1FeeWei: 0n });
      add("agent gas", BigInt(balance) >= need ? "pass" : "warn", `${BigInt(balance)} wei held, about ${need} needed up front per trade.`);
    } catch {
      add("agent gas", "unverified", "The RPC did not answer.");
    }
  }
}
