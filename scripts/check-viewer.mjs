// Read-only HTTP smoke check. No wallet, signed calls, trades or paid model requests.
import assert from 'node:assert/strict';
const base = process.argv[2] ?? 'http://127.0.0.1:4178';
async function get(path) {
  const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(60_000) });
  assert.equal(r.status, 200, `${path}: ${r.status}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
}
const home = await get('/?network=mainnet');
assert.ok(home.includes('Mainnet v4 is deployed. Testnet v3 is available too.'));
assert.ok(!home.includes('No mainnet deployment or swap has happened'));
const ids = [...home.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
assert.equal(new Set(ids).size, ids.length, 'duplicate HTML id');
const app = await get('/app.js');
for (const [, id] of app.matchAll(/\$\('#([^']+)'\)/g)) assert.ok(ids.includes(id), `Missing #${id}`);
const progress = await get('/api/progress');
assert.equal(progress.comparison.projects.length, 4); assert.equal(progress.criteria.length, 10);
const proof = await get('/api/proof');
assert.ok(proof.verification?.suites.some((s) => s.name === 'agent'));
console.log(JSON.stringify({ staticPage: 'pass', progress: 'pass', proof: 'pass', health: await get('/healthz') }));
for (const network of ['mainnet', 'testnet']) {
  const chainId = network === 'mainnet' ? 177 : 133;
  const data = await get(`/api/evidence?network=${network}`);
  assert.equal(data.network, network);
  assert.equal(data.deployment.chainId, chainId);
  assert.equal(data.vault.chainId, chainId, JSON.stringify(data.vault));
  assert.equal(data.vault.address, data.deployment.address);
  assert.ok(data.vault.tokens.length === 2);
  const list = await get(`/api/demo?network=${network}`); assert.equal(list.available, true);
  const demo = await get(`/api/demo/agent-withdraw?network=${network}`);
  assert.equal(demo.chainId, chainId); assert.equal(demo.vault, data.vault.address); assert.equal(demo.refused, true);
  const venue = await get(`/api/venue?network=${network}`);
  assert.equal(venue.chainId, chainId, JSON.stringify(venue));
  assert.ok(venue.market, `Missing ${network} market`);
  console.log(JSON.stringify({ network, chainId, vault: data.vault.address, generation: data.vault.version, block: data.vault.block, tokens: data.vault.tokens.map((t) => t.token), demo: demo.error, venue: venue.verdict, checks: venue.checks.length }));
}
