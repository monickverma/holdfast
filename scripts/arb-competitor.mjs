// What another contract's real arbitrage between these venues earned, from its own receipts on hsk.blockscout.com.
// Read only: explorer API reads, one at a time. These are someone else's mainnet transactions, not ours.
//   node scripts/arb-competitor.mjs [--out evidence/v4/arb-competitor-<date>.json]
// Each transaction is valued in USDT: its change in USDT, plus its change in WHSK and the gas it paid in HSK, both at
// the price of its own HSKSwap leg (USDT paid or received there per WHSK). WETH it passes through is counted too.
import { writeFileSync } from "node:fs";

const EXPLORER = "https://hsk.blockscout.com/api/v2";
const BOT = "0xf9Ee4523742D52c9f1B4DE779fC5B40D67E9a07d".toLowerCase();
const HSKSWAP_POOL = "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc";
const TOKENS = { WHSK: "0xb210d2120d57b758ee163cffb43e73728c471cf1", USDT: "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029", WETH: "0xefd4bc9afd210517803f293ababd701caeecdfd0" };
const VENUES = {
  "0x340bdfc78724b3c4e28385462d9a36d469ad047b": "solidly-20",
  "0xf8365695ccc4fca53241d7d42bbdc3b2e7d43ae4": "hyperindex-30",
  "0x711d26aa3ff64dd9dc5fa22b7c64c26c1b28f8f2": "hyperindex-weth-30",
  "0xb92b79ed6b370d5cfee2e14b1d0983c258304c16": "hskswap-weth-30",
  [HSKSWAP_POOL]: "hskswap-30",
};

async function get(path) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${EXPLORER}${path}`, { signal: AbortSignal.timeout(30_000) });
    if (response.ok) return response.json();
    if (attempt >= 4) throw new Error(`${path}: http ${response.status}`);
    await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
  }
}

const txs = [];
let page = "";
for (;;) {
  const body = await get(`/addresses/${BOT}/transactions${page}`);
  txs.push(...body.items);
  if (!body.next_page_params) break;
  page = `?${new URLSearchParams(body.next_page_params)}`;
}

const rows = [];
for (const tx of txs.sort((a, b) => a.block_number - b.block_number)) {
  const transfers = (await get(`/transactions/${tx.hash}/token-transfers`)).items ?? [];
  const delta = { WHSK: 0, USDT: 0, WETH: 0 };
  const venues = new Set();
  let poolUsdt = 0;
  let poolWhsk = 0;
  for (const t of transfers) {
    const symbol = Object.keys(TOKENS).find((k) => TOKENS[k] === t.token.address_hash.toLowerCase());
    if (!symbol) continue;
    const value = Number(t.total.value) / 10 ** Number(t.total.decimals);
    const from = t.from.hash.toLowerCase();
    const to = t.to.hash.toLowerCase();
    if (to === BOT) delta[symbol] += value;
    if (from === BOT) delta[symbol] -= value;
    for (const side of [from, to]) if (VENUES[side]) venues.add(VENUES[side]);
    if (from === HSKSWAP_POOL || to === HSKSWAP_POOL) {
      if (symbol === "USDT") poolUsdt += value;
      if (symbol === "WHSK") poolWhsk += value;
    }
  }
  const price = poolWhsk > 0 ? poolUsdt / poolWhsk : null;
  const feeHsk = Number(tx.fee?.value ?? 0) / 1e18;
  const ok = tx.status === "ok";
  rows.push({
    hash: tx.hash,
    block: tx.block_number,
    time: tx.timestamp,
    status: tx.status,
    kind: tx.created_contract ? "deployment" : "trade",
    method: tx.method,
    venues: [...venues],
    gasUsed: Number(tx.gas_used),
    gasPriceGwei: Number(tx.gas_price) / 1e9,
    feeHsk,
    delta,
    hskswapPrice: price,
    netUsdt: price === null ? null : delta.USDT + delta.WHSK * price - feeHsk * price,
    grossUsdt: price === null ? null : delta.USDT + delta.WHSK * price,
    ok,
  });
}

// A trade with no HSKSwap leg is valued at the nearest trade's price, and marked so.
const priced = rows.filter((r) => r.hskswapPrice !== null);
for (const r of rows) {
  if (r.hskswapPrice !== null || r.kind !== "trade" || !priced.length) continue;
  const near = priced.reduce((a, b) => (Math.abs(b.block - r.block) < Math.abs(a.block - r.block) ? b : a));
  r.priceFromBlock = near.block;
  r.grossUsdt = r.delta.USDT + r.delta.WHSK * near.hskswapPrice;
  r.netUsdt = r.grossUsdt - r.feeHsk * near.hskswapPrice;
}
const trades = rows.filter((r) => r.kind === "trade");
const valued = trades.filter((r) => r.netUsdt !== null);
const deployments = rows.filter((r) => r.kind === "deployment");
const firstPrice = priced[0]?.hskswapPrice ?? null;
const deploymentUsdt = firstPrice === null ? null : deployments.reduce((a, r) => a + r.feeHsk * firstPrice, 0);
const report = {
  lane: "mainnet, someone else's transactions, read from the explorer; not ours",
  wallTime: new Date().toISOString(),
  contract: BOT,
  explorer: `https://hsk.blockscout.com/address/${BOT}`,
  method: "Each transaction's token transfers into and out of the contract, and its fee. WHSK and gas are valued at the USDT per WHSK of the transaction's own HSKSwap leg, which includes that leg's 0.3% fee, so it values what the contract kept slightly high. A trade with no HSKSwap leg uses the nearest trade's price (priceFromBlock). WETH that passes through is counted, and nets to zero. The deployment's fee is valued at the first trade's price",
  transactions: rows.length,
  succeeded: rows.filter((r) => r.ok).length,
  failed: rows.filter((r) => !r.ok).length,
  trades: trades.length,
  tradesPricedFromNearest: trades.filter((r) => r.priceFromBlock !== undefined).length,
  tradesNetUsdt: valued.reduce((a, r) => a + r.netUsdt, 0),
  tradesGrossUsdt: valued.reduce((a, r) => a + r.grossUsdt, 0),
  tradesFeeHsk: trades.reduce((a, r) => a + r.feeHsk, 0),
  tradeNetRange: valued.length ? { min: Math.min(...valued.map((r) => r.netUsdt)), max: Math.max(...valued.map((r) => r.netUsdt)) } : null,
  winners: valued.filter((r) => r.netUsdt > 0).length,
  losers: valued.filter((r) => r.netUsdt <= 0).length,
  deploymentFeeHsk: deployments.reduce((a, r) => a + r.feeHsk, 0),
  deploymentUsdt,
  netAfterDeploymentUsdt: deploymentUsdt === null ? null : valued.reduce((a, r) => a + r.netUsdt, 0) - deploymentUsdt,
  first: rows[0]?.time ?? null,
  last: rows.at(-1)?.time ?? null,
  rows,
};
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : `evidence/v4/arb-competitor-${report.wallTime.slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
const { rows: _rows, ...summary } = report;
console.log(JSON.stringify(summary, null, 1));
console.log(`wrote ${out}`);
