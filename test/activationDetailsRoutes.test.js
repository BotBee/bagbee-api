// The activation mail's passenger/flight details, through the real index.js
// (Rúnar, 2026-10-09: "include the flight number, flight date, passenger name").
//
// Both routes: POST /app/deliveries/activation describes the rows it has just
// read, POST /send-activation-request looks its tag numbers up. The stub below
// holds Tag numbers (fields by name), Úthringingar and Orders (fields by id, as
// the lookup asks for them) and answers Resend; every call is logged so the
// tests can hold the lookup to one read per table and Orders to no writes.

import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bootIndex, airtable, APP_TOKEN } from "./_indexHarness.js";
import { UTHR, ORDER, activationBodies } from "../src/activationDetails.js";

// index.js reads these at import, before the harness boots it.
process.env.RESEND_API_KEY = "harness-resend-key";
process.env.ACTIVATION_SEND_TIMEOUT_MS = "500";
process.env.ACTIVATION_LOOKUP_TIMEOUT_MS = "150";
for (const name of ["ACTIVATION_FROM", "ACTIVATION_FALLBACK_FROM", "ACTIVATION_REPLY_TO", "ACTIVATION_CC", "ACTIVATION_TO", "ACTIVATION_RECIPIENTS"]) {
  delete process.env[name];
}

const boot = await bootIndex();
after(() => boot.close());

// index.js pins the first body it renders for a tag set and a handler to the
// ten-minute window (so a retap is the same payload under the same key); every
// case here starts from an empty memo, as if in its own window, unless it is
// testing the retap itself.
beforeEach(() => activationBodies.clear());

const TAGS = "tblVyZakUmK0CY0YJ";
const UTHRINGINGAR = "tblT74xUkrvoehHEE";
const ORDERS = "tblWLlNxZvtkFSFXs";
const AUTH = { "x-app-token": APP_TOKEN };
const ICELANDAIR = "paxservicemanagerskef@icelandair.is";
const AIRPORT_ASSOCIATES = "pax@airportassociates.com";

const PASS = "recDETAILPASS0001"; // claimed from a boarding pass: everything on the row
const CHECKIN = "recDETAILUTHR0002"; // linked to its Úthringingar row only
const PRINTED = "recvkWAUjTdN0Zm5I"; // printed from an order: Order No only (the 2026-10-08 send)
const UTHR_ROW = "recUTHRINGINGAR01";
const ORDER_ROW = "recteH7tBgVi8hkR1";

const photo = {
  Attachments: [{ id: "attPHOTO000000001", url: "https://v5.airtableusercontent.com/x/full.jpg", filename: "bag.jpg" }],
  "Delivery photo at": "2026-10-08T21:54:17.576Z",
  Inactive: true,
};

function tables() {
  return {
    tags: new Map([
      [PASS, { ...photo, "BagTag Number": "0108005884", "Passenger Name": "JONSDOTTIR/SIGRIDUR", PNR: "ABC123", Flight: "FI204", "Flight Date": "2026-10-09" }],
      [CHECKIN, { ...photo, "BagTag Number": "0108000002", "Úthringingar": [UTHR_ROW] }],
      [PRINTED, { ...photo, "BagTag Number": "0523490818", "Order No": "8hkR1" }],
    ]),
    uthr: new Map([[UTHR_ROW, { [UTHR.name]: "Guðrún <Gunna> Ólafsdóttir", [UTHR.bookingRef]: "XYZ789", [UTHR.flight]: "FI450", [UTHR.flightDate]: "2026-10-10" }]]),
    orders: new Map([[ORDER_ROW, { [ORDER.name]: "JON JONSSON", [ORDER.flight]: "NO5901", [ORDER.flightDate]: "2026-10-09" }]]),
  };
}

