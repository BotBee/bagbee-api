// Spec §4.3 / §10.1 — the access token is the only thing standing between a
// stranger and a driver's shift list, so every way of forging one gets a case.

import test from "node:test";
import assert from "node:assert/strict";
import { signJwt, verifyJwt } from "../src/auth/jwt.js";

const SECRET = "s".repeat(48);
const OTHER = "o".repeat(48);
const NOW = 1_770_000_000;

const claimsFor = (over = {}) => ({
  iss: "bagbee-api",
  aud: "bagbee-vakt",
  sub: "11111111-1111-4111-8111-111111111111",
  sid: "22222222-2222-4222-8222-222222222222",
  did: "33333333-3333-4333-8333-333333333333",
  at: "recLCxvPg6oAKUfDp",
  team: ["Office", "Drivers"],
  role: "owner",
  iat: NOW,
  exp: NOW + 900,
  ...over,
});

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

test("sign → verify round trip keeps every claim", () => {
  const token = signJwt(claimsFor(), SECRET);
  const out = verifyJwt(token, [SECRET], { nowSec: NOW });
  assert.deepEqual(out, claimsFor());
  // The header is the fixed one in §4.3, not whatever a library would pick.
  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url"));
  assert.deepEqual(header, { alg: "HS256", typ: "JWT" });
});

test("a token signed with another secret is invalid_token", () => {
  const token = signJwt(claimsFor(), OTHER);
  assert.equal(codeOf(() => verifyJwt(token, [SECRET], { nowSec: NOW })), "invalid_token");
});

test("alg:none is rejected before any signature work", () => {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = `${b64u({ alg: "none", typ: "JWT" })}.${b64u(claimsFor())}.`;
  assert.equal(codeOf(() => verifyJwt(token, [SECRET], { nowSec: NOW })), "invalid_token");
});

test("an unsigned token with the right claims is invalid_token", () => {
  const token = signJwt(claimsFor(), SECRET).split(".").slice(0, 2).join(".") + ".";
  assert.equal(codeOf(() => verifyJwt(token, [SECRET], { nowSec: NOW })), "invalid_token");
});

test("expiry has a 30 s leeway and then answers token_expired", () => {
  const token = signJwt(claimsFor(), SECRET);
  assert.ok(verifyJwt(token, [SECRET], { nowSec: NOW + 900 + 29 }));
  assert.equal(codeOf(() => verifyJwt(token, [SECRET], { nowSec: NOW + 900 + 31 })), "token_expired");
});

test("the previous secret still verifies during a rotation", () => {
  const token = signJwt(claimsFor(), OTHER);
  assert.ok(verifyJwt(token, [SECRET, OTHER], { nowSec: NOW }));
  // …and the new one keeps working, which is the point of the two-entry list.
  assert.ok(verifyJwt(signJwt(claimsFor(), SECRET), [SECRET, OTHER], { nowSec: NOW }));
});

test("wrong aud or iss is invalid_token even with a valid signature", () => {
  for (const over of [{ aud: "bagbee-app" }, { iss: "someone-else" }, { aud: undefined }, { iss: undefined }]) {
    const token = signJwt(claimsFor(over), SECRET);
    assert.equal(codeOf(() => verifyJwt(token, [SECRET], { nowSec: NOW })), "invalid_token");
  }
});

test("malformed input never throws anything but invalid_token", () => {
  for (const junk of [null, undefined, "", "a.b", "a.b.c.d", "not-base64.$$.??", "...."]) {
    assert.equal(codeOf(() => verifyJwt(junk, [SECRET], { nowSec: NOW })), "invalid_token", String(junk));
  }
});

test("a missing exp is treated as expired, not as forever", () => {
  const token = signJwt(claimsFor({ exp: undefined }), SECRET);
  assert.equal(codeOf(() => verifyJwt(token, [SECRET], { nowSec: NOW })), "token_expired");
});
