// ---------------------------------------------------------------------------
// GET /v2/me/shifts · GET /v2/me/shifts/:ref · POST /v2/me/shifts/:ref/confirm
// (spec §4.5, §4.8)
// ---------------------------------------------------------------------------
//
// Mounted behind requireStaff, so this file never decides who you are. What it
// does decide is that you only ever see your own shifts: every route goes through
// shifts.getShiftForStaff / listShiftsForStaff, which resolve membership from the
// Airtable links, and a ref that is not yours is answered with the same 404 as a
// ref that does not exist. There is no path in here that takes a shift id and
// reads it without first proving the caller is on it.
//
// Postgres is read here and nowhere else in the shift path: the shifts and detail
// modules stay DB-free (B2) and are handed `plans` and `confirmations` as Maps.
// Airtable is READ ONLY — the confirm answer lives in Postgres, never in Airtable
// (Q7 defers the BSÍ Status write).

import express from "express";
import { limited } from "../auth/throttle.js";
import { createDeclineMailer, isNotifiableTransition } from "../mail/declineMail.js";
import { parseShiftRef, validateRange } from "../staff/shifts.js";
import { addDays, isoSec, todayUTC } from "../time.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANSWERS = ["yes", "no"];
const SOURCES = ["push_action", "app"];

const SHIFTS_LIMIT = { bucket: "shifts_staff", windowSec: 3600, limit: 300 };
const CONFIRM_LIMIT = { bucket: "confirm_staff", windowSec: 3600, limit: 120 };

/// A tap older than this is a phone whose clock is wrong or an outbox entry that
/// sat for a week; either way `received_at` is the more honest time (§4.5).
const ANSWERED_AT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/// How far ahead a shift may be confirmed. Beyond this the plan does not exist
/// yet, so a "yes" would be an answer to nothing.
const CONFIRMABLE_FORWARD_DAYS = 7;

// --- Postgres reads -------------------------------------------------------

const PLAN_COLUMNS = "shift_ref, version, stop_count, bag_count, first_stop_at, first_stop_name, published_at";

/// Two rows per shift are all §4.5 needs — the latest version (counts, first
/// stop) and the latest PUBLISHED one (the version people were actually told) —
/// but folding every version in JS is simpler than two window functions and the
/// table holds at most a handful of rows per shift.
export function foldPlanRows(rows) {
  const plans = new Map();
  for (const row of rows || []) {
    const entry = plans.get(row.shift_ref) || { published: null, latest: null };
    entry.latest = {
      version: row.version,
      stopCount: row.stop_count ?? 0,
      bagCount: row.bag_count ?? 0,
      firstStopAt: row.first_stop_at ?? null,
      firstStopName: row.first_stop_name ?? null,
    };
    if (row.published_at) entry.published = { version: row.version, publishedAt: row.published_at };
    plans.set(row.shift_ref, entry);
  }
  return plans;
}

export function foldConfirmationRows(rows) {
  const out = new Map();
  for (const row of rows || []) {
    out.set(row.shift_ref, {
      answer: row.answer,
      answeredAt: isoSec(row.answered_at),
      planVersion: row.plan_version ?? null,
      source: row.source,
    });
  }
  return out;
}

export function createShiftStateReader(db) {
  /// Refs are validated against /^(vakt|bsi)_rec[A-Za-z0-9]{14}$/ before they get
  /// here, so they can never contain the separator — string_to_array keeps this to
  /// one bound parameter instead of a generated IN list.
  const refList = (refs) => [...new Set(refs.filter(Boolean))].join(",");

  return {
    /// Ordered by version so the fold above sees the newest last.
    async plansForRange(from, to) {
      const { rows } = await db.query(
        `SELECT ${PLAN_COLUMNS} FROM plan_snapshots
          WHERE plan_date >= $1::date AND plan_date <= $2::date
          ORDER BY shift_ref, version`,
        [from, to],
      );
      return foldPlanRows(rows);
    },
    async plansForRefs(refs) {
      const list = refList(refs);
      if (!list) return new Map();
      const { rows } = await db.query(
        `SELECT ${PLAN_COLUMNS} FROM plan_snapshots
          WHERE shift_ref = ANY(string_to_array($1, ','))
          ORDER BY shift_ref, version`,
        [list],
      );
      return foldPlanRows(rows);
    },
    /// current_shift_confirmations is DISTINCT ON (shift_ref, staff_id): one row
    /// per shift, the latest answer, which is exactly what StaffShift carries.
    async confirmationsForRange(staffId, from, to) {
      const { rows } = await db.query(
        `SELECT shift_ref, answer, answered_at, plan_version, source
           FROM current_shift_confirmations
          WHERE staff_id = $1 AND shift_date >= $2::date AND shift_date <= $3::date`,
        [staffId, from, to],
      );
      return foldConfirmationRows(rows);
    },
    async confirmationsForRefs(staffId, refs) {
      const list = refList(refs);
      if (!list) return new Map();
      const { rows } = await db.query(
        `SELECT shift_ref, answer, answered_at, plan_version, source
           FROM current_shift_confirmations
          WHERE staff_id = $1 AND shift_ref = ANY(string_to_array($2, ','))`,
        [staffId, list],
      );
      return foldConfirmationRows(rows);
    },
  };
}

