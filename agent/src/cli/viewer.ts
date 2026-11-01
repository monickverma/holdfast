// Read-only evidence server. No signer, executor or policy writer is loaded, and private keys never enter this process.
import Anthropic from "@anthropic-ai/sdk";
import { createServer } from "node:http";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createPublicClient, formatUnits, http, isAddress } from "viem";
import type { Agent } from "../agent.js";
import { MAINNET_MARKET as HSKSWAP, testMarket, networkProfile } from "../config.js";
import { buildFacts } from "../facts.js";
import { Assistant, DEFAULT_MODEL } from "../nl.js";
import { DEFAULT_POLICY } from "../policy.js";
import { VAULT_ABI } from "../reader.js";
import { quantileReport } from "../stats.js";
import { JsonlLog } from "../trace.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
type Row = Record<string, any>;
const lanes = ["mainnet", "fork", "replay", "testnet"] as const;
const explorers = { mainnet: "https://hsk.blockscout.com", testnet: "https://testnet-explorer.hskchain.net" };
const isLane = (v: unknown): v is typeof lanes[number] => lanes.includes(v as typeof lanes[number]);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const quantiles = (samples: number[]) => Object.fromEntries([0.5, 0.95, 0.99].map((q) => [`P${q * 100}`, quantileReport(samples, q)]));

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
    const inclusion: number[] = [];
    let feeWei = 0n;
    for (const group of groups) {
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
        trades.push({ lane, time: typeof row.time === "string" ? row.time : "not recorded", side: known ? `${sell ? "sell" : "buy"} ${base}` : "unknown token",
          input: known ? `${amount(row.amountIn, sell ? 18 : 6)} ${sell ? base : quote}` : "unknown",
          output: row.status === "reverted" ? "none" : known ? `${amount(row.amountOut, sell ? 6 : 18)} ${sell ? quote : base}` : "unknown",
          gas: amount(row.gasUsed, 0), status: String(row.status ?? "unknown"), reason: typeof row.revertReason === "string" ? row.revertReason : null,
          link: lane in explorers && /^0x[\da-f]{64}$/i.test(row.txHash ?? "") ? `${explorers[lane as keyof typeof explorers]}/tx/${row.txHash}` : null });
        if (/^\d+$/.test(row.feeWei ?? "")) feeWei += BigInt(row.feeWei);
        if (["included", "reverted"].includes(row.status) && /^\d+$/.test(row.blockNumber ?? "") && /^\d+$/.test(row.broadcastBlock ?? "")) {
          const blocks = Number(BigInt(row.blockNumber) - BigInt(row.broadcastBlock));
          if (Number.isSafeInteger(blocks) && blocks >= 0) inclusion.push(blocks);
        }
      }
    }
    return { lane, latency: { decisionToBroadcastMs: quantiles(sent.map((t) => t.attrs.decisionToBroadcastMs)),
      ...Object.fromEntries(stages.map((stage) => [`${stage} service ms`, quantiles(sent.flatMap((t) => (Array.isArray(t.spans) ? t.spans : []).filter((s: Row) => s.stage === stage && s.ok && finite(s.endMs) && finite(s.startMs)).map((s: Row) => s.endMs - s.startMs)))])),
      inclusionBlocks: quantiles(inclusion) }, trades,
      totals: { fills: trades.filter((t) => t.status === "included").length, reverts: trades.filter((t) => t.status === "reverted").length,
        networkFeeHsk: formatUnits(feeWei, 18), modelCallsInExecutionPath: traces.reduce((sum, t) => sum + (finite(t.attrs?.modelCalls) ? t.attrs.modelCalls : 0), 0) } };
  });
  // Explicit field selection keeps raw signed transactions and arbitrary metadata off the wire.
  const summary = (attack as Row | null)?.summary;
  const attacks = summary ? { lane: "fork", attacks: summary.attacks?.n, contained: summary.attacks?.contained,
    benign: summary.benign?.n, completed: summary.benign?.completed, capViolations: summary.capViolations,
    maxDrainedHsk: summary.maxDrainedHsk, lifetimeCapHsk: summary.lifetimeCapHsk } : null;
  return { lanes: result, attacks, incomplete, empty: !groups.some((g) => g.traces.length || g.ledger.length) && !attacks };
}

