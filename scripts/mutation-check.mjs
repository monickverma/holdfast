// Breaks one vault check at a time and confirms a test notices. A surviving mutant is a check nothing is really testing.
// Restores the source afterwards, including on failure. Writes evidence/v4/mutation-check.json.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const FILE = "contracts/HoldfastVault.sol";
const original = readFileSync(FILE, "utf8");
// A Windows checkout may have CRLF line endings. The patterns below are written with LF.
const eol = original.includes("\r\n") ? "\r\n" : "\n";
const MUTANTS = [
  ["agent check removed", "if (msg.sender != agent) revert NotAgent();", ""],
  ["pause ignored", "if (paused) revert IsPaused();", ""],
  ["expiry ignored", "if (block.timestamp >= agentExpiry) revert AgentExpired();", ""],
  ["expiry off by one", "if (block.timestamp >= agentExpiry) revert AgentExpired();", "if (block.timestamp > agentExpiry) revert AgentExpired();"],
  ["any token allowed", "if (tokenIn != tokenA && tokenIn != tokenB) revert BadToken();\n        if (amountIn == 0)", "if (amountIn == 0)"],
  ["deadline upper bound removed", " || deadline > block.timestamp + MAX_INTENT_TTL", ""],
  ["intent replay allowed", "if (usedBits & bit != 0) revert IntentUsed();", ""],
  ["trade cap removed", "if (amountIn > limit.maxTrade) revert OverTradeCap();", ""],
  ["lifetime cap removed", "if (amountIn > left) revert OverLifetimeCap();", ""],
  ["hourly budget removed", "if (amountIn > available) revert OverHourlyBudget();", ""],
  ["daily budget removed", "if (amountIn > available) revert OverDailyBudget();", ""],
  ["floor removed", "if (minOut < _floorOut(amountIn, floorPrice)) revert BelowFloor();", ""],
  ["floor rounds down", "(amountIn * floorPrice + 1e18 - 1) / 1e18", "(amountIn * floorPrice) / 1e18"],
  ["lifetime not charged", "uint72(left - amountIn), uint72(available - amountIn)", "uint72(left), uint72(available - amountIn)"],
  ["budget not charged", "uint72(left - amountIn), uint72(available - amountIn)", "uint72(left - amountIn), uint72(available)"],
  ["output check removed", "if (amountOut < minOut) revert InsufficientOutput();", ""],
  ["partial pull keeps allowance", "if (spent != amountIn) _approve(tokenIn, 0);", ""],
  ["agent can withdraw", "function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant", "function withdraw(address token, address to, uint256 amount) external nonReentrant"],
  ["anyone can set limits", "uint256 hourlyBudget_\n    ) external onlyOwner {\n        _setLimits", "uint256 hourlyBudget_\n    ) external {\n        _setLimits"],
  ["reentrancy lock removed", "if (lock != 0) revert Reentered();", ""],
  ["guard skipped on trades", "if (window != 0) _requireInBand(tokenIn, _twapTick(window), guardBandTicks);", ""],
  ["band has the wrong sign", "gap < -int256(band) : gap > int256(band)", "gap > int256(band) : gap < -int256(band)"],
  ["band off by one", "gap < -int256(band) : gap > int256(band)", "gap <= -int256(band) : gap >= int256(band)"],
  ["twap does not round down", "if (delta < 0 && delta % span != 0) tick--;", ""],
  ["stop fires on any price", "if (_sellsToken0(tokenIn) ? twap > s.triggerTick : twap < s.triggerTick) revert StopNotTriggered();", ""],
  ["stop cooldown ignored", "if (block.timestamp < s.nextAt) revert StopCoolingDown();", ""],
  ["stop allowance not charged", "s.remaining -= uint72(amountIn);", ""],
  ["stop skips its band", "_requireInBand(tokenIn, twap, t.bandTicks);", ""],
  ["stop ignores its floor", "uint256 minOut = _floorOut(amountIn, t.floorPriceX18);", "uint256 minOut = 0;"],
  ["halt leaves the stop armed", "paused = true;\n        stop.armed = false;", "paused = true;"],
  ["revoke does nothing", "agentExpiry = uint40(block.timestamp);\n        emit AgentSet(agent, block.timestamp);", "emit AgentSet(agent, block.timestamp);"],
  ["guardian can unpause", "function unpause() external onlyOwner {", "function unpause() external {"],
  ["handover needs no acceptance", "pendingOwner = newOwner;", "owner = newOwner;"],
  ["conditional limits not checked", "if (limits[token].remaining != expectedRemaining) revert RemainingChanged();", ""],
  ["limits truncate", "maxTrade_ > type(uint72).max || remaining_ > type(uint72).max || hourlyBudget_ > type(uint72).max\n                || floorPriceX18_ > type(uint112).max", "false"],
  ["limit change refills budget", "uint256 available = hourlyBudget_ > spent ? hourlyBudget_ - spent : 0;", "uint256 available = hourlyBudget_;"],
  ["trades leave no log entry", "_log(LOG_TRADE, intentId, tokenIn, spent, amountOut);", ""],
  ["log records the asked amount", "_log(LOG_TRADE, intentId, tokenIn, spent, amountOut);", "_log(LOG_TRADE, intentId, tokenIn, amountIn, amountOut);"],
  ["stops leave no log entry", "_log(LOG_STOP, bytes32(0), tokenIn, amountIn, amountOut);", ""],
  ["log head not bound to the vault", "abi.encode(\"holdfast.log.v1\", block.chainid, address(this))", "abi.encode(\"holdfast.log.v1\", block.chainid)"],
  ["count not advanced", "logCount = count;", ""],
  ["anyone can anchor", "if (msg.sender != agent || block.timestamp >= agentExpiry) revert NotAgent();\n        _log(LOG_ANCHOR", "_log(LOG_ANCHOR"],
  ["expired key can anchor", "if (msg.sender != agent || block.timestamp >= agentExpiry) revert NotAgent();\n        _log(LOG_ANCHOR", "if (msg.sender != agent) revert NotAgent();\n        _log(LOG_ANCHOR"],
  ["worst-fill refusal removed", "if (worst > _dailyNow(lossBucket, t.dailyLossBudget)) revert OverLossBudget();", ""],
  ["stale mark accepted", "if (t.maxMarkAge != 0 && block.timestamp > uint256(t.markSetAt) + t.maxMarkAge) revert MarkStale();", ""],
  ["loss not charged", "if (lossGuardOn) _chargeLoss(tokenIn, spent, amountOut, intentId);", ""],
  ["breaker does not pause", "paused = true;\n            emit LossBreakerTripped", "emit LossBreakerTripped"],
  ["good fills earn credit", "return given > got ? given - got : 0;", "return given > got ? given - got : given / 2;"],
  ["buy side not valued at the mark", "uint256 got = tokenIn == tokenA ? amountOut : (amountOut * mark) / 1e18;", "uint256 got = amountOut;"],
  ["new mark refills the loss budget", "uint256 spent = lossGuardOn ? oldBudget - _dailyNow(lossBucket, oldBudget) : 0;", "uint256 spent = 0;"],
  ["share limit removed", "if (share != 0 && amountIn * BPS > IERC20(tokenIn).balanceOf(address(this)) * share) revert OverBalanceShare();", ""],
  ["cooldown removed", "if (interval != 0 && block.timestamp < limit.refilledAt + interval) revert TradeTooSoon();", ""],
  ["anyone can set the loss guard", "function setLossGuard(uint256 markPriceX18_, uint256 dailyLossBudget_, uint32 maxMarkAge_) external onlyOwner", "function setLossGuard(uint256 markPriceX18_, uint256 dailyLossBudget_, uint32 maxMarkAge_) external"],
  ["anyone can pin", "function setStrategyPin(bytes32 strategyPin_) external onlyOwner", "function setStrategyPin(bytes32 strategyPin_) external"],
  ["guard accepts any pool", "!((token0 == tokenA && token1 == tokenB) || (token0 == tokenB && token1 == tokenA))\n                || IPricePool(pool_).fee() != poolFee", "false"],
];

