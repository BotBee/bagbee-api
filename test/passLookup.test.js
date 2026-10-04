// GET /app/passes/lookup — a scanned boarding pass finds the tag already
// claimed for it (build 69, 2026-10-04).
//
// "Skanna QR-kóða" printed BagBee's own label for every pass and knew nothing of
// claimed tags, and inside an order's check-in a pass whose tag was claimed on
// the Mac or another phone would claim a second one. The lookup answers which
// plates (and which pending pass rows) already belong to the pass: first by the
// raw barcode as stored, then by the booking — the same passenger on the same
// flight — because the Mac decodes the PDF and a phone the paper, and two
// decoders need not agree byte for byte.
//
// Everything drives the real index.js through test/_indexHarness.js.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { bootIndex, airtable, APP_TOKEN } from "./_indexHarness.js";

const boot = await bootIndex();
after(() => boot.close());

const TAGS = "tblVyZakUmK0CY0YJ";
const AUTH = { "x-app-token": APP_TOKEN };

/// A pass laid out field by field at the IATA 792 'M' positions, so a test can
/// change one field and keep every other one where a decoder expects it.
function bcbp({
  name = "JONSDOTTIR/SIGRIDUR", pnr = "ABC123", from = "KEF", to = "PRG", carrier = "FI",
  flight = "0542", julian = "262", seat = "012A", seq = "0001", tail = "100",
} = {}) {
  return "M1" + name.padEnd(20).slice(0, 20) + "E" + pnr.padEnd(7) + from + to +
    carrier.padEnd(3) + flight.padEnd(5) + julian + "Y" + seat.padEnd(4) + seq.padEnd(5) + tail;
}

const RAW = bcbp();
// The same pass through a decoder that keeps the airline's security block.
const RAW_SIGNED = `${RAW}^164GIWVC5EH7JNT684FVNJ91W2QA4DVN5J8K4F0L0GEQ3DF5TGBN8709HKT5D3DW3GBHFCVHMY7J5T6HFR4`;

const formulaOf = (url) => decodeURIComponent(new URL(url).searchParams.get("filterByFormula") || "");
const fieldsOf = (url) => new URL(url).searchParams.getAll("fields[]");
const lookup = (raw, headers = AUTH) =>
  boot.request(`/app/passes/lookup?raw=${encodeURIComponent(raw)}`, { headers });

const PNR_FORMULA = (pnr) => `UPPER(TRIM({PNR}&''))='${pnr}'`;

/// The tag table answered by formula: `byRaw` for the exact read (passRows),
/// `byPnr` for the booking read. Anything else is a test failure.
function stub({ byRaw = [], byPnr = [] } = {}) {
  airtable.reply = (url, options = {}) => {
    assert.ok(!options.method || options.method === "GET", "the lookup never writes");
    assert.ok(url.includes(`/${TAGS}?`), `only the tag table is read: ${url}`);
    const formula = formulaOf(url);
    if (formula.startsWith("{BCBP Raw}=")) return { status: 200, body: JSON.stringify({ records: byRaw }) };
    if (formula.startsWith("UPPER(TRIM({PNR}")) return { status: 200, body: JSON.stringify({ records: byPnr }) };
    throw new Error(`unexpected read: ${formula}`);
  };
}

/// A claimed row as the phone's check-in writes it, with the fields the lookup
/// must NOT pass on (the vendor record, the customer's contact details).
function claimedRow(id, tag, over = {}) {
  return {
    id,
    createdTime: "2026-09-19T07:00:00.000Z",
    fields: {
      "BagTag Number": tag, "BCBP Raw": RAW, PNR: "ABC123", "Passenger Name": "JONSDOTTIR/SIGRIDUR",
      Flight: "FI 542", "Flight Date": "2026-09-19", Destination: "PRG",
      "Order No": "i0lYC", "Order No copy": ["recORDER0000i0lYC"],
      "Label ZPL": `^XA^FO20,200^FD${tag}^FS^XZ`, "Tag data": '{"tagNumber":"x"}',
      Email: "someone@example.com", Phone: "+354 555 0000",
      ...over,
    },
  };
}

