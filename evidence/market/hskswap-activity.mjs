// Read only. Who trades the HSKSwap WHSK/USDT pool on mainnet, how often, and how fast the price moves.
const RPC = "https://mainnet.hsk.xyz";
const POOL = "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc";
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const BLOCKS = Number(process.argv[2] ?? 300000);
const CHUNK = Number(process.argv[3] ?? 1000);
let id = 1;
async function call(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const head = Number(await call("eth_blockNumber", []));
const logs = [];
let errors = 0;
for (let to = head; to > head - BLOCKS; to -= CHUNK) {
  const from = Math.max(to - CHUNK + 1, head - BLOCKS + 1);
  try {
    logs.push(...(await call("eth_getLogs", [{ address: POOL, topics: [SWAP], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }])));
  } catch (error) {
    errors++;
    if (errors === 1) console.log(String(error).slice(0, 200));
  }
}
logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
const int256 = (hex) => { const v = BigInt(`0x${hex}`); return v >= 2n ** 255n ? v - 2n ** 256n : v; };
const rows = logs.map((l) => {
  const d = l.data.slice(2);
  const sqrt = BigInt(`0x${d.slice(128, 192)}`);
  const price = (Number(sqrt) / 2 ** 96) ** 2 * 1e12; // USDT (6) per WHSK (18)
  return { block: Number(l.blockNumber), tx: l.transactionHash, index: Number(l.transactionIndex), a0: Number(int256(d.slice(0, 64))) / 1e18, a1: Number(int256(d.slice(64, 128))) / 1e6, price };
});
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const gaps = rows.slice(1).map((r, i) => (r.block - rows[i].block) * 2);
const moves = rows.slice(1).map((r, i) => Math.abs(r.price / rows[i].price - 1) * 1e4);
const usd = rows.map((r) => Math.abs(r.a1));
const sameBlock = gaps.filter((g) => g === 0).length;
// Sender and fee for a sample, spread evenly over the window.
const step = Math.max(1, Math.floor(rows.length / 400));
const sample = rows.filter((_, i) => i % step === 0);
const senders = {}, targets = {}, tips = [];
for (const r of sample) {
  const t = await call("eth_getTransactionByHash", [r.tx]);
  if (!t) continue;
  senders[t.from] = (senders[t.from] ?? 0) + 1;
  targets[t.to] = (targets[t.to] ?? 0) + 1;
  if (t.maxPriorityFeePerGas) tips.push(Number(BigInt(t.maxPriorityFeePerGas)) / 1e9);
}
const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(JSON.stringify({
  head, windowBlocks: BLOCKS, windowHours: (BLOCKS * 2) / 3600, chunkErrors: errors, swaps: rows.length,
  swapsPerHour: rows.length / ((BLOCKS * 2) / 3600),
  firstBlock: rows[0]?.block, lastBlock: rows.at(-1)?.block,
  gapSec: { p10: q(gaps, 0.1), p50: q(gaps, 0.5), p90: q(gaps, 0.9) }, swapsInSameBlockAsPrevious: sameBlock,
  usdtSize: { p50: q(usd, 0.5), p90: q(usd, 0.9), max: q(usd, 1), total: usd.reduce((a, b) => a + b, 0) },
  priceMoveBps: { p50: q(moves, 0.5), p90: q(moves, 0.9), p99: q(moves, 0.99), max: q(moves, 1), over30bps: moves.filter((m) => m > 30).length },
  lastPrice: rows.at(-1)?.price,
  sampled: sample.length, uniqueSendersInSample: Object.keys(senders).length, topSenders: top(senders), topTargets: top(targets),
  tipGwei: { p50: q(tips, 0.5), p90: q(tips, 0.9), max: q(tips, 1), zero: tips.filter((t) => t === 0).length, n: tips.length },
}, null, 1));
