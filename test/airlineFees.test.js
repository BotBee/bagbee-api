// Airline fee list — the pure half of GET /app/airline-fees (src/airlineFees.js).
//
// What the airline charges at the airport, per airline and destination zone, read
// from two Airtable tables by field id. These tests feed the shaping function
// records exactly as Airtable returns them with returnFieldsByFieldId=true, and
// drive the stale-fallback cache with a fake clock. No network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  ZONE, FEE, AIRLINE_FEE_ZONES_TABLE, AIRLINE_FEES_TABLE,
  airlineFeeParams, parseDestinations, shapeAirlineFees, createStaleCache,
} from "../src/airlineFees.js";

const FETCHED_AT = new Date("2026-10-07T09:30:00.000Z");

/// Record ids are rec + 14 characters; the tail keeps fixtures readable.
const rec = (tail) => `rec${tail.padEnd(14, "0")}`;

function zone(id, { zone: name = id, airline = "Icelandair", label, destinations, sort, active = true } = {}) {
  const fields = { [ZONE.zone]: name, [ZONE.airline]: airline };
  if (label !== undefined) fields[ZONE.label] = label;
  if (destinations !== undefined) fields[ZONE.destinations] = destinations;
  if (sort !== undefined) fields[ZONE.sort] = sort;
  if (active) fields[ZONE.active] = true; // Airtable omits an unticked checkbox
  return { id: rec(id), createdTime: "2026-10-07T08:00:00.000Z", fields };
}

function fee(id, over = {}) {
  const { active = true, zones, ...rest } = over;
  const fields = {
    [FEE.name]: `Fee ${id}`,
    [FEE.airline]: "Icelandair",
    [FEE.category]: "Auka taska",
    [FEE.item]: `Item ${id}`,
    ...rest,
  };
  if (zones) fields[FEE.zones] = zones.map(rec);
  if (active) fields[FEE.active] = true;
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
  return { id: rec(id), createdTime: "2026-10-07T08:00:00.000Z", fields };
}

const shape = (zones, fees) => shapeAirlineFees(zones, fees, { fetchedAt: FETCHED_AT });

test("table and field ids are the ones verified against the base", () => {
  assert.equal(AIRLINE_FEE_ZONES_TABLE, "tbl2CKpEVoBI2Dxp5");
  assert.equal(AIRLINE_FEES_TABLE, "tblfOdAJSsMAh5lMv");
  for (const id of [...Object.values(ZONE), ...Object.values(FEE)]) assert.match(id, /^fld[A-Za-z0-9]{14}$/);
  assert.equal(ZONE.active, "fldIPeaS5UHpyqEMV");
  assert.equal(FEE.active, "flddB9g0709C9YpAI");
  assert.equal(FEE.zones, "fldH4UjV3cCSxmH2v");
});

test("the query asks by field id, for Active rows only, and names no fields (a deleted column must not 422 the read)", () => {
  const params = airlineFeeParams(FEE);
  const q = new URLSearchParams(params);
  assert.equal(q.get("returnFieldsByFieldId"), "true");
  assert.equal(q.get("filterByFormula"), `{${FEE.active}}`);
  assert.deepEqual(q.getAll("fields[]"), []);
  assert.deepEqual(new URLSearchParams(airlineFeeParams(ZONE)).getAll("fields[]"), []);
  assert.equal(new URLSearchParams(airlineFeeParams(ZONE)).get("filterByFormula"), `{${ZONE.active}}`);
});

test("columns the shaper does not know (Airtable now sends every column) change nothing", () => {
  const plain = shape([zone("EU", { label: "Evrópa" })], [fee("F1", { zones: ["EU"] })]);
  const z = zone("EU", { label: "Evrópa" });
  const f = fee("F1", { zones: ["EU"] });
  z.fields.fldNewColumn00000 = "added later";
  f.fields.fldNewColumn00000 = 123;
  f.fields.fldOtherColumn000 = ["recSomething000000"];
  assert.deepEqual(shape([z], [f]), plain);
});

test("destinations split on commas, newlines and semicolons; blanks and repeats go", () => {
  assert.deepEqual(
    parseDestinations(" CPH, Kaupmannahöfn\r\nCopenhagen ;; cph\n\nBLL ,"),
    ["CPH", "Kaupmannahöfn", "Copenhagen", "BLL"],
  );
  assert.deepEqual(parseDestinations(""), []);
  assert.deepEqual(parseDestinations(undefined), []);
  assert.deepEqual(parseDestinations(["CPH"]), []);
});

test("empty tables give an empty list stamped with the fetch time", () => {
  assert.deepEqual(shape([], []), { updatedAt: "2026-10-07T09:30:00.000Z", airlines: [] });
  assert.deepEqual(shape(undefined, undefined).airlines, []);
});

