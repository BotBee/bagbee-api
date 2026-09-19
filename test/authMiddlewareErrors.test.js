// Audit finding 3: requireStaff and requireOwnerOrInternal called
// `authenticate(req).then(handler, next)`. That routes a REJECTION of
// authenticate() to next(), but a throw inside the fulfilment handler itself has
// nowhere to go: the promise rejects with nobody listening, Express never learns
// the request failed, the client is left hanging until it times out, and Node
// prints an unhandled rejection (which on Railway is a process-level event, not a
// 500 on one request).
//
// The fix is `.then(handler).catch(next)`, and these tests pin both halves: the
// throw path must reach next(), and the rejection path must keep reaching it.

import test from "node:test";
import assert from "node:assert/strict";
import { createAuthMiddleware } from "../src/auth/middleware.js";
import { signJwt } from "../src/auth/jwt.js";
import { loadConfig } from "../src/config.js";

const quiet = { log() {}, error() {} };
const SECRET = "s".repeat(40);

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/// A res whose first write throws. This is what an aborted connection, a
/// double-send or any later res patch looks like from inside the handler.
function explodingRes(boom) {
  return {
    set() { return this; },
    status() { throw boom; },
    json() { return this; },
  };
}

function fakeReq(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: lower, get: (name) => lower[String(name).toLowerCase()] };
}

function liveSessionCache(value = { live: true }) {
  return { get: () => value, set() {}, delete() {}, deleteMany() {}, size: 0 };
}

function staffToken(claims = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      iss: "bagbee-api", aud: "bagbee-vakt",
      sub: "11111111-1111-1111-1111-111111111111",
      sid: "22222222-2222-2222-2222-222222222222",
      did: "33333333-3333-3333-3333-333333333333",
      at: "recAAAAAAAAAAAAAA", team: ["Drivers"], role: "staff",
      iat: nowSec, exp: nowSec + 900,
      ...claims,
    },
    SECRET,
  );
}

test("requireStaff routes a throw inside the fulfilment handler to next()", async () => {
  // authConfigured is false without secrets, so the handler takes its very first
  // branch — res.status(503).json(...) — and that is what explodes here.
  const config = loadConfig({});
  const { requireStaff } = createAuthMiddleware({
    db: { ready: false }, config, roster: {}, sessionCache: liveSessionCache(), log: quiet,
  });

  const boom = new Error("res exploded");
  const seen = [];
  requireStaff(fakeReq(), explodingRes(boom), (err) => seen.push(err));
  await settle();

  assert.deepEqual(seen, [boom], "the error must reach Express's error handler, not become an unhandled rejection");
});

test("requireOwnerOrInternal routes a throw inside its async handler to next()", async () => {
  const config = loadConfig({});
  const { requireOwnerOrInternal } = createAuthMiddleware({
    db: { ready: false }, config, roster: {}, sessionCache: liveSessionCache(), log: quiet,
  });

  const boom = new Error("res exploded");
  const seen = [];
  requireOwnerOrInternal(fakeReq(), explodingRes(boom), (err) => seen.push(err));
  await settle();

  assert.deepEqual(seen, [boom]);
});

test("a throw on the authenticated success path also reaches next()", async () => {
  const config = loadConfig({ STAFF_JWT_SECRET: SECRET, OTP_HMAC_SECRET: SECRET });
  const { requireStaff } = createAuthMiddleware({
    db: { ready: true, query: async () => ({ rows: [] }) },
    config, roster: {}, sessionCache: liveSessionCache(), log: quiet,
  });

  const boom = new Error("downstream exploded");
  const seen = [];
  const req = fakeReq({ authorization: `Bearer ${staffToken()}` });
  requireStaff(req, explodingRes(boom), (err) => {
    // First call is the real next(); throwing from it stands in for any
    // synchronous failure on the way out of the middleware.
    if (err === undefined && seen.length === 0) { seen.push("next()"); throw boom; }
    seen.push(err);
  });
  await settle();

  assert.deepEqual(seen, ["next()", boom]);
  assert.equal(req.staff?.id, "11111111-1111-1111-1111-111111111111");
});

test("a rejection from authenticate() still reaches next() (unchanged)", async () => {
  const config = loadConfig({ STAFF_JWT_SECRET: SECRET, OTP_HMAC_SECRET: SECRET });
  const boom = new Error("session cache exploded");
  const sessionCache = { get() { throw boom; }, set() {}, delete() {}, deleteMany() {}, size: 0 };
  const { requireStaff } = createAuthMiddleware({
    db: { ready: true, query: async () => ({ rows: [] }) }, config, roster: {}, sessionCache, log: quiet,
  });

  const seen = [];
  requireStaff(fakeReq({ authorization: `Bearer ${staffToken()}` }), explodingRes(new Error("unused")), (err) => seen.push(err));
  await settle();

  assert.deepEqual(seen, [boom]);
});

test("the ordinary paths still answer normally", async () => {
  const config = loadConfig({ STAFF_JWT_SECRET: SECRET, OTP_HMAC_SECRET: SECRET });
  const { requireStaff } = createAuthMiddleware({
    db: { ready: true, query: async () => ({ rows: [] }) },
    config, roster: {}, sessionCache: liveSessionCache(), log: quiet,
  });

  // Authenticated: next() with no argument, req.staff filled in.
  const okReq = fakeReq({ authorization: `Bearer ${staffToken()}` });
  const okCalls = [];
  const noopRes = { set() { return this; }, status() { return this; }, json() { return this; } };
  requireStaff(okReq, noopRes, (...args) => okCalls.push(args));
  await settle();
  assert.deepEqual(okCalls, [[]]);
  assert.equal(okReq.staff.role, "staff");
  assert.deepEqual(okReq.staff.teams, ["Drivers"]);

  // No bearer at all: 401 invalid_token, and next() is never called.
  const answers = [];
  const recordingRes = {
    set() { return this; },
    status(code) { answers.push(code); return this; },
    json(body) { answers.push(body); return this; },
  };
  const nexts = [];
  requireStaff(fakeReq(), recordingRes, (...args) => nexts.push(args));
  await settle();
  assert.deepEqual(answers, [401, { error: "invalid_token" }]);
  assert.deepEqual(nexts, []);

  // A revoked session is a 401 too, not a pass-through.
  const revoked = createAuthMiddleware({
    db: { ready: true, query: async () => ({ rows: [] }) },
    config, roster: {}, sessionCache: liveSessionCache({ live: false }), log: quiet,
  }).requireStaff;
  const revokedAnswers = [];
  revoked(fakeReq({ authorization: `Bearer ${staffToken()}` }), {
    set() { return this; },
    status(code) { revokedAnswers.push(code); return this; },
    json(body) { revokedAnswers.push(body); return this; },
  }, () => revokedAnswers.push("next"));
  await settle();
  assert.deepEqual(revokedAnswers, [401, { error: "session_revoked" }]);
});
