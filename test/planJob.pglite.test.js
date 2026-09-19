// Spec §6.3–§6.7 — the plan-detect job end to end: an OptimoRoute get_routes
// JSON in, plan_snapshots versions and push payloads out. Everything between is
// the real code (normalizeRoutes, planModel, snapshots, sender); only Optimo,
// Airtable, the roster and APNs are fakes, and PGlite is the database.
//
// Dates: TODAY = Wed 2026-09-16, TMRW = Thu 2026-09-17 ("fim. 17. sep").
// Order numbers are synthetic: real ones open /orders/<n> and the repo is public.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { createDb, initPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { normalizeRoutes, optimoError } from "../src/optimo/client.js";
import { createSnapshotStore } from "../src/plan/snapshots.js";
import { createPlanJob, datesForRun, recipientsOf } from "../src/plan/planJob.js";
import { createCounterJob } from "../src/plan/counterJob.js";
import { createSender } from "../src/push/sender.js";
import { createShiftsService } from "../src/staff/shifts.js";
import { createShiftDetail } from "../src/staff/shiftDetail.js";
import { ORDER, SHIFT, COUNTER, TABLES } from "../src/airtable/fields.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const QUIET = { log() {}, error() {}, warn() {}, info() {} };

const TODAY = "2026-09-16";
const TMRW = "2026-09-17";
const NEXT2 = "2026-09-18";

const RUNAR = "recRunar000000001";
const MATAS = "recMatas000000001";
const VALGEIR = "recValgeir0000001";

const TM = "recShiftTmrwMor01"; // tomorrow Morning — Rúnar + Matas
const TE = "recShiftTmrwEve01"; // tomorrow Evening — never computed the evening before
const DM = "recShiftTodayMo01"; // today Morning — snapshot only, never announced
const DE = "recShiftTodayEv01"; // today Evening — "tonight"
const UN = "recShiftNobody001"; // nobody on it
const TM_REF = `vakt_${TM}`;
const DE_REF = `vakt_${DE}`;

const at = (date, hhmm) => `${date}T${hhmm}:00Z`;

// --- fixtures ---------------------------------------------------------------

const shiftRecords = [
  { id: TM, fields: { [SHIFT.date]: TMRW, [SHIFT.shift]: "Morning", [SHIFT.driver]: [RUNAR, MATAS] } },
  { id: TE, fields: { [SHIFT.date]: TMRW, [SHIFT.shift]: "Evening", [SHIFT.driver]: [MATAS] } },
  { id: DM, fields: { [SHIFT.date]: TODAY, [SHIFT.shift]: "Morning", [SHIFT.driver]: [RUNAR] } },
  { id: DE, fields: { [SHIFT.date]: TODAY, [SHIFT.shift]: "Evening", [SHIFT.driver]: [RUNAR] } },
  { id: UN, fields: { [SHIFT.date]: TMRW, [SHIFT.shift]: "Morning", [SHIFT.driver]: [] } },
];

const counterRecords = [
  { id: "recBsiTmrwSched01", fields: { [COUNTER.date]: TMRW, [COUNTER.slot]: "Morning", [COUNTER.staff]: [RUNAR], [COUNTER.status]: "Scheduled" } },
  { id: "recBsiTmrwOpen001", fields: { [COUNTER.date]: TMRW, [COUNTER.slot]: "Midday", [COUNTER.staff]: [MATAS], [COUNTER.status]: "Open", [COUNTER.start]: "13:30", [COUNTER.end]: "17:00" } },
  { id: "recBsiTmrwCancel1", fields: { [COUNTER.date]: TMRW, [COUNTER.slot]: "Morning", [COUNTER.staff]: [RUNAR], [COUNTER.status]: "Cancelled" } },
  { id: "recBsiTmrwDone001", fields: { [COUNTER.date]: TMRW, [COUNTER.slot]: "Custom", [COUNTER.staff]: [RUNAR], [COUNTER.status]: "Completed" } },
  { id: "recBsiTmrwNobody1", fields: { [COUNTER.date]: TMRW, [COUNTER.slot]: "Morning", [COUNTER.staff]: [], [COUNTER.status]: "Open" } },
  { id: "recBsiTodayRow001", fields: { [COUNTER.date]: TODAY, [COUNTER.slot]: "Morning", [COUNTER.staff]: [RUNAR], [COUNTER.status]: "Scheduled" } },
];

const order = ({ id, num, date, slot, paid = true, bags = 1, name = "Viðskiptavinur", phone = "+3545550000" }) => ({
  id,
  fields: {
    [ORDER.orderNumber]: num,
    [ORDER.pickupDate]: date,
    [ORDER.shiftFormula]: slot,
    [ORDER.paid]: paid,
    [ORDER.totalBags]: bags,
    [ORDER.customerName]: name,
    [ORDER.requestedService]: "Check-in service",
    [ORDER.reference]: "FSEB-1",
    [ORDER.timeWindow]: "04:00 - 05:00",
    [ORDER.pickupAddress]: "Pósthússtræti 11",
    [ORDER.deliveryAddress]: "Keflavík International Airport",
    [ORDER.phone]: phone,
  },
});

