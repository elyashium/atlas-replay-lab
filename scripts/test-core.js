import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep the offline CLI suite explicit. New packages own their tests and deps.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = await readdir(path.join(root, "tests"), { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join("tests", entry.name));
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
