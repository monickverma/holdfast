# Holdfast

Holdfast is an HSKSwap trading agent for the **AI Agent Trading** track. It turns a plain-English strategy into a typed policy. A deterministic loop reads the pool, checks the policy and decides whether to trade. The LLM stays outside that hot path. The vault enforces token, per-trade, hourly, daily, lifetime, output, price-band and expiry limits, and version 4 adds a daily loss budget, a limit on its share of the balance, a minimum time between trades and a log on chain. The agent cannot withdraw funds. **This is a rule-based guarded trader: no model is in the trading loop, and no profit is shown.**

**Vault version 4 is deployed on HSK mainnet** ([Addresses](#addresses)), but it has no limits, guardian or funds yet, so no mainnet swap has happened. Holdfast trades on HSK testnet against our own test market, not HSKSwap (see below). Version 4's trading has run only on local tests and forks. The newest public vault is version 3 on testnet, with its price guard off, and it has not traded there. The real LLM call is not yet tested. Profitability is not claimed.

Start with [docs/STATUS.md](docs/STATUS.md), which says what is done, tested, blocked and left for later. [docs/SECURITY.md](docs/SECURITY.md) has the threat model and [docs/READINESS.md](docs/READINESS.md) the deployment checklist, and [docs/MAINNET-RUNBOOK.md](docs/MAINNET-RUNBOOK.md) the exact mainnet steps and their cost, rehearsed on a fork only.

## Who this is for

Holdfast is for a person or small team that wants an agent to trade their funds but will not give it a wallet key that can empty them. With Holdfast, a stolen or misbehaving agent key can only make swaps inside limits that the owner set on chain. It cannot withdraw. It can still spend the remaining allowance badly, so the owner sets the limit to the amount they accept to risk.

No outside user has tried Holdfast. This is our target user, not a validated market.

## How it could earn money (proposal, not built)

- **A small fee on each swap through the vault.** The fee would be set in the contract and shown to the owner before deposit. The current vault charges no fee.
- **Paid hosting of the agent, for owners who do not want to run it.** The vault would still enforce the limits, so the host does not get custody.

There is no revenue and there are no customers. The fee level is not decided.

## What comes next

1. Deploy version 4 on HSK Chain mainnet with small caps, and trade through the real HSKSwap router: [the runbook](docs/MAINNET-RUNBOOK.md). It needs about 4.2 HSK, 2.83 for deployment alone.
2. Test the chat on more models and many more requests. So far one run of 8 English requests through OpenRouter to `deepseek/deepseek-v4-pro` passed 8 of 8 on 2 November 2026, for $0.009. No Claude model has been tested live.
3. Measure net result on HSKSwap: fill price against the price at the signal, after gas. Latency alone does not show that a trade was good.
4. Trade through a guarded version 4 vault with a guardian set, so these run on a public chain. They have only run on forks so far.
5. Run a keeper for the on-chain stop. The stop exists, and it fires only when someone calls it.
6. Get an external audit before the caps go up.

## How this meets the hackathon criteria

The India rules name completeness, technical maturity and innovation, and publish no weights. The other rows come from the track text and the Mumbai pitch outline, or from earlier Horizon events, which may not apply here.

| Criterion | Source | Where it stands | Evidence |
|---|---|---|---|
| Completeness | India rules | Monitor, decide and execute work on testnet. Live chat is untested. `render.yaml` describes the read-only site, and no public link is live today | [Evidence](#evidence) |
| Technical maturity | India rules | Tests, an attack set and benchmarks with sample sizes and stated flaws | [BENCHMARKS.md](BENCHMARKS.md) |
| Innovation | India rules | The vault enforces the limits, not the model. The agent reacts to flashblocks: market move to receipt P50 225.2 ms on testnet | `evidence/event-to-receipt/` |
| Mainnet deployment | India rules | **Deployed, not configured.** Version 4 is on mainnet with no limits, guardian or funds, so it cannot trade yet | [Addresses](#addresses), `evidence/v4/mainnet-deployment.json` |
| Trading loop with no manual steps | Track text | Done on testnet, on our own market, on an older vault. The agent holds until it is given orders | [Public testnet results](#public-testnet-results-2026-11-01-chain-133) |
| Risk control and stop-loss | Track text | Vault caps are enforced on chain. The agent has a stop-loss, and version 3 adds one on chain that anyone can fire, so far on forks only. Version 4 adds a daily loss budget | `evidence/v3/rehearsal-fork.json`, `evidence/v4/`, [Evidence](#evidence) |
| Sustained profitability | Track text | **Not shown.** No result on a real market | [Known limits](#known-limits) |
| Chat for positions, P&L and strategy | Track text | Built, including chat control of trade frequency (a gap between trades, a daily count) and of which of the pool's two tokens the agent may spend. Live model check: one run of 8 English requests through OpenRouter to `deepseek/deepseek-v4-pro` passed 8 of 8 on 2 November 2026, for $0.009. Policy changes happen only in a terminal | `agent/src/nl.ts`, `agent/test/controls.test.ts`, `evidence/v4/llm-live.json` |
| Whether it works, real problem | Hong Kong event | Refusals are public testnet transactions. The problem has no user evidence yet | [Public testnet results](#public-testnet-results-2026-11-01-chain-133) |
| Commercial potential, user experience | Japan event, Mumbai outline | Proposal above. A public site with a refusal demo, vault status and owner controls | This section and the viewer |

## Run locally

Install the locked packages with `npm ci`. Use Node with TypeScript tooling from this project. Install Foundry, including Forge and Anvil, for contract and fork tests.

```sh
npm run setup
npm run typecheck
npm run test:agent
npm run test:contracts
npm run e2e:fork
npm run attack-set
npm run viewer
```

Other tools: `npm run monitor` (health, exits 0, 1 or 2), `npm run keeper` (fires an armed stop, dry run by default), `npm run audit` (ties each on-chain trade to the decision that made it), `npm run mcp` (read and simulate over MCP, with no key), `npm run rehearse` (the whole lifecycle on a fork), `MODE=observe|simulate|live npm run agent`. `agent/src/sdk.ts` is the reusable client.

Setup creates local wallet configuration if none exists and checks funding. Keep that configuration private. The fork commands start local Anvil and need access to the mainnet RPC. Contract tests build the artifact used by the fork commands.

Open `http://127.0.0.1:4177`. `PORT` changes the port. The viewer binds to the loopback address unless `HOST` says otherwise, as `render.yaml` does. Set `OPENROUTER_API_KEY` (preferred when set, model `anthropic/claude-opus-5.5` unless `LLM_MODEL` names another) or `ANTHROPIC_API_KEY` in the server environment to enable questions on this machine. Without it, the viewer still starts. Each answer costs money, so off this machine a caller must also send `CHAT_TOKEN`, and without one public chat does not exist. `CHAT_DAILY_LIMIT` caps the total, 200 by default. It reads only `VAULT_ADDRESS`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `LLM_MODEL`, `CHAT_TOKEN` and `CHAT_DAILY_LIMIT` from `.env`, so wallet keys never enter its process. `VAULT_ADDRESS` enables pinned, read-only mainnet vault queries. No vault is queried otherwise. Environment values are not displayed.

The site's "Try to break it" panel runs named attacks by `eth_call` against the configured vault: nothing is signed or sent, and a visitor supplies no input but the name. Owner controls use the visitor's own wallet. The page's measured results come from named fields of named files under `evidence/`, by `/api/proof`.

The viewer uses plain HTML, CSS and JavaScript from `web/`, without a CDN. It reads named evidence files under `data/`, including run subdirectories. It does not expose a file download route. Symlinked evidence is skipped. Mainnet, fork and replay stay separate. Within a lane it pools every saved run, so it does not compare before and after; use [BENCHMARKS.md](BENCHMARKS.md) for that. Its revert count includes deliberate refusals. Each quantile shows its sample size. Unsupported quantiles are hidden with the reason from the shared statistics code.

Ledger rows use an explicit lane, a decision's matching trace, or their run directory's only lane. Rows with conflicting or no lane evidence are withheld. Missing timestamps are marked as not recorded. Mainnet and testnet rows get explorer links, and refused trades show the vault's revert reason. Set `NETWORK=testnet` to read the testnet vault. Chat answers are labelled model output. Policy requests belong in the existing REPL; this page cannot activate them.

In the REPL (`npm run agent`), a person can also set how often the agent trades and which token it spends, for example "at most twice a day, an hour apart" or "only ever sell HSK". These are the agent's own limits, checked in chain time against the trades it has sent, and the review shown before approval states them. A stop-loss is never held back by them. They sit under the vault's limits, not in place of them: the owner's on-chain cooldown and caps still apply. The vault holds HSK and USDT and trades only the WHSK/USDT pool, so "which asset" means which of those two the agent may spend. Any other asset would need a new vault.

## Evidence

| Lane | Recorded result |
|---|---|
| Testnet, 45 + 45 limit orders | Market move to receipt, polling against reacting to the flashblock stream: P50 1,628.5 → 225.2 ms (−86.2%), P90 2,230.2 → 413.5 ms (−81.5%); 90 of 90 filled |
| Mainnet, read only, real HSKSwap Quoter | Local quote math matched the Quoter in 250 of 250 comparisons |
| Testnet, 72 + 72 alternating swaps | Tick-to-receipt P50 795.0 → 509.3 ms (−35.9%), P95 1,025.9 → 728.7 ms (−29.0%) |
| Mainnet, read only, real HSKSwap pool, 400 + 400 | Market read P50 364.2 → 203.9 ms, P95 453.7 → 218.0 ms, P99 513.6 → 244.9 ms; 3 HTTP requests → 1; 0 mismatches in 80 compared blocks |
| Fork, real HSKSwap router, vault version 2, median of 20 rounds | Gas above a plain router swap: first vault 51,760, older vault 25,097, version 2 28,375. Version 2 is worse than the older vault, the cost of key expiry and the hourly budget |
| Fork, vault version 2 | Attack set: 120/120 contained and 120/120 benign completed; 0 cap violations. A stolen key selling into a pool pushed to the floor: 60 HSK sold, $2.23 lost; with the budget at a third of the cap, 20 HSK, $0.74 lost; one run each |
| Mainnet read replay, 992 samples, simulated, no outside fee | Edge fills at $15 if a gap stays open: 53 → 11 per gap → 1 with the inventory limit |
| Local, vault version 4 | Forge 165/165; agent 413/413; test-market E2E 18/18; 55 of 55 deliberate bugs caught; Slither 0.11.6, 34 findings, 0 untriaged, 4 of them first seen on version 4 and triaged by us in `scripts/slither-check.mjs`. `evidence/v4/verification.json`, `e2e.json`, `mutation-check.json`, `slither.json` |
| Fork, vault version 4 | Forge 7/7 against the real pool; E2E 8/8, including crash recovery. Every step of the [mainnet runbook](docs/MAINNET-RUNBOOK.md), ending in one swap through the real router: `evidence/v4/mainnet-dress-rehearsal-fork.json`. Attack set: 120/120 contained and 120/120 benign completed, 0 cap violations. 26-step lifecycle rehearsal passed. Both ran with version 4's loss budget, share limit and cooldown left off, so those are tested only in the Foundry suite. `attack-results.json`, `rehearsal-fork.json` |
| Local, vault version 3 | Forge 129/129 including 7 invariants at 25,600 calls each; agent 289/289; test-market E2E 7/7; 37 of 37 deliberate bugs caught. `evidence/v3/verification.json`, `e2e.json`, `mutation-check.json` |
| Fork, vault version 3 | Forge 6/6 against the real pool; E2E 8/8; attack set 120/120 contained and 120/120 benign completed, 0 cap violations; 26-step lifecycle rehearsal. `evidence/v3/` |
| Earlier, vault version 2 | Forge 51/51, plus a separate fork test; agent 191/191; test-market E2E 7/7 |
| Mainnet, read only, 7 days of the real pool | 462 swaps, $8,324 volume; one wallet made 94% of them; no latency race exists there today |
| Mainnet, read only, 43 minutes, simulated fills | With an assumed 20 bps outside fee: 0 opportunities. Without it: 13, all within 7 minutes, $0.42 acting at once at $150 |
| Mainnet, read only | Frames against sealed blocks: 410 of 410 hashes matched, 0 of 207 user transactions vanished; real Swap logs decoded correctly in 284 of 284 blocks |
| Testnet, own test market, **old vault** | 1,050 benchmark swaps, 0 reverts; 0 of 440 fast receipts changed after sealing; refusals on chain |

Set `STREAM=true` to make the agent react to flashblocks as well as poll. It is off by default. The reaction has run on testnet only, and no mainnet trade has been sent.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the threat model, layers, invariants and failure modes, and corrects our own earlier claims. [BENCHMARKS.md](BENCHMARKS.md) has the method, the metric ranking, the measurement flaws we found and what these numbers do not show. Source files are in `evidence/`.

Attack details are in `evidence/attack-results.json`. Reentrancy is covered only in the Foundry suite with a mock.

## Addresses

Mainnet (chain 177) Holdfast vault, version 4: [`0xbbd6f3df289a2fde6b5dd8edea19b827e0d07d3c`](https://hsk.blockscout.com/address/0xbbd6f3df289a2fde6b5dd8edea19b827e0d07d3c). Deployed by the owner key `0x1137…f489` for agent `0x6ddB…2FcA`, whose access expires 7 days after deployment unless renewed. The runtime code matches the build. No limits, guardian, price guard, loss budget or funds are set, so it cannot trade yet.

Mainnet deployment transaction: [`0x24d61d8021a549b45680db3108431d661bf488294783b9f59bc7ba2c39e3be34`](https://hsk.blockscout.com/tx/0x24d61d8021a549b45680db3108431d661bf488294783b9f59bc7ba2c39e3be34), block 29,657,434, 4,666,365 gas, 2.333 HSK plus a 0.0002 HSK L1 fee. Record: `evidence/v4/mainnet-deployment.json`.

Mainnet swap transaction: **not yet run**.

Public site: [holdfast-09jn.onrender.com](https://holdfast-09jn.onrender.com), on Render's free plan, so the first visit after a quiet spell can take about a minute. It reads the **testnet** version 3 vault above (`NETWORK=testnet`), holds no wallet key, and has chat off.

Testnet (chain 133) Holdfast vault, version 3: [`0x9b31aeda4839747a4251d623ddfee4152c961b28`](https://testnet-explorer.hskchain.net/address/0x9b31aeda4839747a4251d623ddfee4152c961b28). Its runtime code matched the build when it was deployed, and differs from today's version 4 source. Price guard off, no guardian, no stop armed. Addresses are in `evidence/v3/testnet-deployment.json`.

Older testnet vault, where the public swaps and refusals below happened: [`0x4bfc3aff6795f7a1cccd00a95f29d24356ceee89`](https://testnet-explorer.hskchain.net/address/0x4bfc3aff6795f7a1cccd00a95f29d24356ceee89). It has no key expiry or hourly budget, and the agent reads it in a legacy mode.

## Known limits

The contract has not been audited. Limits stop at 72 bits, about 4,722 tokens with 18 decimals; larger values are refused. A stolen agent key can sell at the floor inside its limits until it expires, up to the hourly budget. Under the floor, the agent's stop-loss is blocked too, and it can only raise an alert. The on-chain stop in version 3 fires only when someone calls it, sells only above its own floor, and can be fired by a price held off the market for a whole window: the pool is thin enough that this is cheap, as [measured](BENCHMARKS.md#version-3). It is deployed on testnet but not armed. Gas exposure is separate from token caps. Fork results do not establish mainnet execution or profit.

The edge rule trades one leg against an outside price, and nothing closes that trade on another venue, so it is not arbitrage and leaves the vault holding inventory. On the real pool, one wallet made about 94% of the swaps over 7 days.

Benchmark swaps are self-trades in a thin pool. They are not volume or traction. No sustained profitability is claimed. Sparse samples cannot support tail claims. Order-statistic intervals assume independent observations; RPC delays may be correlated.

The viewer does not infer missing lanes, synthesize trades or combine cohorts across lanes. Oversized, malformed or unreadable evidence may be withheld. It has no accounts: everything it serves is public, and its one paid endpoint is closed off this machine. Refresh to reload saved evidence. The chat layer is tested with scripted replies, and live in one run of 8 English requests through OpenRouter to `deepseek/deepseek-v4-pro` passed 8 of 8 on 2 November 2026, for $0.009. That is one small run on one model, not a measure of reliability.

## HSK testnet: our own test market

This is **our own test market, not HSKSwap**. Prices and P&L there mean nothing. Testnet does **not** meet the hackathon's mainnet rule for demo selection or prizes unless the organizers agree.

`NETWORK=mainnet` remains the default, with the original addresses and RPC. `NETWORK=testnet` selects chain **133**, `https://testnet.hsk.xyz`, and the separate **testnet** evidence lane. Addresses and the vault are loaded from gitignored `data/testnet-market.json`; a manifest for a different chain is refused. Testnet evidence defaults to `data/testnet`. Reports refuse mixed lanes; the viewer keeps testnet separate. Do not share run directories across networks.

The small constant-product market charges 0.3%. Its freely mintable tWHSK (18 decimals) and tUSDT (6 decimals) have no backing or value. WHSK is explicitly token0 regardless of address ordering. Router/quoter/pool expose the interfaces consumed by the unchanged HoldfastVault and agent, but this is **not Uniswap V3**. `observe` synthesizes tick cumulatives at the current tick, not genuine historical observations; it cannot validate production TWAP protection. The quoter's extra price field is spot, not a V3 post-swap prediction. Local Anvil has no L1 fee oracle, so that fee is zero in the local script only.

Build offline using the already installed tools:

```powershell
node scripts/forge.mjs build --offline
npm run typecheck
npm run test:contracts -- --offline --no-match-contract HoldfastVaultForkTest
npm run test:agent:local
npm run e2e:testmarket
```

The end-to-end script starts fresh local Anvil on port 8601, chain 31337, without a fork or public RPC. It uses Anvil's public default test keys, assigns each wallet only 0.1 native HSK, deploys six contracts, seeds 1,000,000 tWHSK / 100,000 tUSDT, and mints 100 tWHSK / 10 tUSDT directly to the vault. Per-trade limits are 10 tWHSK / 1 tUSDT, lifetime inputs 50 tWHSK / 5 tUSDT, and floors 0.09 tUSDT per tWHSK / 9 tWHSK per tUSDT. **Trading float never comes from native HSK.** Its manifest and evidence stay in a temporary folder, so local runs never replace the public manifest or appear as testnet evidence.

For public testnet use, `.env` supplies the wallet keys:

```powershell
$env:NETWORK = 'testnet'
npm run deploy:testmarket # dry plan only; sends nothing, writes nothing
# Only when intentionally deploying to public testnet:
npm run deploy:testmarket -- --broadcast
```

The deploy command refuses chain 177 and unknown chains, prints actual receipt gas and cost after broadcast, and preflights a 15-million-gas budget against 0.05 HSK at the current gas price. Without AGENT_PRIVATE_KEY, the owner is also the agent. `setup` under NETWORK=testnet requests **0.05 HSK per wallet**, reads the selected network, and checks its chain ID; setup retains its existing wallet-file workflow. Admin wrapping is refused on testnet: use minted tokens.

Local verification at the time of that deployment: 99 agent tests, 34 Solidity tests and 7 end-to-end scenarios. Current counts are in [Evidence](#evidence). The public results that follow are from the old vault.

### Public testnet results (2026-11-01, chain 133)

| Contract | Address |
|---|---|
| Vault | `0x4bfc3aff6795f7a1cccd00a95f29d24356ceee89` |
| tWHSK | `0xea8504d84ce0568e7d31f86f7a039c1bb84f21c5` |
| tUSDT | `0x328946667b290a941cfbadb37bc86000340187cd` |
| Pool | `0x2ddb1fb72f7dd84af5906b1cf8c272aaf7c88641` |
| Router | `0xc9b2c962d37c9492bf2378435f5f564126d1f491` |
| Quoter | `0xe5f9bab21afabf26eb3246ac62408ab5fda240ff` |

Deployment and setup: 4,793,616 gas, 0.0047984 HSK.

Swaps through the vault, using the agent key: [a benchmark swap](https://testnet-explorer.hskchain.net/tx/0xdfecf966a18aece26398932a56fa65a839486ac7eeee76c739526ae7e360bf2f) and [the next one](https://testnet-explorer.hskchain.net/tx/0x223e00b5b1d7d2e1ca0308243bd0724ead0f8b947e1db36e667eb33989927986).

Refusals by the vault, sent by `npm run refusals -- --broadcast`, which skips the agent's checks:

- [Zero minimum output](https://testnet-explorer.hskchain.net/tx/0x9eba7bf0d3721c8f64f6c6d926871fb5432d85c1fcab6b6c78f606d4c6bfb7a0): reverted with `BelowFloor`.
- [11 tWHSK, over the trade cap](https://testnet-explorer.hskchain.net/tx/0x7d41dda69fccbcf61382a40767287cbb41895b789668826c6dc7740f0aa03792): reverted with `OverTradeCap`.
- [The agent key withdrawing](https://testnet-explorer.hskchain.net/tx/0x276712cd2d682fa6dface8ea5bcb7273f164c5d796be58dcc2b0842ddf175b67): reverted.
- [10 tWHSK once 952 benchmark swaps had used most of the lifetime budget](https://testnet-explorer.hskchain.net/tx/0xd660206d33904df0af39ed4d9c9fd6f0f0a914e128184b52170fbd245d062b1e): reverted with `OverLifetimeCap`. This one was unplanned: it happened when the refusal script first ran with too large an order.

These are self-trades, not volume. Prices and P&L mean nothing here, and this says nothing about HSKSwap or mainnet.

The first testnet vault, `0xb06f965c5fa986e43c8ce3a866a4fae27b224b0b`, has 63 swaps and 3 refusals from before the gas work. Its market is separate.

Windows workaround: `tsx`/esbuild and Node's default test subprocess isolation failed with `spawn EPERM`. `build:agent` emits JavaScript with the installed TypeScript compiler; `test:agent:local` uses `--test-isolation=none`, and `e2e:testmarket` executes the emitted JavaScript. No packages were added.
