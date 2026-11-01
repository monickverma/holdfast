import http from "node:http";
import https from "node:https";

export interface RpcCall {
  method: string;
  params: unknown[];
}

export class RpcError extends Error {
  constructor(
    message: string,
    /** True when sending the same request again is safe and may help. */
    readonly retryable: boolean,
    readonly code?: number,
    /** Revert data from a failed call, when the node returns it. */
    readonly data?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcStats {
  httpRequests: number;
  logicalCalls: number;
  newSockets: number;
  reusedSockets: number;
  rateLimited: number;
  retries: number;
}

export interface RpcOptions {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
}

/** JSON-RPC over one keep-alive connection, with batches checked by response ID. */
export class RpcClient {
  readonly stats: RpcStats = {
    httpRequests: 0,
    logicalCalls: 0,
    newSockets: 0,
    reusedSockets: 0,
    rateLimited: 0,
    retries: 0,
  };
  private readonly url: URL;
  private readonly agent: http.Agent;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private nextId = 1;

  constructor(url: string, options: RpcOptions = {}) {
    this.url = new URL(url);
    const AgentClass = this.url.protocol === "https:" ? https.Agent : http.Agent;
    this.agent = new AgentClass({ keepAlive: true, maxSockets: 4 });
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 250;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const [result] = await this.batch([{ method, params }]);
    return result as T;
  }

  /** Sends once with no retry, for calls with effects. */
  async callOnce<T = unknown>(method: string, params: unknown[] = [], timeoutMs?: number): Promise<T> {
    const [result] = await this.attempt([{ method, params }], timeoutMs);
    return result as T;
  }

  /** All calls succeed and come back in request order, or the whole batch throws. */
  async batch(calls: RpcCall[]): Promise<unknown[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(calls);
      } catch (error) {
        const retryable = error instanceof RpcError && error.retryable;
        if (!retryable || attempt >= this.maxRetries) throw error;
        this.stats.retries++;
        await sleep(this.retryBaseMs * 2 ** attempt);
      }
    }
  }

  close(): void {
    this.agent.destroy();
  }

  private async attempt(calls: RpcCall[], timeoutMs: number = this.timeoutMs): Promise<unknown[]> {
    const ids = calls.map(() => this.nextId++);
    const body = calls.map((call, i) => ({ jsonrpc: "2.0", id: ids[i], ...call }));
    this.stats.httpRequests++;
    this.stats.logicalCalls += calls.length;
    const parsed = await this.post(JSON.stringify(body.length === 1 ? body[0] : body), timeoutMs);
    const replies = Array.isArray(parsed) ? parsed : [parsed];

    const byId = new Map<number, { result?: unknown; error?: { code?: number; message?: string; data?: string } }>();
    for (const reply of replies) {
      if (reply?.id === null && reply?.error) throw new RpcError(`rpc: ${reply.error.message}`, false, reply.error.code);
      if (byId.has(reply?.id)) throw new RpcError(`duplicate response id ${reply?.id}`, true);
      byId.set(reply?.id, reply);
    }
    return ids.map((id) => {
      const reply = byId.get(id);
      if (!reply) throw new RpcError(`missing response id ${id}`, true);
      if (reply.error) throw new RpcError(`rpc: ${reply.error.message}`, false, reply.error.code, reply.error.data);
      if (!("result" in reply)) throw new RpcError(`empty response id ${id}`, true);
      return reply.result;
    });
  }

  private post(payload: string, timeoutMs: number): Promise<any> {
    const request = this.url.protocol === "https:" ? https.request : http.request;
    return new Promise((resolve, reject) => {
      const req = request(
        this.url,
        {
          method: "POST",
          agent: this.agent,
          timeout: timeoutMs,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            "user-agent": "holdfast/0.1",
          },
        },
        (res) => {
          if (req.reusedSocket) this.stats.reusedSockets++;
          else this.stats.newSockets++;
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", (error) => reject(new RpcError(`response: ${error.message}`, true)));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status === 429 || status === 403) {
              this.stats.rateLimited++;
              return reject(new RpcError(`http ${status}`, true));
            }
            if (status >= 500) return reject(new RpcError(`http ${status}`, true));
            if (status !== 200) return reject(new RpcError(`http ${status}`, false));
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new RpcError("response is not json", true));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (error) => reject(new RpcError(`request: ${error.message}`, true)));
      req.end(payload);
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