function orderRecords() {
  return [
    order({ id: "recOrd00000000001", num: "aaaa1", date: TMRW, slot: "Morning", bags: 2, name: "Neha Verma" }),
    order({ id: "recOrd00000000002", num: "bbbb2", date: TMRW, slot: "Morning", bags: 3 }),
    order({ id: "recOrd00000000003", num: "cccc3", date: TMRW, slot: "Morning", bags: 1 }),
    order({ id: "recOrd00000000004", num: "dddd4", date: TMRW, slot: "Morning", bags: 4 }), // paid, not planned at first
    order({ id: "recOrd00000000005", num: "eeee5", date: TMRW, slot: "Evening", bags: 2 }),
    order({ id: "recOrd00000000006", num: "ffff6", date: TODAY, slot: "Evening", bags: 2 }),
    order({ id: "recOrd00000000007", num: "gggg7", date: TODAY, slot: "Morning", bags: 1 }),
    order({ id: "recOrd00000000008", num: "hhhh8", date: TODAY, slot: "Evening", bags: 3 }), // paid, never planned
  ];
}

/// Raw get_routes JSON, the shape OptimoRoute answers with (§6.2).
function optimoFixtures() {
  const stop = (orderNo, stopNumber, dt, extra = {}) => ({
    orderNo, stopNumber, scheduledAt: dt.slice(11, 16), scheduledAtDt: dt, ...extra,
  });
  return {
    [TMRW]: {
      success: true,
      routes: [
        {
          driverName: "BagBee driver 1", driverSerial: "001", dispatchStatus: { state: "not_sent" },
          stops: [
            { stopNumber: 0, locationName: "Depot", address: "Bíldshöfði 12" },
            stop("aaaa1", 1, `${TMRW} 05:25:00`, { locationName: "Neha Verma", address: "Laugavegur 12, 101 Reykjavík", latitude: 64.147, longitude: -21.94 }),
            stop("bbbb2", 2, `${TMRW} 06:10:00`, { locationName: "Hótel Borg", address: "Pósthússtræti 11" }),
            stop("aaaa1-D", 3, `${TMRW} 07:30:00`, { locationName: "KEF" }),
            stop("bbbb2-D", 4, `${TMRW} 07:45:00`, { locationName: "KEF" }),
            stop("eeee5", 5, `${TMRW} 17:09:00`),
            stop("eeee5-D", 6, `${NEXT2} 01:11:00`),
          ],
        },
        {
          driverName: "BagBee driver 2", driverSerial: "002", dispatchStatus: { state: "not_sent" },
          stops: [
            stop("cccc3", 1, `${TMRW} 05:40:00`),
            stop("cccc3-D", 2, `${TMRW} 08:00:00`),
          ],
        },
      ],
    },
    [TODAY]: {
      success: true,
      routes: [
        {
          driverName: "BagBee driver 1", driverSerial: "001", dispatchStatus: { state: "sent" },
          stops: [
            stop("gggg7", 1, `${TODAY} 09:00:00`),
            stop("gggg7-D", 2, `${TODAY} 10:30:00`),
            stop("ffff6", 3, `${TODAY} 17:30:00`),
            stop("ffff6-D", 4, `${TMRW} 01:30:00`),
          ],
        },
      ],
    },
  };
}

/// Adds or removes dddd4 on route 1 of tomorrow — the "late booking" that
/// changes the Morning plan materially (+1 order, +1 stop).
function withDddd4(fixtures, present) {
  const route = fixtures[TMRW].routes[0];
  route.stops = route.stops.filter((s) => s.orderNo !== "dddd4");
  if (present) route.stops.splice(3, 0, { orderNo: "dddd4", stopNumber: 3, scheduledAt: "06:30", scheduledAtDt: `${TMRW} 06:30:00` });
}

function fakeOptimo(fixtures) {
  const optimo = {
    calls: [],
    fixtures,
    fail: null,
    async getRoutes(date) {
      optimo.calls.push(date);
      if (optimo.fail) throw optimoError(optimo.fail);
      return normalizeRoutes(fixtures[date] ?? { success: true, routes: [] }, date);
    },
  };
  return optimo;
}

function fakeAirtable({ orders }) {
  return {
    orders,
    stats: { requests: 0 },
    async listAll(table, opts = {}) {
      this.stats.requests += 1;
      const formula = opts.filterByFormula || "";
      if (table === TABLES.orders) {
        const sameDay = /IS_SAME\(\{[^}]+\},'(\d{4}-\d{2}-\d{2})','day'\)/.exec(formula);
        if (sameDay) return { records: this.orders.filter((o) => o.fields[ORDER.pickupDate] === sameDay[1]), pages: 1 };
        const numbers = [...formula.matchAll(/\{fldo3soPBdIjoOv7H\}='([^']+)'/g)].map((m) => m[1]);
        if (numbers.length) return { records: this.orders.filter((o) => numbers.includes(o.fields[ORDER.orderNumber])), pages: 1 };
        return { records: this.orders, pages: 1 };
      }
      if (table === TABLES.shifts) return { records: shiftRecords, pages: 1 };
      if (table === TABLES.counter) return { records: counterRecords, pages: 1 };
      return { records: [], pages: 1 };
    },
    async getByIds() {
      return [];
    },
  };
}

const roster = {
  async getRoster() {
    return {
      byId: new Map([
        [RUNAR, { airtableId: RUNAR, displayName: "Rúnar", name: "Rúnar Árnason", active: true }],
        [MATAS, { airtableId: MATAS, displayName: "Matas", name: "Matas", active: true }],
        [VALGEIR, { airtableId: VALGEIR, displayName: "Valgeir", name: "Valgeir", active: true }],
      ]),
      stale: false,
    };
  },
};

function fakeApns() {
  const sends = [];
  return {
    sends,
    get: () => ({
      status: "configured",
      client: { async send(msg) { sends.push(msg); return { status: 200, apnsId: crypto.randomUUID(), reason: null, timestamp: null }; } },
    }),
  };
}

// --- harness ------------------------------------------------------------------

async function freshDb() {
  const config = loadConfig({ DATABASE_URL: "pglite:memory" });
  const db = createDb(config);
  await initPool(db, config);
  await migrate(db.pool, MIGRATIONS_DIR);
  db.ready = true;
  return db;
}