// Foundry replays saved failures. Without clearing them, one mutant's failure would count as a kill of the next.
function clearSavedFailures() {
  for (const dir of ["cache/invariant", "cache/fuzz"]) rmSync(dir, { recursive: true, force: true });
}

function run() {
  clearSavedFailures();
  const r = spawnSync(process.execPath, ["scripts/forge.mjs", "test", "--offline", "--no-match-contract", "HoldfastVaultForkTest"], { encoding: "utf8", env: { ...process.env, FOUNDRY_FUZZ_RUNS: "200", FOUNDRY_INVARIANT_RUNS: "64", FOUNDRY_INVARIANT_DEPTH: "60" } });
  const out = `${r.stdout}\n${r.stderr}`;
  if (/Compiler run failed|Compilation failed/.test(out)) return { outcome: "did not compile", detail: out.slice(0, 400) };
  const failed = [...out.matchAll(/^\[FAIL[^\n]*?\b((?:test|testFuzz|invariant)_\w+)\(/gm)].map((m) => m[1]);
  const invariants = [...out.matchAll(/^ (invariant_\w+)\(/gm)].map((m) => m[1]);
  return { outcome: r.status === 0 ? "SURVIVED" : "killed", killedBy: [...new Set([...failed, ...invariants])].slice(0, 6) };
}

const results = [];
try {
  const base = run();
  if (base.outcome !== "SURVIVED") throw new Error(`the unmutated suite must pass first: ${JSON.stringify(base)}`);
  for (const [name, lfFrom, lfTo] of MUTANTS) {
    const [from, to] = [lfFrom, lfTo].map((text) => text.replaceAll("\n", eol));
    if (!original.includes(from)) throw new Error(`mutant "${name}" no longer matches the source`);
    writeFileSync(FILE, original.replace(from, to));
    const result = run();
    results.push({ name, ...result });
    console.log(`${result.outcome.padEnd(16)} ${name}`);
  }
} finally {
  writeFileSync(FILE, original);
  clearSavedFailures();
}
const survived = results.filter((r) => r.outcome === "SURVIVED").map((r) => r.name);
const summary = { wallTime: new Date().toISOString(), lane: "local", mutants: results.length, killed: results.filter((r) => r.outcome === "killed").length, didNotCompile: results.filter((r) => r.outcome === "did not compile").length, survived, note: "Hand-picked mutants of the security checks, not exhaustive mutation testing.", results };
mkdirSync("evidence/v4", { recursive: true });
writeFileSync("evidence/v4/mutation-check.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${summary.killed}/${summary.mutants} killed, ${survived.length} survived, ${summary.didNotCompile} did not compile`);
if (survived.length) process.exitCode = 1;