// --- request helpers ------------------------------------------------------

/// Airtable being down is a 503 with its own code, never a 500: the app has a
/// specific Icelandic string for it and retries, while a 500 would look like a
/// bug in the app (§4.5, §8.12).
function airtableDown(err, res) {
  if (typeof err?.code === "string" && err.code.startsWith("airtable_")) {
    res.status(503).json({ error: "airtable_unavailable" });
    return true;
  }
  return false;
}

/// §4.5: missing, in the future, or older than 7 days → received_at. A string we
/// cannot parse counts as missing; no answer is ever rejected over its timestamp.
export function clampAnsweredAt(value, receivedAt) {
  if (typeof value !== "string") return receivedAt;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return receivedAt;
  if (ms > receivedAt.getTime()) return receivedAt;
  if (ms < receivedAt.getTime() - ANSWERED_AT_MAX_AGE_MS) return receivedAt;
  return new Date(ms);
}

const confirmationBody = (row) => ({
  answer: row.answer,
  answeredAt: isoSec(row.answered_at),
  planVersion: row.plan_version ?? null,
  source: row.source,
});

// --- routes ---------------------------------------------------------------

export function createMeShiftRoutes({
  db,
  config,
  shifts,
  detail,
  identity,
  mailer,
  declineMailer,
  hit,
  clock = () => new Date(),
  log = console,
}) {
  const router = express.Router();
  const state = createShiftStateReader(db);
  const decline = declineMailer || createDeclineMailer({ config, mailer, log });

  /// GET /v2/me/shifts — the list behind "Vaktir" and the hero card on "Í dag".
  /// One ranged Airtable read serves every row's counts (§5.4), and the two
  /// Postgres reads run alongside it rather than after it.
  router.get("/", async (req, res, next) => {
    try {
      if (await limited(res, hit, SHIFTS_LIMIT, req.staff.id)) return;

      const nowDate = clock();
      const today = todayUTC(nowDate);
      /// Validated up front, not inside the service: the Postgres reads below are
      /// bounded by the same dates, so an unvalidated range must not reach them.
      const range = validateRange({ from: req.query.from, to: req.query.to, today });
      if (!range.ok) return res.status(400).json({ error: "invalid_range" });

      const [plans, confirmations] = await Promise.all([
        state.plansForRange(range.from, range.to),
        state.confirmationsForRange(req.staff.id, range.from, range.to),
      ]);

      const result = await shifts.listShiftsForStaff({
        staff: req.staff,
        from: range.from,
        to: range.to,
        plans,
        confirmations,
        nowDate,
      });
      if (!result.ok) return res.status(400).json({ error: result.error });

      const { ok, ...body } = result;
      res.json(body);
    } catch (err) {
      if (airtableDown(err, res)) return;
      next(err);
    }
  });

  /// GET /v2/me/shifts/:ref — the detail screen: routes, orders, crew.
  ///
  /// Wrong ref, someone else's shift and a shift older than today−7 all answer the
  /// same 404 with no detail, so the endpoint cannot be used to find out which
  /// refs exist or who works when (§4.5).
  router.get("/:ref", async (req, res, next) => {
    try {
      if (await limited(res, hit, SHIFTS_LIMIT, req.staff.id)) return;

      const ref = String(req.params.ref || "").trim();
      if (!parseShiftRef(ref)) return res.status(400).json({ error: "invalid_ref" });

      const nowDate = clock();
      const [plans, confirmations] = await Promise.all([
        state.plansForRefs([ref]),
        state.confirmationsForRefs(req.staff.id, [ref]),
      ]);

      const found = await shifts.getShiftForStaff({ staff: req.staff, ref, plans, confirmations, nowDate });
      if (!found.ok) return res.status(404).json({ error: "not_found" });

      res.json(await detail.buildShiftDetail({ staff: req.staff, found, nowDate }));
    } catch (err) {
      if (airtableDown(err, res)) return;
      next(err);
    }
  });

  /// POST /v2/me/shifts/:ref/confirm — "Já, ég mæti" / "Kemst ekki".
  ///
  /// The iOS side is an outbox: the same answer arrives again after a flaky
  /// network, from the lock screen and from the app. clientEventId is therefore
  /// the contract — one row per tap, whatever happens to the connection — and a
  /// replay must never send the office a second email.
  router.post("/:ref/confirm", async (req, res, next) => {
    try {
      if (await limited(res, hit, CONFIRM_LIMIT, req.staff.id)) return;

      const ref = String(req.params.ref || "").trim();
      const body = req.body ?? {};
      const answer = ANSWERS.includes(body.answer) ? body.answer : null;
      const clientEventId = typeof body.clientEventId === "string" && UUID.test(body.clientEventId.trim())
        ? body.clientEventId.trim().toLowerCase()
        : null;
      /// Absent means "app": an older build that never sent the field still
      /// records a usable answer. A value we do not know is refused, because it
      /// would end up in the office mail as the wrong sentence.
      const source = body.source === undefined || body.source === null
        ? "app"
        : SOURCES.includes(body.source) ? body.source : null;
      const planVersion = body.planVersion === undefined || body.planVersion === null
        ? null
        : Number.isInteger(body.planVersion) ? body.planVersion : undefined;

      if (!parseShiftRef(ref) || !answer || !clientEventId || !source || planVersion === undefined) {
        return res.status(400).json({ error: "invalid_request" });
      }

      const nowDate = clock();
      const today = todayUTC(nowDate);
      /// The same membership gate as the detail route, so "not your shift" and
      /// "no such shift" stay indistinguishable here too.
      const found = await shifts.getShiftForStaff({ staff: req.staff, ref, nowDate });
      if (!found.ok) return res.status(404).json({ error: "not_found" });

      const date = found.row.date;
      if (date < today || date > addDays(today, CONFIRMABLE_FORWARD_DAYS)) {
        return res.status(409).json({ error: "shift_not_confirmable" });
      }

      const receivedAt = nowDate;
      const answeredAt = clampAnsweredAt(body.answeredAt, receivedAt);

      const outcome = await db.withTx(async (tx) => {
        /// Two taps in the same second (phone plus watch, or a retry racing the
        /// first attempt) would otherwise both read "no previous answer" and both
        /// mail the office. Same lock pattern as the plan upsert in §4.7.
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`confirm:${ref}:${req.staff.id}`]);

        const { rows: prev } = await tx.query(
          "SELECT answer FROM current_shift_confirmations WHERE shift_ref = $1 AND staff_id = $2",
          [ref, req.staff.id],
        );
        const previousAnswer = prev[0]?.answer ?? null;

        const { rows: inserted } = await tx.query(
          `INSERT INTO shift_confirmations
             (shift_ref, shift_date, staff_id, answer, answered_at, received_at, source, plan_version, device_id, session_id, client_event_id)
           VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (client_event_id) DO NOTHING
           RETURNING answer, answered_at, plan_version, source`,
          [
            ref, date, req.staff.id, answer, answeredAt, receivedAt, source, planVersion,
            req.staff.deviceId, req.staff.sessionId, clientEventId,
          ],
        );
        if (inserted[0]) return { duplicate: false, row: inserted[0], previousAnswer };

        /// The replay path. Scoped to this person AND this shift: client_event_id
        /// is globally unique, and an id that belongs to another answer is a bad
        /// request, not somebody else's row to hand back.
        const { rows: existing } = await tx.query(
          `SELECT answer, answered_at, plan_version, source FROM shift_confirmations
            WHERE client_event_id = $1 AND staff_id = $2 AND shift_ref = $3`,
          [clientEventId, req.staff.id, ref],
        );
        return { duplicate: true, row: existing[0] || null, previousAnswer };
      });

      if (!outcome.row) return res.status(400).json({ error: "invalid_request" });

      let officeNotified = false;
      if (!outcome.duplicate && isNotifiableTransition(outcome.previousAnswer, answer)) {
        const staffRow = await identity.loadStaffRow(req.staff.id).catch(() => null);
        officeNotified = await decline.sendDeclineNotice({
          answer,
          name: staffRow?.name || "Starfsmaður",
          label: found.shift.label,
          date,
          answeredAt,
          source,
        });
      }

      log.log(
        `[confirm] ${ref} staff=${req.staff.id} answer=${answer} source=${source}` +
          ` duplicate=${outcome.duplicate} notified=${officeNotified}`,
      );
      res.json({ confirmation: confirmationBody(outcome.row), officeNotified, duplicate: outcome.duplicate });
    } catch (err) {
      if (airtableDown(err, res)) return;
      next(err);
    }
  });

  return router;
}

export default createMeShiftRoutes;
