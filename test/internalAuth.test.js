// Spec §4.3 / §10.1 — requireOwnerOrInternal, the guard on the endpoints that can
// send real pushes to everyone's phone. S1 was a blocker: safeEqual(undefined,
// undefined) returned true, so an unset VAKT_INTERNAL_SECRET opened all of them.
//
// requireStaff is exercised here too: its three 401 codes and the 60 s session
// cache are the rest of the same surface.

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { signJwt } from "../src/auth/jwt.js";
import { createAuthMiddleware, createSessionCache } from "../src/auth/middleware.js";

const JWT_SECRET = "j".repeat(40);
const OTP_SECRET = "o".repeat(40);
const INTERNAL = "i".repeat(40);
const QUIET = { log() {}, warn() {}, error() {} };

const OWNER = {
  airtableId: "recLCxvPg6oAKUfDp",
  name: "Rúnar",
  firstName: "Rúnar",
  teams: ["Office", "Drivers"],
  status: "Active",
  active: true,
  role: "owner",
};
const DRIVER = { ...OWNER, airtableId: "recusZGetZKMa2ItP", name: "Matas", teams: ["Drivers"], role: "staff" };

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const STAFF_ID = "11111111-1111-4111-8111-111111111111";

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (k, v) => { res.headers[String(k).toLowerCase()] = v; return res; };
  return res;
}

/// Drives a middleware to its one outcome: next() or a response.
function run(middleware, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    res.json = (body) => { res.body = body; resolve({ res, nexted: false }); return res; };
    res.end = () => { resolve({ res, nexted: false }); return res; };
    middleware(req, res, (err) => (err ? reject(err) : resolve({ res, nexted: true, req })));
  });
}

const reqWith = (headers = {}) => {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: lower, get: (name) => lower[String(name).toLowerCase()] };
};

/// A db that answers only the one query requireStaff makes.
function fakeDb({ ready = true, session = { revoked_at: null, expires_at: new Date(Date.now() + 86_400_000) }, fail = null } = {}) {
  const calls = [];
  return {
    ready,
    calls,
    async query(text, params) {
      calls.push(params);
      if (fail) throw fail;
      return { rows: session ? [session] : [] };
    },
  };
}

function build({ internalSecret = INTERNAL, people = [OWNER, DRIVER], db = fakeDb(), rosterFails = false } = {}) {
  const config = loadConfig({
    STAFF_JWT_SECRET: JWT_SECRET,
    OTP_HMAC_SECRET: OTP_SECRET,
    ...(internalSecret === null ? {} : { VAKT_INTERNAL_SECRET: internalSecret }),
  });
  const roster = {
    async getRosterEntry(id) {
      if (rosterFails) throw Object.assign(new Error("airtable down"), { code: "airtable_unavailable" });
      return { entry: people.find((p) => p.airtableId === id) ?? null, stale: false };
    },
  };
  const sessionCache = createSessionCache();
  const mw = createAuthMiddleware({ db, config, roster, sessionCache, log: QUIET });
  return { ...mw, config, db, sessionCache };
}

const tokenFor = (person, over = {}) => {
  const nowSec = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      iss: "bagbee-api", aud: "bagbee-vakt",
      sub: STAFF_ID, sid: SESSION_ID, did: "33333333-3333-4333-8333-333333333333",
      at: person.airtableId, team: person.teams, role: person.role,
      iat: nowSec, exp: nowSec + 900, ...over,
    },
    JWT_SECRET,
  );
};
const bearer = (person, over) => reqWith({ authorization: `Bearer ${tokenFor(person, over)}` });

// --- requireOwnerOrInternal, internal path -------------------------------------

test("VAKT_INTERNAL_SECRET unset: no header and an empty header are both 403", async () => {
  const { requireOwnerOrInternal } = build({ internalSecret: null });
  assert.equal(config403(await run(requireOwnerOrInternal, reqWith())), true);
  // The S1 case: safeEqual("", "") used to be true, so this used to be next().
  assert.equal(config403(await run(requireOwnerOrInternal, reqWith({ "x-internal-secret": "" }))), true);
  // …and so did an undefined header compared with an undefined secret.
  assert.equal(config403(await run(requireOwnerOrInternal, reqWith({ "x-internal-secret": "anything" }))), true);
});

function config403(out) {
  return out.nexted === false && out.res.statusCode === 403 && out.res.body?.error === "forbidden";
}

