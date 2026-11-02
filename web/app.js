import { horizontalBars, lineWithRule, pairedBars, legend } from '/charts.js';
import { controlsFor, encodeCall, parseAmount, roleOf } from '/wallet.js';

const $ = (selector) => document.querySelector(selector);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; };
const link = (text, href) => { const a = el('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
const short = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'none');
const number = (value) => (value === null || value === undefined ? 'not yet run' : Number(value).toLocaleString('en-US'));
const LANE_NAMES = { mainnet: 'Mainnet', testnet: 'Testnet', fork: 'Fork', replay: 'Replay', local: 'Local' };
const laneOf = (text) => { const key = String(text ?? '').toLowerCase().split(/[\s,]/)[0]; return Object.hasOwn(LANE_NAMES, key) ? key : 'local'; };
const laneChip = (lane) => { const key = laneOf(lane); const chip = el('span', LANE_NAMES[key], 'lane'); chip.dataset.lane = key; return chip; };

function table(parent, headings, rows) {
  const wrap = el('div'); wrap.className = 'scroll';
  const grid = el('table'); const head = el('tr');
  for (const title of headings) { const cell = el('th', title); cell.scope = 'col'; head.append(cell); }
  const thead = el('thead'); thead.append(head); grid.append(thead);
  const body = el('tbody');
  for (const row of rows) { const tr = el('tr'); for (const value of row) { const td = el('td'); td.append(value instanceof Node ? value : document.createTextNode(String(value))); tr.append(td); } body.append(tr); }
  grid.append(body); wrap.append(grid); parent.append(wrap);
}

$('#theme').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
};

// ---------- Attacks ----------

const STATUS_ICON = { refused: '✕', other: '!', failed: '—' };
function renderVerdict(result) {
  const box = $('#verdict');
  box.replaceChildren();
  box.dataset.state = result.refused ? 'refused' : 'other';
  box.append(el('p', result.title, 'verdict-title'), el('p', result.story, 'verdict-story'));
  const stamp = el('div', '', 'stamp');
  stamp.append(el('span', `${result.refused ? STATUS_ICON.refused : STATUS_ICON.other} ${result.refused ? 'Refused' : 'Not refused'}`, 'stamp-word'));
  if (result.error) stamp.append(el('span', result.error, 'stamp-error'));
  box.append(stamp);
  if (result.meaning) box.append(el('p', result.meaning, 'verdict-meaning'));
  if (result.refused && !result.matchedExpected) box.append(el('p', `This attack was expected to fail with ${result.expected}. It failed differently, so this is what the vault's state says today.`, 'verdict-meaning'));
  const meta = el('p', '', 'verdict-meta');
  meta.append(laneChip(result.lane), ` Chain ${result.chainId}, block ${number(result.block)}. Sender ${short(result.from)}, vault `, link(short(result.vault), `${result.explorer}/address/${result.vault}`), '. Nothing was signed or sent.');
  box.append(meta);
}

async function loadAttacks() {
  const list = $('#attacks-list');
  try {
    const response = await fetch('/api/demo');
    const { attacks, available } = await response.json();
    if (!available) {
      $('#verdict').replaceChildren(el('p', 'This server has no vault configured, so there is nothing to attack.', 'verdict-idle'));
      return;
    }
    for (const attack of attacks) {
      const button = el('button', attack.title);
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      button.onclick = async () => {
        for (const b of list.querySelectorAll('button')) { b.disabled = true; b.setAttribute('aria-pressed', String(b === button)); }
        $('#verdict').replaceChildren(el('p', 'Asking the node…', 'verdict-idle'));
        delete $('#verdict').dataset.state;
        try {
          const reply = await fetch(`/api/demo/${attack.id}`);
          const result = await reply.json();
          if (!reply.ok) throw new Error(result.error);
          renderVerdict(result);
        } catch (error) {
          $('#verdict').dataset.state = 'failed';
          $('#verdict').replaceChildren(el('p', error.message || 'The network did not answer, so this ran nothing.', 'verdict-idle'));
        } finally {
          for (const b of list.querySelectorAll('button')) b.disabled = false;
        }
      };
      list.append(button);
    }
  } catch {
    $('#verdict').replaceChildren(el('p', 'The attack list could not be loaded.', 'verdict-idle'));
  }
}

// ---------- Vault ----------

