// Spec §4.3 / §10.1 — rotation, the 60-minute grace and reuse detection, against
// a real Postgres (PGlite). The SQL is the whole feature here, so nothing is faked.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createDb, initPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import {
  createSession,
  hashRefresh,
  isPlausibleRefreshToken,
  newRefreshToken,
  revokeAllForStaff,
  revokeSession,
  rotateSession,
} from "../src/auth/refresh.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const QUIET = { log() {}, warn() {}, error() {} };

async function setup() {
  const config = loadConfig({ DATABASE_URL: "pglite:memory" });
  const db = createDb(config);
  await initPool(db, config);
  await migrate(db.pool, MIGRATIONS_DIR);
  db.ready = true;

  const { rows: [staff] } = await db.query(
    `INSERT INTO staff (airtable_record_id, name, login_email, airtable_status)
     VALUES ('recLCxvPg6oAKUfDp', 'Rúnar', 'runa@example.is', 'Active') RETURNING id`,
  );
  const { rows: [device] } = await db.query(
    "INSERT INTO devices (installation_id, staff_id) VALUES ($1, $2) RETURNING id",
    [crypto.randomUUID(), staff.id],
  );

  /// Mints a session and hands back the live refresh token, the way verify-code does.
  async function newSession() {
    const token = newRefreshToken();
    const row = await db.withTx((tx) =>
      createSession(tx, { staffId: staff.id, deviceId: device.id, refreshHash: hashRefresh(token), ip: null, userAgent: null }),
    );
    return { token, sessionId: row.id, expiresAt: row.expires_at };
  }

  const rotate = (token) => rotateSession(db, hashRefresh(token), hashRefresh(newRefreshToken()), { log: QUIET });
  const sessionRow = async (id) => (await db.query("SELECT * FROM sessions WHERE id = $1", [id])).rows[0];
  const deviceRow = async () => (await db.query("SELECT * FROM devices WHERE id = $1", [device.id])).rows[0];

  return { db, config, staffId: staff.id, deviceId: device.id, newSession, rotate, sessionRow, deviceRow };
}

/// Pushes the last rotation into the past so the 60-minute grace has closed.
const ageLastRefresh = (db, sessionId, minutes) =>
  db.query(`UPDATE sessions SET last_refreshed_at = now() - ($2 || ' minutes')::interval WHERE id = $1`, [sessionId, String(minutes)]);

test("token format", () => {
  const token = newRefreshToken();
  assert.match(token, /^bbr_[A-Za-z0-9_-]{43}$/);
  assert.ok(isPlausibleRefreshToken(token));
  assert.ok(!isPlausibleRefreshToken("bbr_"));
  assert.ok(!isPlausibleRefreshToken("nope"));
  assert.ok(!isPlausibleRefreshToken(`bbr_${"x".repeat(300)}`));
  assert.ok(!isPlausibleRefreshToken(undefined));
  assert.match(hashRefresh(token), /^[0-9a-f]{64}$/);
});

test("(a) the current token rotates, and the raw token is never stored", async () => {
  const t = await setup();
  const { token, sessionId } = await t.newSession();
  const next = newRefreshToken();

  const result = await rotateSession(t.db, hashRefresh(token), hashRefresh(next), { log: QUIET });
  assert.equal(result.outcome, "rotated");
  assert.equal(result.viaGrace, false);
  assert.equal(result.session.id, sessionId);

  const row = await t.sessionRow(sessionId);
  assert.equal(row.refresh_hash, hashRefresh(next));
  assert.equal(row.prev_refresh_hash, hashRefresh(token));
  assert.equal(row.superseded_refresh_hash, null);
  // Nothing anywhere in the row equals the token itself.
  assert.ok(!JSON.stringify(row).includes(token));
  await t.db.end();
});

test("(b) the previous token works once inside the 60-min grace, and cannot be replayed", async () => {
  const t = await setup();
  const { token, sessionId } = await t.newSession();
  const second = newRefreshToken();
  await rotateSession(t.db, hashRefresh(token), hashRefresh(second), { log: QUIET });

  // The client never received `second` — a lost response on a van's network.
  const third = newRefreshToken();
  const grace = await rotateSession(t.db, hashRefresh(token), hashRefresh(third), { log: QUIET });
  assert.equal(grace.outcome, "rotated");
  assert.equal(grace.viaGrace, true);

  const row = await t.sessionRow(sessionId);
  assert.equal(row.refresh_hash, hashRefresh(third));
  assert.equal(row.prev_refresh_hash, null, "the grace token must not be replayable");
  assert.equal(row.superseded_refresh_hash, hashRefresh(second));

  // The same previous token a third time is now in none of the three columns, so
  // it is the "older than previous/superseded" case §4.3 accepts: a plain 401 with
  // no revocation. (§10.1's table says "reuse" here; that is not reachable with the
  // §4.3 SQL, which spends the one spare column on catching a thief-first refresh —
  // see the B3 note in §13.)
  const again = await t.rotate(token);
  assert.equal(again.outcome, "unknown");
  assert.equal((await t.sessionRow(sessionId)).revoked_at, null);

  // The discarded current token IS remembered, and presenting it is reuse: in the
  // lost-response case nobody holds it, so a second party must.
  const stolen = await t.rotate(second);
  assert.equal(stolen.outcome, "reuse");
  assert.deepEqual(stolen.revokedSessionIds, [sessionId]);
  const revoked = await t.sessionRow(sessionId);
  assert.equal(revoked.revoked_reason, "refresh_reuse");
  assert.ok(revoked.revoked_at);
  await t.db.end();
});

