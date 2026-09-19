// ---------------------------------------------------------------------------
// Plan model — PURE (spec §5.4). No I/O, no clock, no Airtable.
// ---------------------------------------------------------------------------
//
// Everything here is a function of its arguments so it can be tested against
// recorded fixtures. Iceland is UTC all year, so every date and time below is
// plain UTC wall time; there is no zone conversion anywhere in this file.
//
// The first half is the read model the shifts list and the shift detail need
// (order sets, which crew drives a stop). The second half — computeShiftPlan,
// planHash, isMaterialChange, decidePlanPush — is the "published" decision of
// §6.3, kept pure so the whole tomorrow/tonight timetable can be walked with a
// fake clock in test/planModel.test.js.

import crypto from "node:crypto";
import { ORDER } from "../airtable/fields.js";
import { hhmmUTC } from "../time.js";

/// The Morning/Evening boundary for stops on date D. Default 16:00, matching the
/// `shift (formula)` hour-16 rule in Airtable. Configurable via PLAN_SLOT_SPLIT.
export const DEFAULT_SLOT_SPLIT = "16:00";

/// A route that starts on D does not end at midnight: the KEF evening run comes
/// back at 01:11–02:04 on D+1. Anything before 03:00 therefore belongs to the
/// previous day's route. This is a constant, not a flag — it is the same
/// boundary the website's operationalDate() uses (optimoEnrich.ts:89-90).
/// VERIFIED live: since 2026-06-01 the latest post-midnight stop is 02:04 and
/// the earliest morning stop is 05:00, with nothing in between.
export const ROUTE_DAY_CUTOFF = "03:00";

