// Spec §10.1 (§5.2) — the rate-limited read client and the TTL cache it ships
// with. No network: fetch, the clock and sleep are all injected.

import test from "node:test";
import assert from "node:assert/strict";

import { createAirtableClient, createCache, createTokenBucket } from "../src/airtable/client.js";
import { TABLES, escapeFormulaValue } from "../src/airtable/fields.js";

const silent = { error: () => {}, warn: () => {}, info: () => {} };
const noBucket = { take: async () => {} };

function reply(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  };
}

/// fetch stub: hands back queued replies and records what was asked for.
function fakeFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const fn = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra request");
    if (typeof next === "function") return next();
    return next;
  };
  fn.calls = calls;
  return fn;
}

function client(fetchImpl, over = {}) {
  const sleeps = [];
  const c = createAirtableClient({
    token: "tok",
    fetchImpl,
    bucket: noBucket,
    sleep: async (ms) => sleeps.push(ms),
    logger: silent,
    ...over,
  });
  c.sleeps = sleeps;
  return c;
}

test("listAll POSTs to listRecords, asks for field ids and follows the offset", async () => {
  const f = fakeFetch([
    reply(200, { records: [{ id: "rec1" }], offset: "off1" }),
    reply(200, { records: [{ id: "rec2" }] }),
  ]);
  const c = client(f);

  const { records, pages } = await c.listAll(TABLES.staff, { filterByFormula: "TRUE()", fields: ["fldA"] });

  assert.deepEqual(records.map((r) => r.id), ["rec1", "rec2"]);
  assert.equal(pages, 2);
  assert.equal(f.calls[0].url, `https://api.airtable.com/v0/appHB2bNYPAhfUcLv/${TABLES.staff}/listRecords`);
  assert.equal(f.calls[0].body.returnFieldsByFieldId, true);
  assert.equal(f.calls[0].body.pageSize, 100);
  assert.deepEqual(f.calls[0].body.fields, ["fldA"]);
  assert.equal(f.calls[0].body.offset, undefined);
  assert.equal(f.calls[1].body.offset, "off1");
  assert.equal(f.calls[0].headers.Authorization, "Bearer tok");
});

test("listAll throws airtable_truncated at the page cap instead of silently truncating", async () => {
  const f = fakeFetch([
    reply(200, { records: [{ id: "rec1" }], offset: "a" }),
    reply(200, { records: [{ id: "rec2" }], offset: "b" }),
  ]);
  const logged = [];
  const c = client(f, { logger: { ...silent, error: (...a) => logged.push(a.join(" ")) } });

  await assert.rejects(() => c.listAll(TABLES.orders, { maxPages: 2 }), (err) => err.code === "airtable_truncated");
  assert.equal(logged[0], `[airtable] page cap hit ${TABLES.orders}`);
});

test("429: an interactive caller fails fast, a job waits 30 s once", async () => {
  const interactive = client(fakeFetch([reply(429)]));
  await assert.rejects(
    () => interactive.listAll(TABLES.orders, { interactive: true }),
    (err) => err.code === "airtable_busy" && err.status === 429
  );
  assert.deepEqual(interactive.sleeps, []);

  const job = client(fakeFetch([reply(429), reply(200, { records: [] })]));
  await job.listAll(TABLES.orders);
  assert.deepEqual(job.sleeps, [30_000]);

  const stubborn = client(fakeFetch([reply(429), reply(429)]));
  await assert.rejects(() => stubborn.listAll(TABLES.orders), (err) => err.code === "airtable_busy");
  assert.deepEqual(stubborn.sleeps, [30_000]);
});

test("5xx is retried once after 2 s, then reported as unavailable", async () => {
  const ok = client(fakeFetch([reply(502), reply(200, { records: [{ id: "rec1" }] })]));
  const { records } = await ok.listAll(TABLES.shifts);
  assert.equal(records.length, 1);
  assert.deepEqual(ok.sleeps, [2_000]);

  const down = client(fakeFetch([reply(500), reply(503)]));
  await assert.rejects(() => down.listAll(TABLES.shifts), (err) => err.code === "airtable_unavailable");
});

