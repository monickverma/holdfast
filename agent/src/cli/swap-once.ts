import { networkProfile } from "../config.js";
// One real swap through the vault, on the same path the agent uses. Previews unless --broadcast is given.
//   swap:once -- sell 11        sells 11 HSK
//   swap:once -- buy 1          buys HSK with 1 USDT
import { parseArgs } from "node:util";
import { formatUnits, parseUnits } from "viem";
import { Agent } from "../agent.js";
import { loadConfig } from "../config.js";
import { DEFAULT_POLICY, type Policy } from "../policy.js";
import { sleep } from "../rpc.js";

try {
  process.loadEnvFile();
} catch {
  // A .env file is optional; the environment may already be set.
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { broadcast: { type: "boolean", default: false } } });
const [side, amount] = positionals;
if ((side !== "sell" && side !== "buy") || !amount) throw new Error("Usage: swap:once -- sell|buy <amount> [--broadcast]");

const config = { ...loadConfig(), live: values.broadcast };
if (!config.vault || !config.agentKey) throw new Error("Set VAULT_ADDRESS and AGENT_PRIVATE_KEY in your local .env");

const id = `once-${Date.now()}`;
const policy: Policy = {
  ...DEFAULT_POLICY,
  orders: [{ id, kind: side === "sell" ? "market-sell" : "market-buy", amountIn: parseUnits(amount, side === "sell" ? 18 : 6) }],
};
const agent = new Agent({ config, lane: networkProfile().lane, policy: () => policy, mark: () => null });

try {
  for (let i = 0; i < 40; i++) {
    const record = await agent.step();
    if (!record) {
      await sleep(config.pollMs);
      continue;
    }
    if (record.decision.action === "hold") {
      console.log(`block ${record.block} hold [${record.decision.code}]: ${record.decision.reason}`);
      if (record.decision.code !== "requote") break;
      continue;
    }
    if (!values.broadcast) {
      const out = formatUnits(record.decision.quotedOut, side === "sell" ? 6 : 18);
      console.log(`Would trade at block ${record.block}: quoted out ${out}, min out ${record.decision.minOut}. Nothing sent. Add --broadcast to send.`);
      break;
    }
    if (record.intent) {
      const key = record.intent.key;
      console.log(`tx ${record.intent.txHash}`);
      for (let j = 0; j < 60; j++) {
        await agent.settleInFlight();
        const intent = agent.ledger.get(key)!;
        if (intent.status === "included" || intent.status === "reverted") {
          console.log(`${intent.status}: block ${intent.blockNumber}, ${intent.blockNumber! - intent.broadcastBlock!} blocks after broadcast, gas ${intent.gasUsed}, fee ${formatUnits(intent.feeWei!, 18)} HSK, out ${intent.amountOut ?? 0n}${intent.revertReason ? `, reason ${intent.revertReason}` : ""}`);
          console.log(`${networkProfile().explorer}/tx/${intent.txHash}`);
          break;
        }
        await sleep(500);
      }
      break;
    }
  }
} finally {
  agent.close();
}
