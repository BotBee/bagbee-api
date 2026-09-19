// Spec §4.4 / §10.1 — the rate limits, at both levels: the fixed-window counter
// itself, and the three request-code buckets as the route applies them.
//
// The clock is injected, so "an hour later" costs no wall time; the DATABASE is
// real, because the whole reason these counters live in Postgres is that Railway
// can run two instances and a per-process limiter would double every limit.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig } from "../src/config.js";
import { createDb, initPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createThrottle } from "../src/auth/throttle.js";
import { createAuthMiddleware, createSessionCache } from "../src/auth/middleware.js";
import { createIdentity } from "../src/auth/identity.js";
import { createAuthRoutes } from "../src/routes/auth.js";
import { createV2Router } from "../src/routes/v2.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const LONG = "x".repeat(40);
const QUIET = { log() {}, warn() {}, error() {} };

const PERSON = {
  airtableId: "recLCxvPg6oAKUfDp",
  name: "Rúnar",
  firstName: "Rúnar",
  displayName: "Rúnar",
  email: "runa@example.is",
  personalEmail: "",
  teams: ["Office"],
  status: "Active",
  active: true,
  role: "owner",
};

async function openDb(envOver = {}) {
  const config = loadConfig({ DATABASE_URL: "pglite:memory", STAFF_JWT_SECRET: LONG, OTP_HMAC_SECRET: LONG, ...envOver });
  const db = createDb(config);
  await initPool(db, config);
  await migrate(db.pool, MIGRATIONS_DIR);
  db.ready = true;
  return { db, config };
}

/// The request-code path with a fake roster and a fake mailer; only the throttles
/// and the routes are real.
async function serve({ people = [PERSON], startMs = Date.UTC(2026, 8, 16, 10, 0, 0) } = {}) {
  const { db, config } = await openDb();
  let nowMs = startMs;
  const clock = () => new Date(nowMs);

  const roster = {
    async findActiveStaffByEmail(email) {
      return people.find((p) => p.active && (p.email === email || p.personalEmail === email)) ?? null;
    },
    async getStaffById(id) {
      return people.find((p) => p.airtableId === id) ?? null;
    },
    async getRosterEntry(id) {
      return { entry: people.find((p) => p.airtableId === id) ?? null, stale: false };
    },
  };
  const mails = [];
  const mailer = {
    async sendOtpMail(args) {
      mails.push(args);
      return { status: "sent", providerId: "re_test" };
    },
    async sendGuessAlert() {
      return { status: "skipped" };
    },
  };

  const hit = createThrottle(db, clock);
  const sessionCache = createSessionCache({ clock });
  const { requireStaff } = createAuthMiddleware({ db, config, roster, sessionCache, clock, log: QUIET });
  const identity = createIdentity({ db, config, roster, sessionCache, clock, log: QUIET });
  const authRoutes = createAuthRoutes({ db, config, roster, identity, mailer, hit, sessionCache, requireStaff, clock, log: QUIET });

  const app = express();
  app.set("trust proxy", 1);
  app.use("/v2", express.json({ limit: "32kb" }));
  app.use("/v2", createV2Router({ db, config, apns: () => ({ status: "missing" }), requireStaff, identity, authRoutes, hit, clock }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();

  const post = async (path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };

  return {
    db, config, hit, mails, post,
    advance: (seconds) => { nowMs += seconds * 1000; },
    idle: () => authRoutes.whenIdle(),
    async close() {
      // fetch() keeps its sockets alive, and server.close() waits for them; without
      // this every test would pay the 5 s keepAliveTimeout before finishing.
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await db.end();
    },
  };
}

test("hit counts, allows up to the limit, then reports a retry delay", async (ctx) => {
  const { db } = await openDb();
  ctx.after(() => db.end());
  let nowMs = Date.UTC(2026, 8, 16, 10, 0, 0);
  const hit = createThrottle(db, () => new Date(nowMs));

  for (let i = 1; i <= 3; i += 1) {
    const r = await hit("b", "subject-a", 60, 3);
    assert.equal(r.hits, i);
    assert.equal(r.allowed, true);
  }
  const over = await hit("b", "subject-a", 60, 3);
  assert.equal(over.allowed, false);
  assert.equal(over.hits, 4);
  assert.ok(over.retryAfterSeconds > 0 && over.retryAfterSeconds <= 60);

  // A different subject has its own counter…
  assert.equal((await hit("b", "subject-b", 60, 3)).allowed, true);
  // …and so does a different bucket.
  assert.equal((await hit("other", "subject-a", 60, 3)).allowed, true);

  // The next fixed window starts clean.
  nowMs += 61_000;
  assert.equal((await hit("b", "subject-a", 60, 3)).hits, 1);
});

test("retryAfterSeconds is never 0", async (ctx) => {
  const { db } = await openDb();
  ctx.after(() => db.end());
  // Exactly on a window boundary, where naive arithmetic gives 0 and invites a
  // client hot-loop.
  const hit = createThrottle(db, () => new Date(Date.UTC(2026, 8, 16, 10, 0, 0)));
  await hit("b", "s", 3600, 1);
  const r = await hit("b", "s", 3600, 1);
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterSeconds >= 1);
});

test("peek reads a bucket without counting it", async (ctx) => {
  const { db } = await openDb();
  ctx.after(() => db.end());
  const hit = createThrottle(db, () => new Date(Date.UTC(2026, 8, 16, 10, 0, 0)));

  // An untouched bucket peeks as allowed with zero hits — and is still untouched.
  assert.deepEqual(
    await hit.peek("verify_fail", "s", 3600, 2).then((r) => [r.hits, r.allowed]),
    [0, true],
  );
  assert.equal((await hit.peek("verify_fail", "s", 3600, 2)).hits, 0);

  await hit("verify_fail", "s", 3600, 2);
  await hit("verify_fail", "s", 3600, 2);
  // hits === limit: the budget is spent, so the NEXT one would be refused.
  const full = await hit.peek("verify_fail", "s", 3600, 2);
  assert.equal(full.hits, 2);
  assert.equal(full.allowed, false);
});

test("request-code: 5 per hour per email, then 429 with Retry-After", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  for (let i = 0; i < 5; i += 1) {
    const r = await t.post("/v2/auth/request-code", { email: "runa@example.is" });
    assert.equal(r.status, 200, `request ${i + 1}`);
    assert.deepEqual(r.body, { ok: true, expiresInSeconds: 600, resendAfterSeconds: 30 });
    t.advance(31); // past the 30 s cooldown, still inside the hour
  }
  const sixth = await t.post("/v2/auth/request-code", { email: "runa@example.is" });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, "rate_limited");
  assert.ok(sixth.body.retryAfterSeconds > 0);
  assert.equal(sixth.headers.get("retry-after"), String(sixth.body.retryAfterSeconds));

  await t.idle();
  // Five codes were requested; the sixth never reached the mailer.
  assert.equal(t.mails.length, 5);
});

