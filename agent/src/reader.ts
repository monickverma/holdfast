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
  "function agentExpiry() view returns (uint40)",
  "function hourlyBudget(address) view returns (uint256)",
  "function budgetAvailable(address) view returns (uint256)",
  "function setAgent(address agent_, uint256 expiry_)",
  "function setLimits(address token, uint256 maxTrade_, uint256 remaining_, uint256 floorPriceX18_, uint256 hourlyBudget_)",
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
  "error OverHourlyBudget()",
  "error AgentExpired()",
  "error BadExpiry()",
  "error BelowFloor()",
  "error InsufficientOutput()",
  "error Overspent()",
  "error TokenCallFailed()",
  "error ZeroAddress()",
  "error LimitTooLarge()",
]);

const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getBlockNumber() view returns (uint256 blockNumber)",
  "function getLastBlockHash() view returns (bytes32 blockHash)",
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
  hourlyBudget: bigint;
  /** What the hourly budget allows right now. */
  available: bigint;
}

export interface VaultState {
  paused: boolean;
  /** When the agent key stops working. Null on a vault from before expiry existed. */
  agentExpiry: bigint | null;
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

/** The test market's reserves at a block: what its two tokens' balances say the pool holds. */
export async function poolReserves(rpc: RpcClient, block: bigint): Promise<{ kind: "constant-product"; reserve0: bigint; reserve1: bigint }> {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [HSKSWAP.pool] });
  const tag = `0x${block.toString(16)}`;
  const [reserve0, reserve1] = await rpc.batch([
    { method: "eth_call", params: [{ to: HSKSWAP.whsk, data }, tag] },
    { method: "eth_call", params: [{ to: HSKSWAP.usdt, data }, tag] },
  ]);
  return { kind: "constant-product", reserve0: BigInt(reserve0 as string), reserve1: BigInt(reserve1 as string) };
}

/** Reads everything for one decision in one batch, every call pinned to the same block hash. */
export async function readMarket(
  rpc: RpcClient,
  config: Pick<Config, "vault" | "twapWindowSec" | "legacyVault">,
  head: Head,
  quoteRequests: QuoteRequest[],
): Promise<MarketState> {
  const pin = { blockHash: head.hash };
  const reads = marketReads(config, quoteRequests);
  const calls: RpcCall[] = reads.map((read) => read.call ?? ethCall(read.target!, read.data!, pin));
  calls.push({ method: "eth_maxPriorityFeePerGas", params: [] });
  const raw = await rpc.batch(calls);
  const values = reads.map((read, i) => read.decode(raw[i]));
  return buildMarket(config, head, quoteRequests, values, BigInt(raw[reads.length] as string));
}

export function hasMulticall(rpc: RpcClient): Promise<boolean> {
  return rpc.call<string>("eth_getCode", [MULTICALL3, "latest"]).then((code) => code !== "0x");
}

export interface Tick {
  market: MarketState;
  /** The chain's pending nonce for `nonceOf`, read in the same round trip. */
  pendingNonce?: number;
}

/**
 * The head, every state read and the nonce in one round trip. One Multicall3 eth_call executes against a single
 * state, so its reads cannot straddle two blocks. The block returned beside it is accepted only when that call proves
 * it ran on that block; otherwise this returns null and the caller falls back to the pinned read.
 */
export async function readTick(
  rpc: RpcClient,
  config: Pick<Config, "vault" | "twapWindowSec" | "legacyVault">,
  quoteRequests: QuoteRequest[],
  nonceOf?: Address,
): Promise<Tick | null> {
  const reads = marketReads(config, quoteRequests).filter((read) => read.target);
  const proof = [
    { target: MULTICALL3, allowFailure: false, callData: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "getBlockNumber" }) },
    { target: MULTICALL3, allowFailure: false, callData: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "getLastBlockHash" }) },
  ];
  const data = encodeFunctionData({
    abi: MULTICALL_ABI,
    functionName: "aggregate3",
    args: [[...proof, ...reads.map((read) => ({ target: read.target!, allowFailure: false, callData: read.data! }))]],
  });
  const [block, aggregate, priorityFee, nonce] = await rpc.batch([
    { method: "eth_getBlockByNumber", params: ["latest", false] },
    ethCall(MULTICALL3, data, "latest"),
    { method: "eth_maxPriorityFeePerGas", params: [] },
    ...(nonceOf ? [{ method: "eth_getTransactionCount", params: [nonceOf, "pending"] }] : []),
  ]);
  const rawBlock = block as RawBlock | null;
  const head = parseHead(rawBlock);
  const results = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: aggregate as Hex });
  const ranOn = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "getBlockNumber", data: results[0]!.returnData });
  const ranAfter = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "getLastBlockHash", data: results[1]!.returnData });
  if (ranOn !== head.number || ranAfter !== rawBlock!.parentHash) return null;

  const values: unknown[] = [];
  let next = 2;
  for (const read of marketReads(config, quoteRequests)) values.push(read.target ? read.decode(results[next++]!.returnData) : read.decode(undefined));
  const market = buildMarket(config, head, quoteRequests, values, BigInt(priorityFee as string));
  return nonceOf ? { market, pendingNonce: Number(nonce as string) } : { market };
}

