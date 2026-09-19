// Spec §4.4 / §4.5 / §10.1 — the auth routes end to end: a real express app on
// listen(0), a real Postgres (PGlite), a fake Airtable roster and a fake mailer.
//
// The property most of these cases exist to protect is S2: a stranger must not be
// able to learn whether an address belongs to BagBee staff. So the known and the
// unknown address are driven through the same sequence and their responses
// compared byte for byte, rather than each being checked on its own.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
import { hashCode } from "../src/auth/otp.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const JWT_SECRET = "j".repeat(40);
const OTP_SECRET = "o".repeat(40);
const QUIET = { log() {}, warn() {}, error() {} };
const INSTALLATION = "6f1c0000-0000-4000-8000-000000000001";
const OTHER_INSTALLATION = "6f1c0000-0000-4000-8000-000000000002";
const KNOWN = "runa@example.is";
const UNKNOWN = "stranger@example.com";

const OWNER = {
  airtableId: "recLCxvPg6oAKUfDp",
  name: "Rúnar",
  firstName: "Rúnar",
  displayName: "Rúnar",
  email: KNOWN,
  personalEmail: "runar.personal@example.com",
  teams: ["Office", "Drivers"],
  status: "Active",
  active: true,
  role: "owner",
};

const device = (installationId = INSTALLATION) => ({
  installationId,
  model: "iPhone17,1",
  osVersion: "26.4",
  appVersion: "1.0",
  appBuild: 41,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serve({ people = [OWNER], envOver = {}, lookupDelayMs = 0, mailFails = false } = {}) {
  const config = loadConfig({
    DATABASE_URL: "pglite:memory",
    STAFF_JWT_SECRET: JWT_SECRET,
    OTP_HMAC_SECRET: OTP_SECRET,
    DECLINE_NOTIFY_EMAILS: "runa@example.is,vali@example.is",
    ...envOver,
  });
  const db = createDb(config);
  await initPool(db, config);
  await migrate(db.pool, MIGRATIONS_DIR);
  db.ready = true;

  let nowMs = Date.now();
  const clock = () => new Date(nowMs);

  /// Mutable, so a test can turn someone Inactive between two requests.
  const state = { people: [...people] };
  const find = (id) => state.people.find((p) => p.airtableId === id) ?? null;
  const roster = {
    async findActiveStaffByEmail(email) {
      if (lookupDelayMs) await sleep(lookupDelayMs);
      return state.people.find((p) => p.active && (p.email === email || p.personalEmail === email)) ?? null;
    },
    async getStaffById(id) {
      return find(id);
    },
    async getRosterEntry(id) {
      return { entry: find(id), stale: false };
    },
  };

  const mails = [];
  const alerts = [];
  const mailer = {
    async sendOtpMail(args) {
      mails.push(args);
      if (mailFails) throw Object.assign(new Error("resend 401"), { code: "mail_failed" });
      return { status: "sent", providerId: `re_${mails.length}` };
    },
    async sendGuessAlert(args) {
      alerts.push(args);
      return { status: "sent", providerId: "re_alert" };
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

  async function call(method, path, { body, token, headers = {} } = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  const api = {
    db, config, state, mails, alerts, sessionCache,
    post: (path, body, opts) => call("POST", path, { body: body ?? {}, ...opts }),
    get: (path, opts) => call("GET", path, opts),
    advance: (seconds) => { nowMs += seconds * 1000; },
    idle: () => authRoutes.whenIdle(),
    rows: async (sql, params) => (await db.query(sql, params)).rows,

    /// request-code → wait for the detached task → hand back the code the mailer saw.
    async requestCode(email = KNOWN) {
      const before = api.mails.length;
      const res = await api.post("/v2/auth/request-code", { email });
      await api.idle();
      return { res, code: api.mails.length > before ? api.mails.at(-1).code : null };
    },
    verify: (email, code, installationId = INSTALLATION) =>
      api.post("/v2/auth/verify-code", { email, code, device: device(installationId) }),

    /// A signed-in session, the way the app gets one.
    async signIn(email = KNOWN, installationId = INSTALLATION) {
      const { code } = await api.requestCode(email);
      const res = await api.verify(email, code, installationId);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      api.advance(31); // clear the 30 s cooldown for the next requestCode
      return res.body;
    },

    async close() {
      await api.idle();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await db.end();
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// request-code
// ---------------------------------------------------------------------------

test("request-code: a known and an unknown address are indistinguishable", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const known = await t.post("/v2/auth/request-code", { email: KNOWN });
  const unknown = await t.post("/v2/auth/request-code", { email: UNKNOWN });
  await t.idle();

  assert.equal(known.status, 200);
  assert.deepEqual(known.body, { ok: true, expiresInSeconds: 600, resendAfterSeconds: 30 });
  assert.equal(unknown.status, known.status);
  assert.deepEqual(unknown.body, known.body);
  // Only the real address produced mail and a row.
  assert.equal(t.mails.length, 1);
  assert.equal(t.mails[0].to, KNOWN);
  assert.deepEqual(await t.rows("SELECT email FROM otp_codes"), [{ email: KNOWN }]);
});

test("request-code: the response is sent before the Airtable lookup", async (ctx) => {
  // A 2 s lookup: if the response waited for it, a stranger could time the
  // difference and learn who works here (S2).
  const t = await serve({ lookupDelayMs: 2000 });
  ctx.after(() => t.close());

  const started = Date.now();
  const res = await t.post("/v2/auth/request-code", { email: KNOWN });
  const elapsed = Date.now() - started;

  assert.equal(res.status, 200);
  assert.ok(elapsed < 500, `expected < 500 ms, took ${elapsed} ms`);
  await t.idle();
  assert.equal(t.mails.length, 1, "the code is still sent, just afterwards");
});

test("request-code: the code is stored hashed with the secret, never in clear", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const { code } = await t.requestCode();
  assert.match(code, /^\d{6}$/);
  const [row] = await t.rows("SELECT code_hash, mail_status, mail_provider_id, attempts, max_attempts, request_ip FROM otp_codes");
  assert.equal(row.code_hash, hashCode(OTP_SECRET, KNOWN, code));
  assert.ok(!row.code_hash.includes(code));
  assert.equal(row.mail_status, "sent");
  assert.equal(row.mail_provider_id, "re_1");
  assert.equal(row.attempts, 0);
  assert.equal(row.max_attempts, 5);
  assert.ok(row.request_ip, "the requesting IP is recorded for incident work");
  // The mailer is called exactly once per request.
  assert.equal(t.mails.length, 1);
});

test("request-code: a second code supersedes the first, leaving exactly one live", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const first = await t.requestCode();
  t.advance(31);
  const second = await t.requestCode();
  assert.notEqual(first.code, second.code);

  const rows = await t.rows("SELECT invalidated_reason FROM otp_codes ORDER BY created_at");
  assert.deepEqual(rows, [{ invalidated_reason: "superseded" }, { invalidated_reason: null }]);
  // The old code is dead even though it has not expired.
  assert.equal((await t.verify(KNOWN, first.code)).status, 401);
});

test("request-code: a failed send is recorded and does not throw away the code row", async (ctx) => {
  const t = await serve({ mailFails: true });
  ctx.after(() => t.close());

  const res = await t.post("/v2/auth/request-code", { email: KNOWN });
  await t.idle();
  assert.equal(res.status, 200, "a Resend outage must look the same to the caller");
  assert.deepEqual(await t.rows("SELECT mail_status FROM otp_codes"), [{ mail_status: "failed" }]);
});

test("request-code: the personal address works too", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  const { code } = await t.requestCode(OWNER.personalEmail);
  assert.ok(code);
  assert.equal((await t.verify(OWNER.personalEmail, code)).status, 200);
});

test("request-code: someone outside STAFF_LOGIN_ALLOWLIST gets the same 200 and no mail", async (ctx) => {
  const t = await serve({ envOver: { STAFF_LOGIN_ALLOWLIST: "recOtherPersonXY12" } });
  ctx.after(() => t.close());

  const res = await t.post("/v2/auth/request-code", { email: KNOWN });
  await t.idle();
  assert.deepEqual(res.body, { ok: true, expiresInSeconds: 600, resendAfterSeconds: 30 });
  assert.equal(t.mails.length, 0);
  assert.deepEqual(await t.rows("SELECT id FROM otp_codes"), []);
});

test("request-code: an Inactive person gets the same 200 and no mail", async (ctx) => {
  const t = await serve({ people: [{ ...OWNER, active: false, status: "Inactive" }] });
  ctx.after(() => t.close());
  const res = await t.post("/v2/auth/request-code", { email: KNOWN });
  await t.idle();
  assert.equal(res.status, 200);
  assert.equal(t.mails.length, 0);
});

test("request-code: bad input is invalid_email, and is the only 400 here", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  for (const email of [undefined, null, "", "   ", "no-at-sign", `${"a".repeat(250)}@b.is`, 42, { a: 1 }]) {
    const res = await t.post("/v2/auth/request-code", { email });
    assert.equal(res.status, 400, String(email));
    assert.deepEqual(res.body, { error: "invalid_email" });
  }
  assert.equal(t.mails.length, 0);
});

// ---------------------------------------------------------------------------
// verify-code
// ---------------------------------------------------------------------------

test("verify-code: every email-dependent failure is the same 401, known or unknown", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  // (a) no code was ever requested.
  const noCodeKnown = await t.verify(KNOWN, "123456");
  const noCodeUnknown = await t.verify(UNKNOWN, "123456");
  assert.equal(noCodeKnown.status, 401);
  assert.deepEqual(noCodeKnown.body, { error: "invalid_code" });
  assert.equal(noCodeUnknown.status, noCodeKnown.status);
  assert.deepEqual(noCodeUnknown.body, noCodeKnown.body);

  // (b) a live code, wrong guess.
  const { code } = await t.requestCode();
  const wrong = await t.verify(KNOWN, code === "000000" ? "111111" : "000000");
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, noCodeUnknown.body);
  // Nothing in the body hints at how many tries are left.
  assert.deepEqual(Object.keys(wrong.body), ["error"]);
});

test("verify-code: 5 wrong guesses kill the code, and then the right one is 401 too", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const { code } = await t.requestCode();
  const wrongCode = code === "000000" ? "111111" : "000000";
  for (let i = 1; i <= 5; i += 1) {
    const res = await t.verify(KNOWN, wrongCode);
    assert.equal(res.status, 401, `attempt ${i}`);
    assert.deepEqual(res.body, { error: "invalid_code" });
  }
  const [row] = await t.rows("SELECT attempts, invalidated_reason FROM otp_codes");
  assert.equal(row.attempts, 5);
  assert.equal(row.invalidated_reason, "too_many_attempts");

  // The person now holds a correct code that no longer works — the app words this
  // as "Of margar rangar tilraunir. Biddu um nýjan kóða." on its own (§8.4).
  const right = await t.verify(KNOWN, code);
  assert.equal(right.status, 401);
  assert.deepEqual(right.body, { error: "invalid_code" });
});

