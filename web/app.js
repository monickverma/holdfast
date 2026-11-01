const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); return node; };
function table(parent, headings, rows) {
  const wrap = el('div'); wrap.className = 'scroll';
  const grid = el('table'); const head = el('tr');
  for (const title of headings) { const cell = el('th', title); cell.scope = 'col'; head.append(cell); }
  const thead = el('thead'); thead.append(head); grid.append(thead);
  const body = el('tbody');
  for (const row of rows) { const tr = el('tr'); for (const value of row) { const td = el('td'); td.append(value instanceof Node ? value : document.createTextNode(String(value))); tr.append(td); } body.append(tr); }
  grid.append(body); wrap.append(grid); parent.append(wrap);
}
document.querySelector('#theme').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
};
async function load() {
  const response = await fetch('/api/evidence'); if (!response.ok) throw new Error();
  const data = await response.json();
  document.querySelector('#state').textContent = `${data.empty ? 'No evidence in data/.' : 'Saved evidence is shown by lane.'} Mainnet execution: ${data.lanes.some(l => l.lane === 'mainnet' && l.totals.fills + l.totals.reverts > 0) ? 'see the mainnet trades below.' : 'not yet run.'}${data.lanes.some(l => l.lane === 'testnet' && l.trades.length) ? ' Testnet trades use our own test market with free test tokens, not HSKSwap, so their prices mean nothing.' : ''}`;
  if (data.incomplete) document.querySelector('#state').append(' Some records were withheld: missing or ambiguous lane, unreadable data, or invalid records.');
  for (const group of data.lanes) {
    const area = document.querySelector('#lanes'); area.append(el('h3', group.lane));
    area.append(el('p', `${group.lane} · Fills ${group.totals.fills}, reverts ${group.totals.reverts}, network fees ${group.totals.networkFeeHsk} HSK, model calls in the execution path ${group.totals.modelCallsInExecutionPath}.`));
    const rows = [];
    for (const [metric, qs] of Object.entries(group.latency)) for (const [name, q] of Object.entries(qs)) {
      rows.push([group.lane, metric, name, q.n, q.value === null ? `Hidden: ${q.withheld}. Not yet run with sufficient samples.` : `${q.value} [${q.low ?? '−∞'}, ${q.high ?? '+∞'}]`]);
    }
    table(area, ['Lane', 'Measurement', 'Quantile', 'n', 'Value and interval'], rows);
    if (!group.trades.length) area.append(el('p', `${group.lane} · Trades: not yet run.`));
    else table(area, ['Lane', 'Time (trace or record)', 'Side', 'Input', 'Output', 'Gas units', 'Status', 'Receipt'], group.trades.map(t => {
      let receipt = 'No mainnet link';
      if (t.link) { receipt = el('a', 'Explorer'); receipt.href = t.link; receipt.target = '_blank'; receipt.rel = 'noopener noreferrer'; }
      return [t.lane, t.time, t.side, t.input, t.output, t.gas, t.reason ? `${t.status}: ${t.reason}` : t.status, receipt];
    }));
  }
  const attack = document.querySelector('#attacks');
  if (!data.attacks) attack.append(el('p', 'fork · Attack set: not yet run.'));
  else table(attack, ['Lane', 'Measurement', 'Value'], Object.entries(data.attacks).filter(([key]) => key !== 'lane').map(([key, value]) => ['fork', key, value ?? 'not yet run']));
  const vault = document.querySelector('#vault'); vault.append(el('p', data.vault.status));
  if (data.vault.tokens) {
    const link = el('a', data.vault.address); link.href = `${data.vault.explorer}/address/${data.vault.address}`; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const line = el('p', `${data.vault.lane} - Vault `); line.append(link, ` · Read at block ${data.vault.block}`); vault.append(line);
    table(vault, ['Lane', 'Token', 'Per-trade cap', 'Lifetime remaining', 'Floor output per input'], data.vault.tokens.map(t => [t.lane, t.token, t.maxTrade, t.remainingLifetime, t.floorOutputPerInput]));
  }
  document.querySelector('#chat-status').textContent = data.chat;
  document.querySelector('#ask').disabled = data.chat.includes('missing');
}
document.querySelector('#chat').onsubmit = async event => {
  event.preventDefault(); const button = document.querySelector('#ask'); button.disabled = true;
  const answer = document.querySelector('#answer'); answer.textContent = 'Waiting for model output…';
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: document.querySelector('#question').value }) });
    const result = await response.json(); answer.textContent = result.error ?? `${result.label}: ${result.text}`;
  } catch { answer.textContent = 'Chat is unavailable.'; }
  finally { button.disabled = false; }
};
load().catch(() => { document.querySelector('#state').textContent = 'Evidence could not be loaded. No result is claimed.'; });
