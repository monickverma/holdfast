// Read-only evidence server. No signer, executor or policy writer is loaded, and private keys never enter this process.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createPublicClient, formatUnits, http, isAddress, parseAbi, type Address } from "viem";
import type { Agent } from "../agent.js";
import { MAINNET_MARKET as HSKSWAP, loadConfig, testMarket, networkProfile } from "../config.js";
import { DEMO_ATTACKS, runDemo, type RpcRequest } from "../demo.js";
import { buildFacts } from "../facts.js";
import { assistantFromEnv, MODEL_KEYS, NO_MODEL_KEY, type Assistant } from "../nl.js";
import { DEFAULT_POLICY } from "../policy.js";
import { readProof } from "../proof.js";
import { viewerNetwork, type ViewerNetwork, type Network } from "../viewer-network.js";
import { VAULT_ABI, readHead, readMarket } from "../reader.js";
import { quantileReport } from "../stats.js";
import { BIGINT_FIELDS, type Intent } from "../ledger.js";
import { qualitySummary } from "../quality.js";
import { RpcClient } from "../rpc.js";
import { JsonlLog } from "../trace.js";
import { verifyVenue } from "../venue.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
type Row = Record<string, any>;
const lanes = ["mainnet", "fork", "replay", "testnet"] as const;
const explorers = { mainnet: "https://hsk.blockscout.com", testnet: "https://testnet-explorer.hskchain.net" };
const isLane = (v: unknown): v is typeof lanes[number] => lanes.includes(v as typeof lanes[number]);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const quantiles = (samples: number[]) => Object.fromEntries([0.5, 0.95, 0.99].map((q) => [`P${q * 100}`, quantileReport(samples, q)]));

/** Holds that mean a trade was wanted and refused. The rest ("nothing to do") are only counted. */
const REFUSAL_CODES = new Set(["preflight-refused", "preflight-unverified", "preflight-uneconomic", "no-gas", "bad-mark", "price-impact"]);

/** The ledger's shape from a saved row. A row that will not parse shows in the trade table and is left out of quality. */
function reviveIntent(row: Row): Intent | null {
  try {
    const intent: Row = { ...row };
    for (const field of BIGINT_FIELDS) if (typeof intent[field] === "string") intent[field] = BigInt(intent[field]);
    return intent as Intent;
  } catch { return null; }
}

