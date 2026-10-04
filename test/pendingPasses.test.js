// Boarding passes scanned while the airport check-in is down (2026-09-19).
//
// When BagChain → Altea is down the driver scans the pass inside the order and
// prints BagBee's own fallback label. Until now that left nothing behind but the
// paper: the real tag, claimed later on a phone or in a batch on the Mac, had
// no order to land on. Now the scan is a PENDING row in Tag numbers — the pass,
// the passenger, the order, and no plate — and the claim fills it in.
//
// Four things are covered: POST /app/passes creating and deduping the pending
// row, POST /app/tags filling it (and leaving every existing caller's path
// exactly as it was), the per-order list showing it, and the per-day query the
// Mac's claim_pending.py reads. Everything drives the real index.js through
// test/_indexHarness.js, so nothing here touches api.airtable.com and no test
// can be satisfied by a re-implementation of the wiring.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { bootIndex, airtable, APP_TOKEN } from "./_indexHarness.js";

const boot = await bootIndex();
after(() => boot.close());

const ORDERS = "tblWLlNxZvtkFSFXs";
const TAGS = "tblVyZakUmK0CY0YJ";
const AUTH = { "x-app-token": APP_TOKEN };

// One passenger's pass as the scanner hands it over, with the two labels that
// can be stored against it: BagBee's fallback (no plate) and the real one.
const RAW = "M1JONSDOTTIR/SIGRIDUR EABC123 KEFPRGFI 0542 262Y012A0001 100";
const FALLBACK_ZPL = "^XA^FO20,30^FDJONSDOTTIR/SIGRIDUR^FS^FO20,80^FDi0lYC JON JONSSON^FS^XZ";
const REAL_ZPL = "^XA^MNM^MTD^FO20,30^FDJONSDOTTIR/S^FS^FO20,200^FD0592123456^FS^XZ";
const TAG_DATA = { tagNumber: "0592123456", pnrData: "ABC123", airlineName: "ICELANDAIR" };

const SCAN = {
  bcbpRaw: RAW,
  orderNumber: "i0lYC",
  orderRecordId: "recORDER000000001",
  uthringingarRecordId: "recUTH00000000001",
  passengerName: "JONSDOTTIR/SIGRIDUR",
  pnr: "ABC123",
  flight: "FI 542",
  flightDate: "2026-09-19",
  destination: "PRG",
  zpl: FALLBACK_ZPL,
};

/// The row POST /app/passes leaves behind for SCAN.
const PENDING_ROW = {
  id: "recPASS0000000001",
  createdTime: "2026-09-19T08:00:00.000Z",
  fields: {
    "BCBP Raw": RAW, "Order No": "i0lYC", "Order No copy": ["recORDER000000001"],
    "Úthringingar": ["recUTH00000000001"], "Passenger Name": "JONSDOTTIR/SIGRIDUR",
    PNR: "ABC123", Flight: "FI 542", "Flight Date": "2026-09-19", Destination: "PRG",
    "Label ZPL": FALLBACK_ZPL,
  },
};

/// A tag already claimed for the same pass — the passenger's other bag.
const CLAIMED_ROW = {
  id: "recTAGCLAIMED0001",
  createdTime: "2026-09-19T07:00:00.000Z",
  fields: { "BagTag Number": "0592111111", "BCBP Raw": RAW, "Order No": "i0lYC", "Passenger Name": "JONSDOTTIR/SIGRIDUR" },
};