test("a secret shorter than 32 chars is not configured, even with a matching header", async () => {
  const short = "short-secret";
  const { requireOwnerOrInternal, config } = build({ internalSecret: short });
  assert.equal(config.internalConfigured, false);
  assert.equal(config.internalStatus, "off");
  assert.equal(config403(await run(requireOwnerOrInternal, reqWith({ "x-internal-secret": short }))), true);
});

test("configured: the right header passes, a wrong one is 403", async () => {
  const { requireOwnerOrInternal, config } = build();
  assert.equal(config.internalStatus, "configured");

  const wrong = await run(requireOwnerOrInternal, reqWith({ "x-internal-secret": `${INTERNAL}x` }));
  assert.equal(config403(wrong), true);
  const alsoWrong = await run(requireOwnerOrInternal, reqWith({ "x-internal-secret": "i".repeat(40).replace(/i$/, "j") }));
  assert.equal(config403(alsoWrong), true);

  const ok = await run(requireOwnerOrInternal, reqWith({ "x-internal-secret": INTERNAL }));
  assert.equal(ok.nexted, true);
  assert.equal(ok.req.internal, true);
});

test("a wrong internal header falls through to the owner path instead of answering", async () => {
  const { requireOwnerOrInternal } = build();
  const req = bearer(OWNER);
  req.headers["x-internal-secret"] = "stale-script-secret";
  const out = await run(requireOwnerOrInternal, req);
  assert.equal(out.nexted, true, "the owner's own session still lets them in");
  assert.equal(out.req.internal, undefined);
});

test("the internal path makes no database or roster call", async () => {
  const db = fakeDb();
  const { requireOwnerOrInternal } = build({ db, rosterFails: true });
  const ok = await run(requireOwnerOrInternal, reqWith({ "x-internal-secret": INTERNAL }));
  assert.equal(ok.nexted, true);
  assert.equal(db.calls.length, 0);
});

// --- requireOwnerOrInternal, owner path ----------------------------------------

test("an owner whose roster row still has Office passes", async () => {
  const { requireOwnerOrInternal } = build();
  const out = await run(requireOwnerOrInternal, bearer(OWNER));
  assert.equal(out.nexted, true);
  assert.equal(out.req.staff.role, "owner");
  assert.deepEqual(out.req.staff.teams, ["Office", "Drivers"]);
});

test("a token claiming role:owner is 403 once the roster drops Office", async () => {
  // The claim says owner; the roster says Drivers only. The roster wins (S4).
  const demoted = { ...OWNER, teams: ["Drivers"], role: "staff" };
  const { requireOwnerOrInternal } = build({ people: [demoted] });
  assert.equal(config403(await run(requireOwnerOrInternal, bearer(OWNER))), true);
});

test("an Inactive owner, an unknown record id and a plain staff token are all 403", async () => {
  const inactive = { ...OWNER, active: false, status: "Inactive" };
  assert.equal(config403(await run(build({ people: [inactive] }).requireOwnerOrInternal, bearer(OWNER))), true);
  assert.equal(config403(await run(build({ people: [] }).requireOwnerOrInternal, bearer(OWNER))), true);
  assert.equal(config403(await run(build().requireOwnerOrInternal, bearer(DRIVER))), true);
});

test("the owner path fails closed when the roster is unreachable", async () => {
  const { requireOwnerOrInternal } = build({ rosterFails: true });
  assert.equal(config403(await run(requireOwnerOrInternal, bearer(OWNER))), true);
});

test("a revoked session, an expired token and junk are 403, not 401, on internal routes", async () => {
  const revoked = build({ db: fakeDb({ session: { revoked_at: new Date(), expires_at: new Date(Date.now() + 1000) } }) });
  assert.equal(config403(await run(revoked.requireOwnerOrInternal, bearer(OWNER))), true);

  const expired = build();
  const nowSec = Math.floor(Date.now() / 1000);
  assert.equal(config403(await run(expired.requireOwnerOrInternal, bearer(OWNER, { iat: nowSec - 4000, exp: nowSec - 3000 }))), true);
  assert.equal(config403(await run(expired.requireOwnerOrInternal, reqWith({ authorization: "Bearer nonsense" }))), true);
});