async function seedStaff(db, { airtableId, name, withDevice = true }) {
  const { rows: [staff] } = await db.query(
    "INSERT INTO staff (airtable_record_id, name, login_email, airtable_status) VALUES ($1, $2, $3, 'Active') RETURNING id",
    [airtableId, name, `${name.toLowerCase()}@example.is`],
  );
  if (!withDevice) return { staffId: staff.id, deviceId: null };
  return { staffId: staff.id, deviceId: await addDevice(db, staff.id) };
}

async function addDevice(db, staffId) {
  const { rows: [device] } = await db.query(
    `INSERT INTO devices (installation_id, staff_id, apns_token, apns_environment, app_build)
     VALUES ($1, $2, $3, 'production', 41) RETURNING id`,
    [crypto.randomUUID(), staffId, crypto.randomBytes(32).toString("hex")],
  );
  await db.query(
    "INSERT INTO sessions (staff_id, device_id, refresh_hash, expires_at) VALUES ($1, $2, $3, now() + interval '180 days')",
    [staffId, device.id, crypto.randomBytes(16).toString("hex")],
  );
  return device.id;
}

/// One harness = one process's view: config, caches, sender. Several can share
/// a database to play a PUSH_MODE or PLAN_PUSH_TONIGHT flip.
function build({ db, envOver = {}, optimo, apns = fakeApns(), airtable = fakeAirtable({ orders: orderRecords() }), logs = [] }) {
  const config = loadConfig({ DATABASE_URL: "pglite:memory", PUSH_MODE: "on", ...envOver });
  let nowMs = Date.parse(at(TODAY, "12:00"));
  const clock = () => new Date(nowMs);
  const log = { log: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(`ERROR ${a.join(" ")}`), info() {}, warn() {} };
  const shifts = createShiftsService({ airtable, config, now: () => nowMs, logger: QUIET });
  const snapshots = createSnapshotStore(db);
  const sender = createSender({ db, config, apns: apns.get, roster, clock, log: QUIET });
  const planJob = createPlanJob({ db, config, optimo, shifts, roster, snapshots, sender, airtable, clock, log });
  const counterJob = createCounterJob({ shifts, roster, sender, airtable, clock, log });
  const detail = createShiftDetail({ airtable, shifts, roster, config, now: () => nowMs, logger: QUIET, snapshots });

  const run = async (date, hhmm, opts = {}) => {
    nowMs = Date.parse(at(date, hhmm));
    const report = await planJob.runPlanDetect({ now: clock(), ...opts });
    return { report, entry: (id) => report.shifts.find((s) => s.ref === `vakt_${id}`) };
  };
  const runCounter = async (date, hhmm, opts = {}) => {
    nowMs = Date.parse(at(date, hhmm));
    return counterJob.runCounterTomorrow({ now: clock(), ...opts });
  };
  return { config, shifts, snapshots, sender, planJob, counterJob, detail, apns, airtable, logs, run, runCounter, clock, setNow: (ms) => { nowMs = ms; } };
}

const versions = async (db, ref) =>
  (await db.query("SELECT version, plan_hash, stop_count, bag_count, published_at, push_kind, first_seen_at, last_seen_at FROM plan_snapshots WHERE shift_ref = $1 ORDER BY version", [ref])).rows;
/// Scoped to one shift when asked: today's Evening (`tonight`, 15:00–18:00) is
/// legitimately published in the same runs as tomorrow's Morning, and its rows
/// and sends must not blur what a test says about the Morning.
const pushRows = async (db, ref = null) =>
  (await db.query(
    "SELECT dedupe_key, kind, status, apns_reason, plan_version, airtable_staff_id FROM push_log WHERE $1::text IS NULL OR shift_ref = $1 ORDER BY id",
    [ref],
  )).rows;
const sendsFor = (apns, ref) => apns.sends.filter((s) => s.payload.shiftRef === ref);

// --- tomorrow's Morning through the timetable -----------------------------------

