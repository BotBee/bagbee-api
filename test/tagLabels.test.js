// The "claimed anywhere, printable anywhere" surface (2026-09-18).
//
// A bag tag is claimed on the Mac or on a phone, and whichever side claimed it
// renders the label locally — BagChain returns the tag data but no ZPL. Until
// now the label existed only on the machine that rendered it, so a tag claimed
// at the counter could not be reprinted in the van. These tests cover the three
// things that changed: POST /app/tags storing the label and the vendor's record,
// the per-order tag list, and the per-tag label fetch.
//
// Everything here drives the real index.js through test/_indexHarness.js, which
// replaces node-fetch — so no test touches api.airtable.com, and none of them
// can be satisfied by a re-implementation of index.js's wiring.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { bootIndex, airtable, APP_TOKEN } from "./_indexHarness.js";

const boot = await bootIndex();
after(() => boot.close());

const ORDERS = "tblWLlNxZvtkFSFXs";
const TAGS = "tblVyZakUmK0CY0YJ";
const AUTH = { "x-app-token": APP_TOKEN };

// A label as the shared template renders it: opens ^XA, carries the plate.
const ZPL = "^XA^MNM^MTD^MMT^PW416^LL3200^LS0^PR3,3^FO20,30^FDJONSDOTTIR/S^FS^XZ";
const OTHER_ZPL = "^XA^MNM^MTD^FO42,30^FDJONSDOTTIR/S^FS^XZ";
const TAG_DATA = { tagNumber: "0592123456", pnrData: "ABC123", airlineName: "ICELANDAIR" };

function post(path, body, headers = AUTH) {
  return boot.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/// The body index.js sent to Airtable on its one write, with the method.
function writeCall() {
  const call = airtable.calls.find((c) => c.options.method === "PATCH" || c.options.method === "POST");
  if (!call) return null;
  return { method: call.options.method, url: call.url, fields: JSON.parse(call.options.body).fields };
}

/// Airtable answers the tag lookup with `existing` (or nothing), and accepts the
/// write that follows.
function tagUpsertStub(existing) {
  airtable.reply = (url, options = {}) => {
    if (options.method === "PATCH" || options.method === "POST") {
      return { status: 200, body: JSON.stringify({ id: existing?.id || "recTAGnew00000000" }) };
    }
    return { status: 200, body: JSON.stringify({ records: existing ? [existing] : [] }) };
  };
}

// ---------------------------------------------------------------------------
// POST /app/tags — the label and the vendor record
// ---------------------------------------------------------------------------

test("a new tag stores the label and the vendor record", async () => {
  airtable.reset();
  tagUpsertStub(null);

  const res = await post("/app/tags", {
    tagNumber: "0592123456",
    orderNumber: "i0lYC",
    passengerName: "JONSDOTTIR/SIGRIDUR",
    zpl: ZPL,
    tagData: TAG_DATA,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: "recTAGnew00000000", created: true, updated: false, label: "stored", tagData: "stored",
  });

  const write = writeCall();
  assert.equal(write.method, "POST");
  assert.equal(write.fields["Label ZPL"], ZPL);
  assert.equal(write.fields["BagTag Number"], "0592123456");
  // Stored as JSON text a person can read in the Airtable cell.
  assert.deepEqual(JSON.parse(write.fields["Tag data"]), TAG_DATA);
  assert.match(write.fields["Tag data"], /\n/, "the vendor record is pretty-printed");
});

test("a row that has no label yet gains one — that is the whole point", async () => {
  airtable.reset();
  // Exactly the shape the delivery flow leaves behind: a tag with an order and
  // no label, because nobody rendered one when the row was made.
  tagUpsertStub({ id: "recTAG00000000001", fields: { "BagTag Number": "0592123456", "Order No": "i0lYC" } });

  const res = await post("/app/tags", { tagNumber: "0592123456", zpl: ZPL });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.label, "stored");
  assert.equal(body.updated, true);
  assert.equal(writeCall().fields["Label ZPL"], ZPL);
});

