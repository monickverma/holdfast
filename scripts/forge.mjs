// Runs the Foundry binary in tools/foundry when present, otherwise `forge` from PATH.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = fileURLToPath(new URL("../tools/foundry/forge.exe", import.meta.url));
const result = spawnSync(existsSync(local) ? local : "forge", process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
