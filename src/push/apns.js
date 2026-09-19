// ---------------------------------------------------------------------------
// APNs HTTP/2 client (spec §7)
// ---------------------------------------------------------------------------
//
// Two rules shape this file:
//   1. A bad key must never crash the process. createApnsClient() throws while
//      parsing, and src/vakt.js catches that once and reports apns:"invalid"
//      through /v2/health (§4.4) — every send then becomes a `skipped` push_log
//      row, never an exception on a driver's request.
//   2. The provider token is ES256 over the RAW r||s signature. Node's default
//      DER encoding is accepted by crypto.verify() and rejected by Apple with
//      403 InvalidProviderToken, which is a very expensive typo to find in prod.

import http2 from "node:http2";
import crypto from "node:crypto";

export const HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

const b64u = (v) => Buffer.from(v).toString("base64url");

/// `http2impl` exists only so test/apns.test.js can assert the request headers
/// (collapse id, push type, priority) and the 410 body without touching Apple.
/// Production passes nothing and gets node:http2 (§4.1: dependencies injected).
export function createApnsClient({
  keyP8,
  keyId,
  teamId,
  topic,
  nowMs = () => Date.now(),
  log = console,
  http2impl = http2,
}) {
  const pem = keyP8.includes("BEGIN PRIVATE KEY")
    ? keyP8.replace(/\\n/g, "\n")
    : Buffer.from(keyP8, "base64").toString("utf8");
  const key = crypto.createPrivateKey(pem);
  let cached = null;                      // { jwt, iat }
  const sessions = new Map();             // env -> ClientHttp2Session

  /// ES256 provider token, reused ~50 min. APNs rejects tokens older than 60 min
  /// (403 ExpiredProviderToken) and throttles refreshing more often than every 20 min (429).
  function providerToken({ force = false } = {}) {
    const iat = Math.floor(nowMs() / 1000);
    if (!force && cached && iat - cached.iat < 50 * 60) return cached.jwt;
    if (force && cached && iat - cached.iat < 20 * 60) log.error("[apns] forced token refresh within 20 min");
    const h = b64u(JSON.stringify({ alg: "ES256", kid: keyId }));
    const c = b64u(JSON.stringify({ iss: teamId, iat }));
    // ieee-p1363 = raw r||s. Node's default DER signature is rejected with 403 InvalidProviderToken.
    const sig = crypto.sign("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" });
    cached = { jwt: `${h}.${c}.${b64u(sig)}`, iat };
    return cached.jwt;
  }

  function session(env) {
    const existing = sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = http2impl.connect(HOSTS[env]);
    const drop = () => { if (sessions.get(env) === s) sessions.delete(env); };
    s.on("error", (e) => { log.error("[apns] session error", env, e.code || e.message); drop(); });
    s.on("goaway", drop);
    s.on("close", drop);
    s.unref();
    sessions.set(env, s);
    return s;
  }

  function sendOnce({ deviceToken, environment, payload, collapseId, expiration = 0, priority = 10, pushType = "alert", apnsId, force }) {
    return new Promise((resolve) => {
      let req;
      try {
        req = session(environment).request({
          ":method": "POST",
          ":path": `/3/device/${deviceToken}`,
          authorization: `bearer ${providerToken({ force })}`,
          "apns-topic": topic,
          "apns-push-type": pushType,
          "apns-priority": String(priority),
          "apns-expiration": String(expiration),
          "apns-id": apnsId,
          ...(collapseId ? { "apns-collapse-id": collapseId } : {}),
          "content-type": "application/json",
        });
      } catch (e) { return resolve({ status: 0, reason: `NetworkError:${e.code || e.message}` }); }
      let status = 0, body = "";
      req.setTimeout(10_000, () => { req.close(http2.constants.NGHTTP2_CANCEL); resolve({ status: 0, reason: "Timeout" }); });
      req.on("response", (h) => { status = h[":status"]; });
      req.setEncoding("utf8");
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        let j = {}; try { j = body ? JSON.parse(body) : {}; } catch {}
        resolve({ status, reason: j.reason || null, timestamp: j.timestamp || null });
      });
      req.on("error", (e) => resolve({ status: 0, reason: `NetworkError:${e.code || e.message}` }));
      req.end(JSON.stringify(payload));
    });
  }

  /// One apns-id across every attempt: Apple deduplicates on it, so a retry after
  /// a lost response cannot buzz a phone twice.
  async function send(msg) {
    const apnsId = crypto.randomUUID();
    let r = await sendOnce({ ...msg, apnsId });
    if (r.status === 403 && r.reason === "ExpiredProviderToken") r = await sendOnce({ ...msg, apnsId, force: true });
    for (const delay of [1000, 5000]) {
      if (!(r.status === 0 || r.status === 429 || r.status >= 500)) break;
      await new Promise((ok) => setTimeout(ok, delay));
      r = await sendOnce({ ...msg, apnsId });
    }
    return { ...r, apnsId };
  }

  function close() { for (const s of sessions.values()) s.close(); sessions.clear(); }
  return { send, close, providerToken };
}

export default createApnsClient;