async function vaultLimits(address: string | undefined) {
  if (!address) return { status: "No vault is set." };
  if (!isAddress(address)) return { status: "Vault configuration is invalid." };
  try {
    // Profile endpoint and chain check keep vault reads in the correct lane.
    const profile = networkProfile();
    const market = profile.network === "testnet" ? testMarket() : HSKSWAP;
    const client = createPublicClient({ transport: http(profile.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
    if (await client.getChainId() !== profile.chainId) throw new Error("Wrong chain");
    const blockNumber = await client.getBlockNumber();
    const testnet = profile.network === "testnet";
    const tokens = await Promise.all(([[testnet ? 'tWHSK' : 'HSK', market.whsk, 18], [testnet ? 'tUSDT' : 'USDT', market.usdt, 6]] as const).map(async ([token, tokenAddress, decimals]) => {
      const values = await Promise.all((["maxTrade", "remaining", "floorPriceX18"] as const).map((functionName) => client.readContract({ address, abi: VAULT_ABI, functionName, args: [tokenAddress], blockNumber })));
      return { lane: profile.lane, token, maxTrade: formatUnits(values[0]!, decimals), remainingLifetime: formatUnits(values[1]!, decimals), floorOutputPerInput: formatUnits(values[2]!, decimals === 18 ? 6 : 30) };
    }));
    return { lane: profile.lane, status: "Read from chain", address, explorer: explorers[profile.lane], block: blockNumber.toString(), tokens };
  } catch { return { status: "Vault read unavailable. Not yet run successfully." }; }
}

export function createViewer(options: { dataDir?: string; assistant?: Pick<Assistant, "handle"> | null; vaultAddress?: string } = {}) {
  const dataDir = options.dataDir ?? join(root, "data");
  const llmLog = new JsonlLog(join(dataDir, "llm.jsonl"));
  const assistant = options.assistant === undefined
    ? (process.env.ANTHROPIC_API_KEY ? new Assistant(new Anthropic(), process.env.LLM_MODEL ?? DEFAULT_MODEL, (record) => llmLog.append(record)) : null)
    : options.assistant;
  const address = options.vaultAddress ?? process.env.VAULT_ADDRESS ?? (networkProfile().network === "testnet" ? testMarket().vault : undefined);
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      let text = type === "application/json" ? JSON.stringify(body) : String(body);
      // The API key is never returned, including when echoed by a model or evidence field. The vault address is public.
      const secret = process.env.ANTHROPIC_API_KEY;
      if (secret) text = text.split(secret).join("[redacted]");
      res.end(text);
    };
    try {
      const path = decodeURIComponent(req.url ?? "/");
      if (path.includes("..") || path.includes("\\") || path.includes("\0") || path.includes("%")) return send(400, { error: "Path refused." });
      if (req.headers.host !== `127.0.0.1:${(res.socket?.address() as { port: number }).port}`) return send(403, { error: "Host refused." });
      if (req.method === "GET" && ["/", "/app.js", "/style.css"].includes(path)) {
        const name = path === "/" ? "index.html" : path.slice(1);
        return send(200, readFileSync(join(root, "web", name), "utf8"), path === "/" ? "text/html" : path.endsWith(".js") ? "text/javascript" : "text/css");
      }
      if (req.method === "GET" && path === "/api/evidence") return send(200, { ...readEvidence(dataDir), vault: await vaultLimits(address), chat: assistant ? "Questions only. Answers are model output." : "ANTHROPIC_API_KEY is missing. Chat is unavailable." });
      if (req.method === "POST" && path === "/api/chat") {
        if (req.headers.origin !== `http://${req.headers.host}` || !req.headers["content-type"]?.startsWith("application/json")) return send(403, { error: "Origin refused." });
        if (!assistant) return send(503, { error: "ANTHROPIC_API_KEY is missing. Chat is unavailable." });
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 8_000) return send(413, { error: "Question too long." }); }
        const { message } = JSON.parse(body);
        if (typeof message !== "string" || !message.trim()) return send(400, { error: "A question is required." });
        const base = buildFacts({ lastMarket: undefined } as unknown as Agent, DEFAULT_POLICY) as Row;
        const reply = await assistant.handle(`Answer questions only. Policy changes belong in the REPL.\n${message}`, { status: base.status, evidence: readEvidence(dataDir), vault: await vaultLimits(address) }, DEFAULT_POLICY, 0n);
        return send(200, { label: "Model output", text: reply.kind === "answer" ? reply.text : "This panel only answers questions. Policy changes stay in the existing REPL." });
      }
      send(404, { error: "Not found." });
    } catch { send(400, { error: "Request unavailable." }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Only these names are taken from .env, so the wallet keys stay out of this process.
  if (existsSync(join(root, ".env"))) {
    const file = parseEnv(readFileSync(join(root, ".env"), "utf8"));
    for (const name of ["VAULT_ADDRESS", "ANTHROPIC_API_KEY", "LLM_MODEL"]) if (file[name] && !process.env[name]) process.env[name] = file[name];
  }
  const port = Number(process.env.PORT ?? 4177);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid viewer port.");
  createViewer({ dataDir: process.env.DATA_DIR }).listen(port, "127.0.0.1", () => console.log("Holdfast viewer is listening on the loopback interface."));
}
