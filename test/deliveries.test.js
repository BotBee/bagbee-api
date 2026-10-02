// Afhendingar shared across phones (build 47, 2026-10-02).
//
// The delivery list used to live only on the phone that took the photo. Now
// the Tag numbers rows are the list: POST /app/delivery-photo stamps "Delivery
// photo at" in the same write as the photo, GET /app/deliveries reads the rows
// photographed since a moment, and PATCH /app/deliveries/:recordId carries the
// two flags every phone has to agree on (inactive, activation requested).
//
// Everything drives the real index.js through test/_indexHarness.js, so no
// request reaches api.airtable.com or R2.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { bootIndex, airtable, APP_TOKEN } from "./_indexHarness.js";

// index.js reads the R2 settings once, at import, and refuses photos without
// them; the PUT itself lands in the same stub as the Airtable calls.
Object.assign(process.env, {
  R2_ACCESS_KEY_ID: "harness-r2-key",
  R2_SECRET_ACCESS_KEY: "harness-r2-secret",
  R2_ENDPOINT: "https://r2.harness.invalid",
  R2_BUCKET: "photos",
  R2_PUBLIC_URL: "https://pub.harness.invalid",
});

const boot = await bootIndex();
after(() => boot.close());

const TAGS = "tblVyZakUmK0CY0YJ";
const AUTH = { "x-app-token": APP_TOKEN };
const HOUR = 3_600_000;
const ROW_ID = "recDELIV000000001";

const formulaOf = (url) => new URL(url).searchParams.get("filterByFormula") || "";
const sinceIn = (formula) => {
  const all = [...formula.matchAll(/'(\d{4}-[^']+)'/g)].map((m) => m[1]);
  assert.equal(all.length, 2, `the since, once per half, in ${formula}`);
  assert.ok(all.every((s) => s === all[0]), "both halves of the formula use the same since");
  return all[0];
};
const airtableReads = () => airtable.calls.filter((c) => !c.options.method || c.options.method === "GET");
const airtableWrites = () => airtable.calls
  .filter((c) => c.options.method && c.options.method !== "GET" && c.url.startsWith("https://api.airtable.com/"))
  .map((c) => ({ method: c.options.method, url: c.url, fields: JSON.parse(c.options.body).fields }));

function get(path, headers = AUTH) {
  return boot.request(path, { headers });
}

function patch(id, body, headers = AUTH) {
  return boot.request(`/app/deliveries/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function assertWithin(iso, before, afterMs, what) {
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${what} is a canonical ISO instant`);
  const ms = Date.parse(iso);
  assert.ok(ms >= before && ms <= afterMs, `${what} ${iso} is between ${new Date(before).toISOString()} and ${new Date(afterMs).toISOString()}`);
}

