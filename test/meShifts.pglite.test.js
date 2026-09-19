// Spec §4.5 — GET /v2/me/shifts and GET /v2/me/shifts/:ref over HTTP, mounted the
// way index.js mounts them. B2's shifts/detail modules are the real code; only
// Airtable and requireStaff are fakes, so what these tests check is the part B4
// adds: the Postgres join (plan_snapshots, current_shift_confirmations), the
// response shapes the Swift models decode, and the rule that a person can never
// see a shift they are not on.
//
// Order numbers are synthetic 5-character strings: real ones open /orders/<n> and
// bagbee-api is public (§1.3).

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";

import { loadConfig } from "../src/config.js";
import { createDb, initPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createV2Router } from "../src/routes/v2.js";
import { createThrottle } from "../src/auth/throttle.js";
import { createShiftsService } from "../src/staff/shifts.js";
import { createShiftDetail } from "../src/staff/shiftDetail.js";
import { ORDER, SHIFT, COUNTER, STOP, TABLES } from "../src/airtable/fields.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const LONG = "x".repeat(32);
const QUIET = { log() {}, error() {}, warn() {}, info() {} };

const TODAY = "2026-09-11";
const NEXT = "2026-09-12";
const NOW_MS = Date.parse(`${TODAY}T20:00:00Z`);

const RUNAR = "recRunar000000001";
const MATAS = "recMatas000000001";

const EVENING = "recShiftEvening01";
const MORNING = "recShiftMorning01";
const NOT_MINE = "recShiftNotMine01";
const OLD_SHIFT = "recShiftOld000001";
const COUNTER_ROW = "recCounter0000001";
/// Well-formed and absent from the fixture: the "unknown id" case.
const GHOST_REF = "vakt_recGhost000000001";

// --- Airtable fixtures ----------------------------------------------------

const shiftRecords = [
  { id: EVENING, fields: { [SHIFT.date]: TODAY, [SHIFT.shift]: "Evening", [SHIFT.driver]: [RUNAR, MATAS], [SHIFT.comment]: "Muna kælitöskuna ⟦Umsóknir⟧ Matas sótti um" } },
  { id: MORNING, fields: { [SHIFT.date]: TODAY, [SHIFT.shift]: "Morning", [SHIFT.driver]: [RUNAR] } },
  { id: NOT_MINE, fields: { [SHIFT.date]: TODAY, [SHIFT.shift]: "Morning", [SHIFT.driver]: [MATAS] } },
  // today−9: inside the 35-day window, outside the today−7 detail limit.
  { id: OLD_SHIFT, fields: { [SHIFT.date]: "2026-09-02", [SHIFT.shift]: "Morning", [SHIFT.driver]: [RUNAR] } },
];

const counterRecords = [
  { id: COUNTER_ROW, fields: { [COUNTER.date]: NEXT, [COUNTER.slot]: "Morning", [COUNTER.staff]: [RUNAR], [COUNTER.status]: "Open", [COUNTER.notes]: "Fyrsti dagur" } },
  { id: "recCounter0000002", fields: { [COUNTER.date]: NEXT, [COUNTER.slot]: "Midday", [COUNTER.staff]: [RUNAR], [COUNTER.status]: "Cancelled" } },
];

const order = ({ id, num, date, slot, paid = true, bags = 1 }) => ({
  id,
  fields: {
    [ORDER.orderNumber]: num,
    [ORDER.pickupDate]: date,
    [ORDER.shiftFormula]: slot,
    [ORDER.paid]: paid,
    [ORDER.totalBags]: bags,
    [ORDER.customerName]: "Viðskiptavinur",
    [ORDER.requestedService]: "Check-in service",
    [ORDER.reference]: "FSEB-1",
    [ORDER.timeWindow]: "04:00 - 05:00",
    [ORDER.pickupAddress]: "Pósthússtræti 11",
    [ORDER.deliveryAddress]: "Keflavík International Airport",
    [ORDER.phone]: "+3545550000",
  },
});

const orderRecords = [
  order({ id: "recOrd00000000001", num: "aaaa1", date: TODAY, slot: "Evening", bags: 3 }),
  order({ id: "recOrd00000000002", num: "bbbb2", date: TODAY, slot: "Evening", bags: 2 }),
  // Paid, in the Evening set, never planned: the unplanned row.
  order({ id: "recOrd00000000003", num: "cccc3", date: TODAY, slot: "Evening", bags: 4 }),
  order({ id: "recOrd00000000004", num: "dddd4", date: TODAY, slot: "Morning", bags: 1 }),
];

