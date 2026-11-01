// What a rate limiter sees from the agent's read loop, against a local server that limits for a set time and then
// recovers. Nothing touches a public network. The "before" arm is the old client and the old catch-up loop.
//   npm run bench:limit -- --run rate-limit
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { RpcClient, sleep } from "../rpc.js";

const { values } = parseArgs({ options: { run: { type: "string", default: "rate-limit" }, seconds: { type: "string", default: "20" }, "limited-seconds": { type: "string", default: "10" }, "poll-ms": { type: "string", default: "650" } } });
const TOTAL_MS = Number(values.seconds) * 1000;
const LIMITED_MS = Number(values["limited-seconds"]) * 1000;
const POLL_MS = Number(values["poll-ms"]);

async function arm(name: "before" | "after", retryAfter: boolean) {
  let startedAt = 0;
  let duringLimit = 0;
  let afterLimit = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const limited = performance.now() - startedAt < LIMITED_MS;
      if (limited) {
        duringLimit++;
        res.writeHead(429, retryAfter ? { "retry-after": "2" } : {});
        return res.end("{}");
      }
      afterLimit++;
      const call = JSON.parse(Buffer.concat(chunks).toString());
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: "0x1" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = new RpcClient(url, { respectRateLimit: name === "after" });

  startedAt = performance.now();
  let firstOkMs: number | null = null;
  let skipped = 0;
  for (let tick = 0; performance.now() - startedAt < TOTAL_MS; ) {
    const wait = startedAt + tick * POLL_MS - performance.now();
    if (wait > 0) await sleep(wait);
    try {
      await rpc.call("eth_blockNumber");
      firstOkMs ??= performance.now() - startedAt;
    } catch {
      // The real loop logs and carries on.
    }
    if (name === "before") tick++;
    else {
      const next = Math.max(tick + 1, Math.floor((performance.now() - startedAt) / POLL_MS));
      skipped += next - tick - 1;
      tick = next;
    }
  }
  rpc.close();
  server.closeAllConnections();
  server.close();
  return { name, retryAfterHeader: retryAfter, requestsDuringLimit: duringLimit, requestsAfterLimit: afterLimit, firstSuccessMs: firstOkMs, skippedTicks: skipped };
}

const results = [await arm("before", false), await arm("after", false), await arm("before", true), await arm("after", true)];
const report = { lane: "local simulation", note: `A local server returned 429 for ${LIMITED_MS / 1000} s of a ${TOTAL_MS / 1000} s run, polled every ${POLL_MS} ms. One run per arm. It shows the client's behaviour, not how the public RPC's limiter responds.`, results };
const dir = join("data", values.run!);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