/** Only known evidence names are opened; symlinks and junctions are never followed. */
export function readEvidence(dataDir = join(root, "data")) {
  const groups: Array<{ traces: Row[]; ledger: Row[]; decisions: Row[] }> = [];
  let attack: Row | null = null;
  let incomplete = false;
  function walk(dir: string, depth: number) {
    if (depth > 8) { incomplete = true; return; }
    let entries;
    try {
      if (lstatSync(dir).isSymbolicLink()) { incomplete = true; return; }
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    const read = (name: string, lines: boolean): Row[] => {
      const entry = entries.find((e) => e.name === name);
      if (!entry?.isFile() || entry.isSymbolicLink()) return [];
      try {
        if (lstatSync(join(dir, name)).size > 20_000_000) { incomplete = true; return []; }
        const body = readFileSync(join(dir, name), "utf8");
        return (lines ? body.split("\n") : [body]).flatMap((line) => {
          if (!line.trim()) return [];
          try { const row = JSON.parse(line); return row && typeof row === "object" && !Array.isArray(row) ? [row] : []; }
          catch { incomplete = true; return []; }
        });
      } catch { incomplete = true; return []; }
    };
    groups.push({ traces: read("traces.jsonl", true), ledger: read("ledger.jsonl", true), decisions: read("decisions.jsonl", true) });
    if (dir === dataDir) attack = read("attack-results.json", false)[0] ?? null;
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) walk(join(dir, entry.name), depth + 1);
  }
  walk(dataDir, 0);
  const result = lanes.map((lane) => {
    const traces = groups.flatMap((g) => g.traces.filter((t) => t.lane === lane));
    const sent = traces.filter((t) => finite(t.attrs?.decisionToBroadcastMs));
    const stages = [...new Set(sent.flatMap((t) => Array.isArray(t.spans) ? t.spans.map((s: Row) => String(s.stage)) : []))];
    const trades: Row[] = [];
    const shown: Intent[] = [];
    const refusals: Row[] = [];
    const holdCounts: Record<string, number> = {};
    const inclusion: number[] = [];
    let feeWei = 0n;
    for (const group of groups) {
      const traceLane = new Map(group.traces.map((t) => [t.id, t.lane]));
      for (const row of group.decisions) {
        if (traceLane.get(row.traceId) !== lane || row.decision?.action !== "hold" || typeof row.decision.code !== "string") continue;
        holdCounts[row.decision.code] = (holdCounts[row.decision.code] ?? 0) + 1;
        if (REFUSAL_CODES.has(row.decision.code)) refusals.push({ time: typeof row.wallTime === "string" ? row.wallTime : "not recorded", block: typeof row.block === "string" ? row.block : null, code: row.decision.code, reason: typeof row.decision.reason === "string" ? row.decision.reason.slice(0, 300) : null });
      }
      const latest = new Map<string, Row>();
      for (const row of group.ledger) {
        const links = group.decisions.filter((d) => d.intent?.key === row.key).flatMap((d) => group.traces.filter((t) => t.id === d.traceId));
        const sources = new Set([row.lane, ...links.map((t) => t.lane)].filter(isLane));
        // A run's directory holds one lane, so a row sent outside a decision (a recovery or a deliberate revert) takes that lane.
        const dirLanes = new Set(group.traces.map((t) => t.lane).filter(isLane));
        if (!sources.size && dirLanes.size === 1) sources.add([...dirLanes][0]!);
        if (sources.size !== 1) { incomplete = true; continue; }
        if (!sources.has(lane)) continue;
        latest.set(String(row.key), { ...row, time: row.wallTime ?? links[0]?.wallTime });
      }
      for (const row of latest.values()) {
        const token = String(row.tokenIn).toLowerCase();
        let market: { whsk: string; usdt: string } = HSKSWAP;
        if (lane === "testnet") { try { market = testMarket(); } catch { market = { whsk: "", usdt: "" }; } }
        const sell = token === market.whsk.toLowerCase();
        const known = sell || token === market.usdt.toLowerCase();
        const amount = (v: unknown, decimals: number) => typeof v === "string" && /^\d+$/.test(v) ? formatUnits(BigInt(v), decimals) : "not yet run";
        const [base, quote] = lane === "testnet" ? ["tWHSK", "tUSDT"] : ["HSK", "USDT"];
        trades.push({
          lane, time: typeof row.time === "string" ? row.time : "not recorded", side: known ? `${sell ? "sell" : "buy"} ${base}` : "unknown token",
          input: known ? `${amount(row.amountIn, sell ? 18 : 6)} ${sell ? base : quote}` : "unknown",
          output: row.status === "reverted" ? "none" : known ? `${amount(row.amountOut, sell ? 6 : 18)} ${sell ? quote : base}` : "unknown",
          gas: amount(row.gasUsed, 0), status: String(row.status ?? "unknown"), reason: typeof row.revertReason === "string" ? row.revertReason : null,
          link: lane in explorers && /^0x[\da-f]{64}$/i.test(row.txHash ?? "") ? `${explorers[lane as keyof typeof explorers]}/tx/${row.txHash}` : null
        });
        if (/^\d+$/.test(row.feeWei ?? "")) feeWei += BigInt(row.feeWei);
        const intent = reviveIntent(row);
        if (intent) shown.push(intent);
        if (["included", "reverted"].includes(row.status) && /^\d+$/.test(row.blockNumber ?? "") && /^\d+$/.test(row.broadcastBlock ?? "")) {
          const blocks = Number(BigInt(row.blockNumber) - BigInt(row.broadcastBlock));
          if (Number.isSafeInteger(blocks) && blocks >= 0) inclusion.push(blocks);
        }
      }
    }
    let whsk: Address = HSKSWAP.whsk;
    if (lane === "testnet") { try { whsk = testMarket().whsk as Address; } catch { whsk = "0x0000000000000000000000000000000000000000"; } }
    const quality = qualitySummary(shown, whsk);
    return {
      lane,
      // Only named fields, as strings. The decision body and any raw transaction stay on disk.
      quality: {
        fills: quality.fills, fillsWithExpectation: quality.fillsWithExpectation, reverted: quality.reverted, expired: quality.expired, cancelled: quality.cancelled, unverifiedOutcomes: quality.unverifiedOutcomes,
        meanSlippageBps: quality.meanSlippageBps?.toString() ?? null, realizedNetUsdt: quality.realizedNetUsdt === null ? null : formatUnits(quality.realizedNetUsdt, 6), definition: quality.definition,
        rows: quality.rows.map((q) => ({ txHash: /^0x[\da-f]{64}$/i.test(q.txHash ?? "") ? q.txHash : null, side: q.side, quotedOut: q.quotedOut?.toString() ?? null, amountOut: q.amountOut.toString(), slippageBps: q.slippageBps?.toString() ?? null, allowanceUsedBps: q.allowanceUsedBps?.toString() ?? null, costToSpotBps: q.costToSpotBps?.toString() ?? null, gasEstimated: q.gasEstimated?.toString() ?? null, gasUsed: q.gasUsed?.toString() ?? null, expectedNetUsdt: q.expectedNetUsdt === null ? null : formatUnits(q.expectedNetUsdt, 6), realizedNetUsdt: q.realizedNetUsdt === null ? null : formatUnits(q.realizedNetUsdt, 6) })),
      },
      holds: holdCounts, refusals: refusals.slice(-20),
      latency: {
        decisionToBroadcastMs: quantiles(sent.map((t) => t.attrs.decisionToBroadcastMs)),
        decisionToReceiptMs: quantiles(traces.flatMap((t) => (finite(t.attrs?.decisionToReceiptMs) ? [t.attrs.decisionToReceiptMs] : []))),
        ...Object.fromEntries(stages.map((stage) => [`${stage} service ms`, quantiles(sent.flatMap((t) => (Array.isArray(t.spans) ? t.spans : []).filter((s: Row) => s.stage === stage && s.ok && finite(s.endMs) && finite(s.startMs)).map((s: Row) => s.endMs - s.startMs)))])),
        inclusionBlocks: quantiles(inclusion)
      }, trades,
      totals: {
        fills: trades.filter((t) => t.status === "included").length, reverts: trades.filter((t) => t.status === "reverted").length,
        networkFeeHsk: formatUnits(feeWei, 18), modelCallsInExecutionPath: traces.reduce((sum, t) => sum + (finite(t.attrs?.modelCalls) ? t.attrs.modelCalls : 0), 0)
      }
    };
  });
  // Explicit field selection keeps raw signed transactions and arbitrary metadata off the wire.
  const summary = (attack as Row | null)?.summary;
  const attacks = summary ? {
    lane: "fork", attacks: summary.attacks?.n, contained: summary.attacks?.contained,
    benign: summary.benign?.n, completed: summary.benign?.completed, capViolations: summary.capViolations,
    maxDrainedHsk: summary.maxDrainedHsk, lifetimeCapHsk: summary.lifetimeCapHsk
  } : null;
  return { lanes: result, attacks, incomplete, empty: !groups.some((g) => g.traces.length || g.ledger.length) && !attacks };
}

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** A vault from an earlier generation has no such function. Its absence is shown as absent, never as a default. */
const orNull = <T>(promise: Promise<T>) => promise.catch(() => null);

