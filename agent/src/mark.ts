import { parseUnits } from "viem";
import type { Mark } from "./decide.js";

const TICKER_URL = "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=HSK_USDT";

/** Parses a Gate ticker into integer prices. Rejects crossed, empty or malformed books. */
export function parseTicker(body: unknown, nowMs: number): Mark {
  const row = Array.isArray(body) ? body[0] : undefined;
  if (typeof row?.lowest_ask !== "string" || typeof row?.highest_bid !== "string") throw new Error("ticker has no book");
  const askX18 = parseUnits(row.lowest_ask, 6);
  const bidX18 = parseUnits(row.highest_bid, 6);
  if (askX18 === 0n || bidX18 === 0n || bidX18 > askX18) throw new Error("ticker book is empty or crossed");
  return { askX18, bidX18, fetchedAtMs: nowMs };
}

/** Refreshes the outside reference off the decision path, so a slow venue only makes the mark stale. */
export class MarkFeed {
  latest: Mark | null = null;
  failures = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly refreshMs = 5_000) {}

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      const response = await fetch(TICKER_URL, { signal: AbortSignal.timeout(4_000) });
      this.latest = parseTicker(await response.json(), Date.now());
    } catch {
      this.failures++;
    }
  }
}
