// ---------------------------------------------------------------------------
// POST /v2/auth/* (spec §4.4)
// ---------------------------------------------------------------------------
//
// The whole surface is unauthenticated except logout/logout-all, so two rules
// shape every handler here:
//
//  * Nothing may reveal whether an address belongs to staff (S2). request-code
//    answers 200 and sends the body BEFORE the Airtable lookup, so status, body and
//    timing are identical for a driver, a stranger and a typo. verify-code answers
//    one `401 invalid_code` for every email-dependent failure — wrong code, no live
//    code, expired code, exhausted bucket — and the app words the difference itself
//    from the clock (§8.4).
//  * Nothing sensitive reaches the log: no address, no code, no token. Log lines
//    carry logHash(OTP_HMAC_SECRET, email), which is useless without the secret (§1.3).

import express from "express";
import { noteRequestCode } from "../auth/lastRequest.js";
import { isoSec } from "../time.js";
import {
  CODE_TTL_SECONDS,
  RESEND_AFTER_SECONDS,
  generateLoginCode,
  hashCode,
  isPlausibleEmail,
  logHash,
  normalizeEmail,
  safeEqual,
  throttleSubject,
} from "../auth/otp.js";
import {
  hashRefresh,
  isPlausibleRefreshToken,
  newRefreshToken,
  createSession,
  revokeSession,
  revokeAllForStaff,
  rotateSession,
} from "../auth/refresh.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/// Anything else would make the inet column throw and turn a login into a 500.
const IP_LITERAL = /^[0-9a-fA-F.:]{3,45}$/;

const LIMITS = {
  otpReqIp: { bucket: "otp_req_ip", windowSec: 3600, limit: 20 },
  otpReqEmail: { bucket: "otp_req_email", windowSec: 3600, limit: 5 },
  otpReqEmailCooldown: { bucket: "otp_req_email_cooldown", windowSec: 30, limit: 1 },
  otpVerifyIp: { bucket: "otp_verify_ip", windowSec: 3600, limit: 30 },
  otpVerifyFailEmail: { bucket: "otp_verify_fail_email", windowSec: 3600, limit: 10 },
  otpVerifyFailEmailDay: { bucket: "otp_verify_fail_email_day", windowSec: 86400, limit: 20 },
  refreshIp: { bucket: "refresh_ip", windowSec: 3600, limit: 300 },
};

/// app.set("trust proxy", 1) makes req.ip the client address behind Railway's edge.
const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || "");
const inetOrNull = (ip) => (IP_LITERAL.test(ip) ? ip : null);

