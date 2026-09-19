// ---------------------------------------------------------------------------
// Shift read model (spec §4.5, §5.4)
// ---------------------------------------------------------------------------
//
// Two sources, one output shape (StaffShift): driving shifts from Vaktaskipulag
// and counter shifts from BSÍ Counter Shifts. Everything Airtable-facing is
// cached in a window around today, because three pilots refreshing "Í dag" must
// not cost three reads each.
//
// The pure parts (role, labels, plan state, range validation, sorting) are
// exported on their own so the tests can drive them without a client.

import {
  TABLES,
  SHIFT,
  COUNTER,
  SHIFT_FIELDS,
  COUNTER_FIELDS,
  ORDER_COUNT_FIELDS,
  ORDER_DETAIL_FIELDS,
  ORDER,
  escapeFormulaValue,
} from "../airtable/fields.js";
import { createCache } from "../airtable/client.js";
import { countsForSet, normalizeOrder, orderSetsByDate, orderSetsForDate } from "../plan/planModel.js";
import { addDays, isoSec, todayUTC } from "../time.js";

/// How far the cached windows reach around today. The lower bound matches the
/// `from >= today−35` validation in §4.5, so a valid request is always inside a
/// window that is already in memory.
export const WINDOW_BACK_DAYS = 35;
export const WINDOW_FORWARD_DAYS = 45;

const WINDOW_TTL_MS = 5 * 60 * 1000;
const WINDOW_STALE_MS = 60 * 60 * 1000;
const ORDERS_WINDOW_TTL_MS = 10 * 60 * 1000;
const ORDERS_WINDOW_MAX = 50; // LRU cap for custom ranges (§5.4)
const ORDERS_TODAY_TTL_MS = 3 * 60 * 1000;
const ORDERS_PAST_TTL_MS = 60 * 60 * 1000;
const ORDERS_PAGE_CAP = 30;
const ORPHAN_BATCH = 40;

/// Range rules from §4.5.
export const DEFAULT_RANGE_BACK_DAYS = 7;
export const DEFAULT_RANGE_FORWARD_DAYS = 30;
export const MAX_RANGE_DAYS = 62;

/// Applications are appended to the ops Comment behind this sentinel by the
/// website (utils/staff/airtable.ts:115). Staff must see the ops text only.
const APPLY_SENTINEL = "⟦Umsóknir⟧";

const SLOT_RANK = { Morning: 0, Midday: 1, Evening: 2, Custom: 3 };