/// The stub. `fail[table]` answers that status to every read of the table;
/// `hang[table]` never answers (the route's deadline must cut it off).
/// `resendHangs` makes Resend never answer (the send's own timeout, status 0).
/// `unknownTagFields` are Tag numbers columns that no longer exist: a read
/// naming any of them is Airtable's 422, and every other Tag numbers read
/// answers only the fields it names, as Airtable does.
function stub({ fail = {}, hang = {}, resendHangs = false, unknownTagFields = [] } = {}) {
  const t = tables();
  const log = [];
  airtable.reset();
  airtable.reply = (url, options = {}) => {
    const method = options.method || "GET";
    if (url.startsWith("https://api.resend.com/emails")) {
      const message = JSON.parse(options.body);
      log.push({ kind: "mail", message, key: options.headers["Idempotency-Key"] });
      if (resendHangs) return new Promise(() => {});
      return { status: 200, body: JSON.stringify({ id: `re_${log.length}` }) };
    }
    const u = new URL(url);
    const table = decodeURIComponent(u.pathname.split("/")[3] || "");
    if (method !== "GET") {
      log.push({ kind: "write", table, method });
      if (table !== TAGS) return { status: 500, body: "{}" };
      const body = JSON.parse(options.body);
      for (const r of body.records) t.tags.set(r.id, { ...t.tags.get(r.id), ...r.fields });
      return { status: 200, body: JSON.stringify({ records: body.records.map((r) => ({ id: r.id, fields: t.tags.get(r.id) })) }) };
    }
    const formula = u.searchParams.get("filterByFormula") || "";
    log.push({ kind: "read", table, formula, fields: u.searchParams.getAll("fields[]"), byId: u.searchParams.get("returnFieldsByFieldId") });
    if (hang[table]) return new Promise(() => {});
    if (fail[table]) return { status: fail[table], body: '{"error":"SERVICE_UNAVAILABLE"}' };
    const named = u.searchParams.getAll("fields[]");
    const unknown = table === TAGS ? named.find((f) => unknownTagFields.includes(f)) : null;
    if (unknown) {
      return { status: 422, body: JSON.stringify({ error: { type: "UNKNOWN_FIELD_NAME", message: `Unknown field name: "${unknown}"` } }) };
    }
    const only = (fields) => (table === TAGS && unknownTagFields.length && named.length
      ? Object.fromEntries(Object.entries(fields).filter(([k]) => named.includes(k)))
      : fields);

    const ids = [...formula.matchAll(/RECORD_ID\(\)='(rec[A-Za-z0-9]{14})'/g)].map((m) => m[1]);
    const suffixes = [...formula.matchAll(/RIGHT\(RECORD_ID\(\), 5\)='([^']*)'/g)].map((m) => m[1]);
    const numbers = [...formula.matchAll(/TRIM\(\{BagTag Number\}\)='([^']*)'/g)].map((m) => m[1]);
    const store = table === TAGS ? t.tags : table === UTHRINGINGAR ? t.uthr : table === ORDERS ? t.orders : new Map();
    const records = [...store]
      .filter(([id, f]) => ids.includes(id) || suffixes.includes(id.slice(-5)) || numbers.includes(String(f["BagTag Number"] || "").trim()))
      .map(([id, fields]) => ({ id, createdTime: "2026-10-08T19:54:26.000Z", fields: only(fields) }));
    return { status: 200, body: JSON.stringify({ records }) };
  };
  const reads = (table) => log.filter((e) => e.kind === "read" && e.table === table);
  const mails = () => log.filter((e) => e.kind === "mail");
  const mailTo = (to) => mails().find((m) => m.message.to[0] === to)?.message;
  return { t, log, reads, mails, mailTo };
}

const post = (path, body) => boot.request(path, {
  method: "POST",
  headers: { "content-type": "application/json", ...AUTH },
  body: JSON.stringify(body),
});

