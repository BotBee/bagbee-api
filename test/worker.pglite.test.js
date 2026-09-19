// Spec §6.4 — the job scheduler: windows in Iceland time (= UTC), the "older than
// its interval" rule across the day boundary, the advisory lock against an
// overlapping instance, and the job_runs bookkeeping /v2/health reads.
//
// The jobs themselves are fakes: this file is about WHEN they run, not what they
// do (test/planJob covers that). PGlite is the database; no network.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createDb, initPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { JOB_TABLE, activeWindow, buildJobs, createWorker, isDue } from "../src/worker.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const QUIET = { log() {}, error() {}, warn() {} };
const at = (iso) => new Date(iso);

async function freshDb() {
  const config = loadConfig({ DATABASE_URL: "pglite:memory" });
  const db = createDb(config);
  await initPool(db, config);
  await migrate(db.pool, MIGRATIONS_DIR);
  db.ready = true;
  return db;
}

const jobRow = async (db, job) => (await db.query("SELECT * FROM job_runs WHERE job = $1", [job])).rows[0] ?? null;

// --- the table --------------------------------------------------------------

test("the windows are the §6.4 table, inclusive at both ends", () => {
  const w = (job, hhmm) => activeWindow(job, at(`2026-09-16T${hhmm}:00Z`));

  assert.equal(w("plan-detect", "04:59"), null);
  assert.equal(w("plan-detect", "05:00").intervalMs, 30 * 60_000);
  assert.equal(w("plan-detect", "14:29").intervalMs, 30 * 60_000);
  assert.equal(w("plan-detect", "14:30").intervalMs, 10 * 60_000);
  assert.equal(w("plan-detect", "21:50").intervalMs, 10 * 60_000);
  assert.equal(w("plan-detect", "21:51"), null);
  assert.equal(w("plan-detect", "23:59"), null);
  assert.equal(w("plan-detect", "00:00"), null);

  assert.equal(w("counter-tomorrow", "19:59"), null);
  assert.equal(w("counter-tomorrow", "20:00").intervalMs, 10 * 60_000);
  assert.equal(w("counter-tomorrow", "21:50").intervalMs, 10 * 60_000);
  assert.equal(w("counter-tomorrow", "21:51"), null);

  assert.equal(w("retention", "03:29"), null);
  assert.equal(w("retention", "03:30").intervalMs, 24 * 60 * 60_000);
  assert.equal(w("retention", "03:59").intervalMs, 24 * 60 * 60_000);
  assert.equal(w("retention", "04:00"), null);
  assert.equal(activeWindow("no-such-job", at("2026-09-16T12:00:00Z")), null);
  assert.deepEqual(Object.keys(JOB_TABLE), ["plan-detect", "counter-tomorrow", "retention"]);
});

test("a job is due when inside a window and its last start is older than that window's interval", () => {
  const due = (job, now, last) => isDue(job, at(now), last ? at(last) : null).due;

  assert.equal(due("plan-detect", "2026-09-16T17:05:00Z", null), true, "never run");
  assert.equal(due("plan-detect", "2026-09-16T17:05:00Z", "2026-09-16T16:56:00Z"), false, "9 min ago");
  assert.equal(due("plan-detect", "2026-09-16T17:05:00Z", "2026-09-16T16:55:00Z"), true, "exactly 10 min ago");
  assert.equal(due("plan-detect", "2026-09-16T22:00:00Z", "2026-09-16T21:00:00Z"), false, "outside every window");

  // The morning window is a 30-min one: 14:25 → 14:29 is not due …
  assert.equal(due("plan-detect", "2026-09-16T14:29:00Z", "2026-09-16T14:00:00Z"), false);
  assert.equal(due("plan-detect", "2026-09-16T14:30:00Z", "2026-09-16T14:00:00Z"), true);
  // … and the switch to the 10-min window at 14:30 counts from the last start
  // whatever window that start was in.
  assert.equal(due("plan-detect", "2026-09-16T14:30:00Z", "2026-09-16T14:25:00Z"), false);
  assert.equal(due("plan-detect", "2026-09-16T14:35:00Z", "2026-09-16T14:25:00Z"), true);

  // Across the day boundary: the last run at 21:50 yesterday, and 05:00 today.
  assert.equal(due("plan-detect", "2026-09-17T05:00:00Z", "2026-09-16T21:50:00Z"), true);
  assert.equal(due("plan-detect", "2026-09-17T04:59:00Z", "2026-09-16T21:50:00Z"), false);
  // Retention ran at 03:30 yesterday → due at 03:30 today, not at 03:59 yesterday.
  assert.equal(due("retention", "2026-09-16T03:59:00Z", "2026-09-16T03:30:00Z"), false);
  assert.equal(due("retention", "2026-09-17T03:30:00Z", "2026-09-16T03:30:00Z"), true);
  assert.equal(due("retention", "2026-09-17T03:31:00Z", "2026-09-16T03:30:30Z"), true);
  // A start stored as a string (pg returns Date, but be safe) works too.
  assert.equal(isDue("counter-tomorrow", at("2026-09-16T20:00:00Z"), "2026-09-15T21:40:00Z").due, true);
});