async function vaultLimits(address: string | undefined, context: ViewerNetwork) {
  if (!address) return { status: "No vault is set." };
  if (!isAddress(address)) return { status: "Vault configuration is invalid." };
  try {
    // Profile endpoint and chain check keep vault reads in the correct lane.
    const { profile, market } = context;
    const client = createPublicClient({ transport: http(profile.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
    if (await client.getChainId() !== profile.chainId) throw new Error("Wrong chain");
    const blockNumber = await client.getBlockNumber();
    const testnet = profile.network === "testnet";
    const tokens = await Promise.all(([[testnet ? 'tWHSK' : 'HSK', market.whsk, 18], [testnet ? 'tUSDT' : 'USDT', market.usdt, 6]] as const).map(async ([token, tokenAddress, decimals]) => {
      const values = await Promise.all((["maxTrade", "remaining", "floorPriceX18"] as const).map((functionName) => client.readContract({ address, abi: VAULT_ABI, functionName, args: [tokenAddress], blockNumber })));
      const optional = (functionName: "hourlyBudget" | "budgetAvailable" | "dailyBudget" | "dailyAvailable") => orNull(client.readContract({ address, abi: VAULT_ABI, functionName, args: [tokenAddress], blockNumber }));
      const [hourlyBudget, hourlyAvailable, dailyBudget, dailyAvailable] = await Promise.all([optional("hourlyBudget"), optional("budgetAvailable"), optional("dailyBudget"), optional("dailyAvailable")]);
      const balance = await client.readContract({ address: tokenAddress, abi: ERC20, functionName: "balanceOf", args: [address], blockNumber });
      const amount = (value: bigint | null) => (value === null ? null : formatUnits(value, decimals));
      return { lane: profile.lane, token, address: tokenAddress, decimals, balance: formatUnits(balance, decimals), maxTrade: formatUnits(values[0]!, decimals), remainingLifetime: formatUnits(values[1]!, decimals), floorOutputPerInput: formatUnits(values[2]!, decimals === 18 ? 6 : 30), hourlyBudget: amount(hourlyBudget), hourlyAvailable: amount(hourlyAvailable), dailyBudget: amount(dailyBudget), dailyAvailable: amount(dailyAvailable) };
    }));
    const read = <T>(functionName: string) => orNull(client.readContract({ address, abi: VAULT_ABI, functionName, blockNumber } as never) as Promise<T>);
    const [version, owner, agent, guardian, paused, agentExpiry, twapWindow, bandTicks, stop, stopReady, block] = await Promise.all([
      read<bigint>("VERSION"), read<Address>("owner"), read<Address>("agent"), read<Address>("guardian"), read<boolean>("paused"), read<number>("agentExpiry"), read<number>("twapWindow"), read<number>("guardBandTicks"),
      read<readonly [bigint, bigint, number, number, number, boolean, boolean]>("stop"), read<boolean>("stopReady"), client.getBlock({ blockNumber }),
    ]);
    return {
      lane: profile.lane, chainId: profile.chainId, status: "Read from chain", address, explorer: explorers[profile.lane], block: blockNumber.toString(), blockTime: Number(block.timestamp), tokens,
      version: version === null ? null : Number(version), owner, agent, guardian, paused,
      agentExpiry: agentExpiry === null ? null : Number(agentExpiry),
      guard: twapWindow === null ? null : { on: twapWindow !== 0, windowSec: twapWindow, bandTicks },
      stop: stop === null ? null : { armed: stop[5], ready: stopReady === true },
    };
  } catch { return { status: "Vault read unavailable. Not yet run successfully." }; }
}

/** The venue check and the market, both read from chain now. Signs nothing, and the agent key is kept out of the config. */
async function readVenueNow(address: string | undefined, context: ViewerNetwork) {
  const { profile, market } = context;
  const rpc = new RpcClient(profile.rpcUrl, { maxRetries: 0 });
  try {
    const config = { ...loadConfig({ NETWORK: "mainnet", MODE: "observe" }), chainId: profile.chainId,
      rpcUrl: profile.rpcUrl, poolKind: profile.network === "testnet" ? "constant-product" as const : "v3" as const,
      legacyVault: context.generation < 2, guardedVault: context.generation >= 3,
      ...(address && isAddress(address) ? { vault: address } : {}) };
    // A mismatched RPC must never produce quotes labelled as the selected chain.
    if (Number(await rpc.call<string>("eth_chainId")) !== profile.chainId) throw new Error("Wrong chain");
    const report = await verifyVenue(rpc, config, undefined, market);
    const head = await readHead(rpc);
    const state = await readMarket(rpc, config, head, [{ tokenIn: market.whsk, amountIn: 10n ** 18n }, { tokenIn: market.whsk, amountIn: 10n ** 19n }, { tokenIn: market.usdt, amountIn: 10n ** 6n }], market);
    const [one, ten, buy] = state.quotes;
    return {
      lane: profile.lane, chainId: report.chainId, block: head.number.toString(), readAt: new Date().toISOString(), verdict: report.verdict,
      checks: report.checks.map((c) => ({ name: c.name, status: c.status, source: c.source, detail: c.detail })),
      market: {
        priceUsdt: formatUnits(state.spotPriceX18, 6), tick: state.tick, twapTick: state.twapTick, liquidity: state.liquidity.toString(),
        sell1: formatUnits(one!.amountOut, 6), sell10: formatUnits(ten!.amountOut, 6), buyWith1Usdt: formatUnits(buy!.amountOut, 18),
        baseFeeWei: head.baseFeePerGas.toString(), priorityFeeWei: state.priorityFeePerGas.toString(), l1FeeWei: state.l1FeeWei.toString(),
      },
    };
  } catch {
    return { lane: profile.lane, verdict: "unverified", checks: [], market: null, status: "The network did not answer, so nothing here is verified right now." };
  } finally {
    rpc.close();
  }
}

/** A fixed window per key. A key is only as good as the address behind it, so anything that costs money also has a global cap. */
export function rateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const seen = new Map<string, { start: number; used: number }>();
  return (key: string): boolean => {
    const time = now();
    if (seen.size > 10_000) for (const [k, v] of seen) if (time - v.start >= windowMs) seen.delete(k);
    if (seen.size > 20_000) seen.clear();
    const entry = seen.get(key);
    if (!entry || time - entry.start >= windowMs) { seen.set(key, { start: time, used: 1 }); return true; }
    if (entry.used >= limit) return false;
    entry.used++;
    return true;
  };
}

/** One value for ttl, shared between callers, so a burst of visitors costs one disk walk and one set of reads. */
function cached<T>(ttlMs: number, load: () => Promise<T>) {
  let at = -Infinity;
  let value: Promise<T> | undefined;
  return () => {
    if (!value || performance.now() - at >= ttlMs) {
      at = performance.now();
      value = load().catch((error) => { at = -Infinity; throw error; });
    }
    return value;
  };
}

const sameSecret = (given: string, secret: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
};

const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/charts.js": ["charts.js", "text/javascript"],
  "/wallet.js": ["wallet.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
  "/api/progress": ["progress.json", "application/json"],
};

export function createViewer(options: {
  dataDir?: string;
  assistant?: Pick<Assistant, "handle"> | null;
  vaultAddress?: string;
  evidenceDir?: string;
  rpc?: RpcRequest;
  cacheMs?: number;
  chatToken?: string;
  chatDailyLimit?: number;
  venue?: (network: Network) => Promise<unknown>;
  vault?: (network: Network) => Promise<unknown>;
  limits?: { api?: number; demo?: number; chat?: number };
} = {}) {
  const dataDir = options.dataDir ?? join(root, "data");
  const evidenceDir = options.evidenceDir ?? join(root, "evidence");
  const cacheMs = options.cacheMs ?? 15_000;
  const chatToken = options.chatToken ?? process.env.CHAT_TOKEN;
  const chatDailyLimit = options.chatDailyLimit ?? Number(process.env.CHAT_DAILY_LIMIT ?? 200);
  const allowApi = rateLimiter(options.limits?.api ?? 120, 60_000);
  const allowDemo = rateLimiter(options.limits?.demo ?? 20, 60_000);
  const allowChat = rateLimiter(options.limits?.chat ?? 5, 60_000);
  const chatToday = { day: "", used: 0 };
  const llmLog = new JsonlLog(join(dataDir, "llm.jsonl"));
  const assistant = options.assistant === undefined
    ? assistantFromEnv(process.env, (record) => llmLog.append(record))
    : options.assistant;
  const defaultNetwork = networkProfile().network;
  const proof = cached(Math.max(cacheMs, 60_000), async () => readProof(evidenceDir));
  const runs = new Map((["mainnet", "testnet"] as const).map((network) => {
    const context = viewerNetwork(network, evidenceDir);
    const { profile, market } = context;
    // Legacy operator overrides apply only to the operator's selected network.
    const address = network === defaultNetwork
      ? options.vaultAddress ?? process.env.VAULT_ADDRESS ?? context.address
      : context.address;
    const evidence = cached(cacheMs, async () => ({ ...readEvidence(dataDir), vault: options.vault ? await options.vault(network) : await vaultLimits(address, context) }));
    const venue = cached(Math.max(cacheMs, 60_000), () => options.venue ? options.venue(network) : readVenueNow(address, context));
    const rpc: RpcRequest = options.rpc ?? (async (method, params) => {
      const response = await fetch(profile.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
      return await response.json() as { result?: unknown; error?: { message?: string; data?: unknown } };
    });
    // One upstream call per attack per window, however many visitors press the button.
    const demos = new Map(Object.keys(DEMO_ATTACKS).map((name) => [name, cached(cacheMs, async () => {
      if (!address || !isAddress(address)) throw new Error("No vault");
      const client = createPublicClient({ transport: http(profile.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
      if (await client.getChainId() !== profile.chainId) throw new Error("Wrong chain");
      const block = await client.getBlock();
      const read = <T>(functionName: string, args: unknown[] = []) => client.readContract({ address, abi: VAULT_ABI, functionName, args, blockNumber: block.number } as never) as Promise<T>;
      const [agent, owner, maxTrade, remaining] = await Promise.all([read<Address>("agent"), read<Address>("owner"), read<bigint>("maxTrade", [market.whsk]), read<bigint>("remaining", [market.whsk])]);
      const outcome = await runDemo(name, { vault: address, agent, owner, tokenIn: market.whsk, maxTrade, spendable: remaining < maxTrade ? remaining : maxTrade, timestamp: block.timestamp }, block.number, rpc);
      return { ...outcome, lane: profile.lane, chainId: profile.chainId, vault: address, explorer: explorers[profile.lane], readAt: new Date().toISOString(), note: "A real eth_call against this vault's state. Nothing was signed or sent." };
    })]));
    return [network, { context, profile, address, evidence, venue, demos }] as const;
  }));
  /** A person at this machine, not a proxied visitor. */
  const isLoopback = (req: IncomingMessage, localHost: string) => req.headers.host === localHost && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") && !req.headers["x-forwarded-for"];
  /** The proxy appends the address it saw, so the last entry is the one a client cannot choose. */
  const clientOf = (req: IncomingMessage) => {
    const forwarded = req.headers["x-forwarded-for"];
    const list = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return list.at(-1) ?? req.socket.remoteAddress ?? "unknown";
  };
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = "application/json", extra: Record<string, string> = {}) => {
      res.writeHead(status, {
        "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY", "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        ...(req.headers.host === process.env.RENDER_EXTERNAL_HOSTNAME ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
        ...extra,
      });
      let text = type === "application/json" ? JSON.stringify(body) : String(body);
      // The API keys are never returned, including when echoed by a model or evidence field. The vault address is public.
      for (const name of MODEL_KEYS) {
        const secret = process.env[name];
        if (secret) text = text.split(secret).join("[redacted]");
      }
      res.end(text);
    };
    try {
      const rawPath = decodeURIComponent(req.url ?? "/");
      if (rawPath.includes("..") || rawPath.includes("\\") || rawPath.includes("\0") || rawPath.includes("%")) return send(400, { error: "Path refused." });
      const url = new URL(req.url ?? "/", "http://viewer.invalid");
      const path = decodeURIComponent(url.pathname);
      const selected = url.searchParams.get("network") ?? defaultNetwork;
      if (!["mainnet", "testnet"].includes(selected) || url.searchParams.getAll("network").length > 1) return send(400, { error: "Choose mainnet or testnet." });
      const { context, profile, address, evidence, venue, demos } = runs.get(selected as Network)!;
      const localHost = `127.0.0.1:${(res.socket?.address() as { port: number }).port}`;
      const renderHost = process.env.RENDER_EXTERNAL_HOSTNAME;

      if (
        req.headers.host !== localHost &&
        (!renderHost || req.headers.host !== renderHost)
      ) {
        return send(403, { error: "Host refused." });
      }
      const local = isLoopback(req, localHost);
      const client = clientOf(req);
      const chatOpen = Boolean(assistant) && (local || Boolean(chatToken));
      if (req.method === "GET" && STATIC[path]) {
        const [name, type] = STATIC[path]!;
        const content = readFileSync(join(root, "web", name), "utf8");
        return send(200, type === "application/json" ? JSON.parse(content) : content, type);
      }
      if (req.method === "GET" && path === "/healthz") return send(200, { ok: true, commit: /^[a-f0-9]{40}$/i.test(process.env.RENDER_GIT_COMMIT ?? "") ? process.env.RENDER_GIT_COMMIT : null });
      if (req.method === "GET" && path.startsWith("/api/") && !allowApi(client)) return send(429, { error: "Too many requests. Try again in a minute." }, "application/json", { "Retry-After": "60" });
      if (req.method === "GET" && path === "/api/evidence") {
        return send(200, {
          ...await evidence(), network: profile.network, deployment: context.deployment,
          chat: !assistant ? `${NO_MODEL_KEY}. Chat is unavailable.` : chatOpen ? "Questions only. Answers are model output." : "Chat is off on this public server, because each answer costs money.",
          chatOpen,
        });
      }
      if (req.method === "GET" && path === "/api/proof") return send(200, await proof());
      if (req.method === "GET" && path === "/api/venue") return send(200, await venue());
      if (req.method === "GET" && path === "/api/demo") return send(200, { attacks: Object.entries(DEMO_ATTACKS).map(([id, a]) => ({ id, title: a.title, actor: a.actor, expected: a.expected })), available: Boolean(address && isAddress(address)) });
      if (req.method === "GET" && path.startsWith("/api/demo/")) {
        const demo = demos.get(path.slice("/api/demo/".length));
        if (!demo) return send(404, { error: "No such attack." });
        if (!allowDemo(client)) return send(429, { error: "Too many requests. Try again in a minute." }, "application/json", { "Retry-After": "60" });
        try { return send(200, await demo()); }
        catch { return send(503, { error: "The network did not answer, so this ran nothing. Try again." }); }
      }
      if (req.method === "POST" && path === "/api/chat") {
        const expectedOrigin =
          req.headers.host === process.env.RENDER_EXTERNAL_HOSTNAME
            ? `https://${req.headers.host}`
            : `http://${req.headers.host}`;

        if (
          req.headers.origin !== expectedOrigin ||
          !req.headers["content-type"]?.startsWith("application/json")
        ) {
          return send(403, { error: "Origin refused." });
        }
        if (!assistant) return send(503, { error: `${NO_MODEL_KEY}. Chat is unavailable.` });
        // Each answer spends the operator's money, and an Origin header is only a browser's word. Off this machine, a
        // caller must hold the token. With no token set, public chat does not exist.
        if (!local) {
          const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
          if (!chatToken || !given || !sameSecret(given, chatToken)) return send(403, { error: "Chat is off on this public server." });
        }
        if (!allowChat(client)) return send(429, { error: "Too many questions. Try again in a minute." }, "application/json", { "Retry-After": "60" });
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 8_000) return send(413, { error: "Question too long." }); }
        const { message } = JSON.parse(body);
        if (typeof message !== "string" || !message.trim()) return send(400, { error: "A question is required." });
        // Counted before the call: a failed call may still have been billed.
        const day = new Date().toISOString().slice(0, 10);
        if (chatToday.day !== day) { chatToday.day = day; chatToday.used = 0; }
        if (chatToday.used >= chatDailyLimit) return send(429, { error: "Today's question budget is used up." });
        chatToday.used++;
        const base = buildFacts({ lastMarket: undefined } as unknown as Agent, DEFAULT_POLICY) as Row;
        const reply = await assistant.handle(`Answer questions only. Policy changes belong in the REPL.\n${message}`, { status: base.status, evidence: readEvidence(dataDir), vault: await vaultLimits(address, context), network: selected }, DEFAULT_POLICY, 0n);
        return send(200, { label: "Model output", text: reply.kind === "answer" ? reply.text : "This panel only answers questions. Policy changes stay in the existing REPL." });
      }
      send(404, { error: "Not found." });
    } catch { send(400, { error: "Request unavailable." }); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 500;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Only these names are taken from .env, so the wallet keys stay out of this process.
  if (existsSync(join(root, ".env"))) {
    const file = parseEnv(readFileSync(join(root, ".env"), "utf8"));
    for (const name of ["VAULT_ADDRESS", ...MODEL_KEYS, "LLM_MODEL", "CHAT_TOKEN", "CHAT_DAILY_LIMIT"]) if (file[name] && !process.env[name]) process.env[name] = file[name];
  }
  const port = Number(process.env.PORT ?? 4177);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid viewer port.");
  const host = process.env.HOST ?? "127.0.0.1";

  createViewer({ dataDir: process.env.DATA_DIR })
    .listen(port, host, () => {
      console.log(`Holdfast viewer listening on ${host}:${port}`);
    });
}