/** Every value a decision needs, in the fixed order buildMarket expects. */
function marketReads(config: Pick<Config, "vault" | "twapWindowSec" | "legacyVault">, quoteRequests: QuoteRequest[]): MarketRead[] {
  const pool = HSKSWAP.pool;
  const reads: MarketRead[] = [
    contractRead(pool, POOL_ABI, "slot0", []),
    contractRead(pool, POOL_ABI, "liquidity", []),
    contractRead(pool, POOL_ABI, "observe", [[config.twapWindowSec, 0]]),
    // Local Anvil has no fee oracle. Public testnet has the same predeploy as mainnet.
    process.env.TEST_MARKET_LOCAL === "1"
      ? { call: { method: "eth_chainId", params: [] }, decode: () => 0n }
      : contractRead(HSKSWAP.gasOracle, ORACLE_ABI, "getL1Fee", [SAMPLE_TX]),
  ];
  for (const request of quoteRequests) {
    reads.push(
      contractRead(HSKSWAP.quoter, QUOTER_ABI, "quoteExactInputSingle", [
        {
          tokenIn: request.tokenIn,
          tokenOut: otherToken(request.tokenIn),
          amountIn: request.amountIn,
          fee: HSKSWAP.fee,
          sqrtPriceLimitX96: 0n,
        },
      ]),
    );
  }
  if (config.vault) {
    const vault = config.vault;
    reads.push(contractRead(vault, VAULT_ABI, "paused", []));
    if (!config.legacyVault) reads.push(contractRead(vault, VAULT_ABI, "agentExpiry", []));
    for (const token of [HSKSWAP.whsk, HSKSWAP.usdt]) {
      reads.push(
        contractRead(token, ERC20_ABI, "balanceOf", [vault]),
        contractRead(vault, VAULT_ABI, "maxTrade", [token]),
        contractRead(vault, VAULT_ABI, "remaining", [token]),
        contractRead(vault, VAULT_ABI, "floorPriceX18", [token]),
      );
      if (!config.legacyVault) reads.push(contractRead(vault, VAULT_ABI, "hourlyBudget", [token]), contractRead(vault, VAULT_ABI, "budgetAvailable", [token]));
    }
  }
  return reads;
}

function buildMarket(
  config: Pick<Config, "vault" | "twapWindowSec" | "legacyVault">,
  head: Head,
  quoteRequests: QuoteRequest[],
  values: unknown[],
  priorityFeePerGas: bigint,
): MarketState {
  const [sqrtPriceX96, tick] = values[0] as readonly [bigint, number];
  const [tickCumulatives] = values[2] as readonly [readonly bigint[], readonly bigint[]];
  const elapsed = BigInt(config.twapWindowSec);
  const twapTick = arithmeticMeanTick(tickCumulatives[1]! - tickCumulatives[0]!, elapsed);

  const quotes: Quote[] = quoteRequests.map((request, i) => {
    const [amountOut, , ticksCrossed] = values[4 + i] as readonly [bigint, bigint, number, bigint];
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
    priorityFeePerGas,
  };
  if (config.vault) {
    const vaultStart = 4 + quoteRequests.length;
    const legacy = config.legacyVault === true;
    const limits = (start: number): TokenLimits => {
      const remaining = values[start + 2] as bigint;
      return {
        balance: values[start] as bigint,
        maxTrade: values[start + 1] as bigint,
        remaining,
        floorPriceX18: values[start + 3] as bigint,
        hourlyBudget: legacy ? remaining : (values[start + 4] as bigint),
        available: legacy ? remaining : (values[start + 5] as bigint),
      };
    };
    const first = vaultStart + (legacy ? 1 : 2);
    market.vault = {
      paused: values[vaultStart] as boolean,
      agentExpiry: legacy ? null : BigInt(values[vaultStart + 1] as number),
      whsk: limits(first),
      usdt: limits(first + (legacy ? 4 : 6)),
    };
  }
  return market;
}

/** Uniswap rounds a negative fractional mean tick toward negative infinity. */
export function arithmeticMeanTick(delta: bigint, elapsed: bigint): number {
  let tick = delta / elapsed;
  if (delta < 0n && delta % elapsed !== 0n) tick--;
  return Number(tick);
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
  parentHash: Hex;
  timestamp: Hex;
  baseFeePerGas?: Hex;
}

interface MarketRead {
  /** A contract read, or a plain RPC call when there is no contract to ask. */
  target?: Address;
  data?: Hex;
  call?: RpcCall;
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

function ethCall(to: Address, data: Hex, block: { blockHash: Hex } | "latest"): RpcCall {
  return { method: "eth_call", params: [{ to, data }, block] };
}

function contractRead(target: Address, abi: Abi, functionName: string, args: unknown[]): MarketRead {
  return {
    target,
    data: encodeFunctionData({ abi, functionName, args }),
    decode: (raw) => decodeFunctionResult({ abi, functionName, data: raw as Hex }),
  };
}