const stopRecords = [
  {
    id: "recStop0000000001",
    fields: {
      [STOP.orderNumber]: "aaaa1", [STOP.orderDate]: [TODAY], [STOP.stopNumber]: 1,
      [STOP.scheduledAt]: "17:09", [STOP.scheduledAtDt]: `${TODAY} 17:09:00`,
      [STOP.driver]: "BagBee driver 1 01", [STOP.locationName]: "Hótel Borg",
      [STOP.address]: "Pósthússtræti 11", [STOP.latitude]: 64.147, [STOP.longitude]: -21.94,
      [STOP.pickupCompleted]: false,
    },
  },
  {
    id: "recStop0000000002",
    fields: {
      [STOP.orderNumber]: "aaaa1-D", [STOP.orderDate]: [TODAY], [STOP.stopNumber]: 8,
      [STOP.scheduledAt]: "01:11", [STOP.scheduledAtDt]: `${NEXT} 01:11:00`,
      [STOP.driver]: "BagBee driver 1 01", [STOP.deliveryCompleted]: false,
    },
  },
  {
    id: "recStop0000000003",
    fields: {
      [STOP.orderNumber]: "bbbb2", [STOP.orderDate]: [TODAY], [STOP.stopNumber]: 2,
      [STOP.scheduledAt]: "18:30", [STOP.scheduledAtDt]: `${TODAY} 18:30:00`,
      [STOP.driver]: "BagBee driver 1 01",
    },
  },
];

function fakeAirtable({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async listAll(table, opts = {}) {
      if (fail) throw Object.assign(new Error(fail), { code: fail });
      calls.push({ table, ...opts });
      const formula = opts.filterByFormula || "";
      if (table === TABLES.orders) {
        const sameDay = /IS_SAME\(\{[^}]+\},'(\d{4}-\d{2}-\d{2})','day'\)/.exec(formula);
        if (sameDay) return { records: orderRecords.filter((o) => o.fields[ORDER.pickupDate] === sameDay[1]), pages: 1 };
        const numbers = [...formula.matchAll(/\{fldo3soPBdIjoOv7H\}='([^']+)'/g)].map((m) => m[1]);
        if (numbers.length) return { records: orderRecords.filter((o) => numbers.includes(o.fields[ORDER.orderNumber])), pages: 1 };
        return { records: orderRecords, pages: 1 };
      }
      if (table === TABLES.shifts) return { records: shiftRecords, pages: 1 };
      if (table === TABLES.counter) return { records: counterRecords, pages: 1 };
      if (table === TABLES.stops) return { records: stopRecords, pages: 1 };
      return { records: [], pages: 1 };
    },
    async getByIds() {
      return [];
    },
  };
}

const fakeRoster = {
  async getRoster() {
    return {
      byId: new Map([
        [RUNAR, { airtableId: RUNAR, displayName: "Rúnar", active: true }],
        [MATAS, { airtableId: MATAS, displayName: "Matas", active: true }],
      ]),
      stale: false,
    };
  },
};

// --- harness --------------------------------------------------------------

async function serve({ airtable = fakeAirtable(), envOver = {} } = {}) {
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

  const people = {};
  for (const [key, airtableId, name] of [["runar", RUNAR, "Rúnar"], ["matas", MATAS, "Matas"]]) {
    const { rows: [staff] } = await db.query(
      `INSERT INTO staff (airtable_record_id, name, login_email, airtable_status)
       VALUES ($1, $2, $3, 'Active') RETURNING id`,
      [airtableId, name, `${key}@example.is`],
    );
    const { rows: [device] } = await db.query(
      "INSERT INTO devices (installation_id, staff_id) VALUES ($1, $2) RETURNING id",
      [crypto.randomUUID(), staff.id],
    );
    const { rows: [session] } = await db.query(
      `INSERT INTO sessions (staff_id, device_id, refresh_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '180 days') RETURNING id`,
      [staff.id, device.id, crypto.randomBytes(16).toString("hex")],
    );
    people[key] = { staffId: staff.id, deviceId: device.id, sessionId: session.id, airtableId };
  }

  let caller = people.runar;
  const now = () => NOW_MS;
  const clock = () => new Date(NOW_MS);
  const shifts = createShiftsService({ airtable, config, now, logger: QUIET });
  const detail = createShiftDetail({ airtable, shifts, roster: fakeRoster, config, now, logger: QUIET });

  const app = express();
  app.use("/v2", express.json({ limit: "32kb" }));
  app.use("/v2", createV2Router({
    db,
    config,
    apns: () => ({ status: "missing", client: null }),
    hit: createThrottle(db, clock),
    clock,
    shifts,
    detail,
    /// Only loadStaffRow is reached from the shift routes (the office mail needs a
    /// name); the rest of identity belongs to /v2/me, which is B3's own test.
    identity: {
      loadStaffRow: async (id) => (await db.query("SELECT id, name FROM staff WHERE id = $1", [id])).rows[0] || null,
    },
    mailer: { async send() { return { providerId: "test" }; } },
    requireStaff: (req, res, next) => {
      req.staff = {
        id: caller.staffId, sessionId: caller.sessionId, deviceId: caller.deviceId,
        airtableId: caller.airtableId, teams: ["Drivers"], role: "staff",
      };
      next();
    },
  }));

  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();

  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  };

  return {
    db, get, people, airtable,
    as: (who) => { caller = people[who]; },
    close: async () => { await new Promise((r) => server.close(r)); await db.end(); },
  };
}