test("the previous token AFTER the grace is reuse, and unlinks the device", async () => {
  const t = await setup();
  const { token, sessionId } = await t.newSession();
  await t.rotate(token);
  await ageLastRefresh(t.db, sessionId, 61);

  const late = await t.rotate(token);
  assert.equal(late.outcome, "reuse");
  const row = await t.sessionRow(sessionId);
  assert.equal(row.revoked_reason, "refresh_reuse");
  const device = await t.deviceRow();
  assert.equal(device.staff_id, null);
  assert.equal(device.invalidated_reason, "refresh_reuse");
  assert.ok(device.invalidated_at);
  await t.db.end();
});

test("59 minutes is still inside the grace", async () => {
  const t = await setup();
  const { token, sessionId } = await t.newSession();
  await t.rotate(token);
  await ageLastRefresh(t.db, sessionId, 59);
  assert.equal((await t.rotate(token)).outcome, "rotated");
  await t.db.end();
});

test("thief-first: the real user's refresh discards the thief's token, which is then caught", async () => {
  const t = await setup();
  const { token, sessionId } = await t.newSession();

  // The thief has a copy and refreshes first; the response is theirs.
  const thiefToken = newRefreshToken();
  assert.equal((await rotateSession(t.db, hashRefresh(token), hashRefresh(thiefToken), { log: QUIET })).outcome, "rotated");

  // The real user refreshes with what they still hold: the grace path (b), which
  // throws the thief's token into superseded_refresh_hash.
  const userToken = newRefreshToken();
  const user = await rotateSession(t.db, hashRefresh(token), hashRefresh(userToken), { log: QUIET });
  assert.equal(user.outcome, "rotated");
  assert.equal(user.viaGrace, true);

  // The thief comes back. Both parties are signed out and the device is unlinked.
  const thief = await t.rotate(thiefToken);
  assert.equal(thief.outcome, "reuse");
  assert.equal((await t.sessionRow(sessionId)).revoked_reason, "refresh_reuse");
  assert.equal((await t.deviceRow()).staff_id, null);
  await t.db.end();
});

test("every live session on the device dies with the reused one", async () => {
  const t = await setup();
  const a = await t.newSession();
  const b = await t.newSession();
  await t.rotate(a.token);
  await ageLastRefresh(t.db, a.sessionId, 61);

  const result = await t.rotate(a.token);
  assert.equal(result.outcome, "reuse");
  assert.equal(result.revokedSessionIds.length, 2);
  assert.equal((await t.sessionRow(a.sessionId)).revoked_reason, "refresh_reuse");
  assert.equal((await t.sessionRow(b.sessionId)).revoked_reason, "refresh_reuse");
  await t.db.end();
});

test("a revoked or expired session cannot rotate, and revokes nothing", async () => {
  const t = await setup();
  const revoked = await t.newSession();
  await revokeSession(t.db, revoked.sessionId, t.deviceId, "logout");
  assert.equal((await t.rotate(revoked.token)).outcome, "unknown");

  const expired = await t.newSession();
  await t.db.query("UPDATE sessions SET expires_at = now() - interval '1 day' WHERE id = $1", [expired.sessionId]);
  assert.equal((await t.rotate(expired.token)).outcome, "unknown");
  await t.db.end();
});

test("an unknown token is a plain 401 case: nothing is revoked", async () => {
  const t = await setup();
  const { sessionId } = await t.newSession();
  assert.equal((await t.rotate(newRefreshToken())).outcome, "unknown");
  assert.equal((await t.sessionRow(sessionId)).revoked_at, null);
  await t.db.end();
});

test("expiry slides forward 180 days on every rotation", async () => {
  const t = await setup();
  const { token, sessionId } = await t.newSession();
  await t.db.query("UPDATE sessions SET expires_at = now() + interval '3 days' WHERE id = $1", [sessionId]);

  const result = await t.rotate(token);
  assert.equal(result.outcome, "rotated");
  const days = (new Date(result.session.expires_at).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 179.9 && days < 180.1, `expected ~180 days, got ${days}`);
  await t.db.end();
});

test("revokeAllForStaff revokes live sessions, unlinks every device, and is idempotent", async () => {
  const t = await setup();
  const a = await t.newSession();
  const b = await t.newSession();
  await revokeSession(t.db, b.sessionId, null, "logout");

  const ids = await revokeAllForStaff(t.db, t.staffId, "staff_inactive");
  assert.deepEqual(ids, [a.sessionId]);
  assert.equal((await t.sessionRow(a.sessionId)).revoked_reason, "staff_inactive");
  // An already-revoked session keeps its original reason.
  assert.equal((await t.sessionRow(b.sessionId)).revoked_reason, "logout");
  const device = await t.deviceRow();
  assert.equal(device.staff_id, null);
  assert.equal(device.invalidated_reason, "staff_inactive");

  assert.deepEqual(await revokeAllForStaff(t.db, t.staffId, "staff_inactive"), []);
  await t.db.end();
});

test("logout revokes one session and unlinks only that device", async () => {
  const t = await setup();
  const { sessionId } = await t.newSession();
  assert.equal(await revokeSession(t.db, sessionId, t.deviceId, "logout"), 1);
  assert.equal((await t.sessionRow(sessionId)).revoked_reason, "logout");
  assert.equal((await t.deviceRow()).invalidated_reason, "logout");
  // A second logout changes nothing.
  assert.equal(await revokeSession(t.db, sessionId, t.deviceId, "logout"), 0);
  await t.db.end();
});
