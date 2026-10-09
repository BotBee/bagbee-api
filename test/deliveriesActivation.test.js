// POST /app/deliveries/activation — the delivery list's activation send, once
// however many phones ask (build 47 review, 2026-10-02).
//
// The phone used to read the list, mail the handler, then stamp each row. Two
// phones tapping Send within that second both saw the tags unrequested and both
// mailed the airline; a stamp lost at the kerb left the tag looking unsent on
// every other phone. The read, the mail and the stamp are now one step on the
// server, under the same lock as the flag writes.
//
// Everything drives the real index.js through test/_indexHarness.js. The stub
// below keeps the Tag numbers rows in a Map, so a second request sees what the
// first one wrote, and answers Resend's /emails as well.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { bootIndex, airtable, APP_TOKEN } from "./_indexHarness.js";

// index.js reads these at import, before the harness boots it.
process.env.RESEND_API_KEY = "harness-resend-key";
process.env.ACTIVATION_SEND_TIMEOUT_MS = "500";
for (const name of ["ACTIVATION_FROM", "ACTIVATION_FALLBACK_FROM", "ACTIVATION_REPLY_TO", "ACTIVATION_CC", "ACTIVATION_TO", "ACTIVATION_RECIPIENTS"]) {
  delete process.env[name];
}

const boot = await bootIndex();
after(() => boot.close());

const TAGS = "tblVyZakUmK0CY0YJ";
const AUTH = { "x-app-token": APP_TOKEN };
const ICELANDAIR = "paxservicemanagerskef@icelandair.is";
const AIRPORT_ASSOCIATES = "pax@airportassociates.com";

const ICE = "recACTIVICE000001";   // Icelandair tag, inactive, owed
const AA = "recACTIVAAX000002";    // another airline's tag, inactive, owed
const DONE = "recACTIVDONE00003";  // inactive, already requested
const LIVE = "recACTIVLIVE00004";  // not inactive

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fields(over = {}) {
  return {
    "BagTag Number": "0108123456",
    "Order No": "i0lYC",
    "Passenger Name": "JONSDOTTIR/SIGRIDUR",
    Attachments: [{ id: "attPHOTO000000001", url: "https://v5.airtableusercontent.com/x/full.jpg", filename: "bag.jpg" }],
    "Delivery photo at": "2026-10-02T18:30:00.000Z",
    ...over,
  };
}

/// The Tag numbers rows, as Airtable would hold them, and every call in order.
function stubStore({ mail = () => ({ status: 200, body: JSON.stringify({ id: "re_ok" }) }), mailDelayMs = 0, stamp = null } = {}) {
  const rows = new Map([
    [ICE, fields({ "BagTag Number": "0108000001", Inactive: true })],
    [AA, fields({ "BagTag Number": "0523000002", Inactive: true })],
    [DONE, fields({ "BagTag Number": "0108000003", Inactive: true, "Activation requested at": "2026-10-02T19:00:00.000Z" })],
    [LIVE, fields({ "BagTag Number": "0108000004" })],
  ]);
  const log = [];
  const record = (id) => ({ id, createdTime: "2026-10-01T09:00:00.000Z", fields: { ...rows.get(id) } });
  const write = (id, changes) => {
    const merged = { ...rows.get(id), ...changes };
    for (const [k, v] of Object.entries(merged)) if (v === null || v === false) delete merged[k];
    rows.set(id, merged);
  };

  airtable.reset();
  airtable.reply = async (url, options = {}) => {
    if (url.startsWith("https://api.resend.com/emails")) {
      const message = JSON.parse(options.body);
      log.push({ kind: "mail", to: message.to[0], text: message.text });
      if (mailDelayMs) await sleep(mailDelayMs);
      return mail(message);
    }
    const u = new URL(url);
    if (options.method === "PATCH" && u.pathname.endsWith(`/${TAGS}`)) {
      const body = JSON.parse(options.body);
      log.push({ kind: "stamp", ids: body.records.map((r) => r.id), fields: body.records.map((r) => r.fields) });
      if (stamp) return stamp(body);
      for (const r of body.records) write(r.id, r.fields);
      return { status: 200, body: JSON.stringify({ records: body.records.map((r) => record(r.id)) }) };
    }
    if (options.method === "PATCH") {
      const id = u.pathname.split("/").pop();
      const body = JSON.parse(options.body);
      log.push({ kind: "flag", id, fields: body.fields });
      write(id, body.fields);
      return { status: 200, body: JSON.stringify(record(id)) };
    }
    const formula = u.searchParams.get("filterByFormula") || "";
    // The mail's passenger/flight lookup reads Úthringingar and Orders too; those
    // tables are empty here (test/activationDetailsRoutes.test.js fills them).
    const table = u.pathname.split("/").pop();
    if (table !== TAGS) {
      log.push({ kind: "lookup", table, formula });
      return { status: 200, body: JSON.stringify({ records: [] }) };
    }
    const ids = [...formula.matchAll(/RECORD_ID\(\)='(rec[A-Za-z0-9]{14})'/g)].map((m) => m[1]);
    log.push({ kind: "read", ids });
    return { status: 200, body: JSON.stringify({ records: ids.filter((id) => rows.has(id)).map(record) }) };
  };
  return { rows, log };
}