function meter(label, available, total) {
  const row = el('div', undefined, 'meter');
  if (available === null || total === null || available === undefined || total === undefined) {
    row.append(el('span', label, 'meter-label'), el('span', 'Not in this vault generation', 'meter-value muted'));
    return row;
  }
  const a = Number(available); const t = Number(total);
  row.append(el('span', label, 'meter-label'), el('span', `${number(a)} of ${number(t)}`, 'meter-value'));
  const track = el('div', undefined, 'track');
  const fill = el('div', undefined, 'track-fill');
  fill.style.width = `${t > 0 ? Math.min(100, (a / t) * 100) : 0}%`;
  track.append(fill);
  row.append(track);
  return row;
}

function fact(label, value, state) {
  const row = el('div', undefined, 'fact');
  row.append(el('dt', label));
  const dd = el('dd');
  if (state) {
    const chip = el('span', `${{ good: '✓', warn: '!', bad: '✕', none: '–' }[state]} ${value}`, 'status');
    chip.dataset.state = state;
    dd.append(chip);
  } else if (value instanceof Node) dd.append(value);
  else dd.append(String(value));
  row.append(dd);
  return row;
}

function renderVault(vault) {
  const status = $('#vault-status');
  const body = $('#vault-body');
  if (!vault.tokens) { status.textContent = vault.status; return; }
  const generation = vault.version ?? null;
  status.replaceChildren(laneChip(vault.lane), ` Read from chain ${vault.chainId} at block ${number(vault.block)}, by this server, within the last few seconds.`);
  if (generation === null || generation < 3) {
    body.append(el('p', 'This vault is an older generation, deployed before the price guard, stop, guardian and daily budget in the contract described above. Those show as not available here. A redeployment is needed before they apply to this address. Its swaps are self-trades in our own thin test market, not volume.', 'callout'));
  }
  const addr = (address) => (address ? link(short(address), `${vault.explorer}/address/${address}`) : 'Not in this generation');
  const now = vault.blockTime;
  const expiry = vault.agentExpiry === null ? ['Not in this generation', 'none'] : vault.agentExpiry <= now ? ['Expired', 'bad'] : [`${((vault.agentExpiry - now) / 86_400).toFixed(1)} days left`, vault.agentExpiry - now < 172_800 ? 'warn' : 'good'];
  const facts = el('dl', undefined, 'facts');
  facts.append(
    fact('Vault', addr(vault.address)),
    fact('Generation', generation === null ? 'Earlier than 3' : generation),
    fact('Owner', addr(vault.owner)),
    fact('Agent key', addr(vault.agent)),
    fact('Guardian', vault.guardian === null ? 'Not in this generation' : /^0x0+$/.test(vault.guardian) ? 'None set' : addr(vault.guardian)),
    fact('Trading', vault.paused ? 'Paused' : 'Not paused', vault.paused ? 'warn' : 'good'),
    fact('Agent key expiry', expiry[0], expiry[1]),
    fact('Price guard', vault.guard === null ? 'Not in this generation' : vault.guard.on ? `On: ${vault.guard.bandTicks} ticks around a ${vault.guard.windowSec} s average` : 'Off', vault.guard === null ? 'none' : vault.guard.on ? 'good' : 'warn'),
    fact('Stop', vault.stop === null ? 'Not in this generation' : !vault.stop.armed ? 'Not armed' : vault.stop.ready ? 'Armed, ready to fire' : 'Armed, waiting', vault.stop === null ? 'none' : vault.stop.armed ? 'good' : 'none'),
  );
  body.append(facts);
  const grid = el('div', undefined, 'token-grid');
  for (const token of vault.tokens) {
    const card = el('div', undefined, 'token');
    card.append(el('h3', token.token), el('p', `Balance ${number(token.balance)}. Cap per trade ${number(token.maxTrade)}. Floor ${token.floorOutputPerInput} output per input.`, 'token-line'));
    // The vault stores what is left, not what was granted, so this has no bar: a full bar would mean nothing.
    const lifetime = el('div', undefined, 'meter');
    lifetime.append(el('span', 'Lifetime left', 'meter-label'), el('span', number(token.remainingLifetime), 'meter-value'));
    card.append(lifetime);
    card.append(meter('This hour', token.hourlyAvailable, token.hourlyBudget));
    if (token.dailyBudget !== null && token.dailyBudget !== undefined && Number(token.dailyBudget) === 0) {
      const today = el('div', undefined, 'meter');
      today.append(el('span', 'Today', 'meter-label'), el('span', 'No daily budget set', 'meter-value muted'));
      card.append(today);
    } else {
      card.append(meter('Today', token.dailyAvailable, token.dailyBudget));
    }
    grid.append(card);
  }
  body.append(grid);
  setupWallet(vault);
}

