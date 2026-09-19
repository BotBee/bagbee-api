// Spec §10.1 test/shiftDetail.test.js — the source order, the route-day rules
// and the PlannedStop contract of GET /v2/me/shifts/:ref.
//
// The stop fixture uses the times of the live 2026-09-11/12 rows with synthetic
// 5-character order numbers: real ones open /orders/<n> and bagbee-api is public.

import test from "node:test";
import assert from "node:assert/strict";

import { ORDER, SHIFT, STOP, TABLES } from "../src/airtable/fields.js";
import { createShiftsService } from "../src/staff/shifts.js";
import { createShiftDetail, keepRouteDayStops, normalizeAirtableStop } from "../src/staff/shiftDetail.js";

const D = "2026-09-11";
const NEXT = "2026-09-12";
const RUNAR = "recRunar000000001";
const MATAS = "recMatas000000001";
const EVENING_REF = "vakt_recShiftEvening01";
const MORNING_REF = "vakt_recShiftMorning01";
const silent = { error: () => {}, warn: () => {}, info: () => {} };

const staff = { airtableId: RUNAR, id: "uuid", name: "Rúnar" };

// --- fixtures -------------------------------------------------------------

const shiftRecords = [
  {
    id: "recShiftEvening01",
    fields: { [SHIFT.date]: D, [SHIFT.shift]: "Evening", [SHIFT.driver]: [RUNAR, MATAS] },
  },
  {
    id: "recShiftMorning01",
    fields: { [SHIFT.date]: D, [SHIFT.shift]: "Morning", [SHIFT.driver]: [RUNAR] },
  },
  {
    id: "recShiftMorning02",
    fields: { [SHIFT.date]: NEXT, [SHIFT.shift]: "Morning", [SHIFT.driver]: [RUNAR] },
  },
];

function order({ id, num, date, slot, paid = true, bags = 1, phone = "+3545550000", name = "Viðskiptavinur" }) {
  return {
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
  };
}

const orderRecords = [
  order({ id: "recOrd00000000001", num: "aaaa1", date: D, slot: "Evening", bags: 3 }),
  order({ id: "recOrd00000000002", num: "bbbb2", date: D, slot: "Morning", bags: 2 }),
  order({ id: "recOrd00000000003", num: "cccc3", date: D, slot: "Evening", bags: 1 }),
  order({ id: "recOrd00000000004", num: "dddd4", date: NEXT, slot: "Morning", bags: 5 }),
  order({ id: "recOrd00000000005", num: "eeee5", date: NEXT, slot: "Morning", bags: 6 }),
  // Paid, in the Evening set, never planned: this is the unplanned row.
  order({ id: "recOrd00000000006", num: "ffff6", date: D, slot: "Evening", bags: 4 }),
  // Unpaid and unplanned: must not appear at all.
  order({ id: "recOrd00000000007", num: "gggg7", date: D, slot: "Evening", bags: 9, paid: false }),
  order({ id: "recOrd00000000008", num: "hhhh8", date: D, slot: "Morning", bags: 1 }),
];

function stopRecord({ id, num, stopNumber = 1, at = null, dt = null, orderDate = D, driver = "BagBee driver 1 01", done = false, location = null, address = null, tracking = null }) {
  const delivery = /-D$/i.test(num);
  return {
    id,
    fields: {
      [STOP.orderNumber]: num,
      [STOP.orderDate]: orderDate ? [orderDate] : [],
      [STOP.stopNumber]: stopNumber,
      [STOP.scheduledAt]: at,
      [STOP.scheduledAtDt]: dt,
      [STOP.driver]: driver,
      [STOP.locationName]: location,
      [STOP.address]: address,
      [STOP.latitude]: 64.147,
      [STOP.longitude]: -21.94,
      [delivery ? STOP.deliveryCompleted : STOP.pickupCompleted]: done,
      [STOP.trackingURL]: tracking,
    },
  };
}