const PENDING_ROW = {
  id: "recPASS0000000001",
  createdTime: "2026-09-19T08:00:00.000Z",
  fields: {
    "BCBP Raw": RAW, PNR: "ABC123", "Passenger Name": "JONSDOTTIR/SIGRIDUR", Flight: "FI 542",
    "Flight Date": "2026-09-19", Destination: "PRG", "Order No": "i0lYC",
    "Order No copy": ["recORDER0000i0lYC"], "Label ZPL": "^XA^FDfallback^FS^XZ",
  },
};

/// What the answer carries for a claimed row built by claimedRow().
function claimedEntry(id, tag, over = {}) {
  return {
    recordId: id, tagNumber: tag, orderNumber: "i0lYC", orderRecordId: "recORDER0000i0lYC",
    passengerName: "JONSDOTTIR/SIGRIDUR", flight: "FI 542", flightDate: "2026-09-19",
    destination: "PRG", hasLabel: true, photographed: false, ...over,
  };
}

// ---------------------------------------------------------------------------

test("a pass whose tag was claimed from the same scan is an exact match, and only the plate's facts come back", async () => {
  airtable.reset();
  const row = claimedRow("recTAG00000000001", "0108123456", {
    Attachments: [{ id: "att1", url: "https://dl.airtable.com/x.jpg" }],
  });
  // The booking read finds the same row again; it is one tag, not two.
  stub({ byRaw: [row], byPnr: [row] });

  const res = await lookup(RAW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    match: "exact",
    claimed: [claimedEntry("recTAG00000000001", "0108123456", { photographed: true })],
    pending: [],
  });

  // Two reads of the tag table and nothing else: the raw as stored, and the booking.
  assert.equal(airtable.calls.length, 2);
  const formulas = airtable.calls.map((c) => formulaOf(c.url)).sort();
  assert.deepEqual(formulas, [PNR_FORMULA("ABC123"), `{BCBP Raw}='${RAW}'`].sort());
  const bookingRead = airtable.calls.find((c) => formulaOf(c.url).startsWith("UPPER("));
  assert.deepEqual(fieldsOf(bookingRead.url), [
    "BagTag Number", "BCBP Raw", "PNR", "Passenger Name", "Flight", "Flight Date",
    "Destination", "Order No", "Order No copy", "Label ZPL", "Attachments",
  ]);
});

test("a pass decoded differently elsewhere (security block, trailing spaces, zeros) is found by the booking", async () => {
  airtable.reset();
  // Claimed on the Mac from the PDF, whose decoder kept the security block; the
  // phone's scan has none. Linked to the order only, never given the text.
  const mac = claimedRow("recTAGMAC00000001", "0108111111", {
    "BCBP Raw": RAW_SIGNED, "Order No": undefined, "Order No copy": ["recORDER0000i0lYC"],
  });
  // The other bag, logged by a writer that kept the trailing spaces and wrote
  // the flight number without its leading zero.
  const spaced = claimedRow("recTAGSPACED00001", "0108222222", {
    "BCBP Raw": `${bcbp({ flight: "542" })}   `, "Label ZPL": "  ",
  });
  stub({ byRaw: [], byPnr: [spaced, mac] });

  const res = await lookup(RAW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    match: "tolerant",
    claimed: [
      claimedEntry("recTAGMAC00000001", "0108111111"),
      claimedEntry("recTAGSPACED00001", "0108222222", { hasLabel: false }),
    ],
    pending: [],
  });

  // And the other way round: the phone's scan carries the security block, the
  // row the Mac stored does not.
  airtable.reset();
  stub({ byRaw: [], byPnr: [claimedRow("recTAG00000000001", "0108123456")] });
  const signed = await (await lookup(RAW_SIGNED)).json();
  assert.equal(signed.match, "tolerant");
  assert.deepEqual(signed.claimed.map((t) => t.tagNumber), ["0108123456"]);
});

