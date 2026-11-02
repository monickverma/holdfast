import type { HoldCode } from "./decide.js";

export interface Explanation {
  /** One line a person can read without knowing the code. */
  meaning: string;
  /** What to do about it. A refusal that needs nothing done says so. */
  action: string;
}

const NOTHING = "Nothing. This is the vault doing its job.";
const OWNER_LIMITS = "Only the owner can change this, with `npm run admin -- limits`.";

/** Every error the vault can return. A test fails if the vault gains one that is not here. */
export const VAULT_ERRORS: Record<string, Explanation> = {
  NotOwner: { meaning: "Only the owner's wallet may do this.", action: "Sign with the owner's wallet." },
  NotAgent: { meaning: "This wallet is not the vault's agent, so it may not trade.", action: NOTHING },
  NotOwnerOrAgent: { meaning: "Only the owner, the guardian or an unexpired agent key may pause.", action: NOTHING },
  NotOwnerOrGuardian: { meaning: "Only the owner or the guardian may do this.", action: NOTHING },
  NotPendingOwner: { meaning: "This wallet was not offered ownership.", action: "The current owner must offer it first." },
  IsPaused: { meaning: "The vault is paused, so the agent may not trade.", action: "Find out why it was paused. Only the owner can unpause." },
  Reentered: { meaning: "A token or router tried to call back into the vault during a transfer.", action: "Treat this token or router as hostile and withdraw." },
  BadToken: { meaning: "The vault only trades its two configured tokens.", action: NOTHING },
  BadAmount: { meaning: "The amount is zero, or the vault holds none of it.", action: "Check the vault's balance." },
  BadDeadline: { meaning: "The deadline has passed, or is more than two minutes away.", action: "The agent signs a new one. Nothing was spent." },
  IntentUsed: { meaning: "This intent ID has already run, so this is a replay.", action: NOTHING },
  OverTradeCap: { meaning: "The trade is larger than the most the owner allows in one trade.", action: OWNER_LIMITS },
  OverLifetimeCap: { meaning: "The trade is more than the agent has left to spend, ever.", action: `It stays this way until the owner raises it. ${OWNER_LIMITS}` },
  OverHourlyBudget: { meaning: "The trade is more than the hourly budget has refilled.", action: "Wait for it to refill. Nothing was spent." },
  OverDailyBudget: { meaning: "The trade is more than the daily budget has refilled.", action: "Wait for it to refill. Nothing was spent." },
  OverBalanceShare: { meaning: "The trade is a larger share of the vault's balance than the owner allows at once.", action: "Trade less, or the owner changes it with setMandate. Nothing was spent." },
  TradeTooSoon: { meaning: "The owner's minimum time between trades in this token has not passed.", action: "Wait for it. Nothing was spent." },
  OverLossBudget: { meaning: "At its minimum output this trade could lose more against the owner's mark than today's loss budget has left.", action: "Trade less, or wait for the budget to refill. Nothing was spent." },
  MarkStale: { meaning: "The owner's reference price is older than the owner allows, so the vault will not value a trade against it.", action: "The owner sets a fresh one with setLossGuard. Withdrawals still work." },
  BadMandate: { meaning: "That share or interval is outside what the vault accepts.", action: "Use a share up to 100% and an interval up to one day." },
  BadLossGuard: { meaning: "That mark, budget or age is outside what the vault accepts.", action: "A mark needs a budget that fits, and a mark of zero turns the guard off." },
  AgentExpired: { meaning: "The agent key has passed its expiry, or was revoked.", action: "Only the owner can renew it, with `npm run admin -- renew`." },
  BadExpiry: { meaning: "An agent key's expiry must be in the future and within 30 days.", action: "Choose a shorter expiry." },
  BelowFloor: { meaning: "The trade's minimum output pays less than the owner's price floor.", action: `If the market really is below the floor, the agent cannot sell. ${OWNER_LIMITS}` },
  InsufficientOutput: { meaning: "The swap paid less than the minimum the trade asked for.", action: "The price moved. The whole trade was undone and nothing was spent." },
  Overspent: { meaning: "The router took more than the trade allowed.", action: "Treat the router as hostile and withdraw." },
  TokenCallFailed: { meaning: "A token refused a transfer or approval.", action: "Check the token. It may be paused or blocking this vault." },
  ZeroAddress: { meaning: "An address was left empty.", action: "Give a real address." },
  LimitTooLarge: { meaning: "A limit does not fit its storage, and the vault refuses rather than cutting it down.", action: "Limits top out near 4,722 tokens with 18 decimals." },
  RemainingChanged: { meaning: "A trade changed the agent's allowance after you read it.", action: "Read it again and resend, so the new allowance is one you chose." },
  BadPriceGuard: { meaning: "The pool, window or band is not valid: wrong tokens or fee, an oracle that cannot answer, or a window outside 60 seconds to a day.", action: "Check the pool and its observation history." },
  OracleUnavailable: { meaning: "The pool's price history did not answer, so the vault will not trade blind.", action: "Wait, or have the owner turn the guard off. The owner can still withdraw." },
  PriceOutOfBand: { meaning: "This trade would leave the pool too far from its average price, which is what a pushed pool looks like.", action: "Wait for the price to settle. Nothing was spent." },
  NoPriceGuard: { meaning: "A stop needs a price guard, because that is where it reads the price.", action: "Set a guard first, with `npm run admin -- guard`." },
  BadStop: { meaning: "The stop's sizes, floor, band or cooldown are not valid.", action: "Check that the tranche is under the total and the cooldown is at least 60 seconds." },
  StopNotArmed: { meaning: "No stop is armed.", action: NOTHING },
  StopCoolingDown: { meaning: "The stop sold recently and is waiting out its cooldown.", action: "Try again after the cooldown." },
  StopNotTriggered: { meaning: "The average price has not crossed the stop's trigger.", action: NOTHING },
};