test("a full fee row maps onto the contract, with blanks as null", () => {
  const body = shape(
    [zone("EU", { label: "Evrópa", destinations: "CPH, Kaupmannahöfn\nLHR", sort: 2 })],
    [
      fee("F1", {
        zones: ["EU"],
        [FEE.category]: "Yfirvigt",
        [FEE.item]: "  Taska 23–32 kg  ",
        [FEE.limits]: "23–32 kg",
        [FEE.airportPrice]: 15000,
        [FEE.onlinePrice]: 9900,
        [FEE.currency]: "ISK",
        [FEE.per]: "á tösku, hvora leið",
        [FEE.notes]: "Ekki á Saga Premium",
        [FEE.sourceUrl]: "https://www.icelandair.com/support/baggage/",
        [FEE.checkedOn]: "2026-10-01",
        [FEE.confidence]: "Official",
        [FEE.sort]: 5,
      }),
      fee("F2", { [FEE.limits]: "   ", [FEE.airportPrice]: "15000" }),
    ],
  );
  assert.deepEqual(body, {
    updatedAt: "2026-10-07T09:30:00.000Z",
    airlines: [{
      name: "Icelandair",
      zones: [{ id: rec("EU"), label: "Evrópa", destinations: ["CPH", "Kaupmannahöfn", "LHR"], sort: 2 }],
      fees: [
        {
          id: rec("F2"), zoneIds: [], category: "Auka taska", item: "Item F2", limits: null,
          airportPrice: null, onlinePrice: null, currency: null, per: null, notes: null,
          sourceUrl: null, checkedOn: null, confidence: null, sort: 0,
        },
        {
          id: rec("F1"), zoneIds: [rec("EU")], category: "Yfirvigt", item: "Taska 23–32 kg",
          limits: "23–32 kg", airportPrice: 15000, onlinePrice: 9900, currency: "ISK",
          per: "á tösku, hvora leið", notes: "Ekki á Saga Premium",
          sourceUrl: "https://www.icelandair.com/support/baggage/", checkedOn: "2026-10-01",
          confidence: "Official", sort: 5,
        },
      ],
    }],
  });
});

test("only Active zones and fees are served", () => {
  const body = shape(
    [zone("ON", { label: "On" }), zone("OFF", { label: "Off", active: false })],
    [fee("A"), fee("B", { active: false }), { id: rec("C"), fields: { ...fee("C").fields, [FEE.active]: "true" } }],
  );
  const [icelandair] = body.airlines;
  assert.deepEqual(icelandair.zones.map((z) => z.label), ["On"]);
  assert.deepEqual(icelandair.fees.map((f) => f.id), [rec("A")]);
});

test("a fee tied only to switched-off or deleted zones is dropped, never widened to every zone", () => {
  const body = shape(
    [zone("ON"), zone("OFF", { active: false })],
    [
      fee("ONLYOFF", { zones: ["OFF"] }),
      fee("GONE", { zones: ["DELETED"] }),
      fee("MIXED", { zones: ["OFF", "ON"] }),
      fee("ALL"),
    ],
  );
  const fees = body.airlines[0].fees;
  assert.deepEqual(fees.map((f) => f.id).sort(), [rec("ALL"), rec("MIXED")].sort());
  assert.deepEqual(fees.find((f) => f.id === rec("MIXED")).zoneIds, [rec("ON")]);
  assert.deepEqual(fees.find((f) => f.id === rec("ALL")).zoneIds, []);
});

test("a zone of another airline cannot hold a fee; a fee with no airline takes its zone's", () => {
  const body = shape(
    [zone("FIEU", { airline: "Icelandair" }), zone("NEOS", { airline: "Neos", label: "Tenerife" })],
    [
      fee("CROSS", { zones: ["NEOS"] }), // says Icelandair, linked only to a Neos zone
      fee("SPLIT", { zones: ["FIEU", "NEOS"] }), // keeps only its own airline's zone
      fee("ORPHAN", { [FEE.airline]: undefined, zones: ["NEOS"] }),
      fee("NOWHERE", { [FEE.airline]: undefined }),
    ],
  );
  const by = Object.fromEntries(body.airlines.map((a) => [a.name, a]));
  assert.deepEqual(by.Icelandair.fees.map((f) => [f.id, f.zoneIds]), [[rec("SPLIT"), [rec("FIEU")]]]);
  assert.deepEqual(by.Neos.fees.map((f) => [f.id, f.zoneIds]), [[rec("ORPHAN"), [rec("NEOS")]]]);
});

