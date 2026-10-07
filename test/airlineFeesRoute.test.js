// GET /app/airline-fees — the airline's own price list for extras at the airport
// (extra bags, overweight, oversize, sports equipment), per airline and zone.
//
// Driven through the real index.js (test/_indexHarness.js); the shaping itself is
// covered in airlineFees.test.js. index.js reads the cache TTL and the timeout
// once at import, so both are set before this file's boot: TTL 0 makes every
// request go to Airtable, which is what lets the 502, fresh and stale cases run
// one after another in one process. The 5-minute hold is tested on the cache
// with a fake clock.
//
// Order matters: the 502 case must run before any request has succeeded.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { bootIndex, airtable, APP_TOKEN } from "./_indexHarness.js";

process.env.AIRLINE_FEES_CACHE_MS = "0";
process.env.AIRLINE_FEES_TIMEOUT_MS = "150";

const boot = await bootIndex();
after(() => boot.close());

const ZONES_TABLE = "tbl2CKpEVoBI2Dxp5";
const FEES_TABLE = "tblfOdAJSsMAh5lMv";
const ZONE_ACTIVE = "fldIPeaS5UHpyqEMV";
const FEE_ACTIVE = "flddB9g0709C9YpAI";

const get = (headers = { "x-app-token": APP_TOKEN }) => boot.request("/app/airline-fees", { headers });
const ok = (body) => ({ status: 200, body: JSON.stringify(body) });

const ZONE_EU = {
  id: "recZONEEUROPE0001",
  fields: {
    fld1LHI7eIXBAUGkw: "fi-europe",
    fldGf6EOxvdNpXY9f: "Icelandair",
    fld88zpqdlwrAWaEK: "Evrópa",
    fldSutmDoaL6sME6d: "CPH, Kaupmannahöfn\nLHR",
    fld8yiqhPJPtpAtbZ: 1,
    [ZONE_ACTIVE]: true,
  },
};

const FEE_BAG = {
  id: "recFEEEXTRABAG001",
  fields: {
    fldQwQsdPXB6eai4D: "FI extra bag Europe",
    fldBEd8BlG7e2lE5K: "Icelandair",
    fldH4UjV3cCSxmH2v: [ZONE_EU.id],
    fldWw5qsIkIpPaPwi: "Auka taska",
    fldFyq3hTvVryJje0: "Auka taska 23 kg",
    fldlLSl34RgkNUPcv: 14000,
    fldYFTu32JOkH9jxt: "ISK",
    fld6m4GI0bEIPyQzt: "hvora leið",
    fldVuOYyyXKtw7Mdi: "2026-10-01",
    fldBN6JOAR5FXqr6q: "Official",
    fldFipdXGXgZ4oJbE: 1,
    [FEE_ACTIVE]: true,
  },
};

const FEE_GOLF = {
  id: "recFEEGOLFBAG0001",
  fields: {
    fldQwQsdPXB6eai4D: "Neos golf",
    fldBEd8BlG7e2lE5K: "Neos",
    fldWw5qsIkIpPaPwi: "Íþróttabúnaður",
    fldFyq3hTvVryJje0: "Golfsett",
    fldlLSl34RgkNUPcv: 60,
    fldYFTu32JOkH9jxt: "EUR",
    [FEE_ACTIVE]: true,
  },
};

