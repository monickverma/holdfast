import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hex } from "viem";
import { planDeployment, runtimeMatches, wiredAfterDeploy, type DeployFacts } from "../src/cli/deploy-vault.js";

const OWNER = "0x1137FA10a0aE7e5Ac228d1B3b86CAc02b92Ef489";
const AGENT = "0x6ddB61023935F3E05F4fb94551eA18e0f04d2FcA";
const facts: DeployFacts = {
  rpcChainId: 133,
  expectedChainId: 133,
  owner: OWNER,
  agent: AGENT,
  expiryDays: 7,
  gasEstimate: 4_000_000n,
  gasPrice: 1_000_000_000n,
  balance: 10n ** 16n,
  venue: { verdict: "pass" },
  broadcast: false,
  confirmedMainnet: false,
};

test("a sound plan has no blockers, and its cost includes the margin", () => {
  const plan = planDeployment(facts);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.gasLimit, 4_800_000n);
  assert.equal(plan.costWei, 4_800_000n * 1_000_000_000n);
});

test("a smaller gas margin can be chosen, but not one too thin to land", () => {
  assert.equal(planDeployment({ ...facts, gasMarginPercent: 110n }).gasLimit, 4_400_000n);
  assert.ok(planDeployment({ ...facts, gasMarginPercent: 104n }).blockers.some((b) => /gas margin/.test(b)));
  assert.ok(planDeployment({ ...facts, gasMarginPercent: 201n }).blockers.some((b) => /gas margin/.test(b)));
});

test("each problem blocks the deployment and says why", () => {
  for (const [change, why] of [
    [{ rpcChainId: 177 }, /configured for 133/],
    [{ rpcChainId: null }, /did not report a chain/],
    [{ owner: "not an address" }, /--owner/],
    [{ agent: "" }, /--agent/],
    [{ agent: OWNER }, /different keys/],
    [{ agent: OWNER.toLowerCase() }, /different keys/],
    [{ expiryDays: 31 }, /expiry/],
    [{ expiryDays: 0 }, /expiry/],
    [{ expiryDays: Number.NaN }, /expiry/],
    [{ venue: { verdict: "fail" } }, /venue check came back fail/],
    [{ venue: { verdict: "unverified" } }, /venue check came back unverified/],
    [{ gasEstimate: null }, /cost is unknown/],
    [{ gasPrice: null }, /cost is unknown/],
    [{ balance: null }, /owner's balance/],
    [{ balance: 1n }, /holds/],
  ] as const) {
    const blockers = planDeployment({ ...facts, ...change } as DeployFacts).blockers;
    assert.ok(blockers.some((b) => why.test(b)), `${JSON.stringify(change, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}: ${blockers.join(" | ")}`);
  }
});

test("mainnet needs its own flag, but only to send", () => {
  const mainnet = { ...facts, rpcChainId: 177, expectedChainId: 177 };
  assert.deepEqual(planDeployment(mainnet).blockers, [], "a dry run on mainnet is only reading");
  assert.ok(planDeployment({ ...mainnet, broadcast: true }).blockers.some((b) => /--confirm-mainnet/.test(b)));
  assert.deepEqual(planDeployment({ ...mainnet, broadcast: true, confirmedMainnet: true }).blockers, []);
});

test("runtime comparison ignores immutable slots and nothing else", () => {
  const artifact = { deployedBytecode: { object: "0x6000aaaa6000" as Hex, immutableReferences: { "1": [{ start: 2, length: 2 }] } } };
  assert.deepEqual(runtimeMatches("0x6000bbbb6000", artifact), { matches: true, maskedSlots: 1 });
  assert.equal(runtimeMatches("0x6001bbbb6000", artifact).matches, false, "a changed byte outside the slot");
  assert.equal(runtimeMatches("0x6000bbbb600000", artifact).matches, false, "a different length");
  assert.equal(runtimeMatches("0x6000aaaa6000", { deployedBytecode: { object: "0x6000aaaa6000" } }).matches, true);
});

test("a new vault's unset guardian, guard and loss budget are next steps, and anything else failing is a failed deployment", () => {
  const unset = ["guardian", "price guard", "loss guard"].map((name) => ({ name, status: "fail" as const }));
  assert.equal(wiredAfterDeploy([{ name: "vault router", status: "pass" }, { name: "whsk limits", status: "warn" }, ...unset]), true);
  assert.equal(wiredAfterDeploy([...unset, { name: "vault router", status: "fail" }]), false);
  assert.equal(wiredAfterDeploy([{ name: "vault code", status: "unverified" }]), false);
});
