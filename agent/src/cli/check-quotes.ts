// Read only. Compares the local Uniswap V3 math with the real HSKSwap Quoter, in one atomic read, at many sizes.
//   check:quotes -- --rounds 40 --run quotes-mainnet
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { HSKSWAP, loadConfig, networkProfile } from "../config.js";
import { readTick } from "../reader.js";
import { RpcClient, sleep } from "../rpc.js";
import { wilson } from "../stats.js";
import { v3Quote, type V3PoolState } from "../stream.js";

const { values } = parseArgs({ options: { rounds: { type: "string", default: "40" }, run: { type: "string", default: `quotes-${Date.now()}` } } });
if (networkProfile().network !== "mainnet") throw new Error("This checks real V3 math, so it needs NETWORK=mainnet");

const config = loadConfig();
const rpc = new RpcClient(config.rpcUrl);
const E18 = 10n ** 18n;
const sizes = [
  ...[1n, 10n, 100n, 1_000n, 10_000n].map((scale) => ({ tokenIn: HSKSWAP.whsk, amountIn: (E18 / 1000n) * scale })),
  ...[1n, 10n, 100n, 1_000n, 10_000n].map((scale) => ({ tokenIn: HSKSWAP.usdt, amountIn: 100n * scale })),
];

let compared = 0;
let exact = 0;
let refused = 0;
let maxDiffBps = 0;
let refusedButSameRange = 0;
const blocks = new Set<bigint>();
for (let round = 0; round < Number(values.rounds); round++) {
  const tick = await readTick(rpc, { ...config, vault: undefined }, sizes);
  if (tick) {
    const { market } = tick;
    blocks.add(market.head.number);
    const state: V3PoolState = { kind: "v3", sqrtPriceX96: market.sqrtPriceX96, liquidity: market.liquidity, tick: market.tick };
    for (const quote of market.quotes) {
      const local = v3Quote(state, quote.tokenIn === HSKSWAP.whsk, quote.amountIn, HSKSWAP.fee);
      if (local === null) {
        refused++;
        if (quote.ticksCrossed === 0) refusedButSameRange++;
        continue;
      }
      compared++;
      if (local === quote.amountOut) exact++;
      else maxDiffBps = Math.max(maxDiffBps, Number(((local > quote.amountOut ? local - quote.amountOut : quote.amountOut - local) * 1_000_000n) / (quote.amountOut || 1n)) / 100);
      if (quote.ticksCrossed !== 0) throw new Error(`local math accepted a swap that crossed ${quote.ticksCrossed} ticks`);
    }
  }
  await sleep(2_000 + Math.random() * 1_000);
}
const report = {
  lane: "mainnet",
  venue: "HSKSwap WHSK/USDT, read only",
  blocks: blocks.size,
  compared,
  exact,
  exactWilson95: compared ? wilson(exact, compared) : null,
  maxDiffBps,
  refusedToQuoterCount: refused,
  refusedWithNoTickCrossed: refusedButSameRange,
};
const dir = join(config.dataDir, values.run!);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "quote-check.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
rpc.close();
