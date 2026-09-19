// ---------------------------------------------------------------------------
// Vakt boot (spec §2.1, §3.2, §4.9 edit (5))
// ---------------------------------------------------------------------------
//
// index.js reaches this file through a dynamic import() inside the app.listen
// callback. Everything risky therefore happens AFTER the server is accepting
// connections, and nothing here may call process.exit on failure:
//   - a bad DATABASE_URL leaves /v2 answering 503 and /app/* untouched
//   - a malformed APNS_KEY_P8 is confined to getApns() (§7, critique O8)
//   - a throw anywhere in this module is caught in index.js, which then serves
//     /v2 from the 503 stub while the driver routes keep running

import net from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createDb, initPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { createV2Router } from "./routes/v2.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createApnsClient } from "./push/apns.js";
import { createSender } from "./push/sender.js";
import { createThrottle } from "./auth/throttle.js";
import { createAuthMiddleware, createSessionCache } from "./auth/middleware.js";
import { createIdentity } from "./auth/identity.js";
import { createAirtableClient } from "./airtable/client.js";
import { createRoster } from "./staff/roster.js";
import { createShiftsService } from "./staff/shifts.js";
import { createShiftDetail } from "./staff/shiftDetail.js";
import { createMailer } from "./mail/otpMail.js";
import { createDeclineMailer } from "./mail/declineMail.js";
import { createOptimoClient } from "./optimo/client.js";
import { createSnapshotStore } from "./plan/snapshots.js";
import { createPlanJob } from "./plan/planJob.js";
import { createCounterJob } from "./plan/counterJob.js";
import { createInternalRoutes } from "./routes/internal.js";
import { buildJobs, createWorker } from "./worker.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const DB_RETRY_MS = 30_000;
/// §4.9: wait for a running job, max 20 s.
const SHUTDOWN_JOB_WAIT_MS = 20_000;
/// db.end() and server.close() each wait on something that can simply never
/// finish: a Postgres socket on a private network that has already gone away, and
/// a keep-alive connection Railway's edge is still holding open (server.close()
/// fires its callback only once the LAST connection has gone). A few seconds
/// each, then the shutdown stops caring and moves on.
const SHUTDOWN_CLOSE_WAIT_MS = 2_500;
/// Hard ceiling on the whole handler, armed before the first await. Railway sends
/// SIGTERM and force-kills what is left; exiting ourselves at a known point beats
/// being killed at an unknown one, and it is the only bound that still holds if a
/// step hangs somewhere other than the two closes above.
// The watchdog must not fire before the steps it is guarding have had their
// own budgets, or the last step is cut off every time a shutdown is slow.
const SHUTDOWN_DEADLINE_MS = SHUTDOWN_JOB_WAIT_MS + SHUTDOWN_CLOSE_WAIT_MS * 2;

/// Lazy APNs client (§7). The key is parsed on first use, not at boot, and a
/// failure is confined to this one state object: /v2/health reports "invalid"
/// right after a deploy, every send becomes a `skipped` push_log row with reason
/// apns_not_configured, and nothing else in the process notices.
export function createApnsProbe(config, { log = console } = {}) {
  let state = { status: config.APNS_KEY_P8 ? "unloaded" : "missing", client: null };
  function getApns() {
    if (state.status === "unloaded") {
      try {
        state = {
          status: "configured",
          // Parses APNS_KEY_P8 (PEM, escaped PEM or base64) and throws on a bad
          // key. Opens no socket: HTTP/2 sessions are created at the first send.
          client: createApnsClient({
            keyP8: config.APNS_KEY_P8,
            keyId: config.APNS_KEY_ID,
            teamId: config.APNS_TEAM_ID,
            topic: config.APNS_TOPIC,
            log,
          }),
        };
      } catch (e) {
        // ERR_OSSL_UNSUPPORTED for a truncated or double-encoded key.
        state = { status: "invalid", client: null };
        log.error("[apns] key failed to load:", e.code || e.message);
      }
    }
    return state;
  }
  /// Reads the state WITHOUT loading the key, so shutdown does not parse a key
  /// nobody ever used — or log a scary "key failed to load" on the way out.
  getApns.peek = () => state;
  return getApns;
}

