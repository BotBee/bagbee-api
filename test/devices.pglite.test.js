// Spec §4.5 — POST /v2/me/devices and /v2/me/devices/test-push over HTTP, the way
// index.js mounts them. requireStaff is B3, so a fake one stands in; everything
// below it (validation, the token-moved rule, the rate limits) is the real code.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig } from "../src/config.js";
import { createDb, initPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createV2Router } from "../src/routes/v2.js";
import { createSender } from "../src/push/sender.js";
import { createThrottle } from "../src/auth/throttle.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const LONG = "x".repeat(32);
const AT_RUNAR = "recLCxvPg6oAKUfDp";
const TOKEN_A = "a1b2".repeat(16);              // 64 lowercase hex
const TOKEN_B = "f9e8".repeat(16);
const QUIET = { log() {}, error() {} };

async function serve({ envOver = {}, apnsStatus = "configured" } = {}) {
  const config = loadConfig({
    DATABASE_URL: "pglite:memory",
    STAFF_JWT_SECRET: LONG,
    OTP_HMAC_SECRET: LONG,
    PUSH_MODE: "off",
    ...envOver,
  });
  const db = createDb(config);
  await initPool(db, config);
  await migrate(db.pool, MIGRATIONS_DIR);
  db.ready = true;

  const { rows: [staff] } = await db.query(
    `INSERT INTO staff (airtable_record_id, name, login_email, airtable_status)
     VALUES ($1, 'Rúnar', 'runa@example.is', 'Active') RETURNING id`,
    [AT_RUNAR],
  );
  const installationId = crypto.randomUUID();
  const { rows: [device] } = await db.query(
    "INSERT INTO devices (installation_id, staff_id) VALUES ($1, $2) RETURNING id",
    [installationId, staff.id],
  );
  const { rows: [session] } = await db.query(
    `INSERT INTO sessions (staff_id, device_id, refresh_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '180 days') RETURNING id`,
    [staff.id, device.id, crypto.randomBytes(16).toString("hex")],
  );

  const sends = [];
  const apns = () => ({
    status: apnsStatus,
    client: { async send(msg) { sends.push(msg); return { status: 200, apnsId: crypto.randomUUID() }; } },
  });

  const app = express();
  app.use("/v2", express.json({ limit: "32kb" }));
  app.use("/v2", createV2Router({
    db, config, apns,
    sender: createSender({ db, config, apns, log: QUIET }),
    hit: createThrottle(db),
    /// Stands in for B3's requireStaff: the same req.staff shape (§4.3).
    requireStaff: (req, res, next) => {
      req.staff = { id: staff.id, sessionId: session.id, deviceId: device.id, airtableId: AT_RUNAR, teams: ["Office"], role: "owner" };
      next();
    },
  }));

  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

  return {
    db, post, sends, staffId: staff.id, deviceId: device.id, installationId,
    deviceRow: async () => (await db.query("SELECT * FROM devices WHERE id = $1", [device.id])).rows[0],
    close: async () => { await new Promise((r) => server.close(r)); await db.end(); },
  };
}

const registration = (installationId, over = {}) => ({
  installationId,
  apnsToken: TOKEN_A,
  apnsEnvironment: "production",
  pushAuthorization: "authorized",
  timeSensitiveSetting: "enabled",
  appVersion: "1.0",
  appBuild: 41,
  osVersion: "26.4",
  model: "iPhone17,1",
  ...over,
});

test("registering a token records it and stamps apns_token_updated_at", async (t) => {
  const s = await serve();
  t.after(() => s.close());

  const res = await s.post("/v2/me/devices", registration(s.installationId));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deviceId: s.deviceId });

  const row = await s.deviceRow();
  assert.equal(row.apns_token, TOKEN_A);
  assert.equal(row.apns_environment, "production");
  assert.equal(row.push_authorization, "authorized");
  assert.equal(row.time_sensitive_setting, "enabled");
  assert.equal(row.app_build, 41);
  assert.equal(row.model, "iPhone17,1");
  assert.ok(row.apns_token_updated_at, "the 410 rule compares against this timestamp");
});

test("re-posting the same token does not move apns_token_updated_at", async (t) => {
  const s = await serve();
  t.after(() => s.close());

  await s.post("/v2/me/devices", registration(s.installationId));
  const first = (await s.deviceRow()).apns_token_updated_at;
  await new Promise((r) => setTimeout(r, 20));
  await s.post("/v2/me/devices", registration(s.installationId, { timeSensitiveSetting: "disabled" }));

  const row = await s.deviceRow();
  // The app re-posts on every foreground; a moving timestamp would make every
  // genuine 410 look like a token we had just re-registered (§7).
  assert.equal(row.apns_token_updated_at.getTime(), first.getTime());
  assert.equal(row.time_sensitive_setting, "disabled");
});

