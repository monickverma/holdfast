# Holdfast

Holdfast is an HSKSwap trading agent for the **AI Agent Trading** track. It turns a plain-English strategy into a typed policy. A deterministic loop reads the pool, checks the policy and decides whether to trade. The LLM stays outside that hot path. The vault enforces token, per-trade, lifetime, output and expiry limits. The agent cannot withdraw funds.

No mainnet deployment or swap has happened yet. Holdfast is live on HSK testnet against our own test market, not HSKSwap (see below). The real LLM call is not yet tested. Profitability is not claimed.

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

Setup creates local wallet configuration if none exists and checks funding. Keep that configuration private. The fork commands start local Anvil and need access to the mainnet RPC. Contract tests build the artifact used by the fork commands.

Open `http://127.0.0.1:4177`. `PORT` changes the port. The viewer binds only to the loopback address. Set `ANTHROPIC_API_KEY` in the server environment to enable questions. Without it, the viewer still starts. It reads only `VAULT_ADDRESS`, `ANTHROPIC_API_KEY` and `LLM_MODEL` from `.env`, so wallet keys never enter its process. `VAULT_ADDRESS` enables pinned, read-only mainnet vault queries. No vault is queried otherwise. Environment values are not displayed.

The viewer uses plain HTML, CSS and JavaScript from `web/`, without a CDN. It reads named evidence files under `data/`, including run subdirectories. It does not expose a file download route. Symlinked evidence is skipped. Mainnet, fork and replay stay separate. Within a lane it pools every saved run, so it does not compare before and after; use [BENCHMARKS.md](BENCHMARKS.md) for that. Its revert count includes deliberate refusals. Each quantile shows its sample size. Unsupported quantiles are hidden with the reason from the shared statistics code.

Ledger rows use an explicit lane, a decision's matching trace, or their run directory's only lane. Rows with conflicting or no lane evidence are withheld. Missing timestamps are marked as not recorded. Mainnet and testnet rows get explorer links, and refused trades show the vault's revert reason. Set `NETWORK=testnet` to read the testnet vault. Chat answers are labelled model output. Policy requests belong in the existing REPL; this page cannot activate them.

## Evidence

| Lane | Recorded result |
|---|---|
| Testnet, 72 + 72 alternating swaps | Tick-to-receipt P50 795.0 → 509.3 ms (−35.9%), P95 1,025.9 → 728.7 ms (−29.0%) |
| Mainnet, read only, real HSKSwap pool, 400 + 400 | Market read P50 364.2 → 203.9 ms, P95 453.7 → 218.0 ms, P99 513.6 → 244.9 ms; 3 HTTP requests → 1; 0 mismatches in 80 compared blocks |
| Fork, real HSKSwap router | Gas per sell 157,470 → 130,807 (−16.9%); gas above a plain router swap 51,760 → 25,097 (−51.5%) |
| Fork | Attack set: 100/100 contained and 100/100 benign completed; 0 cap violations; maximum drained about 59.99 HSK against a 60 HSK cap |
| Fork | E2E 8/8, including crash recovery |
| Local | Forge 34/34, plus a separate fork test; agent 88/88; test-market E2E 7/7 |
| Testnet, own test market | 952 benchmark swaps on the current vault, 0 reverts; 0 of 440 fast receipts changed after sealing; refusals on chain |

[BENCHMARKS.md](BENCHMARKS.md) has the method, the metric ranking, the measurement flaws we found and what these numbers do not show. Source files are in `evidence/`.

Attack details are in `evidence/attack-results.json`. Reentrancy is covered only in the Foundry suite with a mock.

## Addresses

Mainnet Holdfast vault: **not yet deployed**.

Mainnet deployment transaction: **not yet run**.

Mainnet swap transaction: **not yet run**.

Testnet (chain 133) Holdfast vault: [`0x4bfc3aff6795f7a1cccd00a95f29d24356ceee89`](https://testnet-explorer.hskchain.net/address/0x4bfc3aff6795f7a1cccd00a95f29d24356ceee89).

## Known limits

The contract has not been audited. Per-trade and lifetime limits stop at 72 bits, about 4,722 tokens with 18 decimals; larger values are refused. A compromised agent can waste the remaining allowed spend. Gas exposure is separate from token caps. Fork results do not establish mainnet execution or profit.

Benchmark swaps are self-trades in a thin pool. They are not volume or traction. No sustained profitability is claimed. Sparse samples cannot support tail claims. Order-statistic intervals assume independent observations; RPC delays may be correlated.

The viewer does not infer missing lanes, synthesize trades or combine cohorts across lanes. Oversized, malformed or unreadable evidence may be withheld. It is a local evidence tool, not an authenticated public service. Refresh to reload saved evidence. Live model and vault integration checks are not yet run.

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

Local verification completed: 88 agent tests, 34 active Solidity tests (31 vault + 3 market), and 7 end-to-end scenarios including market sell, buy, confirmed stop-loss, over-cap and below-floor refusals. These are local checks; the public results follow.

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
- [10 tWHSK once 952 benchmark swaps had used most of the lifetime budget](https://testnet-explorer.hskchain.net/tx/0xd660206d33904df0af39ed4d9c9fd6f0f0a914e128184b52170fbd245d062b1e): reverted with `OverLifetimeCap`. This one was unplanned: it happened when the refusal script first ran with too large an order. 2.4 tWHSK of the 50 remains.

These are self-trades, not volume. Prices and P&L mean nothing here, and this says nothing about HSKSwap or mainnet.

The first testnet vault, `0xb06f965c5fa986e43c8ce3a866a4fae27b224b0b`, has 63 swaps and 3 refusals from before the gas work. Its market is separate.

Windows workaround: `tsx`/esbuild and Node's default test subprocess isolation failed with `spawn EPERM`. `build:agent` emits JavaScript with the installed TypeScript compiler; `test:agent:local` uses `--test-isolation=none`, and `e2e:testmarket` executes the emitted JavaScript. No packages were added.
