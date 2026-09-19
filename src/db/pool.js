// ---------------------------------------------------------------------------
// Postgres pool + PGlite adapter (spec §3.1)
// ---------------------------------------------------------------------------
//
// The whole point of this module is that a database failure is a /v2 problem and
// nothing more: nothing here calls process.exit, and the `ready` flag is the only
// thing routes consult. src/vakt.js owns the retry loop.

/// Slice 1 runs on Railway Postgres. pglite: is for local dev and tests only —
/// DATABASE_URL=pglite:memory or pglite:<dir>.
export function dbTargetOf(databaseUrl) {
  const url = typeof databaseUrl === "string" ? databaseUrl.trim() : "";
  if (!url) return { kind: "none" };
  if (url.startsWith("pglite:")) {
    const rest = url.slice("pglite:".length);
    return { kind: "pglite", dir: rest === "memory" || rest === "" ? null : rest };
  }
  return { kind: "pg", connectionString: url };
}

/// A pg-shaped wrapper over PGlite so migrate.js and the routes never branch.
/// PGlite is a single connection, so connect() hands back the same handle; that is
/// fine for one developer and for tests, and it is refused in production below.
async function createPgliteAdapter(target) {
  const { PGlite } = await import("@electric-sql/pglite");
  const client = target.dir ? await PGlite.create(target.dir) : await PGlite.create();

  const run = async (text, params) => {
    // PGlite's query() is the extended protocol (one statement, real parameters);
    // exec() is the simple protocol, which is what multi-statement migration files need.
    const result = params && params.length
      ? await client.query(text, params)
      : (await client.exec(text)).at(-1) ?? { rows: [] };
    const rows = result.rows ?? [];
    return { rows, rowCount: rows.length || result.affectedRows || 0, fields: result.fields ?? [] };
  };

  return {
    query: run,
    connect: async () => ({ query: run, release() {} }),
    end: () => client.close(),
  };
}

async function createPgPool(target, config) {
  const pg = (await import("pg")).default;
  // A DATE is a calendar day, not an instant. node-pg's default turns it into a
  // JS Date at the host's local midnight, which shifts the day whenever the
  // container's TZ is not UTC. Keep it as the 'YYYY-MM-DD' string it already is.
  pg.types.setTypeParser(1082, (v) => v);
  return new pg.Pool({
    connectionString: target.connectionString,
    // Never put sslmode= in the URL (§3.1); the private Railway network needs no TLS.
    ssl: config.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

/// The object routes and jobs are given. `ready` flips to true only once the pool
/// answers and every migration has applied, so a half-migrated schema is never served.
export function createDb(config) {
  const target = dbTargetOf(config.DATABASE_URL);
  const db = {
    kind: target.kind,
    network: config.dbNetwork,
    ready: false,
    lastError: null,
    pool: null,

    get status() {
      return db.ready ? "ready" : "unavailable";
    },

    async query(text, params) {
      if (!db.pool) throw Object.assign(new Error("db not initialised"), { code: "db_unavailable" });
      return db.pool.query(text, params);
    },

    async withTx(fn) {
      if (!db.pool) throw Object.assign(new Error("db not initialised"), { code: "db_unavailable" });
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async end() {
      const pool = db.pool;
      db.pool = null;
      db.ready = false;
      if (pool) await pool.end();
    },
  };
  return db;
}

/// Builds the pool and proves it answers. Throws on failure; the caller retries.
export async function initPool(db, config) {
  const target = dbTargetOf(config.DATABASE_URL);
  if (target.kind === "none") throw Object.assign(new Error("DATABASE_URL is not set"), { code: "db_not_configured" });
  if (target.kind === "pglite" && config.isProduction) {
    throw Object.assign(new Error("pglite: is refused in production"), { code: "db_not_configured" });
  }
  db.pool = target.kind === "pglite" ? await createPgliteAdapter(target) : await createPgPool(target, config);
  db.kind = target.kind;
  await db.pool.query("SELECT 1");
  return db.pool;
}
