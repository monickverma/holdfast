# Demo video script, 2 to 3 minutes

For the owner to record. Every number here has a named lane and a file behind it, so say the lane out loud. Where a line depends on something that may not have happened, there are two versions. **Use only the one that is true on the day you record.**

Before recording: close `.env`, clear terminal history, and start the site with `npm run viewer`.

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | First lines of the README | "Giving a trading agent a wallet means trusting it with everything. Holdfast keeps the agent's key inside limits a contract enforces, whatever the agent is told to do." |
| 0:15 | `contracts/HoldfastVault.sol`, the limits | "The vault owns the funds. The agent can only ask for a swap, and the vault checks caps, budgets, a price floor, a price band, a daily loss budget and a key that expires. Only the owner can withdraw." |
| 0:40 | Architecture graph, or `agent/src/decide.ts` | "I'll be exact about the AI. The trading loop is rules, with no model in it, so a bad model answer can't place a trade. The model sits outside: it answers questions and drafts a policy, and a person approves it. This is a rule-based guarded trader." |
| 1:00 | **If deployed:** the vault on `hsk.blockscout.com` | "This is version 4 on HSK Chain mainnet, at this address." |
| | **If not deployed:** the README's Addresses section | "It is not deployed on mainnet. That means it doesn't meet the rule for demo selection, and I'm saying so plainly. What follows ran on a fork of mainnet, a local copy of the chain." |
| 1:15 | **If a swap happened:** that transaction on the explorer | "This is one real swap through HSKSwap, signed by the agent key, inside the limits. One swap, not a track record." |
| | **If not:** `evidence/v4/mainnet-dress-rehearsal-fork.json` | "This is the same procedure on the fork, through the real router: deploy, limits, guard, then a swap. Those hashes exist only on the fork." |
| 1:35 | The site's "Try to break it" panel, or the refusals in the README | "The vault's refusals are the point. Here it refuses a zero minimum output, a trade over the cap, and the agent key trying to withdraw. Those are public testnet transactions, on our own test market and an older vault." |
| 2:00 | **If the live model call passed:** a terminal, a plain-English stop-loss, then the review and the confirmation | "You change the strategy in plain English. This code, not the model, shows what the policy does, and nothing runs until I type the confirmation." |
| | **If not:** `evidence/v4/llm-live.json`, showing `BLOCKED` | "The chat layer is built and tested with scripted replies only. It has never called a live model, so I make no claim that it works end to end." |
| 2:20 | `BENCHMARKS.md`, or the site's proof section | State results from the README's Evidence table, each with its lane. Use the attack set line for the version it names. |
| 2:40 | README, Known limits | "It isn't audited. No profit is shown: with an assumed 20 basis point outside fee, a 43 minute simulated run on real mainnet prices found no opportunities. The edge rule has no closing leg, so it isn't arbitrage. One wallet made 94% of the swaps in that pool over 7 days. What I can show is the limit holding." |

## Things not to say

- "Live" or "deployed" without the network.
- "Profitable", or anything implying sustained trading.
- "AI-powered trading". The model isn't in the trading loop.
- Any fork or testnet result as if it were mainnet.

## The existing explainer

`submission-video/holdfast-explainer.mp4` in the main checkout was made before version 4 and isn't in the repository. Its narration says nothing has been deployed on mainnet, the testnet vault is the older contract, and chat edits can re-arm a finished order (fixed in version 4 source since). If any of those has since changed, record again rather than reuse it. `submission-video/SUBMISSION.md` makes the same statements, so check it before pasting.
