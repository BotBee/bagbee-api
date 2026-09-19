// ---------------------------------------------------------------------------
// counter-tomorrow job (spec §6.4, §6.6) — the 20:00 BSÍ push
// ---------------------------------------------------------------------------
//
// No plan, no versions: a counter shift is a person at a desk, so the only thing
// to announce is that the shift exists. One push per (row, person, device),
// dedupe key `counter:<ref>:v1:…` (§6.5), reconciled every run in the window so
// a phone that signs in at 21:00 still gets tomorrow's shift.
//
// Rows with Status Cancelled or Completed are skipped; a staffed `Open` row is
// pushed, because that is a shift somebody is expected to work (D13, Q7).
// READ ONLY towards Airtable: Q7 defers the Status=Confirmed write.

import { counterTimes } from "../staff/shifts.js";
import { collapseIdFor, counterPushPayload, expirationFor } from "../push/payloads.js";
import { createRunState } from "../push/sender.js";
import { addDays, isoSec, todayUTC } from "../time.js";

const SKIPPED_STATUSES = ["Cancelled", "Completed"];

export function createCounterJob({ shifts, roster = null, sender, airtable = null, clock = () => new Date(), log = console }) {
  async function rosterById() {
    if (!roster?.getRoster) return null;
    try {
      return (await roster.getRoster({ interactive: false })).byId;
    } catch (err) {
      log.error?.("[counter] roster read failed:", err?.code || err?.message);
      return null;
    }
  }

  /// runCounterTomorrow({ now, dryRun, triggeredBy }) → the job report.
  async function runCounterTomorrow({ now = clock(), dryRun = false, triggeredBy = "job" } = {}) {
    const startedAt = new Date(now);
    const today = todayUTC(startedAt);
    const tomorrow = addDays(today, 1);
    const before = airtable?.stats?.requests ?? 0;
    const report = { job: "counter-tomorrow", now: isoSec(startedAt), dryRun, date: tomorrow, airtableCalls: 0, shifts: [], errors: [] };
    const runState = createRunState();

    let rows;
    try {
      const bsi = await shifts.bsiWindow(today, { interactive: false });
      rows = bsi.rows.filter((row) => row.date === tomorrow && row.staffIds.length && !SKIPPED_STATUSES.includes(row.status));
    } catch (err) {
      const code = err?.code || err?.message || "error";
      log.error?.(`[counter] read failed: ${code}`);
      report.errors.push({ date: tomorrow, error: code });
      return report;
    }
    const names = await rosterById();

    for (const row of rows) {
      const entry = { ref: row.ref, date: row.date, slot: row.slot, status: row.status || null, sends: null };
      report.shifts.push(entry);
      const { startTime, endTime } = counterTimes(row);
      try {
        const res = await sender.sendShiftPush({
          shiftRef: row.ref,
          planVersion: 1,
          baseKind: "counter_tomorrow",
          buildPayload: ({ airtableStaffId }) =>
            counterPushPayload({ shiftRef: row.ref, date: row.date, slot: row.slot, startTime, endTime, recipient: airtableStaffId }),
          collapseId: collapseIdFor(row.ref),
          expiration: expirationFor({ shiftRef: row.ref, date: row.date, slot: row.slot, startTime }),
          recipients: row.staffIds.map((id) => ({ airtableStaffId: id, name: names?.get?.(id)?.displayName ?? null })),
          triggeredBy,
          dryRun,
          runState,
        });
        entry.sends = res.counts;
      } catch (err) {
        const code = err?.code || err?.message || "error";
        log.error?.(`[counter] ${row.ref} failed: ${code}`);
        report.errors.push({ ref: row.ref, error: code });
      }
    }

    report.airtableCalls = Math.max(0, (airtable?.stats?.requests ?? 0) - before);
    log.log?.(`[counter] run ${report.now} dryRun=${dryRun} date=${tomorrow} shifts=${report.shifts.length} errors=${report.errors.length}`);
    return report;
  }

  return { runCounterTomorrow };
}

export default createCounterJob;
