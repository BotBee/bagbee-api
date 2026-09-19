// Spec §4.7 — /v2/internal/*: the manual plan push, the two job triggers, and the
// two read-outs P5 uses to watch a shadow run. The guard is the real
// requireOwnerOrInternal (S1); Optimo, Airtable, the roster and APNs are fakes;
// PGlite is the database.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";

import { loadConfig } from "../src/config.js";
import { createDb, initPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createV2Router } from "../src/routes/v2.js";
import { createInternalRoutes, isCurrentMember } from "../src/routes/internal.js";
import { createAuthMiddleware, createSessionCache } from "../src/auth/middleware.js";
import { normalizeRoutes, optimoError } from "../src/optimo/client.js";
import { createSnapshotStore } from "../src/plan/snapshots.js";
import { createPlanJob } from "../src/plan/planJob.js";
import { createCounterJob } from "../src/plan/counterJob.js";
import { createSender } from "../src/push/sender.js";
import { createShiftsService } from "../src/staff/shifts.js";
import { ORDER, SHIFT, COUNTER, TABLES } from "../src/airtable/fields.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const LONG = "x".repeat(32);
const INTERNAL = "i".repeat(40);
const QUIET = { log() {}, error() {}, warn() {}, info() {} };

const TODAY = "2026-09-16";
const TMRW = "2026-09-17";
const at = (date, hhmm) => `${date}T${hhmm}:00Z`;

const RUNAR = "recRunar000000001";
const MATAS = "recMatas000000001";
const VALGEIR = "recValgeir0000001";
const TM = "recShiftTmrwMor01";
const TE = "recShiftTmrwEve01";
const TM_REF = `vakt_${TM}`;
const BSI = "recBsiTmrwSched01";

const shiftRecords = [
  { id: TM, fields: { [SHIFT.date]: TMRW, [SHIFT.shift]: "Morning", [SHIFT.driver]: [RUNAR, MATAS] } },
  { id: TE, fields: { [SHIFT.date]: TMRW, [SHIFT.shift]: "Evening", [SHIFT.driver]: [MATAS] } },
  { id: "recShiftTodayEv01", fields: { [SHIFT.date]: TODAY, [SHIFT.shift]: "Evening", [SHIFT.driver]: [RUNAR] } },
];
const counterRecords = [
  { id: BSI, fields: { [COUNTER.date]: TMRW, [COUNTER.slot]: "Morning", [COUNTER.staff]: [VALGEIR], [COUNTER.status]: "Scheduled" } },
];
const order = ({ id, num, date, slot, bags }) => ({
  id,
  fields: { [ORDER.orderNumber]: num, [ORDER.pickupDate]: date, [ORDER.shiftFormula]: slot, [ORDER.paid]: true, [ORDER.totalBags]: bags, [ORDER.customerName]: "Neha Verma", [ORDER.phone]: "+3545550000" },
});
const orderRecords = [
  order({ id: "recOrd00000000001", num: "aaaa1", date: TMRW, slot: "Morning", bags: 2 }),
  order({ id: "recOrd00000000002", num: "bbbb2", date: TMRW, slot: "Morning", bags: 3 }),
  order({ id: "recOrd00000000006", num: "ffff6", date: TODAY, slot: "Evening", bags: 2 }),
];
const optimoJson = {
  [TMRW]: {
    success: true,
    routes: [{
      driverName: "BagBee driver 1", driverSerial: "001",
      stops: [
        { orderNo: "aaaa1", stopNumber: 1, scheduledAt: "05:25", scheduledAtDt: `${TMRW} 05:25:00`, locationName: "Neha Verma" },
        { orderNo: "bbbb2", stopNumber: 2, scheduledAt: "06:10", scheduledAtDt: `${TMRW} 06:10:00` },
        { orderNo: "aaaa1-D", stopNumber: 3, scheduledAt: "07:30", scheduledAtDt: `${TMRW} 07:30:00` },
        { orderNo: "bbbb2-D", stopNumber: 4, scheduledAt: "07:45", scheduledAtDt: `${TMRW} 07:45:00` },
      ],
    }],
  },
  [TODAY]: {
    success: true,
    routes: [{ driverName: "BagBee driver 1", driverSerial: "001", stops: [
      { orderNo: "ffff6", stopNumber: 1, scheduledAt: "17:30", scheduledAtDt: `${TODAY} 17:30:00` },
    ] }],
  },
};