test("whitespace in the cell is not a label", async () => {
  airtable.reset();
  tagUpsertStub({ id: "recTAG00000000001", fields: { "BagTag Number": "0592123456", "Label ZPL": "  \n " } });

  const res = await post("/app/tags", { tagNumber: "0592123456", zpl: ZPL });
  assert.equal((await res.json()).label, "stored");
  assert.equal(writeCall().fields["Label ZPL"], ZPL);
});

test("the same label sent twice writes nothing", async () => {
  airtable.reset();
  tagUpsertStub({
    id: "recTAG00000000001",
    fields: { "BagTag Number": "0592123456", "Label ZPL": ZPL, "Tag data": JSON.stringify(TAG_DATA, null, 2) },
  });

  // The app resends a tag after a dropped connection and the Mac logs it again
  // on every reprint; neither may cost a write.
  const res = await post("/app/tags", { tagNumber: "0592123456", zpl: ZPL, tagData: TAG_DATA });

  assert.deepEqual(await res.json(), {
    id: "recTAG00000000001", created: false, updated: false, label: "unchanged", tagData: "unchanged",
  });
  assert.equal(writeCall(), null, "no PATCH at all");
});

test("a DIFFERENT label never silently replaces the stored one", async () => {
  airtable.reset();
  tagUpsertStub({
    id: "recTAG00000000001",
    fields: { "BagTag Number": "0592123456", "Label ZPL": ZPL },
  });

  // The stored label describes a plate already stuck to a suitcase. A second,
  // different render means one of the two is wrong; the stored one stays, and
  // the caller is told so rather than left believing it won.
  const res = await post("/app/tags", {
    tagNumber: "0592123456", zpl: OTHER_ZPL, passengerName: "JONSDOTTIR/SIGRIDUR",
  });

  const body = await res.json();
  assert.equal(body.label, "conflict");

  // The rest of the upsert still happens — a conflict is about the label only.
  const write = writeCall();
  assert.equal(write.fields["Passenger Name"], "JONSDOTTIR/SIGRIDUR");
  assert.ok(!("Label ZPL" in write.fields), "the stored label must not be in the PATCH");
});

test("replaceLabel:true is the deliberate, reported way to overwrite one", async () => {
  airtable.reset();
  tagUpsertStub({ id: "recTAG00000000001", fields: { "BagTag Number": "0592123456", "Label ZPL": ZPL } });

  const res = await post("/app/tags", { tagNumber: "0592123456", zpl: OTHER_ZPL, replaceLabel: true });

  assert.equal((await res.json()).label, "replaced");
  assert.equal(writeCall().fields["Label ZPL"], OTHER_ZPL);
});

test("a label that is not ZPL is dropped, and the tag is still logged", async () => {
  for (const zpl of ["not a label at all", "   ", 12345, "^XA".padEnd(20001, "A")]) {
    airtable.reset();
    tagUpsertStub(null);

    const res = await post("/app/tags", { tagNumber: "0592123456", zpl });
    const body = await res.json();

    assert.equal(res.status, 200, `${String(zpl).slice(0, 20)}: the tag row is worth more than the label`);
    assert.equal(body.created, true);
    assert.equal(body.label, typeof zpl === "string" && !zpl.trim() ? "none" : "invalid");
    assert.ok(!("Label ZPL" in writeCall().fields));
    assert.equal(writeCall().fields["BagTag Number"], "0592123456");
  }
});

test("tagData is accepted as a JSON string as well as an object", async () => {
  airtable.reset();
  tagUpsertStub(null);

  const res = await post("/app/tags", { tagNumber: "0592123456", tagData: JSON.stringify(TAG_DATA) });

  assert.equal((await res.json()).tagData, "stored");
  assert.deepEqual(JSON.parse(writeCall().fields["Tag data"]), TAG_DATA);
});

test("tagData that is not a JSON object is dropped, and the tag is still logged", async () => {
  for (const tagData of ["{not json", [TAG_DATA], 7]) {
    airtable.reset();
    tagUpsertStub(null);

    const res = await post("/app/tags", { tagNumber: "0592123456", tagData });
    const body = await res.json();

    assert.equal(body.created, true, `${JSON.stringify(tagData)}: still logged`);
    assert.equal(body.tagData, "invalid");
    assert.ok(!("Tag data" in writeCall().fields));
  }
});