function post(path, body, headers = AUTH) {
  return boot.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const formulaOf = (url) => decodeURIComponent(new URL(url).searchParams.get("filterByFormula") || "");
const fieldsOf = (url) => new URL(url).searchParams.getAll("fields[]").map(decodeURIComponent);

/// Every write index.js made, in order, with its parsed body.
function writes() {
  return airtable.calls
    .filter((c) => c.options.method === "PATCH" || c.options.method === "POST")
    .map((c) => ({ method: c.options.method, url: c.url, body: JSON.parse(c.options.body) }));
}

/// The tag table, answered by formula: `byTag` for the plate lookup /app/tags
/// makes first, `byRaw` for the pass lookup, `pendingByPnr` for the booking's
/// rows with no plate (read when the raw finds none), `orders` for the one read on
/// Orders that turns a number into its record id (2026-09-25), and writes
/// accepted with the id they were addressed to.
function tagTableStub({ byTag = [], byRaw = [], pendingByPnr = [], orders = [] } = {}) {
  airtable.reply = (url, options = {}) => {
    if (options.method === "PATCH") {
      return { status: 200, body: JSON.stringify({ id: url.split("/").pop() }) };
    }
    if (options.method === "POST") {
      return { status: 200, body: JSON.stringify({ id: "recPASSnew0000001" }) };
    }
    const formula = formulaOf(url);
    if (formula.startsWith("{BagTag Number}=")) return { status: 200, body: JSON.stringify({ records: byTag }) };
    if (formula.startsWith("{BCBP Raw}=")) return { status: 200, body: JSON.stringify({ records: byRaw }) };
    if (formula.startsWith("AND(LEN({BagTag Number}&'')=0,UPPER(TRIM({PNR}")) {
      return { status: 200, body: JSON.stringify({ records: pendingByPnr }) };
    }
    if (formula.startsWith("{Pöntunarnúmer (fx)}=")) return { status: 200, body: JSON.stringify({ records: orders }) };
    return { status: 200, body: JSON.stringify({ records: [] }) };
  };
}

// ---------------------------------------------------------------------------
// POST /app/passes
// ---------------------------------------------------------------------------

test("a scanned pass becomes a pending row: the pass, the order, and no plate", async () => {
  airtable.reset();
  tagTableStub();

  const res = await post("/app/passes", SCAN);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: "recPASSnew0000001", created: true, updated: false, pending: true, label: "stored", claimedTags: [],
  });

  // Looked up by the raw barcode, the pending row's key.
  assert.equal(formulaOf(airtable.calls[0].url), `{BCBP Raw}='${RAW}'`);

  const [write] = writes();
  assert.equal(write.method, "POST");
  assert.ok(write.url.includes(TAGS));
  assert.equal(write.body.typecast, true);
  assert.deepEqual(write.body.fields, {
    "BCBP Raw": RAW,
    "Order No": "i0lYC",
    "Order No copy": ["recORDER000000001"],
    "Úthringingar": ["recUTH00000000001"],
    "Passenger Name": "JONSDOTTIR/SIGRIDUR",
    PNR: "ABC123",
    Flight: "FI 542",
    "Flight Date": "2026-09-19",
    Destination: "PRG",
    "Label ZPL": FALLBACK_ZPL,
  });
  assert.ok(!("BagTag Number" in write.body.fields), "a pending row has no plate");
});

test("the same pass scanned again is the same row, not a second one", async () => {
  airtable.reset();
  tagTableStub({ byRaw: [PENDING_ROW] });

  // The app retries after a dropped connection; a second phone scans the same
  // pass. Everything is already there, so nothing is written.
  const res = await post("/app/passes", SCAN);
  assert.deepEqual(await res.json(), {
    id: "recPASS0000000001", created: false, updated: false, pending: true, label: "unchanged", claimedTags: [],
  });
  assert.deepEqual(writes(), []);
});

test("a pending row is filled in, blanks only, with links appended", async () => {
  airtable.reset();
  // A scan that got through with just the pass and the order number.
  tagTableStub({
    byRaw: [{ id: "recPASS0000000001", fields: { "BCBP Raw": RAW, "Order No": "i0lYC", "Order No copy": ["recORDER000000009"] } }],
  });

  const res = await post("/app/passes", { ...SCAN, orderNumber: "zzzzz" });
  const body = await res.json();
  assert.equal(body.updated, true);
  assert.equal(body.label, "stored");

  const [write] = writes();
  assert.equal(write.method, "PATCH");
  assert.ok(write.url.endsWith("/recPASS0000000001"));
  assert.equal(write.body.fields["Order No"], undefined, "a filled cell is never overwritten");
  assert.deepEqual(write.body.fields["Order No copy"], ["recORDER000000009", "recORDER000000001"]);
  assert.deepEqual(write.body.fields["Úthringingar"], ["recUTH00000000001"]);
  assert.equal(write.body.fields["Passenger Name"], "JONSDOTTIR/SIGRIDUR");
  assert.equal(write.body.fields["Label ZPL"], FALLBACK_ZPL);
  assert.ok(!("BagTag Number" in write.body.fields));
});

test("a pass whose bags already have tags still gets its pending row, and is told so", async () => {
  airtable.reset();
  tagTableStub({ byRaw: [CLAIMED_ROW] });

  // The passenger's second bag, or the system came back between scan and
  // claim. The row is made either way; the app can show the plates and decide.
  const body = await (await post("/app/passes", SCAN)).json();
  assert.equal(body.created, true);
  assert.equal(body.pending, true);
  assert.deepEqual(body.claimedTags, ["0592111111"]);
  assert.equal(writes()[0].method, "POST");
});

test("bcbpRaw is required; a fallback label that is not ZPL is dropped, not fatal", async () => {
  airtable.reset();
  tagTableStub();

  const missing = await post("/app/passes", { orderNumber: "i0lYC", passengerName: "JONSDOTTIR/SIGRIDUR" });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "bcbpRaw is required" });
  assert.deepEqual(airtable.calls, []);

  const bad = await post("/app/passes", { ...SCAN, zpl: "not a label", flightDate: "19/09/2026" });
  const body = await bad.json();
  assert.equal(bad.status, 200);
  assert.equal(body.created, true);
  assert.equal(body.label, "invalid");
  const fields = writes()[0].body.fields;
  assert.ok(!("Label ZPL" in fields));
  assert.ok(!("Flight Date" in fields), "a date in the wrong shape is left out, as /app/tags does");
});

