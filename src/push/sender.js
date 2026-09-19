// ---------------------------------------------------------------------------
// Push sender — push_log idempotency and device invalidation (spec §6.5, §7)
// ---------------------------------------------------------------------------
//
// This module is the only place that writes push_log, and it is deliberately
// AT-MOST-ONCE: the dedupe key is claimed with INSERT … ON CONFLICT DO NOTHING
// BEFORE the send, so a crash between claim and send leaves a `pending` row that
// is never retried. A driver woken twice at 21:00 is worse than a driver who
// reads tomorrow's plan in the app, which is where the plan lives anyway.
//
// The other half of the design is that a skipped send NEVER burns the real key:
// skips are written as `<real key>:skip:<reason>`, so flipping PUSH_MODE from
// off to pilot inside the push window sends the same version at the next run
// without any manual cleanup (§6.5).

import crypto from "node:crypto";
import { testPushPayload } from "./payloads.js";

/// Devices that are signed in RIGHT NOW: a live, unrevoked, unexpired session on
/// the row (§6.5). DISTINCT ON (d.id) because a device with two live sessions
/// would otherwise be sent to twice — the second send would hit the unique
/// dedupe key and show up as a spurious skip.
const DEVICES_BY_AIRTABLE_ID = `
  SELECT DISTINCT ON (d.id) d.id, d.staff_id, d.apns_token, d.apns_environment, d.apns_token_updated_at
    FROM devices d
    JOIN staff st ON st.id = d.staff_id AND st.airtable_record_id = $1
    JOIN sessions s ON s.device_id = d.id AND s.staff_id = d.staff_id
                   AND s.revoked_at IS NULL AND s.expires_at > now()
   WHERE d.invalidated_at IS NULL AND d.apns_token IS NOT NULL
   ORDER BY d.id`;

const DEVICES_BY_STAFF_ID = `
  SELECT DISTINCT ON (d.id) d.id, d.staff_id, d.apns_token, d.apns_environment, d.apns_token_updated_at
    FROM devices d
    JOIN sessions s ON s.device_id = d.id AND s.staff_id = d.staff_id
                   AND s.revoked_at IS NULL AND s.expires_at > now()
   WHERE d.staff_id = $1 AND d.invalidated_at IS NULL AND d.apns_token IS NOT NULL
   ORDER BY d.id`;

/// Told apart so plan-status can show why someone got nothing: never logged in at
/// all, or logged in on a phone that has no usable APNs token (§6.5).
const STAFF_SIGNED_IN = `
  SELECT st.id AS staff_id,
         EXISTS (SELECT 1 FROM sessions s
                  WHERE s.staff_id = st.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS signed_in
    FROM staff st WHERE st.airtable_record_id = $1`;

const CLAIM = `
  INSERT INTO push_log (dedupe_key, kind, shift_ref, plan_version, staff_id, airtable_staff_id, device_id,
                        apns_environment, collapse_id, payload, status, apns_reason, triggered_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id`;

const FINISH = `
  UPDATE push_log
     SET status = $2, http_status = $3, apns_reason = $4, apns_id = $5::uuid,
         apns_environment = $6, attempts = $7, sent_at = $8
   WHERE id = $1`;

const otherEnv = (env) => (env === "sandbox" ? "production" : "sandbox");

/// Per job run, not per shift: one wrong APNs key must stop the sandbox sends for
/// the whole run, and must not stop the production ones (§7). B6 creates this
/// once per run and passes it to every sendShiftPush call.
export function createRunState() {
  return { blockedEnvironments: new Set() };
}