test("verify-code: an expired code is 401 and is not counted as a wrong guess", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const { code } = await t.requestCode();
  await t.db.query("UPDATE otp_codes SET expires_at = now() - interval '1 minute'");

  const res = await t.verify(KNOWN, code);
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: "invalid_code" });
  assert.deepEqual(await t.rows("SELECT attempts FROM otp_codes"), [{ attempts: 0 }]);
  assert.deepEqual(await t.rows("SELECT bucket FROM auth_throttle WHERE bucket LIKE 'otp_verify_fail%'"), []);
});

test("verify-code: the 21st wrong code in 24 h sends the office alert exactly once", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  // 10 counted wrong guesses per hour is the hourly cap, and 5 per code is the
  // per-code cap, so 20 counted guesses take two codes an hour over two hours.
  const burnTen = async () => {
    for (let round = 0; round < 2; round += 1) {
      const { code } = await t.requestCode();
      const wrong = code === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i += 1) assert.equal((await t.verify(KNOWN, wrong)).status, 401);
      t.advance(31);
    }
  };
  await burnTen();
  t.advance(3600);
  await burnTen();

  const [day] = await t.rows("SELECT hits FROM auth_throttle WHERE bucket = 'otp_verify_fail_email_day'");
  assert.equal(day.hits, 20, "20 counted wrong guesses so far");
  assert.equal(t.alerts.length, 0, "no alert yet");

  // The 21st attempt: the daily bucket is full, so the live code is invalidated
  // and the office is told once.
  t.advance(3600);
  const { code } = await t.requestCode();
  const blocked = await t.verify(KNOWN, code === "000000" ? "111111" : "000000");
  assert.equal(blocked.status, 401);
  assert.deepEqual(blocked.body, { error: "invalid_code" });
  await t.idle();

  assert.equal(t.alerts.length, 1);
  assert.equal(t.alerts[0].name, "Rúnar");
  assert.equal(t.alerts[0].count, 21);
  // No address and no code anywhere in it.
  assert.ok(!JSON.stringify(t.alerts[0]).includes("@"));

  const [live] = await t.rows("SELECT invalidated_reason FROM otp_codes ORDER BY created_at DESC LIMIT 1");
  assert.equal(live.invalidated_reason, "email_throttled");

  // Attempts 22 and 23 are refused the same way, with no second alert.
  assert.equal((await t.verify(KNOWN, "999999")).status, 401);
  assert.equal((await t.verify(KNOWN, "999999")).status, 401);
  await t.idle();
  assert.equal(t.alerts.length, 1);
});

