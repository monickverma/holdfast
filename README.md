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

The viewer uses plain HTML, CSS and JavaScript from `web/`, without a CDN. It reads named evidence files under `data/`, including run subdirectories. It does not expose a file download route. Symlinked evidence is skipped. Mainnet, fork and replay stay separate. Each quantile shows its sample size. Unsupported quantiles are hidden with the reason from the shared statistics code.

Ledger rows use an explicit lane, a decision's matching trace, or their run directory's only lane. Rows with conflicting or no lane evidence are withheld. Missing timestamps are marked as not recorded. Mainnet and testnet rows get explorer links, and refused trades show the vault's revert reason. Set `NETWORK=testnet` to read the testnet vault. Chat answers are labelled model output. Policy requests belong in the existing REPL; this page cannot activate them.

## Evidence

| Lane | Recorded result |
|---|---|
| Local contract suite; fork round trip | Forge 25/25 tests, plus a fork round trip |
| Fork | E2E 8/8 |
| Fork | Attack set: 100/100 contained and 100/100 benign completed; 0 cap violations; maximum drained about 59.99 HSK against a 60 HSK cap |
| Mainnet, read only | Pinned batch read P50 102 ms, n=12 |
| Fork | Swap gas 174,566; about 47k above the 127,767 baseline |
| Mainnet simulation | Deploy dry run accepted; gas 1,280,692. This was not a deployment. |
| Testnet, own test market | 63 swaps included, 0 unexpected reverts; 3 refusals on chain; decision to broadcast P50 490 ms, n=60. Details below. |

Attack details are in `data/attack-results.json`. Reentrancy is covered only in the Foundry suite with a mock.

The agent suite has 79 passing tests, including the viewer checks, and typechecking passes.

## Addresses

Mainnet Holdfast vault: **not yet deployed**.

Mainnet deployment transaction: **not yet run**.

Mainnet swap transaction: **not yet run**.

Testnet (chain 133) Holdfast vault: [`0xb06f965c5fa986e43c8ce3a866a4fae27b224b0b`](https://testnet-explorer.hskchain.net/address/0xb06f965c5fa986e43c8ce3a866a4fae27b224b0b).

## Known limits

The contract has not been audited. A compromised agent can waste the remaining allowed spend. Gas exposure is separate from token caps. Fork results do not establish mainnet execution or profit.

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

Local verification completed: 78 agent tests, 28 active Solidity tests (25 vault + 3 market), and 7 end-to-end scenarios including market sell, buy, confirmed stop-loss, over-cap and below-floor refusals. Deployment plus setup: **4,782,331 gas**, **0.004782331 HSK at 1 gwei**; actual local receipt fees **0.009564662 HSK**. Ledger trades/refusals: **561,279 gas**. These are local measurements; the public results follow.

### Public testnet results (2026-11-01, chain 133)

| Contract | Address |
|---|---|
| Vault | `0xb06f965c5fa986e43c8ce3a866a4fae27b224b0b` |
| tWHSK | `0xb631a47dbb8b2d8815123a69041cd3b96530c45f` |
| tUSDT | `0x144a61255b593b92270d07717acd56cb975490c9` |
| Pool | `0x2b1fa15b14998f1565d73e5a1ea8d4a365b0f901` |
| Router | `0x63046d8d8fc50cb0ee1cbc8533f1a73095832c26` |
| Quoter | `0x2e0113c032252c8fa00ccf646f5dbdc4b81563eb` |

Deployment and setup: 4,782,331 gas, 0.004787 HSK. An earlier attempt stopped when the public RPC returned an old nonce, leaving six unused contracts on chain; the deploy script now counts its own nonces and sets fixed gas limits.

Swaps through the vault, using the agent key:

- [Sell 1 tWHSK](https://testnet-explorer.hskchain.net/tx/0xf77148e4fce5f7613ccdcba4a8fb4d7bbc302b9dd464b543dce384eab21945af), [buy with 0.1 tUSDT](https://testnet-explorer.hskchain.net/tx/0x863b72203ead26db64466ce8b801b614ec165ff33c4f877d31df50e852b2fd6f).
- [An order for 11 tWHSK](https://testnet-explorer.hskchain.net/tx/0xac3f83f6c5b9eb7907805c033bd1541ff7701791182883aca06e89b450f1853e): the agent cut it to the 10 tWHSK cap before sending. This is the agent's own check, not a vault refusal.

Refusals by the vault, sent by `npm run refusals -- --broadcast`, which skips the agent's checks:

- [Zero minimum output](https://testnet-explorer.hskchain.net/tx/0xe3f51390e59826febe4a57c493b9b3425e2f8e13b11c09adbefd9f7cbd1f3cbb): reverted with `BelowFloor`.
- [11 tWHSK, over the trade cap](https://testnet-explorer.hskchain.net/tx/0xc81943a61920939e37c39b4f2ed731c40ecdde56662740ada113636c9ec5ae1f): reverted with `OverTradeCap`.
- [The agent key withdrawing](https://testnet-explorer.hskchain.net/tx/0x0de6af249e76acaf4fe7aa4d8c1ce1d4f2a243f75d953435a1387c3b7662594f): reverted.

Benchmark of 60 alternating swaps, about 0.1 tWHSK or 0.01 tUSDT each, one every 4 seconds: 60 sent, 60 included, 0 reverts. Decision to broadcast was P50 490 ms [484, 496] and P95 581 ms [561, unbounded], with P99 withheld because n=60 is below 299. All 60 were included one block after broadcast. Network cost was 0.00975 HSK, and no model was called on the execution path. These are self-trades, not volume. Prices and P&L mean nothing here, and this says nothing about HSKSwap or mainnet.

Reproduce with `npm run bench:swaps -- --n 60 --usd 0.01 --interval 4 --run bench-small --broadcast`, then `npm run report -- data/testnet/bench-small`, with `NETWORK=testnet` set.

Windows workaround: `tsx`/esbuild and Node's default test subprocess isolation failed with `spawn EPERM`. `build:agent` emits JavaScript with the installed TypeScript compiler; `test:agent:local` uses `--test-isolation=none`, and `e2e:testmarket` executes the emitted JavaScript. No packages were added.
