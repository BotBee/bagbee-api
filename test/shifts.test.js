// Spec §10.1 test/shifts.test.js — membership, labels, counts, the plan state
// and the range rules of GET /v2/me/shifts. Airtable is a fixture; the clock is
// injected; nothing here touches the network.

import test from "node:test";
import assert from "node:assert/strict";

import { COUNTER, ORDER, SHIFT, TABLES } from "../src/airtable/fields.js";
import {
  counterLabel,
  counterTimes,
  createShiftsService,
  driverRoleFor,
  drivingLabel,
  normalizeShiftRow,
  parseShiftRef,
  planStateFor,
  sortShifts,
  stripApplications,
  validateRange,
} from "../src/staff/shifts.js";

const TODAY = "2026-09-15";
const TOMORROW = "2026-09-16";
const NOW = Date.parse(`${TODAY}T10:00:00Z`);
const silent = { error: () => {}, warn: () => {}, info: () => {} };

const MATAS = "recMatas000000001";
const RUNAR = "recRunar000000001";
const VALGEIR = "recValgeir0000001";

function shiftRecord({ id, date, slot = "Morning", drivers = [], extra = [], other = [], comment = "", startsAt = null, starfsmadur = [] }) {
  return {
    id,
    fields: {
      [SHIFT.date]: date,
      [SHIFT.shift]: slot,
      [SHIFT.vaktByrjar]: startsAt,
      [SHIFT.driver]: drivers,
      [SHIFT.extraDriver]: extra,
      [SHIFT.other]: other,
      [SHIFT.starfsmadur]: starfsmadur,
      [SHIFT.comment]: comment,
    },
  };
}

function counterRecord({ id, date, slot = "Morning", start = "", end = "", staff = [], status = "Scheduled", notes = "" }) {
  return {
    id,
    fields: {
      [COUNTER.date]: date,
      [COUNTER.slot]: slot,
      [COUNTER.start]: start,
      [COUNTER.end]: end,
      [COUNTER.staff]: staff,
      [COUNTER.status]: status,
      [COUNTER.notes]: notes,
    },
  };
}

function orderRecord({ id, num, date, paid = true, bags = 1, formula = "Unknown", links = [] }) {
  return {
    id,
    fields: {
      [ORDER.orderNumber]: num,
      [ORDER.pickupDate]: date,
      [ORDER.paid]: paid,
      [ORDER.totalBags]: bags,
      [ORDER.shiftFormula]: formula,
      [ORDER.shiftLink]: links,
    },
  };
}

/// Fixture client. Records every call so the tests can assert that reads use
/// field ids and an explicit field list.
function fakeAirtable({ shifts = [], counter = [], orders = [], staff = [], failTables = new Set() }) {
  const calls = [];
  const byTable = {
    [TABLES.shifts]: shifts,
    [TABLES.counter]: counter,
    [TABLES.orders]: orders,
    [TABLES.staff]: staff,
  };
  return {
    calls,
    failTables,
    async listAll(table, opts = {}) {
      calls.push({ table, ...opts });
      if (failTables.has(table)) {
        const err = new Error("airtable_unavailable");
        err.code = "airtable_unavailable";
        throw err;
      }
      return { records: byTable[table] || [], pages: 1 };
    },
    async getByIds(table, ids) {
      calls.push({ table, ids });
      return (byTable[table] || []).filter((r) => ids.includes(r.id));
    },
  };
}

const service = (fixtures, over = {}) =>
  createShiftsService({ airtable: fakeAirtable(fixtures), now: () => NOW, logger: silent, ...over });

const staffOf = (airtableId) => ({ airtableId, id: "uuid", name: "Test" });

// --- membership -----------------------------------------------------------

test("driverRoleFor: every Bílstjóri link on a two-person shift is a driver", () => {
  const row = normalizeShiftRow(shiftRecord({ id: "recShift000000001", date: TODAY, drivers: [MATAS, RUNAR] }));
  assert.equal(driverRoleFor(row, MATAS), "driver");
  assert.equal(driverRoleFor(row, RUNAR), "driver");
  assert.equal(driverRoleFor(row, VALGEIR), null);
});

