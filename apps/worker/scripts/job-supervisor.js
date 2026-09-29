import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import process from "node:process";

const [contractPath, outputPath] = process.argv.slice(2);
if (!contractPath || !outputPath) throw new Error("usage: job-supervisor.js <contract> <output-dir>");
const child = spawn(process.execPath, ["apps/worker/scripts/execute-job.js", contractPath, outputPath], { stdio: "inherit" });
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; child.kill(signal); });
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve(signal ? 1 : code ?? 1));
});
await writeFile("/output/.worker-exit-code", `${exitCode}\n`, { flag: "wx" });
process.stdout.write(`worker process finished (${exitCode}); waiting for artifact collection\n`);
if (!interrupted) await new Promise((resolve) => {
  const timer = setInterval(() => {
    void access("/output/.parent-collected").then(() => { clearInterval(timer); resolve(); }).catch(() => {});
  }, 100);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { clearInterval(timer); resolve(); });
});
process.exitCode = exitCode;
