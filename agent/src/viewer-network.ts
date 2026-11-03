// The public viewer has two fixed read contexts. A visitor cannot supply RPC URLs or vaults.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAddress, type Address } from "viem";
import { MAINNET_MARKET, networkProfile, type MarketAddresses } from "./config.js";

export type Network = "mainnet" | "testnet";
export function viewerNetwork(network: Network, evidenceDir: string) {
  const profile = networkProfile({ NETWORK: network });
  const read = (name: string) => { try { return JSON.parse(readFileSync(join(evidenceDir, name), "utf8")); } catch { return {}; } };
  const manifest = read(network === "mainnet" ? "v4/mainnet-deployment.json" : "v3/testnet-deployment.json");
  const address: string | undefined = network === "mainnet" ? manifest.toolRecord?.vault : manifest.vault;
  const validAddress = typeof address === "string" && isAddress(address) ? address : undefined;
  const market: MarketAddresses = { ...MAINNET_MARKET };
  if (network === "testnet") {
    // An absent manifest leaves no available vault. Invalid addresses never fall back to mainnet.
    for (const key of ["router", "quoter", "pool", "whsk", "usdt"] as const) {
      market[key] = typeof manifest[key] === "string" && isAddress(manifest[key]) ? manifest[key] : "0x0000000000000000000000000000000000000000" as Address;
    }
  }
  const generation = network === "mainnet" ? 4 : 3;
  return {
    profile, market, address: validAddress, generation,
    deployment: {
      network, chainId: profile.chainId, address: validAddress ?? null, generation,
      explorer: profile.explorer,
      transaction: /^0x[\da-f]{64}$/i.test(manifest.toolRecord?.txHash ?? "") ? manifest.toolRecord.txHash as string : null,
      deployedAt: typeof manifest.receipt?.blockTime === "string" ? manifest.receipt.blockTime as string : null,
      source: network === "mainnet" ? "evidence/v4/mainnet-deployment.json" : "evidence/v3/testnet-deployment.json",
    },
  };
}
export type ViewerNetwork = ReturnType<typeof viewerNetwork>;
