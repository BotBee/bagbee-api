// Airline fee list — the pure half of GET /app/airline-fees (src/airlineFees.js).
//
// What the airline charges at the airport, per airline and destination zone, read
// from two Airtable tables by field id. These tests feed the shaping function
// records exactly as Airtable returns them with returnFieldsByFieldId=true, and
// drive the stale-fallback cache with a fake clock. No network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  ZONE, FEE, AIRLINE_FEE_ZONES_TABLE, AIRLINE_FEES_TABLE, PASSENGER_PRICE_STEP,
  airlineFeeParams, parseDestinations, shapeAirlineFees, passengerPrice, createStaleCache,
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
  assert.deepEqual(shape([], []), { updatedAt: "2026-10-07T09:30:00.000Z", surchargePercent: null, airlines: [] });
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
    surchargePercent: null,
    airlines: [{
      name: "Icelandair",
      zones: [{ id: rec("EU"), label: "Evrópa", destinations: ["CPH", "Kaupmannahöfn", "LHR"], sort: 2 }],
      fees: [
        {
          id: rec("F2"), zoneIds: [], category: "Auka taska", item: "Item F2", limits: null,
          airportPrice: null, onlinePrice: null, currency: null, passengerPrice: null, per: null, notes: null,
          sourceUrl: null, checkedOn: null, confidence: null, sort: 0,
        },
        {
          id: rec("F1"), zoneIds: [rec("EU")], category: "Yfirvigt", item: "Taska 23–32 kg",
          limits: "23–32 kg", airportPrice: 15000, onlinePrice: 9900, currency: "ISK",
          passengerPrice: null, per: "á tösku, hvora leið", notes: "Ekki á Saga Premium",
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
// BagBee's surcharge — percent from the "Álag" row, passenger totals rounded up
// ---------------------------------------------------------------------------

/// BagBee's own rows: airline "BagBee", no zones.
const bagbee = (id, over = {}) => fee(id, { [FEE.airline]: "BagBee", [FEE.currency]: "ISK", ...over });
const surcharge = (id, percent, over = {}) =>
  bagbee(id, { [FEE.category]: "Álag", [FEE.item]: "Álag BagBee á gjöld flugfélaga", [FEE.airportPrice]: percent,
    [FEE.currency]: undefined, [FEE.per]: "%", ...over });

test("passenger price: airline price + 10 %, up to the next 100 kr. — exact, no float drift", () => {
  for (const [price, total] of [
    [10900, 12000], [10000, 11000], [11500, 12700], [13900, 15300],
    [4500, 5000], [3800, 4200], [14900, 16400], [30500, 33600], [1000, 1100], [100, 200], [1, 100],
    // Where price × 1.1 in floating point lands just above the true total:
    [3000, 3300], [11000, 12100], [14000, 15400], [23000, 25300],
  ]) {
    assert.equal(passengerPrice(price, 10, "ISK"), total, `${price} kr.`);
  }
  // The trap is real: 11,000 × 1.1 is 12100.000000000002, which a naive ceil makes 12,200.
  assert.equal(Math.ceil((11000 * 1.1) / 100) * 100, 12200);
});

test("passenger price: EUR, USD, CAD and GBP round up to the next whole unit", () => {
  for (const [price, total] of [[75, 83], [50, 55], [100, 110], [80, 88], [85, 94], [200, 220], [30, 33], [12.5, 14], [0.01, 1]]) {
    assert.equal(passengerPrice(price, 10, "EUR"), total, `€${price}`);
  }
  // €50 × 1.1 is 55.00000000000001 and €100 × 1.1 is 110.00000000000001: naive ceil gives 56 and 111.
  assert.deepEqual([Math.ceil(50 * 1.1), Math.ceil(100 * 1.1)], [56, 111]);
  for (const [price, total] of [[90, 99], [110, 121], [200, 220], [210, 231]]) {
    assert.equal(passengerPrice(price, 10, "EUR"), total, `€${price}`);
  }
  assert.equal(passengerPrice(75, 10, "USD"), 83);
  assert.equal(passengerPrice(75, 10, "CAD"), 83);
  assert.equal(passengerPrice(75, 10, "GBP"), 83);
  assert.equal(passengerPrice(75, 10, " eur "), 83, "currency is read without case or padding");
  assert.deepEqual(Object.keys(PASSENGER_PRICE_STEP).sort(), ["CAD", "EUR", "GBP", "ISK", "USD"]);
});

test("passenger price: other percents are exact too", () => {
  assert.equal(passengerPrice(10000, 20, "ISK"), 12000);
  assert.equal(passengerPrice(10000, 12.5, "ISK"), 11300); // 11,250 → 11,300
  assert.equal(passengerPrice(10000, 0.1, "ISK"), 10100); // 10,010 → 10,100
  assert.equal(passengerPrice(100, 15, "EUR"), 115);
  assert.equal(passengerPrice(0.1, 10, "EUR"), 1);
});

test("passenger price is null without a positive price, a positive percent or a known currency", () => {
  assert.equal(passengerPrice(0, 10, "ISK"), null);
  assert.equal(passengerPrice(-500, 10, "ISK"), null);
  assert.equal(passengerPrice(null, 10, "ISK"), null);
  assert.equal(passengerPrice("10900", 10, "ISK"), null);
  assert.equal(passengerPrice(10900, 0, "ISK"), null);
  assert.equal(passengerPrice(10900, -10, "ISK"), null);
  assert.equal(passengerPrice(10900, null, "ISK"), null);
  assert.equal(passengerPrice(10900, Number.NaN, "ISK"), null);
  assert.equal(passengerPrice(10900, 10, null), null, "a price with no currency is not guessed at");
  assert.equal(passengerPrice(10900, 10, "DKK"), null);
  assert.equal(passengerPrice(10900, 10, "kr."), null);
});

test("the BagBee Álag row gives surchargePercent and is never listed as a fee", () => {
  const body = shape(
    [zone("EU", { label: "Evrópa" })],
    [
      fee("BAG", { zones: ["EU"], [FEE.airportPrice]: 10900, [FEE.currency]: "ISK" }),
      surcharge("PCT", 10),
      bagbee("OWN", { [FEE.item]: "Auka taska (taska nr. 2–9)", [FEE.airportPrice]: 1990 }),
    ],
  );
  assert.equal(body.surchargePercent, 10);
  assert.deepEqual(Object.keys(body), ["updatedAt", "surchargePercent", "airlines"]);
  const all = body.airlines.flatMap((a) => a.fees);
  assert.ok(!all.some((f) => f.id === rec("PCT")), "the surcharge row is not a fee");
  assert.ok(!all.some((f) => f.category === "Álag"));
  assert.deepEqual(body.airlines.map((a) => [a.name, a.fees.map((f) => f.id)]), [
    ["Icelandair", [rec("BAG")]],
    ["BagBee", [rec("OWN")]],
  ]);
});

test("the Álag row is found whatever the case or accents of airline and category", () => {
  for (const [airline, category] of [["BagBee", "Álag"], ["bagbee", "alag"], [" BAGBEE ", " ÁLAG "], ["Bagbee", "Alag"]]) {
    const body = shape([], [fee("BAG", { [FEE.airportPrice]: 10000, [FEE.currency]: "ISK" }),
      surcharge("PCT", 10, { [FEE.airline]: airline, [FEE.category]: category })]);
    assert.equal(body.surchargePercent, 10, `${airline} / ${category}`);
    assert.deepEqual(body.airlines.map((a) => a.name), ["Icelandair"], "an Álag-only airline is not listed");
    assert.equal(body.airlines[0].fees[0].passengerPrice, 11000);
  }
});

test("only BagBee's Álag rows count: another airline's Álag, or BagBee's other categories, are ordinary fees", () => {
  const body = shape([], [
    fee("FIALAG", { [FEE.category]: "Álag", [FEE.airportPrice]: 5, [FEE.currency]: "ISK" }),
    bagbee("OWN", { [FEE.category]: "Auka taska", [FEE.airportPrice]: 10 }),
  ]);
  assert.equal(body.surchargePercent, null);
  assert.deepEqual(body.airlines.map((a) => [a.name, a.fees.map((f) => f.id)]), [
    ["Icelandair", [rec("FIALAG")]],
    ["BagBee", [rec("OWN")]],
  ]);
});

test("an inactive Álag row is ignored; with several, the first by Sort then id wins", () => {
  assert.equal(shape([], [surcharge("OFF", 10, { active: false })]).surchargePercent, null);
  assert.equal(shape([], [surcharge("B", 15, { [FEE.sort]: 2 }), surcharge("C", 12, { [FEE.sort]: 1 })]).surchargePercent, 12);
  assert.equal(shape([], [surcharge("Z", 15), surcharge("A", 10)]).surchargePercent, 10);
  // A blank percent is a deliberate "no surcharge", not a reason to look further.
  const blank = shape([], [surcharge("A", undefined), surcharge("B", 10), fee("BAG", { [FEE.airportPrice]: 10000, [FEE.currency]: "ISK" })]);
  assert.equal(blank.surchargePercent, null);
  assert.equal(blank.airlines[0].fees[0].passengerPrice, null);
});

test("every other airline's priced fee gets passengerPrice; BagBee's own and unpriced fees get null", () => {
  const body = shape(
    [zone("EU", { label: "Evrópa" }), zone("TFS", { airline: "Neos", label: "Tenerife" })],
    [
      surcharge("PCT", 10),
      fee("FI1", { zones: ["EU"], [FEE.airportPrice]: 10900, [FEE.currency]: "ISK", [FEE.sort]: 1 }),
      fee("FI2", { [FEE.airportPrice]: 10000, [FEE.currency]: "ISK", [FEE.sort]: 2 }),
      fee("FI3", { [FEE.airportPrice]: 85, [FEE.currency]: "EUR", [FEE.sort]: 3 }),
      fee("FI4", { [FEE.category]: "Innifalið", [FEE.airportPrice]: 0, [FEE.currency]: "ISK", [FEE.sort]: 4 }),
      fee("FI5", { [FEE.category]: "Innifalið", [FEE.sort]: 5 }),
      fee("FI6", { [FEE.airportPrice]: 4500, [FEE.sort]: 6 }), // no currency
      fee("NE1", { [FEE.airline]: "Neos", zones: ["TFS"], [FEE.airportPrice]: 75, [FEE.currency]: "EUR", [FEE.sort]: 1 }),
      fee("NE2", { [FEE.airline]: "Neos", [FEE.airportPrice]: 50, [FEE.currency]: "EUR", [FEE.sort]: 2 }),
      bagbee("BB1", { [FEE.airportPrice]: 1990, [FEE.sort]: 1 }),
      bagbee("BB2", { [FEE.airportPrice]: 7990, [FEE.sort]: 2 }),
    ],
  );
  const prices = Object.fromEntries(body.airlines.map((a) => [a.name, a.fees.map((f) => [f.airportPrice, f.passengerPrice])]));
  assert.deepEqual(prices, {
    Icelandair: [[10900, 12000], [10000, 11000], [85, 94], [0, null], [null, null], [4500, null]],
    Neos: [[75, 83], [50, 55]],
    BagBee: [[1990, null], [7990, null]],
  });
  // airportPrice itself is untouched: the app shows both.
  assert.equal(body.airlines[0].fees[0].airportPrice, 10900);
});

test("without an Álag row, or with a zero percent, every passengerPrice is null", () => {
  for (const extra of [[], [surcharge("PCT", 0)], [surcharge("PCT", -5)]]) {
    const body = shape([], [fee("BAG", { [FEE.airportPrice]: 10900, [FEE.currency]: "ISK" }), ...extra]);
    assert.equal(body.airlines[0].fees[0].passengerPrice, null);
  }
  assert.equal(shape([], [surcharge("PCT", 0)]).surchargePercent, 0);
});

test("an airline with no zones (BagBee) is served with zones [] and its fees with zoneIds []", () => {
  const body = shape(
    [zone("EU", { label: "Evrópa" })],
    [
      fee("FI", { zones: ["EU"] }),
      surcharge("PCT", 10),
      bagbee("B1", { [FEE.category]: "Auka taska", [FEE.item]: "Auka taska (taska nr. 2–9)", [FEE.airportPrice]: 1990, [FEE.per]: "á tösku", [FEE.sort]: 1 }),
      bagbee("B2", { [FEE.category]: "Auka taska", [FEE.item]: "Auka taska frá 10. tösku", [FEE.airportPrice]: 2490, [FEE.per]: "á tösku", [FEE.sort]: 2 }),
      bagbee("B3", { [FEE.category]: "Yfirstærð", [FEE.item]: "Yfirstærð / íþróttabúnaður", [FEE.airportPrice]: 2490, [FEE.per]: "á hlut", [FEE.sort]: 1 }),
      bagbee("B4", { [FEE.category]: "Annað", [FEE.item]: "Ný pöntun á staðnum – fyrsta taska", [FEE.airportPrice]: 7990, [FEE.per]: "á pöntun", [FEE.sort]: 1 }),
    ],
  );
  const bb = body.airlines.find((a) => a.name === "BagBee");
  assert.deepEqual(bb.zones, []);
  assert.deepEqual(bb.fees.map((f) => [f.item, f.zoneIds, f.airportPrice, f.currency, f.passengerPrice]), [
    ["Auka taska (taska nr. 2–9)", [], 1990, "ISK", null],
    ["Ný pöntun á staðnum – fyrsta taska", [], 7990, "ISK", null],
    ["Yfirstærð / íþróttabúnaður", [], 2490, "ISK", null],
    ["Auka taska frá 10. tösku", [], 2490, "ISK", null],
  ]);
  // A BagBee row linked to another airline's zone is still dropped, not widened.
  assert.ok(!shape([zone("EU")], [bagbee("X", { zones: ["EU"] })]).airlines.some((a) => a.name === "BagBee"));
});

test("airline order: Icelandair, Neos, then BagBee and the rest alphabetically", () => {
  const body = shape([zone("NEOS", { airline: "Neos" })], [
    bagbee("BB"), fee("PLAY", { [FEE.airline]: "PLAY" }), fee("FI"), fee("ATL", { [FEE.airline]: "Atlantic Airways" }),
    surcharge("PCT", 10),
  ]);
  assert.deepEqual(body.airlines.map((a) => a.name), ["Icelandair", "Neos", "Atlantic Airways", "BagBee", "PLAY"]);
  assert.deepEqual(shape([zone("NEOS", { airline: "Neos" })], [bagbee("BB"), fee("FI")]).airlines.map((a) => a.name),
    ["Icelandair", "Neos", "BagBee"]);
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
