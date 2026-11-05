// Lists every place on HSK Chain mainnet where WHSK and USDT, or a close substitute, can trade, and records how we know.
// Read only: eth_call and eth_getCode against the public RPC, one request at a time. Signs nothing.
//   node scripts/arb-venues.mjs [--out evidence/v4/arb-venues-<date>.json]
// Candidates come from three places: the HSKSwap factory's getPool for every fee tier, the same factory for routes
// through a third token, and the largest WHSK and USDT holders on hsk.blockscout.com that are contracts.
import { writeFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

const RPC = "https://mainnet.hsk.xyz";
const CHAIN_ID = 177;
const EXPLORER = "https://hsk.blockscout.com";
const WHSK = "0xb210d2120d57b758ee163cffb43e73728c471cf1";
const USDT = "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029";
const POOL = "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc";
const ROUTER = "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3";
const QUOTER = "0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD";
// Third tokens worth routing through: the explorer's most-held token by each name, with reputation "ok".
const BRIDGES = {
  WETH: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0",
  "USDC.e": "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
  WBTC: "0x6119CA49a79f5825C8B345F8d7aC36B272565b14",
};
const FEES = [100, 500, 2500, 3000, 10000];
const HOLDERS_PER_TOKEN = 50;

const ABI = parseAbi([
  "function factory() view returns (address)",
  "function factoryV2() view returns (address)",
  "function WETH9() view returns (address)",
  "function getPool(address, address, uint24) view returns (address)",
  "function getPair(address, address) view returns (address)",
  "function feeAmountTickSpacing(uint24) view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    if (response.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
      continue;
    }
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }
}

