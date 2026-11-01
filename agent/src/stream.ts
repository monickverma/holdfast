import { performance } from "node:perf_hooks";
import { brotliDecompressSync } from "node:zlib";
import { decodeAbiParameters, parseAbiParameters, toEventSelector, type Address, type Hex } from "viem";
import { sameAddress, spotPriceX18, type MarketState, type Quote, type QuoteRequest } from "./reader.js";

/** Uniswap V3 Swap(address,address,int256,int256,uint160,uint128,int24). */
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
/** ERC-20 Transfer(address,address,uint256). */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SWAP_DATA = parseAbiParameters("int256, int256, uint160, uint128, int24");
const MINT_TOPIC = toEventSelector("Mint(address,address,int24,int24,uint128,uint256,uint256)");
const BURN_TOPIC = toEventSelector("Burn(address,int24,int24,uint128,uint256,uint256)");
const Q96 = 2n ** 96n;
const FEE_DENOMINATOR = 1_000_000n;
/** Uniswap V3 tick spacing for the 0.3% fee tier. No tick can be initialized between two multiples of this. */
const TICK_SPACING = 60;
const TICK_BASE = Math.log(1.0001);

export interface FlashLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  logIndex?: string | number;
}

/** One flashblock. Its contents are a preconfirmation: visible about 200 ms apart, but not yet a sealed block. */
export interface Frame {
  block: bigint;
  index: number;
  /** Only the first frame of a block carries these. */
  timestamp?: bigint;
  baseFeePerGas?: bigint;
  logs: FlashLog[];
  logsOrdered?: boolean;
  /** Monotonic time this process received the frame. Reaction latency starts here. */
  arrivedAt: number;
  /** The builder's view after this frame, for checking it against the sealed block. */
  payloadId?: string;
  blockHash?: Hex;
  transactions?: Hex[];
}

export function decodeFrame(raw: string | ArrayBuffer | Uint8Array, arrivedAt: number = performance.now()): Frame {
  const message = JSON.parse(typeof raw === "string" ? raw : frameText(raw)) as RawFrame;
  if (!Number.isSafeInteger(message.index) || message.index < 0 || message.index > 10 || !message.metadata || message.metadata.block_number == null) throw new Error("invalid frame envelope");
  const receipts: RawReceipt[] = [];
  for (const receipt of Object.values(message.metadata?.receipts ?? {})) {
    // Some builders wrap a receipt in an object keyed by its transaction type.
    const body = ("logs" in receipt ? receipt : Object.values(receipt)[0]) as RawReceipt | undefined;
    if (body?.logs?.length) receipts.push(body);
  }
  let logs = receipts.flatMap((receipt) => receipt.logs!);
  let logsOrdered = receipts.length <= 1;
  if (!logsOrdered) {
    if (receipts.every((receipt) => receipt.cumulativeGasUsed !== undefined)) {
      const ordered = receipts.map((receipt) => ({ receipt, gas: BigInt(receipt.cumulativeGasUsed!) })).sort((a, b) => a.gas < b.gas ? -1 : a.gas > b.gas ? 1 : 0);
      logsOrdered = ordered.every((entry, i) => entry.gas >= 0n && (i === 0 || entry.gas > ordered[i - 1]!.gas));
      if (logsOrdered) logs = ordered.flatMap(({ receipt }) => receipt.logs!);
    } else if (logs.every((log) => log.logIndex !== undefined)) {
      const ordered = logs.map((log) => ({ log, index: BigInt(log.logIndex!) })).sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : 0);
      logsOrdered = ordered.every((entry, i) => entry.index >= 0n && (i === 0 || entry.index > ordered[i - 1]!.index));
      if (logsOrdered) logs = ordered.map(({ log }) => log);
    }
  }
  return {
    block: BigInt(message.metadata.block_number),
    index: message.index,
    timestamp: message.base ? BigInt(message.base.timestamp) : undefined,
    baseFeePerGas: message.base ? BigInt(message.base.base_fee_per_gas) : undefined,
    logs,
    logsOrdered,
    arrivedAt,
    payloadId: message.payload_id,
    blockHash: message.diff?.block_hash,
    transactions: message.diff?.transactions,
  };
}

export type StreamBreak = "index-gap" | "repeated-index" | "payload-change" | "missing-first" | "block-gap" | "out-of-order" | "reconnect" | "malformed";

