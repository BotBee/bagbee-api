// ---------------------------------------------------------------------------
// The ONLY module index.js imports statically (spec §4.1, §4.9 edit (1))
// ---------------------------------------------------------------------------
//
// Everything else in /v2 is reached through the dynamic import() after listen, so
// a broken Vakt module can never stop the driver routes from booting. Keep this
// file's dependencies at node:crypto + src/auth/jwt.js, and keep it from throwing
// at import: a missing or short STAFF_JWT_SECRET just makes staffFromJwt null.
//
// Slice 1, build step B8: requireAppToken in index.js (§4.9 edit (3)) calls
// staffFromJwt as its SECOND check, after the shared x-app-token and only when
// APP_ROUTES_ACCEPT_STAFF_JWT=1. With the flag off nothing here is consulted, so
// /app/* behaviour is byte-for-byte what it was before slice 1.

import { verifyJwt } from "./auth/jwt.js";

const SECRET_MIN_LENGTH = 32;

/// Same secrets rule as src/config.js (§2.2). Read here directly from the
/// environment rather than through config.js, so this file pulls in no /v2 code.
function configuredSecret(name) {
  const v = process.env[name];
  return typeof v === "string" && v.length >= SECRET_MIN_LENGTH ? v : null;
}

/// Read once at import, exactly as §4.9 writes it: Railway restarts the process on
/// an env change, so a live read would buy nothing and cost a getter on every call.
export const APP_ROUTES_ACCEPT_STAFF_JWT = process.env.APP_ROUTES_ACCEPT_STAFF_JWT === "1";

/// The identity a verified Authorization: Bearer token carries, in the shape
/// requireStaff puts on req.staff (§4.3), or null when there is no usable token.
///
/// Signature and expiry only — no database — so this path cannot fail on Postgres,
/// and a revoked session keeps working on /app/* for at most 15 min (accepted,
/// §4.9). `sub` and `sid` are required exactly as in requireStaff's authenticate:
/// a token that names nobody is not a staff token. Never throws.
export function staffFromJwt(req) {
  try {
    const current = configuredSecret("STAFF_JWT_SECRET");
    if (!current) return null;
    const secrets = [current, configuredSecret("STAFF_JWT_SECRET_PREVIOUS")].filter(Boolean);
    const header = typeof req?.get === "function" ? req.get("authorization") : req?.headers?.authorization;
    const m = /^Bearer\s+(\S+)$/i.exec(String(header || "").trim());
    if (!m) return null;
    const claims = verifyJwt(m[1], secrets, { nowSec: Math.floor(Date.now() / 1000) });
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    const sid = typeof claims.sid === "string" ? claims.sid : "";
    if (!sub || !sid) return null;
    return {
      id: sub,
      sessionId: sid,
      deviceId: typeof claims.did === "string" ? claims.did : null,
      airtableId: typeof claims.at === "string" ? claims.at : null,
      teams: Array.isArray(claims.team) ? claims.team : [],
      role: claims.role === "owner" ? "owner" : "staff",
    };
  } catch {
    return null;
  }
}

/// True iff Authorization: Bearer holds a JWT that verifies under §4.3.
export function acceptStaffJwt(req) {
  return staffFromJwt(req) !== null;
}
