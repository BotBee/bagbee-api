// ---------------------------------------------------------------------------
// Migration runner (spec §3.2) — runs at boot, after listen
// ---------------------------------------------------------------------------
//
// Files live in migrations/NNN_snake_name.sql and are applied in lexical order,
// each in its own transaction, under a session advisory lock so two overlapping
// Railway deploys cannot apply the same file twice.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK_ID = 823471001;

export async function migrate(pool, dir) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const done = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    const applied = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);                       // simple-query protocol: multi-statement OK
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
        console.log(`[migrate] applied ${f}`);
      } catch (err) { await client.query("ROLLBACK"); throw err; }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
}

export default migrate;