/// A delivered row as Airtable returns it for the fields the list asks for.
function photoRow(id, over = {}, fields = {}) {
  return {
    id,
    createdTime: "2026-10-01T09:00:00.000Z",
    ...over,
    fields: {
      "BagTag Number": "0108123456",
      "Order No": "i0lYC",
      "Passenger Name": "JONSDOTTIR/SIGRIDUR",
      Flight: "FI 542",
      Destination: "PRG",
      Attachments: [{
        id: "attPHOTO000000001",
        url: `https://v5.airtableusercontent.com/${id}/full.jpg`,
        filename: `bag_${id}.jpg`,
        thumbnails: {
          small: { url: `https://v5.airtableusercontent.com/${id}/small.jpg` },
          large: { url: `https://v5.airtableusercontent.com/${id}/large.jpg` },
        },
      }],
      "Delivery photo at": "2026-10-02T18:30:00.000Z",
      "Last modified": "2026-10-02T18:31:00.000Z",
      ...fields,
    },
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test("the delivery list and its flags sit behind requireAppToken", async () => {
  airtable.reset();

  const list = await get("/app/deliveries", {});
  assert.equal(list.status, 401);
  assert.deepEqual(await list.json(), { error: "Unauthorized" });

  const flag = await patch(ROW_ID, { inactive: true }, {});
  assert.equal(flag.status, 401);
  assert.deepEqual(await flag.json(), { error: "Unauthorized" });

  assert.deepEqual(airtable.calls, [], "an unauthorized request must never reach Airtable");
});

// ---------------------------------------------------------------------------
// POST /app/delivery-photo — the photo time travels with the photo
// ---------------------------------------------------------------------------

test("a delivery photo stamps 'Delivery photo at' in the same write as the attachment, and nothing else", async () => {
  airtable.reset();
  airtable.reply = (url, options = {}) => {
    if (url.startsWith("https://r2.harness.invalid/")) return { status: 200, body: "" };
    if (options.method === "PATCH") return { status: 200, body: JSON.stringify({ id: ROW_ID, fields: {} }) };
    return { status: 200, body: JSON.stringify({ records: [] }) };
  };

  const before = Date.now();
  const res = await boot.request("/app/delivery-photo", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify({ recordId: ROW_ID, imageBase64: Buffer.from("not really a jpeg").toString("base64") }),
  });
  const afterMs = Date.now();

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.url, /^https:\/\/pub\.harness\.invalid\/[0-9a-f-]{36}\.jpg$/);

  const put = airtable.calls.find((c) => c.url.startsWith("https://r2.harness.invalid/"));
  assert.ok(put, "the image went to R2 first");
  assert.equal(put.options.method, "PUT");

  const writes = airtableWrites();
  assert.equal(writes.length, 1, "one Airtable write: attachment and time together");
  const [write] = writes;
  assert.equal(write.method, "PATCH");
  assert.ok(write.url.endsWith(`/${TAGS}/${ROW_ID}`));
  assert.deepEqual(Object.keys(write.fields).sort(), ["Attachments", "Delivery photo at"]);
  assert.deepEqual(write.fields.Attachments, [{ url: body.url, filename: `bag_${ROW_ID}.jpg` }]);
  assertWithin(write.fields["Delivery photo at"], before, afterMs, "Delivery photo at");
  assert.ok(!("Delivered" in write.fields), "Delivered is other automations' field");
});

// ---------------------------------------------------------------------------
// GET /app/deliveries — the window, the formula, the pages
// ---------------------------------------------------------------------------

test("GET /app/deliveries asks Airtable for the last 24 h by photo time, newest first, only the list's fields", async () => {
  airtable.reset();

  const before = Date.now();
  const res = await get("/app/deliveries");
  const afterMs = Date.now();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);

  assert.equal(airtable.calls.length, 1);
  const url = new URL(airtable.calls[0].url);
  assert.equal(url.pathname, `/v0/appHB2bNYPAhfUcLv/${TAGS}`);

  const formula = formulaOf(url.href);
  const since = sinceIn(formula);
  assertWithin(since, before - 24 * HOUR, afterMs - 24 * HOUR, "default since");
  assert.equal(
    formula,
    `IF({Delivery photo at}, IS_AFTER({Delivery photo at}, '${since}'), ` +
      `AND({Attachments}!='', IS_AFTER(LAST_MODIFIED_TIME({Attachments}), '${since}')))`,
  );

  assert.equal(url.searchParams.get("sort[0][field]"), "Delivery photo at");
  assert.equal(url.searchParams.get("sort[0][direction]"), "desc");
  assert.equal(url.searchParams.get("pageSize"), "100");
  assert.equal(url.searchParams.get("offset"), null);

  const fields = url.searchParams.getAll("fields[]");
  assert.deepEqual(fields.sort(), [
    "Activation requested at", "Attachments", "BagTag Number", "Delivery photo at", "Destination",
    "Flight", "Inactive", "Last modified", "Order No", "Order No copy", "Passenger Name",
  ]);
  for (const field of fields) {
    assert.doesNotMatch(field, /mail|phone|sími|netfang/i, "no customer contact field is read");
  }
});