function send(recordIds, headers = AUTH) {
  return boot.request("/app/deliveries/activation", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ recordIds }),
  });
}

const ids = (list) => list.map((r) => r.recordId).sort();

test("mails only the rows still owed, one mail per handler, and stamps them after the mail", async () => {
  const { rows, log } = stubStore();

  const res = await send([ICE, AA, DONE, LIVE, ICE]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["sent", "skipped", "unstamped"]);
  assert.deepEqual(ids(body.sent), [AA, ICE].sort());
  assert.deepEqual(ids(body.skipped), [DONE, LIVE].sort());
  assert.deepEqual(body.unstamped, []);
  for (const row of body.sent) assert.ok(row.activationRequestedAt, `${row.recordId} comes back stamped`);

  const reads = log.filter((e) => e.kind === "read");
  assert.equal(reads.length, 1, "one read of the asked rows");
  assert.deepEqual([...new Set(reads[0].ids)].sort(), [AA, DONE, ICE, LIVE].sort(), "each id once");

  const mails = log.filter((e) => e.kind === "mail");
  assert.deepEqual(mails.map((m) => m.to).sort(), [AIRPORT_ASSOCIATES, ICELANDAIR].sort());
  assert.match(mails.find((m) => m.to === ICELANDAIR).text, /0108000001/);
  assert.doesNotMatch(mails.find((m) => m.to === ICELANDAIR).text, /0108000003|0108000004/, "requested and live tags are not mailed");
  assert.match(mails.find((m) => m.to === AIRPORT_ASSOCIATES).text, /0523000002/);

  // Each handler's rows are stamped after that handler's mail, and only those.
  for (const [id, to] of [[ICE, ICELANDAIR], [AA, AIRPORT_ASSOCIATES]]) {
    const mailAt = log.findIndex((e) => e.kind === "mail" && e.to === to);
    const stampAt = log.findIndex((e) => e.kind === "stamp" && e.ids.includes(id));
    assert.ok(mailAt >= 0 && stampAt > mailAt, `${id} is stamped after its mail`);
  }
  for (const entry of log.filter((e) => e.kind === "stamp")) {
    for (const f of entry.fields) assert.deepEqual(Object.keys(f), ["Activation requested at"], "nothing else is written");
  }
  assert.ok(rows.get(ICE)["Activation requested at"]);
  assert.ok(rows.get(AA)["Activation requested at"]);
  assert.equal(rows.get(DONE)["Activation requested at"], "2026-10-02T19:00:00.000Z", "an earlier stamp is kept");
  assert.equal(rows.get(LIVE)["Activation requested at"], undefined);
});

