// ---------------------------------------------------------------------------
// requireStaff and requireOwnerOrInternal (spec §4.3)
// ---------------------------------------------------------------------------
//
// acceptStaffJwt deliberately does NOT live here: index.js imports it statically
// through src/appJwt.js, and pulling this file into that import would load the
// whole /v2 graph on every boot (C7, §4.1).
//
// Two properties this file exists to guarantee:
//  1. A revoked session stops working within 60 s on every instance — the JWT
//     claim is never the last word on whether you are still signed in.
//  2. An owner is an owner because the roster says so right now, not because a
//     token signed 14 minutes ago says so (S4).

import { verifyJwt } from "./jwt.js";
import { safeEqual } from "./otp.js";

const SESSION_CACHE_TTL_MS = 60_000;
/// 17 staff on a handful of devices; a cap this high can only be reached by an
/// attacker replaying signed tokens, and clearing is cheaper than growing forever.
const SESSION_CACHE_MAX = 5000;

/// Session state per `sid`, cached for 60 s so /v2/me and every shift read do not
/// each cost a round trip. Entries are deleted on logout/logout-all in this
/// process; other instances catch up when their entry expires (§4.3).
export function createSessionCache({ clock = () => new Date(), ttlMs = SESSION_CACHE_TTL_MS } = {}) {
  const entries = new Map();
  return {
    get(sid) {
      const e = entries.get(sid);
      if (!e) return null;
      if (e.cachedUntil <= clock().getTime()) {
        entries.delete(sid);
        return null;
      }
      return e.value;
    },
    set(sid, value) {
      if (entries.size >= SESSION_CACHE_MAX) entries.clear();
      entries.set(sid, { value, cachedUntil: clock().getTime() + ttlMs });
    },
    delete(sid) {
      entries.delete(sid);
    },
    deleteMany(ids) {
      for (const id of ids || []) entries.delete(id);
    },
    get size() {
      return entries.size;
    },
  };
}

const bearerOf = (req) => {
  const header = typeof req?.get === "function" ? req.get("authorization") : req?.headers?.authorization;
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || "").trim());
  return m ? m[1] : null;
};

export function createAuthMiddleware({ db, config, roster, sessionCache, clock = () => new Date(), log = console }) {
  const cache = sessionCache || createSessionCache({ clock });

  /// The shared core. Returns a verdict rather than a response, because
  /// requireStaff answers 401 and requireOwnerOrInternal answers 403 for the very
  /// same failure (§4.3) — the internal endpoints must not confirm to an
  /// unauthenticated caller that a token was merely expired.
  async function authenticate(req) {
    if (!config.authConfigured) return { ok: false, code: "auth_not_configured" };

    const token = bearerOf(req);
    if (!token) return { ok: false, code: "invalid_token" };

    let claims;
    try {
      claims = verifyJwt(token, config.jwtSecrets, { nowSec: Math.floor(clock().getTime() / 1000) });
    } catch (err) {
      return { ok: false, code: err?.code === "token_expired" ? "token_expired" : "invalid_token" };
    }

    const sid = typeof claims.sid === "string" ? claims.sid : "";
    const sub = typeof claims.sub === "string" ? claims.sub : "";
    if (!sid || !sub) return { ok: false, code: "invalid_token" };

    let session = cache.get(sid);
    if (!session) {
      if (!db.ready) return { ok: false, code: "db_unavailable" };
      try {
        const { rows } = await db.query(
          "SELECT revoked_at, expires_at FROM sessions WHERE id = $1 AND staff_id = $2",
          [sid, sub],
        );
        // An unknown sid is cached too: a replayed token from a deleted session
        // must not cost a query on every request.
        session = rows[0]
          ? { live: rows[0].revoked_at === null && new Date(rows[0].expires_at).getTime() > clock().getTime() }
          : { live: false };
        cache.set(sid, session);
      } catch (err) {
        // A uuid-shaped-but-invalid sid makes Postgres throw; so does a pool that
        // dropped between the ready check and the query.
        log.error?.("[auth] session lookup failed:", err?.code || err?.message);
        return { ok: false, code: err?.code === "db_unavailable" ? "db_unavailable" : "invalid_token" };
      }
    }
    if (!session.live) return { ok: false, code: "session_revoked" };

    return {
      ok: true,
      staff: {
        id: sub,
        sessionId: sid,
        deviceId: typeof claims.did === "string" ? claims.did : null,
        airtableId: typeof claims.at === "string" ? claims.at : null,
        teams: Array.isArray(claims.team) ? claims.team : [],
        role: claims.role === "owner" ? "owner" : "staff",
      },
    };
  }

  /// The app treats all three 401 codes the same way: refresh once, retry once (§4.3).
  ///
  /// .then(handler).catch(next), never .then(handler, next): the two-argument form
  /// hands a REJECTION of authenticate() to next() but leaves a throw inside the
  /// handler itself unhandled — no 500, no response at all, the client hanging
  /// until it times out, and an unhandled rejection in the Railway log.
  function requireStaff(req, res, next) {
    authenticate(req)
      .then((result) => {
        if (result.ok) {
          req.staff = result.staff;
          return next();
        }
        if (result.code === "auth_not_configured") return res.status(503).json({ error: "auth_not_configured" });
        if (result.code === "db_unavailable") {
          return res.set("Retry-After", "30").status(503).json({ error: "db_unavailable" });
        }
        return res.status(401).json({ error: result.code });
      })
      .catch(next);
  }

  /// Order matters (§4.3): the internal secret is checked first, and ONLY when it
  /// is configured (set and ≥ 32 chars). A missing or empty header is never
  /// compared — safeEqual("", "") used to return true, which opened every internal
  /// endpoint to anyone the moment the variable was forgotten (S1).
  function requireOwnerOrInternal(req, res, next) {
    if (config.internalConfigured) {
      const supplied = typeof req.get === "function" ? req.get("x-internal-secret") : req.headers?.["x-internal-secret"];
      if (typeof supplied === "string" && supplied.length > 0 && safeEqual(supplied, config.VAKT_INTERNAL_SECRET)) {
        req.internal = true;
        return next();
      }
      // A wrong header falls through to the owner path rather than answering: the
      // two credentials are independent, and an owner running a script with a stale
      // secret should still get in on their own session.
    }

    // .catch(next) for the same reason as requireStaff: this fulfilment handler is
    // itself async, so anything it throws — including from the res calls outside
    // the try below — rejects a promise nobody is listening to.
    authenticate(req)
      .then(async (result) => {
        // A transient Postgres failure is the one case worth distinguishing: it is
        // not a permission answer, and an owner tool should retry rather than
        // conclude it lost its rights.
        if (!result.ok && result.code === "db_unavailable") {
          return res.set("Retry-After", "30").status(503).json({ error: "db_unavailable" });
        }
        if (!result.ok) return res.status(403).json({ error: "forbidden" });

        try {
          const { entry } = await roster.getRosterEntry(result.staff.airtableId);
          if (!entry?.active || !entry.teams.includes("Office")) return res.status(403).json({ error: "forbidden" });
          req.staff = { ...result.staff, teams: entry.teams, role: entry.role };
          return next();
        } catch (err) {
          // Fail closed: without the roster there is no evidence anyone is an owner.
          log.error?.("[auth] owner check failed:", err?.code || err?.message);
          return res.status(403).json({ error: "forbidden" });
        }
      })
      .catch(next);
  }

  return { authenticate, requireStaff, requireOwnerOrInternal, sessionCache: cache };
}

export default createAuthMiddleware;