test("deliveries send: each mail lists passenger, flight and date — from the row, its check-in row, or the order", async () => {
  const s = stub();
  const res = await post("/app/deliveries/activation", { recordIds: [PRINTED, PASS, CHECKIN] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent.length, 3);
  assert.deepEqual(body.unstamped, []);

  const ice = s.mailTo(ICELANDAIR);
  assert.equal(ice.subject, "Inactive bag tags — please activate (2)", "subject unchanged");
  assert.equal(ice.text, [
    "Please activate these inactive bag tags:",
    "",
    "• 0108000002 — Guðrún <Gunna> Ólafsdóttir — FI450 — 10 Oct 2026 — PNR XYZ789",
    "• 0108005884 — JONSDOTTIR/SIGRIDUR — FI204 — 9 Oct 2026 — PNR ABC123",
    "",
  ].join("\n"));
  assert.match(ice.html, /Guðrún &lt;Gunna&gt; Ólafsdóttir/, "escaped in the HTML");
  assert.match(ice.html, /<th[^>]*>PNR<\/th>/);

  const aa = s.mailTo(AIRPORT_ASSOCIATES);
  assert.equal(aa.text, "Please activate these inactive bag tags:\n\n• 0523490818 — JON JONSSON (name on booking) — NO5901 — 9 Oct 2026\n");
  assert.match(aa.html, /<code>0523490818<\/code><\/td><td[^>]*>JON JONSSON <span[^>]*>\(name on booking\)<\/span><\/td><td[^>]*>NO5901<\/td><td[^>]*>9 Oct 2026<\/td><\/tr>/);
  assert.deepEqual(aa.cc, ["bagbee@bagbee.is"]);
  assert.equal(aa.reply_to, "bagbee@bagbee.is");

  // One read per table, Orders only read — and by field id, three fields.
  assert.equal(s.reads(TAGS).length, 1, "the rows the route reads anyway carry the details");
  for (const f of ["PNR", "Flight Date", "Úthringingar"]) assert.ok(s.reads(TAGS)[0].fields.includes(f), f);
  assert.equal(s.reads(UTHRINGINGAR).length, 1);
  assert.equal(s.reads(UTHRINGINGAR)[0].formula, `RECORD_ID()='${UTHR_ROW}'`);
  assert.equal(s.reads(ORDERS).length, 1);
  assert.equal(s.reads(ORDERS)[0].formula, "RIGHT(RECORD_ID(), 5)='8hkR1'");
  assert.equal(s.reads(ORDERS)[0].byId, "true");
  assert.deepEqual(s.reads(ORDERS)[0].fields.sort(), Object.values(ORDER).sort());
  assert.deepEqual(s.log.filter((e) => e.kind === "write").map((e) => e.table), [TAGS, TAGS], "only the two stamps; Orders is never written");
  assert.ok(s.log.findIndex((e) => e.kind === "read" && e.table === ORDERS) < s.log.findIndex((e) => e.kind === "mail"), "looked up before mailing");
});

test("deliveries send: a lookup that fails costs the details, not the activation", async () => {
  const s = stub({ fail: { [UTHRINGINGAR]: 503, [ORDERS]: 503 } });
  const res = await post("/app/deliveries/activation", { recordIds: [PASS, CHECKIN, PRINTED] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent.length, 3);
  for (const row of body.sent) assert.ok(row.activationRequestedAt, "stamped as before");

  assert.equal(s.mailTo(ICELANDAIR).text, [
    "Please activate these inactive bag tags:",
    "",
    "• 0108000002 — — — — — —",
    "• 0108005884 — JONSDOTTIR/SIGRIDUR — FI204 — 9 Oct 2026 — PNR ABC123",
    "",
  ].join("\n"), "what the rows themselves say still goes");
  assert.match(s.mailTo(AIRPORT_ASSOCIATES).text, /• 0523490818 — — — — — —/);
});

test("legacy send: tags are looked up by number; one that has no row is listed with '—'", async () => {
  const s = stub();
  const res = await post("/send-activation-request", { tagNumbers: ["0523490818", "0108999999"], to: AIRPORT_ASSOCIATES });
  assert.equal(res.status, 200);
  const answer = await res.json();
  assert.deepEqual({ ...answer, id: undefined }, { ok: true, count: 2, id: undefined, from: "BagBee <bagbee@bagbee.is>" }, "answer unchanged");
  assert.match(answer.id, /^re_/);

  const mail = s.mailTo(AIRPORT_ASSOCIATES);
  assert.equal(mail.subject, "Inactive bag tags — please activate (2)");
  assert.equal(mail.text, [
    "Please activate these inactive bag tags:",
    "",
    "• 0108999999 — — — — — —",
    "• 0523490818 — JON JONSSON (name on booking) — NO5901 — 9 Oct 2026",
    "",
  ].join("\n"));

  assert.equal(s.reads(TAGS).length, 1);
  assert.equal(s.reads(TAGS)[0].formula, "OR(TRIM({BagTag Number})='0523490818', TRIM({BagTag Number})='0108999999')");
  assert.equal(s.reads(UTHRINGINGAR).length, 0);
  assert.equal(s.reads(ORDERS).length, 1);
  assert.deepEqual(s.log.filter((e) => e.kind === "write"), [], "the legacy route writes nothing");
});

test("legacy send: if the tags cannot be looked up, the mail goes as the bare list it always was", async () => {
  const s = stub({ fail: { [TAGS]: 503 } });
  const res = await post("/send-activation-request", { tagNumbers: ["0523490818", "0108005884"], to: AIRPORT_ASSOCIATES });
  assert.equal(res.status, 200);
  const mail = s.mailTo(AIRPORT_ASSOCIATES);
  assert.equal(mail.text, "Please activate these inactive bag tags:\n\n• 0523490818\n• 0108005884\n");
  assert.match(mail.html, /<ul><li><code>0523490818<\/code><\/li><li><code>0108005884<\/code><\/li><\/ul>/);
});

test("legacy send: a lookup that never answers is cut off by its deadline and the mail still goes", async () => {
  const s = stub({ hang: { [TAGS]: true } });
  const started = Date.now();
  const res = await post("/send-activation-request", { tagNumbers: ["0523490818"], to: AIRPORT_ASSOCIATES });
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 2_000, "the 150 ms lookup budget, not the phone's 30 s");
  assert.equal(s.mailTo(AIRPORT_ASSOCIATES).text, "Please activate these inactive bag tags:\n\n• 0523490818\n");
});

test("the same tags make the same mail and the same idempotency key, in any order", async () => {
  const s = stub();
  await post("/send-activation-request", { tagNumbers: ["0523490818", "0108005884"], to: AIRPORT_ASSOCIATES });
  // Forget the first body, so this shows the render itself is order-free, not
  // just the memo handing the first body back.
  activationBodies.clear();
  await post("/send-activation-request", { tagNumbers: ["0108005884", "0523490818"], to: AIRPORT_ASSOCIATES });
  const [a, b] = s.mails();
  assert.equal(a.key, b.key);
  assert.deepEqual(a.message, b.message, "a retap is the same payload, so Resend answers it as the same request");
  assert.match(a.message.text, /• 0108005884 — JONSDOTTIR\/SIGRIDUR — FI204 — 9 Oct 2026 — PNR ABC123\n• 0523490818 — JON JONSSON \(name on booking\) — NO5901 — 9 Oct 2026/);
});

// ---------------------------------------------------------------------------
// A retap is the same payload under the same key
// ---------------------------------------------------------------------------
//
// Resend replays a reused Idempotency-Key only for the same payload; a different
// payload under it is a 409, which would leave the rows owed and unstamped and
// let the next window's tap mail the handler twice. The lookup can come out
// differently from one tap to the next, so the body is pinned to the key.

/// Runs both taps of a case inside one ten-minute window: if the window rolls
/// over mid-case (the key would rightly change), the case is run once more.
async function insideOneWindow(run) {
  const bucket = () => Math.floor(Date.now() / 600_000);
  for (let attempt = 0; ; attempt++) {
    activationBodies.clear();
    const before = bucket();
    const result = await run();
    if (bucket() === before || attempt === 1) return result;
  }
}

const mailFor = (mails, to) => mails.find((m) => m.message.to[0] === to);

test("deliveries retap after a send that timed out: same key, same body, even though this tap's lookup found more", async () => {
  const { first, second, res1, res2 } = await insideOneWindow(async () => {
    // Tap 1: the lookup gets no answer inside its deadline and Resend none
    // inside the send's (status 0) — the mail may well have gone.
    const s1 = stub({ hang: { [UTHRINGINGAR]: true, [ORDERS]: true }, resendHangs: true });
    const res1 = await post("/app/deliveries/activation", { recordIds: [CHECKIN, PRINTED] });
    const first = s1.mails();
    // Tap 2, same window: the lookup answers in full and so does Resend.
    const s2 = stub();
    const res2 = await post("/app/deliveries/activation", { recordIds: [CHECKIN, PRINTED] });
    return { first, second: s2.mails(), res1, res2 };
  });

  assert.equal(res1.status, 502, "tap 1 could not tell whether it went");
  assert.equal((await res1.json()).failed.length, 2);
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  for (const to of [ICELANDAIR, AIRPORT_ASSOCIATES]) {
    const a = mailFor(first, to);
    const b = mailFor(second, to);
    assert.equal(b.key, a.key, `${to}: same tags, same window, same key`);
    assert.deepEqual(b.message, a.message, `${to}: same key, same payload — Resend replays the first send instead of refusing a 409`);
  }
  assert.match(mailFor(second, AIRPORT_ASSOCIATES).message.text, /• 0523490818 — — — — — —/, "tap 1's body, not tap 2's lookup");
  assert.doesNotMatch(mailFor(second, AIRPORT_ASSOCIATES).message.text, /JON JONSSON/);

  assert.equal(res2.status, 200);
  const body = await res2.json();
  assert.equal(body.sent.length, 2);
  for (const row of body.sent) assert.ok(row.activationRequestedAt, "the retap stamps the rows, so they are no longer owed");
});

test("legacy retap after a send that timed out: same key, same body", async () => {
  const { first, second, res1, res2 } = await insideOneWindow(async () => {
    const s1 = stub({ hang: { [TAGS]: true }, resendHangs: true });
    const res1 = await post("/send-activation-request", { tagNumbers: ["0523490818"], to: AIRPORT_ASSOCIATES });
    const first = s1.mails();
    const s2 = stub();
    const res2 = await post("/send-activation-request", { tagNumbers: ["0523490818"], to: AIRPORT_ASSOCIATES });
    return { first, second: s2.mails(), res1, res2 };
  });

  assert.equal(res1.status, 500);
  await res1.json();
  assert.equal(res2.status, 200);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].key, first[0].key);
  assert.deepEqual(second[0].message, first[0].message);
  assert.equal(second[0].message.text, "Please activate these inactive bag tags:\n\n• 0523490818\n", "the bare list tap 1 sent");
});