test("verify-code: bad input shapes are 400 invalid_request", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  const cases = [
    { email: KNOWN, code: "12345", device: device() },
    { email: KNOWN, code: "abcdef", device: device() },
    { email: KNOWN, code: 123456, device: device() },
    { email: "nope", code: "123456", device: device() },
    { email: KNOWN, code: "123456", device: { installationId: "not-a-uuid" } },
    { email: KNOWN, code: "123456" },
    {},
  ];
  for (const body of cases) {
    const res = await t.post("/v2/auth/verify-code", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(res.body, { error: "invalid_request" });
  }
});

test("verify-code: the right code returns tokens, a profile and a device", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const { code } = await t.requestCode();
  const res = await t.verify(KNOWN, code);
  assert.equal(res.status, 200);
  const b = res.body;

  assert.match(b.accessToken, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.match(b.accessTokenExpiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(b.refreshToken, /^bbr_[\w-]{43}$/);
  assert.match(b.refreshTokenExpiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(b.staff, {
    id: b.staff.id,
    airtableId: OWNER.airtableId,
    name: "Rúnar",
    firstName: "Rúnar",
    email: KNOWN,
    teams: ["Office", "Drivers"],
    role: "owner",
  });
  assert.match(b.deviceId, /^[0-9a-f-]{36}$/);

  const claims = JSON.parse(Buffer.from(b.accessToken.split(".")[1], "base64url"));
  assert.equal(claims.iss, "bagbee-api");
  assert.equal(claims.aud, "bagbee-vakt");
  assert.equal(claims.sub, b.staff.id);
  assert.equal(claims.did, b.deviceId);
  assert.equal(claims.at, OWNER.airtableId);
  assert.equal(claims.role, "owner");
  assert.deepEqual(claims.team, ["Office", "Drivers"]);
  assert.equal(claims.exp - claims.iat, 900);

  const [row] = await t.rows("SELECT consumed_at FROM otp_codes");
  assert.ok(row.consumed_at, "the code is spent");
  const [dev] = await t.rows("SELECT installation_id, model, app_build, staff_id FROM devices");
  assert.equal(dev.installation_id, INSTALLATION);
  assert.equal(dev.model, "iPhone17,1");
  assert.equal(dev.app_build, 41);
  assert.equal(dev.staff_id, b.staff.id);
  const [staff] = await t.rows("SELECT last_login_at, teams, role FROM staff");
  assert.ok(staff.last_login_at);
  assert.deepEqual(staff.teams, ["Office", "Drivers"]);
  assert.equal(staff.role, "owner");
  // The refresh token is never stored in the clear.
  const [session] = await t.rows("SELECT refresh_hash, created_ip, user_agent FROM sessions");
  assert.equal(session.refresh_hash, crypto.createHash("sha256").update(b.refreshToken).digest("hex"));
  assert.ok(session.created_ip);
});

test("verify-code: the same code cannot be used twice", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  const { code } = await t.requestCode();
  assert.equal((await t.verify(KNOWN, code)).status, 200);
  assert.equal((await t.verify(KNOWN, code)).status, 401);
});

test("verify-code: signing in again on the same phone supersedes the old session", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const first = await t.signIn();
  const second = await t.signIn();
  assert.notEqual(first.refreshToken, second.refreshToken);

  const sessions = await t.rows("SELECT revoked_reason FROM sessions ORDER BY created_at");
  assert.deepEqual(sessions, [{ revoked_reason: "superseded" }, { revoked_reason: null }]);
  // One device row, not two.
  assert.equal((await t.rows("SELECT id FROM devices")).length, 1);
  // The old refresh token is dead.
  const refreshed = await t.post("/v2/auth/refresh", { refreshToken: first.refreshToken });
  assert.equal(refreshed.status, 401);
  assert.deepEqual(refreshed.body, { error: "invalid_refresh" });
});

