// Read only, and it never loads a wallet key. Checks mainnet flashblocks against the blocks that sealed, and checks the
// frame's Swap decoder against the pool's real state at past swaps.
//   frame-drift -- --minutes 90 --backfill-blocks 300000 --run drift-mainnet
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { HSKSWAP, loadConfig, networkProfile } from "../config.js";
import { compareBlock, FrameLedger } from "../drift.js";
import { RpcClient, sleep, untilAnswered } from "../rpc.js";
import { wilson } from "../stats.js";
import { FlashblockStream, lastSwap, type FlashLog } from "../stream.js";
import { JsonlLog } from "../trace.js";

const { values } = parseArgs({
  options: {
    minutes: { type: "string", default: "90" },
    "backfill-blocks": { type: "string", default: "300000" },
    run: { type: "string", default: `drift-${Date.now()}` },
  },
});
if (networkProfile().network !== "mainnet") throw new Error("This reads the real chain, so it needs NETWORK=mainnet");

const config = loadConfig({ NETWORK: "mainnet" });
const rpc = new RpcClient(config.rpcUrl);
const dir = join(config.dataDir, values.run!);
mkdirSync(dir, { recursive: true });
const log = new JsonlLog(join(dir, "frame-drift.jsonl"));

const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
]);
const slot0Data = encodeFunctionData({ abi: POOL_ABI, functionName: "slot0" });
const liquidityData = encodeFunctionData({ abi: POOL_ABI, functionName: "liquidity" });
const hex = (value: bigint | number) => `0x${value.toString(16)}`;

/** Runs the same decoder a frame reaction uses on real past logs, and compares with the pool's state at that block. */
async function backfillDecoder(blocks: number) {
  const head = BigInt(await rpc.call<string>("eth_blockNumber", []));
  const byBlock = new Map<bigint, FlashLog[]>();
  for (let to = head; to > head - BigInt(blocks); to -= 1000n) {
    const from = to - 999n;
    // A public RPC limits bursts, so this goes slowly.
    await sleep(250);
    const logs = await rpc.call<Array<FlashLog & { blockNumber: string }>>("eth_getLogs", [{ address: HSKSWAP.pool, topics: [SWAP_TOPIC], fromBlock: hex(from), toBlock: hex(to) }]);
    for (const entry of logs) {
      const block = BigInt(entry.blockNumber);
      byBlock.set(block, [...(byBlock.get(block) ?? []), entry]);
    }
  }
  let checked = 0;
  let matched = 0;
  let unavailable = 0;
  let firstMismatch: unknown = null;
  for (const [block, logs] of byBlock) {
    const decoded = lastSwap({ block, index: 0, logs, arrivedAt: 0 }, HSKSWAP.pool)!;
    await sleep(250);
    try {
      const [slot0, liquidity] = await rpc.batch([
        { method: "eth_call", params: [{ to: HSKSWAP.pool, data: slot0Data }, hex(block)] },
        { method: "eth_call", params: [{ to: HSKSWAP.pool, data: liquidityData }, hex(block)] },
      ]);
      const [sqrtPriceX96, tick] = decodeFunctionResult({ abi: POOL_ABI, functionName: "slot0", data: slot0 as Hex });
      const actualLiquidity = decodeFunctionResult({ abi: POOL_ABI, functionName: "liquidity", data: liquidity as Hex });
      checked++;
      if (decoded.sqrtPriceX96 === sqrtPriceX96 && decoded.tick === tick && decoded.liquidity === actualLiquidity) matched++;
      else firstMismatch ??= { block: block.toString(), decodedTick: decoded.tick, tick };
    } catch {
      unavailable++;
    }
  }
  return { windowBlocks: blocks, blocksWithSwaps: byBlock.size, checked, matched, matchedWilson95: checked ? wilson(matched, checked) : null, stateUnavailable: unavailable, firstMismatch };
}

const backfillBlocks = Number(values["backfill-blocks"]);
const decoder = backfillBlocks > 0 ? await untilAnswered(() => backfillDecoder(backfillBlocks)) : null;
console.log(JSON.stringify({ decoder }));

const ledger = new FrameLedger();
let newest = 0n;
const stream = new FlashblockStream(config.flashblocksUrl!, (frame) => {
  ledger.add(frame);
  if (frame.block > newest) newest = frame.block;
});
await stream.start(120_000);
// The first block may have started before the stream opened.
const firstWhole = (await untilAnswered(() => rpc.call<string>("eth_blockNumber", [])).then(BigInt)) + 2n;

