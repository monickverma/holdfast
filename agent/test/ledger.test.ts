import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HSKSWAP } from "../src/config.js";
import { IntentConflict, Ledger, type Intent } from "../src/ledger.js";
import { tradingResult } from "../src/position.js";

const path = () => join(mkdtempSync(join(tmpdir(), "holdfast-")), "ledger.jsonl");

const body = (key = "k1", bodyHash: `0x${string}` = "0x01"): Omit<Intent, "status"> => ({
  key,
  intentId: "0xaa",
  bodyHash,
  orderId: "o1",
  tokenIn: HSKSWAP.whsk,
  amountIn: 10n ** 18n,
  minOut: 80_000n,
  deadline: 123n,
});

test("intent IDs stay in one bitmap word, then move to a fresh one", () => {
  const ledger = new Ledger(path());
  const first = ledger.nextIntentId();
  assert.match(first, /^0x[0-9a-f]{62}00$/);
  ledger.reserve({ ...body("a"), intentId: first });
  const second = ledger.nextIntentId();
  assert.equal(BigInt(second), BigInt(first) + 1n);
  ledger.reserve({ ...body("b"), intentId: `${first.slice(0, 64)}ff` as `0x${string}` });
  const fresh = ledger.nextIntentId();
  assert.notEqual(fresh.slice(0, 64), first.slice(0, 64));
  assert.match(fresh, /00$/);
  ledger.close();
});

test("separate ledgers never share an intent word", () => {
  const one = new Ledger(path());
  const two = new Ledger(path());
  assert.notEqual(one.nextIntentId(), two.nextIntentId());
  one.close();
  two.close();
});

test("same key and same body returns the earlier record", () => {
  const ledger = new Ledger(path());
  assert.equal(ledger.reserve(body()).existing, false);
  assert.equal(ledger.reserve(body()).existing, true);
  assert.equal(ledger.all().length, 1);
  ledger.close();
});

test("same key with a changed body is refused", () => {
  const ledger = new Ledger(path());
  ledger.reserve(body());
  assert.throws(() => ledger.reserve(body("k1", "0x02")), IntentConflict);
  ledger.close();
});

test("state, nonces and big integers survive a restart", () => {
  const file = path();
  const first = new Ledger(file);
  first.reserve(body());
  first.update("k1", { status: "signed", nonce: 7, rawTx: "0xbeef", txHash: "0xcc" });
  first.close();

  const second = new Ledger(file);
  const intent = second.get("k1")!;
  assert.equal(intent.status, "signed");
  assert.equal(intent.amountIn, 10n ** 18n);
  assert.equal(intent.rawTx, "0xbeef");
  assert.equal(second.lastNonce(), 7);
  assert.equal(second.inFlight()?.key, "k1");
  second.close();
});

test("a line torn by a crash is ignored, and earlier state stands", () => {
  const file = path();
  const first = new Ledger(file);
  first.reserve(body());
  first.close();
  appendFileSync(file, '{"key":"k1","status":"sig');

  const second = new Ledger(file);
  assert.equal(second.get("k1")!.status, "reserved");
  second.close();
});

test("trading result comes from receipts and ignores anything unfilled", () => {
  const price = 100_000n; // 0.1 USDT per HSK
  const base = { intentId: "0xaa", bodyHash: "0x01", orderId: null, minOut: 0n, deadline: 0n } as const;
  const intents: Intent[] = [
    { ...base, key: "a", status: "included", tokenIn: HSKSWAP.whsk, amountIn: 10n * 10n ** 18n, amountOut: 990_000n, feeWei: 10n ** 16n },
    { ...base, key: "b", status: "reverted", tokenIn: HSKSWAP.whsk, amountIn: 10n * 10n ** 18n, feeWei: 10n ** 16n },
    { ...base, key: "c", status: "broadcast", tokenIn: HSKSWAP.usdt, amountIn: 10n ** 6n },
  ];
  const result = tradingResult(intents, price);
  assert.equal(result.fills, 1);
  assert.equal(result.reverts, 1);
  assert.equal(result.usdtDelta, 990_000n);
  assert.equal(result.whskDelta, -(10n * 10n ** 18n));
  assert.equal(result.gasWei, 2n * 10n ** 16n);
  // Sold 1.00 USDT of HSK for 0.99, and paid 0.02 HSK = 0.002 USDT in gas.
  assert.equal(result.pnlUsdt, -12_000n);
});