export function createAuthRoutes({
  db,
  config,
  roster,
  identity,
  mailer,
  hit,
  sessionCache,
  requireStaff,
  // No clock here on purpose: every time decision in these routes is made by
  // Postgres (`now()` for code expiry and session life) or by an injected
  // collaborator (`hit`'s windows, `identity.signAccessToken`'s iat/exp).
  log = console,
  maxPostResponseTasks = 4,
}) {
  const router = express.Router();
  const subjectOf = (value) => throttleSubject(config.OTP_HMAC_SECRET, value);
  const hashOf = (value) => logHash(config.OTP_HMAC_SECRET, value);

  /// Work that must not change the shape or the timing of the response (§4.4 step 3).
  /// The semaphore is the back-pressure: a flood of requests must not open an
  /// unbounded number of Airtable and Resend calls, and dropping the tail is
  /// better than queueing codes that arrive after they expire.
  const pending = new Set();
  function detach(label, fn) {
    if (pending.size >= maxPostResponseTasks) {
      log.warn?.(`[auth] ${label} dropped: ${pending.size} tasks already running`);
      return;
    }
    const task = Promise.resolve()
      .then(fn)
      .catch((err) => log.error?.(`[auth] ${label} failed:`, err?.code || err?.message))
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  /// Tests await this instead of sleeping; nothing in production calls it.
  router.whenIdle = async () => {
    while (pending.size) await Promise.all([...pending]);
  };

  async function limited(res, limit, subject) {
    const r = await hit(limit.bucket, subject, limit.windowSec, limit.limit);
    if (r.allowed) return false;
    res.set("Retry-After", String(r.retryAfterSeconds));
    res.status(429).json({ error: "rate_limited", retryAfterSeconds: r.retryAfterSeconds });
    return true;
  }

  // -------------------------------------------------------------------------
  // POST /v2/auth/request-code
  // -------------------------------------------------------------------------

  /// Everything email-dependent happens after the response: the Airtable lookup,
  /// the allowlist, the code row and the Resend call. A stranger's address and a
  /// driver's therefore cost the same three throttle writes and nothing else.
  async function issueCode({ email, ip, emailHash }) {
    let person;
    try {
      person = await roster.findActiveStaffByEmail(email);
    } catch (err) {
      noteRequestCode("failed", `roster lookup: ${err?.code || err?.message || "error"}`);
      throw err;
    }
    if (!person) {
      noteRequestCode("no-match");
      log.log(`[auth] request-code no-match h=${emailHash}`);
      return;
    }
    // Empty allowlist = all Active staff (§2.2). A non-pilot gets the same 200 and
    // no email, which is indistinguishable from an unknown address.
    if (config.staffLoginAllowlist.length && !config.staffLoginAllowlist.includes(person.airtableId)) {
      noteRequestCode("allowlist", "STAFF_LOGIN_ALLOWLIST is set and does not include this person");
      log.log(`[auth] request-code no-match h=${emailHash}`);
      return;
    }

    const staffRow = await identity.upsertStaffFromAirtable(person, email);
    const code = generateLoginCode();
    const codeHash = hashCode(config.OTP_HMAC_SECRET, email, code);

    const otpId = await db.withTx(async (tx) => {
      // One live code per email (the partial unique index enforces it); asking for
      // a second code kills the first, so a forwarded old email cannot be used.
      await tx.query(
        `UPDATE otp_codes SET invalidated_at = now(), invalidated_reason = 'superseded'
          WHERE email = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [email],
      );
      const { rows } = await tx.query(
        `INSERT INTO otp_codes (staff_id, email, code_hash, expires_at, request_ip)
         VALUES ($1, $2, $3, now() + interval '10 minutes', $4)
         RETURNING id`,
        [staffRow.id, email, codeHash, inetOrNull(ip)],
      );
      return rows[0].id;
    });

    try {
      const { status, providerId } = await mailer.sendOtpMail({ to: email, code, otpId, emailHash });
      await db.query("UPDATE otp_codes SET mail_status = $2, mail_provider_id = $3 WHERE id = $1", [otpId, status, providerId]);
      noteRequestCode(status === "sent" ? "sent" : status);
      log.log(`[auth] request-code sent h=${emailHash} status=${status}`);
    } catch (err) {
      await db.query("UPDATE otp_codes SET mail_status = 'failed' WHERE id = $1", [otpId]).catch(() => {});
      noteRequestCode("failed", `mail: ${err?.message || err?.code || "error"}`);
      log.error(`[auth] request-code mail failed h=${emailHash}:`, err?.code || err?.message);
    }
  }

  router.post("/request-code", async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      if (!isPlausibleEmail(email)) return res.status(400).json({ error: "invalid_email" });

      // Before the lookup, so the counters move identically for every address (§4.4).
      if (await limited(res, LIMITS.otpReqIp, subjectOf(clientIp(req)))) return;
      const emailSubject = subjectOf(email);
      if (await limited(res, LIMITS.otpReqEmail, emailSubject)) return;
      if (await limited(res, LIMITS.otpReqEmailCooldown, emailSubject)) return;

      res.json({ ok: true, expiresInSeconds: CODE_TTL_SECONDS, resendAfterSeconds: RESEND_AFTER_SECONDS });

      const emailHash = hashOf(email);
      const ip = clientIp(req);
      detach("request-code", () => issueCode({ email, ip, emailHash }));
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v2/auth/verify-code
  // -------------------------------------------------------------------------

  /// One transaction over the live code row. Returns a verdict; the caller turns
  /// every email-dependent verdict into the same 401 (§4.4).
  async function consumeCode({ email, code }) {
    return db.withTx(async (tx) => {
      const { rows } = await tx.query(
        // `expired` is decided by the database that wrote expires_at, not by this
        // process's clock: app and Postgres clocks can drift, and a skew of a few
        // minutes either way would silently shorten or extend every code's life.
        `SELECT c.id, c.staff_id, c.code_hash, c.attempts, c.max_attempts,
                (c.expires_at <= now()) AS expired,
                s.airtable_record_id, s.name
           FROM otp_codes c JOIN staff s ON s.id = c.staff_id
          WHERE c.email = $1 AND c.consumed_at IS NULL AND c.invalidated_at IS NULL
          ORDER BY c.created_at DESC
          LIMIT 1
          FOR UPDATE OF c`,
        [email],
      );
      const row = rows[0];
      // Step 1: no live code — an unknown address, a consumed code, a superseded
      // one. Nothing is counted, so guessing at random addresses cannot lock
      // anyone out (S11).
      if (!row) return { outcome: "no_code" };

      const subject = subjectOf(email);
      // Step 2: a bucket that is ALREADY full kills the live code rather than
      // letting the attacker keep guessing against it.
      const hour = await hit.peek(LIMITS.otpVerifyFailEmail.bucket, subject, LIMITS.otpVerifyFailEmail.windowSec, LIMITS.otpVerifyFailEmail.limit);
      const day = await hit.peek(LIMITS.otpVerifyFailEmailDay.bucket, subject, LIMITS.otpVerifyFailEmailDay.windowSec, LIMITS.otpVerifyFailEmailDay.limit);
      if (!hour.allowed || !day.allowed) {
        await tx.query(
          "UPDATE otp_codes SET invalidated_at = now(), invalidated_reason = 'email_throttled' WHERE id = $1",
          [row.id],
        );
        return { outcome: "throttled", staffName: row.name, dayExhausted: !day.allowed, dayHits: day.hits };
      }

      // Step 3: expired codes are not counted either — the code is dead anyway,
      // and the app already tells the person to ask for a new one.
      if (row.expired) return { outcome: "expired" };

      // Step 4: a real wrong guess against a live code. This is the only thing the
      // per-email buckets ever count.
      if (!safeEqual(hashCode(config.OTP_HMAC_SECRET, email, code), row.code_hash)) {
        const attempts = row.attempts + 1;
        await tx.query("UPDATE otp_codes SET attempts = $2 WHERE id = $1", [row.id, attempts]);
        if (attempts >= row.max_attempts) {
          await tx.query(
            "UPDATE otp_codes SET invalidated_at = now(), invalidated_reason = 'too_many_attempts' WHERE id = $1",
            [row.id],
          );
        }
        return { outcome: "wrong", staffName: row.name, attempts };
      }

      // Step 5.
      await tx.query("UPDATE otp_codes SET consumed_at = now() WHERE id = $1", [row.id]);
      return { outcome: "ok", staffId: row.staff_id, airtableId: row.airtable_record_id };
    });
  }

  /// Step 6: the code was right, so one live Airtable read decides whether this
  /// person may still sign in. On an Airtable failure we fall back to the roster
  /// cache (≤ 10 min, stale-serving up to 60 min) rather than burn a correct code
  /// on an outage; only when both are unavailable does the login fail.
  async function freshPerson(airtableId) {
    try {
      const person = await roster.getStaffById(airtableId);
      if (person) return { ok: true, person };
      // A deleted Starfsmenn row is an answer, not a failure.
      return { ok: true, person: null };
    } catch (err) {
      log.error("[auth] verify-code staff read failed:", err?.code || err?.message);
    }
    try {
      const { entry } = await roster.getRosterEntry(airtableId);
      return { ok: true, person: entry };
    } catch (err) {
      log.error("[auth] verify-code roster fallback failed:", err?.code || err?.message);
      return { ok: false, person: null };
    }
  }

  router.post("/verify-code", async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
      const device = req.body?.device ?? {};
      const installationId = typeof device.installationId === "string" ? device.installationId.trim() : "";
      if (!isPlausibleEmail(email) || !/^\d{6}$/.test(code) || !UUID.test(installationId)) {
        return res.status(400).json({ error: "invalid_request" });
      }

      // The only limit that can answer 429 here: it is keyed on the IP, so it
      // reveals nothing about the address (§4.4).
      if (await limited(res, LIMITS.otpVerifyIp, subjectOf(clientIp(req)))) return;

      const emailSubject = subjectOf(email);
      const verdict = await consumeCode({ email, code });

      // Only a real wrong guess against a live code moves the per-email counters.
      if (verdict.outcome === "wrong") {
        await hit(LIMITS.otpVerifyFailEmail.bucket, emailSubject, LIMITS.otpVerifyFailEmail.windowSec, LIMITS.otpVerifyFailEmail.limit);
        await hit(LIMITS.otpVerifyFailEmailDay.bucket, emailSubject, LIMITS.otpVerifyFailEmailDay.windowSec, LIMITS.otpVerifyFailEmailDay.limit);
      }

      /// "On the first trip per 24 h" (§4.4). The alert has its own 1-per-24 h
      /// bucket rather than a magic count: the counting buckets must stay a pure
      /// record of wrong guesses, and an office inbox must not get one mail per
      /// attempt once someone starts hammering an address.
      if (verdict.outcome === "throttled" && verdict.dayExhausted) {
        const first = await hit("otp_verify_alert_day", emailSubject, LIMITS.otpVerifyFailEmailDay.windowSec, 1);
        if (first.hits === 1) {
          const count = verdict.dayHits + 1;
          detach("otp-guess-alert", () => mailer.sendGuessAlert({ name: verdict.staffName, count }));
          log.warn(`[auth] verify-code guessing h=${hashOf(email)} count=${count}`);
        }
      }
      if (verdict.outcome !== "ok") return res.status(401).json({ error: "invalid_code" });

      const { ok, person } = await freshPerson(verdict.airtableId);
      if (!ok) return res.set("Retry-After", "30").status(503).json({ error: "airtable_unavailable" });
      if (!person || !person.active) return res.status(403).json({ error: "staff_inactive" });

      const staffRow = await identity.upsertStaffFromAirtable(person, email);
      const refreshToken = newRefreshToken();
      const ip = inetOrNull(clientIp(req));
      const userAgent = String(req.get("user-agent") || "").slice(0, 256) || null;

      const { deviceId, sessionId, expiresAt, revokedSessionIds } = await db.withTx(async (tx) => {
        // Keyed by installationId, which the app keeps in the Keychain as
        // ThisDeviceOnly: a restored backup gets a new id and a new row (S16).
        const { rows: deviceRows } = await tx.query(
          `INSERT INTO devices (installation_id, staff_id, model, os_version, app_version, app_build)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (installation_id) DO UPDATE SET
             staff_id = EXCLUDED.staff_id,
             model = COALESCE(EXCLUDED.model, devices.model),
             os_version = COALESCE(EXCLUDED.os_version, devices.os_version),
             app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
             app_build = COALESCE(EXCLUDED.app_build, devices.app_build),
             last_seen_at = now(),
             -- The phone changed hands. Its APNs token stops being sent to until
             -- the new person's app registers again (§4.4 step 7).
             invalidated_at = CASE
               WHEN devices.staff_id IS NOT NULL AND devices.staff_id <> EXCLUDED.staff_id THEN now()
               ELSE devices.invalidated_at END,
             invalidated_reason = CASE
               WHEN devices.staff_id IS NOT NULL AND devices.staff_id <> EXCLUDED.staff_id THEN 'reassigned'
               ELSE devices.invalidated_reason END
           RETURNING id`,
          [
            installationId,
            staffRow.id,
            typeof device.model === "string" ? device.model.slice(0, 64) : null,
            typeof device.osVersion === "string" ? device.osVersion.slice(0, 32) : null,
            typeof device.appVersion === "string" ? device.appVersion.slice(0, 32) : null,
            Number.isInteger(device.appBuild) ? device.appBuild : null,
          ],
        );
        const newDeviceId = deviceRows[0].id;

        // One live session per device: logging in again on the same phone replaces
        // the old session instead of leaving a second refresh token alive.
        const { rows: superseded } = await tx.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'superseded'
            WHERE device_id = $1 AND revoked_at IS NULL
           RETURNING id`,
          [newDeviceId],
        );

        const session = await createSession(tx, {
          staffId: staffRow.id,
          deviceId: newDeviceId,
          refreshHash: hashRefresh(refreshToken),
          ip,
          userAgent,
        });
        await tx.query("UPDATE staff SET last_login_at = now() WHERE id = $1", [staffRow.id]);
        return {
          deviceId: newDeviceId,
          sessionId: session.id,
          expiresAt: session.expires_at,
          revokedSessionIds: superseded.map((r) => r.id),
        };
      });
      sessionCache?.deleteMany?.(revokedSessionIds);

      const access = identity.signAccessToken({ staffRow, sessionId, deviceId });
      log.log(`[auth] sign-in h=${hashOf(email)} staff=${staffRow.id} device=${deviceId}`);
      res.json({
        accessToken: access.token,
        accessTokenExpiresAt: isoSec(access.expiresAt),
        refreshToken,
        refreshTokenExpiresAt: isoSec(expiresAt),
        staff: identity.staffProfile(staffRow),
        deviceId,
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v2/auth/refresh
  // -------------------------------------------------------------------------

  router.post("/refresh", async (req, res, next) => {
    try {
      const presented = req.body?.refreshToken;
      if (!isPlausibleRefreshToken(presented)) return res.status(400).json({ error: "invalid_request" });
      if (await limited(res, LIMITS.refreshIp, subjectOf(clientIp(req)))) return;

      const issued = newRefreshToken();
      const result = await rotateSession(db, hashRefresh(presented), hashRefresh(issued), { log });
      if (result.outcome === "reuse") {
        sessionCache?.deleteMany?.(result.revokedSessionIds);
        return res.status(401).json({ error: "invalid_refresh" });
      }
      if (result.outcome !== "rotated") return res.status(401).json({ error: "invalid_refresh" });

      const { session } = result;
      const staffRow = await identity.loadStaffRow(session.staff_id);
      // The session survived a staff row deletion: nothing left to sign.
      if (!staffRow) return res.status(401).json({ error: "invalid_refresh" });

      // Rights are recomputed here, not carried over from the old token (S4).
      const synced = await identity.syncWithRoster(staffRow);
      if (!synced.ok) return res.status(403).json({ error: "staff_inactive" });

      if (session.device_id) {
        await db.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [session.device_id]);
      }

      const access = identity.signAccessToken({
        staffRow: synced.row,
        sessionId: session.id,
        deviceId: session.device_id,
      });
      res.json({
        accessToken: access.token,
        accessTokenExpiresAt: isoSec(access.expiresAt),
        refreshToken: issued,
        refreshTokenExpiresAt: isoSec(session.expires_at),
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /v2/auth/logout and /logout-all
  // -------------------------------------------------------------------------

  if (requireStaff) {
    /// The app clears its local tokens whatever this answers, so the only job here
    /// is to make the server agree.
    router.post("/logout", requireStaff, async (req, res, next) => {
      try {
        await revokeSession(db, req.staff.sessionId, req.staff.deviceId, "logout");
        sessionCache?.delete?.(req.staff.sessionId);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    });

    /// "Skrá út alls staðar": a lost phone. Every session and every device token of
    /// this person dies, so no push can reach the lost device either (S6).
    router.post("/logout-all", requireStaff, async (req, res, next) => {
      try {
        const ids = await revokeAllForStaff(db, req.staff.id, "logout_all");
        sessionCache?.deleteMany?.(ids);
        log.log(`[auth] logout-all staff=${req.staff.id} sessions=${ids.length}`);
        res.json({ revokedSessions: ids.length });
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}

export default createAuthRoutes;