test("driverRoleFor: Extra driver and Aðrir starfsmenn keep their own roles", () => {
  const row = normalizeShiftRow(
    shiftRecord({ id: "recShift000000002", date: TODAY, drivers: [MATAS], extra: [RUNAR], other: [VALGEIR] })
  );
  assert.equal(driverRoleFor(row, RUNAR), "extra");
  assert.equal(driverRoleFor(row, VALGEIR), "other");
});

/// The old first-name rule is gone on purpose: Starfsmaður was last used
/// 2025-12-30 and its options do not match the roster's First values.
test("driverRoleFor: a Starfsmaður value alone is not membership", () => {
  const row = normalizeShiftRow(shiftRecord({ id: "recShift000000003", date: TODAY, starfsmadur: ["Rúnar"] }));
  assert.equal(driverRoleFor(row, RUNAR), null);
  assert.equal(driverRoleFor(row, null), null);
});

test("a two-person shift is listed for both drivers", async () => {
  const fixtures = { shifts: [shiftRecord({ id: "recShift000000004", date: TODAY, drivers: [MATAS, RUNAR] })] };
  for (const person of [MATAS, RUNAR]) {
    const out = await service(fixtures).listShiftsForStaff({ staff: staffOf(person) });
    assert.equal(out.shifts.length, 1);
    assert.equal(out.shifts[0].role, "driver");
    assert.equal(out.shifts[0].ref, "vakt_recShift000000004");
    assert.equal(out.shifts[0].kind, "driving");
  }
  const stranger = await service(fixtures).listShiftsForStaff({ staff: staffOf(VALGEIR) });
  assert.equal(stranger.shifts.length, 0);
});

// --- counter shifts -------------------------------------------------------

test("a staffed Open counter row is listed, a Cancelled one is hidden", async () => {
  const out = await service({
    counter: [
      counterRecord({ id: "recBsi00000000001", date: TODAY, slot: "Morning", staff: [RUNAR], status: "Open" }),
      counterRecord({ id: "recBsi00000000002", date: TODAY, slot: "Midday", staff: [RUNAR], status: "Cancelled" }),
      counterRecord({ id: "recBsi00000000003", date: TODAY, slot: "Midday", staff: [VALGEIR], status: "Scheduled" }),
    ],
  }).listShiftsForStaff({ staff: staffOf(RUNAR) });

  assert.deepEqual(out.shifts.map((s) => s.ref), ["bsi_recBsi00000000001"]);
  const shift = out.shifts[0];
  assert.equal(shift.kind, "counter");
  assert.equal(shift.label, "BSÍ · Morgunn");
  assert.equal(shift.role, "counter");
  assert.equal(shift.status, "Open");
  assert.equal(shift.plan, null);
  assert.equal(shift.orderCount, 0);
  assert.equal(shift.bagCount, 0);
});

test("blank counter times fall back to the standing hours", () => {
  assert.deepEqual(counterTimes({ slot: "Morning", start: "", end: "" }), { startTime: "09:00", endTime: "13:00" });
  assert.deepEqual(counterTimes({ slot: "Midday", start: "", end: "" }), { startTime: "13:00", endTime: "17:00" });
  assert.deepEqual(counterTimes({ slot: "Custom", start: "", end: "" }), { startTime: null, endTime: null });
  assert.deepEqual(counterTimes({ slot: "Custom", start: "11:30", end: "19:00" }), { startTime: "11:30", endTime: "19:00" });
  // Free text that is not a time must not reach the app as a time.
  assert.deepEqual(counterTimes({ slot: "Morning", start: "níu", end: "" }), { startTime: "09:00", endTime: "13:00" });
});

test("labels are the exact Icelandic strings from the spec", () => {
  assert.equal(drivingLabel("Morning"), "Morgunvakt");
  assert.equal(drivingLabel("Evening"), "Kvöldvakt");
  assert.equal(counterLabel("Morning"), "BSÍ · Morgunn");
  assert.equal(counterLabel("Midday"), "BSÍ · Miðdagur");
  assert.equal(counterLabel("Custom"), "BSÍ · Sérvakt");
});

// --- shape ----------------------------------------------------------------

