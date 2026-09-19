// ---------------------------------------------------------------------------
// plan-detect job (spec §6.3, §6.4, §6.5, §6.7)
// ---------------------------------------------------------------------------
//
// One run = one OptimoRoute read per date, one snapshot upsert per staffed
// driving shift, one "published?" decision per shift that has a push kind, and
// then a reconcile of sends for every shift whose window is open. The four parts
// are kept apart on purpose:
//
//   compute   → pure (planModel) on top of read-only Optimo + Airtable
//   snapshot  → the only Postgres write, in a transaction under the per-shift lock
//   decide    → pure (decidePlanPush), marked in that same transaction
//   reconcile → the sender, which owns push_log and the dedupe keys
//
// so a manual dry run (the internal endpoints) can do the first and the third
// with nothing written, and a crash between any two of them costs at most one
// run's worth of delay — never a double push and never a lost decision.
//
// Every timestamp in a run comes from the ONE `now` the run started with: the
// "unchanged for 10 minutes" rule compares first_seen_at against it, and two
// runs 10 minutes apart must see exactly 10 minutes, not 9:59.8 because the
// insert happened a few hundred ms after the tick.
//
// READ ONLY towards Airtable and OptimoRoute. Nothing here plans, dispatches or
// completes a stop.

import {
  PUSH_KINDS,
  assignStops,
  computeShiftPlan,
  decidePlanPush,
  inWindow,
  kindFor,
  orderSetsForDate,
} from "./planModel.js";
import { collapseIdFor, expirationFor, planPushPayload } from "../push/payloads.js";
import { createRunState } from "../push/sender.js";
import { addDays, hhmmUTC, isoSec, todayUTC } from "../time.js";

/// From this time of day the run also reads tomorrow (§6.4): tomorrow's Morning
/// is announced the evening before, and the planner's 14:30 pass is what puts it
/// into OptimoRoute in the first place.
export const TOMORROW_FROM = "14:30";

/// A driving row is a shift only when somebody is on it (§6.3).
export const isStaffed = (row) => row.driverIds.length + row.extraIds.length + row.otherIds.length > 0;

/// The people on a row, in the order the detail lists them (§5.4).
export function recipientsOf(row, rosterById = null) {
  const seen = new Set();
  const out = [];
  for (const id of [...row.driverIds, ...row.extraIds, ...row.otherIds]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ airtableStaffId: id, name: rosterById?.get?.(id)?.displayName ?? null });
  }
  return out;
}

/// Which dates a run at `now` covers (§6.4). Before 14:30 only today exists in
/// OptimoRoute; from 14:30 tomorrow's Morning is being planned too.
export function datesForRun(now) {
  const today = todayUTC(now);
  return hhmmUTC(now) >= TOMORROW_FROM ? [today, addDays(today, 1)] : [today];
}

/// The push_kind a decision marks a version with (§6.5).
export function pushKindFor(kind, action) {
  if (action === "revise") return "plan_revised";
  return PUSH_KINDS[kind]?.baseKind ?? "plan_published";
}