test("request-code: the 30 s cooldown blocks the second attempt", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  assert.equal((await t.post("/v2/auth/request-code", { email: "runa@example.is" })).status, 200);
  const quick = await t.post("/v2/auth/request-code", { email: "runa@example.is" });
  assert.equal(quick.status, 429);
  assert.ok(quick.body.retryAfterSeconds <= 30);

  t.advance(31);
  assert.equal((await t.post("/v2/auth/request-code", { email: "runa@example.is" })).status, 200);
  await t.idle();
  assert.equal(t.mails.length, 2);
});

test("an unknown email throttles exactly like a known one", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  const known = [];
  const unknown = [];
  for (let i = 0; i < 7; i += 1) {
    known.push(await t.post("/v2/auth/request-code", { email: "runa@example.is" }));
    unknown.push(await t.post("/v2/auth/request-code", { email: "stranger@example.com" }));
    t.advance(31);
  }
  for (let i = 0; i < 7; i += 1) {
    assert.equal(known[i].status, unknown[i].status, `attempt ${i + 1} status`);
    assert.equal(known[i].body.error ?? null, unknown[i].body.error ?? null);
    assert.equal(Boolean(known[i].body.ok), Boolean(unknown[i].body.ok));
  }
  await t.idle();
  // The stranger never got mail; the counters moved the same way regardless.
  assert.equal(t.mails.length, 5);
  assert.ok(t.mails.every((m) => m.to === "runa@example.is"));
});

test("the shared IP bucket cuts in at 20 per hour whatever the address", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  // 20 different addresses: each email bucket stays at 1, so only the IP bucket
  // can be what stops the 21st.
  for (let i = 0; i < 20; i += 1) {
    const r = await t.post("/v2/auth/request-code", { email: `person${i}@example.com` });
    assert.equal(r.status, 200, `address ${i}`);
  }
  const blocked = await t.post("/v2/auth/request-code", { email: "person20@example.com" });
  assert.equal(blocked.status, 429);
  await t.idle();
});

test("verify-fail buckets only count against a live code", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  const guess = (email) => t.post("/v2/auth/verify-code", {
    email,
    code: "000000",
    device: { installationId: "6f1c0000-0000-4000-8000-000000000001" },
  });

  // 25 guesses at an address with no live code: all 401, and nothing is counted,
  // so a stranger cannot lock a real driver out by guessing (S11).
  for (let i = 0; i < 25; i += 1) {
    const r = await guess("runa@example.is");
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "invalid_code" });
  }
  const hourly = await t.hit.peek("otp_verify_fail_email", "any", 3600, 10);
  assert.equal(hourly.hits, 0);
  const { rows } = await t.db.query("SELECT count(*)::int AS n FROM auth_throttle WHERE bucket LIKE 'otp_verify_fail%'");
  assert.equal(rows[0].n, 0, "no per-email fail counters exist yet");

  // Now there IS a live code, so a wrong guess counts.
  await t.post("/v2/auth/request-code", { email: "runa@example.is" });
  await t.idle();
  await guess("runa@example.is");
  const after = await t.db.query("SELECT bucket, hits FROM auth_throttle WHERE bucket LIKE 'otp_verify_fail%' ORDER BY bucket");
  assert.deepEqual(after.rows, [
    { bucket: "otp_verify_fail_email", hits: 1 },
    { bucket: "otp_verify_fail_email_day", hits: 1 },
  ]);
});

test("verify-code answers 429 only on the IP bucket, after 30 tries", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  const body = { email: "runa@example.is", code: "000000", device: { installationId: "6f1c0000-0000-4000-8000-000000000001" } };
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await t.post("/v2/auth/verify-code", body)).status, 401, `try ${i + 1}`);
  }
  const blocked = await t.post("/v2/auth/verify-code", body);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, "rate_limited");
});
