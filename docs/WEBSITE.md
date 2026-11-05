# Website and evidence guide

Open **[Holdfast](https://holdfast-09jn.onrender.com)**. The existing Render service serves the viewer. A free instance may take a moment to wake up.

## Choose a network

- [Mainnet view](https://holdfast-09jn.onrender.com/?network=mainnet): HashKey Chain **177**, vault **v4**, `0xbbd6f3df289a2fde6b5dd8edea19b827e0d07d3c`.
- [Testnet view](https://holdfast-09jn.onrender.com/?network=testnet): HashKey testnet **133**, vault **v3**, `0x9b31aeda4839747a4251d623ddfee4152c961b28`.

Use **View network** near the top, or either deployment card. The URL keeps your selection so you can share it. Mainnet is the page's default. Switching reloads the page, discards wallet controls and pending transaction reviews, and keeps the selected theme for the browser session. It does not change your wallet network, fund a vault or enable trading.

The selected network controls vault reads, venue checks, attack simulations and question context. Each network has a separate cache. The viewer uses fixed public RPC endpoints and committed deployment manifests, without modifying the process environment between requests. Visitors cannot supply a vault or RPC address. `NETWORK` still sets the default for API requests without a network query; an operator's `VAULT_ADDRESS` override applies only to that default network.

## Understand the status

**Deployed** means a contract exists and there is a deployment record. It does not mean the vault is funded, configured, audited, source-verified or profitable. The 3 November mainnet read found zero token balances, zero per-trade caps, no guardian and disabled price/loss guards. Zero caps prevent trading. The live vault section shows the actual read block and timestamp; if RPC reads fail, it says unavailable. The recorded deployment remains visible independently of RPC availability.

Testnet uses our own synthetic market and free **tWHSK/tUSDT**, not the mainnet HSKSwap market. Older testnet swaps do not imply that the current v3 testnet vault has traded.

**Try to break it** runs an `eth_call` on the selected chain. It signs and broadcasts nothing and spends no gas. The reported revert is what the node returned, which can differ from the expected refusal because of the current vault settings.

Owner controls are optional. Connecting reads your account and chain; the page offers controls for that account's role. Before a transaction can be sent, your wallet must match the displayed chain and account, the call is simulated, a review is shown, and your wallet asks for a signature. The page rechecks chain/account before sending. A changed account or chain invalidates the review.

## Find and assess the proof

**Progress** shows before/after measurements, recorded test counts, AI-engine changes, the ten review criteria and the three repository comparisons. **Proof** has the gas and latency charts, history verification and refusal records. **Docs** links the runbook, architecture, research and threat model.

Evidence labels retain their original meaning when you switch networks:

| Label | What happened |
|---|---|
| Mainnet read | Real chain data was queried; no trade is implied |
| Testnet | Free test tokens, usually in our synthetic market |
| Fork | Local copy of real chain state; no public transaction |
| Local | Unit tests, local end-to-end runs or a recorded model evaluation |
| Replay | Recorded prices with simulated fills; gains are not earned money |

Each result links to its artifact or method. The **31 → 50 /100** assessment is an unweighted review rubric, not a percentage complete. The separate historical comparison (**65.7, 53.9, 48.7, 29.4**) uses its own weights and pinned repository revisions from 2 November. It is not a current leaderboard, official judging result or independent security audit. The underlying historical reviews remain unchanged.

The AI engine can propose buy/sell/hold behind deterministic checks. It is off by default and has never traded on chain. The 14/14 live-model result evaluates chat requests on one model. The arbitrage modules perform research and read-only screening; they do not execute cross-venue trades. No sustained profit is demonstrated.

Download the public summaries at `/api/progress` and `/api/proof`. The former is an explicitly maintained, versioned presentation record; the latter reads named fields from saved artifacts. Neither exposes environment files, signed transactions or keys. Wallet keys are never loaded by the viewer. Public chat remains subject to the existing model-key, token and budget controls.

## Reproduce and maintain

```sh
npm ci --include=dev
npm run build:agent
node --test --test-isolation=none .test-build/test/*.test.js
node .test-build/src/cli/viewer.js
```

Open `http://127.0.0.1:4177/?network=mainnet`, then test `?network=testnet`. No wallet connection is needed. `TEST_MARKET_FILE=evidence/v3/testnet-deployment.json` labels saved testnet trading rows against the committed test market; live viewer contexts already use the committed manifests.

The Render build is `npm ci --include=dev && npm run build:agent`; its start command is `node .test-build/src/cli/viewer.js`. `/healthz` returns the validated `RENDER_GIT_COMMIT` when Render supplies it, so it can be compared with GitHub. A successful local build does not itself update the hosted service.

When measurements change, update `web/progress.json` and the linked documentation together. Preserve the historical source, date, environment, sample size and limitations. A newer agent-test recording belongs in `evidence/progress/site-verification.json`; it replaces only the agent count in the public digest and never restamps older Solidity/fork results. Do not describe an old chain snapshot as a current live read.