const totals = { blocks: 0, skippedEmptyBlocks: 0, partialBlocks: 0, hashMatch: 0, vanished: 0, vanishedUser: 0, unseen: 0, orderMismatch: 0, multiPayload: 0, blocksWithUserTx: 0, userTransactions: 0, userBlocksHashMatch: 0, framesPerBlock: {} as Record<string, number>, hashChangedLater: 0, recheckedLater: 0, readFailures: 0 };
const pendingRecheck: Array<{ block: bigint; hash: Hex; dueAtBlock: bigint }> = [];
const samplesOfMismatch: unknown[] = [];

async function sealed(block: bigint) {
  return rpc.call<{ hash: Hex; transactions: Hex[] } | null>("eth_getBlockByNumber", [hex(block), false]);
}

function report(): void {
  writeFileSync(
    join(dir, "frame-drift-report.json"),
    JSON.stringify(
      {
        lane: "mainnet, read only",
        decoderAgainstRealSwaps: decoder,
        frames: stream.frames,
        reconnects: stream.reconnects,
        ...totals,
        vanishedUserWilson95PerUserTransaction: wilson(totals.vanishedUser, totals.userTransactions + totals.vanishedUser),
        hashMatchWilson95: wilson(totals.hashMatch, totals.blocks),
        samplesOfMismatch,
      },
      null,
      1,
    ),
  );
}

const endAt = Date.now() + Number(values.minutes) * 60_000;
let reportedAt = Date.now();
while (Date.now() < endAt) {
  await sleep(1_000);
  // Two blocks behind the stream, so the block has sealed on the RPC too.
  for (const seen of ledger.takeUpTo(newest - 2n)) {
    if (seen.block < firstWhole) continue;
    // The public RPC has a rate limit. Every block a trade could react to is read, and one in five of the empty ones.
    const worthReading = seen.transactions.length > seen.deposits.size || seen.payloadIds.size > 1 || seen.block % 5n === 0n;
    if (!worthReading) {
      totals.skippedEmptyBlocks++;
      continue;
    }
    try {
      const block = await sealed(seen.block);
      if (!block) {
        totals.readFailures++;
        continue;
      }
      const drift = compareBlock(seen, block);
      totals.blocks++;
      totals.framesPerBlock[seen.frames] = (totals.framesPerBlock[seen.frames] ?? 0) + 1;
      if (!seen.indexes.has(0)) totals.partialBlocks++;
      if (drift.hashMatch) totals.hashMatch++;
      totals.vanished += drift.vanished;
      totals.vanishedUser += drift.vanishedUser.length;
      totals.unseen += drift.unseen;
      if (!drift.orderMatch) totals.orderMismatch++;
      if (drift.payloads > 1) totals.multiPayload++;
      if (drift.userTransactions > 0) {
        totals.blocksWithUserTx++;
        totals.userTransactions += drift.userTransactions;
        if (drift.hashMatch) totals.userBlocksHashMatch++;
      }
      if (!drift.hashMatch || drift.vanished || drift.unseen || !drift.orderMatch || drift.payloads > 1) {
        log.append({ ...drift, sealedHash: block.hash, frameHash: seen.lastHash, indexes: [...seen.indexes] });
        if (samplesOfMismatch.length < 20) samplesOfMismatch.push({ block: seen.block.toString(), frames: seen.frames, hashMatch: drift.hashMatch, vanished: drift.vanished, vanishedUser: drift.vanishedUser, unseen: drift.unseen, payloads: drift.payloads });
      }
      pendingRecheck.push({ block: seen.block, hash: block.hash, dueAtBlock: seen.block + 60n });
    } catch {
      totals.readFailures++;
    }
  }
  // Sealed once is not the end: read each block again about two minutes later.
  while (pendingRecheck.length && pendingRecheck[0]!.dueAtBlock <= newest) {
    const due = pendingRecheck.shift()!;
    try {
      const again = await sealed(due.block);
      totals.recheckedLater++;
      if (again?.hash !== due.hash) totals.hashChangedLater++;
    } catch {
      totals.readFailures++;
    }
  }
  if (Date.now() - reportedAt > 30_000) {
    report();
    reportedAt = Date.now();
  }
}
report();
stream.close();
rpc.close();
process.exit(0);
