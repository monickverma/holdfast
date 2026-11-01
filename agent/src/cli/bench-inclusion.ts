// Testnet self-transfers only. This tool measures stream inclusion independently of the sync response.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { networkProfile } from "../config.js";
import { analyzeInclusion, inclusionRow, inclusionSchedule, InclusionTracker, retryAfterMs, type InclusionRow } from "../inclusion.js";
import { sleep } from "../rpc.js";
import { FlashblockStream, FrameContinuity, type Frame } from "../stream.js";
import { JsonlLog } from "../trace.js";

const safeError = (error: unknown) => String(error).replace(/0x[0-9a-f]{64,}/gi, "[hex omitted]");

async function main(): Promise<void> {
  process.loadEnvFile();
  if (process.env.NETWORK !== "testnet") throw new Error("Set NETWORK=testnet");
  const { values } = parseArgs({ options: {
    broadcast: { type: "boolean", default: false }, phases: { type: "string", default: "0,50,90,110,150" },
    "per-cell": { type: "string", default: "10" }, seed: { type: "string", default: "1" },
    run: { type: "string", default: `inclusion-${Date.now()}` }, "timeout-ms": { type: "string", default: "15000" },
  } });
  if (!values.broadcast) throw new Error("This sends testnet self-transfers. Add --broadcast to run.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(values.run!)) throw new Error("run must be a simple directory name");
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 2000) throw new Error("timeout-ms must be at least 2000");
  const phases = values.phases!.split(",").map((value) => value.trim() === "" ? NaN : Number(value));
  const schedule = inclusionSchedule(phases, Number(values["per-cell"]), Number(values.seed));
  // The same environment/profile and agent wallet as bench-react; no deployed market or vault is needed.
  const profile = networkProfile();
  if (Number(process.env.CHAIN_ID ?? profile.chainId) !== 133) throw new Error("Expected testnet chain 133");
  const rpcUrl = process.env.RPC_URL ?? profile.rpcUrl;
  const streamUrl = process.env.FLASHBLOCKS_URL ?? "wss://testnet-flashblocks.hsk.xyz/ws";
  const key = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error("Needs AGENT_PRIVATE_KEY");
  let account;
  try { account = privateKeyToAccount(key); } catch { throw new Error("Invalid agent wallet key"); }

  mkdirSync("data", { recursive: true });
  const dataDir = join("data", values.run!);
  mkdirSync(dataDir); // Refuse to mix a new run with existing samples.
  const log = new JsonlLog(join(dataDir, "inclusion.jsonl"));
  const rows: InclusionRow[] = [];
  writeFileSync(join(dataDir, "run.json"), JSON.stringify({ phases, perCell: Number(values["per-cell"]), seed: Number(values.seed), timeoutMs,
    chainId: 133, startedAt: new Date().toISOString(), clock: "performance.now milliseconds", minimumSendGapMs: 2000 }, null, 2));

  let current: InclusionRow | null = null;
  let tracker: InclusionTracker | null = null;
  let latest: { frame: Frame; sequence: number } | null = null;
  let sequence = 0;
  let baseFee = 0n;
  let lastSend = -Infinity;
  const continuity = new FrameContinuity();
  const listeners = new Set<() => void>();
  const controller = new AbortController();
  const breakStream = (kind: string) => {
    if (current && current.triggerArrivedAt !== null) current.error ??= `stream ${kind}; inclusion distance is untrusted`;
    continuity.reset();
    for (const listener of listeners) listener();
  };
  const stream = new FlashblockStream(streamUrl, (frame) => {
    sequence++;
    const problem = continuity.observe(frame);
    if (problem) breakStream(problem);
    if (frame.baseFeePerGas !== undefined) baseFee = frame.baseFeePerGas;
    latest = { frame, sequence };
    tracker?.observe(frame, sequence);
    for (const listener of listeners) listener();
  }, breakStream);

  const waitFor = <T>(get: () => T | null): Promise<T> => new Promise((resolve, reject) => {
    const finish = (error?: Error, result?: T) => {
      clearTimeout(timer);
      listeners.delete(check);
      controller.signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve(result!);
    };
    const check = () => { const result = get(); if (result !== null) finish(undefined, result); };
    const aborted = () => finish(new Error("interrupted"));
    const timer = setTimeout(() => finish(new Error("timed out waiting for stream frame")), timeoutMs);
    listeners.add(check);
    controller.signal.addEventListener("abort", aborted, { once: true });
    if (controller.signal.aborted) aborted(); else check();
  });

  const flush = () => {
    if (!current) return;
    if (current.responseAt !== null && current.inclusionArrivedAt !== null) current.inclusionToResponseMs = current.responseAt - current.inclusionArrivedAt;
    if (current.error?.startsWith("stream ")) current.framesBetween = null;
    log.append(current);
    rows.push(current);
    current = null;
    tracker = null;
  };
  const stop = () => {
    if (current) { current.error ??= "interrupted"; current.responseStatus ??= "interrupted"; flush(); }
    controller.abort();
    stream.close();
    process.exitCode = 130;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let requestId = 0;
  const request = async (body: unknown) => {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) });
    if (current) current.httpStatus = response.status;
    if (response.status === 429) {
      if (current) { current.rateLimitWaitMs = retryAfterMs(response.headers.get("retry-after")); current.responseStatus = "http 429"; }
      else await sleep(retryAfterMs(response.headers.get("retry-after")));
      throw new Error("http 429");
    }
    if (!response.ok) throw new Error(`http ${response.status}`);
    return response.json();
  };
  const call = (method: string, params: unknown[] = []) => ({ jsonrpc: "2.0", id: ++requestId, method, params });
  try {
    const startup = [call("eth_chainId"), call("eth_getTransactionCount", [account.address, "pending"]), call("eth_gasPrice")];
    const replies = await request(startup) as Array<{ id: number; result?: Hex; error?: unknown }>;
    const results = startup.map((entry) => {
      const reply = replies.find((value) => value.id === entry.id);
      if (!reply?.result || reply.error) throw new Error("initial RPC batch failed");
      return reply.result;
    });
    if (Number(results[0]) !== 133) throw new Error("RPC is not testnet chain 133");
    let nonce = Number(results[1]);
    const gasPrice = BigInt(results[2]!);
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Invalid initial nonce");
    await stream.start();
    for (const [trial, cell] of schedule.entries()) {
      if (controller.signal.aborted) break;
      current = inclusionRow(trial, cell);
      const row = current;
      try {
        await sleep(Math.max(0, lastSend + 2000 - performance.now()));
        if (controller.signal.aborted) break;
        const raw = await account.signTransaction({ type: "eip1559", chainId: 133, nonce, to: account.address, value: 0n,
          gas: 21_000n, maxPriorityFeePerGas: gasPrice, maxFeePerGas: (baseFee > gasPrice ? baseFee : gasPrice) * 2n + gasPrice });
        tracker = new InclusionTracker(row, raw);
        const after = sequence;
        const trigger = await waitFor(() => latest && latest.sequence > after && latest.frame.index === cell.targetIndex ? latest : null);
        tracker.trigger(trigger.frame, trigger.sequence);
        const sendDue = trigger.frame.arrivedAt + cell.targetPhaseMs;
        while (performance.now() < sendDue) await sleep(Math.max(1, sendDue - performance.now()));
        if (controller.signal.aborted) break;
        if (row.error) throw new Error(row.error);
        row.sendAt = performance.now();
        row.actualPhaseMs = row.sendAt - trigger.frame.arrivedAt;
        lastSend = row.sendAt;
        try {
          const sent = call("eth_sendRawTransactionSync", [raw]);
          const reply = await request(sent) as { id: number; result?: { status: Hex; blockNumber: Hex; transactionIndex: Hex; transactionHash: Hex }; error?: { message: string } };
          row.responseAt = performance.now();
          if (reply.id !== sent.id || reply.error || !reply.result) throw new Error(reply.error?.message ?? "sync response has no matching receipt");
          const receipt = reply.result;
          if (receipt.transactionHash?.toLowerCase() !== row.transactionHash) throw new Error("sync receipt hash does not match the sent transaction");
          row.receiptBlock = String(BigInt(receipt.blockNumber));
          row.receiptTransactionIndex = Number(receipt.transactionIndex);
          row.responseStatus = receipt.status === "0x1" ? "success" : "reverted";
        } catch (error) {
          row.responseAt ??= performance.now();
          row.responseStatus ??= "error";
          row.error ??= safeError(error);
        }
        // Receipt and stream can arrive in either order. Never poll for a receipt.
        await waitFor(() => row.inclusionArrivedAt === null ? null : true);
        if (row.responseStatus !== "success") row.error ??= "self-transfer did not return a successful receipt";
      } catch (error) {
        row.error ??= safeError(error);
        row.responseStatus ??= "failed";
      } finally { flush(); }
      if (row.rateLimitWaitMs !== null) await sleep(row.rateLimitWaitMs);
      // A trial that never sent, or was refused at the rate limit, used no nonce and is only a failed sample.
      if (row.sendAt === null || row.responseStatus === "http 429") continue;
      // An uncertain send might still consume its nonce. Stop instead of creating another outstanding transaction.
      if (row.responseStatus !== "success") break;
      nonce++;
    }
  } finally {
    stream.close();
    controller.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    writeFileSync(join(dataDir, "analysis.json"), JSON.stringify(analyzeInclusion(rows), null, 2));
  }
  console.log(`Wrote ${rows.length} trials to ${dataDir}`);
}

void main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
