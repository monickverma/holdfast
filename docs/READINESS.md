# Mainnet readiness

**Holdfast is not ready for real funds without an audit, and nothing here has been done on mainnet.** The team chose testnet for now. A mainnet deployment needs an explicit decision by the owner.

`Ready` means it exists and was exercised in the lane named. `Open` means a person must still do it.

## Before anything is deployed

| Check | State | How |
|---|---|---|
| Reproducible contract build | Ready | Solidity 0.8.28 pinned in `foundry.toml`, `npm ci` from the lockfile. Foundry itself is whatever is in `tools/`, 1.5.1 here |
| Contract tests, fork tests, agent tests | Ready, local and fork | `node scripts/record-verification.mjs`, writes `evidence/v3/verification.json` |
| Tests catch deliberate bugs | Ready, local | `npm run check:mutation` |
| Static analysis triaged | Ready, local | `npm run check:slither`, needs Slither installed |
| Attack set | Ready, fork | `npm run attack-set` |
| Whole lifecycle rehearsed | Ready, fork | `npm run rehearse`: 26 steps with throwaway keys. A testnet run is still open: it needs agent gas and the owner's approval |
| External audit | **Open** | None has been done. Do this before caps go up |
| Live model call | **Open, blocked** | `npm run llm:live` needs `ANTHROPIC_API_KEY`. Do not use chat for policy until it passes |

## Keys

| Check | State | How |
|---|---|---|
| Owner is a hardware wallet or a Safe | **Open** | The vault accepts a contract as owner. `.env` holds a plain key today, fine on testnet only |
| Agent key holds only gas, and only a little | **Open** | `monitor` warns when it runs low |
| Agent key expiry short, at most 30 days | Ready, enforced | `npm run admin -- renew` |
| A guardian on a separate key | **Open** | `npm run admin -- guardian`. It can stop things and nothing else |
| Keeper key holds only gas | **Open** | `KEEPER_PRIVATE_KEY`, used only with `--broadcast` |
| Keys never in the viewer | Ready, tested | It reads only named variables from `.env` |

## Deployment

Do these in order on testnet first, then mainnet with the smallest amount you are willing to lose.

1. `npm run preflight`, and check the chain, code, factory, tokens, fee and pool. Check the printed addresses against `agent/src/config.ts`.
2. Deploy. Compare the runtime code with the build, masking immutables, which matched on testnet. **Source verification on the explorer is open:** no submission has been run, so do this before funding.
3. Set small limits with `npm run admin -- limits`. They use `setLimitsIfRemaining`, which refuses if the allowance changed after you read it.
4. Set a daily budget, a guardian and a price guard: `admin -- daily`, `admin -- guardian`, `admin -- guard`. The guard stays off until you do this.
5. Arm a stop if you want one, with `admin -- stop`, and run `npm run keeper -- --watch --broadcast` somewhere, or accept that it may not fire.
6. Fund with a small amount.
7. Run with `MODE=simulate` first, so the vault's real answer is logged with no key loaded and no funds moved.
8. Then `MODE=live`, on a small size.
9. Run `npm run audit` and compare it with what you set.

Chain 177 needs `--confirm-mainnet` on each broadcast tool, which is deliberate. The refusal is covered in the rehearsal.

**Cost to know:** deploying version 3 takes 3,866,702 gas, against 1,707,783 for version 2 (fork, `evidence/v3/gas-compare.json`). The runtime is 17,420 bytes, under the 24,576 limit.

## Conservative starting limits

These are a suggestion, not a measurement of what is safe. Size them to the amount you accept losing. The pool is thin: see the cost of pushing it in [SECURITY.md](SECURITY.md).

| Limit | Suggestion |
|---|---|
| Per trade | A few dollars, while the agent is unproven on a real market |
| Hourly and daily budgets | A multiple of one trade you can watch |
| Lifetime cap | The amount at risk, with nothing above it in the vault |
| Floor | Close to the market, because the floor sets a thief's loss. Review it as the price moves |
| Price guard | A short window of about 10 minutes and a band of about 100 ticks, as in the rehearsal. Too tight will refuse normal trades, and this is not tuned on live data |
| Key expiry | Days, not the 30-day maximum |

## Monitoring and running it

| Check | State | How |
|---|---|---|
| Health check | Ready, fork | `npm run monitor`, exits 0, 1 or 2 for a cron job. Reads only, no key |
| Agent heartbeat | Ready, local | `npm run monitor -- --agent` |
| Site health | Ready | `/healthz`, used by `render.yaml` |
| Alerting | **Open** | Nothing pages anyone. Wire the monitor's exit code to something |
| Process supervision | **Open** | Nothing restarts the agent |

## If something goes wrong

There is no upgrade path in the contract. Rollback means withdrawing and deploying a new vault.

| Situation | Action | Who |
|---|---|---|
| Agent misbehaving | `npm run admin -- pause` | Owner, guardian, or the agent key |
| Agent key stolen | `npm run admin -- revoke`, which works in the same block | Owner or guardian |
| Anything else, or unsure | `npm run admin -- halt`, then withdraw | Halt by owner or guardian, withdraw by owner |
| Get funds out | `npm run admin -- withdraw`, or from the site's owner controls. Works when halted or revoked, tested in the rehearsal | Owner only |
| Bad version found | Withdraw, deploy a fixed vault, set limits, fund | Owner |
| Owner key at risk | `admin -- offer-ownership` to a safe address, then `accept-ownership` from it, or withdraw first | Owner |

## Public site

| Check | State | How |
|---|---|---|
| Deploy config | Written, **not deployed** | `render.yaml`. Merging it to the deployed branch would change the live site, so that is the owner's call |
| No paid endpoint open to visitors | Ready, tested | Chat needs `CHAT_TOKEN` off this machine. Leave it unset for a public site |
| Site reads version 3 | Ready, testnet | `render.yaml` points at `evidence/v3/testnet-deployment.json`. The vault there has its guard off until the owner sets it |