// --- the list -------------------------------------------------------------

test("the list carries only the caller's shifts, in date and slot order", async (t) => {
  const h = await serve();
  t.after(h.close);

  const { status, body } = await h.get("/v2/me/shifts");
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ["from", "to", "generatedAt", "stale", "shifts"]);
  assert.equal(body.from, "2026-09-04");            // today − 7
  assert.equal(body.to, "2026-10-11");              // today + 30
  assert.equal(body.generatedAt, `${TODAY}T20:00:00Z`);
  assert.equal(body.stale, false);

  const refs = body.shifts.map((s) => s.ref);
  assert.deepEqual(refs, [
    `vakt_${MORNING}`,                               // 09-11 Morning
    `vakt_${EVENING}`,                               // 09-11 Evening
    `bsi_${COUNTER_ROW}`,                            // 09-12 counter
  ]);
  assert.ok(!refs.includes(`vakt_${NOT_MINE}`), "another driver's shift is not in the list");
  assert.ok(!refs.includes(`vakt_${OLD_SHIFT}`), "today−9 is outside the default from=today−7");
  assert.ok(!refs.some((r) => r === "bsi_recCounter0000002"), "a Cancelled counter row is hidden");
});

test("a StaffShift has every key the app decodes, with the driving values filled in", async (t) => {
  const h = await serve();
  t.after(h.close);

  const { body } = await h.get("/v2/me/shifts");
  const evening = body.shifts.find((s) => s.ref === `vakt_${EVENING}`);

  assert.deepEqual(Object.keys(evening), [
    "ref", "kind", "airtableId", "date", "slot", "label", "startTime", "endTime",
    "role", "orderCount", "bagCount", "comment", "status", "plan", "confirmation",
  ]);
  assert.equal(evening.kind, "driving");
  assert.equal(evening.airtableId, EVENING);
  assert.equal(evening.label, "Kvöldvakt");
  assert.equal(evening.role, "driver");
  assert.equal(evening.orderCount, 3);
  assert.equal(evening.bagCount, 9);
  assert.equal(evening.comment, "Muna kælitöskuna", "the ⟦Umsóknir⟧ block is stripped");
  assert.equal(evening.status, null);
  assert.equal(evening.confirmation, null);
  /// Evening dated today at 20:00 — the tonight window closed at 18:00.
  assert.equal(evening.plan.state, "none");
});

test("a counter shift carries its hours, its status and no plan", async (t) => {
  const h = await serve();
  t.after(h.close);

  const { body } = await h.get("/v2/me/shifts");
  const counter = body.shifts.find((s) => s.ref === `bsi_${COUNTER_ROW}`);

  assert.equal(counter.kind, "counter");
  assert.equal(counter.label, "BSÍ · Morgunn");
  assert.equal(counter.role, "counter");
  assert.equal(counter.startTime, "09:00", "blank Start falls back to the fixed hours");
  assert.equal(counter.endTime, "13:00");
  assert.equal(counter.status, "Open");
  assert.equal(counter.comment, "Fyrsti dagur");
  assert.equal(counter.plan, null);
  assert.equal(counter.orderCount, 0);
  assert.equal(counter.bagCount, 0);
});