/** Every reason the agent can give for holding. A test fails if one is added and not explained. */
export const HOLD_REASONS: Record<HoldCode, Explanation> = {
  "no-signal": { meaning: "Nothing the strategy asks for is due.", action: "Nothing." },
  paused: { meaning: "The vault is paused.", action: "Only the owner can unpause." },
  "key-expired": { meaning: "The agent key has expired or was revoked.", action: "Only the owner can renew it." },
  "over-budget": { meaning: "The hourly or daily budget has no room yet.", action: "It refills over time." },
  "opportunity-taken": { meaning: "The edge rule already traded this price gap.", action: "It trades again once the gap has closed." },
  "inventory-limit": { meaning: "Another edge or model trade would hold more HSK, or owe more, than the policy allows.", action: "A trade the other way frees it up, such as the edge rule's own unwind when that is on." },
  "model-hold": { meaning: "The model looked at the market and proposed no trade.", action: "Nothing. It looks again when the signal changes." },
  "proposal-stale": { meaning: "The model's proposal was made too many blocks ago to act on.", action: "Nothing. A fresh one comes when the model is next asked." },
  "proposal-refused": { meaning: "The model proposed something the policy does not allow: a token it may not spend, or more than its size limit.", action: "Nothing. The model cannot widen its own limits." },
  "mark-disagrees": { meaning: "The outside price is too far from this pool to trust either.", action: "It rechecks every block." },
  "stop-blocked": { meaning: "The stop has triggered, but the owner's floor would refuse the sale.", action: "This needs a person: lower the floor, or withdraw." },
  "stop-disputed": { meaning: "The pool is at the trigger, but the outside price says it was pushed there.", action: "It waits about a minute, then sells anyway." },
  breaker: { meaning: "The agent's own circuit breaker has tripped.", action: "Look at why, then type `reset breaker`." },
  "strategy-not-pinned": { meaning: "The owner pinned a different strategy on the vault, so the policy this agent loaded may not trade.", action: "Load the pinned policy, or the owner pins this one with setStrategyPin." },
  "stale-state": { meaning: "The chain data is too old to trade on.", action: "Check the RPC." },
  "stale-mark": { meaning: "The outside price is too old to value a trade.", action: "Check the price feed." },
  "price-deviation": { meaning: "The pool has moved too far from its average price in the agent's own check.", action: "It rechecks every block." },
  "no-balance": { meaning: "The vault does not hold enough of the input token.", action: "Fund the vault." },
  "cap-exhausted": { meaning: "The agent has used all it may ever spend.", action: "Only the owner can raise it." },
  "no-limits": { meaning: "The owner has set no limits for this token, so it may not be traded.", action: "Set limits." },
  "below-floor": { meaning: "The best price is below the owner's floor.", action: "It rechecks every block." },
  uneconomic: { meaning: "After fees and gas, the trade would lose money.", action: "Nothing." },
  "stop-unconfirmed": { meaning: "The stop's condition has to hold across sealed blocks before it sells.", action: "Nothing." },
  requote: { meaning: "The limits changed, so the quote is for the wrong size.", action: "It quotes the new size next block." },
  "price-band": { meaning: "This trade would push the pool past the vault's price band.", action: "It rechecks every block." },
  "oracle-unavailable": { meaning: "The pool's price history did not answer, so the vault would refuse every trade.", action: "Wait, or have the owner turn the guard off." },
  "bad-mark": { meaning: "The outside price is crossed, zero or very wide, so it cannot value a trade.", action: "Check the price feed." },
  "price-impact": { meaning: "This order is large for the pool, and would pay too far under the current price.", action: "Use a smaller order, or raise maxImpactBps knowingly." },
  "preflight-unverified": { meaning: "The node could not confirm the trade, so it was not sent. A stop-loss would still go out.", action: "Check the RPC." },
  "preflight-uneconomic": { meaning: "At the vault's own output and the node's gas estimate, the trade no longer pays.", action: "Nothing." },
  "no-gas": { meaning: "The agent key holds too little gas for a node to accept the trade.", action: "Send the agent key some HSK." },
  "too-soon": { meaning: "The policy spaces trades apart, and the last one was too recent.", action: "It trades once the gap has passed, or change the pacing in the prompt." },
  "trade-count": { meaning: "The policy's count of trades for the last 24 hours is used up.", action: "It trades again as older trades leave the window, or change the pacing in the prompt." },
  "preflight-refused": { meaning: "The vault was asked first and said it would refuse, so no gas was spent.", action: "See the error it named." },
};

/** Takes a vault error's name, or a node's raw message, and always returns something readable. */
export function explainError(error: string): Explanation {
  const known = VAULT_ERRORS[error];
  if (known) return known;
  const named = Object.keys(VAULT_ERRORS).find((name) => new RegExp(`\\b${name}\\b`).test(error));
  if (named) return VAULT_ERRORS[named]!;
  return { meaning: "The transaction failed for a reason the vault did not name. It may have come from the pool or a token.", action: "Replay it with `cast run` to see where." };
}