test("a since inside the window is used as given, in canonical form", async () => {
  airtable.reset();
  const asked = new Date(Date.now() - 5 * HOUR);
  const raw = asked.toISOString().replace(/\.\d{3}Z$/, "Z"); // ISO8601DateFormatter's default form

  const res = await get(`/app/deliveries?since=${encodeURIComponent(raw)}`);
  assert.equal(res.status, 200);
  assert.equal(sinceIn(formulaOf(airtable.calls[0].url)), new Date(Date.parse(raw)).toISOString());

  // An offset is an instant like any other; it reaches Airtable as UTC.
  airtable.reset();
  const local = new Date(Date.now() - 2 * HOUR);
  const plusTwo = new Date(local.getTime() + 2 * HOUR).toISOString().slice(0, 19) + "+02:00";
  const res2 = await get(`/app/deliveries?since=${encodeURIComponent(plusTwo)}`);
  assert.equal(res2.status, 200);
  assert.equal(sinceIn(formulaOf(airtable.calls[0].url)), new Date(Date.parse(plusTwo)).toISOString());
});

test("a since older than 72 h is clamped to 72 h ago", async () => {
  for (const raw of ["2026-01-01T00:00:00Z", "2020-05-05", new Date(Date.now() - 73 * HOUR).toISOString()]) {
    airtable.reset();
    const before = Date.now();
    const res = await get(`/app/deliveries?since=${encodeURIComponent(raw)}`);
    const afterMs = Date.now();
    assert.equal(res.status, 200, raw);
    assertWithin(sinceIn(formulaOf(airtable.calls[0].url)), before - 72 * HOUR, afterMs - 72 * HOUR, `clamped ${raw}`);
  }
});

test("a since that is not an ISO instant is 400 and never reaches Airtable", async () => {
  airtable.reset();
  for (const raw of [
    "yesterday", "1790928000", "2026-10-02T08:00:00", "2026-10-02 08:00:00Z", "2026-13-01T00:00:00Z",
    "2026-02-30T00:00:00Z", "2026-10-02T25:00:00Z", "2026-10-02T08:00:00+0000", "'), TRUE(), ('",
  ]) {
    const res = await get(`/app/deliveries?since=${encodeURIComponent(raw)}`);
    assert.equal(res.status, 400, raw);
    assert.match((await res.json()).error, /since must be an ISO 8601/, raw);
  }
  // Two values are an array, not an instant.
  const twice = await get("/app/deliveries?since=2026-10-02T08:00:00Z&since=2026-10-02T09:00:00Z");
  assert.equal(twice.status, 400);

  assert.deepEqual(airtable.calls, []);
});

