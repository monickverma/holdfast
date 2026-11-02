// Read-only: what Sentinel's public deployments actually hold, recomputed from the chain. Sends nothing.
// Writes evidence/v4/sentinel-chain-check.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, parseAbiItem } from "viem";

const VAULT = "0xACdB76B454E9D845f650c0Ad30195E525856e01c";
const DEPLOY_BLOCK = 34977817n;
const ORACLE = "0x8383854D98D0339D82F69d7bF9Baa69dbC559bcD";
const AGENT = "0xE7bD08FabDC2147C60e52e70FeB898230B97D069";
const MAIN_FACTORY = "0x6BFd2655fE5eCA056E5024C018A4A4C7cA15B14E";
const MAIN_REGISTRY = "0x0A10069225527aF05dB49B21e04B535D9aB84287";
const CANDIDATE_FEEDS = { "APRO BTC/USD, per vendor docs": "0x204ED500ab56A2E19B051561258E3A45c850360F", "Supra push, per vendor docs": "0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57" };

const test = createPublicClient({ transport: http("https://testnet.hsk.xyz", { timeout: 20_000 }) });
const main = createPublicClient({ transport: http("https://mainnet.hsk.xyz", { timeout: 20_000 }) });
const abi = parseAbi(["function logHead() view returns (bytes32)", "function logCount() view returns (uint256)", "function isPublisher(address) view returns (bool)", "function agent() view returns (address)", "function vaultCount() view returns (uint256)", "function count() view returns (uint256)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)", "function description() view returns (string)"]);
const trade = parseAbiItem("event TradeExecuted(uint256 indexed id, bytes32 indexed decisionHash, address venue, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 navBefore, uint256 navAfter, uint32 strategyVersion, uint256 timestamp, bytes32 logHead)");
const hold = parseAbiItem("event HoldRecorded(uint256 indexed id, bytes32 indexed decisionHash, uint256 nav, uint256 timestamp, bytes32 logHead)");

const latest = await test.getBlockNumber();
const logs = [];
for (let from = DEPLOY_BLOCK; from <= latest; from += 5000n) {
  const to = from + 4999n > latest ? latest : from + 4999n;
  const [t, h] = await Promise.all([test.getLogs({ address: VAULT, event: trade, fromBlock: from, toBlock: to }), test.getLogs({ address: VAULT, event: hold, fromBlock: from, toBlock: to })]);
  logs.push(...t, ...h);
  if (logs.length >= 400) break;
}
logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
let head = `0x${"0".repeat(64)}`;
let recomputes = true;
const seen = new Map();
let venues = new Set();
for (const log of logs) {
  const a = log.args;
  const isTrade = log.eventName === "TradeExecuted";
  if (isTrade) venues.add(a.venue);
  seen.set(a.decisionHash, (seen.get(a.decisionHash) ?? 0) + 1);
  head = keccak256(isTrade
    ? encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [head, a.id, 1, a.decisionHash, a.tokenIn, a.tokenOut, a.amountIn, a.amountOut, a.navAfter, a.timestamp])
    : encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], [head, a.id, 0, a.decisionHash, a.nav, a.timestamp]));
  if (head !== a.logHead) recomputes = false;
}
const read = (client, address, functionName, args = []) => client.readContract({ address, abi, functionName, args }).catch(() => null);
const code = async (client, address) => ((await client.getCode({ address }).catch(() => undefined))?.length ?? 2) > 2;
const feeds = {};
for (const [name, address] of Object.entries(CANDIDATE_FEEDS)) {
  const round = await read(main, address, "latestRoundData");
  feeds[name] = { address, hasCode: await code(main, address), answersLatestRoundData: round !== null, description: await read(main, address, "description"), updatedAt: round ? round[3].toString() : null };
}
const result = {
  wallTime: new Date().toISOString(), lane: "live read only", testnet: {
    vault: VAULT, block: latest.toString(), logEntries: logs.length, logCountOnChain: (await read(test, VAULT, "logCount"))?.toString() ?? null,
    headRecomputes: recomputes && head === (await read(test, VAULT, "logHead")), distinctDecisionHashes: seen.size, reusedDecisionHashes: [...seen.values()].filter((n) => n > 1).length,
    venuesUsed: [...venues], agentIsOraclePublisher: await read(test, ORACLE, "isPublisher", [AGENT]),
  },
  mainnet: { factoryVaultCount: (await read(main, MAIN_FACTORY, "vaultCount"))?.toString() ?? null, registryStrategyCount: (await read(main, MAIN_REGISTRY, "count"))?.toString() ?? null, candidateFeeds: feeds },
};
mkdirSync("evidence/v4", { recursive: true });
writeFileSync("evidence/v4/sentinel-chain-check.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 1));