test("two phones sending the same tag at once mail the handler once", async () => {
  const { log } = stubStore({ mailDelayMs: 60 });

  const [a, b] = await Promise.all([send([ICE]), send([ICE])]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const answers = [await a.json(), await b.json()];

  assert.equal(log.filter((e) => e.kind === "mail").length, 1, "one mail, not two");
  assert.deepEqual(answers.map((x) => ids(x.sent)).sort(), [[], [ICE]]);
  const second = answers.find((x) => x.sent.length === 0);
  assert.deepEqual(ids(second.skipped), [ICE], "the second phone is told the tag is already requested");
  assert.ok(second.skipped[0].activationRequestedAt);
});

test("a handler whose mail fails gets nothing stamped, and the answer says so", async () => {
  const { rows } = stubStore({
    mail: (m) => (m.to[0] === AIRPORT_ASSOCIATES
      ? { status: 422, body: JSON.stringify({ name: "validation_error", message: "Invalid `to` field." }) }
      : { status: 200, body: JSON.stringify({ id: "re_ok" }) }),
  });

  const res = await send([ICE, AA]);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, "Failed to send email");
  assert.equal(body.detail.message, "Invalid `to` field.");
  assert.deepEqual(ids(body.sent), [ICE], "the mail that went out is still reported");
  assert.deepEqual(ids(body.failed), [AA]);
  assert.equal(body.failed[0].activationRequestedAt, null);

  assert.ok(rows.get(ICE)["Activation requested at"]);
  assert.equal(rows.get(AA)["Activation requested at"], undefined, "still owed on every phone");
});

test("a stamp that does not take after the mail is reported as unstamped, not dropped", async () => {
  stubStore({ stamp: () => ({ status: 503, body: '{"error":"SERVICE_UNAVAILABLE"}' }) });

  const res = await send([ICE]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(ids(body.sent), [ICE]);
  assert.deepEqual(body.unstamped, [ICE]);
});

test("a flag change waits behind a send in progress", async () => {
  const { rows, log } = stubStore({ mailDelayMs: 60 });

  const sending = send([ICE]);
  await sleep(15);
  const flag = boot.request(`/app/deliveries/${ICE}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify({ inactive: false }),
  });
  const [s, f] = await Promise.all([sending, flag]);
  assert.equal(s.status, 200);
  assert.equal(f.status, 200);

  const stampAt = log.findIndex((e) => e.kind === "stamp");
  const flagAt = log.findIndex((e) => e.kind === "flag");
  assert.ok(stampAt >= 0 && flagAt > stampAt, "the PATCH ran after the send had stamped");
  // Made active after the request: the stamp goes with it, so marking it
  // inactive again asks the airline again.
  assert.equal(rows.get(ICE).Inactive, undefined);
  assert.equal(rows.get(ICE)["Activation requested at"], undefined);
});

test("a malformed body is 400, without the token 401, and neither reaches Airtable or Resend", async () => {
  airtable.reset();
  for (const body of [{}, { recordIds: [] }, { recordIds: "recACTIVICE000001" }, { recordIds: ["0108000001"] },
    { recordIds: [ICE, "rec' OR '1'='1xxxx"] }, { recordIds: Array.from({ length: 201 }, () => ICE) }]) {
    const res = await boot.request("/app/deliveries/activation", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match((await res.json()).error, /recordIds must be/);
  }

  const unauthorized = await send([ICE], {});
  assert.equal(unauthorized.status, 401);

  assert.deepEqual(airtable.calls, []);
});

test("an Airtable failure reading the rows mails nothing", async () => {
  airtable.reset();
  airtable.reply = (url) => (url.startsWith("https://api.resend.com/")
    ? { status: 200, body: JSON.stringify({ id: "re_ok" }) }
    : { status: 503, body: '{"error":"SERVICE_UNAVAILABLE"}' });

  const res = await send([ICE]);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });
  assert.equal(airtable.calls.filter((c) => c.url.startsWith("https://api.resend.com/")).length, 0);
});
