// Read-only check of everything the agent depends on. Sends no transaction.
import { performance } from "node:perf_hooks";
import { HSKSWAP, loadConfig } from "../config.js";
import { readHead, readMarket } from "../reader.js";
import { RpcClient } from "../rpc.js";
import { nearestRank } from "../stats.js";

const config = loadConfig();
const rpc = new RpcClient(config.rpcUrl);

const chainId = Number(await rpc.call<string>("eth_chainId"));
console.log(`rpc      ${config.rpcUrl}`);
console.log(`chain    ${chainId}${chainId === config.chainId ? "" : `  EXPECTED ${config.chainId}`}`);
for (const [name, address] of Object.entries({ router: HSKSWAP.router, quoter: HSKSWAP.quoter, pool: HSKSWAP.pool })) {
  const code = await rpc.call<string>("eth_getCode", [address, "latest"]);
  console.log(`${name.padEnd(8)} ${address} ${code.length > 2 ? "code present" : "NO CODE"}`);
}

const quoteRequests = [
  { tokenIn: HSKSWAP.whsk, amountIn: 10n ** 19n },
  { tokenIn: HSKSWAP.usdt, amountIn: 10n ** 6n },
];
const samples: number[] = [];
let market;
for (let i = 0; i < Number(process.env.PREFLIGHT_N ?? 12); i++) {
  const head = await readHead(rpc);
  const start = performance.now();
  market = await readMarket(rpc, config, head, quoteRequests);
  samples.push(performance.now() - start);
  await new Promise((resolve) => setTimeout(resolve, 650));
}
if (!market) throw new Error("no reads ran");

const [sell, buy] = market.quotes;
console.log(`block    ${market.head.number} ${market.head.hash}`);
console.log(`price    ${Number(market.spotPriceX18) / 1e6} USDT per HSK, tick ${market.tick}, twap tick ${market.twapTick}`);
console.log(`quote    10 WHSK -> ${Number(sell!.amountOut) / 1e6} USDT`);
console.log(`quote    1 USDT -> ${Number(buy!.amountOut) / 1e18} WHSK`);
console.log(`fees     base ${market.head.baseFeePerGas} tip ${market.priorityFeePerGas} l1 ${market.l1FeeWei} wei`);
console.log(`pinned batch  n=${samples.length} P50=${nearestRank(samples, 0.5).toFixed(1)}ms max=${Math.max(...samples).toFixed(1)}ms`);
console.log(`rpc stats     ${JSON.stringify(rpc.stats)}`);
if (market.vault) console.log(`vault    ${config.vault} ${JSON.stringify(market.vault, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
rpc.close();