test("the list follows Airtable's offset for at most 300 rows", async () => {
  airtable.reset();
  let page = 0;
  airtable.reply = () => {
    page += 1;
    const records = Array.from({ length: 100 }, (_, i) => {
      const n = (page - 1) * 100 + i;
      return photoRow(`recPAGE${String(n).padStart(10, "0")}`, {}, {
        "BagTag Number": `0108${String(n).padStart(6, "0")}`,
        "Delivery photo at": new Date(Date.UTC(2026, 9, 2, 20) - n * 60_000).toISOString(),
      });
    });
    // Airtable would go on: there is always another page.
    return { status: 200, body: JSON.stringify({ records, offset: `itrPAGE${page}/recNEXT` }) };
  };

  const res = await get("/app/deliveries");
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.equal(rows.length, 300);
  assert.equal(airtable.calls.length, 3, "three pages, then stop");

  const offsets = airtable.calls.map((c) => new URL(c.url).searchParams.get("offset"));
  assert.deepEqual(offsets, [null, "itrPAGE1/recNEXT", "itrPAGE2/recNEXT"]);
  // The filter and sort ride along on every page.
  for (const call of airtable.calls) {
    const url = new URL(call.url);
    assert.match(url.searchParams.get("filterByFormula"), /^IF\(\{Delivery photo at\}/);
    assert.equal(url.searchParams.get("sort[0][field]"), "Delivery photo at");
  }
  assert.equal(rows[0].tagNumber, "0108000000");
  assert.equal(rows[299].tagNumber, "0108000299");
});

test("each row is the list's shape: photo, thumbnail, photo time, flags — and nothing else", async () => {
  airtable.reset();
  const records = [
    // Newest by the stamp.
    photoRow("recDELIV000000001", {}, {
      Inactive: true,
      "Activation requested at": "2026-10-02T19:00:00.000Z",
    }),
    // Photographed before "Delivery photo at" existed: its time is Last modified.
    photoRow("recLEGACY00000001", { createdTime: "2026-10-02T07:00:00.000Z" }, {
      "BagTag Number": "0108654321",
      "Order No": undefined,
      "Order No copy": ["recORDERXXXXAbCdE"],
      "Delivery photo at": undefined,
      "Last modified": "2026-10-02T19:15:00.000Z",
      Attachments: [{ id: "attLEGACY0000001", url: "https://v5.airtableusercontent.com/legacy.jpg", filename: "bag.jpg" }],
    }),
    // An older stamped row, with blanks where a hand-made row has them.
    photoRow("recDELIV000000003", {}, {
      "BagTag Number": "0108000003",
      "Delivery photo at": "2026-10-02T10:00:00.000Z",
      "Passenger Name": "  ",
      Flight: undefined,
      Destination: undefined,
      Inactive: false,
    }),
  ].map((r) => ({ ...r, fields: Object.fromEntries(Object.entries(r.fields).filter(([, v]) => v !== undefined)) }));
  airtable.reply = () => ({ status: 200, body: JSON.stringify({ records }) });

  const res = await get("/app/deliveries");
  assert.equal(res.status, 200);
  const rows = await res.json();

  assert.deepEqual(rows, [
    {
      recordId: "recLEGACY00000001",
      tagNumber: "0108654321",
      orderNumber: "AbCdE",
      passengerName: "JONSDOTTIR/SIGRIDUR",
      flight: "FI 542",
      destination: "PRG",
      photoUrl: "https://v5.airtableusercontent.com/legacy.jpg",
      photoThumbUrl: null,
      photoAt: "2026-10-02T19:15:00.000Z",
      inactive: false,
      activationRequestedAt: null,
    },
    {
      recordId: "recDELIV000000001",
      tagNumber: "0108123456",
      orderNumber: "i0lYC",
      passengerName: "JONSDOTTIR/SIGRIDUR",
      flight: "FI 542",
      destination: "PRG",
      photoUrl: "https://v5.airtableusercontent.com/recDELIV000000001/full.jpg",
      photoThumbUrl: "https://v5.airtableusercontent.com/recDELIV000000001/large.jpg",
      photoAt: "2026-10-02T18:30:00.000Z",
      inactive: true,
      activationRequestedAt: "2026-10-02T19:00:00.000Z",
    },
    {
      recordId: "recDELIV000000003",
      tagNumber: "0108000003",
      orderNumber: "i0lYC",
      passengerName: null,
      flight: null,
      destination: null,
      photoUrl: "https://v5.airtableusercontent.com/recDELIV000000003/full.jpg",
      photoThumbUrl: "https://v5.airtableusercontent.com/recDELIV000000003/large.jpg",
      photoAt: "2026-10-02T10:00:00.000Z",
      inactive: false,
      activationRequestedAt: null,
    },
  ]);
});

test("an Airtable failure on the list is the usual error shape", async () => {
  airtable.reset();
  airtable.reply = () => ({ status: 503, body: '{"error":"SERVICE_UNAVAILABLE"}' });
  const res = await get("/app/deliveries");
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });
});

// ---------------------------------------------------------------------------
// PATCH /app/deliveries/:recordId — inactive, activation requested
// ---------------------------------------------------------------------------

/// The row exists (or not, with `missing`), and the PATCH answers with the
/// row as it now is: the fields written merged over `current`.
function flagStub({ missing = false, current = photoRow(ROW_ID).fields } = {}) {
  airtable.reply = (url, options = {}) => {
    if (options.method === "PATCH") {
      const { fields } = JSON.parse(options.body);
      const merged = { ...current, ...fields };
      for (const [k, v] of Object.entries(merged)) if (v === null || v === false) delete merged[k];
      return { status: 200, body: JSON.stringify({ id: ROW_ID, createdTime: "2026-10-01T09:00:00.000Z", fields: merged }) };
    }
    return { status: 200, body: JSON.stringify({ records: missing ? [] : [{ id: ROW_ID, fields: { "BagTag Number": "0108123456" } }] }) };
  };
}

