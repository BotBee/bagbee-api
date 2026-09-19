// Spec §10.1 test/planModel.test.js — the pure read model: which day a route
// belongs to, which crew drives a stop, and which orders were booked for whom.
// Fixtures follow the shape of the live 2026-09-11..14 rows, anonymized.

import test from "node:test";
import assert from "node:assert/strict";

import { ORDER } from "../src/airtable/fields.js";
import {
  DEFAULT_SLOT_SPLIT,
  ROUTE_DAY_CUTOFF,
  assignStops,
  countsForSet,
  groupStopsByDriver,
  normalizeOrder,
  orderSetsByDate,
  orderSetsForDate,
  parseStopDt,
  routeDayOf,
  slotOfOrder,
  slotOfStop,
} from "../src/plan/planModel.js";

const D = "2026-09-11";
const NEXT = "2026-09-12";

function orderRecord({ id = "recOrd00000000001", num, date = D, paid = true, bags = 0, formula = "Unknown", links = [] }) {
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

const ord = (args) => normalizeOrder(orderRecord(args));

/// Vaktaskipulag rows as the shifts module normalizes them.
const shiftRows = new Map([
  ["recShiftMorning01", { id: "recShiftMorning01", date: D, slot: "Morning" }],
  ["recShiftEvening01", { id: "recShiftEvening01", date: D, slot: "Evening" }],
  ["recShiftOtherDay1", { id: "recShiftOtherDay1", date: NEXT, slot: "Morning" }],
]);

const stop = (over) => ({
  orderNo: "aaaaa",
  base: "aaaaa",
  leg: "pickup",
  stopNumber: 1,
  scheduledAt: null,
  scheduledAtDt: null,
  routeDate: D,
  driver: "BagBee driver 1 01",
  locationName: null,
  address: null,
  ...over,
});

// --- route day ------------------------------------------------------------

test("routeDayOf puts the post-midnight KEF run on the previous day's route", () => {
  assert.equal(ROUTE_DAY_CUTOFF, "03:00");
  // The live 2026-09-12 early rows: order date 09-11, driven by 09-11's evening.
  assert.equal(routeDayOf("2026-09-12 01:11:00"), "2026-09-11");
  assert.equal(routeDayOf("2026-09-12 02:04:00"), "2026-09-11");
  // The next morning's own stops.
  assert.equal(routeDayOf("2026-09-12 05:25:00"), "2026-09-12");
  assert.equal(routeDayOf("2026-09-12 05:55:00"), "2026-09-12");
  // The boundary itself.
  assert.equal(routeDayOf("2026-09-12 02:59:00"), "2026-09-11");
  assert.equal(routeDayOf("2026-09-12 03:00:00"), "2026-09-12");
  // Month and year boundaries must not wrap wrongly.
  assert.equal(routeDayOf("2026-10-01 00:30:00"), "2026-09-30");
  assert.equal(routeDayOf("2027-01-01 02:00:00"), "2026-12-31");
  assert.equal(routeDayOf(""), null);
  assert.equal(routeDayOf("not a date"), null);
});

test("parseStopDt reads Airtable and OptimoRoute spellings as UTC", () => {
  assert.deepEqual(parseStopDt("2026-09-12 01:11:00"), {
    date: "2026-09-12",
    hhmm: "01:11",
    epoch: Date.parse("2026-09-12T01:11:00Z"),
  });
  assert.equal(parseStopDt("2026-09-12T05:25:00Z").hhmm, "05:25");
  assert.equal(parseStopDt("2026-09-12 05:25").hhmm, "05:25");
  assert.equal(parseStopDt(null), null);
});

/// Iceland is UTC, but the machine running the tests need not be. Every time
/// rule must give the same answer in Auckland as in Reykjavík.
test("time rules do not move with the process time zone", () => {
  const original = process.env.TZ;
  try {
    for (const tz of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = tz;
      assert.equal(routeDayOf("2026-09-12 01:11:00"), "2026-09-11", tz);
      assert.equal(routeDayOf("2026-09-12 05:25:00"), "2026-09-12", tz);
      assert.equal(parseStopDt("2026-09-12 01:11:00").epoch, Date.parse("2026-09-12T01:11:00Z"), tz);
      assert.equal(slotOfStop(stop({ scheduledAtDt: `${D} 15:59:00` }), D), "Morning", tz);
      assert.equal(slotOfStop(stop({ scheduledAtDt: `${D} 16:00:00` }), D), "Evening", tz);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

// --- order sets -----------------------------------------------------------

test("orderSetsForDate prefers the shift link, falls back to the formula", () => {
  const orders = [
    ord({ id: "rec1", num: "linkM", formula: "Evening", links: ["recShiftMorning01"] }), // link wins
    ord({ id: "rec2", num: "formE", formula: "Evening" }),
    ord({ id: "rec3", num: "formM", formula: "Morning" }),
    ord({ id: "rec4", num: "unkwn", formula: "Unknown" }),
    ord({ id: "rec5", num: "oldLk", formula: "Morning", links: ["recShiftOtherDay1"] }), // link to another date
    ord({ id: "rec6", num: "dangl", formula: "Unknown", links: ["recDoesNotExist1"] }),
  ];
  const sets = orderSetsForDate(orders, shiftRows, D);

  assert.deepEqual([...sets.Morning.keys()].sort(), ["formM", "linkM", "oldLk"]);
  assert.deepEqual([...sets.Evening.keys()], ["formE"]);
  assert.deepEqual([...sets.unassigned.keys()].sort(), ["dangl", "unkwn"]);
  assert.equal(slotOfOrder(ord({ num: "x", formula: "Unknown" }), shiftRows, D), null);
});

test("orderSetsByDate buckets by the order's own pickup date", () => {
  const sets = orderSetsByDate(
    [
      ord({ id: "rec1", num: "a", date: D, formula: "Morning" }),
      ord({ id: "rec2", num: "b", date: NEXT, formula: "Morning" }),
    ],
    shiftRows
  );
  assert.deepEqual([...sets.keys()].sort(), [D, NEXT]);
  assert.deepEqual([...sets.get(D).Morning.keys()], ["a"]);
  assert.deepEqual([...sets.get(NEXT).Morning.keys()], ["b"]);
});

test("counts use Greitt orders only, never the rollup", () => {
  const sets = orderSetsForDate(
    [
      ord({ id: "rec1", num: "paid1", formula: "Morning", paid: true, bags: 4 }),
      ord({ id: "rec2", num: "paid2", formula: "Morning", paid: true, bags: 7 }),
      ord({ id: "rec3", num: "unpai", formula: "Morning", paid: false, bags: 99 }),
    ],
    shiftRows,
    D
  );
  assert.deepEqual(countsForSet(sets.Morning), { orderCount: 2, bagCount: 11 });
  assert.deepEqual(countsForSet(sets.Evening), { orderCount: 0, bagCount: 0 });
  assert.deepEqual(countsForSet(undefined), { orderCount: 0, bagCount: 0 });
});

test("normalizeOrder defaults every string to \"\" and every number to 0", () => {
  const o = normalizeOrder({ id: "recEmpty000000001", fields: {} });
  assert.equal(o.customerName, "");
  assert.equal(o.requestedService, "");
  assert.equal(o.reference, "");
  assert.equal(o.timeWindow, "");
  assert.equal(o.totalBags, 0);
  assert.equal(o.paid, false);
  assert.deepEqual(o.shiftLinkIds, []);
});

// --- slot of stop ---------------------------------------------------------

test("slotOfStop splits date D at 16:00 and gives the night run to Evening", () => {
  assert.equal(DEFAULT_SLOT_SPLIT, "16:00");
  assert.equal(slotOfStop(stop({ scheduledAtDt: `${D} 15:59:00` }), D), "Morning");
  assert.equal(slotOfStop(stop({ scheduledAtDt: `${D} 16:00:00` }), D), "Evening");
  assert.equal(slotOfStop(stop({ scheduledAtDt: `${D} 17:09:00` }), D), "Evening");
  // Post-midnight stop of D's evening route, already route-dated D.
  assert.equal(slotOfStop(stop({ scheduledAtDt: `${NEXT} 01:11:00` }), D), "Evening");
  // A custom split moves the boundary.
  assert.equal(slotOfStop(stop({ scheduledAtDt: `${D} 15:59:00` }), D, "15:00"), "Evening");
});

test("slotOfStop excludes anything that is not on D's route", () => {
  assert.equal(slotOfStop(stop({ routeDate: NEXT, scheduledAtDt: `${NEXT} 05:25:00` }), D), null);
  assert.equal(slotOfStop(stop({ routeDate: "2026-09-10", scheduledAtDt: `2026-09-10 09:00:00` }), D), null);
  // Guard: route-dated input cannot have a stop on an earlier calendar day.
  assert.equal(slotOfStop(stop({ routeDate: D, scheduledAtDt: `2026-09-10 23:00:00` }), D), null);
});

test("slotOfStop without a timestamp falls back to the booking, then the clock", () => {
  const sets = orderSetsForDate([ord({ id: "rec1", num: "booked", formula: "Evening" })], shiftRows, D);
  assert.equal(slotOfStop(stop({ base: "booked" }), D, DEFAULT_SLOT_SPLIT, sets), "Evening");
  assert.equal(slotOfStop(stop({ base: "nobook", scheduledAt: "09:30" }), D, DEFAULT_SLOT_SPLIT, sets), "Morning");
  assert.equal(slotOfStop(stop({ base: "nobook", scheduledAt: "18:30" }), D, DEFAULT_SLOT_SPLIT, sets), "Evening");
  // Nothing to go on at all: Evening, so the stop is shown to the crew that is
  // still working rather than to one that has gone home.
  assert.equal(slotOfStop(stop({ base: "nobook" }), D, DEFAULT_SLOT_SPLIT, sets), "Evening");
});

// --- assignStops ----------------------------------------------------------

test("assignStops reports a Morning-booked order driven in the evening", () => {
  const sets = orderSetsForDate([ord({ id: "rec1", num: "4tvvF", formula: "Morning" })], shiftRows, D);
  const logged = [];
  const out = assignStops(
    [
      stop({ orderNo: "4tvvF", base: "4tvvF", scheduledAtDt: `${D} 17:00:00` }),
      stop({ orderNo: "4tvvF-D", base: "4tvvF", leg: "delivery", scheduledAtDt: `${NEXT} 02:04:00` }),
    ],
    sets,
    D,
    DEFAULT_SLOT_SPLIT,
    { logger: { info: (m) => logged.push(m) } }
  );

  assert.equal(out.Morning.length, 0);
  assert.equal(out.Evening.length, 2);
  assert.equal(out.mismatches.length, 2);
  assert.deepEqual(out.mismatches[0], { orderNo: "4tvvF", set: "Morning", stop: "Evening" });
  assert.equal(logged[0], "[plan] slot mismatch 4tvvF set=Morning stop=Evening");
  assert.equal(out.orphanBases.length, 0);
  assert.equal(out.Evening[0].slot, "Evening");
});

test("assignStops collects orphan bases but not orders that are merely unassigned", () => {
  const sets = orderSetsForDate(
    [
      ord({ id: "rec1", num: "known", formula: "Morning" }),
      ord({ id: "rec2", num: "unkwn", formula: "Unknown" }),
    ],
    shiftRows,
    D
  );
  const out = assignStops(
    [
      stop({ orderNo: "known", base: "known", scheduledAtDt: `${D} 09:00:00` }),
      stop({ orderNo: "unkwn", base: "unkwn", scheduledAtDt: `${D} 09:10:00` }),
      stop({ orderNo: "83teD", base: "83teD", scheduledAtDt: `${D} 09:20:00` }),
      stop({ orderNo: "83teD-D", base: "83teD", leg: "delivery", scheduledAtDt: `${D} 10:20:00` }),
      stop({ orderNo: "away1", base: "away1", routeDate: NEXT, scheduledAtDt: `${NEXT} 09:00:00` }),
    ],
    sets,
    D
  );

  assert.equal(out.Morning.length, 4);
  assert.equal(out.excluded.length, 1);
  assert.deepEqual(out.orphanBases, ["83teD"]);
});

test("route stops sort by the full timestamp, so 17:09 comes before 01:11 next day", () => {
  const routes = groupStopsByDriver([
    stop({ orderNo: "late1", base: "late1", stopNumber: 12, scheduledAt: "01:11", scheduledAtDt: `${NEXT} 01:11:00` }),
    stop({ orderNo: "erly1", base: "erly1", stopNumber: 3, scheduledAt: "17:09", scheduledAtDt: `${D} 17:09:00` }),
    stop({ orderNo: "erly2", base: "erly2", stopNumber: 4, scheduledAt: "17:09", scheduledAtDt: `${D} 17:09:00` }),
    stop({ orderNo: "other", base: "other", driver: "BagBee driver 2 01", scheduledAtDt: `${D} 18:00:00` }),
  ]);

  assert.deepEqual(routes.map((r) => r.driver), ["BagBee driver 1 01", "BagBee driver 2 01"]);
  assert.deepEqual(routes[0].stops.map((s) => s.orderNo), ["erly1", "erly2", "late1"]);
});

// --- the published decision (§6.3) — B6 -----------------------------------

import {
  MAX_REVISIONS,
  PUSH_KINDS,
  STABLE_MS,
  computeShiftPlan,
  decidePlanPush,
  inWindow,
  isMaterialChange,
  kindFor,
  planHash,
} from "../src/plan/planModel.js";

const at = (date, hhmm) => new Date(`${date}T${hhmm}:00Z`);
const TODAY = "2026-09-16";
const TMRW = "2026-09-17";

test("kindFor: tomorrow's Morning and today's Evening have a kind, nothing else does", () => {
  assert.equal(kindFor(TMRW, "Morning", TODAY), "tomorrow");
  assert.equal(kindFor(TODAY, "Evening", TODAY), "tonight");
  // Tomorrow's Evening is never announced the evening before (§6.3): OptimoRoute
  // has no plan for it yet and `no_stops` would hide a real shift.
  assert.equal(kindFor(TMRW, "Evening", TODAY), null);
  assert.equal(kindFor(TODAY, "Morning", TODAY), null);
  assert.equal(kindFor("2026-09-18", "Morning", TODAY), null);
  // The year boundary: Dec 31 → Jan 1 is still "tomorrow".
  assert.equal(kindFor("2027-01-01", "Morning", "2026-12-31"), "tomorrow");
});

test("the two windows and deadlines are the §6.3 table", () => {
  assert.deepEqual(PUSH_KINDS.tomorrow, { slot: "Morning", dayOffset: 1, open: "17:05", close: "21:30", deadline: "17:35", baseKind: "plan_published" });
  assert.deepEqual(PUSH_KINDS.tonight, { slot: "Evening", dayOffset: 0, open: "15:00", close: "18:00", deadline: "16:15", baseKind: "plan_tonight" });
  assert.equal(STABLE_MS, 10 * 60 * 1000);
  assert.equal(MAX_REVISIONS, 2);
  assert.equal(inWindow(at(TODAY, "17:05"), "17:05", "21:30"), true);
  assert.equal(inWindow(at(TODAY, "21:30"), "17:05", "21:30"), true);
  assert.equal(inWindow(at(TODAY, "17:04"), "17:05", "21:30"), false);
  assert.equal(inWindow(at(TODAY, "21:31"), "17:05", "21:30"), false);
});

/// A latest version as stateForRef hands it to the decision.
const latestAt = (firstSeen, over = {}) => ({
  version: 1, stopCount: 11, orderNumbers: ["aaaa1", "bbbb2"], firstStopDt: at(TMRW, "05:25"),
  covered: 2, expected: 2, firstSeenAt: firstSeen, ...over,
});

test("decidePlanPush, tomorrow's Morning: window, stability, deadline, revisions", () => {
  const seen = at(TODAY, "16:50");
  const decide = (hhmm, over = {}, rest = {}) =>
    decidePlanPush({ latest: latestAt(seen, over), now: at(TODAY, hhmm), kind: "tomorrow", ...rest });

  assert.deepEqual(decide("17:10", { stopCount: 0 }), { action: "none", reason: "no_stops" });
  assert.deepEqual(decide("17:04"), { action: "none", reason: "outside_window" });
  assert.deepEqual(decide("21:31"), { action: "none", reason: "outside_window" });
  // Seen at 16:50: at 16:59 it is 9 min old.
  assert.deepEqual(decidePlanPush({ latest: latestAt(at(TODAY, "16:59")), now: at(TODAY, "17:05"), kind: "tomorrow" }), { action: "none", reason: "not_stable" });
  assert.deepEqual(decidePlanPush({ latest: latestAt(at(TODAY, "16:55")), now: at(TODAY, "17:05"), kind: "tomorrow" }), { action: "publish", reason: null }, "exactly 10 minutes is stable");
  // Complete → publish as soon as stable and inside the window.
  assert.deepEqual(decide("17:05"), { action: "publish", reason: null });
  // Incomplete → wait for the 17:35 deadline.
  assert.deepEqual(decide("17:34", { covered: 1 }), { action: "none", reason: "incomplete" });
  assert.deepEqual(decide("17:35", { covered: 1 }), { action: "publish", reason: null });
  assert.deepEqual(decide("21:30", { covered: 0 }), { action: "publish", reason: null });

  // Published v1; v2 differs materially → revise, at most twice.
  const published = latestAt(seen, { version: 1 });
  const v2 = latestAt(at(TODAY, "18:00"), { version: 2, stopCount: 12, orderNumbers: ["aaaa1", "bbbb2", "cccc3"] });
  assert.deepEqual(decidePlanPush({ latest: v2, publishedVersion: published, revisionsSent: 0, now: at(TODAY, "18:10"), kind: "tomorrow" }), { action: "revise", reason: null });
  assert.deepEqual(decidePlanPush({ latest: v2, publishedVersion: published, revisionsSent: 1, now: at(TODAY, "18:10"), kind: "tomorrow" }), { action: "revise", reason: null });
  assert.deepEqual(decidePlanPush({ latest: v2, publishedVersion: published, revisionsSent: 2, now: at(TODAY, "18:10"), kind: "tomorrow" }), { action: "none", reason: "no_material_change" });
  // Same version as published, or a non-material v2 → nothing.
  assert.deepEqual(decidePlanPush({ latest: published, publishedVersion: published, now: at(TODAY, "18:10"), kind: "tomorrow" }), { action: "none", reason: "no_material_change" });
  const nudged = latestAt(at(TODAY, "18:00"), { version: 2, firstStopDt: at(TMRW, "05:30") });
  assert.deepEqual(decidePlanPush({ latest: nudged, publishedVersion: published, now: at(TODAY, "18:10"), kind: "tomorrow" }), { action: "none", reason: "no_material_change" });
  // A revision is still gated by the window and by stability.
  assert.deepEqual(decidePlanPush({ latest: v2, publishedVersion: published, now: at(TODAY, "18:05"), kind: "tomorrow" }), { action: "none", reason: "not_stable" });
  assert.deepEqual(decidePlanPush({ latest: v2, publishedVersion: published, now: at(TODAY, "21:45"), kind: "tomorrow" }), { action: "none", reason: "outside_window" });
});

test("decidePlanPush, tonight: 15:00–18:00 with the 16:15 deadline", () => {
  const seen = at(TODAY, "14:35");
  const decide = (hhmm, over = {}) =>
    decidePlanPush({ latest: latestAt(seen, { firstStopDt: at(TODAY, "17:09"), ...over }), now: at(TODAY, hhmm), kind: "tonight" });

  assert.deepEqual(decide("14:59"), { action: "none", reason: "outside_window" });
  assert.deepEqual(decide("15:00"), { action: "publish", reason: null });
  assert.deepEqual(decide("15:00", { covered: 1 }), { action: "none", reason: "incomplete" });
  assert.deepEqual(decide("16:14", { covered: 1 }), { action: "none", reason: "incomplete" });
  assert.deepEqual(decide("16:15", { covered: 1 }), { action: "publish", reason: null });
  assert.deepEqual(decide("18:00"), { action: "publish", reason: null });
  assert.deepEqual(decide("18:01"), { action: "none", reason: "outside_window" });
});

test("a shift without a kind is never announced, whatever the clock says", () => {
  const latest = latestAt(at(TODAY, "10:00"));
  assert.deepEqual(decidePlanPush({ latest, now: at(TODAY, "17:10"), kind: null }), { action: "none", reason: "not_announced" });
  assert.deepEqual(decidePlanPush({ latest, now: at(TODAY, "17:10"), kind: "someday" }), { action: "none", reason: "not_announced" });
});

test("isMaterialChange: count, order set, or the first stop moving ≥ 15 min", () => {
  const base = { stopCount: 11, orderNumbers: ["aaaa1", "bbbb2"], firstStopDt: at(TMRW, "05:25") };
  assert.equal(isMaterialChange(base, { ...base }), false);
  assert.equal(isMaterialChange(base, { ...base, stopCount: 12 }), true);
  assert.equal(isMaterialChange(base, { ...base, orderNumbers: ["aaaa1", "cccc3"] }), true);
  assert.equal(isMaterialChange(base, { ...base, orderNumbers: ["bbbb2", "aaaa1"] }), false, "order of the list is not a change");
  assert.equal(isMaterialChange(base, { ...base, firstStopDt: at(TMRW, "05:39") }), false);
  assert.equal(isMaterialChange(base, { ...base, firstStopDt: at(TMRW, "05:40") }), true);
  assert.equal(isMaterialChange(base, { ...base, firstStopDt: at(TMRW, "05:10") }), true);
  // Epochs, not "HH:MM": 23:55 → 00:05 next day is ten minutes, not a day (D2).
  const late = { ...base, firstStopDt: at(TODAY, "23:55") };
  assert.equal(isMaterialChange(late, { ...late, firstStopDt: at(TMRW, "00:05") }), false);
  assert.equal(isMaterialChange(late, { ...late, firstStopDt: at(TMRW, "00:10") }), true);
  // A first stop appearing or disappearing is a change; none on either side is not.
  assert.equal(isMaterialChange({ ...base, firstStopDt: null }, base), true);
  assert.equal(isMaterialChange({ ...base, firstStopDt: null }, { ...base, firstStopDt: null }), false);
  assert.equal(isMaterialChange(null, base), true);
  // Strings from the database compare the same as Dates.
  assert.equal(isMaterialChange({ ...base, firstStopDt: "2026-09-17T05:25:00Z" }, base), false);
});

test("planHash ignores input order and the other slot's stop numbers", () => {
  const s = (orderNo, dt, stopNumber, driver = "BagBee driver 1 01") =>
    stop({ orderNo, base: orderNo.replace(/-D$/i, ""), scheduledAtDt: dt, stopNumber, driver });
  const morning = [s("aaaa1", `${D} 05:25:00`, 1), s("bbbb2", `${D} 06:10:00`, 2), s("cccc3", `${D} 05:40:00`, 1, "BagBee driver 2 02")];

  assert.equal(planHash(morning), planHash([...morning].reverse()));
  // An insert into the Morning renumbers every Evening stop (Optimo's stopNumber
  // is day-level), but the Evening's own hash must not move (D8).
  const evening = [s("eeee5", `${D} 17:09:00`, 5), s("eeee5-D", `${NEXT} 01:11:00`, 6)];
  const renumbered = [s("eeee5", `${D} 17:09:00`, 9), s("eeee5-D", `${NEXT} 01:11:00`, 10)];
  assert.equal(planHash(evening), planHash(renumbered));
  // But a real reorder within a driver's route, a time change or a driver change does.
  assert.notEqual(planHash(evening), planHash([s("eeee5", `${D} 17:20:00`, 5), s("eeee5-D", `${NEXT} 01:11:00`, 6)]));
  assert.notEqual(planHash(morning), planHash(morning.map((x) => ({ ...x, driver: "BagBee driver 3 03" }))));
  assert.notEqual(planHash(morning), planHash(morning.slice(1)));
  assert.match(planHash([]), /^[0-9a-f]{64}$/);
});

test("computeShiftPlan counts covered orders across both crews and picks the first stop by full datetime", () => {
  const sets = orderSetsForDate(
    [
      ord({ id: "rec1", num: "aaaa1", formula: "Morning", bags: 2 }),
      ord({ id: "rec2", num: "bbbb2", formula: "Morning", bags: 3 }),
      ord({ id: "rec3", num: "dddd4", formula: "Morning", bags: 4 }),       // paid, never planned
      ord({ id: "rec4", num: "late1", formula: "Morning", bags: 1 }),       // Morning-booked, driven by the Evening
      ord({ id: "rec5", num: "eeee5", formula: "Evening", bags: 5 }),
      ord({ id: "rec6", num: "unpd1", formula: "Morning", bags: 9, paid: false }),
    ],
    shiftRows,
    D,
  );
  const orderByNumber = new Map([...sets.Morning, ...sets.Evening]);
  const assigned = assignStops(
    [
      stop({ orderNo: "bbbb2", base: "bbbb2", stopNumber: 2, scheduledAt: "06:10", scheduledAtDt: `${D} 06:10:00`, locationName: "Hótel Borg" }),
      stop({ orderNo: "aaaa1", base: "aaaa1", stopNumber: 1, scheduledAt: "05:25", scheduledAtDt: `${D} 05:25:00`, locationName: "Viðskiptavinur með mjög langt nafn sem fer yfir fjörutíu stafi" }),
      stop({ orderNo: "aaaa1-D", base: "aaaa1", leg: "delivery", stopNumber: 3, scheduledAt: "07:30", scheduledAtDt: `${D} 07:30:00` }),
      stop({ orderNo: "late1", base: "late1", stopNumber: 4, scheduledAt: "17:00", scheduledAtDt: `${D} 17:00:00` }),
      stop({ orderNo: "eeee5", base: "eeee5", stopNumber: 5, scheduledAt: "17:09", scheduledAtDt: `${D} 17:09:00` }),
      stop({ orderNo: "eeee5-D", base: "eeee5", leg: "delivery", stopNumber: 6, scheduledAt: "01:11", scheduledAtDt: `${NEXT} 01:11:00` }),
    ],
    sets,
    D,
  );

  const morning = computeShiftPlan({ assigned, orderSets: sets, slot: "Morning", orderByNumber });
  assert.equal(morning.stopCount, 3);
  assert.equal(morning.bagCount, 5);
  assert.equal(morning.expectedOrderCount, 4, "aaaa1, bbbb2, dddd4, late1 — the unpaid one is not expected");
  assert.equal(morning.plannedOrderCount, 3, "late1 is driven by the Evening half but still counts as planned");
  assert.deepEqual(morning.orderNumbers, ["aaaa1", "bbbb2"]);
  assert.equal(morning.firstStopAt, "05:25");
  assert.equal(morning.firstStopDt.toISOString(), `${D}T05:25:00.000Z`);
  assert.equal(morning.firstStopName.length, 40);
  assert.equal(morning.routes.length, 1);
  assert.deepEqual(morning.routes[0].stops.map((s) => s.optimoOrderNo), ["aaaa1", "bbbb2", "aaaa1-D"]);
  assert.equal(morning.routes[0].stops[0].phone, null, "no phone on the order → null, never \"\"");

  const evening = computeShiftPlan({ assigned, orderSets: sets, slot: "Evening", orderByNumber });
  assert.equal(evening.stopCount, 3);
  assert.equal(evening.firstStopAt, "17:00", "17:00 on D, never the 01:11 stop on D+1 (D2)");
  assert.deepEqual(evening.orderNumbers, ["eeee5", "late1"]);
  assert.equal(evening.bagCount, 6);
  assert.equal(evening.expectedOrderCount, 1);
  assert.equal(evening.plannedOrderCount, 1);

  const empty = computeShiftPlan({ assigned: { Morning: [], Evening: [] }, orderSets: sets, slot: "Evening", orderByNumber });
  assert.equal(empty.stopCount, 0);
  assert.equal(empty.firstStopDt, null);
  assert.equal(empty.firstStopAt, null);
  assert.equal(empty.firstStopName, null);
});