// --- bookkeeping ------------------------------------------------------------

test("a due job is claimed, run, and finished in job_runs; the next tick is not due again", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const calls = [];
  let nowMs = Date.parse("2026-09-16T17:05:00Z");
  const clock = () => new Date(nowMs);
  const jobs = {
    "plan-detect": async ({ now }) => {
      calls.push(now.toISOString());
      return { job: "plan-detect", shifts: [{ ref: "vakt_recAbcdefghij1234" }] };
    },
  };
  const worker = createWorker({ db, jobs, clock, log: QUIET, tickMs: 60_000 });

  const ran = await worker.tick();
  assert.deepEqual(ran.map((r) => [r.job, r.status]), [["plan-detect", "ok"]]);
  assert.deepEqual(calls, ["2026-09-16T17:05:00.000Z"]);

  const row = await jobRow(db, "plan-detect");
  assert.equal(row.last_started_at.toISOString(), "2026-09-16T17:05:00.000Z");
  assert.equal(row.last_finished_at.toISOString(), "2026-09-16T17:05:00.000Z");
  assert.equal(row.last_status, "ok");
  assert.deepEqual(row.last_detail, { job: "plan-detect", shifts: [{ ref: "vakt_recAbcdefghij1234" }] });

  nowMs += 60_000;
  assert.deepEqual(await worker.tick(), [], "one minute later it is not due");
  assert.equal(calls.length, 1);

  nowMs += 9 * 60_000;
  await worker.tick();
  assert.equal(calls.length, 2, "ten minutes after the last start it runs again");
  assert.equal(worker.state.lastRun.job, "plan-detect");
});

test("a throwing job records error and its code, and never stops the next job", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const order = [];
  const clock = () => new Date("2026-09-16T20:05:00Z"); // plan-detect AND counter-tomorrow windows
  const jobs = {
    "plan-detect": async () => { order.push("plan"); throw Object.assign(new Error("boom"), { code: "optimo_unavailable" }); },
    "counter-tomorrow": async () => { order.push("counter"); return { job: "counter-tomorrow" }; },
  };
  const worker = createWorker({ db, jobs, clock, log: QUIET });

  const ran = await worker.tick();
  assert.deepEqual(order, ["plan", "counter"], "jobs run one after another in table order");
  assert.deepEqual(ran.map((r) => r.status), ["error", "ok"]);
  const row = await jobRow(db, "plan-detect");
  assert.equal(row.last_status, "error");
  assert.deepEqual(row.last_detail, { error: "optimo_unavailable" });
  assert.equal((await jobRow(db, "counter-tomorrow")).last_status, "ok");
});

test("nothing runs while the database is not ready, and nothing outside every window", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  let calls = 0;
  const jobs = { "plan-detect": async () => { calls += 1; return {}; } };

  db.ready = false;
  const worker = createWorker({ db, jobs, clock: () => new Date("2026-09-16T17:05:00Z"), log: QUIET });
  assert.deepEqual(await worker.tick(), []);
  assert.equal(calls, 0);
  assert.equal(await jobRow(db, "plan-detect"), null, "an unready DB is not written to");

  db.ready = true;
  const night = createWorker({ db, jobs, clock: () => new Date("2026-09-16T23:00:00Z"), log: QUIET });
  assert.deepEqual(await night.tick(), []);
  assert.equal(calls, 0);
});

test("a job that is not in the job set is left alone even inside its window", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  let counter = 0;
  const worker = createWorker({
    db,
    jobs: { "plan-detect": async () => ({}) },
    clock: () => new Date("2026-09-16T20:05:00Z"),
    log: QUIET,
  });
  await worker.tick();
  assert.equal(await jobRow(db, "counter-tomorrow"), null);
  assert.equal(counter, 0);
});

// --- the lock -----------------------------------------------------------------

test("when another instance holds the advisory lock the job is skipped_locked and not run", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  let calls = 0;
  const lockQueries = [];

  // PGlite is one session, so a second pg_try_advisory_lock on the same key would
  // succeed re-entrantly; the "other instance" is simulated on the dedicated client.
  const realConnect = db.pool.connect.bind(db.pool);
  db.pool.connect = async () => {
    const client = await realConnect();
    return {
      async query(text, params) {
        if (/pg_try_advisory_lock/.test(text)) {
          lockQueries.push(params[0]);
          return { rows: [{ locked: false }] };
        }
        return client.query(text, params);
      },
      release: () => client.release(),
    };
  };

  const worker = createWorker({
    db,
    jobs: { "plan-detect": async () => { calls += 1; return {}; } },
    clock: () => new Date("2026-09-16T17:05:00Z"),
    log: QUIET,
  });
  const ran = await worker.tick();

  assert.equal(calls, 0, "the job body must not run without the lock");
  assert.deepEqual(lockQueries, ["plan-detect"]);
  assert.deepEqual(ran, [{ job: "plan-detect", status: "skipped_locked" }]);
  const row = await jobRow(db, "plan-detect");
  assert.equal(row, null, "a locked-out instance writes nothing — the row belongs to the lock holder");
});