/// Both tables answered from fixtures; the fee table comes back in two pages so
/// the route is seen to follow Airtable's offset.
function stubTables() {
  airtable.reset();
  airtable.reply = (url) => {
    const q = new URL(url).searchParams;
    if (url.includes(`/${ZONES_TABLE}?`)) return ok({ records: [ZONE_EU] });
    if (url.includes(`/${FEES_TABLE}?`)) {
      return q.get("offset") === "page2"
        ? ok({ records: [FEE_GOLF] })
        : ok({ records: [FEE_BAG], offset: "page2" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

test("no app token, no list — and Airtable is never asked", async () => {
  airtable.reset();
  const res = await get({});
  assert.equal(res.status, 401);
  assert.equal(airtable.calls.length, 0);
});

test("Airtable down with nothing held yet: 502 with a readable error", async () => {
  airtable.reset();
  airtable.reply = () => ({ status: 503, body: '{"error":"SERVICE_UNAVAILABLE"}' });
  const res = await get();
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("x-airline-fees-stale"), null);
  assert.deepEqual(await res.json(), { error: "The airline fee list could not be read from Airtable" });
});

test("reads both tables by field id, Active rows only, never writes, and serves the contract shape", async () => {
  stubTables();
  const before = Date.now();
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-airline-fees-stale"), null);
  const body = await res.json();

  for (const call of airtable.calls) {
    assert.ok(!call.options.method || call.options.method === "GET", "the route never writes");
    assert.ok(call.url.startsWith("https://api.airtable.com/v0/appHB2bNYPAhfUcLv/"), call.url);
  }
  const zoneCalls = airtable.calls.filter((c) => c.url.includes(`/${ZONES_TABLE}?`));
  const feeCalls = airtable.calls.filter((c) => c.url.includes(`/${FEES_TABLE}?`));
  assert.equal(zoneCalls.length, 1);
  assert.equal(feeCalls.length, 2, "the second page of fees is read too");
  for (const [call, active] of [[zoneCalls[0], ZONE_ACTIVE], [feeCalls[0], FEE_ACTIVE]]) {
    const q = new URL(call.url).searchParams;
    assert.equal(q.get("returnFieldsByFieldId"), "true");
    assert.equal(q.get("filterByFormula"), `{${active}}`);
    assert.deepEqual(q.getAll("fields[]"), [], "no fields[]: a deleted column must not 422 the whole read");
  }

  assert.equal(body.stale, false);
  assert.ok(Date.parse(body.updatedAt) >= before - 1000);
  assert.deepEqual(body.airlines.map((a) => a.name), ["Icelandair", "Neos"]);
  const [icelandair, neos] = body.airlines;
  assert.deepEqual(icelandair.zones, [
    { id: ZONE_EU.id, label: "Evrópa", destinations: ["CPH", "Kaupmannahöfn", "LHR"], sort: 1 },
  ]);
  assert.deepEqual(icelandair.fees, [{
    id: FEE_BAG.id, zoneIds: [ZONE_EU.id], category: "Auka taska", item: "Auka taska 23 kg",
    limits: null, airportPrice: 14000, onlinePrice: null, currency: "ISK", per: "hvora leið",
    notes: null, sourceUrl: null, checkedOn: "2026-10-01", confidence: "Official", sort: 1,
  }]);
  assert.deepEqual(neos.zones, []);
  assert.deepEqual(neos.fees.map((f) => [f.item, f.zoneIds, f.airportPrice, f.currency]), [["Golfsett", [], 60, "EUR"]]);
});

test("Airtable fails after a good read: the last good list is served, marked stale", async () => {
  stubTables();
  const good = await (await get()).json();

  airtable.reset();
  airtable.reply = () => ({ status: 500, body: '{"error":"SERVER_ERROR"}' });
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-airline-fees-stale"), "1");
  const body = await res.json();
  assert.equal(body.stale, true);
  assert.equal(body.updatedAt, good.updatedAt, "updatedAt still says when the list was really read");
  assert.deepEqual(body.airlines, good.airlines);
  assert.ok(airtable.calls.length > 0, "Airtable was asked again first");
});

test("an Airtable that never answers costs the timeout, then the last good list", async () => {
  stubTables();
  await get();

  airtable.reset();
  airtable.reply = () => new Promise(() => {});
  const started = Date.now();
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-airline-fees-stale"), "1");
  assert.equal((await res.json()).stale, true);
  assert.ok(Date.now() - started < 2_000, "answered on the timeout, not left hanging");
});
