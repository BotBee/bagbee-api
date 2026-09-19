// ---------------------------------------------------------------------------
// Shift detail join (spec §5.5)
// ---------------------------------------------------------------------------
//
// One shift, everything the crew needs on the road: the routes, the orders
// behind them, and who else is on the shift. Three sources in a fixed order —
// a fresh OptimoRoute snapshot, Airtable's mirrored Optimo Stops, an old
// snapshot — because between 21:50 and ~03:15 neither of the first two exists
// and "source: none" right after a push told someone their plan was ready is
// the one outcome we cannot ship.
//
// READ ONLY: this module never writes to Airtable.

import { TABLES, STOP, STOP_FIELDS } from "../airtable/fields.js";
import { createCache } from "../airtable/client.js";
import { assignStops, groupStopsByDriver, routeDayOf } from "../plan/planModel.js";
import { addDays, isoSec, todayUTC } from "../time.js";

const STOPS_TTL_MS = 3 * 60 * 1000;
const STOPS_STALE_MS = 60 * 60 * 1000;
/// A snapshot older than this is not "the current plan" any more — the job runs
/// every 10 min inside its windows, so 40 min means three missed runs.
const SNAPSHOT_FRESH_MS = 40 * 60 * 1000;

const str = (v) => (typeof v === "string" ? v.trim() : "");
const nullableStr = (v) => str(v) || null;
const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function isDeliveryLeg(orderNo) {
  return /-D$/i.test(str(orderNo));
}

export function baseOrderNumber(orderNo) {
  return str(orderNo).replace(/-D$/i, "");
}

/// One Airtable Optimo Stops row → the normalized stop shape assignStops takes.
export function normalizeAirtableStop(record) {
  const f = record.fields || {};
  const raw = str(f[STOP.orderNumber]);
  if (!raw) return null;
  const delivery = isDeliveryLeg(raw);
  const orderDates = Array.isArray(f[STOP.orderDate]) ? f[STOP.orderDate] : [];
  return {
    orderNo: raw,
    base: baseOrderNumber(raw),
    leg: delivery ? "delivery" : "pickup",
    stopNumber: typeof f[STOP.stopNumber] === "number" ? f[STOP.stopNumber] : null,
    scheduledAt: nullableStr(f[STOP.scheduledAt]),
    scheduledAtDt: nullableStr(f[STOP.scheduledAtDt]),
    orderDate: str(orderDates[0]).slice(0, 10) || null,
    driver: str(f[STOP.driver]) || "Unassigned",
    locationName: nullableStr(f[STOP.locationName]),
    address: nullableStr(f[STOP.address]),
    latitude: numOrNull(f[STOP.latitude]),
    longitude: numOrNull(f[STOP.longitude]),
    done: Boolean(delivery ? f[STOP.deliveryCompleted] : f[STOP.pickupCompleted]),
    stopRecordId: record.id,
    trackingURL: nullableStr(f[STOP.trackingURL]),
    routeDate: null,
  };
}

/// Keep only the rows that belong to date D's route, and stamp the route date.
///
/// Airtable has no route-date column, so this is derived: a stop on D at or
/// after 03:00, or on D+1 before 03:00 (the evening KEF run that comes back at
/// 01:11–02:04). The old "D+1 before 06:00" rule pulled the NEXT morning's
/// 05:25 and 05:55 stops into D's evening — VERIFIED on 2026-09-11/12.
export function keepRouteDayStops(stops, D) {
  const kept = [];
  for (const stop of stops) {
    if (typeof stop.stopNumber !== "number") continue; // not planned yet
    if (stop.scheduledAtDt) {
      const routeDate = routeDayOf(stop.scheduledAtDt);
      if (routeDate !== D) continue;
      kept.push({ ...stop, routeDate });
      continue;
    }
    /// No time at all: it can only be placed by the order it belongs to.
    if (stop.orderDate === D) kept.push({ ...stop, routeDate: D });
  }
  return kept;
}