test("a row with no stored pass is matched on PNR, name and flight", async () => {
  airtable.reset();
  // Typed by hand: the name as the passenger writes it, the flight run together.
  const byHand = claimedRow("recTAGHAND0000001", "0108333333", {
    "BCBP Raw": undefined, "Passenger Name": "Sigríður Anna Jónsdóttir", Flight: "fi0542",
  });
  // The pass cuts a long name at 20 characters and appends the title.
  const longRaw = bcbp({ name: "GUDMUNDSDOTTIR/THORU", pnr: "XYZ789", seq: "0007" });
  const thorunn = claimedRow("recTAGHAND0000002", "0108444444", {
    "BCBP Raw": undefined, PNR: "XYZ789", "Passenger Name": "GUDMUNDSDOTTIR/THORUNN MS", "Flight Date": undefined,
  });

  stub({ byPnr: [byHand] });
  let body = await (await lookup(RAW)).json();
  assert.equal(body.match, "tolerant");
  assert.deepEqual(body.claimed.map((t) => t.recordId), ["recTAGHAND0000001"]);
  assert.equal(body.claimed[0].passengerName, "Sigríður Anna Jónsdóttir");

  airtable.reset();
  stub({ byPnr: [thorunn] });
  body = await (await lookup(longRaw)).json();
  assert.equal(body.match, "tolerant");
  assert.deepEqual(body.claimed.map((t) => t.recordId), ["recTAGHAND0000002"]);
  assert.equal(body.claimed[0].flightDate, null);
});

test("the rest of the booking is not this pass: other passengers, the return leg, another day", async () => {
  airtable.reset();
  stub({
    byRaw: [],
    byPnr: [
      // Same flight, the travelling companion: another check-in sequence number.
      claimedRow("recOTHERPAX000001", "0108900001", { "BCBP Raw": bcbp({ name: "JONSSON/JON MR", seq: "0002" }) }),
      // Same sequence number, but the flight home a week later.
      claimedRow("recRETURNLEG00001", "0108900002", { "BCBP Raw": bcbp({ from: "PRG", to: "KEF", flight: "0543", julian: "269" }) }),
      // Same flight number, a different day.
      claimedRow("recOTHERDAY000001", "0108900003", { "BCBP Raw": bcbp({ julian: "263" }) }),
      // Another carrier.
      claimedRow("recOTHERCARR00001", "0108900004", { "BCBP Raw": bcbp({ carrier: "SK" }) }),
      // Typed by hand: the sister, the right flight.
      claimedRow("recHANDSISTER0001", "0108900005", { "BCBP Raw": undefined, "Passenger Name": "Anna Jónsdóttir" }),
      // Typed by hand: the right name, the wrong flight, and the wrong day.
      claimedRow("recHANDFLIGHT0001", "0108900006", { "BCBP Raw": undefined, Flight: "FI 543" }),
      claimedRow("recHANDDATE000001", "0108900007", { "BCBP Raw": undefined, "Flight Date": "2026-09-20" }),
      // A name with no given name cannot tell family members apart.
      claimedRow("recHANDSURNAME001", "0108900008", { "BCBP Raw": undefined, "Passenger Name": "JONSDOTTIR/MRS" }),
      claimedRow("recHANDSURNAME002", "0108900009", { "BCBP Raw": undefined, "Passenger Name": "Jónsdóttir" }),
    ],
  });

  const res = await lookup(RAW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { match: "none", claimed: [], pending: [] });
});

test("nothing on the pass or the booking is none", async () => {
  airtable.reset();
  stub();

  const res = await lookup(RAW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { match: "none", claimed: [], pending: [] });
});

test("something that is not a boarding pass is looked up by its raw only", async () => {
  airtable.reset();
  stub();

  const res = await lookup("i0lYC");
  assert.deepEqual(await res.json(), { match: "none", claimed: [], pending: [] });
  assert.equal(airtable.calls.length, 1, "no booking read without a PNR to read");
  assert.equal(formulaOf(airtable.calls[0].url), "{BCBP Raw}='i0lYC'");
});

