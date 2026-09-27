import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, inTransaction } from "./db.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const pool = createPool();
try {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const version = "001_initial";
  const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
  if (applied.rowCount) {
    console.log(`${version} already applied`);
  } else {
    const sql = await readFile(path.join(root, "../migrations", `${version}.sql`), "utf8");
    await inTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
    });
    console.log(`applied ${version}`);
  }
} finally {
  await pool.end();
}
