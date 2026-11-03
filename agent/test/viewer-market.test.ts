import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { join } from "node:path";
import { readMarket } from "../src/reader.js";
import { verifyVenue } from "../src/venue.js";
import { viewerNetwork } from "../src/viewer-network.js";
import type { RpcClient, RpcCall } from "../src/rpc.js";

test("market quotes use the selected token pair even when process NETWORK differs", async () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const { market } = viewerNetwork(network, join(process.cwd(), "evidence"));
    let seen: RpcCall[] = [];
    const rpc = { batch: async (calls: RpcCall[]) => { seen = calls; throw new Error("captured batch"); } } as unknown as RpcClient;
    await assert.rejects(readMarket(rpc, { twapWindowSec: 300 }, { number: 1n, hash: `0x${"1".repeat(64)}`, timestamp: 1n, baseFeePerGas: 1n }, [{ tokenIn: market.whsk, amountIn: 1n }], market), /captured batch/);
    assert.equal((seen[0]!.params![0] as { to: string }).to, market.pool);
    const quote = seen[4]!.params![0] as { to: string; data: Hex };
    assert.equal(quote.to, market.quoter);
    const decoded = decodeFunctionData({ abi: parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256,uint160,uint32,uint256)"]), data: quote.data });
    assert.equal(decoded.args[0].tokenOut.toLowerCase(), market.usdt.toLowerCase());
  }
});

test("venue verification reads the selected market's contracts", async () => {
  const context = viewerNetwork("testnet", join(process.cwd(), "evidence"));
  const codes: string[] = [];
  const rpc = { call: async (method: string, params: unknown[] = []) => {
    if (method === "eth_chainId") return "0x85";
    if (method === "eth_blockNumber") return "0x1";
    if (method === "eth_getCode") { codes.push(params[0] as string); return "0x01"; }
    throw new Error("No fixture answer");
  } } as unknown as RpcClient;
  const result = await verifyVenue(rpc, { chainId: 133, poolKind: "constant-product" }, undefined, context.market);
  assert.equal(result.chainId, 133); assert.equal(result.verdict, "unverified");
  assert.deepEqual(codes, [context.market.router, context.market.quoter, context.market.pool, context.market.whsk, context.market.usdt]);
});