// ---------- Wallet ----------

function setupWallet(vault) {
  const panel = $('#wallet-panel');
  panel.hidden = false;
  const state = $('#wallet-state');
  const provider = () => window.ethereum;
  let account = null;

  const refresh = async () => {
    const box = $('#controls');
    box.replaceChildren();
    if (!account) return;
    const chain = Number(await provider().request({ method: 'eth_chainId' }));
    const role = roleOf(account, vault);
    state.textContent = `Connected ${short(account)} on chain ${chain}. Role on this vault: ${role === 'none' ? 'none' : role}.`;
    if (chain !== vault.chainId) {
      const change = el('button', `Switch the wallet to chain ${vault.chainId}`);
      change.type = 'button';
      change.onclick = async () => {
        try { await provider().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${vault.chainId.toString(16)}` }] }); await refresh(); }
        catch (error) { state.textContent = error.message || 'The wallet refused to switch.'; }
      };
      box.append(change);
      return;
    }
    const controls = controlsFor(role, vault.version);
    if (!controls.length) { box.append(el('p', 'This wallet has no role on this vault, so there is nothing for it to do here.', 'muted')); return; }
    for (const control of controls) box.append(controlRow(control, vault, () => account, provider));
  };

  $('#connect').onclick = async () => {
    if (!provider()) { state.textContent = 'No wallet found in this browser. The page stays read only.'; return; }
    try {
      [account] = await provider().request({ method: 'eth_requestAccounts' });
      await refresh();
    } catch (error) { state.textContent = error.message || 'The wallet refused the connection.'; }
  };
}

function controlRow(control, vault, accountOf, provider) {
  const row = el('div', undefined, 'control');
  row.append(el('h4', control.label), el('p', control.note));
  const inputs = {};
  const field = (name, label, type = 'text', value = '') => {
    const wrap = el('label', label);
    const input = el('input'); input.type = type; input.value = value; input.autocomplete = 'off';
    wrap.append(input); row.append(wrap); inputs[name] = input;
  };
  if (control.form === 'withdraw') {
    const wrap = el('label', 'Token');
    const select = el('select');
    for (const token of vault.tokens) { const option = el('option', token.token); option.value = token.address; select.append(option); }
    wrap.append(select); row.append(wrap); inputs.token = select;
    field('to', 'Send to', 'text', accountOf());
    field('amount', 'Amount');
  }
  if (control.form === 'agent') {
    field('agent', 'Agent address');
    field('days', 'Valid for, in days (30 at most)', 'number', '7');
  }
  const button = el('button', control.label);
  button.type = 'button';
  const error = el('p', '', 'field-error');
  button.onclick = async () => {
    error.textContent = '';
    try {
      let args = [];
      let detail = [];
      if (control.form === 'withdraw') {
        const token = vault.tokens.find((t) => t.address === inputs.token.value);
        args = [token.address, inputs.to.value.trim(), parseAmount(inputs.amount.value.trim(), token.decimals)];
        detail = [['Token', token.token], ['Send to', inputs.to.value.trim()], ['Amount', `${inputs.amount.value.trim()} ${token.token}`]];
      } else if (control.form === 'agent') {
        const days = Number(inputs.days.value);
        if (!(days > 0 && days <= 30)) throw new Error('Choose between 0 and 30 days.');
        const expiry = BigInt(Math.floor(Date.now() / 1000 + days * 86_400));
        args = [inputs.agent.value.trim(), expiry];
        detail = [['Agent', inputs.agent.value.trim()], ['Expires', new Date(Number(expiry) * 1000).toISOString()]];
      }
      await reviewAndSend(control, encodeCall(control.call, args), detail, vault, accountOf(), provider());
    } catch (problem) { error.textContent = problem.message; }
  };
  row.append(button, error);
  return row;
}

async function reviewAndSend(control, data, detail, vault, from, provider) {
  const dialog = $('#confirm');
  const body = $('#confirm-body');
  const check = $('#confirm-check');
  const send = $('#confirm-send');
  body.replaceChildren();
  const list = el('dl', undefined, 'facts');
  for (const [label, value] of [['Action', control.label], ['Vault', vault.address], ['Network', `${LANE_NAMES[laneOf(vault.lane)]}, chain ${vault.chainId}`], ['From', from], ...detail]) list.append(fact(label, value));
  body.append(list);
  send.disabled = true;
  check.textContent = 'Asking your wallet\'s node what the vault would say…';
  dialog.showModal();
  try {
    await provider.request({ method: 'eth_call', params: [{ from, to: vault.address, data }, 'latest'] });
    check.textContent = 'The vault would accept this. Your wallet will show it to you before anything is signed.';
    send.disabled = false;
  } catch (error) {
    check.textContent = `The vault would refuse this, so it cannot be sent from here. ${error.data?.message ?? error.message ?? ''}`;
    return;
  }
  send.onclick = async () => {
    send.disabled = true;
    check.textContent = 'Waiting for your wallet…';
    try {
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from, to: vault.address, data }] });
      check.replaceChildren('Sent, and not yet confirmed: ', link(short(hash), `${vault.explorer}/tx/${hash}`), '. Reload this page after a few seconds to see the vault\'s new state.');
    } catch (error) {
      check.textContent = error.message || 'The wallet did not send it.';
    }
  };
}

// ---------- Proof ----------

function tile(value, label, source) {
  const card = el('div', undefined, 'tile');
  card.append(el('p', value, 'tile-value'), el('p', label, 'tile-label'));
  const meta = el('p', '', 'tile-source');
  if (source?.lane) meta.append(laneChip(source.lane));
  if (source?.text) meta.append(` ${source.text}`);
  card.append(meta);
  return card;
}

const llmValue = (llm) => (!llm ? 'not yet run' : llm.passed !== null && llm.total !== null ? `${number(llm.passed)} of ${number(llm.total)}` : llm.status);
function llmLabel(llm) {
  if (llm?.status === 'BLOCKED') return 'Live model call: not tested. No API key was available, so no claim is made that it works';
  if (!llm) return 'Live model call';
  const where = llm.model ? ` on ${llm.model}${llm.provider ? ` via ${llm.provider}` : ''}` : '';
  return `Live model checks${llm.status ? ` ${llm.status === 'PASS' ? 'passed' : llm.status.toLowerCase()}` : ''}${where}, in one run. The model stays outside the trading path`;
}

function renderTiles(proof) {
  const tiles = $('#tiles');
  const suites = proof.verification?.suites ?? [];
  const suite = (name) => suites.find((s) => s.name === name);
  const fraction = (s) => (s ? `${number(s.passed)} of ${number((s.passed ?? 0) + (s.failed ?? 0))}` : 'not yet run');
  const m = proof.mutation; const s = proof.slither; const a = proof.attacks;
  tiles.append(
    tile(fraction(suite('contracts')), 'Contract tests pass, including seven invariants at 25,600 calls each', { lane: 'local', text: suite('contracts')?.command ?? '' }),
    tile(fraction(suite('fork')), 'Tests against the real HSKSwap pool', { lane: 'fork' }),
    tile(fraction(suite('agent')), 'Agent, viewer and SDK tests pass', { lane: 'local' }),
    tile(m ? `${number(m.killed)} of ${number(m.mutants)}` : 'not yet run', 'Deliberate bugs in the vault caught by the tests', { lane: m?.lane ?? 'local', text: 'npm run check:mutation' }),
    tile(s ? `${number(s.untriaged)} open` : 'not yet run', s ? `Of ${number(s.findings)} Slither findings, each triaged in the script` : 'Slither findings', { lane: 'local', text: 'npm run check:slither' }),
    tile(a ? `${number(a.contained)} of ${number(a.attacks)}` : 'not yet run', a ? `Attacks contained, with ${number(a.completed)} of ${number(a.benign)} normal trades completed and ${number(a.capViolations)} cap violations` : 'Attack set', { lane: a?.lane ?? 'fork', text: 'npm run attack-set' }),
    tile(proof.rehearsal ? number(proof.rehearsal.steps.length) : 'not yet run', 'Deployment rehearsal steps passed, from preflight to recovery', { lane: proof.rehearsal?.lane ?? 'fork', text: 'npm run rehearse' }),
    tile(llmValue(proof.llm), llmLabel(proof.llm), { lane: 'local', text: 'npm run llm:live' }),
  );
}

function renderGas(gas) {
  const area = $('#chart-gas');
  if (!gas) { $('#gas-sub').textContent = 'Not yet run.'; return; }
  const arms = [
    ['plain', 'The router alone, no vault', 2],
    ['v1', 'First vault', 2],
    ['v2', 'Version 2', 2],
    ['v3GuardOff', 'Version 3, guard off', 2],
    ['v3GuardOn', 'Version 3, guard on', 2],
    ['v3GuardDailyHash', 'Version 3, guard, daily budget and decision hash', 2],
    ['v4GuardOff', 'Version 4, guard off', 1],
    ['v4GuardOn', 'Version 4, guard on', 1],
    ['v4FullWithLossCharged', 'Version 4, every control on, loss charged', 1],
  ].filter(([key]) => gas.median[key]?.sell);
  const plain = Number(gas.median.plain?.sell);
  const rows = arms.map(([key, label, tone]) => {
    const sell = Number(gas.median[key].sell); const buy = Number(gas.median[key].buy);
    return { label, value: sell, tone, tip: [label, `Sell ${number(sell)} gas`, `Buy ${number(buy)} gas`, key === 'plain' ? 'The baseline' : `${number(sell - plain)} over the router alone`] };
  });
  const hasV4 = Boolean(gas.median.v4GuardOff?.sell);
  const off = Number(gas.median[hasV4 ? 'v4GuardOff' : 'v3GuardOff']?.sell); const on = Number(gas.median[hasV4 ? 'v4GuardOn' : 'v3GuardOn']?.sell); const previous = Number(gas.median[hasV4 ? 'v3GuardOff' : 'v2']?.sell);
  $('#gas-sub').replaceChildren(laneChip(gas.lane), ` Median sell, ${number(gas.rounds)} rounds, on a fork of the real pool. With the guard off this vault costs ${number(off - previous)} gas more than the previous one. Turning it on adds ${number(on - off)}.`);
  legend(area, [{ name: 'Earlier', tone: 2 }, { name: 'This vault', tone: 1 }]);
  horizontalBars(area, rows, { unit: 'gas', ariaLabel: 'Median gas per sell by vault version. A table follows.' });
  table($('#table-gas'), ['Arm', 'Sell', 'Buy'], arms.map(([key, label]) => [label, number(gas.median[key].sell), number(gas.median[key].buy)]));
  table($('#table-gas'), ['Deployment', 'Gas', 'Runtime bytes'], [['First vault', number(gas.deployGas.v1), number(gas.runtimeBytes.v1)], ['Version 2', number(gas.deployGas.v2), number(gas.runtimeBytes.v2)], ['Version 3', number(gas.deployGas.v3), number(gas.runtimeBytes.v3)], ...(gas.deployGas.v4 ? [['Version 4', number(gas.deployGas.v4), number(gas.runtimeBytes.v4)]] : [])]);
}

function renderVerifier(rows) {
  if (!rows?.length) { $('#verifier-table').replaceChildren(el('p', 'Not yet run.')); return; }
  table($('#verifier-table'), ['Where', 'Answer', 'Vault version', 'Log entries', 'Trades tied to a record'], rows.map((r) => [r.lane === 'local' ? 'Local chain, test market' : 'Public testnet, read only', r.status, r.vaultVersion ?? 'unknown', number(r.logEntries), `${number(r.tradesMatched)} of ${number(r.trades)}`]));
  const findings = rows.flatMap((r) => r.findings.map((f) => [r.lane === 'local' ? 'Local' : 'Testnet', f.severity, f.code, f.detail]));
  if (findings.length) table($('#verifier-findings'), ['Where', 'Answer', 'Code', 'Detail'], findings);
  else $('#verifier-findings').replaceChildren(el('p', 'Nothing.'));
  const link = $('#verifier-download');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' }));
  link.hidden = false;
}

function renderPush(rehearsal) {
  const rows = rehearsal?.manipulation?.rows ?? [];
  if (!rows.length) { $('#push-sub').textContent = 'Not yet run.'; return; }
  $('#push-sub').replaceChildren(laneChip(rehearsal.lane), ' Sell into the real pool on a fork and buy straight back. A floor on the cost: no other trader acts on a fork, and holding the price for a whole averaging window would add arbitrage losses it cannot measure.');
  lineWithRule($('#chart-push'), rows.map((r) => ({
    x: r.ticks, y: r.lossUsd, label: `$${number(r.lossUsd)} to move ${number(r.ticks)} ticks`,
    tip: [`${number(r.ticks)} ticks`, `About $${number(r.lossUsd)} lost on the round trip`, `${number(r.capitalWhsk)} WHSK of capital, about $${number(r.capitalUsd)}`],
  })), { xLabel: 'Ticks moved, about 1 bp each', yLabel: 'Round-trip loss', rule: { x: 100, label: '100-tick band in the rehearsal' }, ariaLabel: 'Round-trip loss against ticks moved in the real pool. A table follows.' });
  table($('#table-push'), ['Ticks moved', 'Round-trip loss', 'Capital'], rows.map((r) => [number(r.ticks), `about $${number(r.lossUsd)}`, `${number(r.capitalWhsk)} WHSK, about $${number(r.capitalUsd)}`]));
}

function renderLatency(latency) {
  if (!latency?.poll?.p50?.value) { $('#latency-sub').textContent = 'Not yet run.'; return; }
  const series = [{ name: 'Polling', tone: 2 }, { name: 'Flashblock stream', tone: 1 }];
  const row = (label, q) => ({
    label,
    values: [Math.round(latency.poll[q].value), Math.round(latency.stream[q].value)],
    tips: [
      [`Polling, ${label}`, `${latency.poll[q].value.toFixed(1)} ms`, `Interval ${latency.poll[q].low?.toFixed(1)} to ${latency.poll[q].high?.toFixed(1)} ms`, `n = ${latency.poll[q].n}`],
      [`Flashblock stream, ${label}`, `${latency.stream[q].value.toFixed(1)} ms`, `Interval ${latency.stream[q].low?.toFixed(1)} to ${latency.stream[q].high?.toFixed(1)} ms`, `n = ${latency.stream[q].n}`],
    ],
  });
  $('#latency-sub').replaceChildren(laneChip(latency.lane), ` On our ${(latency.venue ?? '').replace(/^own /, 'own ')}, with the older vault, ${number(latency.poll.attempts)} + ${number(latency.stream.attempts)} limit orders. Self-trades with no rivals, so this claims nothing about winning on mainnet.`);
  legend($('#chart-latency'), series);
  pairedBars($('#chart-latency'), series, [row('P50', 'p50'), row('P90', 'p90')], { unit: 'ms', ariaLabel: 'Event to receipt latency, polling against stream. A table follows.' });
  table($('#table-latency'), ['Arm', 'Quantile', 'Value, ms', 'Interval, ms', 'n'], ['poll', 'stream'].flatMap((arm) => ['p50', 'p90'].map((q) => [arm === 'poll' ? 'Polling' : 'Flashblock stream', q.toUpperCase(), latency[arm][q].value.toFixed(1), `${latency[arm][q].low?.toFixed(1)} to ${latency[arm][q].high?.toFixed(1)}`, latency[arm][q].n])));
}

function renderRehearsal(rehearsal) {
  if (!rehearsal) { $('#rehearsal-sub').textContent = 'Not yet run.'; return; }
  $('#rehearsal-sub').replaceChildren(laneChip(rehearsal.lane), ` Chain ${rehearsal.chainId}, forked, with throwaway keys. ${rehearsal.result}. Attacks, a keeper firing the stop, key rotation, a halt and a full withdrawal. Nothing reached the real chain.`);
  const list = $('#rehearsal-steps');
  for (const step of rehearsal.steps) {
    const item = el('li', step.name);
    if (step.gasUsed) item.append(el('span', ` ${number(step.gasUsed)} gas`, 'muted'));
    list.append(item);
  }
}

function renderTransactions(tx) {
  if (!tx) { $('#tx-sub').textContent = 'Not yet run.'; return; }
  $('#tx-sub').replaceChildren(laneChip(tx.lane), ` Real transactions on chain ${tx.chainId}, checked against their receipts at ${tx.checkedAt}. ${tx.note}`);
  const refusals = tx.rows.filter((r) => r.kind === 'refusal');
  const swaps = tx.rows.filter((r) => r.kind !== 'refusal');
  table($('#tx-table'), ['Lane', 'What happened', 'Status on chain', 'Block', 'Receipt'], [...refusals, ...swaps].map((r) => {
    const status = el('span', `${r.status === 'reverted' ? '✕' : '✓'} ${r.status === 'reverted' ? 'Reverted' : r.status === 'success' ? 'Succeeded' : r.status}`, 'status');
    status.dataset.state = r.status === 'reverted' ? 'bad' : 'good';
    return [laneChip(tx.lane), r.label, status, number(r.block), link('Explorer', `${tx.explorer}/tx/${r.hash}`)];
  }));
}

function renderAttackSet(attacks) {
  if (!attacks) { $('#attack-sub').textContent = 'Not yet run.'; return; }
  $('#attack-sub').replaceChildren(laneChip(attacks.lane), ' The compiled vault against the real router on a local fork, holding the agent key, so nothing off chain helps. A fork is not a mainnet run or an audit. Reentrancy needs a hostile router, so it is covered in the contract tests.');
  table($('#attack-table'), ['Family', 'Attacks', 'Contained'], attacks.families.map((f) => [f.family.replaceAll('-', ' '), number(f.attacks), number(f.contained)]));
}

async function loadProof() {
  try {
    const response = await fetch('/api/proof'); if (!response.ok) throw new Error();
    const proof = await response.json();
    renderTiles(proof);
    renderVerifier(proof.verifier);
    renderGas(proof.gas);
    renderPush(proof.rehearsal);
    renderLatency(proof.latency);
    renderRehearsal(proof.rehearsal);
    renderTransactions(proof.transactions);
    renderAttackSet(proof.attacks);
  } catch {
    $('#tiles').replaceChildren(el('p', 'The evidence could not be loaded from this server.'));
  }
}

// ---------- Market and venue ----------

async function loadVenue() {
  const status = $('#venue-status'); const body = $('#venue-body');
  try {
    const response = await fetch('/api/venue'); if (!response.ok) throw new Error();
    const venue = await response.json();
    if (!venue.market) { status.textContent = venue.status ?? 'Not verified right now.'; return; }
    status.replaceChildren(laneChip(venue.lane), ` Live read at block ${number(venue.block)} on chain ${venue.chainId}, ${venue.readAt}. Verdict: ${venue.verdict}.`);
    const m = venue.market;
    // Test tokens are worth nothing, so they are never called HSK or USDT.
    const [base, quote] = laneOf(venue.lane) === 'testnet' ? ['tWHSK', 'tUSDT'] : ['HSK', 'USDT'];
    const facts = el('dl', undefined, 'facts');
    facts.append(
      fact(`Pool price, ${quote} per ${base}`, m.priceUsdt), fact('Tick, and its 5-minute average', `${m.tick}, ${m.twapTick}`), fact('Active liquidity, raw units', m.liquidity),
      fact(`Selling 1 ${base} returns, ${quote}`, m.sell1), fact(`Selling 10 ${base} returns, ${quote}`, m.sell10), fact(`1 ${quote} buys, ${base}`, m.buyWith1Usdt),
      fact('Base fee, wei per gas', m.baseFeeWei), fact('Tip, wei per gas', m.priorityFeeWei), fact('L1 fee for a trade, wei', m.l1FeeWei),
    );
    body.replaceChildren(facts);
    table(body, ['Check', 'Result', 'Source', 'Detail'], venue.checks.map((c) => [c.name, c.status, c.source, c.detail ?? '']));
  } catch { status.textContent = 'The venue could not be read from this server.'; }
}

// ---------- Run data ----------

async function load() {
  const response = await fetch('/api/evidence'); if (!response.ok) throw new Error();
  const data = await response.json();
  const chip = $('#network');
  const lane = data.vault?.lane ?? data.network;
  chip.textContent = `${LANE_NAMES[laneOf(lane)]}${data.vault?.chainId ? `, chain ${data.vault.chainId}` : ''}`;
  chip.dataset.lane = laneOf(lane);
  renderVault(data.vault);
  if (data.chatOpen) { $('#chat-section').hidden = false; $('#chat-status').textContent = data.chat; }
  if (data.empty) {
    $('#state-public').textContent = 'This public server holds no run data, so its live tables are hidden. The results above are from the repository. Mainnet execution: not yet run.';
    return;
  }
  $('#lanes-section').hidden = false;
  $('#state').textContent = `Saved evidence is shown by lane. Mainnet execution: ${data.lanes.some(l => l.lane === 'mainnet' && l.totals.fills + l.totals.reverts > 0) ? 'see the mainnet trades below.' : 'not yet run.'}${data.lanes.some(l => l.lane === 'testnet' && l.trades.length) ? ' Testnet trades use our own test market with free test tokens, not HSKSwap, so their prices mean nothing.' : ''}`;
  if (data.incomplete) $('#state').append(' Some records were withheld: missing or ambiguous lane, unreadable data, or invalid records.');
  for (const group of data.lanes) {
    const area = $('#lanes'); area.append(el('h3', group.lane));
    area.append(el('p', `${group.lane} · Fills ${group.totals.fills}, reverts ${group.totals.reverts}, network fees ${group.totals.networkFeeHsk} HSK, model calls in the execution path ${group.totals.modelCallsInExecutionPath}.`));
    const rows = [];
    for (const [metric, qs] of Object.entries(group.latency)) for (const [name, q] of Object.entries(qs)) {
      rows.push([group.lane, metric, name, q.n, q.value === null ? `Hidden: ${q.withheld}. Not yet run with sufficient samples.` : `${q.value} [${q.low ?? '−∞'}, ${q.high ?? '+∞'}]`]);
    }
    table(area, ['Lane', 'Measurement', 'Quantile', 'n', 'Value and interval'], rows);
    const q = group.quality;
    if (q?.rows.length) {
      area.append(el('p', `${group.lane} · Fills ${q.fills}, with a recorded expectation ${q.fillsWithExpectation}. Mean slippage ${q.meanSlippageBps ?? 'not recorded'} bps. Realized net ${q.realizedNetUsdt ?? 'not recorded'} USDT. Outcomes the receipt could not confirm: ${q.unverifiedOutcomes}. ${q.definition}`));
      const shown = (value) => value ?? 'not recorded';
      table(area, ['Lane', 'Side', 'Quoted out', 'Actual out', 'Slippage bps', 'Cost to spot bps', 'Gas estimated', 'Gas used', 'Expected net USDT', 'Realized net USDT'], q.rows.map((r) => [group.lane, r.side, shown(r.quotedOut), r.amountOut, shown(r.slippageBps), shown(r.costToSpotBps), shown(r.gasEstimated), shown(r.gasUsed), shown(r.expectedNetUsdt), shown(r.realizedNetUsdt)]));
    }
    if (group.refusals?.length) table(area, ['Lane', 'Time', 'Refused by', 'Reason'], group.refusals.map((r) => [group.lane, r.time, r.code, r.reason ?? 'not recorded']));
    if (!group.trades.length) area.append(el('p', `${group.lane} · Trades: not yet run.`));
    else table(area, ['Lane', 'Time (trace or record)', 'Side', 'Input', 'Output', 'Gas units', 'Status', 'Receipt'], group.trades.map(t => {
      let receipt = 'No mainnet link';
      if (t.link) receipt = link('Explorer', t.link);
      return [t.lane, t.time, t.side, t.input, t.output, t.gas, t.reason ? `${t.status}: ${t.reason}` : t.status, receipt];
    }));
  }
  const attack = $('#attacks');
  if (data.attacks) { attack.append(el('h3', 'Attack set on this server')); table(attack, ['Lane', 'Measurement', 'Value'], Object.entries(data.attacks).filter(([key]) => key !== 'lane').map(([key, value]) => ['fork', key, value ?? 'not yet run'])); }
}

$('#chat').onsubmit = async event => {
  event.preventDefault(); const button = $('#ask'); button.disabled = true;
  const answer = $('#answer'); answer.textContent = 'Waiting for model output…';
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: $('#question').value }) });
    const result = await response.json(); answer.textContent = result.error ?? `${result.label}: ${result.text}`;
  } catch { answer.textContent = 'Chat is unavailable.'; }
  finally { button.disabled = false; }
};

loadAttacks();
loadProof();
loadVenue();
load().catch(() => { $('#state-public').textContent = 'Live run data could not be loaded. The results above are from the repository.'; $('#vault-status').textContent = 'The vault could not be read.'; $('#network').textContent = 'Network unknown'; });