const SHIFT_REF_RE = /^(vakt|bsi)_rec[A-Za-z0-9]{14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^\d{2}:\d{2}$/;

const str = (v) => (typeof v === "string" ? v.trim() : "");
const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

// --- pure helpers ---------------------------------------------------------

export function stripApplications(raw) {
  const s = typeof raw === "string" ? raw : "";
  const idx = s.indexOf(APPLY_SENTINEL);
  return (idx === -1 ? s : s.slice(0, idx)).replace(/\s+$/, "").trim();
}

/// `vakt_recXXXXXXXXXXXXXX` / `bsi_recXXXXXXXXXXXXXX` → { kind, airtableId }.
export function parseShiftRef(ref) {
  const s = str(ref);
  if (!SHIFT_REF_RE.test(s)) return null;
  const [prefix, id] = [s.slice(0, s.indexOf("_")), s.slice(s.indexOf("_") + 1)];
  return { kind: prefix === "vakt" ? "driving" : "counter", prefix, airtableId: id };
}

/// A real UTC date that round-trips, so "2026-02-31" is rejected rather than
/// silently read as 2026-03-03.
export function isRealDate(value) {
  const s = str(value);
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validateRange({ from, to, today }) {
  const f = from === undefined || from === null || from === "" ? addDays(today, -DEFAULT_RANGE_BACK_DAYS) : str(from);
  const t = to === undefined || to === null || to === "" ? addDays(today, DEFAULT_RANGE_FORWARD_DAYS) : str(to);
  if (!isRealDate(f) || !isRealDate(t)) return { ok: false, error: "invalid_range" };
  if (f < addDays(today, -WINDOW_BACK_DAYS)) return { ok: false, error: "invalid_range" };
  if (f > t) return { ok: false, error: "invalid_range" };
  const span = (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000;
  if (span > MAX_RANGE_DAYS) return { ok: false, error: "invalid_range" };
  return { ok: true, from: f, to: t };
}

/// Which role this person has on a driving row (§5.4).
///
/// Every linked Bílstjóri is a driver — two-person shifts are 2+ links, not a
/// driver plus a helper. The old Starfsmaður first-name rule is deliberately
/// gone: the field was last used 2025-12-30 and its values ("Gabríel") do not
/// equal the roster's First values ("Gabríel Andri").
export function driverRoleFor(row, staffAirtableId) {
  if (!staffAirtableId) return null;
  if (row.driverIds.includes(staffAirtableId)) return "driver";
  if (row.extraIds.includes(staffAirtableId)) return "extra";
  if (row.otherIds.includes(staffAirtableId)) return "other";
  return null;
}

export function normalizeShiftRow(record) {
  const f = record.fields || {};
  const slot = str(f[SHIFT.shift]);
  /// Vakt byrjar is an instant; Iceland is UTC, so slicing the ISO string is the
  /// wall time. Set on 1 of 1,799 rows, hence null nearly always.
  const startIso = str(f[SHIFT.vaktByrjar]);
  const started = startIso ? new Date(startIso) : null;
  return {
    id: record.id,
    ref: `vakt_${record.id}`,
    kind: "driving",
    date: str(f[SHIFT.date]).slice(0, 10),
    slot: slot === "Morning" || slot === "Evening" ? slot : "",
    startTime: started && !Number.isNaN(started.getTime()) ? started.toISOString().slice(11, 16) : null,
    driverIds: ids(f[SHIFT.driver]),
    extraIds: ids(f[SHIFT.extraDriver]),
    otherIds: ids(f[SHIFT.other]),
    comment: stripApplications(f[SHIFT.comment]),
  };
}

export function normalizeCounterRow(record) {
  const f = record.fields || {};
  const slot = str(f[COUNTER.slot]);
  return {
    id: record.id,
    ref: `bsi_${record.id}`,
    kind: "counter",
    date: str(f[COUNTER.date]).slice(0, 10),
    slot: slot || "Custom",
    start: str(f[COUNTER.start]),
    end: str(f[COUNTER.end]),
    staffIds: ids(f[COUNTER.staff]),
    status: str(f[COUNTER.status]),
    notes: str(f[COUNTER.notes]),
  };
}

export function drivingLabel(slot) {
  return slot === "Evening" ? "Kvöldvakt" : "Morgunvakt";
}

export function counterLabel(slot) {
  if (slot === "Morning") return "BSÍ · Morgunn";
  if (slot === "Midday") return "BSÍ · Miðdagur";
  return "BSÍ · Sérvakt";
}

/// Start/End are free text on the Airtable row and are often blank; the two
/// standing slots then have fixed hours (§4.5).
export function counterTimes(row) {
  const start = HHMM_RE.test(row.start) ? row.start : "";
  const end = HHMM_RE.test(row.end) ? row.end : "";
  if (start && end) return { startTime: start, endTime: end };
  if (row.slot === "Morning") return { startTime: start || "09:00", endTime: end || "13:00" };
  if (row.slot === "Midday") return { startTime: start || "13:00", endTime: end || "17:00" };
  return { startTime: start || null, endTime: end || null };
}

const EMPTY_PLAN = {
  state: "none",
  version: null,
  latestVersion: null,
  stopCount: 0,
  bagCount: 0,
  firstStopAt: null,
  firstStopName: null,
  publishedAt: null,
};

/// The `plan` block of a driving StaffShift (§4.5).
///
/// `pending` is what lets the app say "Áætlun kemur ~17:00" — but only while the
/// push window is still open. Once it has closed the shift falls back to `none`,
/// so nobody reads "coming at 17:00" on the morning of the shift itself.
export function planStateFor({ date, slot, plan, now, today = todayUTC(now) }) {
  const published = plan?.published || null;
  const latest = plan?.latest || null;

  if (published) {
    return {
      state: "published",
      version: published.version ?? null,
      latestVersion: latest?.version ?? published.version ?? null,
      /// Counts come from the latest version (freshest), the version number from
      /// the published one (what people were actually told).
      stopCount: latest?.stopCount ?? published.stopCount ?? 0,
      bagCount: latest?.bagCount ?? published.bagCount ?? 0,
      firstStopAt: latest?.firstStopAt ?? published.firstStopAt ?? null,
      firstStopName: latest?.firstStopName ?? published.firstStopName ?? null,
      publishedAt: isoSec(published.publishedAt) ?? null,
    };
  }

  const nowHHMM = new Date(now).toISOString().slice(11, 16);
  const tomorrow = addDays(today, 1);
  const pending =
    (slot === "Morning" && date === tomorrow && nowHHMM < "21:30") ||
    (slot === "Evening" && date === today && nowHHMM < "18:00");

  return { ...EMPTY_PLAN, state: pending ? "pending" : "none" };
}

export function toDrivingShift({ row, role, counts, plan, confirmation, now, today }) {
  return {
    ref: row.ref,
    kind: "driving",
    airtableId: row.id,
    date: row.date,
    slot: row.slot,
    label: drivingLabel(row.slot),
    startTime: row.startTime,
    endTime: null,
    role,
    orderCount: counts?.orderCount || 0,
    bagCount: counts?.bagCount || 0,
    comment: row.comment || "",
    status: null,
    plan: planStateFor({ date: row.date, slot: row.slot, plan, now, today }),
    confirmation: confirmation || null,
  };
}

export function toCounterShift({ row, confirmation }) {
  const { startTime, endTime } = counterTimes(row);
  return {
    ref: row.ref,
    kind: "counter",
    airtableId: row.id,
    date: row.date,
    slot: row.slot,
    label: counterLabel(row.slot),
    startTime,
    endTime,
    role: "counter",
    orderCount: 0,
    bagCount: 0,
    comment: row.notes || "",
    status: row.status || null,
    plan: null,
    confirmation: confirmation || null,
  };
}

export function sortShifts(shifts) {
  return shifts.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const ra = SLOT_RANK[a.slot] ?? 9;
    const rb = SLOT_RANK[b.slot] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.startTime || "").localeCompare(b.startTime || "");
  });
}