/** One read, or undefined if the contract does not have it. */
async function read(address, functionName, args = []) {
  try {
    const data = await rpc("eth_call", [{ to: address, data: encodeFunctionData({ abi: ABI, functionName, args }) }, BLOCK]);
    return decodeFunctionResult({ abi: ABI, functionName, data });
  } catch {
    return undefined;
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";
const lower = (a) => a?.toLowerCase();
const symbols = new Map();
async function token(address) {
  const key = lower(address);
  if (!symbols.has(key)) symbols.set(key, { symbol: (await read(address, "symbol")) ?? "?", decimals: Number((await read(address, "decimals")) ?? 18) });
  return symbols.get(key);
}

if (Number(await rpc("eth_chainId", [])) !== CHAIN_ID) throw new Error(`Expected chain ${CHAIN_ID}`);
const BLOCK = await rpc("eth_blockNumber", []);
const startedAt = new Date().toISOString();

/** What a contract is, read from the contract itself, with its WHSK and USDT balances. */
async function describe(address, source) {
  const code = await rpc("eth_getCode", [address, BLOCK]);
  if (code === "0x") return { address, source, kind: "not a contract" };
  const [token0, token1, fee, factory] = [await read(address, "token0"), await read(address, "token1"), await read(address, "fee"), await read(address, "factory")];
  const row = { address, source, factory: factory ?? null, codeBytes: (code.length - 2) / 2 };
  if (token0 && token1) {
    const [t0, t1] = [await token(token0), await token(token1)];
    row.pair = `${t0.symbol}/${t1.symbol}`;
    row.token0 = token0;
    row.token1 = token1;
    const bal0 = await read(token0, "balanceOf", [address]);
    const bal1 = await read(token1, "balanceOf", [address]);
    row.balances = { [t0.symbol]: bal0 === undefined ? null : Number(bal0) / 10 ** t0.decimals, [t1.symbol]: bal1 === undefined ? null : Number(bal1) / 10 ** t1.decimals };
    if (fee !== undefined) {
      row.kind = "concentrated liquidity (V3 interface)";
      row.fee = Number(fee);
      row.liquidity = String((await read(address, "liquidity")) ?? "");
      const slot0 = await read(address, "slot0");
      if (slot0) row.tick = Number(slot0[1]);
    } else {
      const reserves = await read(address, "getReserves");
      row.kind = reserves ? "constant product (V2 interface)" : "two-token contract, interface unknown";
    }
  } else {
    row.kind = "no token0/token1: not a recognised pool";
    const whsk = await read(WHSK, "balanceOf", [address]);
    const usdt = await read(USDT, "balanceOf", [address]);
    row.balances = { WHSK: whsk === undefined ? null : Number(whsk) / 1e18, USDT: usdt === undefined ? null : Number(usdt) / 1e6 };
  }
  row.explorer = `${EXPLORER}/address/${address}`;
  return row;
}

// 1. The factory behind the pool the vault trades in, and the router's own factories.
const factory = await read(POOL, "factory");
const routerFactory = await read(ROUTER, "factory");
const routerFactoryV2 = await read(ROUTER, "factoryV2");
const quoterFactory = await read(QUOTER, "factory");
const weth9 = await read(ROUTER, "WETH9");
const tiers = [];
for (const fee of FEES) tiers.push({ fee, tickSpacing: (await read(factory, "feeAmountTickSpacing", [fee])) ?? null });

// 2. Every fee tier of the pair, and of each two-hop route, on that factory.
const factoryPools = [];
async function pools(a, b, label) {
  for (const fee of FEES) {
    const pool = await read(factory, "getPool", [a, b, fee]);
    factoryPools.push({ route: label, fee, pool: pool && lower(pool) !== ZERO ? pool : null });
  }
}
await pools(WHSK, USDT, "WHSK/USDT");
for (const [name, address] of Object.entries(BRIDGES)) {
  await pools(WHSK, address, `WHSK/${name}`);
  await pools(address, USDT, `${name}/USDT`);
}
let v2Pair = null;
if (routerFactoryV2 && lower(routerFactoryV2) !== ZERO) v2Pair = (await read(routerFactoryV2, "getPair", [WHSK, USDT])) ?? null;

// 3. The largest holders of each token that are contracts. A pool must hold both of its tokens.
const holderCandidates = new Map();
for (const [name, address] of [["WHSK", WHSK], ["USDT", USDT]]) {
  const body = await (await fetch(`${EXPLORER}/api/v2/tokens/${address}/holders`, { signal: AbortSignal.timeout(20_000) })).json();
  for (const holder of body.items.slice(0, HOLDERS_PER_TOKEN)) {
    if (!holder.address.is_contract) continue;
    const key = lower(holder.address.hash);
    const entry = holderCandidates.get(key) ?? { address: holder.address.hash, explorerName: holder.address.name ?? null, top: [] };
    entry.top.push(name);
    holderCandidates.set(key, entry);
  }
}

const venues = [];
const seen = new Set();
for (const row of factoryPools.filter((r) => r.pool)) {
  seen.add(lower(row.pool));
  venues.push({ ...(await describe(row.pool, `factory.getPool, ${row.route}, fee ${row.fee}`)), route: row.route });
}
if (v2Pair && lower(v2Pair) !== ZERO) {
  seen.add(lower(v2Pair));
  venues.push(await describe(v2Pair, "router factoryV2.getPair(WHSK, USDT)"));
}
for (const candidate of holderCandidates.values()) {
  if (seen.has(lower(candidate.address))) continue;
  venues.push({ ...(await describe(candidate.address, `top ${HOLDERS_PER_TOKEN} ${candidate.top.join(" and ")} holder on the explorer`)), explorerName: candidate.explorerName });
}

const isPair = (v, a, b) => v.token0 && ((lower(v.token0) === a && lower(v.token1) === b) || (lower(v.token0) === b && lower(v.token1) === a));
const report = {
  startedAt,
  lane: "mainnet read-only, no trades",
  rpc: RPC,
  chainId: CHAIN_ID,
  block: BigInt(BLOCK).toString(),
  method: "eth_call at one block for every chain read; candidates from factory getPool over fee tiers " + FEES.join(", ") + ", two-hop routes through " + Object.keys(BRIDGES).join(", ") + ", and the top " + HOLDERS_PER_TOKEN + " WHSK and USDT holders on " + EXPLORER,
  hskswap: { pool: POOL, poolFactory: factory, router: ROUTER, routerFactory: routerFactory ?? null, routerFactoryV2: routerFactoryV2 ?? null, quoter: QUOTER, quoterFactory: quoterFactory ?? null, weth9: weth9 ?? null, tiers },
  factoryPools,
  v2Pair,
  venues,
  summary: {
    whskUsdtVenues: venues.filter((v) => isPair(v, lower(WHSK), lower(USDT))).map((v) => ({ address: v.address, kind: v.kind, fee: v.fee ?? null, factory: v.factory, balances: v.balances })),
    sameRouterFactory: lower(routerFactory) === lower(factory),
  },
};
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : `evidence/v4/arb-venues-${startedAt.slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ block: report.block, factory, routerFactory, routerFactoryV2, tiers, factoryPools: factoryPools.filter((r) => r.pool), whskUsdt: report.summary.whskUsdtVenues }, null, 2));
console.log(`wrote ${out}`);
