// ---------------------------------------------------------------------------
// POST /v2/me/devices and /v2/me/devices/test-push (spec §4.5)
// ---------------------------------------------------------------------------
//
// Both routes sit behind requireStaff, which the caller mounts: this file never
// decides who you are, only what happens to YOUR device row.
//
// The registration route is the one place an APNs token enters the system, so it
// is also the place that has to be forgiving. A value iOS 27 invents for
// `pushAuthorization` must never cost us the token — an unknown enum is stored as
// NULL, not rejected — while a malformed token IS rejected, because the CHECK
// constraint would otherwise turn it into a 500 at 17:05.

import express from "express";
import { limited } from "../auth/throttle.js";

const UUID =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
const ENVIRONMENTS = ["production", "sandbox"];
const PUSH_AUTHORIZATIONS = ["authorized", "denied", "provisional", "notDetermined", "ephemeral"];
const TIME_SENSITIVE = ["enabled", "disabled", "notSupported"];

const DEVICES_LIMIT = { bucket: "devices_staff", windowSec: 3600, limit: 60 };
const TEST_PUSH_LIMIT = { bucket: "test_push_staff", windowSec: 3600, limit: 5 };

/// Anything longer is a bug or an attack, not an OS version string.
const text = (v, max = 64) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const oneOf = (v, allowed) => (typeof v === "string" && allowed.includes(v) ? v : null);

export function createMeDeviceRoutes({ db, sender, hit, log = console }) {
  const router = express.Router();

  /// POST /v2/me/devices — the app calls this after every APNs registration and
  /// whenever notification settings change (§8.9). It is an update, never an
  /// insert: the device row was created at verify-code, keyed by installationId.
  router.post("/", async (req, res, next) => {
    try {
      if (await limited(res, hit, DEVICES_LIMIT, req.staff.id)) return;

      const body = req.body ?? {};
      const installationId = typeof body.installationId === "string" ? body.installationId.trim() : "";
      const apnsToken = body.apnsToken === null || body.apnsToken === undefined ? null : String(body.apnsToken);
      const apnsEnvironment = oneOf(body.apnsEnvironment, ENVIRONMENTS);

      const envGiven = body.apnsEnvironment !== undefined && body.apnsEnvironment !== null;
      if (!UUID.test(installationId)) return res.status(400).json({ error: "invalid_request" });
      if (apnsToken !== null && !APNS_TOKEN.test(apnsToken)) return res.status(400).json({ error: "invalid_request" });
      if (envGiven && !apnsEnvironment) return res.status(400).json({ error: "invalid_request" });
      // A token with no environment could never be sent to. No token and no
      // environment is fine: notification permission was denied on the phone.
      if (apnsToken !== null && !apnsEnvironment) return res.status(400).json({ error: "invalid_request" });

      const appBuild = Number.isInteger(body.appBuild) ? body.appBuild : null;

      const deviceId = await db.withTx(async (tx) => {
        const { rows } = await tx.query("SELECT id, installation_id FROM devices WHERE id = $1", [req.staff.deviceId]);
        const row = rows[0];
        // The session says one device, the app says another: a restored backup or
        // a copied Keychain. Refuse rather than move someone else's token.
        if (!row || String(row.installation_id).toLowerCase() !== installationId.toLowerCase()) return null;

        if (apnsToken) {
          // The same physical phone can be handed to another person: whoever
          // registers the token last owns it, and the old row stops being sent to.
          await tx.query(
            `UPDATE devices SET invalidated_at = now(), invalidated_reason = 'token_moved'
              WHERE apns_token = $1 AND id <> $2 AND invalidated_at IS NULL`,
            [apnsToken, row.id],
          );
        }

        await tx.query(
          `UPDATE devices SET
             apns_token = $2,
             apns_environment = COALESCE($3, apns_environment),
             push_authorization = $4,
             time_sensitive_setting = $5,
             app_version = COALESCE($6, app_version),
             app_build = COALESCE($7, app_build),
             os_version = COALESCE($8, os_version),
             model = COALESCE($9, model),
             last_seen_at = now(),
             -- Only a NEW token resets the clock the 410 rule compares against (§7).
             apns_token_updated_at = CASE
               WHEN $2 IS DISTINCT FROM apns_token OR invalidated_at IS NOT NULL THEN now()
               ELSE apns_token_updated_at END,
             invalidated_at = NULL,
             invalidated_reason = NULL
           WHERE id = $1`,
          [
            row.id, apnsToken, apnsEnvironment,
            oneOf(body.pushAuthorization, PUSH_AUTHORIZATIONS),
            oneOf(body.timeSensitiveSetting, TIME_SENSITIVE),
            text(body.appVersion, 32), appBuild, text(body.osVersion, 32), text(body.model, 64),
          ],
        );
        return row.id;
      });

      if (!deviceId) return res.status(409).json({ error: "device_mismatch" });
      res.json({ deviceId });
    } catch (err) {
      next(err);
    }
  });

  /// POST /v2/me/devices/test-push — "Senda prufutilkynningu" in Mitt.
  /// Deliberately ignores PUSH_MODE: it reaches only the caller's own signed-in
  /// devices, carries no shift or customer data, and is capped at 5/h, so it
  /// cannot buzz anyone else — and P3 has to prove APNs works while PUSH_MODE is
  /// still `off` (§4.5, critique C2).
  router.post("/test-push", async (req, res, next) => {
    try {
      if (await limited(res, hit, TEST_PUSH_LIMIT, req.staff.id)) return;
      const { results } = await sender.sendTestPush({
        staffId: req.staff.id,
        airtableStaffId: req.staff.airtableId ?? null,
      });
      log.log(`[push] test push staff=${req.staff.id} devices=${results.length}`);
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createMeDeviceRoutes;