test("shifts sort by date, then Morning < Midday < Evening < Custom", () => {
  const mk = (date, slot, startTime = null) => ({ date, slot, startTime, ref: `${date}-${slot}` });
  const sorted = sortShifts([
    mk("2026-09-16", "Morning"),
    mk(TODAY, "Custom"),
    mk(TODAY, "Evening"),
    mk(TODAY, "Morning"),
    mk(TODAY, "Midday"),
  ]);
  assert.deepEqual(sorted.map((s) => s.ref), [
    `${TODAY}-Morning`,
    `${TODAY}-Midday`,
    `${TODAY}-Evening`,
    `${TODAY}-Custom`,
    "2026-09-16-Morning",
  ]);
});

test("the applications block is stripped out of the ops comment", async () => {
  const raw = "Muna lyklana að BSÍ\n\n⟦Umsóknir⟧\nJón Jónsson | jon@x.is | 2026-06-21";
  assert.equal(stripApplications(raw), "Muna lyklana að BSÍ");
  assert.equal(stripApplications(""), "");
  assert.equal(stripApplications(undefined), "");

  const out = await service({
    shifts: [shiftRecord({ id: "recShift000000005", date: TODAY, drivers: [RUNAR], comment: raw })],
  }).listShiftsForStaff({ staff: staffOf(RUNAR) });
  assert.equal(out.shifts[0].comment, "Muna lyklana að BSÍ");
});

test("orderCount and bagCount come from the Greitt orders of that (date, slot)", async () => {
  const out = await service({
    shifts: [
      shiftRecord({ id: "recShiftMorning01", date: TODAY, slot: "Morning", drivers: [RUNAR] }),
      shiftRecord({ id: "recShiftEvening01", date: TODAY, slot: "Evening", drivers: [RUNAR] }),
    ],
    orders: [
      orderRecord({ id: "recO1", num: "aaaaa", date: TODAY, formula: "Morning", bags: 3 }),
      orderRecord({ id: "recO2", num: "bbbbb", date: TODAY, formula: "Morning", bags: 8 }),
      orderRecord({ id: "recO3", num: "ccccc", date: TODAY, formula: "Morning", bags: 5, paid: false }),
      orderRecord({ id: "recO4", num: "ddddd", date: TODAY, links: ["recShiftEvening01"], bags: 2 }),
      orderRecord({ id: "recO5", num: "eeeee", date: TOMORROW, formula: "Morning", bags: 9 }),
    ],
  }).listShiftsForStaff({ staff: staffOf(RUNAR) });

  const morning = out.shifts.find((s) => s.slot === "Morning");
  const evening = out.shifts.find((s) => s.slot === "Evening");
  assert.deepEqual([morning.orderCount, morning.bagCount], [2, 11]);
  assert.deepEqual([evening.orderCount, evening.bagCount], [1, 2]);
});

