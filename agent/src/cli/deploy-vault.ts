// Deploys a vault against the configured market. A dry run by default: it signs nothing and needs no key.
//   npm run deploy:vault -- --owner 0x.. --agent 0x..                    plan only
//   npm run deploy:vault -- --owner 0x.. --agent 0x.. --broadcast        sends, using OWNER_PRIVATE_KEY
// Chain 177 also needs --confirm-mainnet. Limits, the guard and the guardian are separate steps: see docs/READINESS.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { createWalletClient, defineChain, encodeDeployData, formatEther, getAddress, http, isAddress, keccak256, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { explorerFor, MAINNET_CHAIN_ID } from "../chain-guard.js";
import { HSKSWAP, loadConfig } from "../config.js";
import { RpcClient } from "../rpc.js";
import { allowsLive, verifyVenue, type VenueReport } from "../venue.js";

/** The vault refuses more than 30 days. A first deployment should expire sooner, and renewing is one transaction. */
export const DEFAULT_EXPIRY_DAYS = 7;
const MAX_EXPIRY_DAYS = 30;
/** Added to the node's estimate, since what it estimates can change before the transaction lands. */
const GAS_MARGIN_PERCENT = 120n;

export interface DeployFacts {
  rpcChainId: number | null;
  expectedChainId: number;
  owner: string;
  agent: string;
  expiryDays: number;
  /** Null means the node did not say. */
  gasEstimate: bigint | null;
  gasPrice: bigint | null;
  balance: bigint | null;
  venue: Pick<VenueReport, "verdict">;
  broadcast: boolean;
  confirmedMainnet: boolean;
}

export interface DeployPlan {
  gasLimit: bigint | null;
  costWei: bigint | null;
  /** Empty means it may be sent. Anything unknown is a blocker, not a pass. */
  blockers: string[];
}

export function planDeployment(facts: DeployFacts): DeployPlan {
  const blockers: string[] = [];
  if (facts.rpcChainId === null) blockers.push("The RPC did not report a chain.");
  else if (facts.rpcChainId !== facts.expectedChainId) blockers.push(`The RPC is chain ${facts.rpcChainId}, but this run is configured for ${facts.expectedChainId}.`);
  if (facts.rpcChainId === MAINNET_CHAIN_ID && facts.broadcast && !facts.confirmedMainnet) blockers.push("This would send on HSK mainnet with real funds. Add --confirm-mainnet if that is what you mean.");
  if (!isAddress(facts.owner)) blockers.push("--owner is not an address.");
  if (!isAddress(facts.agent)) blockers.push("--agent is not an address.");
  if (isAddress(facts.owner) && isAddress(facts.agent) && getAddress(facts.owner) === getAddress(facts.agent)) blockers.push("The owner and agent must be different keys, or a stolen agent key could withdraw everything.");
  if (!Number.isFinite(facts.expiryDays) || facts.expiryDays <= 0 || facts.expiryDays > MAX_EXPIRY_DAYS) blockers.push(`The agent key's expiry must be from 1 to ${MAX_EXPIRY_DAYS} days.`);
  if (!allowsLive(facts.venue)) blockers.push(`The venue check came back ${facts.venue.verdict}.`);
  const gasLimit = facts.gasEstimate === null ? null : (facts.gasEstimate * GAS_MARGIN_PERCENT) / 100n;
  const costWei = gasLimit === null || facts.gasPrice === null ? null : gasLimit * facts.gasPrice;
  if (costWei === null) blockers.push("The node gave no gas estimate or gas price, so the cost is unknown.");
  if (facts.balance === null) blockers.push("The node did not report the owner's balance.");
  else if (costWei !== null && facts.balance < costWei) blockers.push(`The owner holds ${formatEther(facts.balance)} HSK and this needs about ${formatEther(costWei)}.`);
  return { gasLimit, costWei, blockers };
}

interface Artifact {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex; immutableReferences?: Record<string, Array<{ start: number; length: number }>> };
}