// --- service --------------------------------------------------------------

export function createShiftsService({ airtable, config = {}, now = Date.now, logger = console } = {}) {
  const windows = createCache({ now, logger, label: "shifts" });
  const ordersWindows = createCache({ now, logger, label: "orders-window", max: ORDERS_WINDOW_MAX });
  const ordersByDate = createCache({ now, logger, label: "orders-date" });

  const clock = () => new Date(now());

  function windowDates(today) {
    return { from: addDays(today, -WINDOW_BACK_DAYS), to: addDays(today, WINDOW_FORWARD_DAYS) };
  }

  /// Vaktaskipulag around today (~162 rows, 2 pages).
  async function vaktWindow(today, { interactive = true } = {}) {
    const { from, to } = windowDates(today);
    const { value, stale } = await windows.get(`vakt|${from}|${to}`, {
      ttlMs: WINDOW_TTL_MS,
      staleMs: WINDOW_STALE_MS,
      load: async () => {
        const formula =
          `AND(DATETIME_FORMAT({${SHIFT.date}},'YYYY-MM-DD')>='${from}', DATETIME_FORMAT({${SHIFT.date}},'YYYY-MM-DD')<='${to}')`;
        const { records } = await airtable.listAll(TABLES.shifts, {
          filterByFormula: formula,
          fields: SHIFT_FIELDS,
          interactive,
        });
        const rows = records.map(normalizeShiftRow).filter((r) => r.date);
        return { rows, byId: new Map(rows.map((r) => [r.id, r])) };
      },
    });
    return { ...value, stale };
  }

  /// BSÍ counter rows. The date field is a real date, so the window uses
  /// IS_AFTER/IS_BEFORE with one day of slack on each side.
  async function bsiWindow(today, { interactive = true } = {}) {
    const { from, to } = windowDates(today);
    const { value, stale } = await windows.get(`bsi|${from}|${to}`, {
      ttlMs: WINDOW_TTL_MS,
      staleMs: WINDOW_STALE_MS,
      load: async () => {
        const formula =
          `AND(IS_AFTER({${COUNTER.date}}, DATEADD('${from}',-1,'days')), IS_BEFORE({${COUNTER.date}}, DATEADD('${to}',1,'days')))`;
        const { records } = await airtable.listAll(TABLES.counter, {
          filterByFormula: formula,
          fields: COUNTER_FIELDS,
          interactive,
        });
        return records.map(normalizeCounterRow).filter((r) => r.date);
      },
    });
    return { rows: value, stale };
  }

  /// Orders for a whole requested range, for orderCount/bagCount only.
  async function ordersWindow(from, to, { interactive = true } = {}) {
    const { value, stale } = await ordersWindows.get(`${from}|${to}`, {
      ttlMs: ORDERS_WINDOW_TTL_MS,
      staleMs: WINDOW_STALE_MS,
      load: async () => {
        const formula =
          `AND(IS_AFTER({${ORDER.pickupDate}}, DATEADD('${from}',-1,'days')), IS_BEFORE({${ORDER.pickupDate}}, DATEADD('${to}',1,'days')))`;
        const { records, pages } = await airtable.listAll(TABLES.orders, {
          filterByFormula: formula,
          fields: ORDER_COUNT_FIELDS,
          maxPages: ORDERS_PAGE_CAP,
          interactive,
        });
        /// B4 wants the page count for the default window: the size of this read
        /// is the one number in §5.5's call budget that was never measured.
        logger.info?.(`[shifts] orders window ${from}..${to} rows=${records.length} pages=${pages}`);
        return records.map(normalizeOrder).filter(Boolean);
      },
    });
    return { orders: value, stale };
  }

  /// One date's orders with the detail fields. Past dates are frozen, so they
  /// are cached far longer than today's.
  async function ordersForDate(date, { today = todayUTC(clock()), interactive = true } = {}) {
    const { value, stale } = await ordersByDate.get(date, {
      ttlMs: date >= today ? ORDERS_TODAY_TTL_MS : ORDERS_PAST_TTL_MS,
      staleMs: WINDOW_STALE_MS,
      load: async () => {
        const { records } = await airtable.listAll(TABLES.orders, {
          filterByFormula: `IS_SAME({${ORDER.pickupDate}},'${date}','day')`,
          fields: ORDER_DETAIL_FIELDS,
          interactive,
        });
        return records.map(normalizeOrder).filter(Boolean);
      },
    });
    return { orders: value, stale };
  }

  /// Orphan stops: legs whose order is dated another day, or has no Airtable row
  /// at all. Looked up by order number regardless of date (§5.4).
  async function ordersByNumbers(numbers, { date, today = todayUTC(clock()), interactive = true } = {}) {
    const unique = [...new Set((numbers || []).filter(Boolean))].sort();
    if (!unique.length) return { orders: [], stale: false };
    const { value, stale } = await ordersByDate.get(`orphans|${date}|${unique.join(",")}`, {
      ttlMs: date >= today ? ORDERS_TODAY_TTL_MS : ORDERS_PAST_TTL_MS,
      staleMs: WINDOW_STALE_MS,
      load: async () => {
        const out = [];
        for (let i = 0; i < unique.length; i += ORPHAN_BATCH) {
          const batch = unique.slice(i, i + ORPHAN_BATCH);
          const formula = `OR(${batch.map((n) => `{${ORDER.orderNumber}}='${escapeFormulaValue(n)}'`).join(",")})`;
          const { records } = await airtable.listAll(TABLES.orders, {
            filterByFormula: formula,
            fields: ORDER_DETAIL_FIELDS,
            interactive,
          });
          out.push(...records.map(normalizeOrder).filter(Boolean));
        }
        return out;
      },
    });
    return { orders: value, stale };
  }

  /// GET /v2/me/shifts (§4.5). `plans` and `confirmations` are Postgres data the
  /// route layer passes in, keyed by shift ref, so this module stays DB-free.
  async function listShiftsForStaff({ staff, from, to, plans = new Map(), confirmations = new Map(), nowDate = clock() }) {
    const today = todayUTC(nowDate);
    const range = validateRange({ from, to, today });
    if (!range.ok) return range;

    const [vakt, bsi] = await Promise.all([vaktWindow(today), bsiWindow(today)]);
    let stale = vakt.stale || bsi.stale;

    const driving = vakt.rows.filter((row) => {
      if (row.date < range.from || row.date > range.to || !row.slot) return false;
      return driverRoleFor(row, staff.airtableId) !== null;
    });

    const counter = bsi.rows.filter(
      (row) =>
        row.date >= range.from &&
        row.date <= range.to &&
        row.staffIds.includes(staff.airtableId) &&
        /// Cancelled rows are hidden; a staffed `Open` row is still shown,
        /// because that is a shift somebody is expected to work.
        row.status !== "Cancelled"
    );

    /// One ranged Orders read serves every driving row's counts.
    let setsByDate = new Map();
    if (driving.length) {
      const orders = await ordersWindow(range.from, range.to);
      stale = stale || orders.stale;
      setsByDate = orderSetsByDate(orders.orders, vakt.byId);
    }

    const shifts = [
      ...driving.map((row) =>
        toDrivingShift({
          row,
          role: driverRoleFor(row, staff.airtableId),
          counts: countsForSet(setsByDate.get(row.date)?.[row.slot]),
          plan: plans.get(row.ref),
          confirmation: confirmations.get(row.ref),
          now: nowDate,
          today,
        })
      ),
      ...counter.map((row) => toCounterShift({ row, confirmation: confirmations.get(row.ref) })),
    ];

    return {
      ok: true,
      from: range.from,
      to: range.to,
      generatedAt: isoSec(nowDate),
      stale,
      shifts: sortShifts(shifts),
    };
  }

  /// One shift the caller is actually on. Returns null for every "no" — wrong
  /// ref, not their shift, too old — so the route has a single 404 path and
  /// cannot be used to probe which refs exist (§4.5).
  async function getShiftForStaff({ staff, ref, plans = new Map(), confirmations = new Map(), nowDate = clock(), maxAgeDays = 7 }) {
    const parsed = parseShiftRef(ref);
    if (!parsed) return { ok: false, error: "invalid_ref" };

    const today = todayUTC(nowDate);
    const oldest = addDays(today, -maxAgeDays);

    if (parsed.kind === "counter") {
      const bsi = await bsiWindow(today);
      const row = bsi.rows.find((r) => r.id === parsed.airtableId);
      if (!row || !row.staffIds.includes(staff.airtableId) || row.status === "Cancelled" || row.date < oldest) {
        return { ok: false, error: "not_found" };
      }
      return { ok: true, kind: "counter", row, role: "counter", stale: bsi.stale, shift: toCounterShift({ row, confirmation: confirmations.get(row.ref) }) };
    }

    const vakt = await vaktWindow(today);
    const row = vakt.byId.get(parsed.airtableId);
    const role = row ? driverRoleFor(row, staff.airtableId) : null;
    if (!row || !role || !row.slot || row.date < oldest) return { ok: false, error: "not_found" };

    const { orders, stale: ordersStale } = await ordersForDate(row.date, { today });
    const sets = orderSetsForDate(orders, vakt.byId, row.date);

    return {
      ok: true,
      kind: "driving",
      row,
      role,
      stale: vakt.stale || ordersStale,
      orders,
      orderSets: sets,
      shiftRowsById: vakt.byId,
      shift: toDrivingShift({
        row,
        role,
        counts: countsForSet(sets[row.slot]),
        plan: plans.get(row.ref),
        confirmation: confirmations.get(row.ref),
        now: nowDate,
        today,
      }),
    };
  }

  return {
    listShiftsForStaff,
    getShiftForStaff,
    vaktWindow,
    bsiWindow,
    ordersWindow,
    ordersForDate,
    ordersByNumbers,
    config,
  };
}

export default createShiftsService;
