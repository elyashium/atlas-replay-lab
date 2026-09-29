import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, inTransaction } from "./db.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const pool = createPool();
try {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const migrationsDir = path.join(root, "../migrations");
  const migrations = (await readdir(migrationsDir))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  for (const file of migrations) {
    const version = file.slice(0, -4);
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const didApply = await inTransaction(pool, async (client) => {
      // Startup deploys may race. Serialize migration application and recheck
      // the ledger while holding the transaction-scoped lock.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [7410292026]);
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (applied.rowCount) return false;
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
      return true;
    });
    if (!didApply) {
      console.log(`${version} already applied`);
      continue;
    }
    console.log(`applied ${version}`);
  }
} finally {
  await pool.end();
}