export function createShiftDetail({ airtable, shifts, roster, config = {}, now = Date.now, logger = console, snapshots = null } = {}) {
  const stopsCache = createCache({ now, logger, label: "stops" });
  const clock = () => new Date(now());

  async function stopsForDate(date, { interactive = true } = {}) {
    return stopsCache.get(date, {
      ttlMs: STOPS_TTL_MS,
      staleMs: STOPS_STALE_MS,
      load: async () => {
        const next = addDays(date, 1);
        /// Selects by order date OR by stop date: post-midnight legs and orphan
        /// legs carry another order's date entirely.
        const formula =
          `OR(DATETIME_FORMAT(ARRAYJOIN({${STOP.orderDate}}),'YYYY-MM-DD')='${date}', ` +
          `LEFT({${STOP.scheduledAtDt}}&'',10)='${date}', ` +
          `LEFT({${STOP.scheduledAtDt}}&'',10)='${next}')`;
        const { records } = await airtable.listAll(TABLES.stops, {
          filterByFormula: formula,
          fields: STOP_FIELDS,
          interactive,
        });
        return records.map(normalizeAirtableStop).filter(Boolean);
      },
    });
  }

  /// PlannedStop — the exact JSON shape of the existing /app/route stop
  /// (index.js:273-303), so the app decodes it with the Swift type it already
  /// has. Every non-optional field is ALWAYS emitted: one missing key fails the
  /// decode of the whole detail, and orphan stops have no order behind them.
  function toPlannedStop(stop, order, { phoneAllowed, fromAirtable }) {
    return {
      stopNumber: stop.stopNumber,
      scheduledAt: stop.scheduledAt || null,
      driver: stop.driver || "Unassigned",
      leg: stop.leg,
      done: fromAirtable ? Boolean(stop.done) : false,
      locationName: stop.locationName || null,
      address: stop.address || order?.pickupAddress || null,
      orderNumber: stop.base,
      recordId: order?.recordId || null,
      stopRecordId: fromAirtable ? stop.stopRecordId || null : null,
      optimoOrderNo: stop.orderNo,
      latitude: numOrNull(stop.latitude),
      longitude: numOrNull(stop.longitude),
      /// Pickup legs only, and only around the shift date: a delivery leg goes
      /// to an airline desk, not to a person, and an old shift must not keep
      /// serving customer phone numbers.
      phone: phoneAllowed && stop.leg === "pickup" ? order?.phone || null : null,
      customerName: order?.customerName || "",
      requestedService: order?.requestedService || "",
      reference: order?.reference || "",
      totalBags: order?.totalBags || 0,
      timeWindow: order?.timeWindow || "",
      trackingURL: fromAirtable ? stop.trackingURL || null : null,
    };
  }

  function buildOrders({ slotStops, allBases, orderSets, slot, orderByNumber }) {
    const planned = [];
    const seen = new Set();
    for (const stop of slotStops) {
      if (seen.has(stop.base)) continue;
      seen.add(stop.base);
      const order = orderByNumber.get(stop.base);
      /// An order number with no Airtable row (e.g. igJsY) appears only as
      /// stops, never in orders[] — every entry here has a real recordId.
      if (order) planned.push({ order, planned: true });
    }

    const unplanned = [];
    for (const order of orderSets?.[slot]?.values?.() || []) {
      if (!order.paid) continue;
      if (allBases.has(order.orderNumber)) continue;
      unplanned.push({ order, planned: false });
    }

    const rows = [...planned, ...unplanned].map(({ order, planned: isPlanned }) => ({
      recordId: order.recordId,
      orderNumber: order.orderNumber,
      customerName: order.customerName || "",
      requestedService: order.requestedService || "",
      reference: order.reference || "",
      totalBags: order.totalBags || 0,
      timeWindow: order.timeWindow || "",
      pickupAddress: order.pickupAddress || "",
      deliveryAddress: order.deliveryAddress || "",
      planned: isPlanned,
    }));

    rows.sort((a, b) => {
      if (a.planned !== b.planned) return a.planned ? -1 : 1;
      return (a.timeWindow || "").localeCompare(b.timeWindow || "");
    });

    return { orders: rows, unplannedOrderCount: unplanned.length };
  }

  async function buildCrew(row, staff) {
    const { byId } = await roster.getRoster();
    const crew = [];
    const add = (id, role) => {
      if (id === staff.airtableId) return; // the caller is not their own crew
      const person = byId.get(id);
      crew.push({ name: person?.displayName || "", role });
    };
    for (const id of row.driverIds) add(id, "driver");
    for (const id of row.extraIds) add(id, "extra");
    for (const id of row.otherIds) add(id, "other");
    return crew.filter((c) => c.name);
  }

  /// GET /v2/me/shifts/:ref (§4.5). `found` is the result of
  /// shifts.getShiftForStaff, so membership and the today−7 limit are already
  /// decided by the time we get here.
  async function buildShiftDetail({ staff, found, nowDate = clock() }) {
    const today = todayUTC(nowDate);

    if (found.kind === "counter") {
      /// Counter shifts have no route and no orders — the person stands at a
      /// desk at BSÍ.
      return {
        shift: found.shift,
        source: "none",
        fetchedAt: isoSec(nowDate),
        stale: false,
        routes: [],
        orders: [],
        unplannedOrderCount: 0,
        crew: [],
      };
    }

    const row = found.row;
    const D = row.date;
    const slot = row.slot;
    const split = config.planSlotSplit || "16:00";
    const phoneAllowed = D >= addDays(today, -1) && D <= addDays(today, 1);

    const snapshot = snapshots?.latestForRef ? await snapshots.latestForRef(row.ref) : null;
    const snapshotAge = snapshot?.lastSeenAt ? nowDate.getTime() - new Date(snapshot.lastSeenAt).getTime() : Infinity;

    let source = "none";
    let fetchedAt = isoSec(nowDate);
    let stale = false;
    let routes = [];
    let slotStops = [];
    let allBases = new Set();
    let orphanBases = [];
    let fromAirtable = false;

    if (snapshot && snapshotAge < SNAPSHOT_FRESH_MS) {
      source = "optimo_snapshot";
      fetchedAt = isoSec(snapshot.lastSeenAt);
      routes = snapshot.routes || [];
    } else {
      const { value: allStops, fetchedAt: stopsFetchedAt } = await stopsForDate(D);
      const kept = keepRouteDayStops(allStops, D);
      const assigned = assignStops(kept, found.orderSets, D, split, { logger });
      if (assigned[slot].length) {
        source = "airtable_stops";
        fromAirtable = true;
        fetchedAt = isoSec(stopsFetchedAt);
        slotStops = assigned[slot];
        orphanBases = assigned.orphanBases;
        for (const s of [...assigned.Morning, ...assigned.Evening]) allBases.add(s.base);
      } else if (snapshot) {
        /// Nothing in Airtable yet: this is tomorrow's Morning between the last
        /// job run at 21:50 and the website's enrich cron from ~03:15.
        source = "optimo_snapshot";
        stale = true;
        fetchedAt = isoSec(snapshot.lastSeenAt);
        routes = snapshot.routes || [];
      }
    }

    const orderByNumber = new Map();
    for (const order of found.orders || []) orderByNumber.set(order.orderNumber, order);

    if (source === "optimo_snapshot") {
      /// Snapshot routes are already PlannedStop-shaped; re-assert the rules
      /// that depend on the source and on today's date rather than trusting a
      /// row written hours ago.
      routes = (routes || []).map((route) => ({
        driver: route.driver || "Unassigned",
        stops: (route.stops || []).map((stop) => ({
          ...stop,
          done: false,
          stopRecordId: null,
          trackingURL: null,
          phone: phoneAllowed && stop.leg === "pickup" ? stop.phone || null : null,
        })),
      }));
      for (const route of routes) for (const stop of route.stops) allBases.add(stop.orderNumber);
      slotStops = routes.flatMap((r) => r.stops.map((s) => ({ base: s.orderNumber })));
    } else if (source === "airtable_stops") {
      if (orphanBases.length) {
        /// Orders dated another day, or with no Airtable row at all. Missing
        /// ones simply stay missing and the stop gets the §4.5 defaults.
        const { orders: orphanOrders } = await shifts.ordersByNumbers(orphanBases, { date: D, today });
        for (const order of orphanOrders) orderByNumber.set(order.orderNumber, order);
      }
      routes = groupStopsByDriver(slotStops).map((route) => ({
        driver: route.driver,
        stops: route.stops.map((stop) => toPlannedStop(stop, orderByNumber.get(stop.base), { phoneAllowed, fromAirtable })),
      }));
    }

    const { orders, unplannedOrderCount } = buildOrders({
      slotStops,
      allBases,
      orderSets: found.orderSets,
      slot,
      orderByNumber,
    });

    return {
      shift: found.shift,
      source,
      fetchedAt,
      stale: stale || Boolean(found.stale),
      routes,
      orders,
      unplannedOrderCount,
      crew: await buildCrew(row, staff),
    };
  }

  return { buildShiftDetail, stopsForDate };
}

export default createShiftDetail;