/** Only the previous envelope is needed to check the next frame. */
export class FrameContinuity {
  private previous: Pick<Frame, "block" | "index" | "payloadId"> | null = null;

  reset(): void { this.previous = null; }

  observe(frame: Frame): StreamBreak | null {
    const previous = this.previous;
    this.previous = { block: frame.block, index: frame.index, payloadId: frame.payloadId };
    if (!frame.payloadId) return "malformed";
    if (!previous) return frame.index === 0 ? null : "missing-first";
    if (frame.block < previous.block) return "out-of-order";
    if (frame.block === previous.block) {
      if (frame.payloadId !== previous.payloadId) return "payload-change";
      if (frame.index <= previous.index) return "repeated-index";
      return frame.index === previous.index + 1 ? null : "index-gap";
    }
    if (frame.index !== 0) return "missing-first";
    return frame.block === previous.block + 1n ? null : "block-gap";
  }
}

/** The price state a pool holds after this frame, for a V3 pool. Null when the frame did not touch the pool. */
export function lastSwap(frame: Frame, pool: Address): V3PoolState | null {
  if (frame.logsOrdered === false) return null;
  let state: V3PoolState | null = null;
  for (const log of frame.logs) {
    if (sameAddress(log.address, pool) && (log.topics[0] === MINT_TOPIC || log.topics[0] === BURN_TOPIC)) return null;
    if (log.topics[0] !== SWAP_TOPIC || !sameAddress(log.address, pool)) continue;
    const [, , sqrtPriceX96, liquidity, tick] = decodeAbiParameters(SWAP_DATA, log.data);
    state = { kind: "v3", sqrtPriceX96, liquidity, tick };
  }
  return state;
}

export function liquidityChanged(frame: Frame, pool: Address): boolean {
  return frame.logs.some((log) => (log.topics[0] === MINT_TOPIC || log.topics[0] === BURN_TOPIC) && sameAddress(log.address, pool));
}

/** Net token movement into a pool in this frame. The test market emits no Swap event, only token transfers. */
export function poolTransfers(frame: Frame, pool: Address, token0: Address, token1: Address): { delta0: bigint; delta1: bigint } | null {
  let delta0 = 0n;
  let delta1 = 0n;
  let touched = false;
  const word = pool.toLowerCase().slice(2);
  for (const log of frame.logs) {
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const zero = sameAddress(log.address, token0);
    if (!zero && !sameAddress(log.address, token1)) continue;
    const into = log.topics[2]?.toLowerCase().endsWith(word) ?? false;
    const outOf = log.topics[1]?.toLowerCase().endsWith(word) ?? false;
    if (into === outOf) continue;
    const amount = BigInt(log.data) * (into ? 1n : -1n);
    if (zero) delta0 += amount;
    else delta1 += amount;
    touched = true;
  }
  return touched ? { delta0, delta1 } : null;
}

export interface V3PoolState {
  kind: "v3";
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
}

export interface ConstantProductState {
  kind: "constant-product";
  reserve0: bigint;
  reserve1: bigint;
}

export type PoolState = V3PoolState | ConstantProductState;

/**
 * The exact Uniswap V3 output for a swap that stays inside the current tick range. Returns null when the swap could
 * reach another initialized tick, because this math would be wrong there and the caller must ask the Quoter instead.
 */
export function v3Quote(state: V3PoolState, zeroForOne: boolean, amountIn: bigint, fee: number): bigint | null {
  const { sqrtPriceX96: price, liquidity } = state;
  if (liquidity === 0n || amountIn <= 0n) return null;
  const net = (amountIn * (FEE_DENOMINATOR - BigInt(fee))) / FEE_DENOMINATOR;
  let next: bigint;
  let out: bigint;
  if (zeroForOne) {
    const numerator = liquidity << 96n;
    const denominator = numerator + net * price;
    next = (numerator * price + denominator - 1n) / denominator;
    out = (liquidity * (price - next)) / Q96;
  } else {
    next = price + (net * Q96) / liquidity;
    out = ((liquidity << 96n) * (next - price)) / next / price;
  }
  const low = Math.floor(state.tick / TICK_SPACING) * TICK_SPACING;
  const after = 2 * (Math.log(Number(next) / 2 ** 96) / TICK_BASE);
  // One tick of margin on each side, so the float above cannot hide a crossing.
  return after > low + 1 && after < low + TICK_SPACING - 1 ? out : null;
}

