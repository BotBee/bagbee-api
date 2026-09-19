// Regression guard for the existing driver surface (spec §1.3, §2.1).
//
// Slice 1 is only allowed to ADD /v2. Everything the vans already use —
// /health, the x-app-token check in front of every /app/* route, and the
// Airtable pass-through behind it — has to keep answering byte-identically,
// including when the new /v2 module fails to load at boot.
//
// These tests drive the real index.js (test/_indexHarness.js), so they break if
// index.js changes, which a hand-written copy of its wiring never would.
//
// Build step B8 adds the §10.1 requireAppToken matrix here, against the same
// real file. requireAppToken reads APP_ROUTES_ACCEPT_STAFF_JWT and APP_TOKEN
// once at import, so the flag-OFF half runs on the in-process boot (pinned off,
// with STAFF_JWT_SECRET configured) and the flag-ON and APP_TOKEN-unset halves
// each run on a second index.js in a child process (bootIndexChild).

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { signJwt } from "../src/auth/jwt.js";
import { bootIndex, bootIndexChild, airtable, APP_TOKEN, STAFF_JWT_SECRET } from "./_indexHarness.js";

const PREVIOUS_SECRET = "harness-previous-staff-jwt-secret-0123456789";

/// A token exactly as identity.signAccessToken mints it (§4.3): 15 min from now
/// unless `over` says otherwise, signed with the current secret unless told.
function staffJwt(over = {}, secret = STAFF_JWT_SECRET) {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      iss: "bagbee-api",
      aud: "bagbee-vakt",
      sub: "11111111-1111-4111-8111-111111111111",
      sid: "22222222-2222-4222-8222-222222222222",
      did: "33333333-3333-4333-8333-333333333333",
      at: "recLCxvPg6oAKUfDp",
      team: ["Bílstjórar"],
      role: "staff",
      iat,
      exp: iat + 900,
      ...over,
    },
    secret,
  );
}
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const withHeaders = (init, headers) => ({ ...init, headers: { ...(init.headers || {}), ...headers } });

const [boot, jwtBoot] = await Promise.all([
  bootIndex(),
  bootIndexChild({ APP_ROUTES_ACCEPT_STAFF_JWT: "1", STAFF_JWT_SECRET_PREVIOUS: PREVIOUS_SECRET }),
]);
after(() => Promise.all([boot.close(), jwtBoot.close()]));

test("GET /health answers exactly {ok:true}", async () => {
  const res = await boot.request("/health");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  assert.deepEqual(await res.json(), { ok: true });
});

test("/app/* is 401 Unauthorized without an x-app-token", async () => {
  airtable.reset();

  for (const path of [
    "/app/orders/today", "/app/route", "/app/orders/upcoming", "/app/orders/day?date=2026-09-16",
    "/app/orders/search?q=x", "/app/orders/recAAAAAAAAAAAAAA", "/app/order-colors",
    "/app/tags/find?tag=1", "/app/orders/recAAAAAAAAAAAAAA/tags", "/app/tags/1/label",
  ]) {
    const res = await boot.request(path);
    assert.equal(res.status, 401, `${path} must stay behind requireAppToken`);
    assert.deepEqual(await res.json(), { error: "Unauthorized" }, path);
  }

  // POST routes sit behind the same guard, and the guard runs before any handler.
  for (const [path, body] of [
    ["/app/delivery-photo", { recordId: "recAAAAAAAAAAAAAA", photoBase64: "" }],
    ["/app/tags", { tagNumber: "1" }],
    ["/app/fasttrack", {}],
    ["/send-activation-request", {}],
  ]) {
    const post = await boot.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(post.status, 401, `${path} must stay behind requireAppToken`);
    assert.deepEqual(await post.json(), { error: "Unauthorized" }, path);
  }

  assert.deepEqual(airtable.calls, [], "an unauthorized request must never reach Airtable");
});