const fakeAirtable = {
  stats: { requests: 0 },
  async listAll(table, opts = {}) {
    this.stats.requests += 1;
    const formula = opts.filterByFormula || "";
    if (table === TABLES.orders) {
      const sameDay = /IS_SAME\(\{[^}]+\},'(\d{4}-\d{2}-\d{2})','day'\)/.exec(formula);
      if (sameDay) return { records: orderRecords.filter((o) => o.fields[ORDER.pickupDate] === sameDay[1]), pages: 1 };
      return { records: orderRecords, pages: 1 };
    }
    if (table === TABLES.shifts) return { records: shiftRecords, pages: 1 };
    if (table === TABLES.counter) return { records: counterRecords, pages: 1 };
    return { records: [], pages: 1 };
  },
  async getByIds() { return []; },
};

const people = new Map([
  [RUNAR, { airtableId: RUNAR, name: "Rúnar Árnason", displayName: "Rúnar", teams: ["Office", "Drivers"], status: "Active", active: true, role: "owner" }],
  [MATAS, { airtableId: MATAS, name: "Matas", displayName: "Matas", teams: ["Drivers"], status: "Active", active: true, role: "staff" }],
  [VALGEIR, { airtableId: VALGEIR, name: "Valgeir", displayName: "Valgeir", teams: ["Office"], status: "Active", active: true, role: "owner" }],
]);
const roster = {
  async getRoster() { return { byId: people, stale: false }; },
  async getRosterEntry(id) { return { entry: people.get(id) ?? null, stale: false }; },
};

function fakeApns() {
  const sends = [];
  return {
    sends,
    get: () => ({ status: "configured", client: { async send(msg) { sends.push(msg); return { status: 200, apnsId: crypto.randomUUID() }; } } }),
  };
}

// --- harness ---------------------------------------------------------------------