test("a network failure or timeout becomes airtable_unavailable and logs no formula", async () => {
  const logged = [];
  const c = client(
    async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    },
    { logger: { ...silent, error: (...a) => logged.push(a.join(" ")) } }
  );

  await assert.rejects(
    () => c.listAll(TABLES.staff, { filterByFormula: "LOWER({fldX})='jon@bagbee.is'" }),
    (err) => err.code === "airtable_unavailable"
  );
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes("@"), "the log line must not carry an email address");
});

test("401/403 is reported separately, so a bad PAT is not read as an outage", async () => {
  const c = client(fakeFetch([reply(403)]));
  await assert.rejects(() => c.listAll(TABLES.staff), (err) => err.code === "airtable_forbidden");
});

test("a missing token fails before any request is made", async () => {
  const f = fakeFetch([]);
  const c = createAirtableClient({ token: "", fetchImpl: f, bucket: noBucket, logger: silent });
  await assert.rejects(() => c.listAll(TABLES.staff), (err) => err.code === "airtable_not_configured");
  assert.equal(f.calls.length, 0);
});

test("getByIds batches 50 record ids per request", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `rec${String(i).padStart(14, "0")}`);
  const f = fakeFetch([reply(200, { records: [] }), reply(200, { records: [] })]);
  const c = client(f);

  await c.getByIds(TABLES.staff, ids, ["fldA"]);

  assert.equal(f.calls.length, 2);
  assert.equal((f.calls[0].body.filterByFormula.match(/RECORD_ID\(\)/g) || []).length, 50);
  assert.equal((f.calls[1].body.filterByFormula.match(/RECORD_ID\(\)/g) || []).length, 10);
});

test("escapeFormulaValue closes the quote-escape hole", () => {
  assert.equal(escapeFormulaValue("o'brien@x.is"), "o\\'brien@x.is");
  assert.equal(escapeFormulaValue("a\\b"), "a\\\\b");
});

test("the token bucket allows a burst of 4 and then paces at 4/s", async () => {
  let t = 1_000;
  const sleeps = [];
  const bucket = createTokenBucket({
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });

  for (let i = 0; i < 4; i += 1) await bucket.take();
  assert.deepEqual(sleeps, [], "the first four go straight through");

  await bucket.take();
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 0 && sleeps[0] <= 250, `expected a quarter-second pace, got ${sleeps[0]}`);
});

test("the cache is single-flight, serves stale on failure and evicts by LRU", async () => {
  let t = 0;
  const cache = createCache({ now: () => t, logger: silent });
  let loads = 0;
  const load = async () => {
    loads += 1;
    return `v${loads}`;
  };

  const [a, b] = await Promise.all([
    cache.get("k", { ttlMs: 100, load }),
    cache.get("k", { ttlMs: 100, load }),
  ]);
  assert.equal(loads, 1, "two concurrent callers make one request");
  assert.equal(a.value, "v1");
  assert.equal(b.value, "v1");
  assert.equal(a.stale, false);

  t = 50;
  assert.equal((await cache.get("k", { ttlMs: 100, load })).value, "v1");
  assert.equal(loads, 1, "still fresh");

  t = 200;
  const failing = async () => {
    throw new Error("airtable down");
  };
  const stale = await cache.get("k", { ttlMs: 100, staleMs: 1_000, load: failing });
  assert.equal(stale.value, "v1");
  assert.equal(stale.stale, true, "an outage serves the old answer, it does not blank the screen");

  t = 5_000;
  await assert.rejects(() => cache.get("k", { ttlMs: 100, staleMs: 1_000, load: failing }));

  const lru = createCache({ now: () => t, max: 2, logger: silent });
  for (const key of ["a", "b", "c"]) await lru.get(key, { ttlMs: 1_000, load: async () => key });
  assert.equal(lru.size(), 2);
});