test("the /v2/internal endpoints never exist outside the Vakt module: with it unloaded they are the 503 stub, not a leak", async () => {
  // B6 mounts /v2/internal/* inside src/vakt.js behind requireOwnerOrInternal.
  // Under the harness that module fails to load, so every one of these paths
  // must be the same stub answer as /v2/health — never an Express 404 page, and
  // never a handler running without its guard.
  for (const [method, path] of [
    ["POST", "/v2/internal/push/plan-published"],
    ["POST", "/v2/internal/jobs/plan-detect"],
    ["POST", "/v2/internal/jobs/counter-tomorrow"],
    ["GET", "/v2/internal/plan-status?date=2026-09-17"],
    ["GET", "/v2/internal/confirmations"],
  ]) {
    const res = await boot.request(path, {
      method,
      headers: { "content-type": "application/json", "x-internal-secret": "whatever", "x-app-token": APP_TOKEN },
      body: method === "POST" ? "{}" : undefined,
    });
    assert.equal(res.status, 503, `${method} ${path}`);
    assert.equal(res.headers.get("retry-after"), "30");
    assert.deepEqual(await res.json(), { error: "vakt_unavailable" });
  }
  assert.deepEqual(airtable.calls, [], "the stub must not touch Airtable");
});

test("/app/* is 401 for a wrong token and never leaks the right one", async () => {
  const res = await boot.request("/app/orders/today", { headers: { "x-app-token": "nope" } });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });

  // Same length as the real token, so this exercises the timingSafeEqual compare
  // rather than the length short-circuit in front of it.
  const sameLength = await boot.request("/app/orders/today", {
    headers: { "x-app-token": "x".repeat(APP_TOKEN.length) },
  });
  assert.equal(sameLength.status, 401);
});

test("/app/orders/today with the token returns Airtable's payload unchanged", async () => {
  airtable.reset();
  const payload = { records: [{ id: "recTESTTESTTEST1", fields: { "Pöntunarnúmer (fx)": "i0lYC" } }] };
  airtable.reply = () => ({ status: 200, body: JSON.stringify(payload) });

  const res = await boot.request("/app/orders/today", { headers: { "x-app-token": APP_TOKEN } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), payload);

  assert.equal(airtable.calls.length, 1);
  const call = airtable.calls[0];
  assert.match(call.url, /^https:\/\/api\.airtable\.com\/v0\/appHB2bNYPAhfUcLv\/tblWLlNxZvtkFSFXs\?/);
  assert.match(call.url, /filterByFormula=/);
  assert.equal(call.options.headers.Authorization, "Bearer harness-airtable-token");
});

test("an Airtable failure still maps to the existing error shape", async () => {
  airtable.reset();
  airtable.reply = () => ({ status: 422, body: '{"error":"INVALID_FILTER_BY_FORMULA"}' });

  const res = await boot.request("/app/orders/today", { headers: { "x-app-token": APP_TOKEN } });
  assert.equal(res.status, 400, "4xx from Airtable is reported as 400, 5xx as 502");
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });
});

test("a /v2 module that fails to import leaves /app/* and /health working", async () => {
  // The harness makes import("./src/vakt.js") throw, which is exactly what a bad
  // APNS_KEY_P8 or a syntax error in the new module would do on Railway (§2.1).
  const v2 = await boot.request("/v2/health");
  assert.equal(v2.status, 503);
  assert.equal(v2.headers.get("retry-after"), "30");
  assert.deepEqual(await v2.json(), { error: "vakt_unavailable" });

  const health = await boot.request("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  airtable.reset();
  const payload = { records: [] };
  airtable.reply = () => ({ status: 200, body: JSON.stringify(payload) });
  const app = await boot.request("/app/orders/today", { headers: { "x-app-token": APP_TOKEN } });
  assert.equal(app.status, 200, "a broken Vakt module must not touch the driver routes");
  assert.deepEqual(await app.json(), payload);

  const unauth = await boot.request("/app/orders/today");
  assert.equal(unauth.status, 401);
});

test("an unknown path is still Express's own 404, not a /v2 answer", async () => {
  const res = await boot.request("/app/does-not-exist");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
});

// ---------------------------------------------------------------------------
// B8 — requireAppToken matrix (§4.9 edit (3), §10.1). Flag OFF: the in-process
// boot. STAFF_JWT_SECRET IS configured there, so what refuses the JWT below is
// the flag and nothing else.
// ---------------------------------------------------------------------------

test("flag off: a valid staff JWT alone is 401 on every /app/* path, GET and POST", async () => {
  airtable.reset();
  const token = staffJwt();

  for (const path of ["/app/orders/today", "/app/route", "/app/orders/upcoming", "/app/tags/1/label", "/app/order-colors"]) {
    const res = await boot.request(path, { headers: bearer(token) });
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { error: "Unauthorized" }, path);
  }
  for (const [path, body] of [["/app/tags", { tagNumber: "1" }], ["/app/fasttrack", {}], ["/send-activation-request", {}]]) {
    const res = await boot.request(path, withHeaders(json(body), bearer(token)));
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { error: "Unauthorized" }, path);
  }

  // A wrong shared token is not rescued by a valid JWT while the flag is off.
  const both = await boot.request("/app/orders/today", { headers: { ...bearer(token), "x-app-token": "nope" } });
  assert.equal(both.status, 401);
  assert.deepEqual(await both.json(), { error: "Unauthorized" });

  assert.deepEqual(airtable.calls, [], "a refused JWT must never reach Airtable");
});

