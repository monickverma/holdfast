# Independent council review of Holdfast

Written on 2 November 2026 by a separate review session using the LLM council skill, against commit `197c8b2`, the content of `main` at merge `44275a8`. It is the session's report as given, with only this header added. The council's working files were left out of the repository. Scores are the council's judgment, not measurements, and a later commit can make any of this out of date.

The council's verdict is that Holdfast is strong engineering, a poor fit for the track, and ineligible today because it has no mainnet deployment. It scored 0/10 for a prize as it stands, and about 2/10 (range 1–4, low confidence) if deployed. This was a review only: I changed no code and sent no transactions.

## Problem statement and criteria
Source: [DoraHacks, HSK Chain Horizon Hackathon India](https://dorahacks.io/hackathon/hskchainindia/detail), read today. The repository's summary of the rules wasn't used as a source.

- **Track:** an automated trading system on HSKSwap, "Powered by an AI agent as its core engine".
- **What it must do:** handle market monitoring, on-chain data analysis, signal identification and order execution, "Without any manual intervention". It should capture "arbitrage and price spreads" and "achieve sustained profitability under a strict risk-control and stop-loss framework".
- **Chat:** users view positions and P&L, and adjust sizing, frequency, risk appetite and target assets through conversation.
- **Mainnet gate:** "projects that have not completed deployment will be automatically deemed to have forfeited their eligibility for demo selection." Winners must also be on mainnet to claim a prize.
- **Selection:** "strong completeness, technical maturity and innovation". In-person Mumbai teams get priority, and "officially recommended products" earn extra points.
- **No published rubric:** there are no scoring weights, and I couldn't determine what counts as "officially recommended" for this track.
- **Deadline conflict:** the page says both 1 Nov and 2 Nov at 21:30 IST. Its countdown showed about 10 hours left when I read it earlier today.

## Scores

| Criterion | Final | Advisors | Reason (where the evidence comes from) |
|---|---|---|---|
| Mainnet rule | 0 | 0–1 | No contract and no transactions (mainnet read) |
| Closed-loop automation | 5 | 4–6 | Works through the real router (fork), but holds by default until given orders (code) |
| AI as core engine | 1 | 1–2 | No model in the trading loop (code), and the LLM has never been called (recorded as BLOCKED) |
| Arbitrage and spreads | 2 | 2–3 | One-legged trades (code); $0.42 at zero outside fee, 0 opportunities at 20 bps (mainnet read-only, simulated fills) |
| Sustained profitability | 0 | 0–1 | No P&L on any real market |
| Risk control and stop-loss | 7 | 8–9 | On-chain limits, and the agent's stop-loss works (fork); marked down for the unpaid keeper, no audit, and attack set run only on v3 |
| Natural-language interface | 2 | 3–4 | Scripted tests only; policy changes happen only in a terminal; no frequency or asset control |
| Completeness | 3 | 3–5 | v4 isn't on any public chain, and the README still describes v3 |
| Technical maturity | 7 | 7–8 | Tests I re-ran all pass (below); unaudited |
| Innovation | 4 | 4–7 | Many entries pitch the same "agent can't steal" idea |
| Prize chance today | 0 | 1–2 | The rule text forfeits demo selection and blocks prize claims |

## Where the council disagreed
- **Is it undervalued?** The Expansionist said yes and wanted to pitch it as infrastructure. The Contrarian, Outsider and First Principles Thinker said it answers the wrong question. The chairman sided with them, because a new pitch doesn't change what the track asks for.
- **Does an agent exist?** The Contrarian said "does not exist". The 8/8 fork run refutes that: a rule-based agent exists, but an AI one doesn't.
- **What is it worth after a fix?** The Expansionist said 5/10 and the Executor about 4/10, both assuming real trades and a live LLM too. The chairman found no evidence for either and gave about 2/10 for meeting the mainnet rule alone.
- **Scores set outside the advisors' range:** the chairman went below all five on risk control and chat, and below all five on prize chance.

## Strongest points
- **Key limits:** the agent key can only swap and can't withdraw. This holds in the code and on the fork.
- **Reliability:** on the fork, the stop-loss sells with no model and no reference price, and crash recovery fills only once.
- **Tests I re-ran, all passing:**
  - Local: 165/165 contract, 397/397 agent, 18/18 end to end.
  - Mainnet fork: 7/7 contract, 8/8 end to end.
- **Testnet record:** I counted 1,050 trade events on the older vault, but they were all against the team's own market with self-minted tokens.
- **Honesty:** the README itself marks the mainnet rule "Not met" and says profitability is not shown.

## Weakest points
- **Mainnet:** owner and agent wallets are at nonce 0 with 0 HSK. Deployment needs about 2.34 HSK, roughly $0.20 at the current pool price. A rival, Guarded Trade Agent, has a confirmed mainnet buy and sell, which I checked on chain.
- **AI:** `agent/src/decide.ts` has no model, and `agent/src/nl.ts` only serves chat.
- **Real market:** the pool did $8,324 in 7 days, with one wallet making about 94% of swaps. The edge rule's own code comment says "Nothing closes an edge trade on another venue", so it isn't arbitrage.
- **Public record:** the source says v4, the README says v3, and the v3 testnet vault has no trades and too little gas to make any.
- **Chat bug (found by reading the code, not by running it):** editing a policy gives orders new IDs, so a part-filled order can reset to its full amount. A human must still confirm, and vault caps still apply.

## What most limits its chances
The mainnet rule comes first, because it decides eligibility outright. After that comes fit, which deploying won't fix: the track wants an AI that earns from spreads, and Holdfast is a rule engine inside a very good safety cage. In the time left, that gap can only be disclosed, not closed.

**Council's advice:**
- **If about 3 HSK can be obtained:** deploy v4, make one small real swap through HSKSwap and one live LLM call, fix the README, record a video and submit. Describe it as a rule-based guarded trader with no profit shown, and disclose that Slither and the attack set haven't run on v4.
- **If not:** without a written exception from the organizers, it's out of the prize race. The council expects "lack of funds" to fail with judges at $0.20, though your testnet decision and how easily you can get HSK are yours to weigh.

## What I couldn't verify
- **Submission:** none of the 27 public builds is named Holdfast or shows your team's handles, but it could be a draft or listed under another name.
- **Not re-run:** the attack set, mutation check and Slither are the project's own recorded results.
- **Unknown:** live model behaviour, any organizer exception, Mumbai attendance, and whether a public site is live.
- **Rivals:** only Guarded Trade Agent was checked on chain. The Sentinel mainnet detail comes from your repo's own check, so the true number of eligible entries is unknown.
- **Originality:** all 15 commits fall within about 22 hours, and I can't tell whether earlier private work exists.
- **Files not opened:** your main checkout has `submission-video` and `SUBMISSION_DRAFTS.md`. Both are outside this review copy, so "no video" means none in the repository.
