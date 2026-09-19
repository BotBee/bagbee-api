// ---------------------------------------------------------------------------
// /v2/internal/* — owner and script endpoints (spec §4.7)
// ---------------------------------------------------------------------------
//
// Mounted behind requireOwnerOrInternal (§4.3) and requireDb, so nothing here
// decides who is asking. What it does decide is that a manual action can never
// do more than the job would: the plan-published endpoint takes the same
// per-shift lock, writes the same snapshot, marks the same published_at and
// hands the same dedupe keys to the same sender. `force` is the one exception
// (a `manual:<uuid>` key), and PUSH_MODE=off still blocks it.
//
// `now` on the job endpoints is honoured only outside production (§2.2): a
// stray request must never move the clock on Railway.
//
// Airtable and OptimoRoute stay READ ONLY here too.

import express from "express";
import { PUSH_KINDS } from "../plan/planModel.js";
import { recipientsOf } from "../plan/planJob.js";
import { collapseIdFor, expirationFor, planPushPayload } from "../push/payloads.js";
import { counterLabel, driverRoleFor, drivingLabel, isRealDate, parseShiftRef, validateRange } from "../staff/shifts.js";
import { isoSec, todayUTC } from "../time.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// Who is signed in and on how many phones, per Airtable id (§4.7 plan-status).
/// DISTINCT on the device: a phone with two live sessions is still one phone.
const STAFF_PRESENCE = `
  SELECT st.airtable_record_id,
         EXISTS (SELECT 1 FROM sessions s
                  WHERE s.staff_id = st.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS signed_in,
         (SELECT count(DISTINCT d.id) FROM devices d
            JOIN sessions s ON s.device_id = d.id AND s.staff_id = d.staff_id
                           AND s.revoked_at IS NULL AND s.expires_at > now()
           WHERE d.staff_id = st.id AND d.invalidated_at IS NULL AND d.apns_token IS NOT NULL) AS devices
    FROM staff st
   WHERE st.airtable_record_id = ANY(string_to_array($1, ','))`;

const PUSHES_FOR_REFS = `
  SELECT shift_ref, kind, plan_version, airtable_staff_id, status, apns_reason, created_at
    FROM push_log
   WHERE shift_ref = ANY(string_to_array($1, ','))
   ORDER BY created_at, id`;

const CONFIRMATIONS_FOR_REFS = `
  SELECT c.shift_ref, c.shift_date, c.answer, c.answered_at, c.received_at, c.source, c.plan_version,
         st.name AS staff_name, st.airtable_record_id
    FROM current_shift_confirmations c
    JOIN staff st ON st.id = c.staff_id
   WHERE c.shift_ref = ANY(string_to_array($1, ','))
   ORDER BY c.shift_ref, c.answered_at`;

const CONFIRMATIONS_FOR_RANGE = `
  SELECT c.shift_ref, c.shift_date, c.answer, c.answered_at, c.received_at, c.source, c.plan_version,
         st.name AS staff_name, st.airtable_record_id
    FROM current_shift_confirmations c
    JOIN staff st ON st.id = c.staff_id
   WHERE c.shift_date >= $1::date AND c.shift_date <= $2::date
   ORDER BY c.shift_date, c.shift_ref, c.answered_at`;

const refList = (refs) => [...new Set(refs.filter(Boolean))].join(",");
const dateOf = (v) => (typeof v === "string" ? v.slice(0, 10) : isoSec(v)?.slice(0, 10) ?? null);

/// Membership right now, from the Airtable links (§4.7 "current membership"): a
/// transfer rewrites the links, so an earlier "yes" from the person who gave the
/// shift away is still in the view and must come back as stale.
export function isCurrentMember(row, airtableId) {
  if (!row) return false;
  if (row.kind === "counter") return row.staffIds.includes(airtableId);
  return driverRoleFor(row, airtableId) !== null;
}