test("flag off: the shared token still wins whatever Authorization carries", async () => {
  airtable.reset();
  const payload = { records: [{ id: "recTESTTESTTEST2", fields: {} }] };
  airtable.reply = () => ({ status: 200, body: JSON.stringify(payload) });

  // iOS keeps sending x-app-token after login and ADDS the Bearer (§2.1), so a
  // valid JWT beside the token is the common production request.
  for (const authorization of [`Bearer ${staffJwt()}`, "Bearer garbage", "Basic Zm9vOmJhcg=="]) {
    const res = await boot.request("/app/orders/today", { headers: { "x-app-token": APP_TOKEN, authorization } });
    assert.equal(res.status, 200, authorization);
    assert.deepEqual(await res.json(), payload, authorization);
  }
  assert.equal(airtable.calls.length, 3);
});

// ---------------------------------------------------------------------------
// Flag ON: the child boot (APP_ROUTES_ACCEPT_STAFF_JWT=1, current + previous
// secret). Its Airtable stub answers {records:[]} to everything.
// ---------------------------------------------------------------------------

test("flag on: a valid staff JWT alone is 200 and gets exactly the shared token's answer", async () => {
  const token = staffJwt();
  const cases = [
    ["/app/orders/today", {}],
    ["/app/orders/upcoming", {}],
    ["/app/route?date=2026-09-18", {}],
    ["/app/order-colors", {}],
    ["/app/fasttrack", json({})],
    ["/send-activation-request", json({})],
  ];
  for (const [path, init] of cases) {
    const viaToken = await jwtBoot.request(path, withHeaders(init, { "x-app-token": APP_TOKEN }));
    const viaJwt = await jwtBoot.request(path, withHeaders(init, bearer(token)));
    assert.notEqual(viaJwt.status, 401, `${path}: the JWT must pass the guard`);
    assert.equal(viaJwt.status, viaToken.status, path);
    assert.deepEqual(await viaJwt.json(), await viaToken.json(), `${path}: identical handler answer`);
  }
  const today = await jwtBoot.request("/app/orders/today", { headers: bearer(token) });
  assert.equal(today.status, 200);
  assert.deepEqual(await today.json(), { records: [] });
});

test("flag on: an expired, forged or identity-less JWT is still 401 Unauthorized", async () => {
  const now = Math.floor(Date.now() / 1000);
  const bad = {
    "expired (past the 30 s leeway)": staffJwt({ iat: now - 2000, exp: now - 120 }),
    "another secret": staffJwt({}, "x".repeat(48)),
    "wrong aud": staffJwt({ aud: "bagbee-app" }),
    "wrong iss": staffJwt({ iss: "someone-else" }),
    "no sub": staffJwt({ sub: undefined }),
    "no sid": staffJwt({ sid: undefined }),
    "alg none": `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${staffJwt().split(".")[1]}.`,
    garbage: "not.a.jwt",
  };
  for (const [name, token] of Object.entries(bad)) {
    const res = await jwtBoot.request("/app/orders/today", { headers: bearer(token) });
    assert.equal(res.status, 401, name);
    assert.deepEqual(await res.json(), { error: "Unauthorized" }, name);
  }

  // Only the Bearer scheme is read; a bare token or another scheme is nothing.
  for (const authorization of [staffJwt(), `Basic ${staffJwt()}`, `Token ${staffJwt()}`]) {
    const res = await jwtBoot.request("/app/orders/today", { headers: { authorization } });
    assert.equal(res.status, 401, authorization.slice(0, 12));
  }
});