test("a caller that sends neither is byte-for-byte the old behaviour", async () => {
  airtable.reset();
  tagUpsertStub(null);

  // The payload build 40 and the Mac's tag_log.py already send.
  const res = await post("/app/tags", {
    tagNumber: "0592123456",
    orderNumber: "i0lYC",
    orderRecordId: "recORDER000000001",
    passengerName: "JONSDOTTIR/SIGRIDUR",
    pnr: "ABC123",
    flight: "FI 542",
    flightDate: "2026-09-19",
    destination: "PRG",
    bcbpRaw: "M1JONSDOTTIR/SIGRIDUR",
    uthringingarRecordId: "recUTH00000000001",
  });

  const body = await res.json();
  assert.equal(body.created, true);
  assert.equal(body.label, "none");
  assert.equal(body.tagData, "none");

  const fields = writeCall().fields;
  assert.ok(!("Label ZPL" in fields) && !("Tag data" in fields));
  assert.deepEqual(fields["Order No copy"], ["recORDER000000001"]);
  assert.deepEqual(fields["Úthringingar"], ["recUTH00000000001"]);
  assert.equal(fields["Flight Date"], "2026-09-19");
});

// ---------------------------------------------------------------------------
// GET /app/orders/:orderRef/tags
// ---------------------------------------------------------------------------

const ORDER = {
  id: "recORDER000000001",
  fields: { "Pöntunarnúmer (fx)": "i0lYC", "Tag numbers": ["recTAGLINKED00001"] },
};

// Two tags on one order that reach it by different routes: the first carries
// only the "Order No" text (the claimer never resolved the order's record id),
// the second only the link. Both belong in the answer.
const TAG_BY_TEXT = {
  id: "recTAGTEXT0000001",
  createdTime: "2026-09-18T09:00:00.000Z",
  fields: {
    "BagTag Number": "0592111111", "Order No": "i0lYC", "Passenger Name": "JONSDOTTIR/SIGRIDUR",
    PNR: "ABC123", Flight: "FI 542", "Flight Date": "2026-09-19", Destination: "PRG",
    "Label ZPL": ZPL, Delivered: true,
  },
};
const TAG_BY_LINK = {
  id: "recTAGLINKED00001",
  createdTime: "2026-09-18T09:05:00.000Z",
  fields: { "BagTag Number": "0592222222", "Passenger Name": "JONSSON/JON", Flight: "FI 542" },
};

// What Airtable really answers when a single record is fetched and is not
// there: 403, not 404. It refuses to distinguish "gone" from "not yours", and
// this endpoint has to read both as "no such order" (checked live against
// appHB2bNYPAhfUcLv on 2026-09-18 — the stub said 404 and the base said 403).
const GONE_403 = { status: 403, body: '{"error":{"type":"INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"}}' };
const GONE_404 = { status: 404, body: '{"error":{"type":"MODEL_ID_NOT_FOUND"}}' };

/// Airtable with one order and its two tags, reachable by either identifier.
function orderWithTagsStub({ order = ORDER, tags = [TAG_BY_TEXT, TAG_BY_LINK], gone = GONE_403 } = {}) {
  airtable.reply = (url) => {
    if (url.includes(`/${ORDERS}/`)) {
      return order ? { status: 200, body: JSON.stringify(order) } : gone;
    }
    if (url.includes(`/${ORDERS}?`)) {
      return { status: 200, body: JSON.stringify({ records: order ? [order] : [] }) };
    }
    return { status: 200, body: JSON.stringify({ records: tags }) };
  };
}