test("the fallback label has its own size cap: a pass bitmap is stored, a tag that big is still not", async () => {
  // The app puts the scanned pass on the fallback label as an uncompressed ^GF
  // bitmap; a 60-char pass as Aztec is ~36k hex characters, and a mobile pass
  // as QR ~41k. Under the tag cap (20k) every one of them was dropped as "too
  // long", and the pending row had nothing to reprint from another phone.
  const bitmapLabel = "^XA^FO20,30^FDJONSDOTTIR/SIGRIDUR^FS^FO20,300^GFA,18144,18144,48," + "F".repeat(36288) + "^FS^XZ";
  airtable.reset();
  tagTableStub();
  let body = await (await post("/app/passes", { ...SCAN, zpl: bitmapLabel })).json();
  assert.equal(body.created, true);
  assert.equal(body.label, "stored");
  assert.equal(writes()[0].body.fields["Label ZPL"], bitmapLabel);

  // The cap on a TAG's label is unchanged: the same bytes sent with a plate
  // are still refused as a label, and the tag row is still written.
  airtable.reset();
  tagTableStub();
  body = await (await post("/app/tags", { tagNumber: "0592123456", zpl: bitmapLabel })).json();
  assert.equal(body.created, true);
  assert.equal(body.label, "invalid");
  assert.ok(!("Label ZPL" in writes()[0].body.fields));
  assert.equal(writes()[0].body.fields["BagTag Number"], "0592123456");

  // And a pass label past its own cap is dropped, not fatal — the row is
  // still worth more than the label.
  airtable.reset();
  tagTableStub();
  body = await (await post("/app/passes", { ...SCAN, zpl: "^XA".padEnd(60001, "F") })).json();
  assert.equal(body.created, true);
  assert.equal(body.label, "invalid");
  assert.ok(!("Label ZPL" in writes()[0].body.fields));
});

// ---------------------------------------------------------------------------
// POST /app/tags — the claim fills the pending row
// ---------------------------------------------------------------------------

test("a claimed tag fills the pending row for its pass instead of adding a second one", async () => {
  airtable.reset();
  tagTableStub({ byRaw: [PENDING_ROW] });

  // Exactly what TagBookkeeping and tag_log.py send for a claim.
  const res = await post("/app/tags", {
    tagNumber: "0592123456",
    orderNumber: "i0lYC",
    orderRecordId: "recORDER000000002",
    passengerName: "JONSDOTTIR/SIGRIDUR",
    pnr: "ABC123",
    flight: "FI 542",
    flightDate: "2026-09-19",
    destination: "PRG",
    bcbpRaw: RAW,
    uthringingarRecordId: "recUTH00000000001",
    zpl: REAL_ZPL,
    tagData: TAG_DATA,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: "recPASS0000000001", created: false, updated: true,
    label: "replaced", tagData: "stored", filledPending: true,
  });

  // The plate lookup first, as always; the pass only because it found nothing.
  assert.equal(formulaOf(airtable.calls[0].url), "{BagTag Number}='0592123456'");
  assert.equal(formulaOf(airtable.calls[1].url), `{BCBP Raw}='${RAW}'`);

  const all = writes();
  assert.equal(all.length, 1, "one PATCH, no POST");
  const [write] = all;
  assert.equal(write.method, "PATCH");
  assert.ok(write.url.endsWith("/recPASS0000000001"));
  assert.equal(write.body.fields["BagTag Number"], "0592123456");
  // The fallback label is not this tag's label: the real one lands over it.
  assert.equal(write.body.fields["Label ZPL"], REAL_ZPL);
  assert.deepEqual(JSON.parse(write.body.fields["Tag data"]), TAG_DATA);
  assert.deepEqual(write.body.fields["Order No copy"], ["recORDER000000001", "recORDER000000002"]);
  assert.ok(!("Úthringingar" in write.body.fields), "a link already there is not appended twice");
  assert.ok(!("Passenger Name" in write.body.fields), "filled cells stay filled");
});

test("a claim that brought no label clears the fallback rather than leave it posing as one", async () => {
  airtable.reset();
  tagTableStub({ byRaw: [PENDING_ROW] });

  const body = await (await post("/app/tags", { tagNumber: "0592123456", bcbpRaw: RAW })).json();
  assert.equal(body.filledPending, true);
  assert.equal(body.label, "cleared");

  const fields = writes()[0].body.fields;
  assert.equal(fields["BagTag Number"], "0592123456");
  assert.equal(fields["Label ZPL"], null, "cleared, so a later reprint log can store the real one");
});

test("a pending row that stored no fallback label simply gains the real one", async () => {
  airtable.reset();
  const { "Label ZPL": _, ...bare } = PENDING_ROW.fields;
  tagTableStub({ byRaw: [{ ...PENDING_ROW, fields: bare }] });

  const body = await (await post("/app/tags", { tagNumber: "0592123456", bcbpRaw: RAW, zpl: REAL_ZPL })).json();
  assert.equal(body.label, "stored");
  assert.equal(writes()[0].body.fields["Label ZPL"], REAL_ZPL);
});

