// Spec §10.1 test/config.test.js — the secrets rule, production detection and
// the flags that guard OTP logging and clock overrides.

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { loadConfig, dbNetworkOf, SECRET_MIN_LENGTH } from "../src/config.js";
import { createV2Router } from "../src/routes/v2.js";

const LONG = "x".repeat(SECRET_MIN_LENGTH);
const SHORT = "x".repeat(SECRET_MIN_LENGTH - 1);

/// Minimal env: loadConfig must never read process.env when it is handed one.
const env = (over = {}) => ({ ...over });

async function serve(config) {
  const app = express();
  app.use("/v2", express.json({ limit: "32kb" }));
  app.use("/v2", createV2Router({ db: { ready: false, status: "unavailable", query: async () => ({ rows: [] }) }, config, apns: () => ({ status: "missing" }) }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  return {
    url: (p) => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test("secrets rule: auth is configured only when both secrets are set and >= 32 chars", () => {
  assert.equal(loadConfig(env()).authStatus, "missing");
  assert.equal(loadConfig(env({ STAFF_JWT_SECRET: SHORT, OTP_HMAC_SECRET: LONG })).authStatus, "missing");
  assert.equal(loadConfig(env({ STAFF_JWT_SECRET: LONG, OTP_HMAC_SECRET: SHORT })).authStatus, "missing");
  assert.equal(loadConfig(env({ STAFF_JWT_SECRET: LONG })).authStatus, "missing");
  assert.equal(loadConfig(env({ OTP_HMAC_SECRET: LONG })).authStatus, "missing");

  const ok = loadConfig(env({ STAFF_JWT_SECRET: LONG, OTP_HMAC_SECRET: LONG }));
  assert.equal(ok.authStatus, "configured");
  assert.equal(ok.authConfigured, true);
});

test("secrets rule: a short STAFF_JWT_SECRET yields no usable jwt secrets", () => {
  assert.deepEqual(loadConfig(env({ STAFF_JWT_SECRET: SHORT })).jwtSecrets, []);
  assert.deepEqual(loadConfig(env({ STAFF_JWT_SECRET: LONG })).jwtSecrets, [LONG]);
  // A short previous secret is ignored rather than accepted alongside a good one.
  assert.deepEqual(
    loadConfig(env({ STAFF_JWT_SECRET: LONG, STAFF_JWT_SECRET_PREVIOUS: SHORT })).jwtSecrets,
    [LONG],
  );
  assert.deepEqual(
    loadConfig(env({ STAFF_JWT_SECRET: LONG, STAFF_JWT_SECRET_PREVIOUS: `${LONG}p` })).jwtSecrets,
    [LONG, `${LONG}p`],
  );
});

test("secrets rule: the internal path is off unless VAKT_INTERNAL_SECRET is long enough", () => {
  assert.equal(loadConfig(env()).internalStatus, "off");
  assert.equal(loadConfig(env({ VAKT_INTERNAL_SECRET: "" })).internalStatus, "off");
  assert.equal(loadConfig(env({ VAKT_INTERNAL_SECRET: SHORT })).internalStatus, "off");
  assert.equal(loadConfig(env({ VAKT_INTERNAL_SECRET: LONG })).internalStatus, "configured");
});

test("/v2/auth/* returns 503 auth_not_configured while the secrets rule is unmet", async () => {
  const s = await serve(loadConfig(env({ STAFF_JWT_SECRET: SHORT, OTP_HMAC_SECRET: LONG })));
  try {
    const res = await fetch(s.url("/v2/auth/request-code"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "jon@example.com" }),
    });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "auth_not_configured" });
  } finally {
    await s.close();
  }
});

test("/v2/auth/* stops saying auth_not_configured once both secrets are configured", async () => {
  // This harness has no database, so the next guard in line answers instead. What
  // matters is that the secrets guard steps aside and names a different problem:
  // "set the variable" and "wait for Postgres" send Rúnar to different places.
  const s = await serve(loadConfig(env({ STAFF_JWT_SECRET: LONG, OTP_HMAC_SECRET: LONG })));
  try {
    const res = await fetch(s.url("/v2/auth/request-code"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "jon@example.com" }),
    });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "db_unavailable" });
    assert.equal(res.headers.get("retry-after"), "30");
  } finally {
    await s.close();
  }
});

test("isProduction is true with only RAILWAY_ENVIRONMENT_NAME set", () => {
  assert.equal(loadConfig(env()).isProduction, false);
  assert.equal(loadConfig(env({ RAILWAY_ENVIRONMENT_NAME: "production" })).isProduction, true);
  assert.equal(loadConfig(env({ RAILWAY_ENVIRONMENT_NAME: "staging" })).isProduction, true);
  assert.equal(loadConfig(env({ NODE_ENV: "production" })).isProduction, true);
  assert.equal(loadConfig(env({ NODE_ENV: "development" })).isProduction, false);
});

test("a caller-supplied `now` is refused in production", () => {
  assert.equal(loadConfig(env({ NODE_ENV: "development" })).allowNowOverride, true);
  assert.equal(loadConfig(env({ NODE_ENV: "production" })).allowNowOverride, false);
  // The Railway-only case is what makes a forgotten NODE_ENV harmless.
  assert.equal(loadConfig(env({ RAILWAY_ENVIRONMENT_NAME: "production" })).allowNowOverride, false);
});