test("verify-code: a phone handed to someone else invalidates the old APNs token", async (ctx) => {
  const second = { ...OWNER, airtableId: "recusZGetZKMa2ItP", name: "Matas", email: "mattie@example.is", personalEmail: "", teams: ["Drivers"], role: "staff" };
  const t = await serve({ people: [OWNER, second] });
  ctx.after(() => t.close());

  await t.signIn(KNOWN, INSTALLATION);
  await t.db.query("UPDATE devices SET apns_token = $1, apns_environment = 'production'", ["a1b2".repeat(16)]);
  await t.signIn(second.email, INSTALLATION);

  const [dev] = await t.rows("SELECT invalidated_reason, apns_token FROM devices");
  assert.equal(dev.invalidated_reason, "reassigned");
  assert.ok(dev.apns_token, "the token is kept but marked dead until the new person registers");
});

test("verify-code: a correct code from someone who has since gone Inactive is 403", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const { code } = await t.requestCode();
  // Between the email and the tap, the person left.
  t.state.people = [{ ...OWNER, active: false, status: "Inactive" }];

  const res = await t.verify(KNOWN, code);
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "staff_inactive" });
  assert.deepEqual(await t.rows("SELECT id FROM sessions"), []);
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

test("refresh: rotates the token and recomputes role from the roster", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const signIn = await t.signIn();
  // The person is taken off Office in Airtable.
  t.state.people = [{ ...OWNER, teams: ["Drivers"], role: "staff" }];

  const res = await t.post("/v2/auth/refresh", { refreshToken: signIn.refreshToken });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt"]);
  assert.notEqual(res.body.refreshToken, signIn.refreshToken);

  const claims = JSON.parse(Buffer.from(res.body.accessToken.split(".")[1], "base64url"));
  assert.equal(claims.role, "staff", "owner rights must not survive leaving Office");
  assert.deepEqual(claims.team, ["Drivers"]);
  // …and the change is written back, so the next token starts from the truth.
  assert.deepEqual(await t.rows("SELECT role FROM staff"), [{ role: "staff" }]);
});

