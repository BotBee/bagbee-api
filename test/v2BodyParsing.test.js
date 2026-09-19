// Audit finding 2: a malformed or oversized body on a /v2 path was answered by
// Express's default error handler, not by the /v2 JSON error shape (§4.2).
//
// The /v2 parser is mounted in index.js, in front of the /v2 stub, so its
// next(err) walks straight past the stub (a 3-arg middleware) and past the /v2
// router's own error handler. The app then gets an HTML stack-trace page it
// cannot decode, on a code path a client can trigger at will.
//
// These tests drive the real index.js, and the /app/* half of each pair is there
// to prove the fix did not reach across into the driver routes: they must keep
// getting exactly what they got before, HTML page included.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { bootIndex, APP_TOKEN } from "./_indexHarness.js";

const boot = await bootIndex();
after(() => boot.close());

const JSON_HEADERS = { "content-type": "application/json" };
const MALFORMED = '{"shiftRef": "vakt_recAAAAAAAAAAAAAA",';

/// Comfortably over the /v2 32kb limit and comfortably under the /app/* 20mb one,
/// so the same bytes must be refused by one and accepted by the other.
const oversized = () => JSON.stringify({ pad: "p".repeat(40_000) });

test("malformed JSON on /v2 answers 400 in the /v2 error shape", async () => {
  const res = await boot.request("/v2/me/shifts/vakt_recAAAAAAAAAAAAAA/confirm", {
    method: "POST",
    headers: JSON_HEADERS,
    body: MALFORMED,
  });

  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  assert.deepEqual(await res.json(), { error: "invalid_json" });
});

test("an oversized body on /v2 answers 413 in the /v2 error shape", async () => {
  const res = await boot.request("/v2/me/devices", {
    method: "POST",
    headers: JSON_HEADERS,
    body: oversized(),
  });

  assert.equal(res.status, 413);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  assert.deepEqual(await res.json(), { error: "payload_too_large" });
});

test("the /v2 body guard does not answer for a well-formed body", async () => {
  // The Vakt module is stubbed to fail in the harness, so a parsed body reaches
  // the 503 stub — which is the proof that the guard only fires on parse errors.
  const res = await boot.request("/v2/me/shifts/vakt_recAAAAAAAAAAAAAA/confirm", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ answer: "yes" }),
  });

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "vakt_unavailable" });
});

test("malformed JSON on /app/* is unchanged: the default HTML 400", async () => {
  const res = await boot.request("/app/delivery-photo", {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-app-token": APP_TOKEN },
    body: MALFORMED,
  });

  assert.equal(res.status, 400);
  assert.match(
    res.headers.get("content-type") || "",
    /text\/html/,
    "the driver routes must keep Express's own error page, not gain the /v2 JSON shape",
  );
  const body = await res.text();
  assert.doesNotMatch(body, /"error"\s*:/, "no /v2 error body may leak onto /app/*");
});

test("a 40kb body on /app/* is still accepted: the 32kb limit is /v2-only", async () => {
  const res = await boot.request("/app/delivery-photo", {
    method: "POST",
    headers: JSON_HEADERS,
    body: oversized(),
  });

  // Parsed fine by the 20mb parser, so the request reaches requireAppToken and
  // is refused there for the missing token — not at 413 by the /v2 limit.
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
});