test("the tag list is reachable by the 5-char order number", async () => {
  airtable.reset();
  orderWithTagsStub();

  const res = await boot.request("/app/orders/i0lYC/tags", { headers: AUTH });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.found, true);
  assert.equal(body.orderNumber, "i0lYC");
  assert.equal(body.orderRecordId, "recORDER000000001");
  assert.equal(body.count, 2);

  // Oldest first: tags are claimed one after another, so this is the order of
  // the stack of labels in the driver's hand.
  assert.deepEqual(body.tags.map((t) => t.tagNumber), ["0592111111", "0592222222"]);
  assert.deepEqual(body.tags[0], {
    recordId: "recTAGTEXT0000001",
    tagNumber: "0592111111",
    passengerName: "JONSDOTTIR/SIGRIDUR",
    pnr: "ABC123",
    flight: "FI 542",
    flightDate: "2026-09-19",
    destination: "PRG",
    delivered: true,
    hasLabel: true,
    createdAt: "2026-09-18T09:00:00.000Z",
  });
  assert.equal(body.tags[1].hasLabel, false, "a tag with no label says so");
  assert.equal(body.tags[1].delivered, false);

  // The label itself is not in the list — a 32-bag group would be 65 kB.
  assert.ok(body.tags.every((t) => !("zpl" in t) && !("_zpl" in t)));
});

test("the same list is reachable by the Orders record id", async () => {
  airtable.reset();
  orderWithTagsStub();

  const res = await boot.request("/app/orders/recORDER000000001/tags", { headers: AUTH });
  const body = await res.json();

  assert.equal(body.found, true);
  assert.equal(body.orderNumber, "i0lYC");
  assert.deepEqual(body.tags.map((t) => t.tagNumber), ["0592111111", "0592222222"]);

  // Read straight off the record — no search for an id we already have.
  assert.ok(airtable.calls[0].url.includes(`/${ORDERS}/recORDER000000001`));
});

test("the tag query asks for both the text match and the linked rows", async () => {
  airtable.reset();
  orderWithTagsStub();
  await boot.request("/app/orders/i0lYC/tags", { headers: AUTH });

  const tagCall = airtable.calls.find((c) => c.url.includes(TAGS));
  const formula = decodeURIComponent(new URL(tagCall.url).searchParams.get("filterByFormula"));
  assert.equal(formula, "OR({Order No}='i0lYC',RECORD_ID()='recTAGLINKED00001')");

  // A tag matched by both routes is one tag, not two.
  airtable.reset();
  orderWithTagsStub({ tags: [TAG_BY_TEXT, TAG_BY_TEXT] });
  const body = await (await boot.request("/app/orders/i0lYC/tags", { headers: AUTH })).json();
  assert.equal(body.count, 1);
});

test("?labels=1 embeds the labels, for pre-loading a day before driving out", async () => {
  airtable.reset();
  orderWithTagsStub();

  const body = await (await boot.request("/app/orders/i0lYC/tags?labels=1", { headers: AUTH })).json();
  assert.equal(body.tags[0].zpl, ZPL);
  assert.equal(body.tags[1].zpl, null, "no label stored is null, not an empty string");
  assert.ok(body.tags.every((t) => !("_zpl" in t)));
});

test("an order that does not exist is an empty answer, not an error", async () => {
  const cases = [
    ["recORDERGONE00001", GONE_403],   // what the real base answers
    ["recORDERGONE00001", GONE_404],
    ["zzzzz", GONE_403],               // the search path: 200 with no records
  ];

  for (const [ref, gone] of cases) {
    airtable.reset();
    orderWithTagsStub({ order: null, gone });

    const res = await boot.request(`/app/orders/${ref}/tags`, { headers: AUTH });
    assert.equal(res.status, 200, `${ref} (${gone.status}) must not be an error`);
    assert.deepEqual(await res.json(), {
      found: false, orderNumber: null, orderRecordId: null, count: 0, tags: [],
    });
    // Nothing to look tags up by, so nothing was asked of the tag table.
    assert.ok(!airtable.calls.some((c) => c.url.includes(TAGS)));
  }
});

test("a real Airtable outage is still an error, not an empty order", async () => {
  // The 403/404 leniency above must not swallow anything else: a 500 or a 429
  // has to reach the app as a failure, or a driver reads "no tags" during an
  // outage and hands over a bag with no label.
  for (const status of [429, 500, 502]) {
    airtable.reset();
    airtable.reply = () => ({ status, body: "upstream says no" });

    const res = await boot.request("/app/orders/recORDER000000001/tags", { headers: AUTH });
    assert.equal(res.status, status === 429 ? 400 : 502, `Airtable ${status}`);
    assert.deepEqual(await res.json(), { error: "Airtable request failed" });
  }
});