test("refresh: a bad shape is 400, an unknown token is 401", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  for (const refreshToken of [undefined, "", "nope", 42, `bbr_${"x".repeat(300)}`]) {
    const res = await t.post("/v2/auth/refresh", { refreshToken });
    assert.equal(res.status, 400, String(refreshToken));
    assert.deepEqual(res.body, { error: "invalid_request" });
  }
  const unknown = await t.post("/v2/auth/refresh", { refreshToken: `bbr_${"a".repeat(43)}` });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.body, { error: "invalid_refresh" });
});

test("refresh: an Inactive person is signed out everywhere", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const a = await t.signIn(KNOWN, INSTALLATION);
  const b = await t.signIn(KNOWN, OTHER_INSTALLATION);
  t.state.people = [{ ...OWNER, active: false, status: "Inactive" }];

  const res = await t.post("/v2/auth/refresh", { refreshToken: b.refreshToken });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "staff_inactive" });

  const sessions = await t.rows("SELECT revoked_reason FROM sessions WHERE revoked_at IS NOT NULL");
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => s.revoked_reason === "staff_inactive"));
  const devices = await t.rows("SELECT staff_id, invalidated_reason FROM devices");
  assert.equal(devices.length, 2);
  assert.ok(devices.every((d) => d.staff_id === null && d.invalidated_reason === "staff_inactive"));

  // The other device's access token stops working in the same instant.
  assert.equal((await t.get("/v2/me", { token: a.accessToken })).status, 401);
});

