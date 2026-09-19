// ---------------------------------------------------------------------------
// Refresh tokens: rotation, the 60-minute grace, and reuse detection (spec §4.3)
// ---------------------------------------------------------------------------
//
// A refresh token is a bearer credential with a 180-day sliding life, so the only
// defence against a copied one is noticing that two parties are using the same
// session. Three hashes per session make that possible:
//
//   refresh_hash             the token that works now
//   prev_refresh_hash        the one before it — usable ONCE, within 60 minutes
//   superseded_refresh_hash  a current token that a grace-window refresh discarded;
//                            in the lost-response case nobody holds it, so if it is
//                            ever presented, a second party has a copy (§4.3 (b)/(c))
//
// The grace is 60 minutes and it is a CONSTANT, not a flag (C15): a van that loses
// signal mid-refresh often retries only when the app next comes to the foreground,
// and a false reuse signs a driver out until they can read a new email code.

import crypto from "node:crypto";

export const REFRESH_TTL_DAYS = 180;
export const REFRESH_PREFIX = "bbr_";
/// Long enough to reject junk early, loose enough that a future format still parses.
export const MAX_REFRESH_LENGTH = 200;

export const newRefreshToken = () => REFRESH_PREFIX + crypto.randomBytes(32).toString("base64url");
export const hashRefresh = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

export function isPlausibleRefreshToken(token) {
  return typeof token === "string" && token.startsWith(REFRESH_PREFIX) && token.length > REFRESH_PREFIX.length && token.length <= MAX_REFRESH_LENGTH;
}

// (a) the presented token is the current one — the ordinary case.
const ROTATE_CURRENT = `
  UPDATE sessions SET prev_refresh_hash = refresh_hash, refresh_hash = $2,
         last_refreshed_at = now(), expires_at = now() + interval '180 days'
   WHERE refresh_hash = $1 AND revoked_at IS NULL AND expires_at > now()
  RETURNING id, staff_id, device_id, expires_at`;

// (b) the previous token, inside the grace window: the client never received the
//     last rotation. prev_refresh_hash is cleared, so it cannot be replayed again.
const ROTATE_PREVIOUS = `
  UPDATE sessions SET superseded_refresh_hash = refresh_hash, refresh_hash = $2, prev_refresh_hash = NULL,
         last_refreshed_at = now(), expires_at = now() + interval '180 days'
   WHERE prev_refresh_hash = $1 AND revoked_at IS NULL AND expires_at > now()
     AND last_refreshed_at > now() - interval '60 minutes'
  RETURNING id, staff_id, device_id, expires_at`;

// (c) a previous token outside the grace window, or a superseded one.
const FIND_REUSED = `
  SELECT id, staff_id, device_id FROM sessions
   WHERE (prev_refresh_hash = $1 OR superseded_refresh_hash = $1) AND revoked_at IS NULL`;

/// Everything on the device goes, not just the one session: the party holding the
/// copy may already have refreshed a sibling session on the same installation.
const REVOKE_DEVICE_SESSIONS = `
  UPDATE sessions SET revoked_at = now(), revoked_reason = 'refresh_reuse'
   WHERE device_id = $1 AND revoked_at IS NULL
  RETURNING id`;

const REVOKE_SESSION = `
  UPDATE sessions SET revoked_at = now(), revoked_reason = $2
   WHERE id = $1 AND revoked_at IS NULL
  RETURNING id`;

const UNLINK_DEVICE = `
  UPDATE devices SET staff_id = NULL,
         invalidated_at = COALESCE(invalidated_at, now()),
         invalidated_reason = COALESCE(invalidated_reason, $2)
   WHERE id = $1`;

/// Creates the session row that verify-code hands back. The caller owns the
/// transaction so the device upsert and the session insert commit together.
export async function createSession(tx, { staffId, deviceId, refreshHash, ip = null, userAgent = null }) {
  const { rows } = await tx.query(
    `INSERT INTO sessions (staff_id, device_id, refresh_hash, expires_at, created_ip, user_agent)
     VALUES ($1, $2, $3, now() + interval '180 days', $4, $5)
     RETURNING id, created_at, expires_at`,
    [staffId, deviceId, refreshHash, ip, userAgent],
  );
  return rows[0];
}

/// One transaction, one verdict:
///   { outcome: "rotated", session }  → sign a new access token
///   { outcome: "reuse", revokedSessionIds, staffId }
///   { outcome: "unknown" }           → plain 401, nothing revoked
///
/// "unknown" covers a token older than the three we store. Its replay cannot be
/// distinguished from a random guess, so it revokes nothing (accepted, §4.3).
export async function rotateSession(db, presentedHash, newHash, { log = console } = {}) {
  return db.withTx(async (tx) => {
    const current = await tx.query(ROTATE_CURRENT, [presentedHash, newHash]);
    if (current.rows[0]) return { outcome: "rotated", session: current.rows[0], viaGrace: false };

    const previous = await tx.query(ROTATE_PREVIOUS, [presentedHash, newHash]);
    if (previous.rows[0]) return { outcome: "rotated", session: previous.rows[0], viaGrace: true };

    const { rows: reused } = await tx.query(FIND_REUSED, [presentedHash]);
    if (!reused.length) return { outcome: "unknown" };

    const revokedSessionIds = new Set();
    let staffId = null;
    for (const row of reused) {
      staffId = staffId ?? row.staff_id;
      if (row.device_id) {
        const { rows } = await tx.query(REVOKE_DEVICE_SESSIONS, [row.device_id]);
        for (const r of rows) revokedSessionIds.add(r.id);
        await tx.query(UNLINK_DEVICE, [row.device_id, "refresh_reuse"]);
      } else {
        const { rows } = await tx.query(REVOKE_SESSION, [row.id, "refresh_reuse"]);
        for (const r of rows) revokedSessionIds.add(r.id);
      }
      // No token, no email, no IP — the session id is enough to find the person.
      log.warn?.(`[auth] refresh reuse sid=${row.id}`);
    }
    return { outcome: "reuse", revokedSessionIds: [...revokedSessionIds], staffId };
  });
}

/// Sign-out of one device (§4.4 logout).
export async function revokeSession(db, sessionId, deviceId, reason = "logout") {
  const { rows } = await db.query(REVOKE_SESSION, [sessionId, reason]);
  if (deviceId) await db.query(UNLINK_DEVICE, [deviceId, reason]);
  return rows.length;
}

/// Sign-out everywhere: logout-all, and the staff_inactive path on refresh and
/// /v2/me. Returns the revoked session ids so the caller can drop its cache entries
/// — otherwise this instance keeps honouring access tokens for up to 60 s.
export async function revokeAllForStaff(db, staffId, reason) {
  return db.withTx(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
        WHERE staff_id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [staffId, reason],
    );
    await tx.query(
      `UPDATE devices SET staff_id = NULL,
              invalidated_at = COALESCE(invalidated_at, now()),
              invalidated_reason = COALESCE(invalidated_reason, $2)
        WHERE staff_id = $1`,
      [staffId, reason],
    );
    return rows.map((r) => r.id);
  });
}