test("a passenger with two bags gets both tags, sorted by tag number", async () => {
  airtable.reset();
  // The plates were not claimed in number order; the answer is in it anyway.
  const first = claimedRow("recTAGBAG00000002", "0108500002", { "Label ZPL": undefined });
  const second = { ...claimedRow("recTAGBAG00000001", "0108500001"), createdTime: "2026-09-19T07:05:00.000Z" };
  stub({ byRaw: [first, second], byPnr: [first, second] });

  const body = await (await lookup(RAW)).json();
  assert.deepEqual(body, {
    match: "exact",
    claimed: [
      claimedEntry("recTAGBAG00000001", "0108500001"),
      claimedEntry("recTAGBAG00000002", "0108500002", { hasLabel: false }),
    ],
    pending: [],
  });
});

test("a pass scanned while check-in was down, with no tag yet, is pending only", async () => {
  airtable.reset();
  stub({ byRaw: [PENDING_ROW], byPnr: [PENDING_ROW] });

  const res = await lookup(RAW);
  assert.deepEqual(await res.json(), {
    match: "exact",
    claimed: [],
    pending: [{
      recordId: "recPASS0000000001", orderNumber: "i0lYC", orderRecordId: "recORDER0000i0lYC",
      passengerName: "JONSDOTTIR/SIGRIDUR",
    }],
  });
});

test("a pending row from the phone and a tag the Mac claimed from the PDF are both on the answer", async () => {
  airtable.reset();
  // The pending row has the phone's raw; the Mac claimed the bag from its own
  // decoding, so POST /app/tags never filled the pending row.
  const mac = claimedRow("recTAGMAC00000001", "0108111111", { "BCBP Raw": RAW_SIGNED });
  const unlinked = { ...PENDING_ROW, fields: { ...PENDING_ROW.fields, "Order No": "", "Order No copy": undefined } };
  stub({ byRaw: [unlinked], byPnr: [unlinked, mac] });

  const body = await (await lookup(RAW)).json();
  assert.deepEqual(body, {
    match: "tolerant",
    claimed: [claimedEntry("recTAGMAC00000001", "0108111111")],
    pending: [{ recordId: "recPASS0000000001", orderNumber: null, orderRecordId: null, passengerName: "JONSDOTTIR/SIGRIDUR" }],
  });
});

test("raw is required and at most 400 characters; a refused request reads nothing", async () => {
  airtable.reset();
  stub();

  for (const path of [
    "/app/passes/lookup",
    "/app/passes/lookup?raw=",
    "/app/passes/lookup?raw=%20%20%20",
    "/app/passes/lookup?raw=a&raw=b",
    "/app/passes/lookup?raw[x]=a",
  ]) {
    const res = await boot.request(path, { headers: AUTH });
    assert.equal(res.status, 400, path);
    assert.deepEqual(await res.json(), { error: "raw is required" }, path);
  }

  const long = await lookup(RAW + "X".repeat(401 - RAW.length));
  assert.equal(long.status, 400);
  assert.deepEqual(await long.json(), { error: "raw must be at most 400 characters" });
  assert.deepEqual(airtable.calls, []);

  // 400 itself is fine.
  const edge = await lookup(RAW + "X".repeat(400 - RAW.length));
  assert.equal(edge.status, 200);
});

test("the lookup stays behind the app token", async () => {
  airtable.reset();
  stub();

  for (const headers of [{}, { "x-app-token": "nope" }]) {
    const res = await lookup(RAW, headers);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
  }
  assert.deepEqual(airtable.calls, [], "an unauthorized request must never reach Airtable");
});

test("a quote or backslash in the pass cannot break out of either formula", async () => {
  airtable.reset();
  stub();

  // The name and the PNR are free text on a barcode anyone can print.
  const hostile = bcbp({ name: "X'),TRUE(),('\\/Y", pnr: "AB'\\C" });
  const res = await lookup(hostile);
  assert.equal(res.status, 200);

  const escaped = hostile.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const formulas = airtable.calls.map((c) => formulaOf(c.url));
  assert.ok(formulas.includes(`{BCBP Raw}='${escaped}'`), formulas.join("\n"));
  assert.ok(formulas.includes("UPPER(TRIM({PNR}&''))='AB\\'\\\\C'"), formulas.join("\n"));
});

test("an Airtable failure is the usual error shape", async () => {
  airtable.reset();
  airtable.reply = () => ({ status: 503, body: '{"error":"SERVICE_UNAVAILABLE"}' });

  const res = await lookup(RAW);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });
});
