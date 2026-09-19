// Spec §4.9 / B8 — staffFromJwt is what requireAppToken trusts on /app/* when
// APP_ROUTES_ACCEPT_STAFF_JWT=1, with no database behind it. It reads the
// secrets from process.env on every call (the module must not depend on
// config.js), so each case sets the environment it needs and puts it back.

import test from "node:test";
import assert from "node:assert/strict";
import { signJwt } from "../src/auth/jwt.js";
import { staffFromJwt, acceptStaffJwt } from "../src/appJwt.js";

const SECRET = "s".repeat(48);
const PREVIOUS = "p".repeat(48);
const OTHER = "o".repeat(48);

const claimsFor = (over = {}) => {
  const iat = Math.floor(Date.now() / 1000);
  return {
    iss: "bagbee-api",
    aud: "bagbee-vakt",
    sub: "11111111-1111-4111-8111-111111111111",
    sid: "22222222-2222-4222-8222-222222222222",
    did: "33333333-3333-4333-8333-333333333333",
    at: "recLCxvPg6oAKUfDp",
    team: ["Office", "Bílstjórar"],
    role: "owner",
    iat,
    exp: iat + 900,
    ...over,
  };
};

/// An Express-shaped request: only `get()` is used.
const reqWith = (authorization) => ({
  get: (name) => (name.toLowerCase() === "authorization" ? authorization : undefined),
});

function withEnv(vars, fn) {
  const saved = {};
  for (const key of ["STAFF_JWT_SECRET", "STAFF_JWT_SECRET_PREVIOUS"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a valid token yields the identity requireStaff would put on req.staff", () => {
  withEnv({ STAFF_JWT_SECRET: SECRET }, () => {
    const token = signJwt(claimsFor(), SECRET);
    assert.deepEqual(staffFromJwt(reqWith(`Bearer ${token}`)), {
      id: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      deviceId: "33333333-3333-4333-8333-333333333333",
      airtableId: "recLCxvPg6oAKUfDp",
      teams: ["Office", "Bílstjórar"],
      role: "owner",
    });
    assert.equal(acceptStaffJwt(reqWith(`Bearer ${token}`)), true);

    // Anything but "owner" is staff; missing optional claims are null/empty.
    const plain = signJwt(claimsFor({ role: "admin", did: undefined, at: 42, team: "Office" }), SECRET);
    assert.deepEqual(staffFromJwt(reqWith(`Bearer ${plain}`)), {
      id: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      deviceId: null,
      airtableId: null,
      teams: [],
      role: "staff",
    });
  });
});

test("the header is read case-insensitively and from a plain headers object too", () => {
  withEnv({ STAFF_JWT_SECRET: SECRET }, () => {
    const token = signJwt(claimsFor(), SECRET);
    assert.ok(staffFromJwt(reqWith(`bearer ${token}`)));
    assert.ok(staffFromJwt(reqWith(`  Bearer   ${token}  `)));
    assert.ok(staffFromJwt({ headers: { authorization: `Bearer ${token}` } }));
  });
});

test("no or short STAFF_JWT_SECRET means nobody is accepted, however well the token is signed", () => {
  const token = signJwt(claimsFor(), SECRET);
  withEnv({}, () => {
    assert.equal(staffFromJwt(reqWith(`Bearer ${token}`)), null);
    assert.equal(acceptStaffJwt(reqWith(`Bearer ${token}`)), false);
  });
  withEnv({ STAFF_JWT_SECRET: "short" }, () => {
    assert.equal(staffFromJwt(reqWith(`Bearer ${signJwt(claimsFor(), "short")}`)), null);
  });
  // A previous secret alone is not a configuration either.
  withEnv({ STAFF_JWT_SECRET_PREVIOUS: SECRET }, () => {
    assert.equal(staffFromJwt(reqWith(`Bearer ${token}`)), null);
  });
});

test("the previous secret verifies during a rotation; any other secret does not", () => {
  withEnv({ STAFF_JWT_SECRET: SECRET, STAFF_JWT_SECRET_PREVIOUS: PREVIOUS }, () => {
    assert.ok(staffFromJwt(reqWith(`Bearer ${signJwt(claimsFor(), PREVIOUS)}`)));
    assert.ok(staffFromJwt(reqWith(`Bearer ${signJwt(claimsFor(), SECRET)}`)));
    assert.equal(staffFromJwt(reqWith(`Bearer ${signJwt(claimsFor(), OTHER)}`)), null);
  });
  // A short previous secret is ignored, not used.
  withEnv({ STAFF_JWT_SECRET: SECRET, STAFF_JWT_SECRET_PREVIOUS: "short" }, () => {
    assert.equal(staffFromJwt(reqWith(`Bearer ${signJwt(claimsFor(), "short")}`)), null);
  });
});

test("expired, identity-less, mis-addressed and malformed tokens are null, never a throw", () => {
  withEnv({ STAFF_JWT_SECRET: SECRET }, () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = {
      expired: signJwt(claimsFor({ iat: now - 2000, exp: now - 120 }), SECRET),
      "no exp": signJwt(claimsFor({ exp: undefined }), SECRET),
      "no sub": signJwt(claimsFor({ sub: undefined }), SECRET),
      "numeric sub": signJwt(claimsFor({ sub: 7 }), SECRET),
      "no sid": signJwt(claimsFor({ sid: "" }), SECRET),
      "wrong aud": signJwt(claimsFor({ aud: "bagbee-app" }), SECRET),
      "wrong iss": signJwt(claimsFor({ iss: "x" }), SECRET),
      garbage: "a.b.c",
      empty: "",
    };
    for (const [name, token] of Object.entries(cases)) {
      assert.equal(staffFromJwt(reqWith(`Bearer ${token}`)), null, name);
    }
    // Still inside the 30 s leeway: accepted, as on /v2.
    assert.ok(staffFromJwt(reqWith(`Bearer ${signJwt(claimsFor({ exp: now - 20 }), SECRET)}`)));

    // No header, another scheme, a bare token, and requests that are not requests.
    const token = signJwt(claimsFor(), SECRET);
    for (const header of [undefined, "", token, `Basic ${token}`, `Bearer ${token} extra`]) {
      assert.equal(staffFromJwt(reqWith(header)), null, String(header).slice(0, 12));
    }
    for (const notReq of [null, undefined, {}, { get: () => { throw new Error("boom"); } }]) {
      assert.equal(staffFromJwt(notReq), null);
    }
  });
});