test("flag on: no auth is 401 and the shared token is 200, unchanged", async () => {
  const none = await jwtBoot.request("/app/orders/today");
  assert.equal(none.status, 401);
  assert.deepEqual(await none.json(), { error: "Unauthorized" });

  const wrong = await jwtBoot.request("/app/orders/today", { headers: { "x-app-token": "nope" } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: "Unauthorized" });

  const right = await jwtBoot.request("/app/orders/today", { headers: { "x-app-token": APP_TOKEN } });
  assert.equal(right.status, 200);
  assert.deepEqual(await right.json(), { records: [] });

  // Right token + garbage Bearer → next (§10.1): the token is checked first.
  const both = await jwtBoot.request("/app/orders/today", { headers: { "x-app-token": APP_TOKEN, authorization: "Bearer garbage" } });
  assert.equal(both.status, 200);
  assert.deepEqual(await both.json(), { records: [] });

  const post = await jwtBoot.request("/app/tags", json({ tagNumber: "1" }));
  assert.equal(post.status, 401, "POST routes keep their guard with the flag on");
});

test("flag on: the JWT is a second way in — a wrong shared token beside a valid JWT is accepted (§2.1)", async () => {
  const res = await jwtBoot.request("/app/orders/today", { headers: { "x-app-token": "nope", ...bearer(staffJwt()) } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { records: [] });
});

test("flag on: a token signed with STAFF_JWT_SECRET_PREVIOUS still works during a rotation", async () => {
  const res = await jwtBoot.request("/app/orders/today", { headers: bearer(staffJwt({}, PREVIOUS_SECRET)) });
  assert.equal(res.status, 200);
});

test("flag on: /health and the /v2 stub are untouched", async () => {
  const health = await jwtBoot.request("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const v2 = await jwtBoot.request("/v2/health", { headers: bearer(staffJwt()) });
  assert.equal(v2.status, 503);
  assert.deepEqual(await v2.json(), { error: "vakt_unavailable" });

  const missing = await jwtBoot.request("/app/does-not-exist", { headers: bearer(staffJwt()) });
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------------
// APP_TOKEN unset: the server fails closed exactly as before (§10.1).
// ---------------------------------------------------------------------------

test("APP_TOKEN unset, flag off: 503 Server not configured for everyone, JWT or not", async (t) => {
  const noToken = await bootIndexChild({ APP_TOKEN: null });
  t.after(() => noToken.close());

  for (const [name, headers] of [["no auth", {}], ["the token", { "x-app-token": APP_TOKEN }], ["a valid JWT", bearer(staffJwt())]]) {
    const res = await noToken.request("/app/orders/today", { headers });
    assert.equal(res.status, 503, name);
    assert.deepEqual(await res.json(), { error: "Server not configured" }, name);
  }
  assert.match(noToken.stderr, /APP_TOKEN is not set/, "the refusal is still logged");
});

test("APP_TOKEN unset, flag on: a valid JWT gets in, everything else is still 503", async (t) => {
  const noToken = await bootIndexChild({ APP_TOKEN: null, APP_ROUTES_ACCEPT_STAFF_JWT: "1" });
  t.after(() => noToken.close());

  const viaJwt = await noToken.request("/app/orders/today", { headers: bearer(staffJwt()) });
  assert.equal(viaJwt.status, 200, "§2.4 step 6: the JWT path does not depend on the shared token existing");
  assert.deepEqual(await viaJwt.json(), { records: [] });

  for (const [name, headers] of [["no auth", {}], ["the old token", { "x-app-token": APP_TOKEN }], ["a garbage Bearer", bearer("garbage")]]) {
    const res = await noToken.request("/app/orders/today", { headers });
    assert.equal(res.status, 503, name);
    assert.deepEqual(await res.json(), { error: "Server not configured" }, name);
  }
});