/** Compares code read from chain with the build. Immutables are set at deployment, so those bytes are skipped, and counted. */
export function runtimeMatches(onChain: Hex, artifact: Pick<Artifact, "deployedBytecode">): { matches: boolean; maskedSlots: number } {
  const built = artifact.deployedBytecode.object;
  const slots = Object.values(artifact.deployedBytecode.immutableReferences ?? {}).flat();
  if (onChain.length !== built.length) return { matches: false, maskedSlots: slots.length };
  const mask = (code: string) => {
    const hex = code.slice(2).split("");
    for (const { start, length } of slots) hex.fill("0", start * 2, (start + length) * 2);
    return hex.join("");
  };
  return { matches: mask(onChain.toLowerCase()) === mask(built.toLowerCase()), maskedSlots: slots.length };
}

export async function runDeploy(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      owner: { type: "string" },
      agent: { type: "string" },
      "expiry-days": { type: "string" },
      broadcast: { type: "boolean", default: false },
      "confirm-mainnet": { type: "boolean", default: false },
      out: { type: "string" },
      artifact: { type: "string", default: "out/HoldfastVault.sol/HoldfastVault.json" },
    },
  });
  const config = loadConfig({ ...env, AGENT_PRIVATE_KEY: undefined, VAULT_ADDRESS: undefined, MODE: "observe", LIVE: undefined });
  const signer = values.broadcast ? (env.OWNER_PRIVATE_KEY ? privateKeyToAccount(env.OWNER_PRIVATE_KEY as Hex) : null) : null;
  if (values.broadcast && !signer) {
    console.log("BLOCKED --broadcast needs OWNER_PRIVATE_KEY.");
    return 1;
  }
  const owner = values.owner ?? signer?.address ?? "";
  // The balance and estimate below are the owner's, so they only mean something if the owner is who sends.
  if (signer && signer.address.toLowerCase() !== owner.toLowerCase()) {
    console.log("BLOCKED OWNER_PRIVATE_KEY is not the key of --owner.");
    return 1;
  }
  const agent = values.agent ?? "";
  const expiryDays = Number(values["expiry-days"] ?? DEFAULT_EXPIRY_DAYS);
  const artifact = JSON.parse(readFileSync(values.artifact!, "utf8")) as Artifact;
  const rpc = new RpcClient(config.rpcUrl);
  const ask = <T>(method: string, params: unknown[] = []): Promise<T | null> => rpc.call<T>(method, params).catch(() => null);
  try {
    const { vault: _ignored, ...withoutVault } = config;
    const venue = await verifyVenue(rpc, withoutVault);
    const block = await rpc.call<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]).catch(() => null);
    const expiry = BigInt(block ? Number(BigInt(block.timestamp)) : Math.floor(Date.now() / 1000)) + BigInt(Math.floor(expiryDays * 86_400));
    const valid = isAddress(owner) && isAddress(agent);
    const args = [owner, agent, expiry, HSKSWAP.router, HSKSWAP.whsk, HSKSWAP.usdt, HSKSWAP.fee];
    const data = valid ? encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args }) : null;
    const [rawChain, rawGas, rawPrice, rawBalance] = await Promise.all([
      ask<string>("eth_chainId"),
      data ? ask<string>("eth_estimateGas", [{ from: owner, data }]) : Promise.resolve(null),
      ask<string>("eth_gasPrice"),
      valid ? ask<string>("eth_getBalance", [owner, "latest"]) : Promise.resolve(null),
    ]);
    const plan = planDeployment({
      rpcChainId: rawChain === null ? null : Number(rawChain),
      expectedChainId: config.chainId,
      owner,
      agent,
      expiryDays,
      gasEstimate: rawGas === null ? null : BigInt(rawGas),
      gasPrice: rawPrice === null ? null : BigInt(rawPrice),
      balance: rawBalance === null ? null : BigInt(rawBalance),
      venue,
      broadcast: values.broadcast!,
      confirmedMainnet: values["confirm-mainnet"]!,
    });
    const bytecodeHash = keccak256(artifact.bytecode.object);

    console.log(`chain      ${rawChain === null ? "unknown" : Number(rawChain)}  (${config.rpcUrl})`);
    console.log(`venue      ${venue.verdict}`);
    for (const check of venue.checks.filter((c) => c.status !== "pass")) console.log(`  ${check.status}  ${check.name}: ${check.detail}`);
    console.log(`owner      ${owner}`);
    console.log(`agent      ${agent}  expires ${expiry} (${expiryDays} days)`);
    console.log(`build      ${bytecodeHash}`);
    console.log(`gas        ${rawGas === null ? "unknown" : BigInt(rawGas)} estimated, limit ${plan.gasLimit ?? "unknown"}`);
    console.log(`cost       ${plan.costWei === null ? "unknown" : `about ${formatEther(plan.costWei)} HSK`}, holding ${rawBalance === null ? "unknown" : formatEther(BigInt(rawBalance))} HSK`);
    for (const blocker of plan.blockers) console.log(`BLOCKED    ${blocker}`);
    if (plan.blockers.length) return 1;
    if (!values.broadcast) {
      console.log("Dry run. Nothing was signed or sent. Add --broadcast to send.");
      return 0;
    }

    const out = values.out ?? `deployments/vault-${rawChain === null ? "unknown" : Number(rawChain)}.json`;
    // A record of a live contract is never replaced by accident.
    if (existsSync(out)) {
      console.log(`BLOCKED    ${out} already exists. Pass another --out.`);
      return 1;
    }
    const chain = defineChain({ id: config.chainId, name: "HSK Chain", nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
    const wallet = createWalletClient({ account: signer!, chain, transport: http(config.rpcUrl) });
    const txHash = await wallet.sendTransaction({ data: data!, gas: plan.gasLimit!, gasPrice: BigInt(rawPrice!) });
    console.log(`sent       ${txHash}`);
    // Written before waiting, so a crash here still leaves the hash of what went out.
    mkdirSync(dirname(out), { recursive: true });
    const record: Record<string, unknown> = { wallTime: new Date().toISOString(), chainId: config.chainId, txHash, owner, agent, expiry: expiry.toString(), router: HSKSWAP.router, whsk: HSKSWAP.whsk, usdt: HSKSWAP.usdt, fee: HSKSWAP.fee, bytecodeHash, status: "sent" };
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);

    let receipt: { status: Hex; contractAddress: Address; blockNumber: Hex; gasUsed: Hex; effectiveGasPrice: Hex } | null = null;
    for (let i = 0; i < 120 && !receipt; i++) {
      receipt = await ask("eth_getTransactionReceipt", [txHash]);
      if (!receipt) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!receipt || receipt.status !== "0x1") {
      writeFileSync(out, `${JSON.stringify({ ...record, status: receipt ? "reverted" : "no receipt yet" }, null, 2)}\n`);
      console.log(`BLOCKED    ${receipt ? "The deployment reverted." : "No receipt yet."} See ${out}.`);
      return 1;
    }
    const code = await rpc.call<Hex>("eth_getCode", [receipt.contractAddress, "latest"]);
    const match = runtimeMatches(code, artifact);
    const after = await verifyVenue(rpc, { ...config, vault: receipt.contractAddress }, getAddress(agent));
    const explorer = explorerFor(config.chainId);
    // A new vault has no guardian or guard yet. Those are the next steps, so here they are reported and do not fail it.
    const wired = after.checks.every((c) => c.status === "pass" || c.status === "warn" || c.name === "guardian" || c.name === "price guard");
    writeFileSync(out, `${JSON.stringify({
      ...record,
      status: match.matches && wired ? "verified" : "deployed, verification failed",
      vault: receipt.contractAddress,
      block: BigInt(receipt.blockNumber).toString(),
      gasUsed: BigInt(receipt.gasUsed).toString(),
      feeWei: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString(),
      runtimeMatchesBuild: match.matches,
      immutableSlotsMasked: match.maskedSlots,
      venue: { verdict: after.verdict, notPassing: after.checks.filter((c) => c.status !== "pass") },
      explorer: explorer ? `${explorer}/address/${receipt.contractAddress}` : null,
    }, null, 2)}\n`);
    console.log(`vault      ${receipt.contractAddress}`);
    console.log(`runtime    ${match.matches ? `matches the build, ${match.maskedSlots} immutable slots masked` : "DOES NOT MATCH THE BUILD"}`);
    console.log(`venue      ${after.verdict}`);
    console.log(`record     ${out}`);
    console.log("Next: limits, a guardian and a guard, in that order. The vault has no trading limits until you set them.");
    return match.matches && wired ? 0 : 1;
  } finally {
    rpc.close();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").match(/cli\/deploy-vault\.(ts|js)$/)) {
  try {
    process.loadEnvFile();
  } catch {
    // A .env file is optional; a dry run needs no key.
  }
  process.exitCode = await runDeploy(process.argv.slice(2));
}