const stopRecords = [
  stopRecord({ id: "recStop0000000001", num: "bbbb2", stopNumber: 1, at: "09:30", dt: `${D} 09:30:00`, location: "Hótel Borg" }),
  stopRecord({ id: "recStop0000000002", num: "aaaa1", stopNumber: 3, at: "17:09", dt: `${D} 17:09:00` }),
  stopRecord({ id: "recStop0000000003", num: "cccc3", stopNumber: 4, at: "18:30", dt: `${D} 18:30:00`, done: true }),
  // The post-midnight KEF run of D's evening route.
  stopRecord({ id: "recStop0000000004", num: "aaaa1-D", stopNumber: 11, at: "01:11", dt: `${NEXT} 01:11:00` }),
  stopRecord({ id: "recStop0000000005", num: "cccc3-D", stopNumber: 12, at: "02:04", dt: `${NEXT} 02:04:00` }),
  // The NEXT morning's own stops — the rows the old "D+1 before 06:00" rule stole.
  stopRecord({ id: "recStop0000000006", num: "dddd4", stopNumber: 1, at: "05:25", dt: `${NEXT} 05:25:00`, orderDate: NEXT }),
  stopRecord({ id: "recStop0000000007", num: "eeee5", stopNumber: 2, at: "05:55", dt: `${NEXT} 05:55:00`, orderDate: NEXT }),
  // An orphan: no Airtable order row behind it at all.
  stopRecord({ id: "recStop0000000008", num: "83teD", stopNumber: 2, at: "10:20", dt: `${D} 10:20:00`, orderDate: null, address: "Laugavegur 27b" }),
  // No time at all: placed by its order's date and booking.
  stopRecord({ id: "recStop0000000009", num: "hhhh8", stopNumber: 5, at: null, dt: null }),
  // Not planned yet: no stopNumber.
  stopRecord({ id: "recStop0000000010", num: "iiii9", stopNumber: null, at: null, dt: null }),
];

/// Fixture client that honours the parts of the formulas the tests depend on:
/// one date's orders, an order-number lookup, and everything else unfiltered.
function fakeAirtable({ shifts = shiftRecords, orders = orderRecords, stops = stopRecords, counter = [] } = {}) {
  const calls = [];
  return {
    calls,
    async listAll(table, opts = {}) {
      calls.push({ table, ...opts });
      const formula = opts.filterByFormula || "";
      if (table === TABLES.orders) {
        const sameDay = /IS_SAME\(\{[^}]+\},'(\d{4}-\d{2}-\d{2})','day'\)/.exec(formula);
        if (sameDay) return { records: orders.filter((o) => o.fields[ORDER.pickupDate] === sameDay[1]), pages: 1 };
        const numbers = [...formula.matchAll(/\{fldo3soPBdIjoOv7H\}='([^']+)'/g)].map((m) => m[1]);
        if (numbers.length) return { records: orders.filter((o) => numbers.includes(o.fields[ORDER.orderNumber])), pages: 1 };
        return { records: orders, pages: 1 };
      }
      if (table === TABLES.shifts) return { records: shifts, pages: 1 };
      if (table === TABLES.counter) return { records: counter, pages: 1 };
      if (table === TABLES.stops) return { records: stops, pages: 1 };
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
        [RUNAR, { airtableId: RUNAR, displayName: "Rúnar" }],
        [MATAS, { airtableId: MATAS, displayName: "Matas" }],
      ]),
      stale: false,
    };
  },
};

/// now defaults to the evening of D, so the phone window is open.
function build({ now = Date.parse(`${D}T20:00:00Z`), snapshots = null, airtable = fakeAirtable() } = {}) {
  const shifts = createShiftsService({ airtable, now: () => now, logger: silent });
  const detail = createShiftDetail({ airtable, shifts, roster: fakeRoster, now: () => now, logger: silent, snapshots });
  return { shifts, detail, airtable, now };
}

async function detailFor(ref, opts = {}) {
  const { shifts, detail } = build(opts);
  const found = await shifts.getShiftForStaff({ staff: opts.staff || staff, ref });
  assert.equal(found.ok, true, `expected ${ref} to be the caller's shift`);
  return detail.buildShiftDetail({ staff: opts.staff || staff, found });
}

// --- route day ------------------------------------------------------------

test("keepRouteDayStops keeps D's night run and drops the next morning", () => {
  const stops = stopRecords.map(normalizeAirtableStop);
  const kept = keepRouteDayStops(stops, D).map((s) => s.orderNo);

  assert.deepEqual(kept.sort(), ["83teD", "aaaa1", "aaaa1-D", "bbbb2", "cccc3", "cccc3-D", "hhhh8"]);
  assert.ok(!kept.includes("dddd4"), "05:25 the next morning is not D's route");
  assert.ok(!kept.includes("eeee5"), "05:55 the next morning is not D's route");
  assert.ok(!kept.includes("iiii9"), "a stop with no stopNumber is not planned yet");
});

test("keepRouteDayStops on D+1 gives the morning its own stops back", () => {
  const stops = stopRecords.map(normalizeAirtableStop);
  const kept = keepRouteDayStops(stops, NEXT).map((s) => s.orderNo);

  assert.deepEqual(kept.sort(), ["dddd4", "eeee5"]);
  assert.ok(!kept.includes("aaaa1-D"), "01:11 belongs to the previous day's route");
  assert.ok(!kept.includes("cccc3-D"), "02:04 belongs to the previous day's route");
});