test("the oldest pending row for a pass is the one filled", async () => {
  airtable.reset();
  const younger = { ...PENDING_ROW, id: "recPASS0000000002", createdTime: "2026-09-19T09:00:00.000Z" };
  tagTableStub({ byRaw: [younger, PENDING_ROW] });

  await post("/app/tags", { tagNumber: "0592123456", bcbpRaw: RAW });
  assert.ok(writes()[0].url.endsWith("/recPASS0000000001"));
});

test("a claim from another decoding of the pass fills the pending row the booking finds", async () => {
  airtable.reset();
  // The pending row was filed from the paper pass; the tag is claimed from the
  // wallet pass (or the Mac's PDF), whose raw carries the security block. No
  // row has that raw, so the booking is read: same flight, day and sequence.
  const signed = `${RAW}^164GIWVC5EH7JNT684FVNJ91W2QA4DVN5J8K4F0L0GEQ3DF5TGBN8709HKT5D3D`;
  const companion = {
    ...PENDING_ROW, id: "recPASSCOMPANION1", createdTime: "2026-09-19T07:00:00.000Z",
    fields: { ...PENDING_ROW.fields, "BCBP Raw": RAW.replace("JONSDOTTIR/SIGRIDUR ", "JONSSON/JON MR      ").replace("0001 ", "0002 ") },
  };
  tagTableStub({ pendingByPnr: [companion, PENDING_ROW] });

  const res = await post("/app/tags", { tagNumber: "0592123456", bcbpRaw: signed, zpl: REAL_ZPL });
  const body = await res.json();
  assert.equal(body.id, "recPASS0000000001");
  assert.equal(body.filledPending, true);

  // The raw first, then the booking's rows with no plate.
  assert.equal(formulaOf(airtable.calls[1].url), `{BCBP Raw}='${signed}'`);
  assert.equal(formulaOf(airtable.calls[2].url), "AND(LEN({BagTag Number}&'')=0,UPPER(TRIM({PNR}&''))='ABC123')");

  const all = writes();
  assert.equal(all.length, 1, "one PATCH, no POST");
  assert.ok(all[0].url.endsWith("/recPASS0000000001"), "the passenger's row, not the companion's");
  assert.equal(all[0].body.fields["BagTag Number"], "0592123456");
  assert.ok(!("BCBP Raw" in all[0].body.fields), "the row keeps the raw it was filed with");

  // A companion's pending row alone is not this bag's: a new row instead.
  airtable.reset();
  tagTableStub({ pendingByPnr: [companion] });
  const other = await (await post("/app/tags", { tagNumber: "0592123456", bcbpRaw: signed })).json();
  assert.equal(other.created, true);
  assert.equal(writes()[0].method, "POST");
});

test("a tag already known by its number never looks at the pass — the old path, byte for byte", async () => {
  airtable.reset();
  // A complete row — both order halves — so there is nothing to derive either.
  tagTableStub({
    byTag: [{ id: "recTAG00000000001", fields: {
      "BagTag Number": "0592123456", "Order No": "i0lYC", "Order No copy": ["recORDER0000i0lYC"], "BCBP Raw": RAW,
    } }],
    byRaw: [PENDING_ROW],
  });

  const res = await post("/app/tags", { tagNumber: "0592123456", bcbpRaw: RAW, passengerName: "JONSDOTTIR/SIGRIDUR" });
  assert.deepEqual(await res.json(), {
    id: "recTAG00000000001", created: false, updated: true, label: "none", tagData: "none",
  });

  const reads = airtable.calls.filter((c) => !c.options.method || c.options.method === "GET");
  assert.equal(reads.length, 1, "no second lookup when the plate is known");
  assert.ok(writes()[0].url.endsWith("/recTAG00000000001"));
});

test("a claim with no pending row behind it is the same create as before", async () => {
  airtable.reset();
  // The pass has a claimed row (the other bag) but nothing pending.
  tagTableStub({ byRaw: [CLAIMED_ROW] });

  const res = await post("/app/tags", {
    tagNumber: "0592123456", orderNumber: "i0lYC", orderRecordId: "recORDER000000001",
    passengerName: "JONSDOTTIR/SIGRIDUR", bcbpRaw: RAW, zpl: REAL_ZPL,
  });
  assert.deepEqual(await res.json(), {
    id: "recPASSnew0000001", created: true, updated: false, label: "stored", tagData: "none",
  });

  const [write] = writes();
  assert.equal(write.method, "POST");
  assert.equal(write.body.fields["BagTag Number"], "0592123456");
  assert.equal(write.body.fields["BCBP Raw"], RAW);
  assert.deepEqual(write.body.fields["Order No copy"], ["recORDER000000001"]);
});

