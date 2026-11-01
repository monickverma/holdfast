// A read-only MCP server over stdio, so another agent can look and ask but never act. No SDK dependency: the protocol
// here is a few JSON-RPC methods, and every extra package would sit next to the vault's configuration.
import { explainError, HOLD_REASONS } from "./explain.js";
import { IntentError, parseIntent, validatePolicy, type HoldfastClient } from "./sdk.js";

export const PROTOCOL_VERSION = "2025-06-18";

type Json = Record<string, unknown>;

export interface McpRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Json;
}

const INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["side", "amount"],
  properties: {
    side: { type: "string", enum: ["sell", "buy"] },
    amount: { type: "string", description: "Input amount as a decimal string: HSK for a sell, USDT for a buy." },
    minOut: { type: "string", description: "Least the trade may pay, as a decimal string. Omit to quote the market." },
    slippageBps: { type: "integer", minimum: 0, maximum: 500 },
  },
};

export const TOOLS = [
  { name: "holdfast_status", description: "Read the vault's balances, limits and price guard from the chain.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "holdfast_simulate_trade", description: "Ask the vault, by eth_call, what it would do with a trade. Nothing is signed or sent. The result is a simulation.", inputSchema: INTENT_SCHEMA },
  { name: "holdfast_validate_policy", description: "Check a strategy policy against the same schema the agent uses. Does not activate it.", inputSchema: { type: "object", required: ["policy"], additionalProperties: false, properties: { policy: { type: "object" } } } },
  {
    name: "holdfast_explain",
    description: "Explain a vault error name or an agent hold code in plain English.",
    inputSchema: { type: "object", required: ["code"], additionalProperties: false, properties: { code: { type: "string", maxLength: 200 } } },
  },
];

function text(value: unknown, isError = false): Json {
  return { content: [{ type: "text", text: JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }], ...(isError ? { isError: true } : {}) };
}

async function callTool(client: Pick<HoldfastClient, "status" | "simulate">, name: unknown, args: Json): Promise<Json> {
  switch (name) {
    case "holdfast_status":
      return text(await client.status());
    case "holdfast_simulate_trade":
      try {
        parseIntent(args);
      } catch (error) {
        if (error instanceof IntentError) return text({ error: error.message }, true);
        throw error;
      }
      return text(await client.simulate(args));
    case "holdfast_validate_policy": {
      const result = validatePolicy(args.policy);
      return text(result.ok ? { ok: true, version: result.policy.version, orders: result.policy.orders.length } : result, !result.ok);
    }
    case "holdfast_explain": {
      const code = String(args.code ?? "");
      return text(HOLD_REASONS[code as keyof typeof HOLD_REASONS] ?? explainError(code));
    }
    default:
      return text({ error: `Unknown tool: ${String(name)}` }, true);
  }
}

/** One message in, at most one out. Pure apart from the client, so a test can drive it without a process. */
export async function handleMcp(client: Pick<HoldfastClient, "status" | "simulate">, request: McpRequest): Promise<Json | null> {
  // A notification has no ID, and gets no answer.
  if (request.id === undefined || request.id === null) return null;
  const reply = (result: Json) => ({ jsonrpc: "2.0", id: request.id, result });
  switch (request.method) {
    case "initialize":
      return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "holdfast", version: "0.1.0" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      try {
        return reply(await callTool(client, request.params?.name, (request.params?.arguments ?? {}) as Json));
      } catch (error) {
        // A node's message can carry a URL with an API key in it, so a caller gets a generic answer.
        console.error(`mcp tool failed: ${String(error)}`);
        return reply(text({ error: "The chain read failed. Try again." }, true));
      }
    default:
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
  }
}