test("a 403 the whole token shares is an outage, NOT an order with no tags", async () => {
  // Airtable answers both "this row is gone" and "you may not read this table"
  // with the same 403, and the app's common path is the record id — so reading
  // that 403 as "missing" on its own turns a permissions or token failure into
  // "engir töskumiðar skráðir á þessa pöntun" on a driver's phone, with the bag
  // in their hand. The list query for the same id is what tells the two apart:
  // it comes back empty for a deleted row and fails when the table is gone.
  airtable.reset();
  airtable.reply = () => GONE_403;

  const res = await boot.request("/app/orders/recORDER000000001/tags", { headers: AUTH });
  assert.equal(res.status, 400, "a 4xx from Airtable is reported as a failure");
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });
  assert.ok(!airtable.calls.some((c) => c.url.includes(TAGS)), "and no tag list was invented");
});

test("the deleted-order 403 is confirmed by a list query before it becomes found:false", async () => {
  airtable.reset();
  orderWithTagsStub({ order: null, gone: GONE_403 });

  const body = await (await boot.request("/app/orders/recORDERGONE00001/tags", { headers: AUTH })).json();
  assert.equal(body.found, false);

  const reask = airtable.calls[1];
  assert.ok(reask && reask.url.includes(`/${ORDERS}?`), "the 403 is re-asked as a list query");
  assert.equal(
    decodeURIComponent(new URL(reask.url).searchParams.get("filterByFormula")),
    "RECORD_ID()='recORDERGONE00001'"
  );

  // A 404 is unambiguous and costs no second call.
  airtable.reset();
  orderWithTagsStub({ order: null, gone: GONE_404 });
  await boot.request("/app/orders/recORDERGONE00001/tags", { headers: AUTH });
  assert.equal(airtable.calls.length, 1);
});

test("the label route tells the same two 403s apart", async () => {
  airtable.reset();
  airtable.reply = () => GONE_403;

  const res = await boot.request("/app/tags/recTAGTEXT0000001/label", { headers: AUTH });
  assert.equal(res.status, 400, "an outage must not read as 'that bag has no tag'");
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });

  // The same 403 for a tag that really is not ours still answers found:false.
  airtable.reset();
  labelStub(null, GONE_403);
  const gone = await (await boot.request("/app/tags/recTAGGONE0000001/label", { headers: AUTH })).json();
  assert.equal(gone.found, false);
});

test("an order with no tags yet is a clean empty list", async () => {
  airtable.reset();
  orderWithTagsStub({ order: { id: "recORDER000000001", fields: { "Pöntunarnúmer (fx)": "i0lYC" } }, tags: [] });

  const res = await boot.request("/app/orders/i0lYC/tags", { headers: AUTH });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    found: true, orderNumber: "i0lYC", orderRecordId: "recORDER000000001", count: 0, tags: [],
  });
});

test("an Airtable failure on the tag list is still the shared error shape", async () => {
  airtable.reset();
  airtable.reply = () => ({ status: 500, body: "upstream is down" });

  const res = await boot.request("/app/orders/i0lYC/tags", { headers: AUTH });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });
});

// ---------------------------------------------------------------------------
// GET /app/tags/:tagRef/label
// ---------------------------------------------------------------------------

const STORED_TAG = {
  id: "recTAGTEXT0000001",
  fields: {
    "BagTag Number": "0592111111", "Order No": "i0lYC", "Passenger Name": "JONSDOTTIR/SIGRIDUR",
    PNR: "ABC123", Flight: "FI 542", "Flight Date": "2026-09-19", Destination: "PRG",
    "Label ZPL": ZPL, "Tag data": JSON.stringify(TAG_DATA, null, 2),
  },
};