test("a claim without a pass makes no pass lookup at all", async () => {
  airtable.reset();
  tagTableStub();

  await post("/app/tags", { tagNumber: "0592123456", orderNumber: "i0lYC" });
  // Two reads, neither of them for a pass: the plate lookup, and (since
  // 2026-09-25) the one read on Orders that turns the number into its link.
  const reads = airtable.calls.filter((c) => !c.options.method || c.options.method === "GET");
  assert.ok(!reads.some((c) => formulaOf(c.url).startsWith("{BCBP Raw}=")), "no pass lookup");
  assert.equal(reads.filter((c) => c.url.includes(TAGS)).length, 1, "one lookup of the tag table");
  assert.equal(writes()[0].method, "POST");
});

// ---------------------------------------------------------------------------
// GET /app/orders/:orderRef/tags — the pending pass is on the order
// ---------------------------------------------------------------------------

const ORDER = {
  id: "recORDER000000001",
  fields: { "Pöntunarnúmer (fx)": "i0lYC", "Tag numbers": ["recPASS0000000001"] },
};

function orderWithRowsStub(rows) {
  airtable.reply = (url) => {
    if (url.includes(`/${ORDERS}/`)) return { status: 200, body: JSON.stringify(ORDER) };
    if (url.includes(`/${ORDERS}?`)) return { status: 200, body: JSON.stringify({ records: [ORDER] }) };
    return { status: 200, body: JSON.stringify({ records: rows }) };
  };
}

test("the order's tag list shows the pending pass, in its place, with what the app claims from", async () => {
  airtable.reset();
  orderWithRowsStub([PENDING_ROW, CLAIMED_ROW]);

  const res = await boot.request("/app/orders/i0lYC/tags", { headers: AUTH });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.found, true);
  assert.equal(body.count, 2);
  // Oldest first, pending or not: the claimed bag came first that morning.
  assert.deepEqual(body.tags.map((t) => t.recordId), ["recTAGCLAIMED0001", "recPASS0000000001"]);

  assert.deepEqual(body.tags[1], {
    recordId: "recPASS0000000001",
    tagNumber: null,
    passengerName: "JONSDOTTIR/SIGRIDUR",
    pnr: "ABC123",
    flight: "FI 542",
    flightDate: "2026-09-19",
    destination: "PRG",
    delivered: false,
    hasLabel: true,
    hasPhoto: false,
    createdAt: "2026-09-19T08:00:00.000Z",
    pending: true,
    bcbpRaw: RAW,
  });
  assert.equal(body.tags[0].pending, false);
  assert.equal(body.tags[0].tagNumber, "0592111111");
  assert.equal(body.tags[0].bcbpRaw, RAW, "a claimed row keeps the pass it was issued for");

  // The pass is asked for along with the rest of the row.
  const tagCall = airtable.calls.find((c) => c.url.includes(TAGS));
  assert.ok(fieldsOf(tagCall.url).includes("BCBP Raw"));
});

test("?labels=1 carries the fallback label of a pending pass like any other", async () => {
  airtable.reset();
  orderWithRowsStub([PENDING_ROW]);

  const body = await (await boot.request("/app/orders/i0lYC/tags?labels=1", { headers: AUTH })).json();
  assert.equal(body.tags[0].pending, true);
  assert.equal(body.tags[0].zpl, FALLBACK_ZPL);
});

// ---------------------------------------------------------------------------
// GET /app/passes/pending?date= — the Mac's batch claim
// ---------------------------------------------------------------------------

const DAY_ORDERS = [
  { id: "recORDER000000001", fields: { "Pöntunarnúmer (fx)": "i0lYC", "Nafn viðskiptavinar": "Jón Jónsson", Greitt: true, "Dagsetning pick-up": "2026-09-19" } },
  { id: "recORDER000000002", fields: { "Pöntunarnúmer (fx)": "zzzzz", "Nafn viðskiptavinar": "Anna Önnudóttir", "Dagsetning pick-up": "2026-09-19" } },
];

// Three pending rows: one linked to the first order, one that reaches the
// second only by its "Order No" text, and one for an order on some other day.
const PENDING_ROWS = [
  PENDING_ROW,
  {
    id: "recPASS0000000002", createdTime: "2026-09-19T08:05:00.000Z",
    fields: { "BCBP Raw": "M1ONNUDOTTIR/ANNA EDEF456 KEFCPHFI 0204 262Y002A0002 100", "Order No": "zzzzz", "Passenger Name": "ONNUDOTTIR/ANNA", Flight: "FI 204" },
  },
  {
    id: "recPASS0000000003", createdTime: "2026-09-18T08:00:00.000Z",
    fields: { "BCBP Raw": "M1OTHER/DAY EGHI789 KEFLHRFI 0450 261Y001A0003 100", "Order No": "yyyyy", "Order No copy": ["recORDER000000077"] },
  },
];

function dayStub({ orders = DAY_ORDERS, rows = PENDING_ROWS } = {}) {
  airtable.reply = (url) => {
    if (url.includes(`/${ORDERS}?`)) return { status: 200, body: JSON.stringify({ records: orders }) };
    return { status: 200, body: JSON.stringify({ records: rows }) };
  };
}