test("item falls back to Name, label to Zone, category to Annað; rows with neither are dropped", () => {
  const body = shape(
    [zone("Z1", { zone: "eu-internal" }), zone("Z2", { zone: "  ", label: "" })],
    [
      fee("NAMED", { [FEE.item]: "", [FEE.name]: "Golfsett" }),
      fee("BARE", { [FEE.item]: undefined, [FEE.name]: undefined }),
      fee("NOCAT", { [FEE.category]: undefined }),
    ],
  );
  const [icelandair] = body.airlines;
  assert.deepEqual(icelandair.zones.map((z) => z.label), ["eu-internal"]);
  assert.deepEqual(icelandair.fees.map((f) => f.item).sort(), ["Golfsett", "Item NOCAT"]);
  assert.equal(icelandair.fees.find((f) => f.item === "Item NOCAT").category, "Annað");
});

test("airlines run Icelandair, Neos, then others alphabetically; zones and fees by sort then text", () => {
  const body = shape(
    [
      zone("PLAY", { airline: "PLAY" }),
      zone("NEOS", { airline: "Neos" }),
      zone("ATL", { airline: "Atlantic Airways" }),
      zone("Z3", { label: "Ameríka", sort: 2 }),
      zone("Z2", { label: "Norðurlönd", sort: 1 }),
      zone("Z1", { label: "Evrópa", sort: 1 }),
      zone("Z0", { label: "Án röðunar" }),
    ],
    [
      fee("F3", { [FEE.item]: "Önnur taska", [FEE.sort]: 2 }),
      fee("F2", { [FEE.item]: "Aukataska", [FEE.sort]: 2 }),
      fee("F1", { [FEE.item]: "Zebra", [FEE.sort]: 1 }),
      fee("F0", { [FEE.item]: "Ýmislegt", [FEE.sort]: 1.5 }),
    ],
  );
  assert.deepEqual(body.airlines.map((a) => a.name), ["Icelandair", "Neos", "Atlantic Airways", "PLAY"]);
  const [icelandair] = body.airlines;
  assert.deepEqual(icelandair.zones.map((z) => z.label), ["Án röðunar", "Evrópa", "Norðurlönd", "Ameríka"]);
  assert.deepEqual(icelandair.fees.map((f) => f.item), ["Zebra", "Ýmislegt", "Aukataska", "Önnur taska"]);
});

test("Checked on keeps the calendar date; anything unreadable is null", () => {
  const body = shape([], [
    fee("D1", { [FEE.checkedOn]: "2026-09-30T00:00:00.000Z", [FEE.sort]: 1 }),
    fee("D2", { [FEE.checkedOn]: "30.09.2026", [FEE.sort]: 2 }),
  ]);
  assert.deepEqual(body.airlines[0].fees.map((f) => f.checkedOn), ["2026-09-30", null]);
});

// ---------------------------------------------------------------------------
// createStaleCache — five minutes fresh, last good list on failure
// ---------------------------------------------------------------------------

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("a fresh answer is served from memory until the TTL runs out", async () => {
  const c = clock();
  let calls = 0;
  const cache = createStaleCache({ load: async () => ({ n: ++calls }), ttlMs: 300_000, now: c.now });

  assert.deepEqual(await cache.get(), { payload: { n: 1 }, stale: false });
  c.advance(299_999);
  assert.deepEqual(await cache.get(), { payload: { n: 1 }, stale: false });
  assert.equal(calls, 1);
  c.advance(1);
  assert.deepEqual(await cache.get(), { payload: { n: 2 }, stale: false });
  assert.equal(calls, 2);
});

test("a failed refresh serves the last good list, marked stale, and the next request tries again", async () => {
  const c = clock();
  let fail = false;
  let calls = 0;
  const cache = createStaleCache({
    load: async () => {
      calls++;
      if (fail) throw new Error("Airtable 503");
      return { n: calls };
    },
    ttlMs: 1_000,
    now: c.now,
  });

  await cache.get();
  fail = true;
  c.advance(1_000);
  const stale = await cache.get();
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.payload, { n: 1 });
  assert.equal(stale.error.message, "Airtable 503");

  // A failure is not cached: the very next request goes back to Airtable.
  fail = false;
  assert.deepEqual(await cache.get(), { payload: { n: 3 }, stale: false });
  assert.equal(calls, 3);
});

test("with nothing held, a failure rejects (the route turns it into a 502)", async () => {
  const cache = createStaleCache({
    load: () => { throw new Error("sync boom"); }, // even a synchronous throw must not wedge the cache
    ttlMs: 1_000,
  });
  await assert.rejects(cache.get(), /sync boom/);
  await assert.rejects(cache.get(), /sync boom/);
});

test("callers arriving together share one load", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = createStaleCache({
    load: async () => { calls++; await gate; return { n: calls }; },
    ttlMs: 0,
  });
  const pending = [cache.get(), cache.get(), cache.get()];
  release();
  const answers = await Promise.all(pending);
  assert.equal(calls, 1);
  for (const a of answers) assert.deepEqual(a, { payload: { n: 1 }, stale: false });
});
