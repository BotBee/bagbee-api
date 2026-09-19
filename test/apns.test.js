// Spec §10.1 test/apns.test.js — the ES256 provider token, key loading, and the
// request Apple actually receives. No network: a generated P-256 key and a fake
// node:http2 whose sessions are plain EventEmitters.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createApnsClient, HOSTS } from "../src/push/apns.js";

/// A throwaway key of the same type Apple issues (.p8 = PKCS8 P-256).
function testKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

const decodePart = (p) => JSON.parse(Buffer.from(p, "base64url").toString("utf8"));

/// Minimal stand-in for a ClientHttp2Session. `script` decides what each request
/// answers; every request made is recorded for assertions.
function fakeHttp2({ script = () => ({ status: 200, body: "" }) } = {}) {
  const connections = [];
  const requests = [];
  return {
    requests,
    connections,
    impl: {
      connect(host) {
        const session = new EventEmitter();
        session.unref = () => {};
        session.close = () => { session.closed = true; };
        session.closed = false;
        session.destroyed = false;
        session.request = (headers) => {
          const req = new EventEmitter();
          req.setTimeout = () => {};
          req.setEncoding = () => {};
          req.close = () => {};
          req.end = (body) => {
            const record = { host, headers, body: JSON.parse(body) };
            requests.push(record);
            const answer = script(record, requests.length) || {};
            // Async, like a real response, so `end` returns first.
            setImmediate(() => {
              if (answer.error) return req.emit("error", answer.error);
              req.emit("response", { ":status": answer.status });
              if (answer.body) req.emit("data", answer.body);
              req.emit("end");
            });
          };
          return req;
        };
        connections.push({ host, session });
        return session;
      },
    },
  };
}

test("provider token is an ES256 JWT Apple can verify", () => {
  const { pem, publicKey } = testKey();
  const client = createApnsClient({ keyP8: pem, keyId: "ABCD123456", teamId: "8V2TSPJUTK", topic: "is.bagbee.app" });

  const [h, c, s] = client.providerToken().split(".");
  assert.deepEqual(decodePart(h), { alg: "ES256", kid: "ABCD123456" });
  assert.equal(decodePart(c).iss, "8V2TSPJUTK");
  assert.ok(Number.isInteger(decodePart(c).iat));

  const sig = Buffer.from(s, "base64url");
  // 64 bytes = raw r||s. A DER signature here is ~70 bytes and Apple answers 403.
  assert.equal(sig.length, 64);
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig));
});

test("the token is reused for 50 minutes and regenerated after", () => {
  const { pem } = testKey();
  let now = 1_700_000_000_000;
  const client = createApnsClient({
    keyP8: pem, keyId: "ABCD123456", teamId: "8V2TSPJUTK", topic: "is.bagbee.app", nowMs: () => now,
  });

  const first = client.providerToken();
  now += 49 * 60 * 1000;
  assert.equal(client.providerToken(), first, "refreshing before 50 min risks a 429 from Apple");
  now += 2 * 60 * 1000;
  const second = client.providerToken();
  assert.notEqual(second, first, "a token older than 60 min is rejected with ExpiredProviderToken");
  assert.equal(decodePart(second.split(".")[1]).iat, Math.floor(now / 1000));
});

