import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import type { BreakerLimits } from "./breaker.js";

export const CHAIN_ID = 177;
export function networkProfile(env: Record<string, string | undefined> = process.env) {
  const network = env.NETWORK ?? "mainnet";
  if (network !== "mainnet" && network !== "testnet") throw new Error("NETWORK must be mainnet or testnet");
  return { network, chainId: network === "testnet" ? 133 : 177, rpcUrl: network === "testnet" ? "https://testnet.hsk.xyz" : "https://mainnet.hsk.xyz", explorer: network === "testnet" ? "https://testnet-explorer.hskchain.net" : "https://hsk.blockscout.com", lane: network } as const;
}
export function assertTestMarketChain(chainId: number) {
  if (chainId === 177) throw new Error("Refusing test market deployment on chain 177");
  if (chainId !== 133 && chainId !== 31337) throw new Error("Expected testnet 133 or local Anvil 31337");
}
/** Local test runs use their own file, so they can never replace the public testnet manifest. */
export const testMarketFile = () => process.env.TEST_MARKET_FILE ?? "data/testnet-market.json";
export function testMarket() {
  const m = JSON.parse(readFileSync(testMarketFile(), "utf8"));
  for (const key of ["router", "quoter", "pool", "whsk", "usdt", "vault"]) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(m[key])) throw new Error(`Invalid test market ${key}`);
  }
  return m as { router: Address; quoter: Address; pool: Address; whsk: Address; usdt: Address; vault: Address; chainId: number; generation?: number };
}

export const MAINNET_MARKET = {
  router: "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3",
  quoter: "0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD",
  pool: "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc",
  whsk: "0xb210d2120d57b758ee163cffb43e73728c471cf1",
  usdt: "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029",
  fee: 3000,
  gasOracle: "0x420000000000000000000000000000000000000F",
} as const satisfies Record<string, Address | number>;

// Lazy loading lets setup and deployment run before the address manifest exists.
export const HSKSWAP = new Proxy(MAINNET_MARKET, {
  get(target, prop: keyof typeof MAINNET_MARKET) {
    if (networkProfile().network === "mainnet" || prop === "fee" || prop === "gasOracle") return target[prop];
    return testMarket()[prop];
  },
});

export type AgentMode = "observe" | "simulate" | "live";

/** MODE names the mode. LIVE=true is the older spelling of MODE=live, and the two may not disagree. */
export function agentMode(env: Record<string, string | undefined>): AgentMode {
  const mode = env.MODE;
  if (mode === undefined || mode === "") return env.LIVE === "true" ? "live" : "observe";
  if (mode !== "observe" && mode !== "simulate" && mode !== "live") throw new Error("MODE must be observe, simulate or live");
  if (env.LIVE === "true" && mode !== "live") throw new Error(`LIVE=true and MODE=${mode} disagree. Set one.`);
  return mode;
}

export interface Config {
  rpcUrl: string;
  chainId: number;
  vault?: Address;
  /** Absent means the agent can observe and decide but cannot sign. */
  agentKey?: Hex;
  /** Real transactions go out only when this is true. */
  live: boolean;
  /** "observe" reads and decides. "simulate" also asks the vault what it would do, by eth_call. "live" sends. */
  mode?: AgentMode;
  /** Asks the vault by eth_call before signing a trade decided from a sealed block. A refusal then costs no gas. */
  preflight?: boolean;
  /** Who a simulation calls the vault as, when no key is loaded. */
  agentAddress?: Address;
  pollMs: number;
  dataDir: string;
  twapWindowSec: number;
  /** Where to watch flashblocks. Absent means the agent only polls. */
  flashblocksUrl?: string;
  /** Other endpoints to send the same signed bytes to. Empty means one route. */
  hedgeRpcUrls?: string[];
  /** How a frame's logs turn into pool state: real Uniswap V3, or the test market's constant product. */
  poolKind: "v3" | "constant-product";
  /** Refuse a decision when the state it used is older than this. */
  maxStateAgeMs: number;
  /** Refuse a decision when the reference price is older than this. */
  maxMarkAgeMs: number;
  /** True for a vault deployed before key expiry and the hourly budget, which has neither to read. */
  legacyVault?: boolean;
  /** True for a v3 vault, which has a price guard and a daily budget to read. */
  guardedVault?: boolean;
  /** The agent's own stops, inside the vault's. Defaults to BREAKER_DEFAULTS. */
  breaker?: BreakerLimits;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const profile = networkProfile(env);
  const mode = agentMode(env);
  const config: Config = {
    rpcUrl: env.RPC_URL ?? profile.rpcUrl,
    chainId: Number(env.CHAIN_ID ?? profile.chainId),
    live: mode === "live",
    mode,
    preflight: env.PREFLIGHT !== "false",
    guardedVault: env.VAULT_GENERATION !== undefined && Number(env.VAULT_GENERATION) >= 3,
    pollMs: Number(env.POLL_MS ?? 650),
    dataDir: env.DATA_DIR ?? (profile.network === "testnet" ? "data/testnet" : "data"),
    twapWindowSec: Number(env.TWAP_WINDOW_SEC ?? 300),
    maxStateAgeMs: Number(env.MAX_STATE_AGE_MS ?? 6_000),
    maxMarkAgeMs: Number(env.MAX_MARK_AGE_MS ?? 5_000),
    poolKind: profile.network === "testnet" ? "constant-product" : "v3",
    // A custom RPC is a fork or a local node, which has no stream.
    flashblocksUrl: env.FLASHBLOCKS_URL ?? (env.RPC_URL ? undefined : `wss://${profile.network}-flashblocks.hsk.xyz/ws`),
    hedgeRpcUrls: env.HEDGE_RPC_URLS?.split(",").filter(Boolean) ?? [],
  };
  if (profile.network === "testnet") {
    assertTestMarketChain(config.chainId);
    const market = testMarket();
    if (market.chainId !== config.chainId) throw new Error("Test market manifest chain does not match profile; deploy on the selected chain first");
    config.vault = market.vault;
    // The vault on public testnet predates the expiry and budget. A redeployment writes generation 3.
    config.legacyVault = (market.generation ?? 1) < 2;
    config.guardedVault = (market.generation ?? 1) >= 3;
  }
  if (env.VAULT_ADDRESS) config.vault = env.VAULT_ADDRESS as Address;
  if (env.AGENT_PRIVATE_KEY) config.agentKey = env.AGENT_PRIVATE_KEY as Hex;
  return config;
}