function labelStub(record, gone = GONE_403) {
  airtable.reply = (url) => {
    if (url.includes(`/${TAGS}/`)) {
      return record ? { status: 200, body: JSON.stringify(record) } : gone;
    }
    return { status: 200, body: JSON.stringify({ records: record ? [record] : [] }) };
  };
}

test("a label is fetched by the tag's record id", async () => {
  airtable.reset();
  labelStub(STORED_TAG);

  const res = await boot.request("/app/tags/recTAGTEXT0000001/label", { headers: AUTH });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    found: true,
    recordId: "recTAGTEXT0000001",
    tagNumber: "0592111111",
    passengerName: "JONSDOTTIR/SIGRIDUR",
    pnr: "ABC123",
    flight: "FI 542",
    flightDate: "2026-09-19",
    destination: "PRG",
    orderNumber: "i0lYC",
    hasLabel: true,
    zpl: ZPL,
    // The vendor record travels with it, so a client whose stored label is
    // missing or stale can render one itself from the same source the Mac used.
    tagData: TAG_DATA,
  });
});

test("a scanned bag tag number reaches its label in one call", async () => {
  airtable.reset();
  labelStub(STORED_TAG);

  const body = await (await boot.request("/app/tags/0592111111/label", { headers: AUTH })).json();
  assert.equal(body.zpl, ZPL);

  const formula = decodeURIComponent(new URL(airtable.calls[0].url).searchParams.get("filterByFormula"));
  assert.equal(formula, "{BagTag Number}='0592111111'");
});

test("a tag claimed before labels were stored says so instead of failing", async () => {
  airtable.reset();
  labelStub({ id: "recTAGTEXT0000001", fields: { "BagTag Number": "0592111111" } });

  const body = await (await boot.request("/app/tags/0592111111/label", { headers: AUTH })).json();
  assert.equal(body.found, true);
  assert.equal(body.hasLabel, false);
  assert.equal(body.zpl, null);
  assert.equal(body.tagData, null);
});

test("unparsable stored tag data is reported as absent, not as a fault", async () => {
  airtable.reset();
  labelStub({ id: "recTAGTEXT0000001", fields: { "BagTag Number": "0592111111", "Label ZPL": ZPL, "Tag data": "typed by hand" } });

  const res = await boot.request("/app/tags/0592111111/label", { headers: AUTH });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.zpl, ZPL, "the label is what this route is for");
  assert.equal(body.tagData, null);
});

test("a tag that is not ours is a lookup miss, the same as /app/tags/find", async () => {
  const cases = [["recTAGGONE0000001", GONE_403], ["recTAGGONE0000001", GONE_404], ["0000000000", GONE_403]];

  for (const [ref, gone] of cases) {
    airtable.reset();
    labelStub(null, gone);

    const res = await boot.request(`/app/tags/${ref}/label`, { headers: AUTH });
    assert.equal(res.status, 200, `${ref} (${gone.status}): a scan of someone else's bag is not an error`);
    assert.deepEqual(await res.json(), {
      found: false, recordId: null, tagNumber: null, hasLabel: false, zpl: null, tagData: null,
    });
  }
});

test("the label route reports a real outage rather than an empty label", async () => {
  airtable.reset();
  airtable.reply = () => ({ status: 500, body: "upstream says no" });

  const res = await boot.request("/app/tags/recTAGTEXT0000001/label", { headers: AUTH });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });
});

// ---------------------------------------------------------------------------
// The guard in front of all of it
// ---------------------------------------------------------------------------

test("both new routes sit behind requireAppToken like every other /app route", async () => {
  airtable.reset();

  for (const path of ["/app/orders/i0lYC/tags", "/app/orders/i0lYC/tags?labels=1",
                      "/app/orders/recORDER000000001/tags", "/app/tags/0592111111/label",
                      "/app/tags/recTAGTEXT0000001/label"]) {
    const res = await boot.request(path);
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { error: "Unauthorized" }, path);

    const wrong = await boot.request(path, { headers: { "x-app-token": "x".repeat(APP_TOKEN.length) } });
    assert.equal(wrong.status, 401, `${path} with a wrong token of the right length`);
  }

  assert.deepEqual(airtable.calls, [], "an unauthorized request must never reach Airtable");
});