test("a new token moves the timestamp and takes the token off any other device", async (t) => {
  const s = await serve();
  t.after(() => s.close());

  // Another phone row already holds TOKEN_B — the same physical device handed on,
  // or an installation restored from a backup.
  const { rows: [other] } = await s.db.query(
    `INSERT INTO devices (installation_id, apns_token, apns_environment, apns_token_updated_at)
     VALUES ($1, $2, 'production', now()) RETURNING id`,
    [crypto.randomUUID(), TOKEN_B],
  );

  await s.post("/v2/me/devices", registration(s.installationId));
  const before = (await s.deviceRow()).apns_token_updated_at;
  await new Promise((r) => setTimeout(r, 20));
  const res = await s.post("/v2/me/devices", registration(s.installationId, { apnsToken: TOKEN_B }));
  assert.equal(res.status, 200);

  const row = await s.deviceRow();
  assert.equal(row.apns_token, TOKEN_B);
  assert.ok(row.apns_token_updated_at.getTime() > before.getTime());

  const { rows: [stale] } = await s.db.query("SELECT invalidated_reason FROM devices WHERE id = $1", [other.id]);
  assert.equal(stale.invalidated_reason, "token_moved", "two live rows with one token would double-send");
});

test("registering again clears an earlier invalidation", async (t) => {
  const s = await serve();
  t.after(() => s.close());
  await s.db.query(
    "UPDATE devices SET invalidated_at = now(), invalidated_reason = 'apns_410' WHERE id = $1",
    [s.deviceId],
  );

  await s.post("/v2/me/devices", registration(s.installationId));
  const row = await s.deviceRow();
  assert.equal(row.invalidated_at, null);
  assert.equal(row.invalidated_reason, null);
});

test("a different installationId is a 409, never a token move", async (t) => {
  const s = await serve();
  t.after(() => s.close());
  const res = await s.post("/v2/me/devices", registration(crypto.randomUUID()));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "device_mismatch" });
  assert.equal((await s.deviceRow()).apns_token, null);
});

test("malformed tokens and environments are refused", async (t) => {
  const s = await serve();
  t.after(() => s.close());

  const bad = [
    { apnsToken: TOKEN_A.toUpperCase() },              // the CHECK constraint is lowercase-only
    { apnsToken: "abc" },                              // too short
    { apnsToken: `${TOKEN_A}zz` },                     // not hex
    { apnsEnvironment: "development" },                // not production|sandbox
    { apnsToken: TOKEN_A, apnsEnvironment: undefined },// a token we could never send to
    { installationId: "not-a-uuid" },
  ];
  for (const over of bad) {
    const res = await s.post("/v2/me/devices", registration(s.installationId, over));
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.deepEqual(await res.json(), { error: "invalid_request" });
  }
  assert.equal((await s.deviceRow()).apns_token, null);
});

test("permission denied: no token is still recorded", async (t) => {
  const s = await serve();
  t.after(() => s.close());
  const res = await s.post("/v2/me/devices", registration(s.installationId, {
    apnsToken: null, apnsEnvironment: undefined, pushAuthorization: "denied", timeSensitiveSetting: "notSupported",
  }));
  assert.equal(res.status, 200);

  const row = await s.deviceRow();
  assert.equal(row.apns_token, null);
  assert.equal(row.push_authorization, "denied");
  assert.equal(row.app_build, 41);
});

test("an unknown iOS enum value is stored as NULL, not rejected", async (t) => {
  const s = await serve();
  t.after(() => s.close());
  // A future iOS authorization case must never cost us a working APNs token.
  const res = await s.post("/v2/me/devices", registration(s.installationId, { pushAuthorization: "someFutureCase" }));
  assert.equal(res.status, 200);

  const row = await s.deviceRow();
  assert.equal(row.push_authorization, null);
  assert.equal(row.apns_token, TOKEN_A);
});

test("test-push sends to the caller's own device and is capped at 5/h", async (t) => {
  const s = await serve();
  t.after(() => s.close());
  await s.post("/v2/me/devices", registration(s.installationId));

  const res = await s.post("/v2/me/devices/test-push");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { results: [{ deviceId: s.deviceId, status: "sent", apnsReason: null }] });
  // PUSH_MODE is "off" in this fixture: the button must still work (P3).
  assert.equal(s.sends.length, 1);
  assert.equal(s.sends[0].payload.aps.alert.title, "Prufa");

  for (let i = 0; i < 4; i += 1) assert.equal((await s.post("/v2/me/devices/test-push")).status, 200);
  const limited = await s.post("/v2/me/devices/test-push");
  assert.equal(limited.status, 429);
  assert.deepEqual(Object.keys(await limited.clone().json()).sort(), ["error", "retryAfterSeconds"]);
  assert.equal((await limited.json()).error, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(s.sends.length, 5);
});

test("device registration is capped at 60/h", async (t) => {
  const s = await serve();
  t.after(() => s.close());
  for (let i = 0; i < 60; i += 1) {
    assert.equal((await s.post("/v2/me/devices", registration(s.installationId))).status, 200);
  }
  const limited = await s.post("/v2/me/devices", registration(s.installationId));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "rate_limited");
});

test("/v2/me/devices stays a 404 until B3 supplies requireStaff", async (t) => {
  const config = loadConfig({ DATABASE_URL: "pglite:memory", STAFF_JWT_SECRET: LONG, OTP_HMAC_SECRET: LONG });
  const db = createDb(config);
  const app = express();
  app.use("/v2", express.json({ limit: "32kb" }));
  // No requireStaff, no sender: exactly what src/vakt.js wires today.
  app.use("/v2", createV2Router({ db, config, apns: () => ({ status: "missing", client: null }) }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/v2/me/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  // Never an unauthenticated 200 — the routes simply do not exist yet.
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});
