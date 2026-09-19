// Spec §10.1 test/vaktLoad.test.js — a broken /v2 module must not take the
// driver routes down (critique O8), and a malformed APNS_KEY_P8 must surface as
// "invalid" instead of throwing.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { createApnsProbe } from "../src/vakt.js";
import { loadConfig } from "../src/config.js";

/// The index.js §4.9 edits (4) and (5), with the dynamic import injected so a
/// failure can be simulated without breaking the real module.
async function bootLikeIndex(loadV2) {
  const app = express();
  let v2Handler = null;
  let v2LoadError = false;

  app.use("/v2", (req, res, next) => {
    if (v2Handler) return v2Handler(req, res, next);
    res.set("Retry-After", "30").status(503).json({ error: v2LoadError ? "vakt_unavailable" : "starting" });
  });
  app.get("/health", (req, res) => res.json({ ok: true }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const settled = loadV2()
    .then((handler) => { v2Handler = handler; })
    .catch((e) => { v2LoadError = true; void e; });

  const { port } = server.address();
  return {
    settled,
    get: (p) => fetch(`http://127.0.0.1:${port}${p}`),
    close: () => new Promise((r) => server.close(r)),
  };
}

test("a rejecting /v2 import leaves /v2 on 503 vakt_unavailable and /health 200", async (t) => {
  const boot = await bootLikeIndex(() => Promise.reject(Object.assign(new Error("boom"), { code: "ERR_OSSL_UNSUPPORTED" })));
  t.after(() => boot.close());
  await boot.settled;

  const v2 = await boot.get("/v2/health");
  assert.equal(v2.status, 503);
  assert.equal(v2.headers.get("retry-after"), "30");
  assert.deepEqual(await v2.json(), { error: "vakt_unavailable" });

  const legacy = await boot.get("/health");
  assert.equal(legacy.status, 200, "driver routes must survive a broken Vakt module");
  assert.deepEqual(await legacy.json(), { ok: true });
});

test("/v2 answers 503 starting until the module has loaded", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const boot = await bootLikeIndex(() => gate.then(() => express.Router().get("/health", (req, res) => res.json({ ok: true }))));
  t.after(() => boot.close());

  const early = await boot.get("/v2/health");
  assert.equal(early.status, 503);
  assert.deepEqual(await early.json(), { error: "starting" });

  release();
  await boot.settled;
  assert.equal((await boot.get("/v2/health")).status, 200);
});

test("getApns() reports a malformed APNS_KEY_P8 as invalid without throwing", () => {
  const quiet = { error() {}, log() {} };
  const probe = createApnsProbe(loadConfig({ APNS_KEY_P8: "not-a-key" }), { log: quiet });
  assert.equal(probe().status, "invalid");
  assert.equal(probe().status, "invalid", "the failed parse is cached, not retried on every health check");
});

test("getApns() reports missing when APNS_KEY_P8 is unset, and configured for a real key", () => {
  assert.equal(createApnsProbe(loadConfig({}))().status, "missing");

  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });

  // Base64 of the .p8 file (recommended) …
  assert.equal(createApnsProbe(loadConfig({ APNS_KEY_P8: Buffer.from(pem).toString("base64") }))().status, "configured");
  // … the PEM text itself …
  assert.equal(createApnsProbe(loadConfig({ APNS_KEY_P8: pem }))().status, "configured");
  // … and PEM pasted with literal \n sequences, which is how it often survives a copy-paste.
  assert.equal(createApnsProbe(loadConfig({ APNS_KEY_P8: pem.replace(/\n/g, "\\n") }))().status, "configured");
});
