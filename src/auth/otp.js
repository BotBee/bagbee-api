// ---------------------------------------------------------------------------
// One-time login codes (spec §4.4)
// ---------------------------------------------------------------------------
//
// Ported from bagbee-is-active utils/staff/auth.ts:54-67,167-173,258-261, with the
// hardening the critique log calls for (S10/C14 on hashCode, S1 on safeEqual,
// S12 on the log and throttle hashes).
//
// Everything here is pure and secret-keyed: nothing in this file may ever be
// called without OTP_HMAC_SECRET, because a plain SHA-256 of an email is
// reversible over 17 staff addresses and a plain SHA-256 of an IPv4 over 2^32.

import crypto from "node:crypto";

export const CODE_TTL_SECONDS = 600;
export const RESEND_AFTER_SECONDS = 30;
export const MAX_EMAIL_LENGTH = 254;

export const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

/// crypto.randomInt is uniform; padStart keeps the leading zeros a modulo-based
/// generator would quietly drop (a "0" prefix is a perfectly good code).
export const generateLoginCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

/// Always 3 arguments. Called as hashCode(config.OTP_HMAC_SECRET, email, code) at
/// request AND verify. Throws if the secret is missing/short, OR if email/code are
/// not an address and 6 digits. The second check is what catches a 2-argument call
/// hashCode(email, code): there `code` is undefined, even when the email is ≥ 32
/// characters and would pass the length check as a "secret" (C14, reproduced in node).
export const hashCode = (secret, email, code) => {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("otp secret not configured");
  if (typeof email !== "string" || !email.includes("@") || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new Error("hashCode(secret, email, code): bad arguments");
  }
  return crypto.createHmac("sha256", secret).update(`${email}:${code}`).digest("base64url");
};

/// Refuses non-strings and empty strings: safeEqual(undefined, undefined) must be
/// false, or an unset VAKT_INTERNAL_SECRET opens the internal endpoints to anyone (S1).
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/// 12 hex characters, enough to correlate log lines for one address during an
/// incident and useless to anyone who does not hold OTP_HMAC_SECRET (§1.3).
export const logHash = (secret, v) => crypto.createHmac("sha256", secret).update(`log:${v}`).digest("hex").slice(0, 12);

/// The value stored in auth_throttle.subject. A different prefix than logHash, so
/// the two tables cannot be joined on a shared digest.
export const throttleSubject = (secret, v) => crypto.createHmac("sha256", secret).update(`thr:${v}`).digest("hex");

/// Deliberately loose: the strict check is Airtable's, and 400 must not become a
/// second way to ask whether an address is staff (§4.4, S2).
export function isPlausibleEmail(email) {
  return typeof email === "string" && email.length > 0 && email.length <= MAX_EMAIL_LENGTH && email.includes("@");
}