/// Evidence for Q1: Railway allows outbound SMTP only on Pro, and Gmail SMTP from
/// this service failed on 465 and 587 in May (§0.2). One cheap TCP connect, no
/// credentials, no mail — it just settles whether the egress is open at all (§4.6).
export function probeSmtpEgress({ host = "smtp.gmail.com", port = 587, timeoutMs = 5000, log = console } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (verdict) => {
      if (settled) return;
      settled = true;
      log.log(`[vakt] smtp egress ${port}: ${verdict}`);
      socket.destroy();
      resolve(verdict);
    };
    const socket = net.connect({ host, port });
    socket.unref();                                   // never holds the process open
    socket.setTimeout(timeoutMs, () => done("blocked"));
    socket.on("connect", () => done("reachable"));
    socket.on("error", () => done("blocked"));
  });
}

/// Brings the pool up and applies migrations, retrying forever every 30 s.
/// db.ready flips only after the last migration has committed, so /v2 never reads
/// a half-migrated schema.
export function startDbLoop(db, config, { log = console, retryMs = DB_RETRY_MS } = {}) {
  let timer = null;
  let stopped = false;

  const attempt = async () => {
    if (stopped) return;
    try {
      if (!db.pool) await initPool(db, config);
      await migrate(db.pool, MIGRATIONS_DIR);
      db.ready = true;
      db.lastError = null;
      log.log(`[vakt] db ready (${db.kind}, ${db.network})`);
    } catch (err) {
      db.ready = false;
      db.lastError = err?.code || err?.message || String(err);
      // Never the URL: it carries the password (§1.3).
      log.error(`[vakt] db init failed: ${db.lastError}`);
      // Drop a half-built pool so the next attempt starts clean.
      if (db.pool) await db.end().catch(() => {});
      timer = setTimeout(attempt, retryMs);
      timer.unref?.();
    }
  };

  attempt();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/// Settles when `work` settles or `ms` passes, whichever comes first, and leaves
/// no live timer behind either way. Rejections are swallowed: every caller below
/// is on the way out and has nothing left to do about a failure.
function withDeadline(work, ms, onTimeout, onError) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve();
    }, ms);
    timer.unref?.();
  });
  // A failing step must still be visible: the process is leaving, and a silent
  // "pool gone" is exactly what makes the next deploy's log unreadable.
  const attempt = Promise.resolve(work).catch((err) => { onError?.(err); });
  return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
}

/// Ordered shutdown so Railway's SIGTERM during a deploy does not cut a running
/// job or leave a Postgres connection dangling (§4.9).
///
/// Every step is bounded. An unbounded shutdown is worse than an abrupt one: the
/// instance sits there answering nothing until Railway force-kills it, which is
/// the same outcome minutes later and with a scarier deploy log.
///
/// `proc`, and the three timeouts, are injectable so test/shutdown.test.js can
/// drive this without installing real signal handlers or exiting the runner.
export function registerShutdown({
  server, db, dbLoop, worker, apns,
  log = console,
  proc = process,
  jobWaitMs = SHUTDOWN_JOB_WAIT_MS,
  closeWaitMs = SHUTDOWN_CLOSE_WAIT_MS,
  deadlineMs = SHUTDOWN_DEADLINE_MS,
} = {}) {
  let shuttingDown = false;
  let watchdog = null;

  const handler = async (signal) => {
    // Idempotent on purpose. Railway repeats SIGTERM when the first one does not
    // take, and an orchestrator or a person can send a second one at any moment;
    // a repeat must be a no-op, not a second pass that ends a pool twice.
    if (shuttingDown) {
      log.log(`[vakt] ${signal} ignored — shutdown already running`);
      return;
    }
    shuttingDown = true;
    log.log(`[vakt] ${signal} — shutting down`);

    // Armed before the first await, so nothing below it is load-bearing.
    watchdog = setTimeout(() => {
      watchdog = null;
      log.error(`[vakt] shutdown watchdog fired after ${deadlineMs}ms — exiting anyway`);
      proc.exit(0);
    }, deadlineMs);
    watchdog.unref?.();

    try {
      dbLoop?.stop();
      if (worker) {
        worker.stop();
        await withDeadline(worker.drain(), jobWaitMs,
          () => log.error(`[vakt] job drain gave up after ${jobWaitMs}ms`),
          (err) => log.error("[vakt] job drain failed:", err?.code || err?.message));
      }
      // Closes the HTTP/2 sessions to Apple, if any were ever opened.
      try { apns?.peek?.().client?.close(); } catch { /* shutting down anyway */ }
      await withDeadline(db.end(), closeWaitMs,
        () => log.error(`[vakt] db.end() gave up after ${closeWaitMs}ms`),
        (err) => log.error("[vakt] db.end() failed:", err?.code || err?.message));
      await withDeadline(
        new Promise((resolve) => (server ? server.close(resolve) : resolve())),
        closeWaitMs,
        () => log.error(`[vakt] server.close() gave up after ${closeWaitMs}ms`),
        (err) => log.error("[vakt] server.close() failed:", err?.code || err?.message),
      );
    } catch (err) {
      log.error("[vakt] shutdown error:", err?.code || err?.message);
    } finally {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
      proc.exit(0);
    }
  };

  // on(), not once(): with once() the listener is gone after the first signal, so
  // a second SIGTERM falls through to Node's default handler and kills the process
  // in the middle of the drain this function exists to protect.
  proc.on("SIGTERM", () => handler("SIGTERM"));
  proc.on("SIGINT", () => handler("SIGINT"));
  return handler;
}