test("OTP_MAIL_TRANSPORT=log needs non-production AND ALLOW_OTP_LOG=1", () => {
  const log = (over) => loadConfig(env({ OTP_MAIL_TRANSPORT: "log", ...over })).otpMailTransport;
  assert.equal(log({}), "resend", "ALLOW_OTP_LOG missing");
  assert.equal(log({ ALLOW_OTP_LOG: "0" }), "resend");
  assert.equal(log({ ALLOW_OTP_LOG: "1" }), "log");
  assert.equal(log({ ALLOW_OTP_LOG: "1", NODE_ENV: "production" }), "resend");
  assert.equal(log({ ALLOW_OTP_LOG: "1", RAILWAY_ENVIRONMENT_NAME: "production" }), "resend");
  // An unknown transport falls back to resend rather than disabling mail.
  assert.equal(loadConfig(env({ OTP_MAIL_TRANSPORT: "smtp" })).otpMailTransport, "resend");
});

test("health mail status: configured needs only RESEND_OTP_API_KEY; log wins when effective", () => {
  assert.equal(loadConfig(env()).mailStatus, "missing");
  assert.equal(loadConfig(env({ RESEND_OTP_API_KEY: "re_test" })).mailStatus, "configured");
  assert.equal(
    loadConfig(env({ OTP_MAIL_TRANSPORT: "log", ALLOW_OTP_LOG: "1" })).mailStatus,
    "log",
  );
  // OTP_FROM has a default, so it is never part of "configured".
  assert.equal(loadConfig(env({ RESEND_OTP_API_KEY: "re_test" })).OTP_FROM, "BagBee <innskraning@updates.bagbee.is>");
});

test("dbNetwork names the network, never the URL", () => {
  assert.equal(dbNetworkOf("postgres://u:p@postgres.railway.internal:5432/railway"), "private");
  assert.equal(dbNetworkOf("postgres://u:p@viaduct.proxy.rlwy.net:12345/railway"), "public");
  assert.equal(dbNetworkOf("pglite:./.data/pglite"), "pglite");
  assert.equal(dbNetworkOf("pglite:memory"), "pglite");
  assert.equal(dbNetworkOf(""), "missing");
  assert.equal(loadConfig(env({ DATABASE_URL: "pglite:memory" })).dbNetwork, "pglite");
});

test("flags keep their documented defaults and reject junk values", () => {
  const d = loadConfig(env());
  assert.equal(d.vaktShell, "off");
  assert.equal(d.pushMode, "off");
  assert.equal(d.workerEnabled, true);
  assert.equal(d.planPushTonight, true);
  assert.equal(d.counterPushEnabled, true);
  assert.equal(d.appRoutesAcceptStaffJwt, false);
  assert.equal(d.planSlotSplit, "16:00");
  assert.equal(d.minAppBuild, 41);
  assert.deepEqual(d.staffLoginAllowlist, []);
  assert.deepEqual(d.declineNotifyEmails, []);
  assert.equal(d.DATABASE_SSL, "disable");

  const set = loadConfig(env({
    VAKT_SHELL: "on",
    PUSH_MODE: "pilot",
    WORKER_ENABLED: "0",
    PLAN_PUSH_TONIGHT: "0",
    COUNTER_PUSH_ENABLED: "0",
    APP_ROUTES_ACCEPT_STAFF_JWT: "1",
    PLAN_SLOT_SPLIT: "15:30",
    DATABASE_SSL: "require",
    STAFF_LOGIN_ALLOWLIST: "recLCxvPg6oAKUfDp, reckSlV8TCqkU19oG ,",
    DECLINE_NOTIFY_EMAILS: "a@bagbee.is,b@bagbee.is",
  }));
  assert.equal(set.vaktShell, "on");
  assert.equal(set.pushMode, "pilot");
  assert.equal(set.workerEnabled, false);
  assert.equal(set.planPushTonight, false);
  assert.equal(set.counterPushEnabled, false);
  assert.equal(set.appRoutesAcceptStaffJwt, true);
  assert.equal(set.planSlotSplit, "15:30");
  assert.equal(set.DATABASE_SSL, "require");
  assert.deepEqual(set.staffLoginAllowlist, ["recLCxvPg6oAKUfDp", "reckSlV8TCqkU19oG"]);
  assert.deepEqual(set.declineNotifyEmails, ["a@bagbee.is", "b@bagbee.is"]);

  const junk = loadConfig(env({ VAKT_SHELL: "yes", PUSH_MODE: "loud", PLAN_SLOT_SPLIT: "25:00", WORKER_ENABLED: "true" }));
  assert.equal(junk.vaktShell, "off");
  assert.equal(junk.pushMode, "off");
  assert.equal(junk.planSlotSplit, "16:00", "an out-of-range hour falls back, it does not split at 25:00");
  assert.equal(junk.workerEnabled, true, "unparseable WORKER_ENABLED keeps the default");
  assert.equal(loadConfig(env({ PLAN_SLOT_SPLIT: "1600" })).planSlotSplit, "16:00");
  assert.equal(loadConfig(env({ PLAN_SLOT_SPLIT: "16:60" })).planSlotSplit, "16:00");
});

test("secrets are read byte-exact while plain settings are trimmed", () => {
  const padded = `${LONG} `;
  const c = loadConfig(env({ STAFF_JWT_SECRET: padded, OTP_FROM: "  BagBee <x@bagbee.is>  " }));
  assert.equal(c.STAFF_JWT_SECRET, padded, "trimming a secret would change the HMAC key");
  assert.equal(c.OTP_FROM, "BagBee <x@bagbee.is>");
});