test("a job that another instance just ran is not run again under the lock", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  let calls = 0;
  // Between the tick's read (nothing yet) and taking the lock, "another
  // instance" finishes the job: the row now says it started one minute ago.
  const realConnect = db.pool.connect.bind(db.pool);
  db.pool.connect = async () => {
    const client = await realConnect();
    await db.query(
      "INSERT INTO job_runs (job, last_started_at, last_status) VALUES ($1, $2, 'ok') ON CONFLICT (job) DO UPDATE SET last_started_at = EXCLUDED.last_started_at",
      ["plan-detect", new Date("2026-09-16T17:04:00Z")],
    );
    return client;
  };
  const worker = createWorker({
    db,
    jobs: { "plan-detect": async () => { calls += 1; return {}; } },
    clock: () => new Date("2026-09-16T17:05:00Z"),
    log: QUIET,
  });
  const ran = await worker.tick();
  assert.equal(calls, 0, "the job body must not run twice inside one interval");
  assert.deepEqual(ran, [{ job: "plan-detect", status: "skipped_recent" }]);
});

test("the lock is taken on a dedicated client and released in finally, even when the job throws", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  const seen = [];
  const realConnect = db.pool.connect.bind(db.pool);
  db.pool.connect = async () => {
    const client = await realConnect();
    return {
      async query(text, params) {
        if (/pg_try_advisory_lock/.test(text)) seen.push("lock");
        if (/pg_advisory_unlock/.test(text)) seen.push("unlock");
        return client.query(text, params);
      },
      release: () => { seen.push("release"); client.release(); },
    };
  };
  const worker = createWorker({
    db,
    jobs: { "plan-detect": async () => { throw new Error("boom"); } },
    clock: () => new Date("2026-09-16T17:05:00Z"),
    log: QUIET,
  });
  await worker.tick();
  assert.deepEqual(seen, ["lock", "unlock", "release"]);
});

// --- ticking, stop and drain ---------------------------------------------------

test("a tick in flight is not doubled; stop() then drain() waits for the running job", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let finished = false;
  const worker = createWorker({
    db,
    jobs: { "plan-detect": async () => { await gate; finished = true; return {}; } },
    clock: () => new Date("2026-09-16T17:05:00Z"),
    log: QUIET,
    tickMs: 5,
  });

  worker.start();
  const first = worker.tick();
  assert.equal(worker.tick(), first, "a second tick while one is running is the same promise");
  worker.stop();
  const drained = worker.drain();
  assert.equal(finished, false);
  release();
  await drained;
  assert.equal(finished, true, "drain resolves only once the job in flight has finished");
  assert.equal((await jobRow(db, "plan-detect")).last_status, "ok");

  // Stopped: further ticks run nothing.
  assert.deepEqual(await worker.tick(), []);
  await worker.drain();
});

test("start() ticks at once so a deploy inside the window does not wait a minute", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  let calls = 0;
  const worker = createWorker({
    db,
    jobs: { "plan-detect": async () => { calls += 1; return {}; } },
    clock: () => new Date("2026-09-16T17:20:00Z"),
    log: QUIET,
    tickMs: 60_000,
  });
  worker.start();
  await worker.drain();
  worker.stop();
  assert.equal(calls, 1);
});

test("buildJobs leaves counter-tomorrow out when COUNTER_PUSH_ENABLED=0", () => {
  const planJob = { runPlanDetect: async () => ({}) };
  const counterJob = { runCounterTomorrow: async () => ({}) };
  const on = buildJobs({ db: {}, config: loadConfig({}), planJob, counterJob });
  assert.deepEqual(Object.keys(on).sort(), ["counter-tomorrow", "plan-detect", "retention"]);
  const off = buildJobs({ db: {}, config: loadConfig({ COUNTER_PUSH_ENABLED: "0" }), planJob, counterJob });
  assert.deepEqual(Object.keys(off).sort(), ["plan-detect", "retention"]);
});

test("the real job wrappers run the jobs with dryRun off and triggered by the job", async () => {
  const seen = [];
  const planJob = { runPlanDetect: async (args) => { seen.push(["plan", args]); return { job: "plan-detect" }; } };
  const counterJob = { runCounterTomorrow: async (args) => { seen.push(["counter", args]); return { job: "counter-tomorrow" }; } };
  const jobs = buildJobs({ db: {}, config: loadConfig({}), planJob, counterJob });
  const now = new Date("2026-09-16T17:05:00Z");
  await jobs["plan-detect"]({ now });
  await jobs["counter-tomorrow"]({ now });
  assert.deepEqual(seen, [
    ["plan", { now, dryRun: false, triggeredBy: "job" }],
    ["counter", { now, dryRun: false, triggeredBy: "job" }],
  ]);
});
