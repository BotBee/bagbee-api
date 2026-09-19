// ---------------------------------------------------------------------------
// Job scheduler (spec §6.4) — tick every 60 s, Iceland time = UTC
// ---------------------------------------------------------------------------
//
// Not a cron: a tick asks, for each job, "is the clock inside your window and is
// job_runs.last_started_at older than your interval?" and runs it if so. Both
// answers come from the database and the clock, never from process memory, so a
// redeploy in the middle of a window neither skips a run nor doubles one:
//
//   - two instances up at once (a Railway deploy overlap) both see the same
//     last_started_at; both may find the job due; only the one that wins
//     pg_try_advisory_lock runs it, the other records `skipped_locked`;
//   - a restart forgets nothing, because the last start is in job_runs.
//
// The lock is a SESSION lock on a dedicated client held for the whole run and
// released in `finally` — a job that throws must not leave the key taken until
// the pool recycles the connection.
//
// Iceland is UTC+0 all year, so every window below is a UTC wall-clock range.

import { runRetention } from "./db/retention.js";

const TICK_MS = 60_000;
const MIN = 60_000;

/// The §6.4 table. A job may have several windows with different intervals.
export const JOB_TABLE = {
  "plan-detect": {
    windows: [
      { open: "14:30", close: "21:50", intervalMs: 10 * MIN },
      /// Snapshot refresh only: the decisions inside are all `outside_window`
      /// or `not_announced` by construction, and no push window is open.
      { open: "05:00", close: "14:29", intervalMs: 30 * MIN },
    ],
  },
  "counter-tomorrow": {
    windows: [{ open: "20:00", close: "21:50", intervalMs: 10 * MIN }],
  },
  retention: {
    windows: [{ open: "03:30", close: "03:59", intervalMs: 24 * 60 * MIN }],
  },
};

const hhmmOf = (now) => new Date(now).toISOString().slice(11, 16);

/// The window `now` falls in, or null. Windows are inclusive at both ends and
/// never cross midnight, so a plain string compare is exact.
export function activeWindow(job, now, table = JOB_TABLE) {
  const hhmm = hhmmOf(now);
  return table[job]?.windows.find((w) => hhmm >= w.open && hhmm <= w.close) ?? null;
}

/// §6.4: due when inside a window AND the last start is older than that
/// window's interval (or there never was one).
export function isDue(job, now, lastStartedAt, table = JOB_TABLE) {
  const window = activeWindow(job, now, table);
  if (!window) return { due: false, window: null };
  if (!lastStartedAt) return { due: true, window };
  const age = new Date(now).getTime() - new Date(lastStartedAt).getTime();
  return { due: age >= window.intervalMs, window };
}

const CLAIM = `
  INSERT INTO job_runs (job, last_started_at, last_status)
  VALUES ($1, $2, 'running')
  ON CONFLICT (job) DO UPDATE SET last_started_at = EXCLUDED.last_started_at, last_status = 'running'`;

const FINISH = "UPDATE job_runs SET last_finished_at = $2, last_status = $3, last_detail = $4::jsonb WHERE job = $1";

// A locked-out instance writes NOTHING to job_runs. The row belongs to whoever
// holds the lock; stamping "skipped_locked" over a running job's status would
// make a healthy overlap during a deploy read as a failure on /v2/health.

/// `jobs` maps a job name to `async ({ now }) => report`. Only jobs present in
/// both `jobs` and `table` are scheduled, so a flag can leave one out entirely.
export function createWorker({ db, jobs, table = JOB_TABLE, clock = () => new Date(), log = console, tickMs = TICK_MS }) {
  let timer = null;
  let stopped = false;
  let running = null; // the promise of the tick in flight, for drain()
  const state = { lastTickAt: null, lastRun: null };

  /// The whole run for one job: lock → claim → run → finish → unlock.
  async function runJob(job, now) {
    const client = await db.pool.connect();
    let locked = false;
    try {
      const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [job]);
      locked = Boolean(rows[0]?.locked);
      if (!locked) {
        log.log?.(`[worker] ${job} skipped: another instance holds the lock`);
        return { job, status: "skipped_locked" };
      }

      // Re-check under the lock. The tick read last_started_at before locking,
      // and a second instance can have finished the same job in between; the
      // lock alone would let both run it back to back.
      const { rows: fresh } = await client.query("SELECT last_started_at FROM job_runs WHERE job = $1", [job]);
      if (!isDue(job, now, fresh[0]?.last_started_at ?? null, table).due) {
        log.log?.(`[worker] ${job} skipped: already run by another instance`);
        return { job, status: "skipped_recent" };
      }

      await db.query(CLAIM, [job, new Date(now)]);
      let status = "ok";
      let detail = null;
      try {
        detail = await jobs[job]({ now: new Date(now) });
      } catch (err) {
        status = "error";
        detail = { error: err?.code || err?.message || "error" };
        log.error?.(`[worker] ${job} failed: ${detail.error}`);
      }
      await db.query(FINISH, [job, clock(), status, JSON.stringify(detail ?? {})]);
      state.lastRun = { job, status, at: clock() };
      return { job, status, detail };
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [job]).catch(() => {});
      client.release();
    }
  }

  /// One pass over the table. Jobs run strictly one after another: OptimoRoute
  /// allows 5 concurrent calls per account and the Vercel crons share them.
  async function tick(now = clock()) {
    state.lastTickAt = now;
    if (stopped || !db.ready) return [];
    const ran = [];
    for (const job of Object.keys(table)) {
      if (stopped) break;
      if (typeof jobs[job] !== "function") continue;
      let lastStartedAt = null;
      try {
        const { rows } = await db.query("SELECT last_started_at FROM job_runs WHERE job = $1", [job]);
        lastStartedAt = rows[0]?.last_started_at ?? null;
      } catch (err) {
        // The pool dropped between the ready check and the read; next tick.
        log.error?.(`[worker] job_runs read failed: ${err?.code || err?.message}`);
        return ran;
      }
      const { due } = isDue(job, now, lastStartedAt, table);
      if (!due) continue;
      try {
        ran.push(await runJob(job, now));
      } catch (err) {
        log.error?.(`[worker] ${job} could not run: ${err?.code || err?.message}`);
      }
    }
    return ran;
  }

  /// A tick that is still running when the next one is due is left alone; a
  /// second concurrent pass would only queue behind the same advisory lock.
  function tickOnce() {
    if (running) return running;
    running = tick()
      .catch((err) => log.error?.(`[worker] tick failed: ${err?.code || err?.message}`))
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    start() {
      if (timer || stopped) return;
      timer = setInterval(tickOnce, tickMs);
      timer.unref?.();
      // The first pass at once: a deploy at 17:20 must not wait a minute to
      // notice that 17:05's plan is due.
      tickOnce();
    },
    /// §4.9: stop the tick, then drain() waits for a run in flight.
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    drain() {
      return running ?? Promise.resolve();
    },
    tick: tickOnce,
    runJob,
    state,
  };
}

/// The real job set for src/vakt.js. counter-tomorrow is left out entirely when
/// COUNTER_PUSH_ENABLED=0; the internal endpoint can still run it by hand.
export function buildJobs({ db, config, planJob, counterJob, log = console }) {
  const jobs = {
    "plan-detect": ({ now }) => planJob.runPlanDetect({ now, dryRun: false, triggeredBy: "job" }),
    retention: () => runRetention({ db, log }),
  };
  if (config.counterPushEnabled) {
    jobs["counter-tomorrow"] = ({ now }) => counterJob.runCounterTomorrow({ now, dryRun: false, triggeredBy: "job" });
  }
  return jobs;
}

export default createWorker;
