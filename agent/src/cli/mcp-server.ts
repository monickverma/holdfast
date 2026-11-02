// npm run mcp. Stdout carries the protocol and nothing else. Keys in the environment are dropped before anything reads it.
import { createInterface } from "node:readline";
import { loadConfig } from "../config.js";
import { handleMcp, type McpRequest } from "../mcp.js";
import { HoldfastClient } from "../sdk.js";

try {
  process.loadEnvFile();
} catch {
  // A .env file is optional; the environment may already be set.
}
for (const name of ["OWNER_PRIVATE_KEY", "AGENT_PRIVATE_KEY", "KEEPER_PRIVATE_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) delete process.env[name];
process.env.LIVE = "false";
delete process.env.MODE;

const client = new HoldfastClient(loadConfig());
const lines = createInterface({ input: process.stdin });
let queue = Promise.resolve();
const MAX_LINE = 100_000;

for await (const line of lines) {
  if (!line.trim()) continue;
  queue = queue.then(async () => {
    let request: McpRequest;
    try {
      if (line.length > MAX_LINE) throw new Error("too long");
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      return;
    }
    const reply = await handleMcp(client, request);
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}
await queue;
client.close();
