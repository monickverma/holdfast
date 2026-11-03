// Chain reads for the arb scan and its replay. Read only: eth_call through Multicall3, pinned to one block hash, so
// every sub-call in one read sees the same state. Signs nothing.
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi, type Address, type Hex } from "viem";
import { ARB_TOKENS, ARB_VENUES, isLocal, venueById, type ArbToken, type PairReserves, type QuoteKey } from "./arb.js";
import { MAINNET_MARKET } from "./config.js";
import type { RpcClient } from "./rpc.js";

/** Any address: neither DODO quote depends on who asks, except its maintainer fee, which is the same for everyone here. */
const TRADER: Address = "0x0000000000000000000000000000000000000001";
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function getReserves() view returns (uint256, uint256, uint256)",
  "function token0() view returns (address)",
  "function getL1Fee(bytes) view returns (uint256)",
  "struct QuoteParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function querySellBase(address trader, uint256 payBaseAmount) view returns (uint256 receiveQuoteAmount, uint256 mtFee)",
  "function querySellQuote(address trader, uint256 payQuoteAmount) view returns (uint256 receiveBaseAmount, uint256 mtFee)",
]);

export interface Sub {
  target: Address;
  data: Hex;
  decode: (data: Hex) => unknown;
}

export const sub = (target: Address, functionName: string, args: unknown[]): Sub => ({
  target,
  data: encodeFunctionData({ abi: ABI as Abi, functionName, args }),
  decode: (data) => decodeFunctionResult({ abi: ABI as Abi, functionName, data }),
});

/** One eth_call of Multicall3 at a block hash. A sub-call that reverts, or answers in a shape we cannot read, is null. */
export async function multicall(rpc: RpcClient, blockHash: Hex, subs: Sub[]): Promise<unknown[]> {
  const data = encodeFunctionData({ abi: ABI, functionName: "aggregate3", args: [subs.map((s) => ({ target: s.target, allowFailure: true, callData: s.data }))] });
  const raw = await rpc.call<Hex>("eth_call", [{ to: MULTICALL3, data }, { blockHash }]);
  const results = decodeFunctionResult({ abi: ABI, functionName: "aggregate3", data: raw });
  return results.map((r, i) => {
    if (!r.success) return null;
    try {
      return subs[i]!.decode(r.returnData);
    } catch {
      return null;
    }
  });
}

/** The call that asks a venue for one quote: the HSKSwap QuoterV2, or DODO's own query functions. */
export function quoteSub(key: QuoteKey): Sub {
  const venue = venueById(key.venue);
  const [a, b] = venue.pair;
  const tokenOut: ArbToken = key.tokenIn === a ? b : a;
  if (venue.kind === "hskswap-v3") {
    return sub(MAINNET_MARKET.quoter, "quoteExactInputSingle", [{ tokenIn: ARB_TOKENS[key.tokenIn], tokenOut: ARB_TOKENS[tokenOut], amountIn: key.amountIn, fee: Number(venue.feePpm), sqrtPriceLimitX96: 0n }]);
  }
  if (venue.kind === "dodo-dvm") return sub(venue.address, key.tokenIn === "WHSK" ? "querySellBase" : "querySellQuote", [TRADER, key.amountIn]);
  throw new Error(`${venue.id} is computed locally`);
}

/** Reads every quote in turn, `chunk` to a call, and writes the answers into `quotes`. Null where the venue refused. */
export async function readQuotes(rpc: RpcClient, blockHash: Hex, keys: readonly QuoteKey[], quotes: Map<string, bigint | null>, keyOf: (k: QuoteKey) => string, chunk = 200): Promise<void> {
  for (let i = 0; i < keys.length; i += chunk) {
    const part = keys.slice(i, i + chunk);
    const answers = await multicall(rpc, blockHash, part.map(quoteSub));
    part.forEach((key, j) => {
      const answer = answers[j] as readonly bigint[] | null;
      quotes.set(keyOf(key), answer ? answer[0]! : null);
    });
  }
}

export const LOCAL_VENUES = ARB_VENUES.filter(isLocal);

/** Which token is each pair's token0. Checked against the pair the venue is listed with, so a wrong address fails. */
export async function readOrientation(rpc: RpcClient, blockHash: Hex): Promise<Map<string, ArbToken>> {
  const token0s = await multicall(rpc, blockHash, LOCAL_VENUES.map((v) => sub(v.address, "token0", [])));
  return new Map(
    LOCAL_VENUES.map((v, i) => {
      const address = String(token0s[i]).toLowerCase();
      const token0 = (Object.keys(ARB_TOKENS) as ArbToken[]).find((t) => ARB_TOKENS[t].toLowerCase() === address);
      if (!token0 || !v.pair.includes(token0)) throw new Error(`${v.id}: token0 ${address} is not one of its pair`);
      return [v.id, token0] as const;
    }),
  );
}

/** Decodes getReserves answers, in LOCAL_VENUES order, into reserves keyed by venue. A pair that did not answer is left out. */
export function reservesFrom(answers: readonly unknown[], orientation: ReadonlyMap<string, ArbToken>): Map<string, PairReserves> {
  const reserves = new Map<string, PairReserves>();
  LOCAL_VENUES.forEach((v, i) => {
    const r = answers[i] as readonly [bigint, bigint, bigint] | null;
    if (r) reserves.set(v.id, { token0: orientation.get(v.id)!, reserve0: r[0], reserve1: r[1] });
  });
  return reserves;
}

export const reservesSubs = (): Sub[] => LOCAL_VENUES.map((v) => sub(v.address, "getReserves", []));
