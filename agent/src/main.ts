import { networkProfile } from "./config.js";
// Runs the agent and a plain-English prompt. Observes only, unless LIVE=true and a key and vault are configured.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Agent } from "./agent.js";
import { loadConfig } from "./config.js";
import { buildFacts } from "./facts.js";
import { MarkFeed } from "./mark.js";
import { assistantFromEnv, NO_MODEL_KEY } from "./nl.js";
import { strategistFromEnv } from "./strategist.js";
import { DEFAULT_POLICY, parsePolicy, serializePolicy, type Policy } from "./policy.js";
import { reviewPolicy } from "./policy-review.js";
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
const llmLog = new JsonlLog(join(config.dataDir, "llm.jsonl"));
const proposals = new JsonlLog(join(config.dataDir, "proposals.jsonl"));
// The model as the engine: asked in the background when the policy's ai rule is on, never on the path to a trade.
const strategist = strategistFromEnv(process.env, {
  maxUsdPerDay: Number(process.env.AI_MAX_USD_PER_DAY ?? 0.5),
  onUsage: (record) => llmLog.append(record),
  onProposal: (event) => proposals.append({ wallTime: new Date().toISOString(), ...event }),
});
const agent = new Agent({ config, lane: networkProfile().lane, policy: () => policy, mark: () => marks.latest, ...(strategist ? { strategist } : {}) });
const assistant = assistantFromEnv(process.env, (record) => llmLog.append(record));

console.log(agent.canTrade ? `LIVE: trading through vault ${config.vault}` : "OBSERVE ONLY: no transaction will be signed.");
if (!assistant) console.log(`${NO_MODEL_KEY}, so the prompt is off, and so is the model engine. The rules and every stop run without it.`);
else console.log(`Model engine ${strategist!.model}: ${policy.ai?.enabled ? "on" : "off until the policy turns it on"}, at most $${process.env.AI_MAX_USD_PER_DAY ?? 0.5} a day.`);

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
    if (message === "reset breaker") {
      agent.resetBreaker();
      console.log("Breaker reset. Trades that failed before now no longer count.");
      continue;
    }
    if (!assistant) {
      console.log(JSON.stringify(buildFacts(agent, policy, strategist), null, 2));
      continue;
    }
    const spot = agent.lastMarket?.spotPriceX18 ?? 0n;
    const reply = await assistant.handle(message, buildFacts(agent, policy, strategist), policy, spot);
    console.log(reply.text);
    if (reply.policy) {
      const review = reviewPolicy(reply.policy, policy, spot, agent.lastMarket?.vault);
      console.log(review.summary.map((line) => `  ${line}`).join("\n"));
      for (const risk of review.risks) console.log(`  RISK: ${risk}`);
      const expected = review.risks.length ? "yes, I accept the risks" : "yes";
      const answer = await prompt.question(`Activate this policy? Type "${expected}" to confirm: `);
      if (answer.trim() === expected) {
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