test("a stop with no scheduledAtDt is kept only when its order date is D", () => {
  const noTime = normalizeAirtableStop(stopRecord({ id: "recStop0000000011", num: "hhhh8", stopNumber: 5, orderDate: D }));
  assert.equal(keepRouteDayStops([noTime], D).length, 1);
  assert.equal(keepRouteDayStops([noTime], NEXT).length, 0);
});

// --- the Evening detail ---------------------------------------------------

test("the Evening crew gets the 17:09 pickup and the post-midnight deliveries", async () => {
  const out = await detailFor(EVENING_REF);

  assert.equal(out.source, "airtable_stops");
  assert.equal(out.stale, false);
  assert.equal(out.routes.length, 1);
  assert.equal(out.routes[0].driver, "BagBee driver 1 01");
  assert.deepEqual(out.routes[0].stops.map((s) => s.optimoOrderNo), ["aaaa1", "cccc3", "aaaa1-D", "cccc3-D"]);
  assert.deepEqual(out.routes[0].stops.map((s) => s.scheduledAt), ["17:09", "18:30", "01:11", "02:04"]);
  assert.deepEqual(out.routes[0].stops.map((s) => s.leg), ["pickup", "pickup", "delivery", "delivery"]);
});

test("the Morning crew keeps its own stops and the orphan, and never sees the evening", async () => {
  const out = await detailFor(MORNING_REF);
  assert.deepEqual(out.routes[0].stops.map((s) => s.orderNumber), ["bbbb2", "83teD", "hhhh8"]);
});

test("an orphan stop emits every required PlannedStop field with defaults", async () => {
  const out = await detailFor(MORNING_REF);
  const orphan = out.routes[0].stops.find((s) => s.orderNumber === "83teD");

  assert.deepEqual(orphan, {
    stopNumber: 2,
    scheduledAt: "10:20",
    driver: "BagBee driver 1 01",
    leg: "pickup",
    done: false,
    locationName: null,
    address: "Laugavegur 27b",
    orderNumber: "83teD",
    recordId: null,
    stopRecordId: "recStop0000000008",
    optimoOrderNo: "83teD",
    latitude: 64.147,
    longitude: -21.94,
    phone: null,
    customerName: "",
    requestedService: "",
    reference: "",
    totalBags: 0,
    timeWindow: "",
    trackingURL: null,
  });
  // An order number with no Airtable row appears only as a stop, never in orders[].
  assert.ok(!out.orders.some((o) => o.orderNumber === "83teD"));
});

test("orders[] carries the planned rows first and the unplanned paid ones after", async () => {
  const out = await detailFor(EVENING_REF);

  assert.deepEqual(out.orders.map((o) => [o.orderNumber, o.planned]), [
    ["aaaa1", true],
    ["cccc3", true],
    ["ffff6", false],
  ]);
  assert.equal(out.unplannedOrderCount, 1);
  assert.ok(!out.orders.some((o) => o.orderNumber === "gggg7"), "an unpaid order is not expected work");
  assert.equal(out.orders[0].recordId, "recOrd00000000001");
  assert.equal(out.orders[0].totalBags, 3);
  assert.equal(out.orders[0].deliveryAddress, "Keflavík International Airport");
});

test("phone is on pickup legs only, and only around the shift date", async () => {
  const near = await detailFor(EVENING_REF);
  const pickup = near.routes[0].stops.find((s) => s.leg === "pickup");
  const delivery = near.routes[0].stops.find((s) => s.leg === "delivery");
  assert.equal(pickup.phone, "+3545550000");
  assert.equal(delivery.phone, null, "a delivery leg goes to an airline, not to a person");

  // Three days later the same shift must stop serving customer phone numbers.
  const later = await detailFor(EVENING_REF, { now: Date.parse("2026-09-14T09:00:00Z") });
  assert.equal(later.routes[0].stops.find((s) => s.leg === "pickup").phone, null);
});

test("done comes from the Airtable completion checkboxes", async () => {
  const out = await detailFor(EVENING_REF);
  assert.equal(out.routes[0].stops.find((s) => s.orderNumber === "cccc3" && s.leg === "pickup").done, true);
  assert.equal(out.routes[0].stops.find((s) => s.orderNumber === "aaaa1" && s.leg === "pickup").done, false);
});

test("crew lists the other people on a two-person shift, never the caller", async () => {
  const out = await detailFor(EVENING_REF);
  assert.deepEqual(out.crew, [{ name: "Matas", role: "driver" }]);

  const asMatas = await detailFor(EVENING_REF, { staff: { airtableId: MATAS, id: "uuid2", name: "Matas" } });
  assert.deepEqual(asMatas.crew, [{ name: "Rúnar", role: "driver" }]);
});

// --- source selection -----------------------------------------------------