export function createSender({ db, config, apns, roster = null, clock = () => new Date(), log = console }) {
  /// PUSH_MODE=pilot uses the login allowlist; empty means "everyone", exactly as
  /// it does for logins (§2.2), so an empty variable never silently mutes a push.
  const inPilot = (airtableStaffId) =>
    config.staffLoginAllowlist.length === 0 || config.staffLoginAllowlist.includes(airtableStaffId);

  /// Reasons a send is skipped before it is attempted, in kill-switch order.
  function skipReasonFor({ kind, airtableStaffId }) {
    if (config.pushMode === "off") return "push_mode_off";
    if (kind === "plan_tonight" && !config.planPushTonight) return "tonight_off";
    if (config.pushMode === "pilot" && !inPilot(airtableStaffId)) return "not_in_pilot";
    if (apns().status !== "configured") return "apns_not_configured";
    return null;
  }

  /// The roster is the Airtable side of "is this person still staff" (§5.3). It
  /// returns { byId: Map<airtableId, entry> }; null here means no roster was
  /// injected and the caller has already filtered.
  async function activeAirtableIds() {
    if (!roster?.getRoster) return null;
    try {
      const { byId } = await roster.getRoster();
      return new Set([...byId.values()].filter((e) => e.active).map((e) => e.airtableId));
    } catch (err) {
      // A roster read failure must not cancel a plan push: Airtable being down at
      // 17:05 is exactly when the drivers still need tomorrow's plan.
      log.error("[push] roster read failed, sending to the given recipients:", err?.code || err?.message);
      return null;
    }
  }

  async function claim(row) {
    const { rows } = await db.query(CLAIM, [
      row.dedupeKey, row.kind, row.shiftRef ?? null, row.planVersion ?? null, row.staffId ?? null,
      row.airtableStaffId ?? null, row.deviceId ?? null, row.environment ?? null, row.collapseId ?? null,
      JSON.stringify(row.payload ?? {}), row.status, row.reason ?? null, row.triggeredBy,
    ]);
    return rows[0]?.id ?? null;
  }

  /// 410 Unregistered carries Apple's timestamp for when the token died. A token
  /// re-registered AFTER that timestamp is still good — invalidating it would sign
  /// the phone out of push until someone noticed (§7).
  async function invalidateOn410(device, timestampMs) {
    const { rowCount } = await db.query(
      `UPDATE devices SET invalidated_at = now(), invalidated_reason = 'apns_410'
        WHERE id = $1 AND invalidated_at IS NULL
          AND (apns_token_updated_at IS NULL OR apns_token_updated_at < to_timestamp($2::bigint / 1000.0))`,
      [device.id, Math.floor(Number(timestampMs) || 0)],
    );
    return rowCount > 0;
  }

  /// One device, one payload. Returns what goes into push_log.
  async function deliver({ client, device, payload, collapseId, expiration, runState }) {
    const environment = device.apns_environment || "production";
    const msg = { deviceToken: device.apns_token, environment, payload, collapseId, expiration };
    let attempts = 1;
    let res = await client.send(msg);

    if (res.status === 200) {
      return { status: "sent", httpStatus: 200, reason: null, apnsId: res.apnsId, environment, attempts };
    }

    if (res.status === 410 && (res.reason === "Unregistered" || res.reason === "ExpiredToken")) {
      const dropped = await invalidateOn410(device, res.timestamp);
      if (!dropped) log.log(`[push] 410 ignored, token re-registered after Apple's timestamp device=${device.id}`);
      return { status: "failed", httpStatus: 410, reason: res.reason, apnsId: res.apnsId, environment, attempts };
    }

    if (res.status === 400 && res.reason === "BadDeviceToken") {
      // Almost always a sandbox token on the production host (a device rebuilt in
      // Xcode). Try the other host before writing the token off.
      const alt = otherEnv(environment);
      attempts += 1;
      const retry = await client.send({ ...msg, environment: alt });
      if (retry.status === 200) {
        await db.query("UPDATE devices SET apns_environment = $2 WHERE id = $1", [device.id, alt]);
        return { status: "sent", httpStatus: 200, reason: null, apnsId: retry.apnsId, environment: alt, attempts };
      }
      await db.query(
        `UPDATE devices SET invalidated_at = now(), invalidated_reason = 'bad_device_token'
          WHERE id = $1 AND invalidated_at IS NULL`,
        [device.id],
      );
      return { status: "failed", httpStatus: retry.status || 400, reason: retry.reason || "BadDeviceToken", apnsId: retry.apnsId, environment: alt, attempts };
    }

    if (res.status === 400 && (res.reason === "DeviceTokenNotForTopic" || res.reason === "TopicDisallowed")) {
      // APNS_TOPIC or the key's app id is wrong. The token is fine; do not burn it.
      log.error(`[push] APNs config problem: ${res.reason} (topic=${config.APNS_TOPIC})`);
      return { status: "failed", httpStatus: 400, reason: res.reason, apnsId: res.apnsId, environment, attempts };
    }

    if (res.status === 403 && res.reason === "InvalidProviderToken") {
      // The key, the Key ID or the key's Sandbox/Production restriction is wrong.
      // Stop hammering THIS environment for the rest of the run; the other one
      // (the pilot's production devices) keeps going.
      log.error(`[push] InvalidProviderToken on ${environment} — skipping the rest of this run on that host`);
      runState.blockedEnvironments.add(environment);
      return { status: "failed", httpStatus: 403, reason: res.reason, apnsId: res.apnsId, environment, attempts };
    }

    return {
      status: "failed",
      httpStatus: res.status || null,
      reason: res.reason || "Unknown",
      apnsId: res.apnsId,
      environment,
      attempts,
    };
  }

  /// A plan or counter push for one shift.
  ///
  /// `recipients` are the people currently on the Airtable row. `buildPayload`
  /// gets the per-recipient kind, because a late joiner must see
  /// "Áætlun morgundagsins er komin" and not "BREYTT:" for a plan they never saw.
  async function sendShiftPush({
    shiftRef,
    planVersion,
    baseKind,                       // plan_published | plan_tonight | counter_tomorrow
    buildPayload,                   // ({ airtableStaffId, kind }) => payload
    collapseId,
    expiration = 0,
    recipients = [],
    triggeredBy = "job",
    force = false,
    dryRun = false,
    runState = createRunState(),
  }) {
    const prefix = String(shiftRef).startsWith("bsi_") ? "counter" : "plan";
    const active = await activeAirtableIds();
    const state = apns();
    const counts = { sent: 0, skipped: 0, failed: 0 };
    const out = [];

    for (const recipient of recipients) {
      const at = recipient.airtableStaffId;
      // Someone who left the company between the decision and this run gets nothing
      // and leaves no row: they are not a recipient any more (§6.5).
      if (active && !active.has(at)) continue;

      const { rows: staffRows } = await db.query(STAFF_SIGNED_IN, [at]);
      const staffId = staffRows[0]?.staff_id ?? null;
      const signedIn = Boolean(staffRows[0]?.signed_in);

      // "BREYTT:" only for someone who actually received an earlier version.
      let kind = baseKind;
      if (baseKind !== "counter_tomorrow" && planVersion) {
        const { rows } = await db.query(
          `SELECT 1 FROM push_log
            WHERE shift_ref = $1 AND airtable_staff_id = $2 AND status = 'sent'
              AND plan_version IS NOT NULL AND plan_version < $3 LIMIT 1`,
          [shiftRef, at, planVersion],
        );
        if (rows.length) kind = "plan_revised";
      }

      const payload = buildPayload({ airtableStaffId: at, kind });
      const entry = { airtableStaffId: at, staffId, name: recipient.name ?? null, kind, devices: [] };
      out.push(entry);

      const { rows: devices } = await db.query(DEVICES_BY_AIRTABLE_ID, [at]);
      const base = force ? null : `${prefix}:${shiftRef}:v${planVersion}:${at}`;

      if (!devices.length) {
        const reason = signedIn ? "no_device" : "not_signed_in";
        counts.skipped += 1;
        entry.devices.push({ deviceId: null, status: "skipped", reason });
        if (!dryRun) {
          await claim({
            dedupeKey: `${base ?? `manual:${crypto.randomUUID()}`}:nodevice:skip:${reason}`,
            kind, shiftRef, planVersion, staffId, airtableStaffId: at, collapseId,
            payload, status: "skipped", reason, triggeredBy,
          });
        }
        continue;
      }

      for (const device of devices) {
        const environment = device.apns_environment || "production";
        const reason = skipReasonFor({ kind, airtableStaffId: at })
          // A blocked host is a skip, not a failure: the key stays free so the run
          // after the key is fixed still delivers this version.
          ?? (runState.blockedEnvironments.has(environment) ? "invalid_provider_token" : null);
        const realKey = base ? `${base}:${device.id}` : `manual:${crypto.randomUUID()}`;

        if (dryRun) {
          counts.skipped += 1;
          entry.devices.push({ deviceId: device.id, status: "skipped", reason: reason ?? "dry_run" });
          continue;
        }

        if (reason) {
          counts.skipped += 1;
          entry.devices.push({ deviceId: device.id, status: "skipped", reason });
          await claim({
            dedupeKey: `${realKey}:skip:${reason}`,
            kind, shiftRef, planVersion, staffId, airtableStaffId: at, deviceId: device.id,
            environment, collapseId, payload, status: "skipped", reason, triggeredBy,
          });
          continue;
        }

        const logId = await claim({
          dedupeKey: realKey,
          kind, shiftRef, planVersion, staffId, airtableStaffId: at, deviceId: device.id,
          environment, collapseId, payload, status: "pending", triggeredBy,
        });
        if (!logId) {
          // Another instance, or an earlier run, already owns this key.
          counts.skipped += 1;
          entry.devices.push({ deviceId: device.id, status: "skipped", reason: "already_claimed" });
          continue;
        }

        const res = await deliver({ client: state.client, device, payload, collapseId, expiration, runState });
        await db.query(FINISH, [
          logId, res.status, res.httpStatus, res.reason, res.apnsId ?? null,
          res.environment, res.attempts, res.status === "sent" ? clock() : null,
        ]);
        counts[res.status] += 1;
        entry.devices.push({ deviceId: device.id, status: res.status, reason: res.reason });
      }
    }

    return { shiftRef, planVersion, counts, recipients: out };
  }

  /// Mitt › "Senda prufutilkynningu" (§4.5). Ignores PUSH_MODE and
  /// PLAN_PUSH_TONIGHT on purpose: it reaches only the caller's own signed-in
  /// devices and carries no shift data, and P3 has to prove push works while
  /// PUSH_MODE is still `off`.
  async function sendTestPush({ staffId, airtableStaffId = null }) {
    const state = apns();
    const payload = testPushPayload();
    const { rows: devices } = await db.query(DEVICES_BY_STAFF_ID, [staffId]);
    const runState = createRunState();
    const results = [];

    for (const device of devices) {
      const environment = device.apns_environment || "production";
      const dedupeKey = `test:${crypto.randomUUID()}`;
      const reason = state.status === "configured" ? null : "apns_not_configured";

      const logId = await claim({
        dedupeKey: reason ? `${dedupeKey}:skip:${reason}` : dedupeKey,
        kind: "test", staffId, airtableStaffId, deviceId: device.id, environment,
        payload, status: reason ? "skipped" : "pending", reason, triggeredBy: "self_test",
      });

      if (reason) {
        results.push({ deviceId: device.id, status: "skipped", apnsReason: reason });
        continue;
      }

      // No collapse id: two test pushes must both arrive, or the button looks broken.
      const res = await deliver({ client: state.client, device, payload, collapseId: null, expiration: 0, runState });
      await db.query(FINISH, [
        logId, res.status, res.httpStatus, res.reason, res.apnsId ?? null,
        res.environment, res.attempts, res.status === "sent" ? clock() : null,
      ]);
      results.push({ deviceId: device.id, status: res.status, apnsReason: res.reason });
    }

    return { results };
  }

  return { sendShiftPush, sendTestPush, skipReasonFor };
}

export default createSender;