test("the day's pending passes are joined to its orders through the pickup date", async () => {
  airtable.reset();
  dayStub();

  const res = await boot.request("/app/passes/pending?date=2026-09-19", { headers: AUTH });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.date, "2026-09-19");
  assert.equal(body.count, 2, "the other day's pass is not in the answer");
  assert.deepEqual(body.passes[0], {
    recordId: "recPASS0000000001",
    bcbpRaw: RAW,
    passengerName: "JONSDOTTIR/SIGRIDUR",
    pnr: "ABC123",
    flight: "FI 542",
    flightDate: "2026-09-19",
    destination: "PRG",
    orderNumber: "i0lYC",
    orderRecordId: "recORDER000000001",
    customerName: "Jón Jónsson",
    paid: true,
    pickupDate: "2026-09-19",
    uthringingarRecordId: "recUTH00000000001",
    hasLabel: true,
    createdAt: "2026-09-19T08:00:00.000Z",
  });
  // Reached by the "Order No" text alone, so the record id comes from the join.
  assert.equal(body.passes[1].orderNumber, "zzzzz");
  assert.equal(body.passes[1].orderRecordId, "recORDER000000002");
  assert.equal(body.passes[1].paid, false, "unpaid is reported, not hidden");
  assert.equal(body.passes[1].uthringingarRecordId, null);
  assert.equal(body.passes[1].hasLabel, false);

  // Orders are READ for the join, with only the fields it needs; the pending
  // rows are the ones with a pass and no plate.
  const [orderCall, tagCall] = airtable.calls;
  assert.ok(orderCall.url.includes(`/${ORDERS}?`));
  assert.equal(formulaOf(orderCall.url), "IS_SAME({Dagsetning pick-up}, '2026-09-19', 'day')");
  assert.deepEqual(fieldsOf(orderCall.url), ["Pöntunarnúmer (fx)", "Nafn viðskiptavinar", "Greitt", "Dagsetning pick-up"]);
  assert.ok(tagCall.url.includes(`/${TAGS}?`));
  assert.equal(formulaOf(tagCall.url), "AND(LEN({BagTag Number}&'')=0, LEN({BCBP Raw}&'')>0)");
  assert.ok(fieldsOf(tagCall.url).includes("Úthringingar"));
  assert.ok(!writes().length, "nothing is ever written by this route");
});

test("a day with no orders has no pending passes and costs one read", async () => {
  airtable.reset();
  dayStub({ orders: [] });

  const body = await (await boot.request("/app/passes/pending?date=2026-09-19", { headers: AUTH })).json();
  assert.deepEqual(body, { date: "2026-09-19", count: 0, passes: [] });
  assert.equal(airtable.calls.length, 1);
});

test("the date defaults to today and must be YYYY-MM-DD", async () => {
  airtable.reset();
  dayStub({ orders: [] });

  const today = new Date().toISOString().slice(0, 10);
  const body = await (await boot.request("/app/passes/pending", { headers: AUTH })).json();
  assert.equal(body.date, today);
  assert.ok(formulaOf(airtable.calls[0].url).includes(`'${today}'`));

  const bad = await boot.request("/app/passes/pending?date=19.9.2026", { headers: AUTH });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "date must be YYYY-MM-DD" });
});

test("an Airtable failure on either read is the shared error shape", async () => {
  airtable.reset();
  airtable.reply = () => ({ status: 500, body: "upstream is down" });

  const res = await boot.request("/app/passes/pending?date=2026-09-19", { headers: AUTH });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });

  airtable.reset();
  airtable.reply = () => ({ status: 500, body: "upstream is down" });
  const scan = await post("/app/passes", SCAN);
  assert.equal(scan.status, 502);
  assert.deepEqual(await scan.json(), { error: "Airtable request failed" });
});

// ---------------------------------------------------------------------------
// "Order No" and "Order No copy" are one fact, written twice (2026-09-25)
// ---------------------------------------------------------------------------
//
// The number is the last five characters of the Orders record id, so either
// half yields the other: the text from the id for free, the id from the text
// with one READ on Orders. On 2026-09-25 fourteen rows claimed from the Mac had
// the link and no text, and nine rows from the phone the text and no link.
// Both are closed here — for a new row, for a row that already exists with one
// half, for the pending row a claim fills, and for POST /app/passes.

const ORDER_ID = "recORDER0000i0lYC";   // ends in the order number, as every real one does
const ORDER_ROW = { id: ORDER_ID, fields: { "Pöntunarnúmer (fx)": "i0lYC" } };
const isOrdersRead = (c) => c.url.includes(`/${ORDERS}?`);
const readCalls = () => airtable.calls.filter((c) => !c.options.method || c.options.method === "GET");