test("plan comes from plan_snapshots: the published version, counts from the latest", async (t) => {
  const h = await serve();
  t.after(h.close);

  const base = {
    ref: `vakt_${EVENING}`, date: TODAY, slot: "Evening",
  };
  for (const [version, published, stops, bags, first] of [
    [1, null, 8, 20, "17:00"],
    [3, `${TODAY}T15:10:00.123Z`, 10, 24, "17:05"],
    [4, null, 11, 26, "17:09"],
  ]) {
    await h.db.query(
      `INSERT INTO plan_snapshots
         (shift_ref, plan_date, slot, version, plan_hash, stop_count, bag_count,
          expected_order_count, planned_order_count, order_numbers, first_stop_at, first_stop_name, routes, published_at)
       VALUES ($1, $2::date, $3, $4, 'h', $5, $6, 3, 2, '{}'::text[], $7, 'Hótel Borg', '[]'::jsonb, $8)`,
      [base.ref, base.date, base.slot, version, stops, bags, first, published],
    );
  }

  const { body } = await h.get("/v2/me/shifts");
  const evening = body.shifts.find((s) => s.ref === base.ref);

  assert.deepEqual(evening.plan, {
    state: "published",
    version: 3,                                       // what people were told
    latestVersion: 4,
    stopCount: 11,                                    // …but the freshest counts
    bagCount: 26,
    firstStopAt: "17:09",
    firstStopName: "Hótel Borg",
    publishedAt: `${TODAY}T15:10:00Z`,                // isoSec drops the millis
  });
});

test("confirmation comes from current_shift_confirmations, latest answer only", async (t) => {
  const h = await serve();
  t.after(h.close);

  const insert = (answer, answeredAt, planVersion, source) => h.db.query(
    `INSERT INTO shift_confirmations
       (shift_ref, shift_date, staff_id, answer, answered_at, source, plan_version, client_event_id)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)`,
    [`vakt_${EVENING}`, TODAY, h.people.runar.staffId, answer, answeredAt, source, planVersion, crypto.randomUUID()],
  );
  await insert("no", `${TODAY}T10:00:00Z`, 2, "app");
  await insert("yes", `${TODAY}T11:30:40Z`, 3, "push_action");
  // Another person's answer on the same shift must not leak into this list.
  await h.db.query(
    `INSERT INTO shift_confirmations
       (shift_ref, shift_date, staff_id, answer, answered_at, source, client_event_id)
     VALUES ($1, $2::date, $3, 'no', $4, 'app', $5)`,
    [`vakt_${EVENING}`, TODAY, h.people.matas.staffId, `${TODAY}T12:00:00Z`, crypto.randomUUID()],
  );

  const { body } = await h.get("/v2/me/shifts");
  const evening = body.shifts.find((s) => s.ref === `vakt_${EVENING}`);
  assert.deepEqual(evening.confirmation, {
    answer: "yes",
    answeredAt: `${TODAY}T11:30:40Z`,
    planVersion: 3,
    source: "push_action",
  });

  h.as("matas");
  const mine = await h.get("/v2/me/shifts");
  const matasEvening = mine.body.shifts.find((s) => s.ref === `vakt_${EVENING}`);
  assert.equal(matasEvening.confirmation.answer, "no", "each person sees their own answer");
});