test("tomorrow's Morning: seen, stable, incomplete, published at the deadline, revised on a material change, capped at two revisions", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const runar = await seedStaff(db, { airtableId: RUNAR, name: "Rúnar" });
  const matas = await seedStaff(db, { airtableId: MATAS, name: "Matas" });
  const optimo = fakeOptimo(optimoFixtures());
  const h = build({ db, optimo });

  // 17:00 — first sight of the plan; the window is not open yet.
  let { report, entry } = await h.run(TODAY, "17:00");
  assert.deepEqual(optimo.calls, [TODAY, TMRW], "one get_routes per date, today then tomorrow");
  assert.equal(report.optimoCalls, 2);
  assert.ok(report.airtableCalls >= 3, "the shift window and both dates' orders were read");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.dates.map((d) => [d.date, d.routeCount, d.stopCount, d.slotMismatch, d.orphans]), [[TODAY, 1, 4, 0, 0], [TMRW, 2, 8, 0, 0]]);
  assert.equal(entry(TM).kind, "tomorrow");
  assert.deepEqual(
    { ...entry(TM) },
    { ref: TM_REF, date: TMRW, slot: "Morning", kind: "tomorrow", stopCount: 6, expected: 4, covered: 3, version: 1, newVersion: true, decision: "none", reason: "outside_window", sends: null },
  );

  // 17:05 — open, but seen only 5 minutes ago.
  ({ entry } = await h.run(TODAY, "17:05"));
  assert.equal(entry(TM).newVersion, false);
  assert.deepEqual([entry(TM).version, entry(TM).decision, entry(TM).reason, entry(TM).sends], [1, "none", "not_stable", null]);

  // 17:10 — stable, but dddd4 is paid and unplanned.
  ({ entry } = await h.run(TODAY, "17:10"));
  assert.deepEqual([entry(TM).decision, entry(TM).reason], ["none", "incomplete"]);
  assert.equal((await versions(db, TM_REF))[0].published_at, null);
  assert.equal(sendsFor(h.apns, TM_REF).length, 0);

  // 17:35 — the deadline: publish anyway, and send to both people.
  ({ entry } = await h.run(TODAY, "17:35"));
  assert.deepEqual([entry(TM).decision, entry(TM).reason], ["publish", null]);
  assert.deepEqual(entry(TM).sends, { sent: 2, skipped: 0, failed: 0 });
  let rows = await versions(db, TM_REF);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].published_at.toISOString(), at(TODAY, "17:35").replace("Z", ".000Z"));
  assert.equal(rows[0].push_kind, "plan_published");
  assert.equal(rows[0].first_seen_at.toISOString(), at(TODAY, "17:00").replace("Z", ".000Z"), "first_seen_at is the run clock, not the insert time");
  assert.equal(sendsFor(h.apns, TM_REF).length, 2);
  const first = sendsFor(h.apns, TM_REF)[0];
  assert.equal(first.payload.aps.alert.title, "Áætlun morgundagsins er komin");
  assert.equal(first.payload.aps.alert.body, "Morgunvakt fim. 17. sep · 6 stopp · 6 töskur · fyrsta stopp 05:25");
  assert.equal(first.payload.planVersion, 1);
  assert.equal(first.payload.shiftRef, TM_REF);
  assert.equal(first.collapseId, `plan-${TM_REF}`);
  assert.equal(first.expiration, Date.parse(at(TMRW, "05:25")) / 1000, "apns-expiration is the first stop");
  for (const forbidden of ["Neha", "Verma", "Laugavegur", "Hótel Borg", "5550000", "Depot"]) {
    assert.ok(!JSON.stringify(first.payload).includes(forbidden), `payload leaked ${forbidden}`);
  }
  assert.deepEqual(sendsFor(h.apns, TM_REF).map((s) => s.payload.recipient).sort(), [MATAS, RUNAR].sort());
  let log = await pushRows(db, TM_REF);
  assert.deepEqual(log.map((r) => r.dedupe_key).sort(), [
    `plan:${TM_REF}:v1:${MATAS}:${matas.deviceId}`,
    `plan:${TM_REF}:v1:${RUNAR}:${runar.deviceId}`,
  ].sort());

  // 17:45 — nothing changed: the keys are claimed, nobody is buzzed twice.
  ({ entry } = await h.run(TODAY, "17:45"));
  assert.deepEqual([entry(TM).decision, entry(TM).reason], ["none", "no_material_change"]);
  assert.deepEqual(entry(TM).sends, { sent: 0, skipped: 2, failed: 0 });
  assert.equal(sendsFor(h.apns, TM_REF).length, 2);
  assert.equal((await pushRows(db, TM_REF)).length, 2, "already_claimed leaves no row");

  // A late booking lands: dddd4 is planned at 06:30 → v2, then a revision.
  withDddd4(optimo.fixtures, true);
  ({ entry } = await h.run(TODAY, "17:50"));
  assert.deepEqual([entry(TM).version, entry(TM).newVersion, entry(TM).reason, entry(TM).covered], [2, true, "not_stable", 4]);
  assert.deepEqual(entry(TM).sends, { sent: 0, skipped: 2, failed: 0 }, "the target is still v1 until v2 is decided");

  ({ entry } = await h.run(TODAY, "18:00"));
  assert.deepEqual([entry(TM).decision, entry(TM).reason], ["revise", null]);
  assert.deepEqual(entry(TM).sends, { sent: 2, skipped: 0, failed: 0 });
  rows = await versions(db, TM_REF);
  assert.deepEqual(rows.map((r) => [r.version, r.stop_count, r.bag_count, r.push_kind]), [[1, 6, 6, "plan_published"], [2, 7, 10, "plan_revised"]]);
  assert.notEqual(rows[0].plan_hash, rows[1].plan_hash);
  const revised = sendsFor(h.apns, TM_REF)[2];
  assert.equal(revised.payload.aps.alert.title, "Áætlun uppfærð");
  assert.equal(revised.payload.aps.alert.body, "BREYTT: Morgunvakt fim. 17. sep · 7 stopp · 10 töskur · fyrsta stopp 05:25");
  assert.equal(revised.payload.planVersion, 2);
  assert.equal(revised.collapseId, first.collapseId, "the revision replaces the first banner");

  // The booking is pulled again: the hash returns to v1's, and that is v3, not v1.
  withDddd4(optimo.fixtures, false);
  ({ entry } = await h.run(TODAY, "18:10"));
  assert.deepEqual([entry(TM).version, entry(TM).newVersion], [3, true]);
  rows = await versions(db, TM_REF);
  assert.equal(rows[2].plan_hash, rows[0].plan_hash, "same plan as v1 …");
  assert.equal(rows[2].version, 3, "… but a new version all the same (§6.5)");

  ({ entry } = await h.run(TODAY, "18:20"));
  assert.deepEqual([entry(TM).decision, entry(TM).sends.sent], ["revise", 2]);
  assert.equal(sendsFor(h.apns, TM_REF).length, 6);

  // A third material change is not announced: two revisions is the cap (Q3).
  withDddd4(optimo.fixtures, true);
  await h.run(TODAY, "18:30");
  ({ entry } = await h.run(TODAY, "18:40"));
  assert.deepEqual([entry(TM).version, entry(TM).decision, entry(TM).reason], [4, "none", "no_material_change"]);
  assert.equal(sendsFor(h.apns, TM_REF).length, 6);
  rows = await versions(db, TM_REF);
  assert.equal(rows[3].published_at, null);
  assert.equal(rows.filter((r) => r.push_kind === "plan_revised").length, 2);

  // 21:31 — the window has closed: no decision and no reconcile, whatever changed.
  withDddd4(optimo.fixtures, false);
  await h.run(TODAY, "21:20");
  ({ entry } = await h.run(TODAY, "21:31"));
  assert.deepEqual([entry(TM).decision, entry(TM).reason, entry(TM).sends], ["none", "outside_window", null]);
});

