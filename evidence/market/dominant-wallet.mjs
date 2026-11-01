// Read only. What the wallet behind most HSKSwap swaps does: bursts, direction, reaction to others, and its net position.
const RPC = "https://mainnet.hsk.xyz";
const POOL = "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc";
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const BOT = "0xec77ef78b577d758ad2ea59bd52c976bbabb4154";
const BLOCKS = 300000, CHUNK = 1000;
let id = 1;
async function call(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const head = Number(await call("eth_blockNumber", []));
const logs = [];
for (let to = head; to > head - BLOCKS; to -= CHUNK) {
  const from = Math.max(to - CHUNK + 1, head - BLOCKS + 1);
  logs.push(...(await call("eth_getLogs", [{ address: POOL, topics: [SWAP], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }])));
}
logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
const int256 = (hex) => { const v = BigInt(`0x${hex}`); return v >= 2n ** 255n ? v - 2n ** 256n : v; };
const rows = [];
for (const l of logs) {
  const d = l.data.slice(2);
  const t = await call("eth_getTransactionByHash", [l.transactionHash]);
  const sqrt = BigInt(`0x${d.slice(128, 192)}`);
  rows.push({ block: Number(l.blockNumber), from: t.from.toLowerCase(), hsk: Number(int256(d.slice(0, 64))) / 1e18, usdt: Number(int256(d.slice(64, 128))) / 1e6, price: (Number(sqrt) / 2 ** 96) ** 2 * 1e12, input: t.input.slice(0, 10) });
}
const bot = rows.filter((r) => r.from === BOT);
const others = rows.filter((r) => r.from !== BOT);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
// A burst is a run of the wallet's swaps less than 60 seconds apart.
const bursts = [];
for (const r of bot) {
  const last = bursts.at(-1);
  if (last && (r.block - last.at(-1).block) * 2 < 60) last.push(r);
  else bursts.push([r]);
}
const sells = bot.filter((r) => r.hsk > 0).length; // pool received HSK, so the trader sold it
const flips = bot.slice(1).filter((r, i) => Math.sign(r.hsk) !== Math.sign(bot[i].hsk)).length;
const burstNet = bursts.map((b) => b.reduce((s, r) => s + r.usdt, 0));
// How long after someone else's swap does the wallet act, and does it push the price back?
const replies = [];
let reverted = 0, checked = 0;
others.forEach((o) => {
  const next = rows[rows.indexOf(o) + 1];
  if (next && next.from === BOT) {
    replies.push((next.block - o.block) * 2);
    checked++;
    if (Math.sign(next.hsk) !== Math.sign(o.hsk)) reverted++;
  }
});
const days = (BLOCKS * 2) / 86400;
const gas = await call("eth_getTransactionReceipt", [logs.find(Boolean).transactionHash]);
console.log(JSON.stringify({
  days, swaps: rows.length, botSwaps: bot.length, botShare: bot.length / rows.length, otherSwaps: others.length,
  botUsdtVolume: bot.reduce((s, r) => s + Math.abs(r.usdt), 0), otherUsdtVolume: others.reduce((s, r) => s + Math.abs(r.usdt), 0),
  botNetHsk: -bot.reduce((s, r) => s + r.hsk, 0), botNetUsdt: -bot.reduce((s, r) => s + r.usdt, 0),
  botSells: sells, botBuys: bot.length - sells, directionFlipRate: flips / (bot.length - 1),
  bursts: bursts.length, burstSize: { p50: q(bursts.map((b) => b.length), 0.5), max: q(bursts.map((b) => b.length), 1) },
  burstGapHours: { p50: q(bursts.slice(1).map((b, i) => (b[0].block - bursts[i].at(-1).block) * 2 / 3600), 0.5) },
  botSizeUsdt: { p50: q(bot.map((r) => Math.abs(r.usdt)), 0.5), p90: q(bot.map((r) => Math.abs(r.usdt)), 0.9) },
  otherSizeUsdt: { p50: q(others.map((r) => Math.abs(r.usdt)), 0.5), p90: q(others.map((r) => Math.abs(r.usdt)), 0.9), max: q(others.map((r) => Math.abs(r.usdt)), 1) },
  repliesToOthers: { n: checked, oppositeDirection: reverted, gapSecP50: q(replies, 0.5) },
  poolPrice: { min: q(rows.map((r) => r.price), 0), p50: q(rows.map((r) => r.price), 0.5), max: q(rows.map((r) => r.price), 1) },
  selector: Object.entries(bot.reduce((m, r) => ({ ...m, [r.input]: (m[r.input] ?? 0) + 1 }), {})),
  sampleSwapGas: Number(gas.gasUsed),
}, null, 0));