const snapshotRoutes = [
  {
    driver: "BagBee driver 1 01",
    stops: [
      {
        stopNumber: 1,
        scheduledAt: "05:25",
        driver: "BagBee driver 1 01",
        leg: "pickup",
        done: true, // a snapshot must never claim a stop is finished
        locationName: "Hótel Borg",
        address: "Pósthússtræti 11",
        orderNumber: "dddd4",
        recordId: "recOrd00000000004",
        stopRecordId: "recShouldBeDropped",
        optimoOrderNo: "dddd4",
        latitude: 64.147,
        longitude: -21.94,
        phone: "+3545550000",
        customerName: "Viðskiptavinur",
        requestedService: "Check-in service",
        reference: "FSEB-1",
        totalBags: 5,
        timeWindow: "04:00 - 05:00",
        trackingURL: "https://example.invalid/t",
      },
    ],
  },
];

const snapshotsAt = (lastSeenAt) => ({ latestForRef: async () => ({ version: 3, lastSeenAt, routes: snapshotRoutes }) });

test("a fresh snapshot wins over Airtable and is served with the source rules re-applied", async () => {
  const now = Date.parse(`${NEXT}T04:00:00Z`);
  const out = await detailFor("vakt_recShiftMorning02", {
    now,
    snapshots: snapshotsAt(new Date(now - 5 * 60 * 1000).toISOString()),
  });

  assert.equal(out.source, "optimo_snapshot");
  assert.equal(out.stale, false);
  assert.equal(out.fetchedAt, new Date(now - 5 * 60 * 1000).toISOString().slice(0, 19) + "Z");
  const stop = out.routes[0].stops[0];
  assert.equal(stop.done, false, "completion tracking stays in Dagurinn in slice 1");
  assert.equal(stop.stopRecordId, null);
  assert.equal(stop.trackingURL, null);
  assert.equal(stop.phone, "+3545550000", "the shift is tomorrow, so the phone is still allowed");
});

test("an old snapshot is served with stale:true when Airtable has no plan yet", async () => {
  // 22:30 on D: the plan job stopped at 21:50 and the website's enrich cron has
  // not mirrored tomorrow yet. Without this the app would show "engin áætlun"
  // half an hour after the push said the plan was ready.
  const now = Date.parse(`${D}T22:30:00Z`);
  const out = await detailFor("vakt_recShiftMorning02", {
    now,
    snapshots: snapshotsAt(new Date(now - 3 * 60 * 60 * 1000).toISOString()),
    airtable: fakeAirtable({ stops: [] }),
  });

  assert.equal(out.source, "optimo_snapshot");
  assert.equal(out.stale, true);
  assert.equal(out.routes[0].stops.length, 1);
});

test("with no snapshot and nothing in Airtable the source is none", async () => {
  const now = Date.parse(`${D}T22:30:00Z`);
  const out = await detailFor("vakt_recShiftMorning02", { now, airtable: fakeAirtable({ stops: [] }) });

  assert.equal(out.source, "none");
  assert.deepEqual(out.routes, []);
  assert.equal(out.stale, false);
  assert.equal(out.fetchedAt, new Date(now).toISOString().slice(0, 19) + "Z");
  // Paid orders with no plan are still the shift's expected work.
  assert.equal(out.unplannedOrderCount, out.orders.length);
});

test("Airtable wins over a stale snapshot as soon as it has a stop number", async () => {
  const now = Date.parse(`${D}T20:00:00Z`);
  const out = await detailFor(EVENING_REF, { now, snapshots: snapshotsAt(new Date(now - 3 * 60 * 60 * 1000).toISOString()) });
  assert.equal(out.source, "airtable_stops");
});

// --- counter --------------------------------------------------------------

test("a counter shift detail is empty by design", async () => {
  const now = Date.parse(`${D}T09:00:00Z`);
  const airtable = fakeAirtable({
    counter: [
      {
        id: "recBsi00000000001",
        fields: {
          fldYl4gO51LLK6UFc: D,
          fldV0Xq7s87r8nyu6: "Morning",
          fldU2BW7HDfhl68i0: [RUNAR],
          fldx19OG14v93SZ9m: "Scheduled",
          fldhfJREfDaGEhaot: "Muna lyklana",
        },
      },
    ],
  });
  const { shifts, detail } = build({ now, airtable });
  const found = await shifts.getShiftForStaff({ staff, ref: "bsi_recBsi00000000001" });
  const out = await detail.buildShiftDetail({ staff, found });

  assert.equal(out.source, "none");
  assert.equal(out.stale, false);
  assert.deepEqual(out.routes, []);
  assert.deepEqual(out.orders, []);
  assert.deepEqual(out.crew, []);
  assert.equal(out.unplannedOrderCount, 0);
  assert.equal(out.shift.label, "BSÍ · Morgunn");
  assert.equal(out.shift.comment, "Muna lyklana");
  assert.equal(out.fetchedAt, new Date(now).toISOString().slice(0, 19) + "Z");
});