export function createInternalRoutes({
  db,
  config,
  shifts,
  roster,
  snapshots,
  sender,
  planJob,
  counterJob,
  clock = () => new Date(),
  log = console,
}) {
  const router = express.Router();

  /// The clock a job endpoint runs at: the request's `now` outside production,
  /// the real one otherwise (§2.2, §4.7).
  function nowFor(body) {
    if (!config.allowNowOverride || typeof body?.now !== "string") return clock();
    const ms = Date.parse(body.now);
    return Number.isNaN(ms) ? clock() : new Date(ms);
  }

  const dryRunOf = (body) => (body?.dryRun === undefined ? true : Boolean(body.dryRun));

  function airtableDown(err, res) {
    if (typeof err?.code === "string" && err.code.startsWith("airtable_")) {
      res.status(503).json({ error: "airtable_unavailable" });
      return true;
    }
    return false;
  }

  async function names() {
    try {
      return (await roster.getRoster()).byId;
    } catch (err) {
      log.error?.("[internal] roster read failed:", err?.code || err?.message);
      return new Map();
    }
  }
  const nameOf = (byId, id) => byId.get(id)?.displayName || byId.get(id)?.name || null;

  /// POST /v2/internal/push/plan-published — announce one shift's plan by hand.
  router.post("/push/plan-published", async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const parsed = parseShiftRef(body.shiftRef);
      if (!parsed) return res.status(400).json({ error: "invalid_request" });
      if (parsed.kind !== "driving") return res.status(404).json({ error: "not_found" });
      const dryRun = dryRunOf(body);
      const force = body.force === true;
      const onlyStaffIds = Array.isArray(body.onlyStaffIds)
        ? body.onlyStaffIds.filter((v) => typeof v === "string" && UUID.test(v)).map((v) => v.toLowerCase())
        : null;

      const now = clock();
      const vakt = await shifts.vaktWindow(todayUTC(now));
      const row = vakt.byId.get(parsed.airtableId);
      if (!row || !row.slot) return res.status(404).json({ error: "not_found" });

      let planned;
      try {
        planned = await planJob.planForShift({ row, now, dryRun });
      } catch (err) {
        if (typeof err?.code === "string" && err.code.startsWith("optimo_")) {
          return res.status(503).json({ error: "optimo_unavailable" });
        }
        throw err;
      }
      if (!planned.ok) return res.status(409).json({ error: planned.error });

      const { target, kind, version } = planned;
      const baseKind = PUSH_KINDS[kind]?.baseKind ?? "plan_published";
      let recipients = recipientsOf(row, await names());
      if (onlyStaffIds) {
        const { rows } = await db.query(
          "SELECT airtable_record_id FROM staff WHERE id = ANY(string_to_array($1, ',')::uuid[])",
          [onlyStaffIds.join(",")],
        );
        const allowed = new Set(rows.map((r) => r.airtable_record_id));
        recipients = recipients.filter((r) => allowed.has(r.airtableStaffId));
      }

      const buildPayload = ({ airtableStaffId, kind: pushKind }) =>
        planPushPayload({
          kind: pushKind,
          shiftRef: row.ref,
          date: row.date,
          slot: row.slot,
          planVersion: version,
          recipient: airtableStaffId,
          stopCount: target.stopCount,
          bagCount: target.bagCount,
          firstStopAt: target.firstStopAt,
        });

      const sent = await sender.sendShiftPush({
        shiftRef: row.ref,
        planVersion: version,
        baseKind,
        buildPayload,
        collapseId: collapseIdFor(row.ref),
        expiration: expirationFor({ shiftRef: row.ref, date: row.date, slot: row.slot, firstStopDt: target.firstStopDt }),
        recipients,
        triggeredBy: "internal_api",
        force,
        dryRun,
      });

      log.log?.(`[internal] plan-published ${row.ref} v${version} dryRun=${dryRun} force=${force} sent=${sent.counts.sent} skipped=${sent.counts.skipped} failed=${sent.counts.failed}`);
      res.json({
        shiftRef: row.ref,
        planVersion: version,
        newVersion: planned.isNew,
        dryRun,
        /// The payload as the first recipient would see it; `recipient` differs
        /// per person and the sender builds each one itself.
        payload: buildPayload({ airtableStaffId: recipients[0]?.airtableStaffId ?? null, kind: baseKind }),
        recipients: sent.recipients.map((r) => ({
          airtableStaffId: r.airtableStaffId,
          staffId: r.staffId,
          name: r.name,
          kind: r.kind,
          devices: r.devices,
        })),
      });
    } catch (err) {
      if (airtableDown(err, res)) return;
      next(err);
    }
  });

  /// POST /v2/internal/jobs/plan-detect — the job, now, dryRun by default.
  router.post("/jobs/plan-detect", async (req, res, next) => {
    try {
      const body = req.body ?? {};
      res.json(await planJob.runPlanDetect({ now: nowFor(body), dryRun: dryRunOf(body), triggeredBy: "internal_api" }));
    } catch (err) {
      if (airtableDown(err, res)) return;
      next(err);
    }
  });

  /// POST /v2/internal/jobs/counter-tomorrow
  router.post("/jobs/counter-tomorrow", async (req, res, next) => {
    try {
      const body = req.body ?? {};
      res.json(await counterJob.runCounterTomorrow({ now: nowFor(body), dryRun: dryRunOf(body), triggeredBy: "internal_api" }));
    } catch (err) {
      if (airtableDown(err, res)) return;
      next(err);
    }
  });

  /// GET /v2/internal/plan-status?date=YYYY-MM-DD — P5's window into a shadow run.
  router.get("/plan-status", async (req, res, next) => {
    try {
      const date = String(req.query.date || "").trim();
      if (!isRealDate(date)) return res.status(400).json({ error: "invalid_request" });

      const today = todayUTC(clock());
      const [vakt, bsi, byId] = await Promise.all([shifts.vaktWindow(today), shifts.bsiWindow(today), names()]);
      const rows = [
        ...vakt.rows.filter((r) => r.date === date && r.slot),
        ...bsi.rows.filter((r) => r.date === date),
      ];
      const refs = rows.map((r) => r.ref);
      const people = [...new Set(rows.flatMap((r) => (r.kind === "counter" ? r.staffIds : [...r.driverIds, ...r.extraIds, ...r.otherIds])))];

      const [versions, pushes, confirmations, presence] = await Promise.all([
        snapshots.versionsForDate(date),
        refs.length ? db.query(PUSHES_FOR_REFS, [refList(refs)]).then((r) => r.rows) : [],
        refs.length ? db.query(CONFIRMATIONS_FOR_REFS, [refList(refs)]).then((r) => r.rows) : [],
        people.length ? db.query(STAFF_PRESENCE, [people.join(",")]).then((r) => r.rows) : [],
      ]);
      const presenceById = new Map(presence.map((p) => [p.airtable_record_id, p]));

      const out = rows.map((row) => {
        const staffIds = row.kind === "counter" ? row.staffIds : [...new Set([...row.driverIds, ...row.extraIds, ...row.otherIds])];
        return {
          ref: row.ref,
          kind: row.kind,
          date: row.date,
          slot: row.slot,
          label: row.kind === "counter" ? counterLabel(row.slot) : drivingLabel(row.slot),
          status: row.kind === "counter" ? row.status || null : null,
          staff: staffIds.map((id) => ({
            airtableStaffId: id,
            name: nameOf(byId, id),
            signedIn: Boolean(presenceById.get(id)?.signed_in),
            devices: Number(presenceById.get(id)?.devices ?? 0),
          })),
          versions: versions
            .filter((v) => v.shiftRef === row.ref)
            .map((v) => ({
              version: v.version,
              planHash: v.planHash,
              stopCount: v.stopCount,
              expected: v.expected,
              covered: v.covered,
              firstStopAt: v.firstStopAt,
              firstSeenAt: isoSec(v.firstSeenAt),
              lastSeenAt: isoSec(v.lastSeenAt),
              publishedAt: isoSec(v.publishedAt),
              pushKind: v.pushKind,
            })),
          pushes: pushes
            .filter((p) => p.shift_ref === row.ref)
            .map((p) => ({
              kind: p.kind,
              planVersion: p.plan_version,
              staffName: nameOf(byId, p.airtable_staff_id),
              status: p.status,
              apnsReason: p.apns_reason,
              createdAt: isoSec(p.created_at),
            })),
          confirmations: confirmations
            .filter((c) => c.shift_ref === row.ref)
            .map((c) => ({
              staffName: c.staff_name,
              answer: c.answer,
              answeredAt: isoSec(c.answered_at),
              source: c.source,
              planVersion: c.plan_version,
              stale: !isCurrentMember(row, c.airtable_record_id),
            })),
        };
      });

      res.json({ date, shifts: out });
    } catch (err) {
      if (airtableDown(err, res)) return;
      next(err);
    }
  });

  /// GET /v2/internal/confirmations?from&to — current answers, with the people
  /// who have since left a shift marked stale and never counted as confirmed.
  router.get("/confirmations", async (req, res, next) => {
    try {
      const today = todayUTC(clock());
      const range = validateRange({ from: req.query.from, to: req.query.to, today });
      if (!range.ok) return res.status(400).json({ error: "invalid_range" });

      const [vakt, bsi, { rows }] = await Promise.all([
        shifts.vaktWindow(today),
        shifts.bsiWindow(today),
        db.query(CONFIRMATIONS_FOR_RANGE, [range.from, range.to]),
      ]);
      const counterById = new Map(bsi.rows.map((r) => [r.id, r]));

      const out = rows.map((c) => {
        const parsed = parseShiftRef(c.shift_ref);
        const row = parsed ? (parsed.kind === "counter" ? counterById.get(parsed.airtableId) : vakt.byId.get(parsed.airtableId)) : null;
        return {
          shiftRef: c.shift_ref,
          shiftDate: dateOf(c.shift_date),
          label: row ? (row.kind === "counter" ? counterLabel(row.slot) : drivingLabel(row.slot)) : null,
          staffName: c.staff_name,
          answer: c.answer,
          answeredAt: isoSec(c.answered_at),
          receivedAt: isoSec(c.received_at),
          source: c.source,
          planVersion: c.plan_version,
          /// A row we cannot find any more (deleted, or outside the cached
          /// window) has no current membership, so its answers are stale too.
          stale: !isCurrentMember(row, c.airtable_record_id),
        };
      });

      res.json({ from: range.from, to: range.to, rows: out });
    } catch (err) {
      if (airtableDown(err, res)) return;
      next(err);
    }
  });

  return router;
}

export default createInternalRoutes;