test("tomorrow's Evening is never computed, an unstaffed row is skipped, today's Morning is snapshotted but never announced", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await seedStaff(db, { airtableId: RUNAR, name: "Rúnar" });
  const h = build({ db, optimo: fakeOptimo(optimoFixtures()) });

  const { report, entry } = await h.run(TODAY, "17:00");
  assert.deepEqual(report.shifts.map((s) => s.ref).sort(), [`vakt_${DM}`, DE_REF, TM_REF].sort());
  assert.equal(entry(TE), undefined, "tomorrow's Evening has no plan yet and must not read as no_stops");
  assert.equal(entry(UN), undefined);
  assert.deepEqual([entry(DM).kind, entry(DM).stopCount, entry(DM).decision, entry(DM).reason, entry(DM).sends], [null, 2, "none", "not_announced", null]);
  assert.deepEqual([entry(DE).kind, entry(DE).stopCount, entry(DE).expected, entry(DE).covered], ["tonight", 2, 2, 1]);
  const { rows } = await db.query("SELECT shift_ref, slot, plan_date::text FROM plan_snapshots ORDER BY shift_ref");
  assert.deepEqual(rows, [
    { shift_ref: TM_REF, slot: "Morning", plan_date: TMRW },
    { shift_ref: `vakt_${DE}`, slot: "Evening", plan_date: TODAY },
    { shift_ref: `vakt_${DM}`, slot: "Morning", plan_date: TODAY },
  ]);
});

// --- tonight --------------------------------------------------------------------

test("tonight: today's Evening publishes at 16:15 even if incomplete; PLAN_PUSH_TONIGHT=0 marks the decision and skips the send, 1 then sends it", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const runar = await seedStaff(db, { airtableId: RUNAR, name: "Rúnar" });
  const optimo = fakeOptimo(optimoFixtures());
  const apns = fakeApns();
  const dark = build({ db, optimo, apns, envOver: { PLAN_PUSH_TONIGHT: "0" } });

  let { entry } = await dark.run(TODAY, "14:40");
  assert.deepEqual([entry(DE).version, entry(DE).decision, entry(DE).reason, entry(DE).sends], [1, "none", "outside_window", null]);

  ({ entry } = await dark.run(TODAY, "15:00"));
  assert.deepEqual([entry(DE).decision, entry(DE).reason], ["none", "incomplete"], "hhhh8 is paid and unplanned");
  ({ entry } = await dark.run(TODAY, "16:14"));
  assert.equal(entry(DE).reason, "incomplete");

  ({ entry } = await dark.run(TODAY, "16:15"));
  assert.deepEqual([entry(DE).decision, entry(DE).reason], ["publish", null]);
  assert.deepEqual(entry(DE).sends, { sent: 0, skipped: 1, failed: 0 });
  const [v1] = await versions(db, DE_REF);
  assert.ok(v1.published_at, "the decision is marked whatever PLAN_PUSH_TONIGHT is (O13, C11)");
  assert.equal(v1.push_kind, "plan_tonight");
  assert.equal(apns.sends.length, 0);
  assert.deepEqual((await pushRows(db)).map((r) => r.dedupe_key), [`plan:${DE_REF}:v1:${RUNAR}:${runar.deviceId}:skip:tonight_off`]);

  // Flip the flag (a new process reads it): the published version goes out at the next run.
  const lit = build({ db, optimo, apns, envOver: { PLAN_PUSH_TONIGHT: "1" } });
  ({ entry } = await lit.run(TODAY, "16:25"));
  assert.deepEqual([entry(DE).decision, entry(DE).reason], ["none", "no_material_change"]);
  assert.deepEqual(entry(DE).sends, { sent: 1, skipped: 0, failed: 0 });
  assert.equal(apns.sends[0].payload.aps.alert.title, "Áætlun kvöldsins er komin");
  assert.equal(apns.sends[0].payload.aps.alert.body, "Kvöldvakt mið. 16. sep · 2 stopp · 2 töskur · fyrsta stopp 17:30");
  assert.equal(apns.sends[0].expiration, Date.parse(at(TODAY, "17:30")) / 1000, "17:30 on D, never the 01:30 stop on D+1");

  // 18:01 — window closed: no more reconciling.
  ({ entry } = await lit.run(TODAY, "18:01"));
  assert.deepEqual([entry(DE).reason, entry(DE).sends], ["outside_window", null]);
});

// --- the day boundary ---------------------------------------------------------

