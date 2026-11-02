# Mainnet runbook

**Nothing here has been run on mainnet.** Every command below ran on a local fork of mainnet with Anvil's public test keys, in this order: [`evidence/v4/mainnet-dress-rehearsal-fork.json`](../evidence/v4/mainnet-dress-rehearsal-fork.json), repeatable with `node scripts/mainnet-dress-rehearsal.mjs`. These commands spend real money and the contract is not audited, so running them is the owner's decision.

## What it costs

Read from mainnet on 2 November 2026: the base fee is 500 gwei, and recent transactions paid about that. Gas is from the fork run. At the pool's price of about $0.0876 per HSK, the whole thing is about $0.37.

| Step | Gas (fork) | HSK at 500 gwei | Key |
| --- | --- | --- | --- |
| Deploy version 4 | 4,666,365 | 2.333, plus an L1 fee of about 0.0002 | Owner |
| Limits, daily budget, guard, guardian, loss budget, wrap and send | 499,989 | 0.250 | Owner |
| Trading float, one swap's worth. It stays yours, as WHSK or USDT in the vault | | 1.000 | Owner |
| One swap | 202,215 | 0.101 | Agent |

**Send 3.65 HSK to the owner and 0.55 HSK to the agent, 4.2 HSK in all.**

- The owner must hold at least 2.83 HSK when it deploys. The tool reserves 5,645,480 gas and refuses to send on less. The unused part stays with the owner.
- The agent must hold at least 0.5 HSK to send a swap, because the agent reserves 500,000 gas at twice the base fee. A swap spends about 0.1, and the rest stays with the agent.
- **Deployment alone**, which is what the mainnet rule asks for, needs 2.83 HSK on the owner and no agent funds.

These replace the 2.34 HSK in the 2 November reviews, which came from a dry run before the last version 4 edits. The base fee can change, so read the dry run's figure on the day.

| Key | Address | State on 2 November (mainnet read) |
| --- | --- | --- |
| Owner | `0x1137FA10a0aE7e5Ac228d1B3b86CAc02b92Ef489` | Nonce 0, balance 0 |
| Agent | `0x6ddB61023935F3E05F4fb94551eA18e0f04d2FcA` | Nonce 0, balance 0 |

## Before you start

1. Run these from a checkout of this branch. `main` does not have the `loss` command or the mainnet flag on `swap-once` yet.
2. Keep the keys in `.env` in that folder, and never show it on screen. Set `VAULT_GENERATION=4`.
3. Choose a guardian address: a wallet other than the owner and agent. It can only stop things. The live agent refuses to start on mainnet without one.
4. Build:

```bash
npm ci
```

```bash
node scripts/forge.mjs build --offline
```

```bash
npm run build:agent
```

## Steps

Each command prints what it would do. Run it first without `--broadcast --confirm-mainnet` if you want to see that again.

**1. Dry run.** Expect `venue pass` and `Dry run`. Stop on anything else.

```bash
node .test-build/src/cli/deploy-vault.js --owner 0x1137FA10a0aE7e5Ac228d1B3b86CAc02b92Ef489 --agent 0x6ddB61023935F3E05F4fb94551eA18e0f04d2FcA
```

**2. Deploy.** This alone meets the mainnet rule. The record goes to `deployments/vault-177.json`. Put the printed address in `.env` as `VAULT_ADDRESS`.

```bash
node .test-build/src/cli/deploy-vault.js --owner 0x1137FA10a0aE7e5Ac228d1B3b86CAc02b92Ef489 --agent 0x6ddB61023935F3E05F4fb94551eA18e0f04d2FcA --broadcast --confirm-mainnet
```

**3. Limits.** Small ones: 1 HSK or 0.1 USDT a trade. Note the `spot` it prints, as micro-USDT per HSK, for step 7.

```bash
node .test-build/src/cli/admin.js limits --max-trade-hsk 1 --lifetime-hsk 2 --hourly-hsk 2 --max-trade-usdt 0.1 --lifetime-usdt 0.2 --hourly-usdt 0.2 --broadcast --confirm-mainnet
```

**4. Daily budget.**

```bash
node .test-build/src/cli/admin.js daily --token whsk --amount 2 --broadcast --confirm-mainnet
```

**5. Price guard.**

```bash
node .test-build/src/cli/admin.js guard --window 600 --band-ticks 100 --broadcast --confirm-mainnet
```

**6. Guardian.** Replace the address.

```bash
node .test-build/src/cli/admin.js guardian --address GUARDIAN_ADDRESS --broadcast --confirm-mainnet
```

**7. Loss budget.** Replace `0.0875` with the spot from step 3, divided by 1,000,000.

```bash
node .test-build/src/cli/admin.js loss --mark 0.0875 --amount 1 --max-age 86400 --broadcast --confirm-mainnet
```

**8. Fund.**

```bash
node .test-build/src/cli/admin.js fund --hsk 1 --broadcast --confirm-mainnet
```

**9. Check.** Expect `verdict pass`. On the fork, the trade line at the end said `held: preflight-refused ... OverTradeCap`, because it tries 10 HSK against the 1 HSK cap. That is expected with these limits, and it sends nothing.

```bash
node .test-build/src/cli/preflight.js --agent 0x6ddB61023935F3E05F4fb94551eA18e0f04d2FcA
```

**10. Preview the swap.** Sends nothing.

```bash
node .test-build/src/cli/swap-once.js sell 1
```

**11. The swap, signed by the agent key.** It prints the transaction and explorer link.

```bash
node .test-build/src/cli/swap-once.js sell 1 --broadcast --confirm-mainnet
```

**12. Publish the source.** This sends the source to the explorer, a third party, and needs the constructor arguments from the deployment.

```bash
node scripts/explorer-verify.mjs VAULT_ADDRESS --chain 177
```

Add `--constructor-args` and `--submit` to send it.

## Afterwards

Record the address, deployment transaction and swap transaction in `README.md` under Addresses, and keep them apart from fork and testnet results. One swap is proof that the path works on mainnet. It is not sustained trading or profit.

**To get funds back:**

```bash
node .test-build/src/cli/admin.js withdraw --token usdt --amount 0.08 --to 0x1137FA10a0aE7e5Ac228d1B3b86CAc02b92Ef489 --broadcast --confirm-mainnet
```

## What the fork cannot show

- A fork charges its own gas and no L1 fee, so costs above are the fork's gas at mainnet's read price, plus a read of the L1 fee for the deployment's bytes.
- Blocks, inclusion and the flashblock stream were not exercised. A custom RPC has no stream, so the agent polled.
- Nothing else traded in the pool during the run.
- Whether this pool is what `app.hskswap.com` routes to has not been checked.
