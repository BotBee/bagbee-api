// Spec §4.4 — the shape of GET /v2/health and GET /v2/app-config.
// No network: a fake APNs probe, a PGlite database, and the router mounted the
// way index.js mounts it.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig } from "../src/config.js";
import { createDb, initPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createV2Router } from "../src/routes/v2.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const LONG = "x".repeat(32);

async function serve({ envOver = {}, apnsStatus = "configured", withDb = true } = {}) {
  const config = loadConfig({
    DATABASE_URL: "pglite:memory",
    STAFF_JWT_SECRET: LONG,
    OTP_HMAC_SECRET: LONG,
    VAKT_INTERNAL_SECRET: LONG,
    RESEND_OTP_API_KEY: "re_test",
    OPTIMOROUTE_API_KEY: "or_test",
    PUSH_MODE: "pilot",
    VAKT_SHELL: "on",
    ...envOver,
  });
  const db = createDb(config);
  if (withDb) {
    await initPool(db, config);
    await migrate(db.pool, MIGRATIONS_DIR);
    db.ready = true;
  }
  const app = express();
  app.use("/v2", express.json({ limit: "32kb" }));
  app.use("/v2", createV2Router({ db, config, apns: () => ({ status: apnsStatus, client: null }) }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  return {
    db,
    config,
    get: (p) => fetch(`http://127.0.0.1:${port}${p}`),
    close: async () => {
      await new Promise((r) => server.close(r));
      if (withDb) await db.end();
    },
  };
}

test("GET /v2/health reports what is configured, never a value", async (t) => {
  const s = await serve();
  t.after(() => s.close());

  const res = await s.get("/v2/health");
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(Object.keys(body), [
    "ok", "db", "dbNetwork", "worker", "apns", "mail", "mailLast", "optimo", "auth", "internal", "pushMode",
  ]);
  assert.equal(body.ok, true);
  assert.equal(body.db, "ready");
  assert.equal(body.dbNetwork, "pglite");
  assert.deepEqual(body.worker, { enabled: true, planDetect: { lastFinishedAt: null, lastStatus: null } });
  assert.equal(body.apns, "configured");
  assert.equal(body.mail, "configured");
  assert.equal(body.optimo, "configured");
  assert.equal(body.auth, "configured");
  assert.equal(body.internal, "configured");
  assert.equal(body.pushMode, "pilot");

  // No secret, URL or host may appear anywhere in the response.
  const raw = JSON.stringify(body);
  for (const leak of [LONG, "re_test", "or_test", "pglite:memory"]) {
    assert.ok(!raw.includes(leak), `health leaked ${leak}`);
  }
});

test("GET /v2/health reports the plan-detect job run with second-precision timestamps", async (t) => {
  const s = await serve();
  t.after(() => s.close());

  await s.db.query(
    `INSERT INTO job_runs (job, last_started_at, last_finished_at, last_status)
     VALUES ('plan-detect', '2026-09-16T17:05:00Z', '2026-09-16T17:05:04.512Z', 'ok')`,
  );
  const body = await (await s.get("/v2/health")).json();
  assert.equal(body.worker.planDetect.lastStatus, "ok");
  // Swift's .iso8601 decoder rejects fractional seconds (§4.2).
  assert.equal(body.worker.planDetect.lastFinishedAt, "2026-09-16T17:05:04Z");
});

test("GET /v2/health stays 200 while the database is down", async (t) => {
  const s = await serve({ withDb: false, apnsStatus: "invalid", envOver: { RESEND_OTP_API_KEY: "", OPTIMOROUTE_API_KEY: "", VAKT_INTERNAL_SECRET: "", PUSH_MODE: "off", WORKER_ENABLED: "0" } });
  t.after(() => s.close());

  const res = await s.get("/v2/health");
  assert.equal(res.status, 200, "health must answer even when Postgres is unreachable");
  const body = await res.json();
  assert.equal(body.db, "unavailable");
  assert.equal(body.worker.planDetect, null);
  assert.equal(body.worker.enabled, false);
  assert.equal(body.apns, "invalid");
  assert.equal(body.mail, "missing");
  assert.equal(body.optimo, "missing");
  assert.equal(body.internal, "off");
  assert.equal(body.pushMode, "off");
});

test("GET /v2/app-config serves the shell flags and needs no database", async (t) => {
  const s = await serve({ withDb: false, envOver: { VAKT_SHELL: "on", PLAN_SLOT_SPLIT: "15:30" } });
  t.after(() => s.close());

  const res = await s.get("/v2/app-config");
  assert.equal(res.status, 200, "a Postgres outage must not pin devices to the cached shell mode");
  assert.deepEqual(await res.json(), { vaktShell: "on", minAppBuild: 41, planSlotSplit: "15:30" });
});

test("an unknown /v2 path answers in the /v2 error shape", async (t) => {
  const s = await serve({ withDb: false });
  t.after(() => s.close());

  const res = await s.get("/v2/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});