test("a record id alone yields the text — no lookup, and nothing invented from a bad id", async () => {
  airtable.reset();
  tagTableStub();
  await post("/app/tags", { tagNumber: "0592123456", orderRecordId: ORDER_ID });
  let fields = writes()[0].body.fields;
  assert.equal(fields["Order No"], "i0lYC");
  assert.deepEqual(fields["Order No copy"], [ORDER_ID]);
  assert.ok(!readCalls().some(isOrdersRead), "the number is in the id; Orders is not asked");

  // A value that is not a record id derives nothing: the text is not made up.
  airtable.reset();
  tagTableStub();
  await post("/app/tags", { tagNumber: "0592123456", orderRecordId: "not-a-record-id" });
  fields = writes()[0].body.fields;
  assert.ok(!("Order No" in fields));
  assert.ok(!readCalls().some(isOrdersRead));
});

test("a number alone resolves the link with ONE read on Orders — a read, never a write", async () => {
  airtable.reset();
  tagTableStub({ orders: [ORDER_ROW] });
  const res = await post("/app/tags", { tagNumber: "0592123456", orderNumber: "i0lYC", passengerName: "JONSDOTTIR/SIGRIDUR" });
  assert.equal(res.status, 200);

  const asks = readCalls().filter(isOrdersRead);
  assert.equal(asks.length, 1, "one read on Orders");
  assert.equal(formulaOf(asks[0].url), "{Pöntunarnúmer (fx)}='i0lYC'");
  assert.deepEqual(fieldsOf(asks[0].url), ["Pöntunarnúmer (fx)"], "the number field only, not the whole row");
  assert.equal(new URL(asks[0].url).searchParams.get("maxRecords"), "1");

  const [write] = writes();
  assert.equal(write.method, "POST");
  assert.ok(write.url.includes(TAGS));
  assert.equal(write.body.fields["Order No"], "i0lYC");
  assert.deepEqual(write.body.fields["Order No copy"], [ORDER_ID]);
  assert.ok(!writes().some((w) => w.url.includes(ORDERS)), "Orders is never written to");
});

test("a number with no such order keeps the text and simply has no link", async () => {
  airtable.reset();
  tagTableStub({ orders: [] });
  const res = await post("/app/tags", { tagNumber: "0592123456", orderNumber: "zzzzz" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).created, true);
  const fields = writes()[0].body.fields;
  assert.equal(fields["Order No"], "zzzzz");
  assert.ok(!("Order No copy" in fields));
});

test("an Orders read that fails costs the link, never the tag", async () => {
  airtable.reset();
  tagTableStub();
  const inner = airtable.reply;
  airtable.reply = (url, options) => (isOrdersRead({ url }) ? { status: 500, body: "orders is down" } : inner(url, options));

  const res = await post("/app/tags", { tagNumber: "0592123456", orderNumber: "i0lYC" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).created, true);
  const fields = writes()[0].body.fields;
  assert.equal(fields["BagTag Number"], "0592123456");
  assert.equal(fields["Order No"], "i0lYC");
  assert.ok(!("Order No copy" in fields));
});

test("both halves sent is the old path: no Orders read at all", async () => {
  airtable.reset();
  tagTableStub();
  await post("/app/tags", { tagNumber: "0592123456", orderNumber: "i0lYC", orderRecordId: ORDER_ID });
  assert.ok(!readCalls().some(isOrdersRead));
  const fields = writes()[0].body.fields;
  assert.equal(fields["Order No"], "i0lYC");
  assert.deepEqual(fields["Order No copy"], [ORDER_ID]);
});

test("a row with the link and no text gains the text from its own link, whatever the request brought", async () => {
  // The Mac's fourteen rows of 2026-09-25: linked to the order, "Order No" blank.
  airtable.reset();
  tagTableStub({ byTag: [{ id: "recTAG00000000001", fields: { "BagTag Number": "0592123456", "Order No copy": [ORDER_ID] } }] });

  const res = await post("/app/tags", { tagNumber: "0592123456", zpl: REAL_ZPL });
  assert.equal((await res.json()).updated, true);
  const [write] = writes();
  assert.equal(write.method, "PATCH");
  assert.equal(write.body.fields["Order No"], "i0lYC");
  assert.ok(!("Order No copy" in write.body.fields), "the link it has is left alone");
  assert.ok(!readCalls().some(isOrdersRead), "the number is in the link; Orders is not asked");
});

test("a row with the text and no link gains the link with one read, whatever the request brought", async () => {
  // The phone's nine rows of 2026-09-25: "Order No" filled, no link.
  airtable.reset();
  tagTableStub({
    byTag: [{ id: "recTAG00000000001", fields: { "BagTag Number": "0592123456", "Order No": "i0lYC" } }],
    orders: [ORDER_ROW],
  });

  const res = await post("/app/tags", { tagNumber: "0592123456", passengerName: "JONSDOTTIR/SIGRIDUR" });
  assert.equal((await res.json()).updated, true);
  const [write] = writes();
  assert.equal(write.method, "PATCH");
  assert.deepEqual(write.body.fields["Order No copy"], [ORDER_ID]);
  assert.ok(!("Order No" in write.body.fields), "the text it has is left alone");
  assert.equal(readCalls().filter(isOrdersRead).length, 1);
});