test("deliveries send: a detail column Airtable no longer knows costs those details, not the activation", async () => {
  // "Flight Date" renamed or deleted: naming it makes the whole read a 422.
  const s = stub({ unknownTagFields: ["Flight Date"] });
  const res = await post("/app/deliveries/activation", { recordIds: [PASS, CHECKIN, PRINTED] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent.length, 3);
  for (const row of body.sent) assert.ok(row.activationRequestedAt, "stamped as before");

  const tagReads = s.reads(TAGS);
  assert.equal(tagReads.length, 2, "refused once, then read with the delivery fields alone");
  assert.ok(tagReads[0].fields.includes("Flight Date"));
  for (const f of ["PNR", "Flight Date", "Úthringingar"]) assert.ok(!tagReads[1].fields.includes(f), `${f} not asked for again`);
  assert.equal(tagReads[1].formula, tagReads[0].formula, "the same rows");

  assert.equal(s.mailTo(ICELANDAIR).text, [
    "Please activate these inactive bag tags:",
    "",
    "• 0108000002 — — — — — —",
    "• 0108005884 — JONSDOTTIR/SIGRIDUR — FI204 — —",
    "",
  ].join("\n"), "what the delivery fields still say goes; the rest is '—'");
  assert.equal(s.mailTo(AIRPORT_ASSOCIATES).text,
    "Please activate these inactive bag tags:\n\n• 0523490818 — JON JONSSON (name on booking) — NO5901 — 9 Oct 2026\n",
    "Order No is a delivery field, so the order is still found");
  assert.equal(s.reads(UTHRINGINGAR).length, 0);
});
