// ---------------------------------------------------------------------------
// Time helpers (spec §4.1)
// ---------------------------------------------------------------------------
//
// Iceland is UTC+0 all year with no DST, so "Iceland time" everywhere in slice 1
// is plain UTC. Server code must therefore use getUTC* only — a getHours() here
// would silently shift the Morning/Evening split on a laptop in another zone.

/// "YYYY-MM-DD" for the UTC day of `now`.
export function todayUTC(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

/// Adds whole days to a "YYYY-MM-DD" string (or a Date) and returns "YYYY-MM-DD".
export function addDays(date, days) {
  const base = typeof date === "string" ? new Date(`${date}T00:00:00Z`) : new Date(date);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/// "2026-09-17T04:20:00Z" — second precision, no milliseconds, because Swift's
/// .iso8601 decoder rejects fractional seconds (§4.2).
export function isoSec(value) {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 19)}Z`;
}

/// "HH:MM" of `now` in UTC — the Iceland wall clock every push window, deadline
/// and job schedule is written in (§6.3, §6.4).
export function hhmmUTC(now = new Date()) {
  return new Date(now).toISOString().slice(11, 16);
}

/// Epoch milliseconds for "YYYY-MM-DD" + "HH:MM" read as UTC.
export function hhmmToEpoch(date, hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
  return Date.parse(`${date}T${m[1]}:${m[2]}:00Z`);
}