test("Vakt byrjar is read as Iceland wall time, whatever the process time zone is", async () => {
  const original = process.env.TZ;
  try {
    for (const tz of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = tz;
      const out = await service({
        shifts: [
          shiftRecord({
            id: "recShift000000006",
            date: TODAY,
            drivers: [RUNAR],
            startsAt: `${TODAY}T05:30:00.000Z`,
          }),
        ],
      }).listShiftsForStaff({ staff: staffOf(RUNAR) });
      assert.equal(out.shifts[0].startTime, "05:30", tz);
      assert.equal(out.shifts[0].date, TODAY, tz);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("generatedAt has no milliseconds, so Swift's .iso8601 can decode it", async () => {
  const out = await service({}).listShiftsForStaff({
    staff: staffOf(RUNAR),
    nowDate: new Date(Date.parse(`${TODAY}T10:00:00.456Z`)),
  });
  assert.equal(out.generatedAt, `${TODAY}T10:00:00Z`);
});

test("window reads use field ids and an explicit field list", async () => {
  const airtable = fakeAirtable({ shifts: [shiftRecord({ id: "recShift000000007", date: TODAY, drivers: [RUNAR] })] });
  const svc = createShiftsService({ airtable, now: () => NOW, logger: silent });
  await svc.listShiftsForStaff({ staff: staffOf(RUNAR) });

  const vakt = airtable.calls.find((c) => c.table === TABLES.shifts);
  assert.ok(vakt.filterByFormula.includes(`{${SHIFT.date}}`));
  assert.ok(vakt.filterByFormula.includes("2026-08-11")); // today − 35
  assert.ok(vakt.filterByFormula.includes("2026-10-30")); // today + 45
  assert.deepEqual(vakt.fields, [SHIFT.date, SHIFT.shift, SHIFT.vaktByrjar, SHIFT.driver, SHIFT.extraDriver, SHIFT.other, SHIFT.comment]);
  assert.ok(!vakt.fields.includes(SHIFT.starfsmadur), "Starfsmaður is not read in slice 1");

  const bsi = airtable.calls.find((c) => c.table === TABLES.counter);
  assert.ok(bsi.filterByFormula.includes(`{${COUNTER.date}}`));
  const orders = airtable.calls.find((c) => c.table === TABLES.orders);
  assert.ok(orders.filterByFormula.includes(`{${ORDER.pickupDate}}`));
  assert.ok(!orders.fields.includes(ORDER.phone), "the list read must not pull customer phone numbers");
});

test("windows are cached and shared: a second call makes no new Airtable request", async () => {
  const airtable = fakeAirtable({ shifts: [shiftRecord({ id: "recShift000000008", date: TODAY, drivers: [RUNAR] })] });
  const svc = createShiftsService({ airtable, now: () => NOW, logger: silent });
  await svc.listShiftsForStaff({ staff: staffOf(RUNAR) });
  const after = airtable.calls.length;
  await svc.listShiftsForStaff({ staff: staffOf(MATAS) });
  assert.equal(airtable.calls.length, after);
});

test("an Airtable outage serves the cached window with stale:true", async () => {
  const airtable = fakeAirtable({ shifts: [shiftRecord({ id: "recShift000000009", date: TODAY, drivers: [RUNAR] })] });
  let clock = NOW;
  const svc = createShiftsService({ airtable, now: () => clock, logger: silent });

  const first = await svc.listShiftsForStaff({ staff: staffOf(RUNAR) });
  assert.equal(first.stale, false);

  clock = NOW + 10 * 60 * 1000; // past the 5 min TTL
  airtable.failTables.add(TABLES.shifts);
  const second = await svc.listShiftsForStaff({ staff: staffOf(RUNAR) });
  assert.equal(second.stale, true);
  assert.equal(second.shifts.length, 1, "the driver still sees the shift");
});

// --- range validation -----------------------------------------------------

test("validateRange applies the defaults and refuses everything §4.5 refuses", () => {
  assert.deepEqual(validateRange({ today: TODAY }), { ok: true, from: "2026-09-08", to: "2026-10-15" });
  assert.deepEqual(validateRange({ from: "2026-08-11", to: TODAY, today: TODAY }).ok, true); // exactly today − 35

  for (const bad of [
    { from: "2026-08-10", to: TODAY }, // before today − 35
    { from: "not-a-date", to: TODAY },
    { from: "2026-02-31", to: TODAY }, // does not round-trip
    { from: "2026-9-1", to: TODAY },
    { from: TOMORROW, to: TODAY }, // from > to
    { from: "2026-09-01", to: "2026-11-05" }, // span > 62 days
  ]) {
    assert.deepEqual(validateRange({ ...bad, today: TODAY }), { ok: false, error: "invalid_range" }, JSON.stringify(bad));
  }

  assert.equal(validateRange({ from: "2026-09-01", to: "2026-11-02", today: TODAY }).ok, true); // exactly 62 days
});

test("an invalid range never reaches Airtable", async () => {
  const airtable = fakeAirtable({});
  const svc = createShiftsService({ airtable, now: () => NOW, logger: silent });
  const out = await svc.listShiftsForStaff({ staff: staffOf(RUNAR), from: "2026-01-01" });
  assert.deepEqual(out, { ok: false, error: "invalid_range" });
  assert.equal(airtable.calls.length, 0);
});

// --- plan state -----------------------------------------------------------

const at = (hhmm, date = TODAY) => Date.parse(`${date}T${hhmm}:00Z`);

test("plan.state: an unpublished tomorrow Morning is pending until the window closes", () => {
  const args = { date: TOMORROW, slot: "Morning", plan: null };
  assert.equal(planStateFor({ ...args, now: at("21:29") }).state, "pending");
  assert.equal(planStateFor({ ...args, now: at("21:31") }).state, "none");
});

/// On the day itself the app must show order counts, never "Áætlun kemur ~17:00".
test("plan.state: an unpublished Morning dated today is none", () => {
  assert.equal(planStateFor({ date: TODAY, slot: "Morning", plan: null, now: at("06:00") }).state, "none");
});

test("plan.state: an unpublished Evening today is pending until 18:00", () => {
  const args = { date: TODAY, slot: "Evening", plan: null };
  assert.equal(planStateFor({ ...args, now: at("17:59") }).state, "pending");
  assert.equal(planStateFor({ ...args, now: at("18:01") }).state, "none");
  // Tomorrow's Evening is never computed the evening before.
  assert.equal(planStateFor({ date: TOMORROW, slot: "Evening", plan: null, now: at("17:00") }).state, "none");
});

test("plan.state: a version marked while PLAN_PUSH_TONIGHT=0 still reads as published", () => {
  const plan = {
    published: { version: 3, publishedAt: `${TODAY}T15:10:00.123Z` },
    latest: { version: 4, stopCount: 11, bagCount: 26, firstStopAt: "05:25", firstStopName: "Hótel Borg" },
  };
  const state = planStateFor({ date: TODAY, slot: "Evening", plan, now: at("23:00") });
  assert.deepEqual(state, {
    state: "published",
    version: 3,
    latestVersion: 4,
    stopCount: 11,
    bagCount: 26,
    firstStopAt: "05:25",
    firstStopName: "Hótel Borg",
    publishedAt: `${TODAY}T15:10:00Z`,
  });
});

test("plan.state: none carries null versions and zero counts", () => {
  assert.deepEqual(planStateFor({ date: "2026-09-01", slot: "Morning", plan: null, now: NOW }), {
    state: "none",
    version: null,
    latestVersion: null,
    stopCount: 0,
    bagCount: 0,
    firstStopAt: null,
    firstStopName: null,
    publishedAt: null,
  });
});

// --- single shift ---------------------------------------------------------

test("parseShiftRef accepts only the two prefixes and a real record id", () => {
  assert.deepEqual(parseShiftRef("vakt_recShift000000001"), {
    kind: "driving",
    prefix: "vakt",
    airtableId: "recShift000000001",
  });
  assert.equal(parseShiftRef("bsi_recBsi00000000001").kind, "counter");
  for (const bad of ["", "vakt_", "vakt_rec123", "shift_recShift000000001", "vakt_recShift00000000123", null]) {
    assert.equal(parseShiftRef(bad), null, String(bad));
  }
});

test("getShiftForStaff answers not_found for a stranger, a stale date and a bad ref alike", async () => {
  const svc = service({
    shifts: [
      shiftRecord({ id: "recShiftMine00001", date: TODAY, drivers: [RUNAR] }),
      shiftRecord({ id: "recShiftTheirs001", date: TODAY, drivers: [MATAS] }),
      shiftRecord({ id: "recShiftOld000001", date: "2026-09-01", drivers: [RUNAR] }),
    ],
  });

  const mine = await svc.getShiftForStaff({ staff: staffOf(RUNAR), ref: "vakt_recShiftMine00001" });
  assert.equal(mine.ok, true);
  assert.equal(mine.shift.role, "driver");
  assert.equal(mine.shift.label, "Morgunvakt");

  assert.deepEqual(await svc.getShiftForStaff({ staff: staffOf(RUNAR), ref: "vakt_recShiftTheirs001" }), {
    ok: false,
    error: "not_found",
  });
  assert.deepEqual(await svc.getShiftForStaff({ staff: staffOf(RUNAR), ref: "vakt_recShiftOld000001" }), {
    ok: false,
    error: "not_found",
  });
  assert.deepEqual(await svc.getShiftForStaff({ staff: staffOf(RUNAR), ref: "vakt_recNope0000000001" }), {
    ok: false,
    error: "not_found",
  });
  assert.deepEqual(await svc.getShiftForStaff({ staff: staffOf(RUNAR), ref: "nonsense" }), {
    ok: false,
    error: "invalid_ref",
  });
});