export function createPlanJob({
  db,
  config,
  optimo,
  shifts,
  roster = null,
  snapshots,
  sender,
  airtable = null,
  clock = () => new Date(),
  log = console,
}) {
  const split = config.planSlotSplit || "16:00";

  async function rosterById() {
    if (!roster?.getRoster) return null;
    try {
      return (await roster.getRoster({ interactive: false })).byId;
    } catch (err) {
      // Names are decoration on the report; the sender re-checks Active itself.
      log.error?.("[plan] roster read failed:", err?.code || err?.message);
      return null;
    }
  }

  /// Everything one date needs, read once: the routes, the orders booked for
  /// the date, the orphan orders behind stops from other dates, and the split
  /// of stops over the two crews. Throws on an OptimoRoute failure — the caller
  /// decides what a date without routes means.
  async function readDate(D, { today }) {
    const routes = await optimo.getRoutes(D);
    const { orders } = await shifts.ordersForDate(D, { today, interactive: false });
    const vakt = await shifts.vaktWindow(today, { interactive: false });
    const orderSets = orderSetsForDate(orders, vakt.byId, D);
    const assigned = assignStops(routes.stops, orderSets, D, split, { logger: log });

    const orderByNumber = new Map();
    for (const order of orders) orderByNumber.set(order.orderNumber, order);
    if (assigned.orphanBases.length) {
      const { orders: orphans } = await shifts.ordersByNumbers(assigned.orphanBases, { date: D, today, interactive: false });
      for (const order of orphans) orderByNumber.set(order.orderNumber, order);
    }

    /// Logged only (§6.2): the distinct dispatch states of the date's routes.
    const dispatchState = [...new Set(routes.drivers.map((d) => d.dispatchState).filter(Boolean))].sort().join(",") || null;

    return {
      date: D,
      routeCount: routes.routeCount,
      stopCount: routes.stops.length,
      excluded: assigned.excluded.length,
      slotMismatch: assigned.mismatches.length,
      orphans: assigned.orphanBases.length,
      assigned,
      orderSets,
      orderByNumber,
      dispatchState,
      rows: vakt.rows.filter((row) => row.date === D && row.slot && isStaffed(row)),
    };
  }

  /// The plan of one shift from an already-read date.
  function planFor(read, slot) {
    return computeShiftPlan({ assigned: read.assigned, orderSets: read.orderSets, slot, orderByNumber: read.orderByNumber });
  }

  /// Snapshot + decision for one shift, in one transaction whose first statement
  /// is the per-shift advisory lock (§6.5). Returns the state after the write.
  async function snapshotAndDecide({ row, plan, dispatchState, kind, now }) {
    return db.withTx(async (tx) => {
      await snapshots.lockShift(tx, row.ref);
      const up = await snapshots.upsert(tx, { shiftRef: row.ref, date: row.date, slot: row.slot, plan, dispatchState, now });
      const state = await snapshots.stateForRef(row.ref, { client: tx });
      const decision = decidePlanPush({
        latest: state.latest,
        publishedVersion: state.published,
        revisionsSent: state.revisionsSent,
        now,
        kind,
      });
      if (decision.action !== "none") {
        /// The decision is marked whatever PUSH_MODE and PLAN_PUSH_TONIGHT are
        /// (§6.5, O13): a shadow evening must show `published` in the app.
        await snapshots.markPublished(tx, {
          shiftRef: row.ref,
          version: state.latest.version,
          pushKind: pushKindFor(kind, decision.action),
          now,
        });
        state.published = { ...state.latest, publishedAt: now, pushKind: pushKindFor(kind, decision.action) };
      }
      return { ...up, decision, state };
    });
  }

  /// The dry-run twin: reads the stored state and pretends the plan was
  /// upserted, so the decision comes out as the real run's would — except that a
  /// brand-new version is `not_stable` by construction, since it has no
  /// first_seen_at yet.
  async function previewDecision({ row, plan, kind, now }) {
    const state = await snapshots.stateForRef(row.ref);
    const same = state.latest && state.latest.planHash === plan.planHash;
    /// The non-hashed columns are what the real upsert refreshes in place (§6.5),
    /// so the preview refreshes them too.
    const fresh = {
      bagCount: plan.bagCount,
      expected: plan.expectedOrderCount,
      covered: plan.plannedOrderCount,
      orderNumbers: plan.orderNumbers,
      firstStopDt: plan.firstStopDt,
      firstStopAt: plan.firstStopAt,
      firstStopName: plan.firstStopName,
    };
    const latest = same
      ? { ...state.latest, ...fresh }
      : {
          shiftRef: row.ref,
          version: (state.latest?.version ?? 0) + 1,
          planHash: plan.planHash,
          stopCount: plan.stopCount,
          ...fresh,
          firstSeenAt: now,
          lastSeenAt: now,
          publishedAt: null,
          pushKind: null,
        };
    const decision = decidePlanPush({ latest, publishedVersion: state.published, revisionsSent: state.revisionsSent, now, kind });
    return { version: latest.version, isNew: !same, latest, decision, state };
  }

  /// §6.5: every run inside the push window, the target version (latest with
  /// published_at) is offered to every current recipient. The sender's dedupe
  /// keys make this idempotent; skips are written under `…:skip:<reason>` keys so
  /// a PUSH_MODE flip inside the window delivers at the next run.
  async function reconcile({ row, kind, target, recipients, now, dryRun, triggeredBy, runState }) {
    const rule = PUSH_KINDS[kind];
    if (!rule || !target || !inWindow(now, rule.open, rule.close)) return null;

    const buildPayload = ({ airtableStaffId, kind: pushKind }) =>
      planPushPayload({
        kind: pushKind,
        shiftRef: row.ref,
        date: row.date,
        slot: row.slot,
        planVersion: target.version,
        recipient: airtableStaffId,
        stopCount: target.stopCount,
        bagCount: target.bagCount,
        firstStopAt: target.firstStopAt,
      });

    const res = await sender.sendShiftPush({
      shiftRef: row.ref,
      planVersion: target.version,
      baseKind: rule.baseKind,
      buildPayload,
      collapseId: collapseIdFor(row.ref),
      expiration: expirationFor({ shiftRef: row.ref, date: row.date, slot: row.slot, firstStopDt: target.firstStopDt }),
      recipients,
      triggeredBy,
      dryRun,
      runState,
    });
    return res.counts;
  }

  /// runPlanDetect({ now, dryRun, triggeredBy }) → the §6.7 report.
  async function runPlanDetect({ now = clock(), dryRun = false, triggeredBy = "job" } = {}) {
    const startedAt = new Date(now);
    const today = todayUTC(startedAt);
    const before = airtable?.stats?.requests ?? 0;
    const report = {
      job: "plan-detect",
      now: isoSec(startedAt),
      dryRun,
      optimoCalls: 0,
      airtableCalls: 0,
      dates: [],
      shifts: [],
      errors: [],
    };
    const runState = createRunState();
    const names = await rosterById();

    for (const D of datesForRun(startedAt)) {
      let read = null;
      report.optimoCalls += 1;
      try {
        read = await readDate(D, { today });
        report.dates.push({
          date: D,
          routeCount: read.routeCount,
          stopCount: read.stopCount,
          excluded: read.excluded,
          slotMismatch: read.slotMismatch,
          orphans: read.orphans,
          dispatchState: read.dispatchState,
        });
      } catch (err) {
        // The date's decisions wait for the next run; its sends do not (below).
        const code = err?.code || err?.message || "error";
        log.error?.(`[plan] ${D} read failed: ${code}`);
        report.errors.push({ date: D, error: code });
      }

      /// Without routes there is no plan to write, but shifts published earlier
      /// still get their reconcile: a device signing in at 17:15 must not wait
      /// for OptimoRoute to come back.
      let rows = read?.rows;
      if (!rows) {
        try {
          const vakt = await shifts.vaktWindow(today, { interactive: false });
          rows = vakt.rows.filter((row) => row.date === D && row.slot && isStaffed(row));
        } catch (err) {
          report.errors.push({ date: D, error: err?.code || err?.message || "error" });
          continue;
        }
      }

      for (const row of rows) {
        /// Tomorrow's Evening has no kind and is not computed (§6.3): it would
        /// read as `no_stops` and hide the shift.
        const kind = kindFor(D, row.slot, today);
        if (D !== today && !kind) continue;

        const entry = {
          ref: row.ref,
          date: D,
          slot: row.slot,
          kind,
          stopCount: null,
          expected: null,
          covered: null,
          version: null,
          newVersion: false,
          decision: "none",
          reason: null,
          sends: null,
        };
        report.shifts.push(entry);

        let state = null;
        try {
          if (read) {
            const plan = planFor(read, row.slot);
            entry.stopCount = plan.stopCount;
            entry.expected = plan.expectedOrderCount;
            entry.covered = plan.plannedOrderCount;
            const out = dryRun
              ? await previewDecision({ row, plan, kind, now: startedAt })
              : await snapshotAndDecide({ row, plan, dispatchState: read.dispatchState, kind, now: startedAt });
            entry.version = out.version;
            entry.newVersion = out.isNew;
            entry.decision = out.decision.action;
            entry.reason = out.decision.reason;
            state = out.state;
            if (out.decision.action !== "none") {
              log.log?.(
                `[plan] ${row.ref} ${D} ${row.slot} v${out.version} decision=${out.decision.action}` +
                  ` push_mode=${config.pushMode}${dryRun ? " (dry run, nothing written)" : ""}`,
              );
            }
          } else {
            entry.reason = "optimo_unavailable";
            state = await snapshots.stateForRef(row.ref);
          }

          if (kind) {
            const target = state?.published ?? null;
            if (target && !entry.version) entry.version = target.version;
            entry.sends = await reconcile({
              row, kind, target, recipients: recipientsOf(row, names),
              now: startedAt, dryRun, triggeredBy, runState,
            });
            if (entry.sends && config.pushMode === "off" && !dryRun) {
              log.log?.(`[plan] ${row.ref} v${target.version} PUSH_MODE=off — dry run of the send: ${entry.sends.skipped} skipped, nothing sent`);
            }
          }
        } catch (err) {
          const code = err?.code || err?.message || "error";
          log.error?.(`[plan] ${row.ref} failed: ${code}`);
          entry.reason = code;
          report.errors.push({ ref: row.ref, error: code });
        }
      }
    }

    report.airtableCalls = Math.max(0, (airtable?.stats?.requests ?? 0) - before);
    log.log?.(
      `[plan] run ${report.now} dryRun=${dryRun} optimo=${report.optimoCalls} airtable=${report.airtableCalls}` +
        ` shifts=${report.shifts.length} decisions=${report.shifts.filter((s) => s.decision !== "none").length} errors=${report.errors.length}`,
    );
    return report;
  }

  /// One shift, now — the internal plan-published endpoint (§4.7). One OR call,
  /// the plan, and (unless dryRun) the upsert and the published_at mark under the
  /// same per-shift lock the job takes. Sends are the caller's business.
  async function planForShift({ row, now = clock(), dryRun = true }) {
    const today = todayUTC(now);
    const read = await readDate(row.date, { today });
    const plan = planFor(read, row.slot);
    if (plan.stopCount === 0) return { ok: false, error: "no_plan", plan };

    const kind = kindFor(row.date, row.slot, today);
    if (dryRun) {
      const preview = await previewDecision({ row, plan, kind, now });
      return { ok: true, plan, version: preview.version, isNew: preview.isNew, target: preview.latest, state: preview.state, kind };
    }

    const out = await db.withTx(async (tx) => {
      await snapshots.lockShift(tx, row.ref);
      const up = await snapshots.upsert(tx, { shiftRef: row.ref, date: row.date, slot: row.slot, plan, dispatchState: read.dispatchState, now });
      const state = await snapshots.stateForRef(row.ref, { client: tx });
      /// A manual publish of a version above an already published one is a
      /// revision; the first one is the kind's own title (or `plan_published`
      /// for a date outside both windows).
      const pushKind = state.published && state.published.version < state.latest.version ? "plan_revised" : pushKindFor(kind, "publish");
      await snapshots.markPublished(tx, { shiftRef: row.ref, version: state.latest.version, pushKind, now });
      const target = await snapshots.versionWithRoutes(row.ref, state.latest.version, { client: tx });
      return { ...up, target, state };
    });
    return { ok: true, plan, version: out.version, isNew: out.isNew, target: out.target, state: out.state, kind };
  }

  return { runPlanDetect, planForShift, readDate, datesForRun };
}

export default createPlanJob;
