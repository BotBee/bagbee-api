// Spec §4.4 / §10.1 — the OTP helpers. Two of these cases exist because the
// mistakes were reproduced in node first: hashCode(email, code) silently
// succeeded (S10/C14) and safeEqual(undefined, undefined) returned true (S1).

import test from "node:test";
import assert from "node:assert/strict";
import {
  generateLoginCode,
  hashCode,
  isPlausibleEmail,
  logHash,
  normalizeEmail,
  safeEqual,
  throttleSubject,
} from "../src/auth/otp.js";

const SECRET = "k".repeat(32);
const OTHER = "j".repeat(32);
const EMAIL = "jon@example.com";
/// 41 characters: long enough to pass a "secret must be ≥ 32 chars" check, which
/// is exactly why the old 2-argument call slipped through (C14).
const LONG_EMAIL = "jon.jonsson.longname.here@example-mail.is";

test("generateLoginCode is always 6 digits, leading zeros included", () => {
  let sawLeadingZero = false;
  for (let i = 0; i < 10_000; i += 1) {
    const code = generateLoginCode();
    assert.match(code, /^\d{6}$/);
    if (code[0] === "0") sawLeadingZero = true;
  }
  // ~10% of 10k draws; a generator that dropped them would fail here.
  assert.ok(sawLeadingZero, "expected at least one code starting with 0");
});

test("hashCode is stable and secret-dependent", () => {
  const a = hashCode(SECRET, EMAIL, "123456");
  assert.equal(a, hashCode(SECRET, EMAIL, "123456"));
  assert.notEqual(a, hashCode(OTHER, EMAIL, "123456"));
  assert.notEqual(a, hashCode(SECRET, "nina@example.com", "123456"));
  assert.notEqual(a, hashCode(SECRET, EMAIL, "123457"));
});

test("hashCode called with 2 arguments throws — short email and 41-char email alike", () => {
  assert.throws(() => hashCode(EMAIL, "123456"), /otp secret not configured/);
  // The long address passes the length check as a "secret", so only the argument
  // shape check catches it. This is the C14 case.
  assert.throws(() => hashCode(LONG_EMAIL, "123456"), /bad arguments/);
});

test("hashCode refuses a bad secret, a bad email or a non-6-digit code", () => {
  assert.throws(() => hashCode(undefined, EMAIL, "123456"), /not configured/);
  assert.throws(() => hashCode("short", EMAIL, "123456"), /not configured/);
  assert.throws(() => hashCode(SECRET, "no-at-sign", "123456"), /bad arguments/);
  assert.throws(() => hashCode(SECRET, EMAIL, "12345"), /bad arguments/);
  assert.throws(() => hashCode(SECRET, EMAIL, "1234567"), /bad arguments/);
  assert.throws(() => hashCode(SECRET, EMAIL, "12a456"), /bad arguments/);
  assert.throws(() => hashCode(SECRET, EMAIL, 123456), /bad arguments/);
});

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail(" Jon@X.IS "), "jon@x.is");
  assert.equal(normalizeEmail(undefined), "");
  assert.equal(normalizeEmail(null), "");
});

test("isPlausibleEmail is loose but bounded", () => {
  assert.ok(isPlausibleEmail("a@b"));
  assert.ok(!isPlausibleEmail(""));
  assert.ok(!isPlausibleEmail("no-at-sign"));
  assert.ok(!isPlausibleEmail(`${"a".repeat(250)}@b.is`));
});

test("safeEqual is false for undefined, empty and differing lengths", () => {
  assert.equal(safeEqual(undefined, undefined), false);
  assert.equal(safeEqual("", ""), false);
  assert.equal(safeEqual(null, null), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abc"), true);
});

test("logHash and throttleSubject change with the secret and differ from each other", () => {
  assert.equal(logHash(SECRET, EMAIL), logHash(SECRET, EMAIL));
  assert.notEqual(logHash(SECRET, EMAIL), logHash(OTHER, EMAIL));
  assert.notEqual(throttleSubject(SECRET, EMAIL), throttleSubject(OTHER, EMAIL));
  // Different prefixes, so the log lines and auth_throttle cannot be joined.
  assert.notEqual(logHash(SECRET, EMAIL), throttleSubject(SECRET, EMAIL).slice(0, 12));
  assert.equal(logHash(SECRET, EMAIL).length, 12);
  assert.match(logHash(SECRET, EMAIL), /^[0-9a-f]{12}$/);
});