test("refresh: an Airtable outage does not sign anyone out", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  const signIn = await t.signIn();
  t.state.people = [];                       // getRosterEntry answers "missing"
  const gone = await t.post("/v2/auth/refresh", { refreshToken: signIn.refreshToken });
  assert.equal(gone.status, 403, "a person genuinely absent from the roster is signed out");

  // But a roster that THROWS is an outage, not an answer.
  const t2 = await serve();
  ctx.after(() => t2.close());
  const s2 = await t2.signIn();
  t2.state.people = null;                    // makes find() throw inside getRosterEntry
  const res = await t2.post("/v2/auth/refresh", { refreshToken: s2.refreshToken });
  assert.equal(res.status, 200);
  const claims = JSON.parse(Buffer.from(res.body.accessToken.split(".")[1], "base64url"));
  assert.equal(claims.role, "owner", "the stored values are kept when the roster cannot be read");
});

// ---------------------------------------------------------------------------
// /v2/me, logout, logout-all
// ---------------------------------------------------------------------------

test("GET /v2/me needs a token and returns the profile, session, device and flags", async (ctx) => {
  const t = await serve({ envOver: { PUSH_MODE: "pilot" } });
  ctx.after(() => t.close());

  const anon = await t.get("/v2/me");
  assert.equal(anon.status, 401);
  assert.deepEqual(anon.body, { error: "invalid_token" });

  const signIn = await t.signIn();
  const res = await t.get("/v2/me", { token: signIn.accessToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.staff, signIn.staff);
  assert.equal(res.body.session.id, JSON.parse(Buffer.from(signIn.accessToken.split(".")[1], "base64url")).sid);
  assert.match(res.body.session.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(res.body.device, { id: signIn.deviceId, pushRegistered: false, apnsEnvironment: null });
  assert.deepEqual(res.body.features, { pushMode: "pilot" });

  // A registered token flips pushRegistered.
  await t.db.query("UPDATE devices SET apns_token = $1, apns_environment = 'sandbox'", ["b1b2".repeat(16)]);
  const after = await t.get("/v2/me", { token: signIn.accessToken });
  assert.deepEqual(after.body.device, { id: signIn.deviceId, pushRegistered: true, apnsEnvironment: "sandbox" });
});

test("GET /v2/me signs out a person who has gone Inactive", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const signIn = await t.signIn();
  t.state.people = [{ ...OWNER, active: false, status: "Inactive" }];

  const res = await t.get("/v2/me", { token: signIn.accessToken });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "staff_inactive" });
  assert.deepEqual(await t.rows("SELECT revoked_reason FROM sessions"), [{ revoked_reason: "staff_inactive" }]);
  assert.deepEqual(await t.rows("SELECT staff_id, invalidated_reason FROM devices"), [{ staff_id: null, invalidated_reason: "staff_inactive" }]);
  // The session cache was dropped too, so the next call is 401 rather than 403.
  assert.equal((await t.get("/v2/me", { token: signIn.accessToken })).status, 401);
});

test("GET /v2/me picks up a name change from the roster", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  const signIn = await t.signIn();
  t.state.people = [{ ...OWNER, name: "Rúnar Snær", firstName: "Rúnar", teams: ["Office"] }];

  const res = await t.get("/v2/me", { token: signIn.accessToken });
  assert.equal(res.body.staff.name, "Rúnar Snær");
  assert.deepEqual(res.body.staff.teams, ["Office"]);
  assert.deepEqual(await t.rows("SELECT name FROM staff"), [{ name: "Rúnar Snær" }]);
});