test("an explicit range is honoured and a bad one is refused", async (t) => {
  const h = await serve();
  t.after(h.close);

  const ok = await h.get(`/v2/me/shifts?from=${TODAY}&to=${TODAY}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.shifts.map((s) => s.ref), [`vakt_${MORNING}`, `vakt_${EVENING}`]);

  for (const query of [
    "?from=2026-13-01&to=2026-09-20",          // not a month
    "?from=2026-02-31&to=2026-09-20",          // does not round-trip
    "?from=2026-09-20&to=2026-09-11",          // from after to
    "?from=2026-06-01&to=2026-06-20",          // before today−35
    "?from=2026-09-01&to=2026-11-20",          // span over 62 days
    "?from=yesterday",                          // not a date at all
  ]) {
    const res = await h.get(`/v2/me/shifts${query}`);
    assert.equal(res.status, 400, `expected 400 for ${query}`);
    assert.deepEqual(res.body, { error: "invalid_range" });
  }
});

test("a range reaching back to today−9 shows the old shift again", async (t) => {
  const h = await serve();
  t.after(h.close);

  const { body } = await h.get("/v2/me/shifts?from=2026-09-01&to=2026-09-11");
  assert.ok(body.shifts.some((s) => s.ref === `vakt_${OLD_SHIFT}`));
});

// --- the detail -----------------------------------------------------------

test("the detail of an own shift has every documented key and a complete PlannedStop", async (t) => {
  const h = await serve();
  t.after(h.close);

  const { status, body } = await h.get(`/v2/me/shifts/vakt_${EVENING}`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), [
    "shift", "source", "fetchedAt", "stale", "routes", "orders", "unplannedOrderCount", "crew",
  ]);
  assert.equal(body.source, "airtable_stops");
  assert.equal(body.stale, false);
  assert.equal(typeof body.fetchedAt, "string");
  assert.equal(body.shift.ref, `vakt_${EVENING}`);

  assert.equal(body.routes.length, 1);
  assert.equal(body.routes[0].driver, "BagBee driver 1 01");
  const stop = body.routes[0].stops[0];
  assert.deepEqual(Object.keys(stop), [
    "stopNumber", "scheduledAt", "driver", "leg", "done", "locationName", "address",
    "orderNumber", "recordId", "stopRecordId", "optimoOrderNo", "latitude", "longitude",
    "phone", "customerName", "requestedService", "reference", "totalBags", "timeWindow", "trackingURL",
  ]);
  assert.equal(stop.leg, "pickup");
  assert.equal(stop.orderNumber, "aaaa1");
  assert.equal(stop.phone, "+3545550000", "a pickup leg on today's shift carries the phone");
  assert.equal(body.routes[0].stops.at(-1).orderNumber, "aaaa1", "the post-midnight delivery stays on this route");
  assert.equal(body.routes[0].stops.at(-1).phone, null, "a delivery leg never carries a phone");

  assert.equal(body.unplannedOrderCount, 1);
  assert.equal(body.orders.at(-1).orderNumber, "cccc3");
  assert.equal(body.orders.at(-1).planned, false);
  assert.deepEqual(body.crew, [{ name: "Matas", role: "driver" }], "the caller is not their own crew");
});

test("a counter detail is empty by design", async (t) => {
  const h = await serve();
  t.after(h.close);

  const { status, body } = await h.get(`/v2/me/shifts/bsi_${COUNTER_ROW}`);
  assert.equal(status, 200);
  assert.equal(body.source, "none");
  assert.equal(body.fetchedAt, `${TODAY}T20:00:00Z`);
  assert.equal(body.stale, false);
  assert.deepEqual(body.routes, []);
  assert.deepEqual(body.orders, []);
  assert.deepEqual(body.crew, []);
  assert.equal(body.unplannedOrderCount, 0);
});

test("another person's shift, an unknown ref and an old shift are the same 404", async (t) => {
  const h = await serve();
  t.after(h.close);

  for (const ref of [`vakt_${NOT_MINE}`, GHOST_REF, `vakt_${OLD_SHIFT}`, "bsi_recCounter0000002"]) {
    const res = await h.get(`/v2/me/shifts/${ref}`);
    assert.equal(res.status, 404, `expected 404 for ${ref}`);
    assert.deepEqual(res.body, { error: "not_found" }, "no body ever says which of the three it was");
  }

  // …and Matas, who IS on it, gets the same shift with a 200.
  h.as("matas");
  const mine = await h.get(`/v2/me/shifts/vakt_${NOT_MINE}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.shift.ref, `vakt_${NOT_MINE}`);
});

test("a malformed ref is refused before anything is read", async (t) => {
  const h = await serve();
  t.after(h.close);

  for (const ref of ["nope", "vakt_rec123", "vakt_recShiftEvening0", "shift_recShiftEvening01", "vakt_recShiftEvening01x"]) {
    const res = await h.get(`/v2/me/shifts/${ref}`);
    assert.equal(res.status, 400, `expected 400 for ${ref}`);
    assert.deepEqual(res.body, { error: "invalid_ref" });
  }
});

test("Airtable being unreachable is a 503 with its own code, not a 500", async (t) => {
  const h = await serve({ airtable: fakeAirtable({ fail: "airtable_unavailable" }) });
  t.after(h.close);

  const list = await h.get("/v2/me/shifts");
  assert.equal(list.status, 503);
  assert.deepEqual(list.body, { error: "airtable_unavailable" });

  const detail = await h.get(`/v2/me/shifts/vakt_${EVENING}`);
  assert.equal(detail.status, 503);
  assert.deepEqual(detail.body, { error: "airtable_unavailable" });
});

test("the list and the detail share one 300/h budget", async (t) => {
  const h = await serve();
  t.after(h.close);

  /// Seeded rather than driven 300 times: the limit is what matters, not the wait.
  const windowStart = new Date(Math.floor(NOW_MS / 1000 / 3600) * 3600 * 1000);
  await h.db.query(
    "INSERT INTO auth_throttle (bucket, subject, window_start, hits) VALUES ('shifts_staff', $1, $2, 300)",
    [h.people.runar.staffId, windowStart],
  );

  const res = await h.get(`/v2/me/shifts/vakt_${EVENING}`);
  assert.equal(res.status, 429);
  assert.equal(res.body.error, "rate_limited");
  assert.ok(res.body.retryAfterSeconds > 0);

  // The other person's budget is untouched.
  h.as("matas");
  assert.equal((await h.get("/v2/me/shifts")).status, 200);
});