test("a re-sent tag whose row is already complete costs no Orders read and no write", async () => {
  // The phone re-sends after a dropped connection, number only. The id is on
  // the row already, so nothing is asked and nothing is written.
  airtable.reset();
  tagTableStub({
    byTag: [{ id: "recTAG00000000001", fields: { "BagTag Number": "0592123456", "Order No": "i0lYC", "Order No copy": [ORDER_ID] } }],
  });
  const body = await (await post("/app/tags", { tagNumber: "0592123456", orderNumber: "i0lYC" })).json();
  assert.deepEqual(body, { id: "recTAG00000000001", created: false, updated: false, label: "none", tagData: "none" });
  assert.equal(readCalls().length, 1, "the plate lookup only");
  assert.deepEqual(writes(), []);
});

test("the request's order comes first; the row's own halves complete only what the request left", async () => {
  // Linked to one order with no text; the request names ANOTHER order by number.
  // The text is the request's (fill-blanks, as ever) and its link is appended;
  // the row's link is not turned into a competing text.
  airtable.reset();
  tagTableStub({
    byTag: [{ id: "recTAG00000000001", fields: { "BagTag Number": "0592123456", "Order No copy": [ORDER_ID] } }],
    orders: [{ id: "recORDER0000zzzzz", fields: { "Pöntunarnúmer (fx)": "zzzzz" } }],
  });
  await post("/app/tags", { tagNumber: "0592123456", orderNumber: "zzzzz" });
  const fields = writes()[0].body.fields;
  assert.equal(fields["Order No"], "zzzzz");
  assert.deepEqual(fields["Order No copy"], [ORDER_ID, "recORDER0000zzzzz"]);
});

test("a claim that fills a pending row completes the row's order too", async () => {
  // The scan got through with the number only; the claim brings the plate and the pass.
  airtable.reset();
  tagTableStub({
    byRaw: [{ id: "recPASS0000000001", fields: { "BCBP Raw": RAW, "Order No": "i0lYC" } }],
    orders: [ORDER_ROW],
  });
  const body = await (await post("/app/tags", { tagNumber: "0592123456", bcbpRaw: RAW })).json();
  assert.equal(body.filledPending, true);
  const fields = writes()[0].body.fields;
  assert.equal(fields["BagTag Number"], "0592123456");
  assert.deepEqual(fields["Order No copy"], [ORDER_ID]);
  assert.equal(readCalls().filter(isOrdersRead).length, 1);
});

test("POST /app/passes completes the pair the same way, new row and pending row alike", async () => {
  // A scan with the record id only: the text is derived, nothing is asked.
  airtable.reset();
  tagTableStub();
  const { orderNumber: _n, ...withIdOnly } = SCAN;
  await post("/app/passes", { ...withIdOnly, orderRecordId: ORDER_ID });
  let fields = writes()[0].body.fields;
  assert.equal(fields["Order No"], "i0lYC");
  assert.deepEqual(fields["Order No copy"], [ORDER_ID]);
  assert.ok(!readCalls().some(isOrdersRead));

  // A scan with the number only: one read, and the link lands.
  airtable.reset();
  tagTableStub({ orders: [ORDER_ROW] });
  const { orderRecordId: _r, ...withNumberOnly } = SCAN;
  await post("/app/passes", withNumberOnly);
  fields = writes()[0].body.fields;
  assert.equal(fields["Order No"], "i0lYC");
  assert.deepEqual(fields["Order No copy"], [ORDER_ID]);
  assert.equal(readCalls().filter(isOrdersRead).length, 1);

  // A pending row with the link only, scanned again by a phone that sends
  // nothing about the order: the text is filled from the row's own link.
  airtable.reset();
  tagTableStub({ byRaw: [{ id: "recPASS0000000001", fields: { "BCBP Raw": RAW, "Order No copy": [ORDER_ID] } }] });
  const body = await (await post("/app/passes", { bcbpRaw: RAW })).json();
  assert.equal(body.updated, true);
  fields = writes()[0].body.fields;
  assert.equal(fields["Order No"], "i0lYC");
  assert.ok(!("Order No copy" in fields));
  assert.ok(!readCalls().some(isOrdersRead));
  assert.ok(!writes().some((w) => w.url.includes(ORDERS)), "Orders is never written to");
});

// ---------------------------------------------------------------------------
// The guard in front of both
// ---------------------------------------------------------------------------

test("the pass routes sit behind requireAppToken like every other /app route", async () => {
  airtable.reset();

  const get = await boot.request("/app/passes/pending?date=2026-09-19");
  assert.equal(get.status, 401);
  assert.deepEqual(await get.json(), { error: "Unauthorized" });

  const wrong = await post("/app/passes", SCAN, { "x-app-token": "x".repeat(APP_TOKEN.length) });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: "Unauthorized" });

  assert.deepEqual(airtable.calls, [], "an unauthorized request must never reach Airtable");
});
