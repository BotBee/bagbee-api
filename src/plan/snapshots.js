// ---------------------------------------------------------------------------
// plan_snapshots store (spec §3.3, §6.5)
// ---------------------------------------------------------------------------
//
// The only writer of plan_snapshots. Three rules live here and nowhere else:
//
//   1. A version is a hash. The same hash as the latest version refreshes that
//      row in place (last_seen_at plus the non-hashed columns, critique D9); a
//      different hash is a new version, even one that returns to an old value.
//   2. Every upsert starts with pg_advisory_xact_lock('plan:<ref>'), shared with
//      the internal plan-published endpoint, so two "latest + 1" inserts cannot
//      collide on UNIQUE (shift_ref, version) (critique D15).
//   3. published_at marks a DECISION, not a delivery (§6.5, critique O13). It is
//      set whatever PUSH_MODE is; sends are tracked only in push_log.
//
// Timestamps are written from the job's clock rather than now(): the "unchanged
// for 10 minutes" rule compares first_seen_at with that same clock, so a skew
// between Postgres and the process can neither delay nor rush a publish.

import { pgTextArray } from "../auth/identity.js";
import { isoSec } from "../time.js";

const VERSION_COLUMNS = `id, shift_ref, plan_date, slot, version, plan_hash, stop_count, bag_count,
  expected_order_count, planned_order_count, order_numbers, first_stop_dt, first_stop_at, first_stop_name,
  or_dispatch_state, first_seen_at, last_seen_at, published_at, push_kind`;

/// A row in the camelCase shape decidePlanPush / isMaterialChange read (§6.3).
export function versionOf(row) {
  if (!row) return null;
  return {
    id: row.id,
    shiftRef: row.shift_ref,
    date: typeof row.plan_date === "string" ? row.plan_date.slice(0, 10) : isoSec(row.plan_date)?.slice(0, 10) ?? null,
    slot: row.slot,
    version: row.version,
    planHash: row.plan_hash,
    stopCount: row.stop_count ?? 0,
    bagCount: row.bag_count ?? 0,
    expected: row.expected_order_count ?? 0,
    covered: row.planned_order_count ?? 0,
    orderNumbers: Array.isArray(row.order_numbers) ? row.order_numbers : [],
    firstStopDt: row.first_stop_dt ? new Date(row.first_stop_dt) : null,
    firstStopAt: row.first_stop_at ?? null,
    firstStopName: row.first_stop_name ?? null,
    dispatchState: row.or_dispatch_state ?? null,
    firstSeenAt: row.first_seen_at ? new Date(row.first_seen_at) : null,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    publishedAt: row.published_at ? new Date(row.published_at) : null,
    pushKind: row.push_kind ?? null,
    routes: row.routes ?? undefined,
  };
}