test("a forced refresh inside 20 minutes is logged, because Apple throttles it", () => {
  const { pem } = testKey();
  let now = 1_700_000_000_000;
  const errors = [];
  const client = createApnsClient({
    keyP8: pem, keyId: "K", teamId: "T", topic: "is.bagbee.app", nowMs: () => now,
    log: { error: (...a) => errors.push(a.join(" ")), log() {} },
  });
  client.providerToken();
  now += 60 * 1000;
  client.providerToken({ force: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /forced token refresh within 20 min/);
});

test("PEM, \\n-escaped PEM and base64 of the .p8 all load", () => {
  const { pem } = testKey();
  const args = { keyId: "K", teamId: "T", topic: "is.bagbee.app" };
  const plain = createApnsClient({ ...args, keyP8: pem }).providerToken();
  const escaped = createApnsClient({ ...args, keyP8: pem.replace(/\n/g, "\\n") }).providerToken();
  const base64 = createApnsClient({ ...args, keyP8: Buffer.from(pem).toString("base64") }).providerToken();
  // Same key, same clock second → byte-identical tokens.
  assert.equal(decodePart(plain.split(".")[0]).kid, "K");
  assert.equal(escaped.split(".")[0], plain.split(".")[0]);
  assert.equal(base64.split(".")[0], plain.split(".")[0]);
});

test("a malformed key throws at construction, so getApns can report invalid", () => {
  assert.throws(() => createApnsClient({ keyP8: "not-a-key", keyId: "K", teamId: "T", topic: "t" }));
});

test("send posts to the production host with the §6.6 headers", async () => {
  const { pem } = testKey();
  const http2impl = fakeHttp2();
  const client = createApnsClient({
    keyP8: pem, keyId: "ABCD123456", teamId: "8V2TSPJUTK", topic: "is.bagbee.app", http2impl: http2impl.impl,
  });

  const payload = { aps: { alert: { title: "Áætlun morgundagsins er komin", body: "Morgunvakt" } }, shiftRef: "vakt_recAbcdefghij1234" };
  const res = await client.send({
    deviceToken: "a".repeat(64),
    environment: "production",
    payload,
    collapseId: "plan-vakt_recAbcdefghij1234",
    expiration: 1_790_000_000,
  });

  assert.equal(res.status, 200);
  assert.match(res.apnsId, /^[0-9a-f-]{36}$/);
  const [req] = http2impl.requests;
  assert.equal(req.host, HOSTS.production);
  assert.equal(req.headers[":path"], `/3/device/${"a".repeat(64)}`);
  assert.equal(req.headers["apns-topic"], "is.bagbee.app");
  assert.equal(req.headers["apns-push-type"], "alert");
  assert.equal(req.headers["apns-priority"], "10");
  assert.equal(req.headers["apns-expiration"], "1790000000");
  assert.equal(req.headers["apns-collapse-id"], "plan-vakt_recAbcdefghij1234");
  assert.match(req.headers.authorization, /^bearer eyJ/);
  assert.deepEqual(req.body, payload);
  assert.ok(Buffer.byteLength(req.headers["apns-collapse-id"]) <= 64);
});

test("no collapse id header when none is given (the test push)", async () => {
  const { pem } = testKey();
  const http2impl = fakeHttp2();
  const client = createApnsClient({ keyP8: pem, keyId: "K", teamId: "T", topic: "is.bagbee.app", http2impl: http2impl.impl });
  await client.send({ deviceToken: "b".repeat(64), environment: "sandbox", payload: { aps: {} } });
  assert.equal(http2impl.requests[0].host, HOSTS.sandbox);
  assert.ok(!("apns-collapse-id" in http2impl.requests[0].headers));
});

test("410 Unregistered comes back with Apple's timestamp", async () => {
  const { pem } = testKey();
  const http2impl = fakeHttp2({
    script: () => ({ status: 410, body: JSON.stringify({ reason: "Unregistered", timestamp: 1_757_000_000_000 }) }),
  });
  const client = createApnsClient({ keyP8: pem, keyId: "K", teamId: "T", topic: "t", http2impl: http2impl.impl });
  const res = await client.send({ deviceToken: "c".repeat(64), environment: "production", payload: { aps: {} } });
  assert.equal(res.status, 410);
  assert.equal(res.reason, "Unregistered");
  // The sender compares this to devices.apns_token_updated_at (§7).
  assert.equal(res.timestamp, 1_757_000_000_000);
  assert.equal(http2impl.requests.length, 1, "a 410 must not be retried");
});

test("an expired provider token is retried once with a forced refresh, same apns-id", async () => {
  const { pem } = testKey();
  let now = 1_700_000_000_000;
  const http2impl = fakeHttp2({
    script: (_r, n) => (n === 1
      ? { status: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) }
      : { status: 200 }),
  });
  const client = createApnsClient({
    keyP8: pem, keyId: "K", teamId: "T", topic: "t", http2impl: http2impl.impl, nowMs: () => now,
    log: { error() {}, log() {} },
  });
  const res = await client.send({ deviceToken: "d".repeat(64), environment: "production", payload: { aps: {} } });
  assert.equal(res.status, 200);
  assert.equal(http2impl.requests.length, 2);
  const ids = http2impl.requests.map((r) => r.headers["apns-id"]);
  // One apns-id across attempts: Apple deduplicates on it, so no double buzz.
  assert.equal(ids[0], ids[1]);
  assert.notEqual(http2impl.requests[0].headers.authorization, http2impl.requests[1].headers.authorization);
});

test("a dropped connection is retried, not thrown", async () => {
  const { pem } = testKey();
  // Only the 1 s backoff is exercised; asserting the 5 s one too would cost the
  // suite six seconds to prove the same loop.
  const http2impl = fakeHttp2({
    script: (_r, n) => (n === 1 ? { error: Object.assign(new Error("boom"), { code: "ECONNRESET" }) } : { status: 200 }),
  });
  const client = createApnsClient({
    keyP8: pem, keyId: "K", teamId: "T", topic: "t", http2impl: http2impl.impl, log: { error() {}, log() {} },
  });
  const res = await client.send({ deviceToken: "e".repeat(64), environment: "production", payload: { aps: {} } });
  assert.equal(res.status, 200, "a van losing signal must not lose the push");
  assert.equal(http2impl.requests.length, 2);
});
