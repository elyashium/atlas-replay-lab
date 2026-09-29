import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const controlPlaneDir = path.dirname(fileURLToPath(import.meta.url));

/** Load the package's ignored local .env without replacing shell-provided values. */
export function loadLocalEnv({ env = process.env, envPath = path.resolve(controlPlaneDir, "../.env") } = {}) {
  if (!existsSync(envPath)) return false;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || env[match[1]] !== undefined) continue;
    env[match[1]] = match[2].replace(/^("|')(.*)\1$/, "$2");
  }
  return true;
}