async function serve({ envOver = {}, optimoFail = null, db = null, nowIso = at(TODAY, "17:35") } = {}) {
  const config = loadConfig({
    DATABASE_URL: "pglite:memory",
    STAFF_JWT_SECRET: LONG,
    OTP_HMAC_SECRET: LONG,
    VAKT_INTERNAL_SECRET: INTERNAL,
    PUSH_MODE: "on",
    ...envOver,
  });
  const own = !db;
  if (own) {
    const devConfig = loadConfig({ DATABASE_URL: "pglite:memory" });
    db = createDb(devConfig);
    await initPool(db, devConfig);
    await migrate(db.pool, MIGRATIONS_DIR);
    db.ready = true;
  }

  const staff = {};
  if (own) {
    for (const [key, airtableId, name] of [["runar", RUNAR, "Rúnar Árnason"], ["matas", MATAS, "Matas"], ["valgeir", VALGEIR, "Valgeir"]]) {
      const { rows: [row] } = await db.query(
        "INSERT INTO staff (airtable_record_id, name, login_email, airtable_status) VALUES ($1, $2, $3, 'Active') RETURNING id",
        [airtableId, name, `${key}@example.is`],
      );
      const { rows: [device] } = await db.query(
        `INSERT INTO devices (installation_id, staff_id, apns_token, apns_environment) VALUES ($1, $2, $3, 'production') RETURNING id`,
        [crypto.randomUUID(), row.id, crypto.randomBytes(32).toString("hex")],
      );
      await db.query(
        "INSERT INTO sessions (staff_id, device_id, refresh_hash, expires_at) VALUES ($1, $2, $3, now() + interval '180 days')",
        [row.id, device.id, crypto.randomBytes(16).toString("hex")],
      );
      staff[key] = { staffId: row.id, deviceId: device.id, airtableId };
    }
  }

  let nowMs = Date.parse(nowIso);
  const clock = () => new Date(nowMs);
  const apns = fakeApns();
  const optimo = {
    calls: [],
    async getRoutes(date) {
      optimo.calls.push(date);
      if (optimoFail) throw optimoError(optimoFail);
      return normalizeRoutes(optimoJson[date] ?? { success: true, routes: [] }, date);
    },
  };
  const shifts = createShiftsService({ airtable: fakeAirtable, config, now: () => nowMs, logger: QUIET });
  const snapshots = createSnapshotStore(db);
  const sender = createSender({ db, config, apns: apns.get, roster, clock, log: QUIET });
  const planJob = createPlanJob({ db, config, optimo, shifts, roster, snapshots, sender, airtable: fakeAirtable, clock, log: QUIET });
  const counterJob = createCounterJob({ shifts, roster, sender, airtable: fakeAirtable, clock, log: QUIET });
  const { requireStaff, requireOwnerOrInternal } = createAuthMiddleware({ db, config, roster, sessionCache: createSessionCache({ clock }), clock, log: QUIET });
  const internalRoutes = createInternalRoutes({ db, config, shifts, roster, snapshots, sender, planJob, counterJob, clock, log: QUIET });

  const app = express();
  app.use("/v2", express.json({ limit: "32kb" }));
  app.use("/v2", createV2Router({ db, config, apns: apns.get, sender, requireStaff, requireOwnerOrInternal, internalRoutes, clock }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();

  const call = async (method, path, body, headers = { "x-internal-secret": INTERNAL }) => {
    const res = await fetch(`http://127.0.0.1:${port}/v2${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  return {
    db, staff, apns, optimo, planJob, call,
    setNow: (iso) => { nowMs = Date.parse(iso); },
    post: (path, body, headers) => call("POST", path, body, headers),
    get: (path, headers) => call("GET", path, undefined, headers),
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      if (own) await db.end();
    },
  };
}

const pushRows = async (db) => (await db.query("SELECT dedupe_key, status, triggered_by, kind FROM push_log ORDER BY id")).rows;
const snapshotRows = async (db) => (await db.query("SELECT version, published_at, push_kind FROM plan_snapshots WHERE shift_ref = $1 ORDER BY version", [TM_REF])).rows;

// --- the guard ---------------------------------------------------------------------

test("every internal path is 403 without the secret, and unknown ones are the JSON 404 with it", async (t) => {
  const h = await serve();
  t.after(h.close);

  for (const [method, path] of [["POST", "/internal/push/plan-published"], ["POST", "/internal/jobs/plan-detect"], ["POST", "/internal/jobs/counter-tomorrow"], ["GET", `/internal/plan-status?date=${TMRW}`], ["GET", "/internal/confirmations"]]) {
    const none = await h.call(method, path, method === "POST" ? {} : undefined, {});
    assert.deepEqual([none.status, none.body], [403, { error: "forbidden" }], `${method} ${path} without a secret`);
    const wrong = await h.call(method, path, method === "POST" ? {} : undefined, { "x-internal-secret": `${INTERNAL}x` });
    assert.deepEqual([wrong.status, wrong.body], [403, { error: "forbidden" }], `${method} ${path} with a wrong secret`);
  }
  assert.equal(h.optimo.calls.length, 0, "a refused request must never reach OptimoRoute");

  const unknown = await h.get("/internal/nope");
  assert.deepEqual([unknown.status, unknown.body], [404, { error: "not_found" }]);
});

test("internal routes answer 503 db_unavailable, after the guard, while Postgres is down", async (t) => {
  const h = await serve();
  t.after(h.close);
  h.db.ready = false;
  const res = await h.get(`/internal/plan-status?date=${TMRW}`);
  assert.deepEqual([res.status, res.body], [503, { error: "db_unavailable" }]);
  const stranger = await h.get(`/internal/plan-status?date=${TMRW}`, {});
  assert.equal(stranger.status, 403, "a stranger learns nothing about Postgres from these paths");
  h.db.ready = true;
});

// --- POST /v2/internal/push/plan-published --------------------------------------------

test("plan-published defaults to a dry run: the payload and recipients, nothing written or sent", async (t) => {
  const h = await serve();
  t.after(h.close);

  const res = await h.post("/internal/push/plan-published", { shiftRef: TM_REF });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.shiftRef, res.body.planVersion, res.body.newVersion, res.body.dryRun], [TM_REF, 1, true, true]);
  assert.equal(res.body.payload.aps.alert.title, "Áætlun morgundagsins er komin");
  assert.equal(res.body.payload.aps.alert.body, "Morgunvakt fim. 17. sep · 4 stopp · 5 töskur · fyrsta stopp 05:25");
  assert.equal(res.body.payload.planVersion, 1);
  assert.ok(!JSON.stringify(res.body.payload).includes("Neha"));
  assert.deepEqual(res.body.recipients.map((r) => [r.airtableStaffId, r.staffId, r.name, r.kind, r.devices]), [
    [RUNAR, h.staff.runar.staffId, "Rúnar", "plan_published", [{ deviceId: h.staff.runar.deviceId, status: "skipped", reason: "dry_run" }]],
    [MATAS, h.staff.matas.staffId, "Matas", "plan_published", [{ deviceId: h.staff.matas.deviceId, status: "skipped", reason: "dry_run" }]],
  ]);
  assert.deepEqual(h.optimo.calls, [TMRW], "one get_routes call, for the shift's date");
  assert.deepEqual(await snapshotRows(h.db), []);
  assert.deepEqual(await pushRows(h.db), []);
  assert.equal(h.apns.sends.length, 0);
});

test("plan-published with dryRun:false writes the snapshot, marks it published and sends once; force sends again under manual keys", async (t) => {
  const h = await serve();
  t.after(h.close);

  const res = await h.post("/internal/push/plan-published", { shiftRef: TM_REF, dryRun: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.planVersion, 1);
  assert.deepEqual(res.body.recipients.map((r) => r.devices[0].status), ["sent", "sent"]);
  const [v1] = await snapshotRows(h.db);
  assert.ok(v1.published_at);
  assert.equal(v1.push_kind, "plan_published");
  assert.equal(h.apns.sends.length, 2);
  let rows = await pushRows(h.db);
  assert.deepEqual(rows.map((r) => [r.status, r.triggered_by]), [["sent", "internal_api"], ["sent", "internal_api"]]);
  assert.ok(rows.every((r) => r.dedupe_key.startsWith(`plan:${TM_REF}:v1:`)), "the job's own dedupe keys, so the job cannot send v1 again");

  // The same call again: every key is claimed.
  const again = await h.post("/internal/push/plan-published", { shiftRef: TM_REF, dryRun: false });
  assert.deepEqual(again.body.recipients.map((r) => r.devices[0].reason), ["already_claimed", "already_claimed"]);
  assert.equal(h.apns.sends.length, 2);
  assert.equal((await snapshotRows(h.db)).length, 1, "the same plan is the same version");

  // force: a deliberate resend under manual keys.
  const forced = await h.post("/internal/push/plan-published", { shiftRef: TM_REF, dryRun: false, force: true });
  assert.deepEqual(forced.body.recipients.map((r) => r.devices[0].status), ["sent", "sent"]);
  assert.equal(h.apns.sends.length, 4);
  rows = await pushRows(h.db);
  assert.equal(rows.filter((r) => r.dedupe_key.startsWith("manual:")).length, 2);
});

test("plan-published narrows to onlyStaffIds and is blocked by PUSH_MODE=off like everything else", async (t) => {
  const h = await serve({ envOver: { PUSH_MODE: "off" } });
  t.after(h.close);

  const res = await h.post("/internal/push/plan-published", { shiftRef: TM_REF, dryRun: false, force: true, onlyStaffIds: [h.staff.matas.staffId] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.recipients.map((r) => [r.airtableStaffId, r.devices[0].status, r.devices[0].reason]), [[MATAS, "skipped", "push_mode_off"]]);
  assert.equal(h.apns.sends.length, 0);
  assert.ok((await snapshotRows(h.db))[0].published_at, "the decision is marked even though nothing was sent");
});

test("plan-published: 400 for a malformed ref, 404 for unknown and counter refs, 409 without a plan, 503 without OptimoRoute", async (t) => {
  const h = await serve();
  t.after(h.close);

  assert.deepEqual((await h.post("/internal/push/plan-published", { shiftRef: "vakt_rec1" })).status, 400);
  assert.deepEqual((await h.post("/internal/push/plan-published", {})).status, 400);
  assert.deepEqual(await h.post("/internal/push/plan-published", { shiftRef: "vakt_recGhost000000001" }), { status: 404, body: { error: "not_found" } });
  assert.deepEqual(await h.post("/internal/push/plan-published", { shiftRef: `bsi_${BSI}` }), { status: 404, body: { error: "not_found" } });
  // Tomorrow's Evening has no stops in OptimoRoute yet.
  assert.deepEqual(await h.post("/internal/push/plan-published", { shiftRef: `vakt_${TE}` }), { status: 409, body: { error: "no_plan" } });
  assert.deepEqual(await snapshotRows(h.db), []);

  const down = await serve({ optimoFail: "optimo_unavailable" });
  t.after(down.close);
  assert.deepEqual(await down.post("/internal/push/plan-published", { shiftRef: TM_REF }), { status: 503, body: { error: "optimo_unavailable" } });
});

// --- the job triggers ---------------------------------------------------------------

test("jobs/plan-detect runs the job as a dry run by default, honours `now` outside production, and can run for real", async (t) => {
  const h = await serve();
  t.after(h.close);

  const dry = await h.post("/internal/jobs/plan-detect", { now: at(TODAY, "17:10") });
  assert.equal(dry.status, 200);
  assert.deepEqual([dry.body.job, dry.body.now, dry.body.dryRun, dry.body.optimoCalls], ["plan-detect", at(TODAY, "17:10"), true, 2]);
  const tm = dry.body.shifts.find((s) => s.ref === TM_REF);
  assert.deepEqual([tm.version, tm.newVersion, tm.decision, tm.reason], [1, true, "none", "not_stable"]);
  assert.deepEqual(await snapshotRows(h.db), []);

  // A body with no now runs at the server clock (17:35).
  const real = await h.post("/internal/jobs/plan-detect", { dryRun: false });
  assert.equal(real.body.now, at(TODAY, "17:35"));
  assert.equal(real.body.dryRun, false);
  assert.equal((await snapshotRows(h.db)).length, 1);
  const later = await h.post("/internal/jobs/plan-detect", { dryRun: false, now: at(TODAY, "17:45") });
  const published = later.body.shifts.find((s) => s.ref === TM_REF);
  assert.deepEqual([published.decision, published.sends], ["publish", { sent: 2, skipped: 0, failed: 0 }]);
  // Today's Evening (tonight, 15:00–18:00) is published by the same run; count the Morning only.
  assert.equal(h.apns.sends.filter((s) => s.payload.shiftRef === TM_REF).length, 2);
  assert.ok((await pushRows(h.db)).every((r) => r.triggered_by === "internal_api"));

  // An unparseable now falls back to the clock rather than answering 500.
  const junk = await h.post("/internal/jobs/plan-detect", { now: "einhvern tímann" });
  assert.equal(junk.body.now, at(TODAY, "17:35"));
});

test("in production `now` is ignored", async (t) => {
  // The database is opened with a dev config (pglite is refused in production);
  // only the router's config claims production.
  const dev = await serve();
  t.after(dev.close);
  const prod = await serve({ db: dev.db, envOver: { RAILWAY_ENVIRONMENT_NAME: "production" }, nowIso: at(TODAY, "17:36") });
  t.after(prod.close);

  const res = await prod.post("/internal/jobs/plan-detect", { now: at(TODAY, "21:00") });
  assert.equal(res.status, 200);
  assert.equal(res.body.now, at(TODAY, "17:36"), "a stray request must never move the clock on Railway");
});

test("jobs/counter-tomorrow reports tomorrow's BSÍ rows, dry by default", async (t) => {
  const h = await serve({ nowIso: at(TODAY, "20:00") });
  t.after(h.close);

  const dry = await h.post("/internal/jobs/counter-tomorrow", {});
  assert.equal(dry.status, 200);
  assert.deepEqual([dry.body.job, dry.body.date, dry.body.dryRun], ["counter-tomorrow", TMRW, true]);
  assert.deepEqual(dry.body.shifts.map((s) => [s.ref, s.slot, s.sends]), [[`bsi_${BSI}`, "Morning", { sent: 0, skipped: 1, failed: 0 }]]);
  assert.deepEqual(await pushRows(h.db), []);

  const real = await h.post("/internal/jobs/counter-tomorrow", { dryRun: false });
  assert.deepEqual(real.body.shifts[0].sends, { sent: 1, skipped: 0, failed: 0 });
  assert.equal(h.apns.sends[0].payload.aps.alert.title, "Vaktin þín á morgun: BSÍ 09–13");
  assert.equal(h.apns.sends[0].payload.recipient, VALGEIR);
});

// --- plan-status and confirmations --------------------------------------------------------

async function confirm(db, { staffId, ref, date, answer, answeredAt, source = "push_action", planVersion = 1 }) {
  await db.query(
    `INSERT INTO shift_confirmations (shift_ref, shift_date, staff_id, answer, answered_at, received_at, source, plan_version, client_event_id)
     VALUES ($1, $2::date, $3, $4, $5, $5, $6, $7, $8)`,
    [ref, date, staffId, answer, answeredAt, source, planVersion, crypto.randomUUID()],
  );
}

test("plan-status shows the people, the versions, the pushes and the answers of a date, with stale answers flagged", async (t) => {
  const h = await serve();
  t.after(h.close);

  assert.deepEqual(await h.get("/internal/plan-status?date=2026-02-31"), { status: 400, body: { error: "invalid_request" } });
  assert.deepEqual(await h.get("/internal/plan-status"), { status: 400, body: { error: "invalid_request" } });

  // A shadow-mode timeline: v1 seen at 17:20, published at 17:35 with PUSH_MODE=on.
  await h.post("/internal/jobs/plan-detect", { dryRun: false, now: at(TODAY, "17:20") });
  await h.post("/internal/jobs/plan-detect", { dryRun: false, now: at(TODAY, "17:35") });
  // Rúnar answers; Valgeir, who is NOT on the shift any more, has an earlier yes.
  await confirm(h.db, { staffId: h.staff.runar.staffId, ref: TM_REF, date: TMRW, answer: "yes", answeredAt: at(TODAY, "17:40") });
  await confirm(h.db, { staffId: h.staff.valgeir.staffId, ref: TM_REF, date: TMRW, answer: "yes", answeredAt: at(TODAY, "17:38"), source: "app" });
  // Matas is signed in on a second phone with no token, and Valgeir's session is revoked.
  await h.db.query("INSERT INTO devices (installation_id, staff_id) VALUES ($1, $2)", [crypto.randomUUID(), h.staff.matas.staffId]);
  await h.db.query("UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE staff_id = $1", [h.staff.valgeir.staffId]);

  const res = await h.get(`/internal/plan-status?date=${TMRW}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.date, TMRW);
  assert.deepEqual(res.body.shifts.map((s) => [s.ref, s.kind, s.slot, s.label]), [
    [TM_REF, "driving", "Morning", "Morgunvakt"],
    [`vakt_${TE}`, "driving", "Evening", "Kvöldvakt"],
    [`bsi_${BSI}`, "counter", "Morning", "BSÍ · Morgunn"],
  ]);

  const tm = res.body.shifts[0];
  assert.deepEqual(tm.staff, [
    { airtableStaffId: RUNAR, name: "Rúnar", signedIn: true, devices: 1 },
    { airtableStaffId: MATAS, name: "Matas", signedIn: true, devices: 1 },
  ]);
  assert.equal(tm.versions.length, 1);
  assert.deepEqual(
    { ...tm.versions[0], planHash: tm.versions[0].planHash.length },
    { version: 1, planHash: 64, stopCount: 4, expected: 2, covered: 2, firstStopAt: "05:25", firstSeenAt: at(TODAY, "17:20"), lastSeenAt: at(TODAY, "17:35"), publishedAt: at(TODAY, "17:35"), pushKind: "plan_published" },
  );
  assert.deepEqual(tm.pushes.map((p) => [p.kind, p.planVersion, p.staffName, p.status, p.apnsReason]).sort(), [
    ["plan_published", 1, "Matas", "sent", null],
    ["plan_published", 1, "Rúnar", "sent", null],
  ]);
  assert.ok(tm.pushes.every((p) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(p.createdAt)));
  assert.deepEqual(tm.confirmations, [
    { staffName: "Valgeir", answer: "yes", answeredAt: at(TODAY, "17:38"), source: "app", planVersion: 1, stale: true },
    { staffName: "Rúnar Árnason", answer: "yes", answeredAt: at(TODAY, "17:40"), source: "push_action", planVersion: 1, stale: false },
  ]);

  const te = res.body.shifts[1];
  assert.deepEqual([te.versions, te.pushes, te.confirmations], [[], [], []]);
  const bsi = res.body.shifts[2];
  assert.equal(bsi.status, "Scheduled");
  assert.deepEqual(bsi.staff, [{ airtableStaffId: VALGEIR, name: "Valgeir", signedIn: false, devices: 0 }]);

  // A date with nothing on it is an empty list, not an error.
  assert.deepEqual(await h.get("/internal/plan-status?date=2026-09-20"), { status: 200, body: { date: "2026-09-20", shifts: [] } });
});

test("confirmations lists the current answers in a range with labels and the stale flag", async (t) => {
  const h = await serve();
  t.after(h.close);

  await confirm(h.db, { staffId: h.staff.runar.staffId, ref: TM_REF, date: TMRW, answer: "no", answeredAt: at(TODAY, "17:40") });
  await confirm(h.db, { staffId: h.staff.runar.staffId, ref: TM_REF, date: TMRW, answer: "yes", answeredAt: at(TODAY, "17:50"), source: "app", planVersion: 2 });
  await confirm(h.db, { staffId: h.staff.valgeir.staffId, ref: TM_REF, date: TMRW, answer: "yes", answeredAt: at(TODAY, "17:38") });
  await confirm(h.db, { staffId: h.staff.valgeir.staffId, ref: `bsi_${BSI}`, date: TMRW, answer: "yes", answeredAt: at(TODAY, "17:39") });
  // A shift that is gone from Airtable: no membership, so stale.
  await confirm(h.db, { staffId: h.staff.matas.staffId, ref: "vakt_recGhost000000001", date: "2026-09-18", answer: "yes", answeredAt: at(TODAY, "17:41") });
  // Outside the requested range.
  await confirm(h.db, { staffId: h.staff.matas.staffId, ref: TM_REF, date: "2026-10-30", answer: "yes", answeredAt: at(TODAY, "17:42") });

  const res = await h.get(`/internal/confirmations?from=${TMRW}&to=2026-09-18`);
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.from, res.body.to], [TMRW, "2026-09-18"]);
  assert.deepEqual(res.body.rows, [
    { shiftRef: `bsi_${BSI}`, shiftDate: TMRW, label: "BSÍ · Morgunn", staffName: "Valgeir", answer: "yes", answeredAt: at(TODAY, "17:39"), receivedAt: at(TODAY, "17:39"), source: "push_action", planVersion: 1, stale: false },
    { shiftRef: TM_REF, shiftDate: TMRW, label: "Morgunvakt", staffName: "Valgeir", answer: "yes", answeredAt: at(TODAY, "17:38"), receivedAt: at(TODAY, "17:38"), source: "push_action", planVersion: 1, stale: true },
    { shiftRef: TM_REF, shiftDate: TMRW, label: "Morgunvakt", staffName: "Rúnar Árnason", answer: "yes", answeredAt: at(TODAY, "17:50"), receivedAt: at(TODAY, "17:50"), source: "app", planVersion: 2, stale: false },
    { shiftRef: "vakt_recGhost000000001", shiftDate: "2026-09-18", label: null, staffName: "Matas", answer: "yes", answeredAt: at(TODAY, "17:41"), receivedAt: at(TODAY, "17:41"), source: "push_action", planVersion: 1, stale: true },
  ]);

  // The default range is today−7..today+30, validated like /v2/me/shifts.
  const dflt = await h.get("/internal/confirmations");
  assert.deepEqual([dflt.body.from, dflt.body.to, dflt.body.rows.length], ["2026-09-09", "2026-10-16", 4]);
  assert.deepEqual(await h.get("/internal/confirmations?from=2026-01-01"), { status: 400, body: { error: "invalid_range" } });
  assert.deepEqual(await h.get(`/internal/confirmations?from=${TMRW}&to=${TODAY}`), { status: 400, body: { error: "invalid_range" } });
});

test("isCurrentMember reads the links of the row it is given", () => {
  const driving = { kind: "driving", driverIds: [RUNAR], extraIds: [], otherIds: [MATAS] };
  assert.equal(isCurrentMember(driving, RUNAR), true);
  assert.equal(isCurrentMember(driving, MATAS), true);
  assert.equal(isCurrentMember(driving, VALGEIR), false);
  assert.equal(isCurrentMember({ kind: "counter", staffIds: [VALGEIR] }, VALGEIR), true);
  assert.equal(isCurrentMember({ kind: "counter", staffIds: [VALGEIR] }, RUNAR), false);
  assert.equal(isCurrentMember(null, RUNAR), false);
});
