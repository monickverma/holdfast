import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi, type Address, type Hex } from "viem";
import { HSKSWAP, type Config } from "./config.js";
import type { RpcCall, RpcClient } from "./rpc.js";

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);
const QUOTER_ABI = parseAbi([
  "struct QuoteParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
export const VAULT_ABI = parseAbi([
  "function paused() view returns (bool)",
  "function agent() view returns (address)",
  "function owner() view returns (address)",
  "function maxTrade(address) view returns (uint256)",
  "function remaining(address) view returns (uint256)",
  "function floorPriceX18(address) view returns (uint256)",
  "function usedIntent(bytes32) view returns (bool)",
  "function execute(address tokenIn, uint256 amountIn, uint256 minOut, uint256 deadline, bytes32 intentId) returns (uint256 amountOut)",
  "function pause()",
  "function unpause()",
  "function setAgent(address agent_)",
  "function setLimits(address token, uint256 maxTrade_, uint256 remaining_, uint256 floorPriceX18_)",
  "function withdraw(address token, address to, uint256 amount)",
  "event Traded(bytes32 indexed intentId, address indexed tokenIn, uint256 amountIn, uint256 amountOut, uint256 remainingAfter)",
  "error NotOwner()",
  "error NotAgent()",
  "error NotOwnerOrAgent()",
  "error IsPaused()",
  "error Reentered()",
  "error BadToken()",
  "error BadAmount()",
  "error BadDeadline()",
  "error IntentUsed()",
  "error OverTradeCap()",
  "error OverLifetimeCap()",
  "error BelowFloor()",
  "error InsufficientOutput()",
  "error Overspent()",
  "error TokenCallFailed()",
  "error ZeroAddress()",
]);

/** A representative signed execute() for the L1 data fee estimate. */
const SAMPLE_TX: Hex = `0x${"a5".repeat(200)}`;

export interface Head {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  baseFeePerGas: bigint;
}

export interface QuoteRequest {
  tokenIn: Address;
  amountIn: bigint;
}

export interface Quote extends QuoteRequest {
  amountOut: bigint;
  ticksCrossed: number;
}

export interface TokenLimits {
  balance: bigint;
  maxTrade: bigint;
  remaining: bigint;
  floorPriceX18: bigint;
}

export interface VaultState {
  paused: boolean;
  whsk: TokenLimits;
  usdt: TokenLimits;
}

export interface MarketState {
  head: Head;
  sqrtPriceX96: bigint;
  tick: number;
  twapTick: number;
  liquidity: bigint;
  /** USDT base units per 1e18 WHSK wei, at spot. */
  spotPriceX18: bigint;
  quotes: Quote[];
  priorityFeePerGas: bigint;
  l1FeeWei: bigint;
  vault?: VaultState;
}

export async function readHead(rpc: RpcClient): Promise<Head> {
  const block = await rpc.call<RawBlock | null>("eth_getBlockByNumber", ["latest", false]);
  return parseHead(block);
}

export async function readHeadByNumber(rpc: RpcClient, number: bigint): Promise<Head> {
  const block = await rpc.call<RawBlock | null>("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]);
  return parseHead(block);
}

/** Reads everything for one decision in one batch, every call pinned to the same block hash. */
export async function readMarket(
  rpc: RpcClient,
  config: Pick<Config, "vault" | "twapWindowSec">,
  head: Head,
  quoteRequests: QuoteRequest[],
): Promise<MarketState> {
  const pin = { blockHash: head.hash };
  const pool = HSKSWAP.pool;
  const calls: Decoder[] = [
    contractCall(pool, POOL_ABI, "slot0", [], pin),
    contractCall(pool, POOL_ABI, "liquidity", [], pin),
    contractCall(pool, POOL_ABI, "observe", [[config.twapWindowSec, 0]], pin),
    // Local Anvil has no fee oracle. Public testnet has the same predeploy as mainnet.
    process.env.TEST_MARKET_LOCAL === "1"
      ? { call: { method: "eth_chainId", params: [] }, decode: () => 0n }
      : contractCall(HSKSWAP.gasOracle, ORACLE_ABI, "getL1Fee", [SAMPLE_TX], pin),
    { call: { method: "eth_maxPriorityFeePerGas", params: [] }, decode: (raw) => BigInt(raw as string) },
  ];
  for (const request of quoteRequests) {
    calls.push(
      contractCall(
        HSKSWAP.quoter,
        QUOTER_ABI,
        "quoteExactInputSingle",
        [
          {
            tokenIn: request.tokenIn,
            tokenOut: otherToken(request.tokenIn),
            amountIn: request.amountIn,
            fee: HSKSWAP.fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
        pin,
      ),
    );
  }
  const vaultStart = calls.length;
  if (config.vault) {
    const vault = config.vault;
    calls.push(contractCall(vault, VAULT_ABI, "paused", [], pin));
    for (const token of [HSKSWAP.whsk, HSKSWAP.usdt]) {
      calls.push(
        contractCall(token, ERC20_ABI, "balanceOf", [vault], pin),
        contractCall(vault, VAULT_ABI, "maxTrade", [token], pin),
        contractCall(vault, VAULT_ABI, "remaining", [token], pin),
        contractCall(vault, VAULT_ABI, "floorPriceX18", [token], pin),
      );
    }
  }

  const raw = await rpc.batch(calls.map((c) => c.call));
  const values = raw.map((value, i) => calls[i]!.decode(value));

  const [sqrtPriceX96, tick] = values[0] as readonly [bigint, number];
  const [tickCumulatives] = values[2] as readonly [readonly bigint[], readonly bigint[]];
  const elapsed = BigInt(config.twapWindowSec);
  const twapTick = Number((tickCumulatives[1]! - tickCumulatives[0]!) / elapsed);

  const quotes: Quote[] = quoteRequests.map((request, i) => {
    const [amountOut, , ticksCrossed] = values[5 + i] as readonly [bigint, bigint, number, bigint];
    return { ...request, amountOut, ticksCrossed };
  });

  const market: MarketState = {
    head,
    sqrtPriceX96,
    tick,
    twapTick,
    liquidity: values[1] as bigint,
    spotPriceX18: spotPriceX18(sqrtPriceX96),
    quotes,
    l1FeeWei: values[3] as bigint,
    priorityFeePerGas: values[4] as bigint,
  };
  if (config.vault) {
    const limits = (start: number): TokenLimits => ({
      balance: values[start] as bigint,
      maxTrade: values[start + 1] as bigint,
      remaining: values[start + 2] as bigint,
      floorPriceX18: values[start + 3] as bigint,
    });
    market.vault = {
      paused: values[vaultStart] as boolean,
      whsk: limits(vaultStart + 1),
      usdt: limits(vaultStart + 5),
    };
  }
  return market;
}

/** Output per 1e18 input base units for WHSK to USDT, where WHSK is token0 of the pool. */
export function spotPriceX18(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n;
}

export function otherToken(token: Address): Address {
  return sameAddress(token, HSKSWAP.whsk) ? HSKSWAP.usdt : HSKSWAP.whsk;
}

export function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

interface RawBlock {
  number: Hex;
  hash: Hex;
  timestamp: Hex;
  baseFeePerGas?: Hex;
}

interface Decoder {
  call: RpcCall;
  decode: (raw: unknown) => unknown;
}

function parseHead(block: RawBlock | null): Head {
  if (!block) throw new Error("block not found");
  return {
    number: BigInt(block.number),
    hash: block.hash,
    timestamp: BigInt(block.timestamp),
    baseFeePerGas: BigInt(block.baseFeePerGas ?? 0),
  };
}

function contractCall(to: Address, abi: Abi, functionName: string, args: unknown[], pin: { blockHash: Hex }): Decoder {
  const data = encodeFunctionData({ abi, functionName, args });
  return {
    call: { method: "eth_call", params: [{ to, data }, pin] },
    decode: (raw) => decodeFunctionResult({ abi, functionName, data: raw as Hex }),
  };
}
