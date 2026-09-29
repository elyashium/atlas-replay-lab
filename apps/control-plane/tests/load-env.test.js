import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadLocalEnv } from "../src/load-env.js";

test("local env loading preserves shell overrides and parses simple quoted values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "atlas-env-test-"));
  const envPath = path.join(directory, ".env");
  const env = { SHELL_WINS: "from-shell" };
  try {
    await writeFile(envPath, "# comment\nFROM_FILE=local-value\nSHELL_WINS=file-value\nQUOTED=\"quoted value\"\n");
    assert.equal(loadLocalEnv({ env, envPath }), true);
    assert.deepEqual(env, { SHELL_WINS: "from-shell", FROM_FILE: "local-value", QUOTED: "quoted value" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing local env is optional", () => {
  assert.equal(loadLocalEnv({ env: {}, envPath: path.join(os.tmpdir(), `atlas-env-missing-${process.pid}`) }), false);
});
