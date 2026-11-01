// Fixed attacks a visitor can try against the deployed vault. Each is one eth_call: the node runs the call against real
// state with an unauthenticated sender, nothing is signed and nothing reaches the chain. The visitor picks a name and
// supplies no address, amount or calldata, so the endpoint cannot be used as a general RPC proxy.
import { decodeErrorResult, encodeFunctionData, keccak256, stringToHex, type Address, type Hex } from "viem";
import { explainError } from "./explain.js";
import { VAULT_ABI } from "./reader.js";

export const STRANGER: Address = "0x000000000000000000000000000000000000dEaD";

export interface DemoContext {
  vault: Address;
  /** The vault's own current agent, so the call is made in that key's name. */
  agent: Address;
  owner: Address;
  tokenIn: Address;
  maxTrade: bigint;
  /** The most one trade could still spend, so a floor test is not stopped earlier by a cap the vault has nearly used. */
  spendable: bigint;
  /** The chain's clock at the block the call is pinned to. */
  timestamp: bigint;
}

interface Attack {
  title: string;
  story: string;
  actor: "the agent key" | "a stranger";
  expected: string;
  call: (c: DemoContext) => { from: Address; data: Hex };
}

const intent = (name: string) => keccak256(stringToHex(`holdfast-public-demo:${name}`));
const execute = (c: DemoContext, name: string, from: Address, tokenIn: Address, amountIn: bigint, minOut: bigint, deadline: bigint) => ({
  from,
  data: encodeFunctionData({ abi: VAULT_ABI, functionName: "execute", args: [tokenIn, amountIn, minOut, deadline, intent(name)] }),
});

export const DEMO_ATTACKS: Record<string, Attack> = {
  "agent-withdraw": {
    title: "The agent key withdraws to itself",
    story: "A model has been told to send the funds somewhere. The agent key asks the vault for them.",
    actor: "the agent key",
    expected: "NotOwner",
    call: (c) => ({ from: c.agent, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "withdraw", args: [c.tokenIn, c.agent, 1n] }) }),
  },
  "over-cap": {
    title: "The agent key sells more than one trade may",
    story: "The key is stolen and the thief tries to sell in one large trade, straight to the vault with no agent in the way.",
    actor: "the agent key",
    expected: "OverTradeCap",
    call: (c) => execute(c, "over-cap", c.agent, c.tokenIn, c.maxTrade + 1n, (c.maxTrade + 1n) * 1_000_000n, c.timestamp + 60n),
  },
  "zero-floor": {
    title: "The agent key sells for nothing",
    story: "The thief sets a minimum output of zero, so a sandwich could take the whole trade.",
    actor: "the agent key",
    expected: "BelowFloor",
    call: (c) => execute(c, "zero-floor", c.agent, c.tokenIn, c.spendable, 0n, c.timestamp + 60n),
  },
  "stale-deadline": {
    title: "The agent key replays an old trade",
    story: "A signed trade sat in a queue until its deadline passed, and someone sends it anyway.",
    actor: "the agent key",
    expected: "BadDeadline",
    call: (c) => execute(c, "stale-deadline", c.agent, c.tokenIn, c.spendable, c.spendable, c.timestamp - 1n),
  },
  "stranger-trade": {
    title: "A stranger tries to trade",
    story: "Anyone can call the contract. This address is not the agent.",
    actor: "a stranger",
    expected: "NotAgent",
    call: (c) => execute(c, "stranger-trade", STRANGER, c.tokenIn, 1n, 1n, c.timestamp + 60n),
  },
  "stranger-withdraw": {
    title: "A stranger tries to withdraw",
    story: "The same call as the agent's, from an address with no role at all.",
    actor: "a stranger",
    expected: "NotOwner",
    call: (c) => ({ from: STRANGER, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "withdraw", args: [c.tokenIn, STRANGER, 1n] }) }),
  },
};

export type RpcRequest = (method: string, params: unknown[]) => Promise<{ result?: unknown; error?: { message?: string; data?: unknown } }>;

export interface DemoOutcome {
  attack: string;
  title: string;
  story: string;
  actor: string;
  from: Address;
  expected: string;
  /** What the node returned. Never defaulted to the expected name. */
  refused: boolean;
  error: string | null;
  meaning: string | null;
  matchedExpected: boolean;
  block: string;
  method: "eth_call";
}

/** Runs one named attack and reports what the node said. A transport failure throws rather than looking like a refusal. */
export async function runDemo(name: string, context: DemoContext, block: bigint, rpc: RpcRequest): Promise<DemoOutcome> {
  const attack = DEMO_ATTACKS[name];
  if (!attack) throw new Error("Unknown attack");
  const { from, data } = attack.call(context);
  const reply = await rpc("eth_call", [{ from, to: context.vault, data }, `0x${block.toString(16)}`]);
  const base = { attack: name, title: attack.title, story: attack.story, actor: attack.actor, from, expected: attack.expected, block: block.toString(), method: "eth_call" as const };
  if (!reply.error) return { ...base, refused: false, error: null, meaning: "The call did not revert.", matchedExpected: false };
  const raw = reply.error.data;
  const payload = typeof raw === "string" ? raw : (raw as { data?: unknown } | undefined)?.data;
  if (typeof payload !== "string" || !/^0x[\da-fA-F]{8,}$/.test(payload)) {
    // A node that says "execution reverted" with no data has told us it reverted and not why. Anything else is a fault.
    if (!/revert/i.test(reply.error.message ?? "")) throw new Error("The node did not answer the call");
    return { ...base, refused: true, error: null, meaning: "The call reverted, and the node gave no reason.", matchedExpected: false };
  }
  try {
    const { errorName } = decodeErrorResult({ abi: VAULT_ABI, data: payload as Hex });
    return { ...base, refused: true, error: errorName, meaning: explainError(errorName).meaning, matchedExpected: errorName === attack.expected };
  } catch {
    return { ...base, refused: true, error: null, meaning: "The call reverted with an error this page does not recognise.", matchedExpected: false };
  }
}