test("a database outage on the owner path is 503, not a permission answer", async () => {
  const { requireOwnerOrInternal } = build({ db: fakeDb({ ready: false }) });
  const out = await run(requireOwnerOrInternal, bearer(OWNER));
  assert.equal(out.res.statusCode, 503);
  assert.deepEqual(out.res.body, { error: "db_unavailable" });
  assert.equal(out.res.headers["retry-after"], "30");
});

// --- requireStaff ---------------------------------------------------------------

test("requireStaff sets req.staff from the claims", async () => {
  const { requireStaff } = build();
  const out = await run(requireStaff, bearer(DRIVER));
  assert.equal(out.nexted, true);
  assert.deepEqual(out.req.staff, {
    id: STAFF_ID,
    sessionId: SESSION_ID,
    deviceId: "33333333-3333-4333-8333-333333333333",
    airtableId: DRIVER.airtableId,
    teams: ["Drivers"],
    role: "staff",
  });
});

test("requireStaff answers the three 401 codes the app knows how to handle", async () => {
  const { requireStaff } = build();
  const nowSec = Math.floor(Date.now() / 1000);

  const missing = await run(requireStaff, reqWith());
  assert.equal(missing.res.statusCode, 401);
  assert.deepEqual(missing.res.body, { error: "invalid_token" });

  const expired = await run(requireStaff, bearer(DRIVER, { iat: nowSec - 4000, exp: nowSec - 3000 }));
  assert.deepEqual(expired.res.body, { error: "token_expired" });

  const gone = build({ db: fakeDb({ session: null }) });
  const revoked = await run(gone.requireStaff, bearer(DRIVER));
  assert.equal(revoked.res.statusCode, 401);
  assert.deepEqual(revoked.res.body, { error: "session_revoked" });
});

test("an expired session row is session_revoked, not a pass", async () => {
  const stale = build({ db: fakeDb({ session: { revoked_at: null, expires_at: new Date(Date.now() - 1000) } }) });
  const out = await run(stale.requireStaff, bearer(DRIVER));
  assert.deepEqual(out.res.body, { error: "session_revoked" });
});

test("without the secrets rule satisfied, requireStaff is 503 and never verifies a token", async () => {
  const config = loadConfig({ STAFF_JWT_SECRET: "too-short", OTP_HMAC_SECRET: OTP_SECRET });
  const db = fakeDb();
  const { requireStaff } = createAuthMiddleware({ db, config, roster: {}, sessionCache: createSessionCache(), log: QUIET });
  const out = await run(requireStaff, bearer(DRIVER));
  assert.equal(out.res.statusCode, 503);
  assert.deepEqual(out.res.body, { error: "auth_not_configured" });
  assert.equal(db.calls.length, 0);
});

test("the session state is cached for 60 s and dropped on demand", async () => {
  const db = fakeDb();
  const { requireStaff, sessionCache } = build({ db });

  await run(requireStaff, bearer(DRIVER));
  await run(requireStaff, bearer(DRIVER));
  assert.equal(db.calls.length, 1, "the second request must be served from cache");

  // logout/logout-all delete the entry so this instance stops honouring the token.
  sessionCache.delete(SESSION_ID);
  await run(requireStaff, bearer(DRIVER));
  assert.equal(db.calls.length, 2);
});

test("the cache expires after its TTL", async () => {
  const db = fakeDb();
  let nowMs = Date.UTC(2026, 8, 16, 10, 0, 0);
  const config = loadConfig({ STAFF_JWT_SECRET: JWT_SECRET, OTP_HMAC_SECRET: OTP_SECRET });
  const clock = () => new Date(nowMs);
  const sessionCache = createSessionCache({ clock });
  const { requireStaff } = createAuthMiddleware({ db, config, roster: {}, sessionCache, clock, log: QUIET });

  // The JWT must be valid at the fake clock, so mint it around that instant.
  const nowSec = Math.floor(nowMs / 1000);
  const req = bearer(DRIVER, { iat: nowSec, exp: nowSec + 900 });
  await run(requireStaff, req);
  nowMs += 59_000;
  await run(requireStaff, req);
  assert.equal(db.calls.length, 1);
  nowMs += 2_000;
  await run(requireStaff, req);
  assert.equal(db.calls.length, 2);
});

test("the session lookup is scoped to the token's own staff id", async () => {
  const db = fakeDb();
  const { requireStaff } = build({ db });
  await run(requireStaff, bearer(DRIVER));
  assert.deepEqual(db.calls[0], [SESSION_ID, STAFF_ID]);
});
