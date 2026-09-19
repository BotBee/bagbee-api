// ---------------------------------------------------------------------------
// Starfsmenn lookups (spec §5.3)
// ---------------------------------------------------------------------------
//
// Two very different reads live here:
//  - findActiveStaffByEmail is a live, uncached query on the login path. It must
//    never answer from a cache: a person turned Inactive five minutes ago must
//    not be able to log in.
//  - getRoster is the whole table, cached 10 min, used for crew names, the
//    Active re-check on every /v2/me and refresh, and the Office/owner check.

import { TABLES, STAFF, STAFF_LOOKUP_FIELDS, ROSTER_FIELDS, escapeFormulaValue } from "../airtable/fields.js";
import { createCache } from "../airtable/client.js";

const ROSTER_TTL_MS = 10 * 60 * 1000;
/// An Airtable outage must not sign everyone out of the app, so a roster older
/// than its TTL is still used for the Active re-check for up to an hour.
const ROSTER_STALE_MS = 60 * 60 * 1000;

const text = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/// One Starfsmenn row in the shape the rest of slice 1 uses. `email` is the main
/// address ("Email address" is set for 17/17 staff); the personal address is
/// kept because login accepts either (§5.3).
export function normalizeStaffRecord(record) {
  if (!record?.id) return null;
  const f = record.fields || {};
  const teams = list(f[STAFF.team]);
  const name = text(f[STAFF.name]); // 4 rows have surrounding spaces
  const first = text(f[STAFF.first]);
  return {
    airtableId: record.id,
    name,
    firstName: first || name,
    /// Crew lists and push bodies use the short name; the full name is the
    /// fallback because `First` is blank on some rows.
    displayName: first || name,
    email: text(f[STAFF.email]).toLowerCase(),
    personalEmail: text(f[STAFF.personalEmail]).toLowerCase(),
    teams,
    status: text(f[STAFF.status]),
    active: text(f[STAFF.status]) === "Active",
    /// Q10: owner = Team contains Office (Rúnar and Valgeir today).
    role: teams.includes("Office") ? "owner" : "staff",
  };
}

export function createRoster({ airtable, now = Date.now, logger = console, ttlMs = ROSTER_TTL_MS, staleMs = ROSTER_STALE_MS } = {}) {
  const cache = createCache({ now, logger, label: "roster" });

  /// Live query, no cache. Exactly one match is required: zero matches and an
  /// ambiguous match both answer "unknown", so a duplicated row can never let
  /// the wrong person receive a login code.
  async function findActiveStaffByEmail(email) {
    const e = escapeFormulaValue(String(email || "").trim().toLowerCase());
    if (!e) return null;
    const formula =
      `AND({${STAFF.status}}='Active', OR(LOWER(TRIM({${STAFF.personalEmail}}))='${e}', LOWER(TRIM({${STAFF.email}}))='${e}'))`;
    const { records } = await airtable.listAll(TABLES.staff, {
      filterByFormula: formula,
      fields: STAFF_LOOKUP_FIELDS,
      interactive: true,
    });
    if (records.length !== 1) {
      /// Count only — the address itself never reaches the log (§1.3).
      if (records.length > 1) logger.warn?.("[roster] ambiguous email match", records.length);
      return null;
    }
    return normalizeStaffRecord(records[0]);
  }

  /// Used at verify-code, where the record id is already known.
  async function getStaffById(recordId) {
    if (!/^rec[A-Za-z0-9]{14}$/.test(String(recordId || ""))) return null;
    const records = await airtable.getByIds(TABLES.staff, [recordId], STAFF_LOOKUP_FIELDS, { interactive: true });
    return records.length === 1 ? normalizeStaffRecord(records[0]) : null;
  }

  /// The whole table (17 rows, 1 page today). Cached 10 min, single-flight.
  async function getRoster({ interactive = true } = {}) {
    const { value, stale } = await cache.get("roster", {
      ttlMs,
      staleMs,
      load: async () => {
        const { records } = await airtable.listAll(TABLES.staff, { fields: ROSTER_FIELDS, interactive });
        const byId = new Map();
        for (const r of records) {
          const s = normalizeStaffRecord(r);
          if (s) byId.set(s.airtableId, s);
        }
        return byId;
      },
    });
    return { byId: value, stale };
  }

  /// Convenience for the Active re-check (§4.4, §4.5): unknown id → null.
  async function getRosterEntry(airtableId) {
    const { byId, stale } = await getRoster();
    return { entry: byId.get(airtableId) || null, stale };
  }

  return { findActiveStaffByEmail, getStaffById, getRoster, getRosterEntry };
}

export default createRoster;