/// Called from the app.listen callback in index.js; returns the /v2 handler.
/// It resolves as soon as the router exists — the database comes up behind it,
/// so a slow or dead Postgres delays nothing and breaks nothing outside /v2.
export async function startVakt({ app, server, env = process.env } = {}) {
  const config = loadConfig(env);
  const db = createDb(config);
  const getApns = createApnsProbe(config);

  const dbLoop = startDbLoop(db, config);

  const clock = () => new Date();
  const airtable = createAirtableClient({ token: config.AIRTABLE_TOKEN });
  const roster = createRoster({ airtable });
  // `roster` lets the sender drop recipients who went Inactive between the plan
  // decision and the send (§6.5).
  const sender = createSender({ db, config, apns: getApns, roster, clock });
  const hit = createThrottle(db, clock);

  // One cache shared by the middleware and the routes: logout and logout-all must
  // be able to delete the very entries requireStaff reads, or a signed-out device
  // keeps working for up to 60 s in this process (§4.3).
  const sessionCache = createSessionCache({ clock });
  // Both guards share one roster cache: requireOwnerOrInternal re-checks Office
  // on every internal call (S4).
  const { requireStaff, requireOwnerOrInternal } = createAuthMiddleware({ db, config, roster, sessionCache, clock });
  const identity = createIdentity({ db, config, roster, sessionCache, clock });
  const mailer = createMailer({ config });
  const declineMailer = createDeclineMailer({ config, mailer });
  const authRoutes = createAuthRoutes({ db, config, roster, identity, mailer, hit, sessionCache, requireStaff, clock });

  const shifts = createShiftsService({ airtable, config });
  // The plan job is the only writer of plan_snapshots; the detail reads them and
  // prefers a fresh OptimoRoute snapshot over Airtable's mirrored stops (§5.5).
  const snapshots = createSnapshotStore(db);
  const detail = createShiftDetail({ airtable, shifts, roster, config, snapshots });

  // READ ONLY: get_routes is the one OptimoRoute call this service knows (§6.2).
  const optimo = createOptimoClient({ apiKey: config.OPTIMOROUTE_API_KEY });
  const planJob = createPlanJob({ db, config, optimo, shifts, roster, snapshots, sender, airtable, clock });
  const counterJob = createCounterJob({ shifts, roster, sender, airtable, clock });

  // The scheduler ticks from now on but runs nothing until db.ready flips, so a
  // slow Postgres delays the first job and breaks nothing (§3.2, §6.4). Set
  // WORKER_ENABLED=0 locally and on any extra replica.
  const worker = config.workerEnabled
    ? createWorker({ db, jobs: buildJobs({ db, config, planJob, counterJob }), clock })
    : null;

  registerShutdown({ server, db, dbLoop, worker, apns: getApns });
  probeSmtpEgress().catch(() => {});
  worker?.start();

  const internalRoutes = createInternalRoutes({ db, config, shifts, roster, snapshots, sender, planJob, counterJob, clock });

  const router = createV2Router({
    db, config, apns: getApns, sender, requireStaff, requireOwnerOrInternal, identity, authRoutes, internalRoutes,
    shifts, detail, mailer, declineMailer, hit, clock,
  });
  console.log(`[vakt] /v2 ready (shell=${config.vaktShell}, auth=${config.authStatus}, internal=${config.internalStatus}, push=${config.pushMode}, worker=${config.workerEnabled ? "on" : "off"})`);
  return router;
}

export default startVakt;