test("before 14:30 only today is read; after midnight yesterday's 'tomorrow' is today's Morning and is never announced", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await seedStaff(db, { airtableId: RUNAR, name: "Rúnar" });
  await seedStaff(db, { airtableId: MATAS, name: "Matas" });
  const optimo = fakeOptimo(optimoFixtures());
  const h = build({ db, optimo });

  assert.deepEqual(datesForRun(new Date(at(TODAY, "14:29"))), [TODAY]);
  assert.deepEqual(datesForRun(new Date(at(TODAY, "14:30"))), [TODAY, TMRW]);
  assert.deepEqual(datesForRun(new Date(at(TODAY, "23:59"))), [TODAY, TMRW]);
  assert.deepEqual(datesForRun(new Date(at(TMRW, "00:00"))), [TMRW]);

  // 23:30 today: tomorrow's Morning exists but the window closed at 21:30.
  let { report, entry } = await h.run(TODAY, "23:30");
  assert.deepEqual(report.shifts.map((s) => s.ref).sort(), [`vakt_${DM}`, DE_REF, TM_REF].sort());
  assert.deepEqual([entry(TM).kind, entry(TM).reason, entry(TM).sends], ["tomorrow", "outside_window", null]);

  // 00:30 tomorrow: the same row is now today's Morning — no kind, no push, ever.
  optimo.calls.length = 0;
  ({ report, entry } = await h.run(TMRW, "00:30"));
  assert.deepEqual(optimo.calls, [TMRW]);
  assert.equal(report.optimoCalls, 1);
  assert.deepEqual(report.shifts.map((s) => s.ref).sort(), [`vakt_${TE}`, TM_REF].sort(), "today's two shifts, and the day after is not read");
  assert.deepEqual([entry(TM).kind, entry(TM).version, entry(TM).newVersion, entry(TM).reason, entry(TM).sends], [null, 1, false, "not_announced", null]);
  assert.deepEqual([entry(TE).kind, entry(TE).stopCount, entry(TE).reason, entry(TE).sends], ["tonight", 2, "outside_window", null]);

  // 05:00 tomorrow: the morning refresh touches last_seen_at, nothing else.
  ({ entry } = await h.run(TMRW, "05:00"));
  const [v1] = await versions(db, TM_REF);
  assert.equal(v1.last_seen_at.toISOString(), at(TMRW, "05:00").replace("Z", ".000Z"));
  assert.equal(v1.first_seen_at.toISOString(), at(TODAY, "23:30").replace("Z", ".000Z"));
  assert.equal(v1.published_at, null);
  assert.equal(h.apns.sends.length, 0);
});

// --- PUSH_MODE and dry runs -----------------------------------------------------

test("PUSH_MODE=off records the decision, writes skip rows, logs a dry run; pilot then sends the published version", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const runar = await seedStaff(db, { airtableId: RUNAR, name: "Rúnar" });
  const matas = await seedStaff(db, { airtableId: MATAS, name: "Matas" });
  const optimo = fakeOptimo(optimoFixtures());
  const apns = fakeApns();
  const logs = [];
  const off = build({ db, optimo, apns, logs, envOver: { PUSH_MODE: "off" } });

  await off.run(TODAY, "17:20");
  const { entry } = await off.run(TODAY, "17:35");
  assert.deepEqual([entry(TM).decision, entry(TM).sends], ["publish", { sent: 0, skipped: 2, failed: 0 }]);
  const [v1] = await versions(db, TM_REF);
  assert.ok(v1.published_at, "shadow mode still shows `published` in the app (O13)");
  assert.equal(sendsFor(apns, TM_REF).length, 0);
  assert.deepEqual((await pushRows(db, TM_REF)).map((r) => [r.dedupe_key, r.status, r.apns_reason]).sort(), [
    [`plan:${TM_REF}:v1:${MATAS}:${matas.deviceId}:skip:push_mode_off`, "skipped", "push_mode_off"],
    [`plan:${TM_REF}:v1:${RUNAR}:${runar.deviceId}:skip:push_mode_off`, "skipped", "push_mode_off"],
  ].sort());
  assert.ok(logs.some((l) => l.includes(`[plan] ${TM_REF} ${TMRW} Morning v1 decision=publish push_mode=off`)), `decision not logged: ${logs.join("\n")}`);
  assert.ok(logs.some((l) => l.includes(`[plan] ${TM_REF} v1 PUSH_MODE=off — dry run of the send: 2 skipped, nothing sent`)), `dry run not logged: ${logs.join("\n")}`);

  // A pilot process on the same database, inside the window: the real key was
  // never burned, so v1 goes to the allowlisted person now.
  const pilot = build({ db, optimo, apns, envOver: { PUSH_MODE: "pilot", STAFF_LOGIN_ALLOWLIST: RUNAR } });
  const later = await pilot.run(TODAY, "17:45");
  assert.deepEqual([later.entry(TM).decision, later.entry(TM).reason], ["none", "no_material_change"]);
  assert.deepEqual(later.entry(TM).sends, { sent: 1, skipped: 1, failed: 0 });
  assert.equal(sendsFor(apns, TM_REF).length, 1);
  assert.equal(sendsFor(apns, TM_REF)[0].payload.recipient, RUNAR);
  const rows = await pushRows(db, TM_REF);
  assert.ok(rows.some((r) => r.dedupe_key === `plan:${TM_REF}:v1:${RUNAR}:${runar.deviceId}` && r.status === "sent"));
  assert.ok(rows.some((r) => r.dedupe_key === `plan:${TM_REF}:v1:${MATAS}:${matas.deviceId}:skip:not_in_pilot`));
});

