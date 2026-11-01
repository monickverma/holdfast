import assert from "node:assert/strict";
import { test } from "node:test";
import { arithmeticMeanTick } from "../src/reader.js";

test("TWAP preserves a negative exact division", () => {
  assert.equal(arithmeticMeanTick(-90_210_000n, 300n), -300_700);
});

test("TWAP rounds a negative non-integer down", () => {
  assert.equal(arithmeticMeanTick(-90_210_001n, 300n), -300_701);
});

test("TWAP truncates a positive non-integer", () => {
  assert.equal(arithmeticMeanTick(90_210_001n, 300n), 300_700);
});

test("TWAP preserves zero", () => {
  assert.equal(arithmeticMeanTick(0n, 300n), 0);
});