test("inactive:true sets Inactive and only Inactive, after checking the row exists", async () => {
  airtable.reset();
  flagStub();

  const res = await patch(ROW_ID, { inactive: true });
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.recordId, ROW_ID);
  assert.equal(row.inactive, true);
  assert.equal(row.activationRequestedAt, null);
  assert.equal(row.photoAt, "2026-10-02T18:30:00.000Z");
  assert.deepEqual(Object.keys(row), [
    "recordId", "tagNumber", "orderNumber", "passengerName", "flight", "destination",
    "photoUrl", "photoThumbUrl", "photoAt", "inactive", "activationRequestedAt",
  ]);

  const [lookup] = airtableReads();
  assert.equal(formulaOf(lookup.url), `RECORD_ID()='${ROW_ID}'`);
  assert.equal(new URL(lookup.url).searchParams.get("maxRecords"), "1");

  const writes = airtableWrites();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PATCH");
  assert.ok(writes[0].url.endsWith(`/${TAGS}/${ROW_ID}`));
  assert.deepEqual(writes[0].fields, { Inactive: true });
});

test("inactive:false clears Inactive and the activation stamp with it", async () => {
  airtable.reset();
  flagStub({ current: { ...photoRow(ROW_ID).fields, Inactive: true, "Activation requested at": "2026-10-02T19:00:00.000Z" } });

  const res = await patch(ROW_ID, { inactive: false });
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.inactive, false);
  assert.equal(row.activationRequestedAt, null);

  const [write] = airtableWrites();
  assert.deepEqual(write.fields, { Inactive: false, "Activation requested at": null });
});

test("activationRequested:true stamps the time and touches nothing else", async () => {
  airtable.reset();
  flagStub({ current: { ...photoRow(ROW_ID).fields, Inactive: true } });

  const before = Date.now();
  const res = await patch(ROW_ID, { activationRequested: true });
  const afterMs = Date.now();
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.inactive, true);

  const [write] = airtableWrites();
  assert.deepEqual(Object.keys(write.fields), ["Activation requested at"]);
  assertWithin(write.fields["Activation requested at"], before, afterMs, "Activation requested at");
  assert.equal(row.activationRequestedAt, write.fields["Activation requested at"]);
});

test("inactive:true and activationRequested:true go in one write", async () => {
  airtable.reset();
  flagStub();

  const res = await patch(ROW_ID, { inactive: true, activationRequested: true });
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.inactive, true);
  assert.ok(row.activationRequestedAt);

  const writes = airtableWrites();
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].fields).sort(), ["Activation requested at", "Inactive"]);
  assert.equal(writes[0].fields.Inactive, true);
});

test("a malformed record id or body is 400 and never reaches Airtable", async () => {
  airtable.reset();
  flagStub();

  for (const id of ["recSHORT", "0108123456", "recDELIV0000000012", encodeURIComponent("rec' OR '1'='1xx")]) {
    const res = await patch(id, { inactive: true });
    assert.equal(res.status, 400, id);
    assert.deepEqual(await res.json(), { error: "recordId must be an Airtable record id" }, id);
  }

  for (const [body, error] of [
    [{}, /nothing to change/],
    [{ Delivered: true }, /nothing to change/],
    [{ inactive: "yes" }, /inactive must be true or false/],
    [{ inactive: null }, /inactive must be true or false/],
    [{ activationRequested: false }, /activationRequested can only be true/],
    [{ activationRequested: "2026-10-02T19:00:00Z" }, /activationRequested can only be true/],
    [{ inactive: false, activationRequested: true }, /activation request is for an inactive tag/],
    [[{ inactive: true }], /nothing to change/],
  ]) {
    const res = await patch(ROW_ID, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, error, JSON.stringify(body));
  }

  assert.deepEqual(airtable.calls, []);
});

test("a row that does not exist is 404 and nothing is written", async () => {
  airtable.reset();
  flagStub({ missing: true });

  const res = await patch(ROW_ID, { inactive: true });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "No such tag row" });
  assert.equal(airtableReads().length, 1);
  assert.deepEqual(airtableWrites(), []);
});

test("an Airtable failure on the flag write is the usual error shape", async () => {
  airtable.reset();
  airtable.reply = (url, options = {}) => (options.method === "PATCH"
    ? { status: 422, body: '{"error":{"type":"INVALID_VALUE_FOR_COLUMN"}}' }
    : { status: 200, body: JSON.stringify({ records: [{ id: ROW_ID, fields: {} }] }) });

  const res = await patch(ROW_ID, { inactive: true });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });
});
