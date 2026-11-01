import assert from "node:assert/strict";
import { brotliCompressSync } from "node:zlib";
import { test } from "node:test";
import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from "viem";
import type { MarketState } from "../src/reader.js";
import { constantProductQuote, decodeFrame, lastSwap, overlayMarket, poolTransfers, v3Quote, type V3PoolState } from "../src/stream.js";

const POOL = "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc" as Address;
const TOKEN0 = "0x00000000000000000000000000000000000000a0" as Address;
const TOKEN1 = "0x00000000000000000000000000000000000000a1" as Address;
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67" as Hex;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const padded = (address: Address) => `0x${address.slice(2).padStart(64, "0")}` as Hex;
const swapData = (sqrt: bigint, liquidity: bigint, tick: number) =>
  encodeAbiParameters(parseAbiParameters("int256, int256, uint160, uint128, int24"), [1n, -1n, sqrt, liquidity, tick]);

const frameOf = (logs: unknown[]) => ({
  index: 3,
  metadata: { block_number: 500, receipts: { "0xaa": { status: "0x1", logs } } },
});

test("a compressed frame decodes, with its logs and block", () => {
  const raw = brotliCompressSync(JSON.stringify(frameOf([{ address: POOL, topics: [SWAP], data: swapData(5n, 6n, -7) }])));
  const frame = decodeFrame(new Uint8Array(raw), 123);
  assert.equal(frame.block, 500n);
  assert.equal(frame.index, 3);
  assert.equal(frame.arrivedAt, 123);
  assert.equal(frame.timestamp, undefined);
  assert.equal(frame.logs.length, 1);
});

test("the first frame of a block carries its timestamp and base fee", () => {
  const frame = decodeFrame(JSON.stringify({ ...frameOf([]), index: 0, base: { timestamp: "0x64", base_fee_per_gas: "0x3b9aca00" } }));
  assert.equal(frame.timestamp, 100n);
  assert.equal(frame.baseFeePerGas, 1_000_000_000n);
});

test("a receipt wrapped by transaction type still yields its logs", () => {
  const frame = decodeFrame(JSON.stringify({ index: 1, metadata: { block_number: "0x10", receipts: { "0xaa": { Eip1559: { logs: [{ address: POOL, topics: [SWAP], data: swapData(5n, 6n, 7) }] } } } } }));
  assert.equal(frame.block, 16n);
  assert.equal(lastSwap(frame, POOL)?.sqrtPriceX96, 5n);
});

test("the last swap in a frame wins, and other pools are ignored", () => {
  const frame = decodeFrame(
    JSON.stringify(
      frameOf([
        { address: POOL, topics: [SWAP], data: swapData(5n, 6n, -7) },
        { address: POOL.toUpperCase().replace("0X", "0x"), topics: [SWAP], data: swapData(8n, 9n, -10) },
        { address: TOKEN0, topics: [SWAP], data: swapData(1n, 1n, 1) },
      ]),
    ),
  );
  assert.deepEqual(lastSwap(frame, POOL), { kind: "v3", sqrtPriceX96: 8n, liquidity: 9n, tick: -10 });
  assert.equal(lastSwap(decodeFrame(JSON.stringify(frameOf([]))), POOL), null);
});

test("pool transfers net out by token, and unrelated transfers are ignored", () => {
  const other = "0x00000000000000000000000000000000000000bb" as Address;
  const frame = decodeFrame(
    JSON.stringify(
      frameOf([
        { address: TOKEN0, topics: [TRANSFER, padded(other), padded(POOL)], data: "0x64" },
        { address: TOKEN1, topics: [TRANSFER, padded(POOL), padded(other)], data: "0x0a" },
        { address: TOKEN1, topics: [TRANSFER, padded(other), padded(other)], data: "0xff" },
        { address: other, topics: [TRANSFER, padded(other), padded(POOL)], data: "0xff" },
      ]),
    ),
  );
  assert.deepEqual(poolTransfers(frame, POOL, TOKEN0, TOKEN1), { delta0: 100n, delta1: -10n });
  assert.equal(poolTransfers(decodeFrame(JSON.stringify(frameOf([]))), POOL, TOKEN0, TOKEN1), null);
});

const v3: V3PoolState = { kind: "v3", sqrtPriceX96: 2n ** 96n, liquidity: 10n ** 24n, tick: 30 };

test("a small V3 swap is priced, and one leaving the tick range is refused", () => {
  // 1:1 price, so a tiny swap returns the input less the 0.3% fee, rounded down.
  const out = v3Quote({ ...v3, sqrtPriceX96: (2n ** 96n * 10015n) / 10000n }, true, 10n ** 12n, 3000);
  assert.ok(out !== null && out > 0n);
  assert.equal(v3Quote(v3, true, 10n ** 12n, 3000), null, "price 1.0 is tick 0, the edge of tick 30's range");
  assert.equal(v3Quote({ ...v3, sqrtPriceX96: (2n ** 96n * 10015n) / 10000n }, true, 10n ** 24n, 3000), null);
  assert.equal(v3Quote({ ...v3, liquidity: 0n }, true, 1n, 3000), null);
});

test("constant product matches the test market's formula", () => {
  const state = { kind: "constant-product" as const, reserve0: 1_000_000n, reserve1: 100_000n };
  assert.equal(constantProductQuote(state, true, 1_000n), (1_000n * 997n * 100_000n) / (1_000_000n * 1000n + 1_000n * 997n));
  assert.equal(constantProductQuote(state, false, 1_000n), (1_000n * 997n * 1_000_000n) / (100_000n * 1000n + 1_000n * 997n));
});

const warm = {
  head: { number: 499n, hash: "0xab", timestamp: 90n, baseFeePerGas: 7n },
  sqrtPriceX96: 1n,
  tick: 11,
  twapTick: 12,
  liquidity: 1n,
  spotPriceX18: 1n,
  quotes: [],
  priorityFeePerGas: 1n,
  l1FeeWei: 1n,
  vault: { paused: false },
} as unknown as MarketState;

test("an overlay moves the pool and the head, and keeps the vault and TWAP from the last read", () => {
  const frame = { block: 500n, index: 0, timestamp: 100n, baseFeePerGas: 9n, logs: [], arrivedAt: 0 };
  const pool = { kind: "constant-product" as const, reserve0: 10n ** 24n, reserve1: 10n ** 23n };
  const market = overlayMarket(warm, frame, pool, [{ tokenIn: TOKEN0, amountIn: 1000n }], TOKEN0, 3000)!;
  assert.equal(market.head.number, 500n);
  assert.equal(market.head.timestamp, 100n);
  assert.equal(market.head.baseFeePerGas, 9n);
  assert.equal(market.quotes[0]!.amountOut, constantProductQuote(pool, true, 1000n));
  assert.equal(market.twapTick, 12);
  assert.equal(market.vault, warm.vault);
  const spot = Number(market.spotPriceX18);
  assert.ok(Math.abs(spot / 1e17 - 1) < 1e-6, "price is reserve1 / reserve0");
});

test("an overlay is refused when any quote is not safe, so the caller reads instead", () => {
  const frame = { block: 500n, index: 2, logs: [], arrivedAt: 0 };
  assert.equal(overlayMarket(warm, frame, v3, [{ tokenIn: TOKEN0, amountIn: 10n ** 12n }], TOKEN0, 3000), null);
});
