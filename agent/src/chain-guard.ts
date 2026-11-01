export const MAINNET_CHAIN_ID = 177;

/**
 * Called before anything is signed for sending. The RPC must be the chain the configuration names, and mainnet needs
 * an extra, explicit flag, so a stray environment variable cannot turn a rehearsal into real money.
 */
export function assertChainForBroadcast(rpcChainId: number, expectedChainId: number, confirmedMainnet: boolean): void {
  if (rpcChainId !== expectedChainId) throw new Error(`The RPC is chain ${rpcChainId}, but this run is configured for ${expectedChainId}. Nothing was sent.`);
  if (rpcChainId === MAINNET_CHAIN_ID && !confirmedMainnet) throw new Error("This would send on HSK mainnet with real funds. Add --confirm-mainnet if that is what you mean. Nothing was sent.");
}

export function explorerFor(chainId: number): string | null {
  if (chainId === MAINNET_CHAIN_ID) return "https://hsk.blockscout.com";
  if (chainId === 133) return "https://testnet-explorer.hskchain.net";
  return null;
}