const str = (v) => (typeof v === "string" ? v.trim() : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/// "YYYY-MM-DD HH:MM:SS" (Airtable) or "YYYY-MM-DDTHH:MM:SSZ" (OptimoRoute JSON)
/// → { date, hhmm, epoch }. Anything else → null.
export function parseStopDt(value) {
  const s = str(value);
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  const date = m[1];
  const hhmm = `${m[2]}:${m[3]}`;
  const epoch = Date.parse(`${date}T${hhmm}:${m[4] || "00"}Z`);
  return Number.isNaN(epoch) ? null : { date, hhmm, epoch };
}

function addDaysISO(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/// Which route a timestamp belongs to. Airtable's Optimo Stops rows carry no
/// route date (VERIFIED: optimoEnrich.ts writes only the fields in §5.1), so it
/// has to be derived from the clock.
export function routeDayOf(scheduledAtDt) {
  const dt = parseStopDt(scheduledAtDt);
  if (!dt) return null;
  return dt.hhmm < ROUTE_DAY_CUTOFF ? addDaysISO(dt.date, -1) : dt.date;
}

// --- orders ---------------------------------------------------------------

/// One Orders row in the shape the read model uses. Every string defaults to ""
/// and every number to 0: one missing field must never fail the app's decode of
/// a whole shift detail (§4.5).
export function normalizeOrder(record) {
  if (!record?.id) return null;
  const f = record.fields || {};
  return {
    recordId: record.id,
    orderNumber: str(f[ORDER.orderNumber]),
    date: str(f[ORDER.pickupDate]).slice(0, 10),
    paid: Boolean(f[ORDER.paid]),
    totalBags: typeof f[ORDER.totalBags] === "number" ? f[ORDER.totalBags] : 0,
    customerName: str(f[ORDER.customerName]),
    pickupAddress: str(f[ORDER.pickupAddress]),
    deliveryAddress: str(f[ORDER.deliveryAddress]),
    timeWindow: str(f[ORDER.timeWindow]),
    requestedService: str(f[ORDER.requestedService]),
    reference: str(f[ORDER.reference]),
    phone: str(f[ORDER.phone]),
    shiftFormula: str(f[ORDER.shiftFormula]),
    shiftLinkIds: Array.isArray(f[ORDER.shiftLink]) ? f[ORDER.shiftLink].filter((x) => typeof x === "string") : [],
  };
}

/// Which slot an order was BOOKED for on date D.
///
/// The link wins over the formula because it is what the office actually
/// planned: VERIFIED that all 76 linked orders agreed with both their date and
/// the formula, while 95 of 171 had no link at all.
export function slotOfOrder(order, shiftRowsById, D) {
  for (const id of order.shiftLinkIds) {
    const row = shiftRowsById?.get?.(id);
    if (row && row.date === D && (row.slot === "Morning" || row.slot === "Evening")) return row.slot;
  }
  if (order.shiftFormula === "Morning" || order.shiftFormula === "Evening") return order.shiftFormula;
  return null; // "Unknown", or a link to another date
}

/// Map<slot, Map<orderNumber, order>> for one date. `unassigned` holds the
/// orders that belong to D but to neither crew.
export function orderSetsForDate(orders, shiftRowsById, D) {
  const sets = { Morning: new Map(), Evening: new Map(), unassigned: new Map() };
  for (const order of orders) {
    if (!order?.orderNumber) continue;
    const slot = slotOfOrder(order, shiftRowsById, D);
    sets[slot || "unassigned"].set(order.orderNumber, order);
  }
  return sets;
}

/// The shifts list needs counts for every date in the window at once, so bucket
/// by the order's own pickup date first and then apply the same rule per date.
export function orderSetsByDate(orders, shiftRowsById) {
  const byDate = new Map();
  for (const order of orders) {
    if (!order?.date) continue;
    if (!byDate.has(order.date)) byDate.set(order.date, []);
    byDate.get(order.date).push(order);
  }
  const out = new Map();
  for (const [date, rows] of byDate) out.set(date, orderSetsForDate(rows, shiftRowsById, date));
  return out;
}

/// Greitt orders in a (date, slot) set, and their bags (§4.5). Deliberately not
/// the `Pantanir á vakt` rollup, which is incomplete.
export function countsForSet(set) {
  let orderCount = 0;
  let bagCount = 0;
  for (const order of set?.values?.() || []) {
    if (!order.paid) continue;
    orderCount += 1;
    bagCount += order.totalBags || 0;
  }
  return { orderCount, bagCount };
}

function setSlotOfBase(orderSets, base) {
  if (orderSets?.Morning?.has(base)) return "Morning";
  if (orderSets?.Evening?.has(base)) return "Evening";
  return null;
}

// --- stops ----------------------------------------------------------------

/// Which crew drives this stop.
///
/// The order set says which shift an order was *booked* for, not which half of
/// the route executes it: since June, 43 Morning-set stops across 17 days ran at
/// or after 15:00. So the stop's own clock decides, and the booking is only the
/// fallback when Optimo gave us no time at all.
export function slotOfStop(stop, D, split = DEFAULT_SLOT_SPLIT, orderSets = null) {
  /// Another day's route (D−1's post-midnight run, D+1's Morning). Excluded
  /// before any time rule runs, otherwise a 01:11 stop from last night's route
  /// would be handed to tonight's crew.
  if (stop.routeDate !== D) return null;

  const dt = parseStopDt(stop.scheduledAtDt);
  if (!dt) {
    const booked = setSlotOfBase(orderSets, stop.base);
    if (booked) return booked;
    const at = str(stop.scheduledAt);
    if (/^\d{2}:\d{2}$/.test(at)) return at >= split ? "Evening" : "Morning";
    return "Evening";
  }

  if (dt.date > D) return "Evening"; // post-midnight run of D's evening route
  if (dt.date < D) return null; // guard; route-dated input cannot reach this
  return dt.hhmm >= split ? "Evening" : "Morning";
}

/// Split normalized stops over the two crews of date D.
///
/// Both legs of one order may legitimately land in different slots (a bag picked
/// up at 15:30 and delivered to KEF at 17:40); each crew then sees its own leg.
export function assignStops(stops, orderSets, D, split = DEFAULT_SLOT_SPLIT, { logger = null } = {}) {
  const out = { Morning: [], Evening: [], excluded: [], mismatches: [], orphanBases: [] };
  const orphans = new Set();

  for (const stop of stops || []) {
    const slot = slotOfStop(stop, D, split, orderSets);
    if (!slot) {
      out.excluded.push(stop);
      continue;
    }

    const booked = setSlotOfBase(orderSets, stop.base);
    if (booked && booked !== slot) {
      out.mismatches.push({ orderNo: stop.orderNo, set: booked, stop: slot });
      logger?.info?.(`[plan] slot mismatch ${stop.orderNo} set=${booked} stop=${slot}`);
    }
    /// Base in none of D's three sets: a leg of an order dated another day, or
    /// an order with no Airtable row at all. Its order data needs a second read.
    if (!booked && !orderSets?.unassigned?.has(stop.base)) orphans.add(stop.base);

    out[slot].push({ ...stop, slot });
  }

  out.orphanBases = [...orphans];
  return out;
}

/// Routes are sorted by driver label and stops by time, then stop number — the
/// order a crew actually drives them in.
export function groupStopsByDriver(stops) {
  const byDriver = new Map();
  for (const stop of stops) {
    const driver = str(stop.driver) || "Unassigned";
    if (!byDriver.has(driver)) byDriver.set(driver, []);
    byDriver.get(driver).push(stop);
  }
  return [...byDriver.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "is"))
    .map(([driver, list]) => ({
      driver,
      stops: list.slice().sort((a, b) => {
        const ax = parseStopDt(a.scheduledAtDt)?.epoch ?? Number.MAX_SAFE_INTEGER;
        const bx = parseStopDt(b.scheduledAtDt)?.epoch ?? Number.MAX_SAFE_INTEGER;
        if (ax !== bx) return ax - bx;
        return (num(a.stopNumber) ?? 0) - (num(b.stopNumber) ?? 0);
      }),
    }));
}

// --- the published decision (§6.3) -----------------------------------------

/// Which (date, slot) is announced when. `tomorrow` is tomorrow's Morning, told
/// the evening before; `tonight` is today's Evening, told the same afternoon,
/// because OptimoRoute has no Evening plan until the 14:30 planner run (§0.6).
/// Tomorrow's Evening therefore has NO kind: computing it the evening before
/// would read as `no_stops` and hide a real shift.
export const PUSH_KINDS = {
  tomorrow: { slot: "Morning", dayOffset: 1, open: "17:05", close: "21:30", deadline: "17:35", baseKind: "plan_published" },
  tonight: { slot: "Evening", dayOffset: 0, open: "15:00", close: "18:00", deadline: "16:15", baseKind: "plan_tonight" },
};

/// A plan must sit unchanged this long before it is announced: the route planner
/// writes routes in several passes and a push in the middle of them would be
/// followed by a "BREYTT:" within minutes.
export const STABLE_MS = 10 * 60 * 1000;
/// ±15 min on the first stop is a change worth a second buzz; less is noise.
export const MATERIAL_FIRST_STOP_MS = 15 * 60 * 1000;
/// At most this many "Áætlun uppfærð" pushes per shift (Q3).
export const MAX_REVISIONS = 2;
export const FIRST_STOP_NAME_MAX = 40;

/// The push kind for a driving shift on date D, given today's date, or null.
export function kindFor(D, slot, today) {
  for (const [kind, rule] of Object.entries(PUSH_KINDS)) {
    if (rule.slot === slot && addDaysISO(today, rule.dayOffset) === D) return kind;
  }
  return null;
}

/// Inclusive "HH:MM" window test on the Iceland (= UTC) wall clock.
export function inWindow(now, open, close) {
  const hhmm = hhmmUTC(now);
  return hhmm >= open && hhmm <= close;
}

const sortedByRoute = (stops) =>
  stops.slice().sort((a, b) => {
    const ax = parseStopDt(a.scheduledAtDt)?.epoch ?? Number.MAX_SAFE_INTEGER;
    const bx = parseStopDt(b.scheduledAtDt)?.epoch ?? Number.MAX_SAFE_INTEGER;
    if (ax !== bx) return ax - bx;
    return (num(a.stopNumber) ?? 0) - (num(b.stopNumber) ?? 0);
  });

/// sha256 over `driver|ordinal|orderNo|scheduledAtDt` lines, sorted.
///
/// The ordinal is the stop's position within its driver's stops IN THIS SLOT,
/// not Optimo's day-level stopNumber: a route spans both halves of the day, so
/// an insert into the Morning renumbers every Evening stop without changing the
/// Evening at all (critique D8).
export function planHash(slotStops) {
  const lines = [];
  for (const route of groupStopsByDriver(slotStops || [])) {
    route.stops.forEach((stop, ordinal) => {
      lines.push(`${route.driver}|${ordinal}|${stop.orderNo}|${stop.scheduledAtDt || ""}`);
    });
  }
  return crypto.createHash("sha256").update(lines.sort().join("\n")).digest("hex");
}

/// The exact JSON of the existing /app/route stop (index.js:273-303), built from
/// an OptimoRoute stop and the order behind it. Every non-optional field of the
/// Swift PlannedStop is always present (§4.5). `done`, `stopRecordId` and
/// `trackingURL` are Airtable-only and stay at their defaults for a snapshot.
export function plannedStopFromOptimo(stop, order) {
  return {
    stopNumber: num(stop.stopNumber) ?? 0,
    scheduledAt: stop.scheduledAt || null,
    driver: str(stop.driver) || "Unassigned",
    leg: stop.leg,
    done: false,
    locationName: stop.locationName || null,
    address: stop.address || order?.pickupAddress || null,
    orderNumber: stop.base,
    recordId: order?.recordId || null,
    stopRecordId: null,
    optimoOrderNo: stop.orderNo,
    latitude: num(stop.latitude),
    longitude: num(stop.longitude),
    /// Pickup legs only. The detail re-applies the today±1 rule at read time
    /// (§4.5), so storing it here is what lets tomorrow's Morning show a phone.
    phone: stop.leg === "pickup" ? order?.phone || null : null,
    customerName: order?.customerName || "",
    requestedService: order?.requestedService || "",
    reference: order?.reference || "",
    totalBags: order?.totalBags || 0,
    timeWindow: order?.timeWindow || "",
    trackingURL: null,
  };
}

/// One shift's plan from one day's routes (§6.3). Pure: `assigned` is the
/// output of assignStops for date D, `orderSets` the date's booking sets, and
/// `orderByNumber` every order we know by number (the date's plus the orphan
/// read), so bags and customer fields are found for an order booked on another
/// day or driven by the other crew.
export function computeShiftPlan({ assigned, orderSets, slot, orderByNumber }) {
  const stops = assigned?.[slot] || [];
  const lookup = orderByNumber?.get ? orderByNumber : new Map();

  const expected = new Set();
  for (const order of orderSets?.[slot]?.values?.() || []) if (order.paid) expected.add(order.orderNumber);

  const plannedAny = new Set();
  for (const s of [...(assigned?.Morning || []), ...(assigned?.Evening || [])]) plannedAny.add(s.base);
  /// A Morning-booked order driven by the Evening half still counts as planned:
  /// the customer is served, whichever crew does it.
  const covered = [...expected].filter((n) => plannedAny.has(n));

  const plannedNums = [...new Set(stops.map((s) => s.base))].sort();

  let bagCount = 0;
  for (const n of plannedNums) bagCount += lookup.get(n)?.totalBags || 0;

  /// Full datetime, never "HH:MM": an Evening that starts at 17:09 has a 01:11
  /// stop after midnight, and a string min would pick that one (critique D2).
  const ordered = sortedByRoute(stops);
  const first = ordered.find((s) => parseStopDt(s.scheduledAtDt)) || ordered[0] || null;
  const firstDt = first ? parseStopDt(first.scheduledAtDt) : null;
  /// In-app only (§6.6): the payload builders never receive it.
  const firstName = first ? str(first.locationName) || str(first.address) : "";

  const routes = groupStopsByDriver(stops).map((route) => ({
    driver: route.driver,
    stops: route.stops.map((s) => plannedStopFromOptimo(s, lookup.get(s.base))),
  }));

  return {
    slot,
    stopCount: stops.length,
    bagCount,
    expectedOrderCount: expected.size,
    plannedOrderCount: covered.length,
    orderNumbers: plannedNums,
    planHash: planHash(stops),
    firstStopDt: firstDt ? new Date(firstDt.epoch) : null,
    firstStopAt: firstDt ? firstDt.hhmm : first?.scheduledAt || null,
    firstStopName: firstName ? firstName.slice(0, FIRST_STOP_NAME_MAX) : null,
    routes,
  };
}

const epochOf = (v) => {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

const sameSet = (a, b) => {
  const x = new Set(a || []);
  const y = new Set(b || []);
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
};

/// Is `current` different enough from the version people were told about to
/// deserve a "BREYTT:"? Count, order set, or the first stop moving ≥ 15 min —
/// on epochs, so 23:55 → 00:05 next day is 10 min, not a day (§6.3).
export function isMaterialChange(prevPublished, current) {
  if (!prevPublished) return true;
  if ((prevPublished.stopCount ?? 0) !== (current.stopCount ?? 0)) return true;
  if (!sameSet(prevPublished.orderNumbers, current.orderNumbers)) return true;
  const a = epochOf(prevPublished.firstStopDt);
  const b = epochOf(current.firstStopDt);
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return Math.abs(a - b) >= MATERIAL_FIRST_STOP_MS;
}

/// The §6.3 table, evaluated in order. `latest` is the newest snapshot version
/// (with firstSeenAt, stopCount, orderNumbers, firstStopDt, covered, expected),
/// `publishedVersion` the newest version with published_at, or null.
export function decidePlanPush({ latest, publishedVersion = null, revisionsSent = 0, now, kind }) {
  const rule = PUSH_KINDS[kind];
  if (!rule) return { action: "none", reason: "not_announced" };
  if (!latest || (latest.stopCount ?? 0) === 0) return { action: "none", reason: "no_stops" };

  const hhmm = hhmmUTC(now);
  if (hhmm < rule.open || hhmm > rule.close) return { action: "none", reason: "outside_window" };

  const seen = epochOf(latest.firstSeenAt);
  if (seen === null || new Date(now).getTime() - seen < STABLE_MS) return { action: "none", reason: "not_stable" };

  if (!publishedVersion) {
    const complete = (latest.covered ?? 0) >= (latest.expected ?? 0);
    if (complete || hhmm >= rule.deadline) return { action: "publish", reason: null };
    return { action: "none", reason: "incomplete" };
  }

  if (
    latest.version > publishedVersion.version &&
    isMaterialChange(publishedVersion, latest) &&
    revisionsSent < MAX_REVISIONS
  ) {
    return { action: "revise", reason: null };
  }
  return { action: "none", reason: "no_material_change" };
}

export default {
  DEFAULT_SLOT_SPLIT,
  ROUTE_DAY_CUTOFF,
  PUSH_KINDS,
  routeDayOf,
  orderSetsForDate,
  orderSetsByDate,
  slotOfStop,
  assignStops,
  computeShiftPlan,
  planHash,
  isMaterialChange,
  decidePlanPush,
};
