// ---------------------------------------------------------------------------
// Staff access tokens (spec §4.3) — HS256, TTL 900 s
// ---------------------------------------------------------------------------
//
// This module is deliberately dependency-free (node:crypto only): src/appJwt.js
// imports it and index.js imports that statically, so anything pulled in here
// would load on every boot and could take the driver routes down.

import crypto from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export function signJwt(claims, secret) {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  const s = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

/// secrets: [current, previous?] so STAFF_JWT_SECRET can be rotated without logging everyone out.
export function verifyJwt(token, secrets, { nowSec, leewaySec = 30 }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw Object.assign(new Error("malformed"), { code: "invalid_token" });
  const [h, p, s] = parts;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(h, "base64url"));
    claims = JSON.parse(Buffer.from(p, "base64url"));
  } catch {
    throw Object.assign(new Error("malformed"), { code: "invalid_token" });
  }
  // alg:none and alg-confusion tokens die here, before any signature work.
  if (header.alg !== "HS256") throw Object.assign(new Error("alg"), { code: "invalid_token" });
  const given = Buffer.from(s, "base64url");
  const ok = secrets.filter(Boolean).some((sec) => {
    const want = crypto.createHmac("sha256", sec).update(`${h}.${p}`).digest();
    return want.length === given.length && crypto.timingSafeEqual(want, given);
  });
  if (!ok) throw Object.assign(new Error("signature"), { code: "invalid_token" });
  if (claims.iss !== "bagbee-api" || claims.aud !== "bagbee-vakt") {
    throw Object.assign(new Error("iss/aud"), { code: "invalid_token" });
  }
  if (typeof claims.exp !== "number" || claims.exp + leewaySec < nowSec) {
    throw Object.assign(new Error("expired"), { code: "token_expired" });
  }
  return claims;
}
