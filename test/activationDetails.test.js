// src/activationDetails.js — passenger, flight and flight date for the
// activation mail (Rúnar, 2026-10-09), resolved and rendered without a server.
//
// The module is pure: it reads through the `read(table, params, signal)` it is
// handed. The stub below holds the three tables in memory, answers the same
// formulas Airtable would, and records every read so the tests can hold the
// lookup to one read per table.

import test from "node:test";
import assert from "node:assert/strict";
import {
  TAG_TABLE, UTHRINGINGAR_TABLE, ORDERS_TABLE, UTHR, ORDER, TAG_DETAIL_FIELDS,
  resolveActivationDetails, renderActivationMail, formatFlightDate, cleanValue, mergeSources,
} from "../src/activationDetails.js";

const UTHR_ROW = "recUTHR0000000001";
const UTHR_ROW_2 = "recUTHR0000000002";
const ORDER_ROW = "recORDER0000i0lYC";
const ORDER_ROW_2 = "recteH7tBgVi8hkR1";

/// A tag row as the deliveries route reads it (fields by name).
const tagRow = (id, fields) => ({ id, createdTime: "2026-10-08T19:54:26.000Z", fields });

/// The three tables, answering RECORD_ID(), RIGHT(RECORD_ID(), 5) and
/// TRIM({BagTag Number}) terms like Airtable would.
function stubTables({ tags = [], uthr = {}, orders = {}, fail = {}, hang = {} } = {}) {
  const reads = [];
  const read = async (table, params, signal) => {
    const p = new URLSearchParams(params);
    const formula = p.get("filterByFormula") || "";
    reads.push({ table, formula, fields: p.getAll("fields[]"), byId: p.get("returnFieldsByFieldId") });
    if (hang[table]) {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    if (fail[table]) throw Object.assign(new Error(`Airtable ${fail[table]}`), { status: fail[table] });
    const ids = [...formula.matchAll(/RECORD_ID\(\)='(rec[A-Za-z0-9]{14})'/g)].map((m) => m[1]);
    const suffixes = [...formula.matchAll(/RIGHT\(RECORD_ID\(\), 5\)='([^']*)'/g)].map((m) => m[1].toLowerCase());
    const tagNumbers = [...formula.matchAll(/TRIM\(\{BagTag Number\}\)='([^']*)'/g)].map((m) => m[1]);
    if (table === TAG_TABLE) return tags.filter((r) => tagNumbers.includes(String(r.fields["BagTag Number"]).trim()));
    const store = table === UTHRINGINGAR_TABLE ? uthr : table === ORDERS_TABLE ? orders : {};
    // Case-insensitive on the suffix, the worst Airtable could do.
    return Object.entries(store)
      .filter(([id]) => ids.includes(id) || suffixes.includes(id.slice(-5).toLowerCase()))
      .map(([id, fields]) => ({ id, fields }));
  };
  return { read, reads, readsOf: (table) => reads.filter((r) => r.table === table) };
}

const uthrFields = (over = {}) => ({
  [UTHR.name]: "Sigríður Jónsdóttir",
  [UTHR.bookingRef]: "UTH123",
  [UTHR.flight]: "FI204",
  [UTHR.flightDate]: "2026-10-09",
  ...over,
});
const orderFields = (over = {}) => ({
  [ORDER.name]: "Jón Jónsson",
  [ORDER.flight]: "NO5901",
  [ORDER.flightDate]: "2026-10-09",
  ...over,
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test("a boarding-pass tag is described from its own row, with no further reads", async () => {
  const t = stubTables();
  const rows = [tagRow("recTAG00000000001", {
    "BagTag Number": "0108005884", "Passenger Name": "JONSDOTTIR/SIGRIDUR", PNR: "ABC123",
    Flight: "FI204", "Flight Date": "2026-10-09", "Úthringingar": [UTHR_ROW], "Order No copy": [ORDER_ROW],
  })];
  const { details, problems } = await resolveActivationDetails({ tagNumbers: ["0108005884"], tagRecords: rows, read: t.read });
  assert.deepEqual(problems, []);
  assert.deepEqual(details.get("0108005884"), {
    found: true, passenger: "JONSDOTTIR/SIGRIDUR", passengerOnBooking: false, pnr: "ABC123", flight: "FI204", flightDate: "2026-10-09",
  });
  assert.equal(t.reads.length, 0, "everything was on the row already");
});

test("a tag printed from an order (Order No only) takes flight, date and the booker's name from the order, marked as such", async () => {
  const t = stubTables({ orders: { [ORDER_ROW_2]: orderFields() } });
  const rows = [tagRow("recvkWAUjTdN0Zm5I", { "BagTag Number": "0523490818", "Order No": "8hkR1" })];
  const { details } = await resolveActivationDetails({ tagNumbers: ["0523490818"], tagRecords: rows, read: t.read });
  assert.deepEqual(details.get("0523490818"), {
    found: true, passenger: "Jón Jónsson", passengerOnBooking: true, pnr: null, flight: "NO5901", flightDate: "2026-10-09",
  });
  const [orders] = t.readsOf(ORDERS_TABLE);
  assert.equal(orders.formula, "RIGHT(RECORD_ID(), 5)='8hkR1'", "by the number the id ends in, not a field name");
  assert.equal(orders.byId, "true");
  assert.deepEqual(orders.fields.sort(), Object.values(ORDER).sort(), "only the three fields it needs");
  assert.equal(t.readsOf(UTHRINGINGAR_TABLE).length, 0, "no check-in row linked, nothing to read");
});

test("the per-passenger check-in row beats the order's booker; the tag row beats both, field by field", async () => {
  const t = stubTables({
    uthr: { [UTHR_ROW]: uthrFields({ [UTHR.bookingRef]: "UTH123" }) },
    orders: { [ORDER_ROW]: orderFields({ [ORDER.flight]: "FI204" }) },
  });
  const rows = [
    // Own flight only: name, PNR and date come from Úthringingar.
    tagRow("recTAG00000000001", { "BagTag Number": "0108000001", Flight: "FI 204", "Úthringingar": [UTHR_ROW], "Order No copy": [ORDER_ROW] }),
    // Own PNR only, no check-in row: the rest from the order.
    tagRow("recTAG00000000002", { "BagTag Number": "0108000002", PNR: "OWN999", "Order No copy": [ORDER_ROW] }),
  ];
  const { details } = await resolveActivationDetails({ tagNumbers: ["0108000001", "0108000002"], tagRecords: rows, read: t.read });
  assert.deepEqual(details.get("0108000001"), {
    found: true, passenger: "Sigríður Jónsdóttir", passengerOnBooking: false, pnr: "UTH123", flight: "FI 204", flightDate: "2026-10-09",
  });
  assert.deepEqual(details.get("0108000002"), {
    found: true, passenger: "Jón Jónsson", passengerOnBooking: true, pnr: "OWN999", flight: "FI204", flightDate: "2026-10-09",
  });
  assert.equal(t.readsOf(UTHRINGINGAR_TABLE).length, 1);
  assert.equal(t.readsOf(ORDERS_TABLE).length, 1, "one Orders read for every tag that needs it");
  assert.equal(t.readsOf(ORDERS_TABLE)[0].formula, `RECORD_ID()='${ORDER_ROW}'`, "complete after Úthringingar: tag 1 needs no order");
});

test("with no order link on the tag, the check-in row's own order link is followed", async () => {
  const t = stubTables({
    uthr: { [UTHR_ROW]: { [UTHR.name]: "Anna Smith", [UTHR.order]: [ORDER_ROW] } },
    orders: { [ORDER_ROW]: orderFields() },
  });
  const rows = [tagRow("recTAG00000000001", { "BagTag Number": "0108000001", "Úthringingar": [UTHR_ROW] })];
  const { details } = await resolveActivationDetails({ tagNumbers: ["0108000001"], tagRecords: rows, read: t.read });
  assert.deepEqual(details.get("0108000001"), {
    found: true, passenger: "Anna Smith", passengerOnBooking: false, pnr: null, flight: "NO5901", flightDate: "2026-10-09",
  });
});

test("a date is only taken with its own flight: another flight's date is not borrowed", async () => {
  const t = stubTables({ orders: { [ORDER_ROW]: orderFields({ [ORDER.flight]: "FI450", [ORDER.flightDate]: "2026-10-12" }) } });
  const rows = [tagRow("recTAG00000000001", { "BagTag Number": "0108000001", "Passenger Name": "DOE/JANE", Flight: "FI204", "Order No copy": [ORDER_ROW] })];
  const { details } = await resolveActivationDetails({ tagNumbers: ["0108000001"], tagRecords: rows, read: t.read });
  assert.equal(details.get("0108000001").flight, "FI204");
  assert.equal(details.get("0108000001").flightDate, null, "FI450's date is not FI204's");

  // The same flight spelt another way is the same flight.
  assert.equal(mergeSources([{ flight: "FI204" }, { flight: "fi0204", flightDate: "2026-10-09" }]).flightDate, "2026-10-09");
  assert.equal(mergeSources([{ flight: "FI204" }, { flightDate: "2026-10-09" }]).flightDate, "2026-10-09", "a source with no flight may fill the date");
});

test("an order number is matched exactly; two orders ending alike, or a malformed number, give nothing rather than a guess", async () => {
  const lookalike = "recXXXXXXXXX8HKR1";
  const t = stubTables({ orders: { [ORDER_ROW_2]: orderFields(), [lookalike]: orderFields({ [ORDER.name]: "Wrong Person" }) } });
  const rows = [
    tagRow("recTAG00000000001", { "BagTag Number": "0523490818", "Order No": "8hkR1" }),
    tagRow("recTAG00000000002", { "BagTag Number": "0523490819", "Order No": "x' OR 1=1" }),
  ];
  const { details } = await resolveActivationDetails({ tagNumbers: ["0523490818", "0523490819"], tagRecords: rows, read: t.read });
  assert.equal(details.get("0523490818").passenger, "Jón Jónsson", "case-sensitive: 8HKR1 is another order");
  assert.equal(details.get("0523490819").passenger, null);
  assert.doesNotMatch(t.readsOf(ORDERS_TABLE)[0].formula, /OR 1=1/, "a malformed number is never put in a formula");
});

test("the legacy route's lookup by tag number: one batched read, safe quoting, best row per tag, unknown tags listed", async () => {
  const t = stubTables({
    tags: [
      tagRow("recTAG00000000001", { "BagTag Number": " 0108000001 ", "Order No": "i0lYC" }),
      { ...tagRow("recTAG00000000003", { "BagTag Number": "0108000001", "Passenger Name": "DOE/JOHN", Flight: "FI204", "Flight Date": "2026-10-09" }), createdTime: "2026-10-01T00:00:00.000Z" },
    ],
    orders: { [ORDER_ROW]: orderFields() },
  });
  const { details, problems } = await resolveActivationDetails({ tagNumbers: ["0108000001", "AB-12", "0108000001"], read: t.read });
  assert.deepEqual(problems, []);
  const tagReads = t.readsOf(TAG_TABLE);
  assert.equal(tagReads.length, 1);
  assert.equal(tagReads[0].formula, "OR(TRIM({BagTag Number})='0108000001', TRIM({BagTag Number})='AB-12')", "each tag once");
  assert.deepEqual(tagReads[0].fields, TAG_DETAIL_FIELDS);
  assert.equal(details.get("0108000001").passenger, "DOE/JOHN", "the row that says most about the bag");
  assert.equal(t.readsOf(ORDERS_TABLE).length, 0, "and it was complete");
  assert.deepEqual(details.get("AB-12"), { found: false, passenger: null, passengerOnBooking: false, pnr: null, flight: null, flightDate: null });

  // Quoting: a quote or backslash cannot leave the literal (the route only lets
  // letters, digits and dashes through, but the module does not rely on it).
  const q = stubTables();
  await resolveActivationDetails({ tagNumbers: ["a'b\\"], read: q.read });
  assert.equal(q.reads[0].formula, "TRIM({BagTag Number})='a\\'b\\\\'");
});

test("200 tags are read in two batches of 100, never one oversized URL", async () => {
  const t = stubTables();
  const tags = Array.from({ length: 200 }, (_, i) => String(1080000000 + i).padStart(10, "0"));
  const { details } = await resolveActivationDetails({ tagNumbers: tags, read: t.read });
  assert.equal(t.readsOf(TAG_TABLE).length, 2);
  for (const r of t.reads) assert.ok(new URLSearchParams([["filterByFormula", r.formula]]).toString().length < 8_000);
  assert.equal(details.size, 200);
});

test("a failed Úthringingar read still lets the order fill in; a failed Orders read keeps the row's own values", async () => {
  const rows = [tagRow("recTAG00000000001", { "BagTag Number": "0108000001", "Passenger Name": "DOE/JANE", "Úthringingar": [UTHR_ROW], "Order No copy": [ORDER_ROW] })];

  const a = stubTables({ orders: { [ORDER_ROW]: orderFields() }, fail: { [UTHRINGINGAR_TABLE]: 503 } });
  const ra = await resolveActivationDetails({ tagNumbers: ["0108000001"], tagRecords: rows, read: a.read });
  assert.deepEqual(ra.problems, ["Úthringingar: Airtable 503"]);
  assert.equal(ra.details.get("0108000001").flight, "NO5901");
  assert.equal(ra.details.get("0108000001").passenger, "DOE/JANE", "own name kept over the booker's");

  const b = stubTables({ fail: { [UTHRINGINGAR_TABLE]: 422, [ORDERS_TABLE]: 422 } });
  const rb = await resolveActivationDetails({ tagNumbers: ["0108000001"], tagRecords: rows, read: b.read });
  assert.equal(rb.problems.length, 2);
  assert.deepEqual(rb.details.get("0108000001"), { found: true, passenger: "DOE/JANE", passengerOnBooking: false, pnr: null, flight: null, flightDate: null });
});

test("a Tag numbers lookup that fails gives no details at all (the mail goes bare), and never throws", async () => {
  const t = stubTables({ fail: { [TAG_TABLE]: 503 } });
  const r = await resolveActivationDetails({ tagNumbers: ["0108000001"], read: t.read });
  assert.equal(r.details, null);
  assert.deepEqual(r.problems, ["Tag numbers: Airtable 503"]);

  const broken = await resolveActivationDetails({ tagNumbers: ["0108000001"], read: () => { throw new TypeError("boom"); } });
  assert.equal(broken.details, null);

  const junk = await resolveActivationDetails({ tagNumbers: ["0108000001"], read: async () => "not a list" });
  assert.equal(junk.details.get("0108000001").found, false);
});

test("the lookup has one deadline for all its reads; past it the mail goes with what is known", async () => {
  const rows = [tagRow("recTAG00000000001", { "BagTag Number": "0108000001", Flight: "FI204", "Order No copy": [ORDER_ROW] })];
  const t = stubTables({ hang: { [ORDERS_TABLE]: true } });
  const started = Date.now();
  const r = await resolveActivationDetails({ tagNumbers: ["0108000001"], tagRecords: rows, read: t.read, timeoutMs: 50 });
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(r.problems, ["Orders: no answer within 50 ms"]);
  assert.equal(r.details.get("0108000001").flight, "FI204");

  const legacy = await resolveActivationDetails({ tagNumbers: ["0108000001"], read: stubTables({ hang: { [TAG_TABLE]: true } }).read, timeoutMs: 50 });
  assert.equal(legacy.details, null);
});

// ---------------------------------------------------------------------------
// Values and rendering
// ---------------------------------------------------------------------------

test("flight dates read as '9 Oct 2026'; a date that does not exist is missing; other text stands", () => {
  assert.equal(formatFlightDate("2026-10-09"), "9 Oct 2026");
  assert.equal(formatFlightDate("2027-01-01"), "1 Jan 2027");
  assert.equal(formatFlightDate("2026-12-31T23:00:00.000Z"), "31 Dec 2026");
  assert.equal(formatFlightDate("2026-02-30"), null);
  assert.equal(formatFlightDate("2026-13-01"), null);
  assert.equal(formatFlightDate(""), null);
  assert.equal(formatFlightDate(undefined), null);
  assert.equal(formatFlightDate({ x: 1 }), null);
  assert.equal(formatFlightDate("9.10"), "9.10");
});

test("values are one short line: line breaks and control/bidi characters folded, long text cut", () => {
  assert.equal(cleanValue("  JON\r\nBcc: x@evil.example  "), "JON Bcc: x@evil.example");
  assert.equal(cleanValue("A\u202eB\u0000C"), "A B C");
  assert.equal(cleanValue(["", "  ", "first"]), "first");
  assert.equal(cleanValue(5901), "5901");
  assert.equal(cleanValue({ name: "x" }), null);
  assert.equal(cleanValue("x".repeat(200)).length, 80);
});

test("the mail: a table and matching text lines, sorted by tag, '—' for anything unknown, PNR only when known", () => {
  const details = new Map([
    ["0523490818", { found: true, passenger: "JON JONSSON", passengerOnBooking: true, pnr: null, flight: "NO5901", flightDate: "2026-10-09" }],
    ["0108005884", { found: true, passenger: "JONSDOTTIR/SIGRIDUR", passengerOnBooking: false, pnr: null, flight: "FI204", flightDate: "2026-10-09" }],
    ["0108000001", { found: false, passenger: null, passengerOnBooking: false, pnr: null, flight: null, flightDate: null }],
  ]);
  const { text, html } = renderActivationMail(["0523490818", "0108005884", "0108000001"], details);
  assert.equal(text, [
    "Please activate these inactive bag tags:",
    "",
    "• 0108000001 — — — — — —",
    "• 0108005884 — JONSDOTTIR/SIGRIDUR — FI204 — 9 Oct 2026",
    "• 0523490818 — JON JONSSON (name on booking) — NO5901 — 9 Oct 2026",
    "",
  ].join("\n"));
  assert.match(html, /<th[^>]*>Bag tag<\/th><th[^>]*>Passenger<\/th><th[^>]*>Flight<\/th><th[^>]*>Flight date<\/th><\/tr>/);
  assert.doesNotMatch(html, />PNR</, "no PNR column when no tag has one");
  assert.match(html, /<code>0108005884<\/code><\/td><td[^>]*>JONSDOTTIR\/SIGRIDUR<\/td><td[^>]*>FI204<\/td><td[^>]*>9 Oct 2026<\/td>/);
  assert.match(html, /JON JONSSON <span[^>]*>\(name on booking\)<\/span>/);
  assert.ok(html.indexOf("0108000001") < html.indexOf("0108005884") && html.indexOf("0108005884") < html.indexOf("0523490818"));

  // Same tags, any order: the same mail (so a retap is the same payload).
  assert.deepEqual(renderActivationMail(["0108000001", "0523490818", "0108005884"], details), { text, html });

  const withPnr = renderActivationMail(["0108005884", "0108000001"], new Map([
    ["0108005884", { passenger: "DOE/JANE", flight: "FI204", flightDate: "2026-10-09", pnr: "ABC123" }],
  ]));
  assert.match(withPnr.text, /• 0108005884 — DOE\/JANE — FI204 — 9 Oct 2026 — PNR ABC123/);
  assert.match(withPnr.text, /• 0108000001 — — — — — —\n/, "a tag missing from the map is all dashes");
  assert.match(withPnr.html, /<th[^>]*>PNR<\/th>/);
  assert.match(withPnr.html, /<td[^>]*>ABC123<\/td><\/tr>/);
});

test("every value is escaped in the HTML", () => {
  const { html, text } = renderActivationMail(["0108000001"], new Map([
    ["0108000001", { passenger: `<img src=x onerror="alert(1)">&'`, flight: "<b>FI</b>", flightDate: "<script>", pnr: '"><a href=x>' }],
  ]));
  assert.doesNotMatch(html, /<img|<b>|<script|<a href/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;&#39;/);
  assert.match(html, /&lt;b&gt;FI&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(text, /<img src=x/, "the text part is text, shown as is");
});

test("without details, the bare list it always was, byte for byte", () => {
  assert.deepEqual(renderActivationMail(["0523914486", "0108005884"], null), {
    text: "Please activate these inactive bag tags:\n\n• 0523914486\n• 0108005884\n",
    html: `
    <p>Please activate these inactive bag tags:</p>
    <ul><li><code>0523914486</code></li><li><code>0108005884</code></li></ul>
  `,
  });
});
