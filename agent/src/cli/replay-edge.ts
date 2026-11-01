// Replays the recorded shadow prices through the live agent's trading rules. Read only: it opens one file.
//   npm run replay:edge -- --samples evidence/shadow/shadow-samples.jsonl
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { replayEdgeFills, type ShadowSample } from "../shadow.js";

const { values } = parseArgs({ options: { samples: { type: "string", default: "evidence/shadow/shadow-samples.jsonl" } } });
const samples = readFileSync(values.samples!, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as ShadowSample);
const sizes = [...new Set(samples.flatMap((s) => s.quotes.map((q) => q.sizeUsdt)))].sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      lane: "mainnet read only, replayed. Fills are simulated.",
      n: samples.length,
      note: "Buy side with no outside fee, the best case. Every unprofitable sample counts as closing the gap, so the once-per-opportunity count is an upper bound: the live rule also needs a fresh mark to reopen. Inventory is what the live agent would be left holding, because it has no code to close the other leg.",
      rows: sizes.map((size) => replayEdgeFills(samples, size)),
    },
    null,
    2,
  ),
);
