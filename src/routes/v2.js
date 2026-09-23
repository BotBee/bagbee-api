// ---------------------------------------------------------------------------
// /v2 router (spec §4.2)
// ---------------------------------------------------------------------------
//
// Every dependency is injected so tests can pass fakes (§4.1). The router is
// mounted at /v2 by the stub in index.js, so paths here are relative: "/health"
// is served as GET /v2/health.

import express from "express";
import { lastRequestCode } from "../auth/lastRequest.js";
import { isoSec } from "../time.js";
import { createMeDeviceRoutes } from "./meDevices.js";
import { createMeShiftRoutes } from "./meShifts.js";
import { createMeRoutes } from "./me.js";

/// Routes that need Postgres answer 503 with Retry-After while the pool is down,
/// so the app can back off instead of showing a login failure (§4.2).
export function requireDb(db) {
  return (req, res, next) => {
    if (db.ready) return next();
    return res.set("Retry-After", "30").status(503).json({ error: "db_unavailable" });
  };
}

/// The secrets rule (§2.2): without a usable STAFF_JWT_SECRET *and* OTP_HMAC_SECRET
/// there is no safe way to sign or verify anything, so the whole auth surface is off.
export function requireAuthConfigured(config) {
  return (req, res, next) => {
    if (config.authConfigured) return next();
    return res.status(503).json({ error: "auth_not_configured" });
  };
}

export function createV2Router({
  db,
  config,
  apns,
  sender,
  requireStaff,
  requireOwnerOrInternal,
  identity,
  authRoutes,
  internalRoutes,
  shifts,
  detail,
  mailer,
  declineMailer,
  hit,
  clock = () => new Date(),
}) {
  const router = express.Router();

  /// GET /v2/health — names of what is configured, never values (§4.4).
  /// Always 200: "db":"unavailable" is an answer, not a failure of this endpoint.
  /// While src/vakt.js is still loading, or failed to, the index.js stub answers
  /// 503 {"starting"|"vakt_unavailable"} instead and this handler is never reached.
  router.get("/health", async (req, res) => {
    const worker = { enabled: config.workerEnabled, planDetect: null };
    if (db.ready) {
      try {
        const { rows } = await db.query(
          "SELECT last_finished_at, last_status FROM job_runs WHERE job = $1",
          ["plan-detect"],
        );
        worker.planDetect = {
          lastFinishedAt: rows[0] ? isoSec(rows[0].last_finished_at) : null,
          lastStatus: rows[0]?.last_status ?? null,
        };
      } catch (err) {
        // A readable health endpoint matters more than this one field.
        console.error("[v2] health job_runs read failed:", err?.code || err?.message);
      }
    }

    res.json({
      ok: true,
      db: db.status,
      dbNetwork: config.dbNetwork,
      worker,
      // Parses APNS_KEY_P8 only (no network), so a malformed key shows as
      // "invalid" right after deploy instead of at the first real send (§4.4, §7).
      apns: apns().status,
      mail: config.mailStatus,
      // Why the last code did or did not go out — no address, no code (§4.4).
      mailLast: lastRequestCode(),
      optimo: config.optimoStatus,
      auth: config.authStatus,
      internal: config.internalStatus,
      pushMode: config.pushMode,
    });
  });

  /// GET /v2/app-config — read at launch and at every safe point by the app (§2.3).
  /// Deliberately DB-free: a Postgres outage must not pin every device to the
  /// cached shell mode, and it must not break the kill switch.
  router.get("/app-config", (req, res) => {
    res.json({
      vaktShell: config.vaktShell,
      minAppBuild: config.minAppBuild,
      planSlotSplit: config.planSlotSplit,
    });
  });

  // The secrets-rule guard sits in front of the whole /auth prefix, so the auth
  // surface cannot come up unprotected even if a later route is mounted without it.
  router.use("/auth", requireAuthConfigured(config), requireDb(db));
  if (authRoutes) router.use("/auth", authRoutes);

  /// /internal/* answers 403 to anyone who is neither the internal secret nor a
  /// live owner (§4.3), BEFORE the database check: a stranger learns nothing about
  /// Postgres from these paths. Mounted only when both the guard and the routes
  /// are injected, so the paths are the JSON 404 until B6 is wired, never open.
  if (requireOwnerOrInternal && internalRoutes) {
    router.use("/internal", requireOwnerOrInternal, requireDb(db), internalRoutes);
  }

  /// Everything under /me is authenticated. Mounting these only when requireStaff
  /// is injected means no unauthenticated /v2/me can exist for even one deploy —
  /// until then the paths fall through to the 404 below.
  ///
  /// /me/devices is mounted FIRST so a device request is answered there and does
  /// not pay for a second session lookup on its way through the /me router.
  if (requireStaff && sender && hit) {
    router.use(
      "/me/devices",
      requireAuthConfigured(config),
      requireStaff,
      requireDb(db),
      createMeDeviceRoutes({ db, sender, hit }),
    );
  }
  /// /me/shifts before /me for the same reason: the list, the detail and the
  /// confirm answer are the busiest authenticated routes in the app, and they
  /// need no work from the /me router on the way past.
  if (requireStaff && identity && shifts && detail && hit) {
    router.use(
      "/me/shifts",
      requireAuthConfigured(config),
      requireStaff,
      requireDb(db),
      createMeShiftRoutes({ db, config, shifts, detail, identity, mailer, declineMailer, hit, clock }),
    );
  }
  if (requireStaff && identity) {
    router.use(
      "/me",
      requireAuthConfigured(config),
      requireStaff,
      requireDb(db),
      createMeRoutes({ db, config, identity }),
    );
  }

  /// JSON 404 in the /v2 error shape (§4.2), so the app never has to parse
  /// Express's default HTML page.
  router.use((req, res) => res.status(404).json({ error: "not_found" }));

  /// Last resort. Without this, a throw inside a /v2 handler returns Express's
  /// HTML stack-trace page, which the app cannot decode and which leaks file
  /// paths. The detail goes to the log, never to the device.
  // eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
  router.use((err, req, res, next) => {
    console.error("[v2] unhandled error:", err?.code || err?.message);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error" });
  });

  return router;
}

export default createV2Router;
