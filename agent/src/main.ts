import { networkProfile } from "./config.js";
// Runs the agent and a plain-English prompt. Observes only, unless LIVE=true and a key and vault are configured.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Agent } from "./agent.js";
import { loadConfig } from "./config.js";
import { buildFacts } from "./facts.js";
import { MarkFeed } from "./mark.js";
import { Assistant, DEFAULT_MODEL } from "./nl.js";
import { DEFAULT_POLICY, parsePolicy, serializePolicy, type Policy } from "./policy.js";
import { JsonlLog } from "./trace.js";

try {
  process.loadEnvFile();
} catch {
  // A .env file is optional; the environment may already be set.
}

const config = loadConfig();
const policyPath = join(config.dataDir, "policy.json");
let policy: Policy = existsSync(policyPath) ? parsePolicy(JSON.parse(readFileSync(policyPath, "utf8"))) : DEFAULT_POLICY;

const marks = new MarkFeed();
marks.start();
const agent = new Agent({ config, lane: networkProfile().lane, policy: () => policy, mark: () => marks.latest });
const llmLog = new JsonlLog(join(config.dataDir, "llm.jsonl"));
const assistant = process.env.ANTHROPIC_API_KEY
  ? new Assistant(new Anthropic(), process.env.LLM_MODEL ?? DEFAULT_MODEL, (record) => llmLog.append(record))
  : null;

console.log(agent.canTrade ? `LIVE: trading through vault ${config.vault}` : "OBSERVE ONLY: no transaction will be signed.");
if (!assistant) console.log("ANTHROPIC_API_KEY is not set, so the prompt is off. The trading loop does not need it.");

// STREAM=true also reacts to flashblocks. Polling stays on either way, so a dropped stream only costs speed.
const running = process.env.STREAM === "true" ? agent.runStreaming() : agent.run();
running.catch((error) => {
  console.error(`agent stopped: ${error}`);
  process.exit(1);
});

const prompt = createInterface({ input: process.stdin, output: process.stdout });
try {
  while (true) {
    const message = (await prompt.question("> ")).trim();
    if (!message) continue;
    if (message === "exit") break;
    if (!assistant) {
      console.log(JSON.stringify(buildFacts(agent, policy), null, 2));
      continue;
    }
    const spot = agent.lastMarket?.spotPriceX18 ?? 0n;
    const reply = await assistant.handle(message, buildFacts(agent, policy), policy, spot);
    console.log(reply.text);
    if (reply.policy) {
      console.log(JSON.stringify(serializePolicy(reply.policy), null, 2));
      const answer = await prompt.question("Activate this policy? Type yes to confirm: ");
      if (answer.trim() === "yes") {
        policy = reply.policy;
        writeFileSync(policyPath, JSON.stringify(serializePolicy(policy), null, 2));
        console.log(`Policy version ${policy.version} is active.`);
      } else {
        console.log("Not activated.");
      }
    }
  }
} finally {
  prompt.close();
  agent.stop();
  await running;
  marks.stop();
  agent.close();
}