test("a dry run writes nothing and previews the decision from the stored state", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await seedStaff(db, { airtableId: RUNAR, name: "Rúnar" });
  await seedStaff(db, { airtableId: MATAS, name: "Matas" });
  const optimo = fakeOptimo(optimoFixtures());
  const h = build({ db, optimo });

  // Nothing stored yet: a dry run sees "v1, new, not yet stable".
  let { report, entry } = await h.run(TODAY, "17:35", { dryRun: true });
  assert.equal(report.dryRun, true);
  assert.deepEqual([entry(TM).version, entry(TM).newVersion, entry(TM).decision, entry(TM).reason, entry(TM).sends], [1, true, "none", "not_stable", null]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM plan_snapshots")).rows[0].n, 0);
  assert.equal((await pushRows(db, TM_REF)).length, 0);

  // Real runs publish v1 …
  await h.run(TODAY, "17:20");
  await h.run(TODAY, "17:35");
  assert.equal(sendsFor(h.apns, TM_REF).length, 2);

  // … and a dry run inside the window resolves the recipients without sending or writing.
  ({ entry } = await h.run(TODAY, "17:45", { dryRun: true }));
  assert.deepEqual([entry(TM).version, entry(TM).newVersion, entry(TM).decision, entry(TM).reason], [1, false, "none", "no_material_change"]);
  assert.deepEqual(entry(TM).sends, { sent: 0, skipped: 2, failed: 0 });
  assert.equal(sendsFor(h.apns, TM_REF).length, 2);
  assert.equal((await pushRows(db, TM_REF)).length, 2);
  assert.equal((await versions(db, TM_REF)).length, 1);

  // A dry run of a changed plan previews v2 without inserting it.
  withDddd4(optimo.fixtures, true);
  ({ entry } = await h.run(TODAY, "17:55", { dryRun: true }));
  assert.deepEqual([entry(TM).version, entry(TM).newVersion, entry(TM).reason], [2, true, "not_stable"]);
  assert.equal((await versions(db, TM_REF)).length, 1);
});

// --- failures and late joiners --------------------------------------------------

test("an OptimoRoute failure writes no snapshot but still reconciles the published version to a late joiner", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const runar = await seedStaff(db, { airtableId: RUNAR, name: "Rúnar" });
  const matas = await seedStaff(db, { airtableId: MATAS, name: "Matas", withDevice: false });
  const optimo = fakeOptimo(optimoFixtures());
  const h = build({ db, optimo });

  await h.run(TODAY, "17:20");
  let { entry } = await h.run(TODAY, "17:35");
  assert.deepEqual(entry(TM).sends, { sent: 1, skipped: 1, failed: 0 });
  assert.ok((await pushRows(db, TM_REF)).some((r) => r.dedupe_key === `plan:${TM_REF}:v1:${MATAS}:nodevice:skip:not_signed_in`));

  // Matas signs in on his phone at 17:40; at 17:45 OptimoRoute is down.
  const matasDevice = await addDevice(db, matas.staffId);
  optimo.fail = "optimo_unavailable";
  let report;
  ({ report, entry } = await h.run(TODAY, "17:45"));
  assert.deepEqual(report.errors, [{ date: TODAY, error: "optimo_unavailable" }, { date: TMRW, error: "optimo_unavailable" }]);
  assert.deepEqual(report.dates, []);
  assert.deepEqual([entry(TM).version, entry(TM).stopCount, entry(TM).decision, entry(TM).reason], [1, null, "none", "optimo_unavailable"]);
  assert.deepEqual(entry(TM).sends, { sent: 1, skipped: 1, failed: 0 }, "Rúnar already claimed, Matas newly reached");
  assert.equal(sendsFor(h.apns, TM_REF).length, 2);
  assert.equal(sendsFor(h.apns, TM_REF)[1].payload.recipient, MATAS);
  assert.equal(sendsFor(h.apns, TM_REF)[1].payload.aps.alert.title, "Áætlun morgundagsins er komin", "a late joiner never gets BREYTT");
  assert.ok((await pushRows(db, TM_REF)).some((r) => r.dedupe_key === `plan:${TM_REF}:v1:${MATAS}:${matasDevice}` && r.status === "sent"));
  const rows = await versions(db, TM_REF);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last_seen_at.toISOString(), at(TODAY, "17:35").replace("Z", ".000Z"), "no routes, no refresh");
  void runar;
});

// --- what the snapshot holds ------------------------------------------------------