export function createSnapshotStore(db) {
  /// Every version of a shift, oldest first, without the routes blob.
  async function versionsForRef(ref, { client = db } = {}) {
    const { rows } = await client.query(
      `SELECT ${VERSION_COLUMNS} FROM plan_snapshots WHERE shift_ref = $1 ORDER BY version`,
      [ref],
    );
    return rows.map(versionOf);
  }

  /// { latest, published, revisionsSent } — what decidePlanPush needs (§6.3).
  async function stateForRef(ref, { client = db } = {}) {
    const versions = await versionsForRef(ref, { client });
    const latest = versions.at(-1) ?? null;
    const published = versions.filter((v) => v.publishedAt).at(-1) ?? null;
    const revisionsSent = versions.filter((v) => v.pushKind === "plan_revised").length;
    return { versions, latest, published, revisionsSent };
  }

  /// The shift detail's snapshot source (§5.5): the newest version with its
  /// routes, in the { version, lastSeenAt, routes } shape createShiftDetail reads.
  async function latestForRef(ref) {
    const { rows } = await db.query(
      `SELECT version, last_seen_at, routes FROM plan_snapshots
        WHERE shift_ref = $1 ORDER BY version DESC LIMIT 1`,
      [ref],
    );
    const row = rows[0];
    if (!row) return null;
    return { version: row.version, lastSeenAt: new Date(row.last_seen_at), routes: row.routes || [] };
  }

  /// One version with its routes — the internal plan-published endpoint builds
  /// its payload from the version it just marked, not from the live routes.
  async function versionWithRoutes(ref, version, { client = db } = {}) {
    const { rows } = await client.query(
      `SELECT ${VERSION_COLUMNS}, routes FROM plan_snapshots WHERE shift_ref = $1 AND version = $2`,
      [ref, version],
    );
    return versionOf(rows[0]);
  }

  /// Every version on a date, for plan-status (§4.7).
  async function versionsForDate(date) {
    const { rows } = await db.query(
      `SELECT ${VERSION_COLUMNS} FROM plan_snapshots WHERE plan_date = $1::date ORDER BY shift_ref, version`,
      [date],
    );
    return rows.map(versionOf);
  }

  /// Must run inside a transaction whose FIRST statement was the per-shift
  /// advisory lock — see lockShift(). Returns { version, isNew, latest }.
  async function upsert(tx, { shiftRef, date, slot, plan, dispatchState = null, now }) {
    const versions = await versionsForRef(shiftRef, { client: tx });
    const latest = versions.at(-1) ?? null;
    const routesJson = JSON.stringify(plan.routes || []);

    if (latest && latest.planHash === plan.planHash) {
      /// Same plan: the customer-facing columns still move (a bag count edited in
      /// Airtable, a phone number corrected), so they are refreshed rather than
      /// frozen from the first run. The hashed columns are unchanged by definition.
      await tx.query(
        `UPDATE plan_snapshots
            SET last_seen_at = $2, routes = $3::jsonb, bag_count = $4, expected_order_count = $5,
                planned_order_count = $6, order_numbers = $7::text[], first_stop_dt = $8, first_stop_at = $9,
                first_stop_name = $10, or_dispatch_state = $11
          WHERE id = $1`,
        [
          latest.id, now, routesJson, plan.bagCount, plan.expectedOrderCount, plan.plannedOrderCount,
          pgTextArray(plan.orderNumbers), plan.firstStopDt, plan.firstStopAt, plan.firstStopName, dispatchState,
        ],
      );
      return {
        version: latest.version,
        isNew: false,
        latest: {
          ...latest, lastSeenAt: now, bagCount: plan.bagCount, expected: plan.expectedOrderCount,
          covered: plan.plannedOrderCount, orderNumbers: plan.orderNumbers, firstStopDt: plan.firstStopDt,
          firstStopAt: plan.firstStopAt, firstStopName: plan.firstStopName, dispatchState,
        },
      };
    }

    const version = (latest?.version ?? 0) + 1;
    const { rows } = await tx.query(
      `INSERT INTO plan_snapshots
         (shift_ref, plan_date, slot, version, plan_hash, stop_count, bag_count, expected_order_count,
          planned_order_count, order_numbers, first_stop_dt, first_stop_at, first_stop_name, routes,
          or_dispatch_state, first_seen_at, last_seen_at)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12, $13, $14::jsonb, $15, $16, $16)
       RETURNING ${VERSION_COLUMNS}`,
      [
        shiftRef, date, slot, version, plan.planHash, plan.stopCount, plan.bagCount, plan.expectedOrderCount,
        plan.plannedOrderCount, pgTextArray(plan.orderNumbers), plan.firstStopDt, plan.firstStopAt,
        plan.firstStopName, routesJson, dispatchState, now,
      ],
    );
    return { version, isNew: true, latest: versionOf(rows[0]) };
  }

  /// The decision mark (§6.5). Idempotent: a version already marked keeps its
  /// first published_at, so a repeated internal call cannot move the time.
  async function markPublished(tx, { shiftRef, version, pushKind, now }) {
    const { rows } = await tx.query(
      `UPDATE plan_snapshots SET published_at = $3, push_kind = $4
        WHERE shift_ref = $1 AND version = $2 AND published_at IS NULL
        RETURNING version`,
      [shiftRef, version, now, pushKind],
    );
    return rows.length > 0;
  }

  /// The per-shift lock every writer of this table takes first (§4.7, §6.5).
  async function lockShift(tx, shiftRef) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`plan:${shiftRef}`]);
  }

  return { versionsForRef, stateForRef, latestForRef, versionWithRoutes, versionsForDate, upsert, markPublished, lockShift };
}

export default createSnapshotStore;
