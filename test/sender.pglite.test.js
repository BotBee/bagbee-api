// Spec §10.1 test/sender.pglite.test.js — push_log idempotency, the skip-key
// rules, and every APNs failure in the §7 table. A fake APNs client; PGlite for
// the database (§10.2). No network.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createDb, initPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createSender, createRunState } from "../src/push/sender.js";
import { planPushPayload, collapseIdFor } from "../src/push/payloads.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const AT_RUNAR = "recLCxvPg6oAKUfDp";
const AT_MATAS = "recusZGetZKMa2ItP";
const REF = "vakt_recAbcdefghij1234";
const QUIET = { log() {}, error() {} };

async function freshDb() {
  const config = loadConfig({ DATABASE_URL: "pglite:memory" });
  const db = createDb(config);
  await initPool(db, config);
  await migrate(db.pool, MIGRATIONS_DIR);
  db.ready = true;
  return db;
}

/// One staff member, one device, one session — the state a phone is in right
/// after verify-code + POST /v2/me/devices.
async function seedStaff(db, {
  airtableId, name = "Tester", token = null, environment = "production",
  tokenUpdatedAt = null, session = "live", withDevice = true,
}) {
  const { rows: [staff] } = await db.query(
    `INSERT INTO staff (airtable_record_id, name, login_email, airtable_status)
     VALUES ($1, $2, $3, 'Active') RETURNING id`,
    [airtableId, name, `${name.toLowerCase()}@example.is`],
  );
  if (!withDevice) return { staffId: staff.id, deviceId: null };

  const { rows: [device] } = await db.query(
    `INSERT INTO devices (installation_id, staff_id, apns_token, apns_environment, apns_token_updated_at, app_build)
     VALUES ($1, $2, $3, $4, $5, 41) RETURNING id`,
    [crypto.randomUUID(), staff.id, token ?? crypto.randomBytes(32).toString("hex"), environment, tokenUpdatedAt],
  );
  if (session !== "none") {
    await db.query(
      `INSERT INTO sessions (staff_id, device_id, refresh_hash, expires_at, revoked_at, revoked_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        staff.id, device.id, crypto.randomBytes(16).toString("hex"),
        session === "expired" ? new Date(Date.now() - 86_400_000) : new Date(Date.now() + 86_400_000),
        session === "revoked" ? new Date() : null,
        session === "revoked" ? "logout" : null,
      ],
    );
  }
  return { staffId: staff.id, deviceId: device.id };
}

/// Records every send and answers from a script keyed by device token.
function fakeApns({ status = "configured", reply = () => ({ status: 200 }) } = {}) {
  const sends = [];
  return {
    sends,
    get: () => ({
      status,
      client: {
        async send(msg) {
          sends.push(msg);
          return { apnsId: crypto.randomUUID(), timestamp: null, reason: null, ...reply(msg, sends.length) };
        },
      },
    }),
  };
}

function makeSender(db, envOver, apns, extra = {}) {
  const config = loadConfig({ DATABASE_URL: "pglite:memory", ...envOver });
  return {
    config,
    sender: createSender({ db, config, apns: apns.get, log: QUIET, ...extra }),
  };
}

const planArgs = (over = {}) => ({
  shiftRef: REF,
  planVersion: 3,
  baseKind: "plan_published",
  collapseId: collapseIdFor(REF),
  expiration: 1_790_000_000,
  buildPayload: ({ airtableStaffId, kind }) => planPushPayload({
    kind, shiftRef: REF, date: "2026-09-17", slot: "Morning", planVersion: 3,
    recipient: airtableStaffId, stopCount: 11, bagCount: 26, firstStopAt: "05:25",
  }),
  recipients: [{ airtableStaffId: AT_RUNAR, name: "Rúnar" }],
  triggeredBy: "job",
  ...over,
});

const keys = async (db) => (await db.query("SELECT dedupe_key, status, apns_reason, kind FROM push_log ORDER BY dedupe_key")).rows;

test("a send is claimed once: the second run sends nothing", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const { deviceId } = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  const apns = fakeApns();
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  const first = await sender.sendShiftPush(planArgs());
  assert.equal(first.counts.sent, 1);
  assert.deepEqual(first.recipients[0].devices, [{ deviceId, status: "sent", reason: null }]);

  const second = await sender.sendShiftPush(planArgs());
  assert.equal(second.counts.sent, 0);
  assert.equal(second.recipients[0].devices[0].reason, "already_claimed");
  assert.equal(apns.sends.length, 1, "a driver must not be buzzed twice for one version");

  const rows = await keys(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dedupe_key, `plan:${REF}:v3:${AT_RUNAR}:${deviceId}`);
  assert.equal(rows[0].status, "sent");

  const { rows: [logged] } = await db.query("SELECT payload, collapse_id, apns_id, attempts, sent_at FROM push_log");
  assert.equal(logged.collapse_id, `plan-${REF}`);
  assert.equal(logged.payload.recipient, AT_RUNAR);
  assert.equal(logged.attempts, 1);
  assert.ok(logged.sent_at);
});

test("PUSH_MODE=off writes only skip rows, and flipping to pilot then sends", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const { deviceId } = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  const apns = fakeApns();

  const off = makeSender(db, { PUSH_MODE: "off" }, apns);
  const shadow = await off.sender.sendShiftPush(planArgs());
  assert.equal(shadow.counts.skipped, 1);
  assert.equal(apns.sends.length, 0);
  assert.deepEqual(await keys(db), [{
    dedupe_key: `plan:${REF}:v3:${AT_RUNAR}:${deviceId}:skip:push_mode_off`,
    status: "skipped", apns_reason: "push_mode_off", kind: "plan_published",
  }]);

  // The real key was never burned, so the same version still goes out.
  const pilot = makeSender(db, { PUSH_MODE: "pilot", STAFF_LOGIN_ALLOWLIST: AT_RUNAR }, apns);
  const live = await pilot.sender.sendShiftPush(planArgs());
  assert.equal(live.counts.sent, 1);
  assert.equal(apns.sends.length, 1);
  assert.equal((await keys(db)).length, 2);
});

test("a tonight version with PLAN_PUSH_TONIGHT=0 skips, then sends when flipped on", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const { deviceId } = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  const apns = fakeApns();
  const args = planArgs({ baseKind: "plan_tonight", planVersion: 1 });

  const dark = makeSender(db, { PUSH_MODE: "on", PLAN_PUSH_TONIGHT: "0" }, apns);
  await dark.sender.sendShiftPush(args);
  assert.equal(apns.sends.length, 0);
  assert.deepEqual((await keys(db)).map((r) => r.dedupe_key), [
    `plan:${REF}:v1:${AT_RUNAR}:${deviceId}:skip:tonight_off`,
  ]);

  const lit = makeSender(db, { PUSH_MODE: "on", PLAN_PUSH_TONIGHT: "1" }, apns);
  const res = await lit.sender.sendShiftPush(args);
  assert.equal(res.counts.sent, 1);
  assert.equal(apns.sends[0].payload.aps.alert.title, "Áætlun kvöldsins er komin");
});

test("PUSH_MODE=pilot skips everyone off the allowlist", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  const { deviceId: matasDevice } = await seedStaff(db, { airtableId: AT_MATAS, name: "Matas" });
  const apns = fakeApns();
  const { sender } = makeSender(db, { PUSH_MODE: "pilot", STAFF_LOGIN_ALLOWLIST: AT_RUNAR }, apns);

  const res = await sender.sendShiftPush(planArgs({
    recipients: [{ airtableStaffId: AT_RUNAR, name: "Rúnar" }, { airtableStaffId: AT_MATAS, name: "Matas" }],
  }));
  assert.equal(res.counts.sent, 1);
  assert.equal(res.counts.skipped, 1);
  const skipped = (await keys(db)).find((r) => r.status === "skipped");
  assert.equal(skipped.dedupe_key, `plan:${REF}:v3:${AT_MATAS}:${matasDevice}:skip:not_in_pilot`);
});

test("a missing APNs key skips instead of throwing", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const { deviceId } = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  const apns = fakeApns({ status: "invalid" });
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  const res = await sender.sendShiftPush(planArgs());
  assert.equal(res.counts.skipped, 1);
  assert.equal(apns.sends.length, 0);
  assert.equal((await keys(db))[0].dedupe_key, `plan:${REF}:v3:${AT_RUNAR}:${deviceId}:skip:apns_not_configured`);
});

test("a revoked or expired session means the device is not signed in any more", async (t) => {
  for (const session of ["revoked", "expired"]) {
    const db = await freshDb();
    const apns = fakeApns();
    await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar", session });
    const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

    const res = await sender.sendShiftPush(planArgs());
    assert.equal(apns.sends.length, 0, `${session} session was sent to`);
    assert.equal(res.recipients[0].devices[0].reason, "not_signed_in");
    assert.equal((await keys(db))[0].dedupe_key, `plan:${REF}:v3:${AT_RUNAR}:nodevice:skip:not_signed_in`);
    await db.end();
  }
});

test("signed in but with no usable token → no_device, not not_signed_in", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const { staffId } = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  // Permission denied on the phone: a live session, a device row, no token.
  await db.query("UPDATE devices SET apns_token = NULL WHERE staff_id = $1", [staffId]);
  const apns = fakeApns();
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  await sender.sendShiftPush(planArgs());
  assert.equal((await keys(db))[0].dedupe_key, `plan:${REF}:v3:${AT_RUNAR}:nodevice:skip:no_device`);
});

test("someone who has left the roster is not a recipient at all", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  await seedStaff(db, { airtableId: AT_MATAS, name: "Matas" });
  const apns = fakeApns();
  // The shape src/staff/roster.js returns (§5.3): a Map keyed by rec id.
  const roster = {
    getRoster: async () => ({
      byId: new Map([
        [AT_RUNAR, { airtableId: AT_RUNAR, name: "Rúnar", status: "Active", active: true }],
        [AT_MATAS, { airtableId: AT_MATAS, name: "Matas", status: "Inactive", active: false }],
      ]),
      stale: false,
    }),
  };
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns, { roster });

  const res = await sender.sendShiftPush(planArgs({
    recipients: [{ airtableStaffId: AT_RUNAR, name: "Rúnar" }, { airtableStaffId: AT_MATAS, name: "Matas" }],
  }));
  assert.equal(res.recipients.length, 1);
  assert.equal(apns.sends.length, 1);
  // No push_log row either: an Inactive person is not a recipient, not a skip.
  assert.equal((await keys(db)).length, 1);
});

test("a late joiner gets plan_published, not BREYTT", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  const apns = fakeApns();
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  await sender.sendShiftPush(planArgs({ planVersion: 3 }));

  // Version 4 is a revision, and a second person joins the shift for it.
  await seedStaff(db, { airtableId: AT_MATAS, name: "Matas" });
  const v4 = planArgs({
    planVersion: 4,
    recipients: [{ airtableStaffId: AT_RUNAR, name: "Rúnar" }, { airtableStaffId: AT_MATAS, name: "Matas" }],
  });
  const res = await sender.sendShiftPush(v4);

  const byStaff = Object.fromEntries(res.recipients.map((r) => [r.airtableStaffId, r.kind]));
  assert.equal(byStaff[AT_RUNAR], "plan_revised", "Rúnar saw v3, so v4 is a change for him");
  assert.equal(byStaff[AT_MATAS], "plan_published", "Matas never saw a plan; BREYTT would be nonsense");
  const titles = apns.sends.map((s) => s.payload.aps.alert.title);
  assert.deepEqual(titles.slice(1), ["Áætlun uppfærð", "Áætlun morgundagsins er komin"]);
});

test("410: a token re-registered after Apple's timestamp survives", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const appleSaidDeadAt = Date.parse("2026-09-15T10:00:00Z");
  // Registered an hour AFTER Apple saw the token die: still a good token (§7).
  const { deviceId } = await seedStaff(db, {
    airtableId: AT_RUNAR, name: "Rúnar", tokenUpdatedAt: new Date(appleSaidDeadAt + 3_600_000),
  });
  const apns = fakeApns({ reply: () => ({ status: 410, reason: "Unregistered", timestamp: appleSaidDeadAt }) });
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  const res = await sender.sendShiftPush(planArgs());
  assert.equal(res.counts.failed, 1);
  const { rows } = await db.query("SELECT invalidated_at, invalidated_reason FROM devices WHERE id = $1", [deviceId]);
  assert.equal(rows[0].invalidated_at, null, "a re-registered token must not be thrown away");
});

test("410: a token older than Apple's timestamp is invalidated", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const appleSaidDeadAt = Date.parse("2026-09-15T10:00:00Z");
  const { deviceId } = await seedStaff(db, {
    airtableId: AT_RUNAR, name: "Rúnar", tokenUpdatedAt: new Date(appleSaidDeadAt - 3_600_000),
  });
  const apns = fakeApns({ reply: () => ({ status: 410, reason: "Unregistered", timestamp: appleSaidDeadAt }) });
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  await sender.sendShiftPush(planArgs());
  const { rows } = await db.query("SELECT invalidated_at, invalidated_reason FROM devices WHERE id = $1", [deviceId]);
  assert.ok(rows[0].invalidated_at);
  assert.equal(rows[0].invalidated_reason, "apns_410");
  const [log] = await keys(db);
  assert.equal(log.status, "failed");
  assert.equal(log.apns_reason, "Unregistered");
});

test("BadDeviceToken is retried on the other host and the environment is corrected", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const { deviceId } = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar", environment: "production" });
  const apns = fakeApns({
    reply: (msg) => (msg.environment === "production"
      ? { status: 400, reason: "BadDeviceToken" }
      : { status: 200 }),
  });
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  const res = await sender.sendShiftPush(planArgs());
  assert.equal(res.counts.sent, 1);
  assert.deepEqual(apns.sends.map((s) => s.environment), ["production", "sandbox"]);
  const { rows } = await db.query("SELECT apns_environment, invalidated_at FROM devices WHERE id = $1", [deviceId]);
  assert.equal(rows[0].apns_environment, "sandbox");
  assert.equal(rows[0].invalidated_at, null);
  const { rows: [log] } = await db.query("SELECT status, attempts, apns_environment FROM push_log");
  assert.equal(log.status, "sent");
  assert.equal(log.attempts, 2);
  assert.equal(log.apns_environment, "sandbox");
});

test("BadDeviceToken on both hosts invalidates the device", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const { deviceId } = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  const apns = fakeApns({ reply: () => ({ status: 400, reason: "BadDeviceToken" }) });
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  const res = await sender.sendShiftPush(planArgs());
  assert.equal(res.counts.failed, 1);
  const { rows } = await db.query("SELECT invalidated_reason FROM devices WHERE id = $1", [deviceId]);
  assert.equal(rows[0].invalidated_reason, "bad_device_token");
});

test("DeviceTokenNotForTopic fails the send but keeps the token", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const { deviceId } = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  const apns = fakeApns({ reply: () => ({ status: 400, reason: "DeviceTokenNotForTopic" }) });
  const { sender } = makeSender(db, { PUSH_MODE: "on", APNS_TOPIC: "is.bagbee.app" }, apns);

  const res = await sender.sendShiftPush(planArgs());
  assert.equal(res.counts.failed, 1);
  const { rows } = await db.query("SELECT invalidated_at FROM devices WHERE id = $1", [deviceId]);
  // It is our topic that is wrong, not the phone's token.
  assert.equal(rows[0].invalidated_at, null);
});

test("InvalidProviderToken on sandbox does not stop the production sends in that run", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar", environment: "sandbox" });
  const { deviceId: matasDevice } = await seedStaff(db, { airtableId: AT_MATAS, name: "Matas", environment: "production" });
  // A third phone on sandbox, to prove the rest of that host is skipped.
  const third = await seedStaff(db, { airtableId: "recZZZZZZZZZZZZZZ", name: "Valgeir", environment: "sandbox" });
  const apns = fakeApns({
    reply: (msg) => (msg.environment === "sandbox" ? { status: 403, reason: "InvalidProviderToken" } : { status: 200 }),
  });
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  const runState = createRunState();
  const res = await sender.sendShiftPush(planArgs({
    runState,
    recipients: [
      { airtableStaffId: AT_RUNAR, name: "Rúnar" },
      { airtableStaffId: AT_MATAS, name: "Matas" },
      { airtableStaffId: "recZZZZZZZZZZZZZZ", name: "Valgeir" },
    ],
  }));

  assert.equal(res.counts.sent, 1, "the production device must still get the plan");
  assert.equal(res.recipients[1].devices[0].deviceId, matasDevice);
  assert.equal(res.recipients[1].devices[0].status, "sent");
  assert.ok(runState.blockedEnvironments.has("sandbox"));
  // Only two APNs calls: the failing sandbox one and the production one.
  assert.equal(apns.sends.length, 2);
  const rows = await keys(db);
  const blocked = rows.find((r) => r.dedupe_key.includes(third.deviceId));
  assert.equal(blocked.status, "skipped");
  assert.equal(blocked.apns_reason, "invalid_provider_token");
  assert.ok(blocked.dedupe_key.endsWith(":skip:invalid_provider_token"), "the real key stays free for a later run");
});

test("dryRun resolves recipients and devices without writing or sending", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const { deviceId } = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  const apns = fakeApns();
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  const res = await sender.sendShiftPush(planArgs({ dryRun: true }));
  assert.deepEqual(res.recipients[0].devices, [{ deviceId, status: "skipped", reason: "dry_run" }]);
  assert.equal(apns.sends.length, 0);
  assert.equal((await keys(db)).length, 0);
});

test("test-push reaches the caller's own devices while PUSH_MODE is off", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const runar = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  const matas = await seedStaff(db, { airtableId: AT_MATAS, name: "Matas" });
  const apns = fakeApns();
  const { sender } = makeSender(db, { PUSH_MODE: "off" }, apns);

  const { results } = await sender.sendTestPush({ staffId: runar.staffId, airtableStaffId: AT_RUNAR });
  assert.deepEqual(results, [{ deviceId: runar.deviceId, status: "sent", apnsReason: null }]);
  assert.equal(apns.sends.length, 1, "P3 has to work while PUSH_MODE is still off");
  assert.notEqual(apns.sends[0].deviceToken, undefined);

  const { rows } = await db.query("SELECT dedupe_key, kind, triggered_by, device_id, shift_ref, payload FROM push_log");
  assert.equal(rows.length, 1, `a test push must never reach ${matas.deviceId}`);
  assert.match(rows[0].dedupe_key, /^test:[0-9a-f-]{36}$/);
  assert.equal(rows[0].kind, "test");
  assert.equal(rows[0].triggered_by, "self_test");
  assert.equal(rows[0].device_id, runar.deviceId);
  assert.equal(rows[0].shift_ref, null);
  assert.equal(rows[0].payload.aps.alert.title, "Prufa");
  // No collapse id: two taps of the button must both arrive.
  assert.equal(apns.sends[0].collapseId, null);
});

test("test-push with a broken APNs key reports skipped instead of failing", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const runar = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  const apns = fakeApns({ status: "invalid" });
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  const { results } = await sender.sendTestPush({ staffId: runar.staffId });
  assert.deepEqual(results, [{ deviceId: runar.deviceId, status: "skipped", apnsReason: "apns_not_configured" }]);
  assert.equal(apns.sends.length, 0);
});

test("a device with two live sessions is sent to once", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const runar = await seedStaff(db, { airtableId: AT_RUNAR, name: "Rúnar" });
  // A second session on the same phone, e.g. after a re-login without a logout.
  await db.query(
    `INSERT INTO sessions (staff_id, device_id, refresh_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 day')`,
    [runar.staffId, runar.deviceId, crypto.randomBytes(16).toString("hex")],
  );
  const apns = fakeApns();
  const { sender } = makeSender(db, { PUSH_MODE: "on" }, apns);

  const res = await sender.sendShiftPush(planArgs());
  assert.equal(apns.sends.length, 1);
  assert.equal(res.recipients[0].devices.length, 1);
});