test("the snapshot carries the PlannedStop routes the detail serves, and a same-hash run refreshes the non-hashed columns", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await seedStaff(db, { airtableId: RUNAR, name: "Rúnar" });
  const optimo = fakeOptimo(optimoFixtures());
  const airtable = fakeAirtable({ orders: orderRecords() });
  const h = build({ db, optimo, airtable });

  await h.run(TODAY, "17:00");
  const { rows: [row] } = await db.query("SELECT * FROM plan_snapshots WHERE shift_ref = $1", [TM_REF]);
  assert.equal(row.plan_date.toISOString().slice(0, 10), TMRW);
  assert.deepEqual([row.slot, row.version, row.stop_count, row.bag_count, row.expected_order_count, row.planned_order_count], ["Morning", 1, 6, 6, 4, 3]);
  assert.deepEqual(row.order_numbers, ["aaaa1", "bbbb2", "cccc3"]);
  assert.equal(row.first_stop_dt.toISOString(), at(TMRW, "05:25").replace("Z", ".000Z"));
  assert.equal(row.first_stop_at, "05:25");
  assert.equal(row.first_stop_name, "Neha Verma", "in-app only; the payload test proves it never reaches a push");
  assert.equal(row.or_dispatch_state, "not_sent");
  assert.equal(row.published_at, null);
  assert.deepEqual(row.routes.map((r) => [r.driver, r.stops.map((s) => s.optimoOrderNo)]), [
    ["BagBee driver 1 01", ["aaaa1", "bbbb2", "aaaa1-D", "bbbb2-D"]],
    ["BagBee driver 2 02", ["cccc3", "cccc3-D"]],
  ]);
  const stop = row.routes[0].stops[0];
  assert.deepEqual(Object.keys(stop).sort(), [
    "address", "customerName", "done", "driver", "latitude", "leg", "locationName", "longitude", "optimoOrderNo",
    "orderNumber", "phone", "recordId", "reference", "requestedService", "scheduledAt", "stopNumber", "stopRecordId",
    "timeWindow", "totalBags", "trackingURL",
  ]);
  assert.deepEqual([stop.orderNumber, stop.recordId, stop.customerName, stop.totalBags, stop.phone, stop.leg, stop.done], ["aaaa1", "recOrd00000000001", "Neha Verma", 2, "+3545550000", "pickup", false]);
  assert.equal(row.routes[0].stops[2].phone, null, "delivery legs carry no phone");

  // The detail prefers this fresh snapshot (§5.5 step 1).
  const found = await h.shifts.getShiftForStaff({ staff: { airtableId: RUNAR, id: "uuid" }, ref: TM_REF, nowDate: h.clock() });
  const detail = await h.detail.buildShiftDetail({ staff: { airtableId: RUNAR, id: "uuid" }, found, nowDate: h.clock() });
  assert.equal(detail.source, "optimo_snapshot");
  assert.equal(detail.stale, false);
  assert.deepEqual(detail.routes.map((r) => r.driver), ["BagBee driver 1 01", "BagBee driver 2 02"]);
  assert.deepEqual(detail.orders.map((o) => [o.orderNumber, o.planned]), [["aaaa1", true], ["bbbb2", true], ["cccc3", true], ["dddd4", false]]);
  assert.equal(detail.unplannedOrderCount, 1);

  // Airtable corrects aaaa1's bags to 5 (the orders cache expires after 3 min):
  // the same hash refreshes bag_count in place, no new version (D9).
  airtable.orders[0].fields[ORDER.totalBags] = 5;
  const { entry } = await h.run(TODAY, "17:10");
  assert.deepEqual([entry(TM).version, entry(TM).newVersion], [1, false]);
  const [v1] = await versions(db, TM_REF);
  assert.equal(v1.bag_count, 9);
  assert.equal(v1.last_seen_at.toISOString(), at(TODAY, "17:10").replace("Z", ".000Z"));
});

test("recipientsOf lists every person on the row once, drivers first", () => {
  const row = { driverIds: [RUNAR, MATAS], extraIds: [VALGEIR, RUNAR], otherIds: [MATAS] };
  const byId = new Map([[RUNAR, { displayName: "Rúnar" }]]);
  assert.deepEqual(recipientsOf(row, byId), [
    { airtableStaffId: RUNAR, name: "Rúnar" },
    { airtableStaffId: MATAS, name: null },
    { airtableStaffId: VALGEIR, name: null },
  ]);
});

// --- counter-tomorrow ---------------------------------------------------------------

test("counter-tomorrow pushes tomorrow's staffed BSÍ rows that are not Cancelled or Completed, once", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const runar = await seedStaff(db, { airtableId: RUNAR, name: "Rúnar" });
  const matas = await seedStaff(db, { airtableId: MATAS, name: "Matas" });
  const h = build({ db, optimo: fakeOptimo(optimoFixtures()) });

  const dry = await h.runCounter(TODAY, "20:00", { dryRun: true });
  assert.deepEqual(dry.shifts.map((s) => [s.ref, s.slot, s.status, s.sends]), [
    ["bsi_recBsiTmrwSched01", "Morning", "Scheduled", { sent: 0, skipped: 1, failed: 0 }],
    ["bsi_recBsiTmrwOpen001", "Midday", "Open", { sent: 0, skipped: 1, failed: 0 }],
  ]);
  assert.equal(dry.date, TMRW);
  assert.equal((await pushRows(db)).length, 0, "a dry run writes nothing");
  assert.equal(h.apns.sends.length, 0);

  const report = await h.runCounter(TODAY, "20:00");
  assert.deepEqual(report.shifts.map((s) => s.sends), [{ sent: 1, skipped: 0, failed: 0 }, { sent: 1, skipped: 0, failed: 0 }]);
  assert.deepEqual(report.errors, []);
  assert.equal(h.apns.sends.length, 2);
  const [toRunar, toMatas] = h.apns.sends;
  assert.equal(toRunar.payload.aps.alert.title, "Vaktin þín á morgun: BSÍ 09–13", "blank Start/End → the fixed Morning hours");
  assert.equal(toRunar.payload.aps.alert.body, "fim. 17. sep · BSÍ · Morgunn");
  assert.equal(toRunar.payload.aps.category, "PLAN_PUBLISHED");
  assert.equal(toRunar.payload.recipient, RUNAR);
  assert.equal(toRunar.collapseId, "counter-bsi_recBsiTmrwSched01");
  assert.equal(toRunar.expiration, Date.parse(at(TMRW, "09:00")) / 1000);
  assert.equal(toMatas.payload.aps.alert.title, "Vaktin þín á morgun: BSÍ 13:30–17:00");
  assert.equal(toMatas.payload.recipient, MATAS);
  assert.deepEqual((await pushRows(db)).map((r) => [r.dedupe_key, r.kind, r.status]).sort(), [
    [`counter:bsi_recBsiTmrwOpen001:v1:${MATAS}:${matas.deviceId}`, "counter_tomorrow", "sent"],
    [`counter:bsi_recBsiTmrwSched01:v1:${RUNAR}:${runar.deviceId}`, "counter_tomorrow", "sent"],
  ].sort());

  // 20:10 — the reconcile finds every key claimed.
  const again = await h.runCounter(TODAY, "20:10");
  assert.deepEqual(again.shifts.map((s) => s.sends), [{ sent: 0, skipped: 1, failed: 0 }, { sent: 0, skipped: 1, failed: 0 }]);
  assert.equal(h.apns.sends.length, 2);
});