/** Constant product with a 0.3% fee: the same formula as the test market's quote. */
export function constantProductQuote(state: ConstantProductState, zeroForOne: boolean, amountIn: bigint): bigint {
  const [reserveIn, reserveOut] = zeroForOne ? [state.reserve0, state.reserve1] : [state.reserve1, state.reserve0];
  const net = amountIn * 997n;
  return (net * reserveOut) / (reserveIn * 1000n + net);
}

/**
 * What the market looks like just after this frame: the last full read, with the pool's new state laid over it and
 * fresh quotes worked out locally. Returns null if any quote cannot be computed safely. Vault limits come from the last
 * read, so they can lag; the vault still checks every trade itself.
 */
export function overlayMarket(warm: MarketState, frame: Frame, pool: PoolState, requests: QuoteRequest[], token0: Address, fee: number): MarketState | null {
  const quotes: Quote[] = [];
  for (const request of requests) {
    const zeroForOne = sameAddress(request.tokenIn, token0);
    const amountOut = pool.kind === "v3" ? v3Quote(pool, zeroForOne, request.amountIn, fee) : constantProductQuote(pool, zeroForOne, request.amountIn);
    if (amountOut === null) return null;
    quotes.push({ ...request, amountOut, ticksCrossed: 0 });
  }
  const sqrtPriceX96 = pool.kind === "v3" ? pool.sqrtPriceX96 : isqrt((pool.reserve1 << 128n) / pool.reserve0) << 32n;
  return {
    ...warm,
    head: {
      ...warm.head,
      number: frame.block,
      timestamp: frame.timestamp ?? warm.head.timestamp,
      baseFeePerGas: frame.baseFeePerGas ?? warm.head.baseFeePerGas,
    },
    sqrtPriceX96,
    // The test market's TWAP is synthetic and equal to its current tick, so only a real pool has a tick to compare.
    tick: pool.kind === "v3" ? pool.tick : warm.tick,
    liquidity: pool.kind === "v3" ? pool.liquidity : isqrt(pool.reserve0 * pool.reserve1),
    spotPriceX18: spotPriceX18(sqrtPriceX96),
    quotes,
  };
}

/** A flashblock subscription that reconnects by itself. The agent's polling keeps working while this is down. */
export class FlashblockStream {
  connected = false;
  frames = 0;
  reconnects = 0;
  private socket: WebSocket | null = null;
  private closed = false;
  private retryMs = 500;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly url: string,
    private readonly onFrame: (frame: Frame) => void,
    private readonly onBreak: (kind: StreamBreak) => void = () => {},
  ) {}

  /** Resolves once connected the first time. */
  start(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`flashblock stream did not open in ${timeoutMs} ms`)), timeoutMs);
      this.connect(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.socket?.close();
  }

  private connect(onOpen?: () => void): void {
    if (this.closed) return;
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      this.connected = true;
      this.retryMs = 500;
      onOpen?.();
    };
    socket.onmessage = (event) => {
      const arrivedAt = performance.now();
      try {
        const frame = decodeFrame(event.data as string | ArrayBuffer, arrivedAt);
        this.frames++;
        this.onFrame(frame);
      } catch {
        this.onBreak("malformed");
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      this.connected = false;
      if (this.closed) return;
      this.reconnects++;
      this.onBreak("reconnect");
      this.retryTimer = setTimeout(() => this.connect(onOpen), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    };
  }
}

function frameText(raw: ArrayBuffer | Uint8Array): string {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  try {
    return brotliDecompressSync(bytes).toString();
  } catch {
    return Buffer.from(bytes).toString();
  }
}

function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

interface RawReceipt {
  logs?: FlashLog[];
  cumulativeGasUsed?: string | number;
}

interface RawFrame {
  index: number;
  payload_id?: string;
  diff?: { block_hash?: Hex; transactions?: Hex[] };
  base?: { timestamp: string; base_fee_per_gas: string };
  metadata: {
    block_number: number | string;
    receipts?: Record<string, RawReceipt | Record<string, RawReceipt>>;
  };
}