test("logout revokes this session and unlinks this device only", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const a = await t.signIn(KNOWN, INSTALLATION);
  const b = await t.signIn(KNOWN, OTHER_INSTALLATION);

  const res = await t.post("/v2/auth/logout", {}, { token: a.accessToken });
  assert.equal(res.status, 204);
  assert.equal(res.body, null);

  // Immediately, not in 60 s: the cache entry is gone in this process.
  assert.equal((await t.get("/v2/me", { token: a.accessToken })).status, 401);
  assert.equal((await t.get("/v2/me", { token: b.accessToken })).status, 200);
  assert.equal((await t.post("/v2/auth/refresh", { refreshToken: a.refreshToken })).status, 401);

  const devices = await t.rows("SELECT installation_id, staff_id, invalidated_reason FROM devices ORDER BY installation_id");
  assert.equal(devices[0].staff_id, null);
  assert.equal(devices[0].invalidated_reason, "logout");
  assert.ok(devices[1].staff_id, "the other phone is untouched");
});

test("logout-all revokes every session and unlinks every device", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());

  const a = await t.signIn(KNOWN, INSTALLATION);
  const b = await t.signIn(KNOWN, OTHER_INSTALLATION);

  const res = await t.post("/v2/auth/logout-all", {}, { token: b.accessToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { revokedSessions: 2 });

  assert.equal((await t.get("/v2/me", { token: a.accessToken })).status, 401);
  assert.equal((await t.get("/v2/me", { token: b.accessToken })).status, 401);
  const devices = await t.rows("SELECT staff_id, invalidated_reason FROM devices");
  assert.ok(devices.every((d) => d.staff_id === null && d.invalidated_reason === "logout_all"));
  const sessions = await t.rows("SELECT revoked_reason FROM sessions");
  assert.ok(sessions.every((s) => s.revoked_reason === "logout_all"));

  // A second call is a no-op, not a 500.
  assert.equal((await t.post("/v2/auth/logout-all", {}, { token: b.accessToken })).status, 401);
});

test("logout and logout-all need a token", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  assert.equal((await t.post("/v2/auth/logout")).status, 401);
  assert.equal((await t.post("/v2/auth/logout-all")).status, 401);
});

// ---------------------------------------------------------------------------
// The secrets rule and the database guard (§2.2, §4.2)
// ---------------------------------------------------------------------------

test("without STAFF_JWT_SECRET or OTP_HMAC_SECRET the whole auth surface is 503", async (ctx) => {
  const t = await serve({ envOver: { OTP_HMAC_SECRET: "too-short" } });
  ctx.after(() => t.close());

  for (const [path, body] of [
    ["/v2/auth/request-code", { email: KNOWN }],
    ["/v2/auth/verify-code", { email: KNOWN, code: "123456", device: device() }],
    ["/v2/auth/refresh", { refreshToken: `bbr_${"a".repeat(43)}` }],
    ["/v2/auth/logout", {}],
  ]) {
    const res = await t.post(path, body);
    assert.equal(res.status, 503, path);
    assert.deepEqual(res.body, { error: "auth_not_configured" });
  }
  const me = await t.get("/v2/me");
  assert.equal(me.status, 503);
  assert.deepEqual(me.body, { error: "auth_not_configured" });
  // /v2/app-config keeps working: it is the kill switch and must never need auth.
  assert.equal((await t.get("/v2/app-config")).status, 200);
});

test("while the database is down every auth route answers 503 db_unavailable", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  const signIn = await t.signIn();
  t.db.ready = false;

  const res = await t.post("/v2/auth/request-code", { email: KNOWN });
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: "db_unavailable" });
  assert.equal(res.headers.get("retry-after"), "30");
  assert.equal((await t.post("/v2/auth/verify-code", { email: KNOWN, code: "123456", device: device() })).status, 503);
  assert.equal((await t.post("/v2/auth/refresh", { refreshToken: signIn.refreshToken })).status, 503);
  // A signed-in caller: requireStaff passes from its cache, then requireDb answers.
  assert.equal((await t.get("/v2/me", { token: signIn.accessToken })).status, 503);
  // No token is still 401 — that answer needs no database, and telling a stranger
  // "try again in 30 s" would be a worse one.
  assert.equal((await t.get("/v2/me")).status, 401);
  t.db.ready = true;
});

test("an unknown /v2 path is a JSON 404", async (ctx) => {
  const t = await serve();
  ctx.after(() => t.close());
  const res = await t.get("/v2/auth/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "not_found" });
});
