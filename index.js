import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";
// The only static import from src/: node:crypto + src/auth/jwt.js, and it never
// throws at import, so it cannot stop the driver routes from booting. Feeds the
// staff-JWT second check in requireAppToken (spec §4.9 edit (3), build step B8).
import { staffFromJwt, APP_ROUTES_ACCEPT_STAFF_JWT } from "./src/appJwt.js";

const app = express();
app.set("trust proxy", 1);
app.use(cors());
// /v2 bodies are small JSON; parsing them first keeps a 20mb upload off the new
// routes. body-parser skips a body that is already parsed, so /app/* is unchanged.
app.use("/v2", express.json({ limit: "32kb" }));

/// body-parser rejects a malformed or oversized body with next(err), and an error
/// walks FORWARD past every ordinary middleware — including the /v2 stub below and
/// the /v2 router's own error handler inside it. Without this, a bad body on a /v2
/// path landed on Express's default HTML error page: a stack trace the app cannot
/// decode, on a path any client can hit at will. Mounted directly behind the
/// parser and scoped to /v2, so an /app/* body error still takes the old route to
/// the old page, byte for byte (§4.2).
const V2_BODY_ERRORS = {
  "entity.parse.failed": [400, "invalid_json"],
  "entity.too.large": [413, "payload_too_large"],
  "encoding.unsupported": [415, "unsupported_media_type"],
  "charset.unsupported": [415, "unsupported_media_type"],
  "request.aborted": [400, "invalid_request"],
  "request.size.invalid": [400, "invalid_request"],
};
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg shape
app.use("/v2", (err, req, res, next) => {
  const mapped = err && typeof err.type === "string" ? V2_BODY_ERRORS[err.type] : null;
  // Anything that is not a body-parser failure is none of this handler's business.
  if (!mapped || res.headersSent) return next(err);
  console.error(`[v2] body rejected: ${err.type}`);
  return res.status(mapped[0]).json({ error: mapped[1] });
});

// Delivery photos are posted as base64, so the default 100kb body limit is far too small.
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;

const AIRTABLE_BASE_ID = "appHB2bNYPAhfUcLv";
const AIRTABLE_TABLE = "tblWLlNxZvtkFSFXs";        // Nýtt/óflokkað (orders)
const TAG_TABLE = "tblVyZakUmK0CY0YJ";             // Tag numbers
const FAST_TRACK_TABLE = "tblBjNPgtuxYD3hFd";      // Fast Track
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ACTIVATION_FROM = process.env.ACTIVATION_FROM || "BagBee <onboarding@resend.dev>";
const ACTIVATION_TO = process.env.ACTIVATION_TO || "pax@airportassociates.com";
const ACTIVATION_CC = process.env.ACTIVATION_CC || "bagbee@bagbee.is";

// Shared secret the iOS app sends as `x-app-token`. Set in Railway.
const APP_TOKEN = process.env.APP_TOKEN;

// Cloudflare R2 — these used to be compiled into the iOS binary.
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT;        // https://<account>.r2.cloudflarestorage.com
const R2_BUCKET = process.env.R2_BUCKET || "photos";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;    // https://pub-....r2.dev

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/// Guards every route the app calls (spec §2.1, §4.9 edit (3)).
///
/// The shared x-app-token is checked first and exactly as before: a request that
/// carries the right one takes the same path it always has. A staff JWT is a
/// SECOND way in, off unless APP_ROUTES_ACCEPT_STAFF_JWT=1, so deploying slice 1
/// changes nothing here until the flag is flipped. Fails closed: if APP_TOKEN
/// isn't set on the server, nothing is served rather than everything.
function requireAppToken(req, res, next) {
  const supplied = req.get("x-app-token") || "";
  if (APP_TOKEN && supplied) {
    const a = Buffer.from(supplied);
    const b = Buffer.from(APP_TOKEN);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }

  // Synchronous signature + expiry check only (no DB), so this path cannot fail
  // on Postgres; a revoked session lingers here for at most 15 min (§4.9). The
  // token's identity lands on req.staff in the same shape /v2's requireStaff
  // uses, so a handler that wants to know who is calling reads one field. The
  // shared-token path sets nothing: a shared secret is not a person.
  if (APP_ROUTES_ACCEPT_STAFF_JWT) {
    const staff = staffFromJwt(req);
    if (staff) {
      req.staff = staff;
      return next();
    }
  }

  if (!APP_TOKEN) {
    console.error("APP_TOKEN is not set — refusing app requests");
    return res.status(503).json({ error: "Server not configured" });
  }
  return res.status(401).json({ error: "Unauthorized" });
}

// ---------------------------------------------------------------------------
// Airtable helpers
// ---------------------------------------------------------------------------

function airtableURL(table, suffix = "") {
  return `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${suffix}`;
}

async function airtableFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    console.error("[airtable]", response.status, text.slice(0, 400));
    const err = new Error(`Airtable ${response.status}`);
    err.status = response.status;
    err.body = text.slice(0, 300);
    throw err;
  }

  return text ? JSON.parse(text) : {};
}

/// Airtable formula values are single-quoted, so a quote in user input would
/// break out of the literal.
function escapeFormulaValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/// An Airtable record id. An order's `Pöntunarnúmer (fx)` is RIGHT(RECORD_ID(), 5)
/// and a bag tag number is all digits, so neither can be mistaken for one.
const AIRTABLE_RECORD_ID = /^rec[A-Za-z0-9]{14}$/;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function sendAirtableError(res, err, endpoint) {
  console.error(`[${endpoint}]`, err.message, err.body || "");
  const status = err.status && err.status >= 400 && err.status < 500 ? 400 : 502;
  res.status(status).json({ error: "Airtable request failed" });
}

// ---------------------------------------------------------------------------
// Orders — read
// ---------------------------------------------------------------------------

/// Paid orders picked up today. Mirrors the formula the app used to run itself.
app.get("/app/orders/today", requireAppToken, async (req, res) => {
  const formula = `AND(IS_SAME({Dagsetning pick-up}, '${todayISO()}', 'day'), {Greitt})`;
  const url = `${airtableURL(AIRTABLE_TABLE)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=100`;

  try {
    res.json(await airtableFetch(url));
  } catch (err) {
    sendAirtableError(res, err, "orders/today");
  }
});

const STOPS_TABLE = "tblE3fYDSuk7dKPdF";          // Optimo Stops

// ---------------------------------------------------------------------------
// The two order fields of a Tag numbers row
// ---------------------------------------------------------------------------
//
// A row names its order twice: "Order No", the 5-character number as text, and
// "Order No copy", the link to the Orders record. They are ONE fact — the number
// is the last five characters of the record id (`Pöntunarnúmer (fx)` is
// RIGHT(RECORD_ID(), 5)) — but the readers of the table each need a different
// half: GET /app/orders/:orderRef/tags matches on either, the check-in
// confirmation and a person in Airtable read the text, Airtable's own lookups
// follow the link. Until 2026-09-25 every caller wrote the half it happened to
// hold: the Mac, which had resolved the record id, left the text blank (14 rows
// that day) and the phone, which knows the number, left the link blank (9). So
// every write here completes the pair from whichever half it has — the text
// from the id with no lookup at all, the id from the text with ONE read on
// Orders. Orders is never written to.

const ORDER_NUMBER_LENGTH = 5;

/// The order number an Orders record id carries in its tail, or null when the
/// value is not a record id at all — nothing is invented from a bad link.
function orderNumberFromRecordId(recordId) {
  const id = String(recordId || "").trim();
  return AIRTABLE_RECORD_ID.test(id) ? id.slice(-ORDER_NUMBER_LENGTH) : null;
}

/// The Orders record id behind a number, or null when there is no such order.
/// One read, asking for the number field only so the row's width is not paid
/// for. READ ONLY.
async function orderRecordIdFromNumber(orderNumber) {
  const number = String(orderNumber || "").trim();
  if (!number) return null;
  const found = await airtableFetch(
    `${airtableURL(AIRTABLE_TABLE)}?${new URLSearchParams([
      ["filterByFormula", `{Pöntunarnúmer (fx)}='${escapeFormulaValue(number)}'`],
      ["maxRecords", "1"],
      ["fields[]", "Pöntunarnúmer (fx)"],
    ])}`
  );
  return (found.records || [])[0]?.id || null;
}

/// The order a request names, both halves, from whichever it brought.
///
/// `{ number, recordId }`, either null when it is neither known nor derivable.
/// When the request has the number only and the row it is about to update is
/// already linked to that very order, the id is read off the row: a phone that
/// re-sends a tag whose row is complete costs no Orders read. The read, when it
/// is needed, never fails the request — a tag row with a text order is worth
/// more than its link, and a claim must not be lost to a slow Orders table.
async function orderIdentity(b, existing, what) {
  let number = String(b.orderNumber || "").trim();
  let recordId = String(b.orderRecordId || "").trim();
  if (recordId && !number) number = orderNumberFromRecordId(recordId) || "";
  if (number && !recordId && existing) {
    recordId = (existing.fields?.["Order No copy"] || [])
      .find((id) => orderNumberFromRecordId(id) === number) || "";
  }
  if (number && !recordId) {
    try {
      recordId = (await orderRecordIdFromNumber(number)) || "";
      if (!recordId) console.warn(`[${what}] order ${number}: no such order — text stored, no link`);
    } catch (err) {
      console.warn(`[${what}] order ${number}: record id not resolved (${err.message}) — text stored, no link`);
    }
  }
  return { number: number || null, recordId: recordId || null };
}

/// The order fields to write on an existing row, given the order the request
/// names (`orderIdentity`). The request's text is filled in by the caller's
/// fill-blanks loop; this appends its link, as before, and then turns the same
/// fill-blanks rule on the row's OWN two cells, so a row that arrived here with
/// one half gains the other whatever the request brought — the request's order
/// first when it has one, the row's when it has not.
async function orderFieldsForRow(existing, order, what) {
  const fields = {};
  const cur = existing.fields || {};
  const links = Array.isArray(cur["Order No copy"]) ? cur["Order No copy"] : [];
  const textBlank = isBlankCell(cur["Order No"]);

  // The link is a list, so "already linked" means the order is in it.
  if (order.recordId && !links.includes(order.recordId)) {
    fields["Order No copy"] = [...links, order.recordId];
  }
  if (textBlank && !order.number && links.length) {
    const number = orderNumberFromRecordId(links[0]);
    if (number) fields["Order No"] = number;
  }
  if (!links.length && !order.recordId && !textBlank) {
    const { recordId } = await orderIdentity({ orderNumber: cur["Order No"] }, null, what);
    if (recordId) fields["Order No copy"] = [recordId];
  }
  return fields;
}

/// Records a bag tag issued by BagChain against its order.
///
/// Without this a tag exists at BagChain and at the airline but nowhere on our
/// side: the order page cannot show it, the bag cannot be found by its number
/// later, and a damage claim has no trail.
///
/// Keyed on the tag number, which is a licence plate and unique. An existing row
/// is FILLED IN, never overwritten — rows are also created by the delivery flow
/// and by hand, and a check-in arriving afterwards must not wipe an attachment
/// or a Delivered tick. The app may resend the same tag after a dropped
/// connection, so this has to be safe to call twice.
///
/// A tag whose number is new but whose boarding pass was scanned earlier as a
/// fallback (POST /app/passes — airport check-in down) fills THAT pending row,
/// matched on "BCBP Raw" among rows with no plate, instead of adding a second
/// row for the same bag. The reply then also carries `filledPending: true`, and
/// `label` can be "cleared" (see below); every existing key is unchanged, and a
/// claim with no pending row behind it is the same create as before.
app.post("/app/tags", requireAppToken, async (req, res) => {
  const b = req.body || {};
  const tagNumber = String(b.tagNumber || "").trim();
  if (!tagNumber) return res.status(400).json({ error: "tagNumber is required" });

  // Only fields with something in them; a blank must never clear a filled cell.
  const incoming = {};
  const put = (field, value) => {
    const v = typeof value === "string" ? value.trim() : value;
    if (v !== undefined && v !== null && v !== "") incoming[field] = v;
  };
  put("BagTag Number", tagNumber);
  put("Passenger Name", b.passengerName);
  put("PNR", b.pnr);
  put("Flight", b.flight);
  put("Destination", b.destination);
  put("BCBP Raw", b.bcbpRaw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.flightDate || ""))) {
    incoming["Flight Date"] = b.flightDate;
  }

  // The label and the vendor's record travel with the tag from build 41 on. A
  // caller that doesn't send them is unaffected: both come back "none".
  const label = normalizeLabel(b.zpl);
  const tagData = normalizeTagData(b.tagData);
  if (label.status === "invalid") console.warn(`[tags] ${tagNumber}: label ignored — ${label.why}`);
  if (tagData.status === "invalid") console.warn(`[tags] ${tagNumber}: tagData ignored — ${tagData.why}`);

  try {
    const found = await airtableFetch(
      `${airtableURL(TAG_TABLE)}?${new URLSearchParams({
        filterByFormula: `{BagTag Number}='${escapeFormulaValue(tagNumber)}'`,
        maxRecords: "1",
      })}`
    );
    let existing = (found.records || [])[0];

    // No row carries this plate yet. If the pass it was claimed for was scanned
    // earlier as a fallback, that pending row IS this bag's row and is filled
    // in — the order must end up with one row per bag, or the pass and its tag
    // count as two. Costs one read, and only on a claim of a brand-new tag.
    let pendingFill = false;
    if (!existing && incoming["BCBP Raw"]) {
      existing = await pendingRowForPass(incoming["BCBP Raw"]);
      pendingFill = Boolean(existing);
      if (pendingFill) console.log(`[tags] ${tagNumber}: filling the pending pass row ${existing.id}`);
    }

    // Both halves of the order, from whichever the caller sent (see
    // orderIdentity). Filled under the same rules as every other field.
    const order = await orderIdentity(b, existing, "tags");
    put("Order No", order.number);

    if (existing) {
      const fields = {};
      for (const [key, value] of Object.entries(incoming)) {
        const current = existing.fields[key];
        if (current === undefined || current === null || current === "") fields[key] = value;
      }

      // "Tag data" is reference data — the vendor's own record for this plate.
      // Plain fill-blanks, like every other field above.
      let tagDataStatus = tagData.status === "ok" ? "unchanged" : tagData.status;
      if (tagData.status === "ok" && isBlankCell(existing.fields["Tag data"])) {
        fields["Tag data"] = tagData.value;
        tagDataStatus = "stored";
      }

      // "Label ZPL" is NOT plain fill-blanks, because it is the one field that
      // ends up on paper wrapped around a bag.
      //
      //   blank (or whitespace) stored  -> write it. A row created by the
      //       delivery flow, or by a claim whose render failed, has no label and
      //       must be able to gain one later — that is the whole point of the
      //       field: claimed on the Mac, printed from a phone.
      //   byte-identical             -> no write. The app resends a tag after a
      //       dropped connection, and the Mac logs the same tag again on reprint.
      //   different                  -> REFUSED, and said so in the reply.
      //       A stored label describes a plate that is already printed and
      //       stuck to a suitcase. Two renders of the same tag should be
      //       identical (same template, same 22-dot shift), so a difference
      //       means one of the two is wrong — most likely an older or newer
      //       template — and quietly replacing it would hand a driver a reprint
      //       that does not match the tag on the bag. First render wins; the
      //       caller gets label:"conflict" and can show it.
      //   replaceLabel:true          -> overwrite anyway, reported as
      //       label:"replaced". The deliberate, non-silent way to fix a label
      //       stored from a broken template. Nothing sends it today.
      let labelStatus = label.status === "ok" ? "unchanged" : label.status;
      if (pendingFill) {
        // A pending row's label, when it has one, is BagBee's OWN fallback
        // label: the passenger's name and the order, printed while the airport
        // system was down — and no plate, because there was none. It describes
        // the pass, not this tag, so the never-replace rule below does not
        // protect it: the real label lands over it ("replaced"), and a claim
        // that brought no label CLEARS it ("cleared") rather than leave it to
        // pose as the tag's label. A blank cell can still gain the real label
        // from a later reprint log; a lingering fallback would block that for
        // good as a "conflict".
        const stored = typeof existing.fields["Label ZPL"] === "string"
          ? existing.fields["Label ZPL"].trim() : "";
        if (label.status === "ok") {
          if (stored !== label.value) fields["Label ZPL"] = label.value;
          labelStatus = !stored ? "stored" : stored === label.value ? "unchanged" : "replaced";
        } else if (stored) {
          fields["Label ZPL"] = null;
          labelStatus = "cleared";
        }
      } else if (label.status === "ok") {
        const stored = typeof existing.fields["Label ZPL"] === "string"
          ? existing.fields["Label ZPL"].trim() : "";
        if (!stored) {
          fields["Label ZPL"] = label.value;
          labelStatus = "stored";
        } else if (stored !== label.value) {
          if (b.replaceLabel === true) {
            fields["Label ZPL"] = label.value;
            labelStatus = "replaced";
            console.warn(`[tags] ${tagNumber}: stored label REPLACED on request`);
          } else {
            labelStatus = "conflict";
            console.warn(`[tags] ${tagNumber}: a different label is already stored — kept the stored one`);
          }
        }
      }

      Object.assign(fields, await orderFieldsForRow(existing, order, "tags"));
      // A tag claimed from a boarding pass has no order — a BCBP carries a PNR,
      // not an order number, and nothing in the base joins the two. It links to
      // the Úthringingar passenger row the check-in run worked from instead.
      const uth = existing.fields["Úthringingar"] || [];
      if (b.uthringingarRecordId && !uth.includes(b.uthringingarRecordId)) {
        fields["Úthringingar"] = [...uth, b.uthringingarRecordId];
      }
      const extra = pendingFill ? { filledPending: true } : {};
      if (!Object.keys(fields).length) {
        return res.json({
          id: existing.id, created: false, updated: false,
          label: labelStatus, tagData: tagDataStatus, ...extra,
        });
      }
      const updated = await airtableFetch(airtableURL(TAG_TABLE, `/${existing.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      return res.json({
        id: updated.id, created: false, updated: true,
        label: labelStatus, tagData: tagDataStatus, ...extra,
      });
    }

    if (order.recordId) incoming["Order No copy"] = [order.recordId];
    if (b.uthringingarRecordId) incoming["Úthringingar"] = [b.uthringingarRecordId];
    if (label.status === "ok") incoming["Label ZPL"] = label.value;
    if (tagData.status === "ok") incoming["Tag data"] = tagData.value;
    const created = await airtableFetch(airtableURL(TAG_TABLE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: incoming, typecast: true }),
    });
    res.json({
      id: created.id, created: true, updated: false,
      label: label.status === "ok" ? "stored" : label.status,
      tagData: tagData.status === "ok" ? "stored" : tagData.status,
    });
  } catch (err) {
    sendAirtableError(res, err, "tags");
  }
});

/// An Airtable cell that holds nothing. Airtable drops an empty long-text field
/// from the record entirely, but a row edited by hand can leave whitespace
/// behind, and whitespace is not a label.
function isBlankCell(value) {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.trim() === "";
}

// A rendered tag is ~1.9 kB and the vendor's record ~0.9 kB; these caps are ten
// times that, and exist only so a runaway caller cannot push a 100k-character
// field at Airtable and get a 422 back instead of a logged tag.
const MAX_LABEL_CHARS = 20000;
const MAX_TAG_DATA_CHARS = 20000;
// The fallback label (POST /app/passes) is a different size of thing. The app
// reproduces the scanned pass on it as an UNCOMPRESSED ^GF bitmap about 380
// dots wide, and a mobile pass's Aztec or QR comes to 35-41k characters of hex
// before the label's own text — twice the tag cap, which silently dropped every
// one of them as "too long" and left the pending row with nothing to reprint.
// There is one such label per bag, never 32 per group, so 60k is a comfortable
// ceiling that still sits well under Airtable's 100k limit on a long-text cell.
const MAX_PASS_LABEL_CHARS = 60000;

/// Validates an incoming label WITHOUT ever failing the request.
///
/// A bad label must not cost us the tag row: the tag number is the licence
/// plate of a bag that is already on a belt, and losing it to a rejected body
/// would be far worse than storing no label. So anything unusable is reported
/// as "invalid" and simply not written — the rest of the upsert still happens.
function normalizeLabel(value, maxChars = MAX_LABEL_CHARS) {
  if (value === undefined || value === null) return { status: "none" };
  if (typeof value !== "string") return { status: "invalid", why: "not a string" };
  const zpl = value.trim();
  if (!zpl) return { status: "none" };
  // Every label the Swift and Python templates render opens with ^XA. Something
  // without it is not a label, and a printer handed it would jam or sit idle.
  if (!zpl.includes("^XA")) return { status: "invalid", why: "not ZPL" };
  if (zpl.length > maxChars) return { status: "invalid", why: "too long" };
  return { status: "ok", value: zpl };
}

/// The vendor's BagTagData record, as an object or as the JSON text of one.
/// Stored pretty-printed: the cell is read by people in Airtable when a tag has
/// to be explained, and by whatever re-renders a label the stored ZPL lost.
function normalizeTagData(value) {
  if (value === undefined || value === null) return { status: "none" };
  let object = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return { status: "none" };
    try {
      object = JSON.parse(text);
    } catch {
      return { status: "invalid", why: "not JSON" };
    }
  }
  // An array is almost certainly the whole `bagTags` list; one record per row.
  if (typeof object !== "object" || object === null || Array.isArray(object)) {
    return { status: "invalid", why: "not an object" };
  }
  const text = JSON.stringify(object, null, 2);
  if (!text || text.length > MAX_TAG_DATA_CHARS) return { status: "invalid", why: "too long" };
  return { status: "ok", value: text };
}

// ---------------------------------------------------------------------------
// Boarding passes scanned while the airport check-in is down
// ---------------------------------------------------------------------------

/// Formula fragment for a Tag numbers row that has no plate yet.
///
/// `&''` coerces the cell to text first, so a blank compares the same whatever
/// the field's type; a pending row missed here becomes a duplicate row the
/// moment its tag is claimed.
const NO_TAG = "LEN({BagTag Number}&'')=0";

/// Every row that carries this boarding pass, split into the ones still waiting
/// for a plate and the ones that have one.
///
/// A pass is NOT unique among claimed rows — a passenger with two bags has two
/// rows with the same raw and two different plates — so the raw is a key only
/// for the pending row, of which there is at most one per pass (POST /app/passes
/// dedupes on it). Oldest pending first, in case two ever slipped through.
async function passRows(raw) {
  const found = await airtableFetch(
    `${airtableURL(TAG_TABLE)}?${new URLSearchParams({
      filterByFormula: `{BCBP Raw}='${escapeFormulaValue(raw)}'`,
      maxRecords: "50",
    })}`
  );
  const pending = [];
  const claimed = [];
  for (const record of found.records || []) {
    (isBlankCell(record.fields?.["BagTag Number"]) ? pending : claimed).push(record);
  }
  pending.sort((a, b) => (a.createdTime || "").localeCompare(b.createdTime || ""));
  return { pending, claimed };
}

/// The one row of a pass still waiting for its plate, or null.
async function pendingRowForPass(raw) {
  return (await passRows(raw)).pending[0] || null;
}

/// Records a boarding pass scanned INSIDE an order while the airport check-in
/// (BagChain → Altea) is down.
///
/// The driver prints BagBee's own fallback label at that point, but a label is
/// not a record: without this the pass exists only on the paper, and when the
/// real tag is claimed later — from a phone, or in a batch on the Mac — nothing
/// says which order it belongs to. So the scan becomes a PENDING row in Tag
/// numbers: the pass, the passenger and the order, and no "BagTag Number".
/// POST /app/tags fills that row in when the plate arrives (matched on
/// "BCBP Raw"), and GET /app/orders/:orderRef/tags lists it meanwhile with
/// pending:true so the order screen can show it and claim from it.
///
/// Keyed on the raw barcode: one pending row per pass, however often it is
/// scanned — the app retries after a dropped connection, and a driver may scan
/// the same pass on a second phone. An existing pending row is filled in,
/// blanks only, with links appended, exactly as /app/tags treats a tag. A pass
/// that already has claimed rows (a passenger with two bags, or the system came
/// back between scan and claim) still gets its pending row, and the reply lists
/// the plates already claimed for it so the app can say so.
///
/// Body: bcbpRaw (required); orderNumber, orderRecordId, uthringingarRecordId,
/// passengerName, pnr, flight, flightDate (YYYY-MM-DD), destination; zpl — the
/// fallback label, optional, same ^XA check as /app/tags and dropped rather
/// than failing the row, but under its own, larger cap (MAX_PASS_LABEL_CHARS):
/// it carries the pass as a bitmap and is far bigger than a rendered tag.
/// Reply: { id, created, updated, pending: true, label, claimedTags }.
app.post("/app/passes", requireAppToken, async (req, res) => {
  const b = req.body || {};
  const raw = String(b.bcbpRaw || "").trim();
  if (!raw) return res.status(400).json({ error: "bcbpRaw is required" });

  const incoming = { "BCBP Raw": raw };
  const put = (field, value) => {
    const v = typeof value === "string" ? value.trim() : value;
    if (v !== undefined && v !== null && v !== "") incoming[field] = v;
  };
  put("Passenger Name", b.passengerName);
  put("PNR", b.pnr);
  put("Flight", b.flight);
  put("Destination", b.destination);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.flightDate || ""))) {
    incoming["Flight Date"] = b.flightDate;
  }
  const label = normalizeLabel(b.zpl, MAX_PASS_LABEL_CHARS);
  if (label.status === "invalid") console.warn(`[passes] fallback label ignored — ${label.why}`);

  try {
    const { pending, claimed } = await passRows(raw);
    const claimedTags = claimed.map((r) => String(r.fields["BagTag Number"]).trim());
    const existing = pending[0];

    // Both halves of the order, from whichever the scan managed to send.
    const order = await orderIdentity(b, existing, "passes");
    put("Order No", order.number);

    if (existing) {
      const fields = {};
      for (const [key, value] of Object.entries(incoming)) {
        const current = existing.fields[key];
        if (current === undefined || current === null || current === "") fields[key] = value;
      }
      // The fallback label is plain fill-blanks: it is rendered from the same
      // pass and order every time, and it is not a plate, so nothing is at
      // stake in keeping the first one.
      let labelStatus = label.status === "ok" ? "unchanged" : label.status;
      if (label.status === "ok" && isBlankCell(existing.fields["Label ZPL"])) {
        fields["Label ZPL"] = label.value;
        labelStatus = "stored";
      }
      Object.assign(fields, await orderFieldsForRow(existing, order, "passes"));
      const uth = existing.fields["Úthringingar"] || [];
      if (b.uthringingarRecordId && !uth.includes(b.uthringingarRecordId)) {
        fields["Úthringingar"] = [...uth, b.uthringingarRecordId];
      }
      if (!Object.keys(fields).length) {
        return res.json({
          id: existing.id, created: false, updated: false, pending: true,
          label: labelStatus, claimedTags,
        });
      }
      const updated = await airtableFetch(airtableURL(TAG_TABLE, `/${existing.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      return res.json({
        id: updated.id, created: false, updated: true, pending: true,
        label: labelStatus, claimedTags,
      });
    }

    if (order.recordId) incoming["Order No copy"] = [order.recordId];
    if (b.uthringingarRecordId) incoming["Úthringingar"] = [b.uthringingarRecordId];
    if (label.status === "ok") incoming["Label ZPL"] = label.value;
    const created = await airtableFetch(airtableURL(TAG_TABLE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: incoming, typecast: true }),
    });
    res.json({
      id: created.id, created: true, updated: false, pending: true,
      label: label.status === "ok" ? "stored" : label.status, claimedTags,
    });
  } catch (err) {
    sendAirtableError(res, err, "passes");
  }
});

const PASS_LIST_FIELDS = [
  "BCBP Raw", "Order No", "Order No copy", "Úthringingar", "Passenger Name", "PNR",
  "Flight", "Flight Date", "Destination", "Label ZPL",
];

/// The pending passes of one pickup day, for the Mac's batch claim
/// (claim_pending.py): every fallback-scanned pass whose ORDER is picked up on
/// `date`, joined through the orders' "Dagsetning pick-up" — a read, nothing on
/// Orders is written. The pending rows are fetched whole (there are few: each
/// is filled the moment its tag is claimed) and the day's orders once, with only
/// the fields the join needs, and the join runs here, so no formula grows with
/// the size of the day.
///
/// A pass reaches its order by the "Order No copy" link or the "Order No" text,
/// whichever the scan managed to fill — the same two routes as the tag list.
/// Unpaid orders are included and marked `paid:false`, so a caller that is
/// about to claim can decide for itself.
app.get("/app/passes/pending", requireAppToken, async (req, res) => {
  const date = (req.query.date || "").toString().trim() || todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }

  try {
    const orderParams = [["filterByFormula", `IS_SAME({Dagsetning pick-up}, '${date}', 'day')`]];
    for (const field of ["Pöntunarnúmer (fx)", "Nafn viðskiptavinar", "Greitt", "Dagsetning pick-up"]) {
      orderParams.push(["fields[]", field]);
    }
    const orders = await airtableFetchAll(AIRTABLE_TABLE, orderParams);
    // A day with no orders has no pending passes, and costs no second read.
    if (!orders.length) return res.json({ date, count: 0, passes: [] });

    const byId = new Map();
    const byNumber = new Map();
    for (const order of orders) {
      byId.set(order.id, order);
      const number = order.fields?.["Pöntunarnúmer (fx)"];
      if (number) byNumber.set(number, order);
    }

    const pendingParams = [["filterByFormula", `AND(${NO_TAG}, LEN({BCBP Raw}&'')>0)`]];
    for (const field of PASS_LIST_FIELDS) pendingParams.push(["fields[]", field]);
    const rows = await airtableFetchAll(TAG_TABLE, pendingParams);

    const passes = [];
    for (const row of rows) {
      const f = row.fields || {};
      const order = (f["Order No copy"] || []).map((id) => byId.get(id)).find(Boolean)
        || byNumber.get(f["Order No"]) || null;
      if (!order) continue;
      const zpl = typeof f["Label ZPL"] === "string" ? f["Label ZPL"].trim() : "";
      passes.push({
        recordId: row.id,
        bcbpRaw: String(f["BCBP Raw"]).trim(),
        passengerName: f["Passenger Name"] || null,
        pnr: f["PNR"] || null,
        flight: f["Flight"] || null,
        flightDate: f["Flight Date"] || null,
        destination: f["Destination"] || null,
        orderNumber: order.fields["Pöntunarnúmer (fx)"] || f["Order No"] || null,
        orderRecordId: order.id,
        customerName: order.fields["Nafn viðskiptavinar"] || null,
        paid: Boolean(order.fields["Greitt"]),
        pickupDate: order.fields["Dagsetning pick-up"] || null,
        uthringingarRecordId: (f["Úthringingar"] || [])[0] || null,
        hasLabel: zpl !== "",
        createdAt: row.createdTime || null,
      });
    }
    // Grouped by order, oldest scan first within it: the order a driver scanned
    // a household's passes in.
    passes.sort((a, b) =>
      String(a.orderNumber || "").localeCompare(String(b.orderNumber || "")) ||
      (a.createdAt || "").localeCompare(b.createdAt || "")
    );

    res.json({ date, count: passes.length, passes });
  } catch (err) {
    sendAirtableError(res, err, "passes/pending");
  }
});

/// Every page of a filtered table read, not just the first 100.
///
/// A busy day is two stops per order across several drivers and runs well past
/// one page; silently returning the first hundred would drop the end of the
/// evening route, which is exactly the part someone is checking at 17:00.
async function airtableFetchAll(table, params, { maxPages = 6 } = {}) {
  const records = [];
  let offset;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams(params);
    q.set("pageSize", "100");
    if (offset) q.set("offset", offset);
    const data = await airtableFetch(`${airtableURL(table)}?${q}`);
    records.push(...(data.records || []));
    offset = data.offset;
    if (!offset) break;
  }
  return records;
}

/// The day's route as OptimoRoute planned it: every stop in sequence, grouped by
/// driver, carrying enough of its order to draw the same row the order lists
/// draw.
///
/// Stops and orders are joined here rather than in the app. Optimo writes the
/// sequence onto the stop and the service and agency live on the order, and an
/// app that fetched both would be making the same two calls over a phone
/// connection in a van.
///
/// An order appears twice, once per leg: Optimo suffixes the delivery leg "-D".
app.get("/app/route", requireAppToken, async (req, res) => {
  const date = (req.query.date || "").toString().trim() || todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }

  try {
    const stopRecords = await airtableFetchAll(STOPS_TABLE, {
      filterByFormula:
        `DATETIME_FORMAT(ARRAYJOIN({Dagsetning pick-up (from Related Order)}),'YYYY-MM-DD')='${date}'`,
    });

    // A stop with no sequence has not been planned yet — Optimo fills the
    // number, the time and the driver together.
    const planned = stopRecords.filter((r) => typeof r.fields.stopNumber === "number");

    // Fetch the orders behind these stops in one go, so each row can carry its
    // service and agency and be coloured like every other order list.
    const orderNumbers = [
      ...new Set(planned.map((r) => baseOrderNumber(r.fields["Order Number"])).filter(Boolean)),
    ];
    const orders = orderNumbers.length
      ? await airtableFetchAll(AIRTABLE_TABLE, {
          filterByFormula: `OR(${orderNumbers
            .map((n) => `{Pöntunarnúmer (fx)}='${escapeFormulaValue(n)}'`)
            .join(",")})`,
        })
      : [];

    const orderByNumber = new Map();
    for (const o of orders) orderByNumber.set(o.fields["Pöntunarnúmer (fx)"], o);

    const stops = planned
      .map((r) => {
        const f = r.fields;
        const number = baseOrderNumber(f["Order Number"]);
        const order = orderByNumber.get(number);
        const of = order?.fields || {};
        const delivery = isDeliveryLeg(f["Order Number"]);
        return {
          stopNumber: f.stopNumber,
          scheduledAt: f.scheduledAt || null,
          driver: f.Driver || "Unassigned",
          leg: delivery ? "delivery" : "pickup",
          // The stop's own id and its untouched order number. A completion must
          // be posted against the LEG, and the delivery leg is the one carrying
          // the "-D" suffix — posting the stripped number would finish the
          // pickup instead and leave the delivery silently open.
          stopRecordId: r.id,
          optimoOrderNo: f["Order Number"] || null,
          // Coordinates, not the address: Optimo's address is free text, every
          // delivery leg reads "Keflavík International Airport", and Icelandic
          // house letters (Laugavegur 27b) geocode badly.
          latitude: typeof f.latitude === "number" ? f.latitude : null,
          longitude: typeof f.longitude === "number" ? f.longitude : null,
          // Pickup legs only. A delivery leg carries no customer contact by
          // deliberate rule — the bag goes to an airline, not to a person.
          phone: delivery ? null : of["Símanúmer"] || null,
          done: Boolean(delivery ? f["Delivery completed"] : f["Pickup completed"]),
          locationName: f.locationName || null,
          address: f.address || first(of["Heimilisfang"]) || null,
          orderNumber: number,
          recordId: order?.id || null,
          customerName: of["Nafn viðskiptavinar"] || first(f["Nafn viðskiptavinar (from Related Order)"]) || "",
          requestedService: of["Requested service"] || "",
          reference: of["Reference"] || "",
          totalBags: of["Total amount of bags"] || 0,
          timeWindow: of["Tímasetning"] || "",
          trackingURL: f["Tracking URL"] || null,
        };
      })
      .sort((a, b) => a.stopNumber - b.stopNumber);

    const byDriver = new Map();
    for (const stop of stops) {
      if (!byDriver.has(stop.driver)) byDriver.set(stop.driver, []);
      byDriver.get(stop.driver).push(stop);
    }

    res.json({
      date,
      planned: stops.length > 0,
      stopCount: stops.length,
      drivers: [...byDriver.entries()]
        .map(([driver, driverStops]) => ({ driver, stops: driverStops }))
        .sort((a, b) => a.driver.localeCompare(b.driver)),
    });
  } catch (err) {
    sendAirtableError(res, err, "route");
  }
});

/// Optimo suffixes the delivery leg of an order "-D"; both legs point at the
/// same order.
function isDeliveryLeg(orderNumber) {
  return /-D$/i.test(String(orderNumber || ""));
}

function baseOrderNumber(orderNumber) {
  return String(orderNumber || "").replace(/-D$/i, "");
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

/// The colour Airtable holds against each `Requested service` choice, so the
/// app can colour order rows from the base instead of a palette baked into a
/// release. Recolour a choice in Airtable and every phone follows.
///
/// Cached in memory for an hour: the schema changes when someone edits a select,
/// which is roughly never, and this is called on every app launch.
///
/// Reads the base schema, which needs `schema.bases:read` on AIRTABLE_TOKEN —
/// a different scope from the record read/write the rest of these routes use. If
/// it is missing this returns 200 with an empty map rather than an error, and
/// the app keeps the choices it already has.
let serviceColorCache = { at: 0, value: null };

app.get("/app/order-colors", requireAppToken, async (req, res) => {
  const HOUR = 60 * 60 * 1000;
  if (serviceColorCache.value && Date.now() - serviceColorCache.at < HOUR) {
    return res.json(serviceColorCache.value);
  }

  try {
    const schema = await airtableFetch(
      `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`
    );
    const table = (schema.tables || []).find((t) => t.id === AIRTABLE_TABLE);
    const field = (table?.fields || []).find((f) => f.name === "Requested service");

    const service = {};
    for (const choice of field?.options?.choices || []) {
      if (choice.name && choice.color) service[choice.name] = choice.color;
    }

    const payload = { service };
    serviceColorCache = { at: Date.now(), value: payload };
    res.json(payload);
  } catch (err) {
    // Deliberately not an error to the app: colour is a nicety, and the app
    // carries its own copy.
    console.warn("[order-colors] falling back to empty:", err.message);
    res.json({ service: {} });
  }
});

/// Paid orders for one pickup day. `date` is YYYY-MM-DD and defaults to today.
///
/// The date is matched against a strict pattern before it reaches the formula —
/// it is interpolated into Airtable's filter string, so anything else would be
/// an injection point.
app.get("/app/orders/day", requireAppToken, async (req, res) => {
  const date = (req.query.date || "").toString().trim() || todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }

  const formula = `AND(IS_SAME({Dagsetning pick-up}, '${date}', 'day'), {Greitt})`;
  const params = new URLSearchParams({ filterByFormula: formula, maxRecords: "100" });

  try {
    res.json(await airtableFetch(`${airtableURL(AIRTABLE_TABLE)}?${params}`));
  } catch (err) {
    sendAirtableError(res, err, "orders/day");
  }
});

/// Paid orders from today onward, soonest first.
///
/// Today counts as upcoming: a pickup later today is still ahead of the driver.
/// Orders with no pickup date are left out — they cannot be scheduled, and in a
/// check-in list an undated row is a trap.
app.get("/app/orders/upcoming", requireAppToken, async (req, res) => {
  const formula = `AND({Greitt}, {Dagsetning pick-up}, NOT(IS_BEFORE({Dagsetning pick-up}, '${todayISO()}')))`;
  const params = new URLSearchParams({ filterByFormula: formula, maxRecords: "100" });
  params.set("sort[0][field]", "Dagsetning pick-up");
  params.set("sort[0][direction]", "asc");

  try {
    res.json(await airtableFetch(`${airtableURL(AIRTABLE_TABLE)}?${params}`));
  } catch (err) {
    sendAirtableError(res, err, "orders/upcoming");
  }
});

app.get("/app/orders/search", requireAppToken, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "q is required" });

  // `upcoming=1` drops orders whose pickup has passed. Opt-in, so the older
  // callers of this endpoint keep searching the full history.
  const upcomingOnly = req.query.upcoming === "1";
  const dateClause = upcomingOnly
    ? `, {Dagsetning pick-up}, NOT(IS_BEFORE({Dagsetning pick-up}, '${todayISO()}'))`
    : "";

  const safe = escapeFormulaValue(q.toLowerCase());
  const formula = `AND({Greitt}${dateClause}, OR(` +
    `FIND('${safe}', LOWER({Nafn viðskiptavinar})),` +
    `FIND('${safe}', LOWER({Delivery Address})),` +
    `FIND('${safe}', LOWER({Pöntunarnúmer (fx)}))` +
    `))`;
  const url = `${airtableURL(AIRTABLE_TABLE)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=100`;

  try {
    res.json(await airtableFetch(url));
  } catch (err) {
    sendAirtableError(res, err, "orders/search");
  }
});

/// Single order, returned in Airtable's native `{id, fields}` shape so the app
/// can keep decoding it with the same model.
app.get("/app/orders/:recordId", requireAppToken, async (req, res) => {
  try {
    res.json(await airtableFetch(airtableURL(AIRTABLE_TABLE, `/${req.params.recordId}`)));
  } catch (err) {
    sendAirtableError(res, err, "orders/:recordId");
  }
});

// ---------------------------------------------------------------------------
// Tag numbers
// ---------------------------------------------------------------------------

app.get("/app/tags/find", requireAppToken, async (req, res) => {
  const barcode = (req.query.barcode || "").toString().trim();
  if (!barcode) return res.status(400).json({ error: "barcode is required" });

  const formula = `{BagTag Number}='${escapeFormulaValue(barcode)}'`;
  const url = `${airtableURL(TAG_TABLE)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

  try {
    const data = await airtableFetch(url);
    res.json({ recordId: data.records?.[0]?.id ?? null });
  } catch (err) {
    sendAirtableError(res, err, "tags/find");
  }
});

/// Whether a failed single-record GET means the record simply isn't there.
///
/// Airtable answers a fetch of a row that does not exist with 403
/// INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND — it will not say which of the two it
/// is — and sometimes 404. A driver opening a deleted order has to see "no
/// tags", not an error.
///
/// A 404 is unambiguous. A 403 is NOT, and reading it as "missing" on its own is
/// how an outage turns into "engir töskumiðar skráðir á þessa pöntun" on a
/// driver's phone — a sentence read with a bag already in hand, and therefore
/// the one that must never be a lie. The app's common path passes a record id
/// (PassengerRecord.bagTagOrderRef prefers recordId), so this branch, not the
/// search below it, is what a permissions or token failure would go through.
///
/// So a 403 is re-asked as a list query for the same id. The list endpoint
/// answers an id it cannot find with an empty page and a token that has lost the
/// table with an error of its own — which distinguishes the two cases Airtable
/// refuses to. Empty means gone; anything else throws, and the caller reports
/// the outage as an outage.
///
/// Logged either way: if the token really has lost the table then
/// /app/orders/today and /app/route are failing at the same moment, and these
/// lines are what explain a suspiciously empty tag list next to them.
async function recordIsMissing(err, table, id, what) {
  if (err.status !== 403 && err.status !== 404) return false;
  if (err.status === 404) {
    console.warn(`[airtable] ${what}: 404, treating as not found`);
    return true;
  }

  const found = await airtableFetch(
    `${airtableURL(table)}?${new URLSearchParams({
      filterByFormula: `RECORD_ID()='${escapeFormulaValue(id)}'`,
      maxRecords: "1",
    })}`
  );
  const missing = !((found.records || []).length);
  console.warn(
    `[airtable] ${what}: 403, and a list query ${missing ? "cannot find it either — treating as not found" : "CAN see it — not treating as not found"}`
  );
  return missing;
}

const TAG_LIST_FIELDS = [
  "BagTag Number", "Order No", "Passenger Name", "PNR",
  "Flight", "Flight Date", "Destination", "Delivered", "Label ZPL", "BCBP Raw",
];

/// The order behind either identifier, or null if there is no such order.
///
/// Returns the linked tag rows as well: the link lives on Orders as the inverse
/// of the tag table's "Order No copy", and it is the only way to find a tag that
/// was linked but never had its "Order No" text filled in.
async function findOrder(ref) {
  if (AIRTABLE_RECORD_ID.test(ref)) {
    try {
      const record = await airtableFetch(airtableURL(AIRTABLE_TABLE, `/${ref}`));
      return {
        id: record.id,
        number: record.fields["Pöntunarnúmer (fx)"] || null,
        tagIds: record.fields["Tag numbers"] || [],
      };
    } catch (err) {
      // A record id that is well formed but gone is a missing order, not a fault.
      if (await recordIsMissing(err, AIRTABLE_TABLE, ref, `order ${ref}`)) return null;
      throw err;
    }
  }

  const found = await airtableFetch(
    `${airtableURL(AIRTABLE_TABLE)}?${new URLSearchParams({
      filterByFormula: `{Pöntunarnúmer (fx)}='${escapeFormulaValue(ref)}'`,
      maxRecords: "1",
    })}`
  );
  const record = (found.records || [])[0];
  if (!record) return null;
  return {
    id: record.id,
    number: record.fields["Pöntunarnúmer (fx)"] || ref,
    tagIds: record.fields["Tag numbers"] || [],
  };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function tagSummary(record) {
  const f = record.fields || {};
  const zpl = typeof f["Label ZPL"] === "string" ? f["Label ZPL"].trim() : "";
  const tagNumber = f["BagTag Number"] || null;
  const raw = typeof f["BCBP Raw"] === "string" ? f["BCBP Raw"].trim() : "";
  return {
    recordId: record.id,
    tagNumber,
    passengerName: f["Passenger Name"] || null,
    pnr: f["PNR"] || null,
    flight: f["Flight"] || null,
    flightDate: f["Flight Date"] || null,
    destination: f["Destination"] || null,
    delivered: Boolean(f["Delivered"]),
    hasLabel: zpl !== "",
    createdAt: record.createdTime || null,
    // A row with no plate is a boarding pass scanned while the airport check-in
    // was down (POST /app/passes), waiting for its tag. The raw is what the app
    // claims from; on a claimed row it is only the pass the tag was issued for.
    pending: tagNumber === null,
    bcbpRaw: raw || null,
    _zpl: zpl,
  };
}

/// Every bag tag on one order, so a tag claimed on the Mac can be printed from a
/// phone that never saw the claim.
///
/// `:orderRef` is either the 5-character Pöntunarnúmer or the Orders record id —
/// the app has both on a route stop and on an order screen, and either works.
///
/// A tag reaches its order by one of two routes and this returns the union of
/// them: the "Order No" text, which every logger fills, and the "Order No copy"
/// link, which is filled only when the claiming side managed to resolve the
/// order's record id. A row can have either without the other.
///
/// Pending passes (POST /app/passes) are in the list too, in their place by
/// creation time, with `tagNumber: null`, `pending: true` and the `bcbpRaw` the
/// app needs to claim the real tag from. `hasLabel` on one of them means the
/// fallback label is stored, and /app/tags/:recordId/label prints it as usual.
///
/// The labels are NOT in this answer by default. A rendered tag is ~1.9 kB and a
/// golf group runs to 32 bags, so carrying them all would turn a list of names
/// into a 65 kB download over a van's connection, for a screen where the driver
/// prints one tag at a time. `hasLabel` says whether there is one to fetch, and
/// GET /app/tags/:tagRef/label fetches it when the driver taps print.
/// `?labels=1` overrides that and embeds them, for pre-loading the day's labels
/// on the depot's wifi before driving out of coverage.
app.get("/app/orders/:orderRef/tags", requireAppToken, async (req, res) => {
  const ref = String(req.params.orderRef || "").trim();
  if (!ref) return res.status(400).json({ error: "orderRef is required" });
  const withLabels = req.query.labels === "1";

  try {
    const order = await findOrder(ref);

    // No such order is an empty list, not a failure. A driver who mistypes a
    // number, or opens an order that has been deleted, should see "no tags" —
    // and so should the app, without a branch for it.
    if (!order) {
      return res.json({
        found: false, orderNumber: null, orderRecordId: null, count: 0, tags: [],
      });
    }

    const clauses = order.number ? [`{Order No}='${escapeFormulaValue(order.number)}'`] : [];
    for (const id of order.tagIds) clauses.push(`RECORD_ID()='${escapeFormulaValue(id)}'`);

    // Chunked so a very large group cannot build a filter longer than Airtable
    // will accept in a URL. One request covers anything realistic.
    const byId = new Map();
    for (const group of chunk(clauses, 100)) {
      const formula = group.length === 1 ? group[0] : `OR(${group.join(",")})`;
      const params = [["filterByFormula", formula]];
      for (const field of TAG_LIST_FIELDS) params.push(["fields[]", field]);
      for (const record of await airtableFetchAll(TAG_TABLE, params)) {
        byId.set(record.id, record);
      }
    }

    // Oldest first: tags are claimed one after another for a group, so creation
    // order is the order they were claimed and printed in, which is the order
    // of the stack in the driver's hand.
    const tags = [...byId.values()]
      .map(tagSummary)
      .sort((a, b) =>
        (a.createdAt || "").localeCompare(b.createdAt || "") ||
        String(a.tagNumber || "").localeCompare(String(b.tagNumber || ""))
      )
      .map(({ _zpl, ...tag }) => (withLabels ? { ...tag, zpl: _zpl || null } : tag));

    res.json({
      found: true,
      orderNumber: order.number,
      orderRecordId: order.id,
      count: tags.length,
      tags,
    });
  } catch (err) {
    sendAirtableError(res, err, "orders/:orderRef/tags");
  }
});

/// One tag's label, fetched when someone is about to print it.
///
/// `:tagRef` is the tag's Airtable record id (from the list above) or the bag tag
/// number itself, so a scanned barcode reaches the label in one call.
///
/// `tagData` — the vendor's own record for this plate — comes with it. When a
/// tag was claimed before the label was stored, or the stored label came from a
/// template that has since been fixed, the client can render the label itself
/// from this exactly as the Mac and the app already do.
///
/// A tag that isn't there answers 200 with found:false rather than 404: this is
/// a lookup, the same as /app/tags/find, and a scan of someone else's bag tag is
/// an ordinary outcome and not an error to be handled separately.
app.get("/app/tags/:tagRef/label", requireAppToken, async (req, res) => {
  const ref = String(req.params.tagRef || "").trim();
  if (!ref) return res.status(400).json({ error: "tagRef is required" });

  try {
    let record = null;
    if (AIRTABLE_RECORD_ID.test(ref)) {
      try {
        record = await airtableFetch(airtableURL(TAG_TABLE, `/${ref}`));
      } catch (err) {
        if (!(await recordIsMissing(err, TAG_TABLE, ref, `tag ${ref}`))) throw err;
      }
    } else {
      const found = await airtableFetch(
        `${airtableURL(TAG_TABLE)}?${new URLSearchParams({
          filterByFormula: `{BagTag Number}='${escapeFormulaValue(ref)}'`,
          maxRecords: "1",
        })}`
      );
      record = (found.records || [])[0] || null;
    }

    if (!record) {
      return res.json({ found: false, recordId: null, tagNumber: null, hasLabel: false, zpl: null, tagData: null });
    }

    const f = record.fields || {};
    const zpl = typeof f["Label ZPL"] === "string" ? f["Label ZPL"].trim() : "";
    let tagData = null;
    if (typeof f["Tag data"] === "string" && f["Tag data"].trim()) {
      try {
        tagData = JSON.parse(f["Tag data"]);
      } catch {
        // Stored by hand or by an older writer. The label is the point of this
        // route; a record we cannot parse is reported as absent, not as a fault.
        console.warn(`[tags/label] ${record.id}: "Tag data" is not JSON`);
      }
    }

    res.json({
      found: true,
      recordId: record.id,
      tagNumber: f["BagTag Number"] || null,
      passengerName: f["Passenger Name"] || null,
      pnr: f["PNR"] || null,
      flight: f["Flight"] || null,
      flightDate: f["Flight Date"] || null,
      destination: f["Destination"] || null,
      orderNumber: f["Order No"] || null,
      hasLabel: zpl !== "",
      zpl: zpl || null,
      tagData,
    });
  } catch (err) {
    sendAirtableError(res, err, "tags/:tagRef/label");
  }
});

// ---------------------------------------------------------------------------
// Fast Track — create
// ---------------------------------------------------------------------------

app.post("/app/fasttrack", requireAppToken, async (req, res) => {
  const { firstName, lastName, email, destination, airlineCode, flightNumber, amount } = req.body || {};

  if (!firstName || !lastName) {
    return res.status(400).json({ error: "firstName and lastName are required" });
  }

  const fields = {
    "Passenger 1 First Name": firstName,
    "Passenger 1 Last Name": lastName,
  };
  if (email) fields["Email"] = email;
  if (destination) fields["Destination"] = destination;
  if (airlineCode) fields["AirlineCode"] = airlineCode;
  if (flightNumber) fields["FlightNumber"] = flightNumber;
  if (typeof amount === "number") fields["Upphæð"] = amount;

  try {
    const created = await airtableFetch(airtableURL(FAST_TRACK_TABLE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields, typecast: true }),
    });
    res.json({ ok: true, id: created.id });
  } catch (err) {
    sendAirtableError(res, err, "fasttrack");
  }
});

// ---------------------------------------------------------------------------
// Delivery photos — R2 upload + Airtable attach
// ---------------------------------------------------------------------------

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

/// Signs an unsigned-payload PUT for R2's S3-compatible API (SigV4, region "auto").
function signR2Put({ bucket, key, contentType, host }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalHeaders =
    `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest =
    `PUT\n/${bucket}/${key}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;

  const kSigning = hmac(hmac(hmac(hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, dateStamp), "auto"), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    amzDate,
    payloadHash,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

app.post("/app/delivery-photo", requireAppToken, async (req, res) => {
  const { recordId, imageBase64 } = req.body || {};

  if (!recordId || !imageBase64) {
    return res.status(400).json({ error: "recordId and imageBase64 are required" });
  }
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ENDPOINT || !R2_PUBLIC_URL) {
    console.error("R2 env vars missing");
    return res.status(503).json({ error: "Photo storage not configured" });
  }

  const image = Buffer.from(imageBase64, "base64");
  if (image.length === 0) return res.status(400).json({ error: "imageBase64 is not valid base64" });

  const filename = `${crypto.randomUUID()}.jpg`;
  const host = new URL(R2_ENDPOINT).host;
  const contentType = "image/jpeg";
  const signed = signR2Put({ bucket: R2_BUCKET, key: filename, contentType, host });

  try {
    const upload = await fetch(`${R2_ENDPOINT}/${R2_BUCKET}/${filename}`, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "x-amz-date": signed.amzDate,
        "x-amz-content-sha256": signed.payloadHash,
        Authorization: signed.authorization,
      },
      body: image,
    });

    if (!upload.ok) {
      const body = await upload.text();
      console.error("[delivery-photo] R2", upload.status, body.slice(0, 300));
      return res.status(502).json({ error: `Photo upload failed (${upload.status})` });
    }

    const publicImageURL = `${R2_PUBLIC_URL}/${filename}`;

    await airtableFetch(airtableURL(TAG_TABLE, `/${recordId}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          Attachments: [{ url: publicImageURL, filename: `bag_${recordId}.jpg` }],
        },
      }),
    });

    res.json({ ok: true, url: publicImageURL });
  } catch (err) {
    console.error("[delivery-photo]", err);
    res.status(502).json({ error: "Failed to attach photo" });
  }
});

// ---------------------------------------------------------------------------
// Existing routes
// ---------------------------------------------------------------------------

app.get("/order/:recordId", async (req, res) => {
  const { recordId } = req.params;
  console.log("HIT /order route - recordId:", recordId);

  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`;
    console.log("Fetching Airtable URL:", url);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    console.log("Airtable status:", response.status);

    if (!response.ok) {
      const errBody = await response.text();
      console.log("Airtable error body:", errBody);
      return res.status(400).json({ error: "Record not found", airtableStatus: response.status, airtableError: errBody });
    }

    const data = await response.json();
    const f = data.fields;

    const totalBags =
      (f["Töskufjöldi_no"] || 0) +
      (f["Töskufjöldi_no_yfirstærð"] || 0);

    res.json({
      DynamicValue01: f["Delivery Address"] || "",
      DynamicValue02: f["Nafn Viðskiptavinar"] || "",
      DynamicValue03: f["Requested service"] || "",
      DynamicValue04: f["Tölvupóstfang"] || "",
      DynamicValue05: f["Símanúmer"] || "",
      DynamicValue06: f["Delivery Address"] || "",
      DynamicValue07: f["Delivery Time-window"] || "",
      DynamicValue08: f["Nafn Viðskiptavinar"] || "",
      DynamicValue09: f["Delivery Address"] || "",
      DynamicValue10: f["Delivery Time-window"] || "",
      DynamicValue11: f["Dagsetning pick-up"] || "",
      DynamicValue12: f["Pöntunarnúmer (fx)"] || "",
      totalBags,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/send-activation-request", requireAppToken, async (req, res) => {
  const { tagNumbers, to } = req.body || {};

  if (!Array.isArray(tagNumbers) || tagNumbers.length === 0) {
    return res.status(400).json({ error: "tagNumbers must be a non-empty array" });
  }

  if (!RESEND_API_KEY) {
    console.error("Missing RESEND_API_KEY env var");
    return res.status(500).json({ error: "Email service not configured" });
  }

  const recipient = (typeof to === "string" && to.trim()) || ACTIVATION_TO;

  const lines = tagNumbers.map((t) => `• ${t}`).join("\n");
  const text = `Please activate these inactive bag tags:\n\n${lines}\n`;
  const html = `
    <p>Please activate these inactive bag tags:</p>
    <ul>${tagNumbers.map((t) => `<li><code>${t}</code></li>`).join("")}</ul>
  `;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: ACTIVATION_FROM,
        to: [recipient],
        cc: ACTIVATION_CC ? [ACTIVATION_CC] : undefined,
        subject: `Inactive bag tags — please activate (${tagNumbers.length})`,
        text,
        html,
      }),
    });

    const result = await r.json();

    if (!r.ok) {
      console.error("[activation] Resend error:", r.status, result);
      return res.status(500).json({ error: "Failed to send email", detail: result });
    }

    console.log(`[activation] sent ${tagNumbers.length} tags to ${recipient} (cc ${ACTIVATION_CC || "none"}), id=${result.id}`);
    res.json({ ok: true, count: tagNumbers.length, id: result.id });
  } catch (err) {
    console.error("[activation] send failed:", err);
    res.status(500).json({ error: "Failed to send email", detail: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// BagBee Vakt (/v2)
// ---------------------------------------------------------------------------

/// A delegating stub. /v2 is served by src/vakt.js once it has loaded; until then,
/// or if loading failed, /v2 answers 503 and /app/* is unaffected. The import is
/// dynamic on purpose: a malformed APNS_KEY_P8 throws ERR_OSSL_UNSUPPORTED from
/// crypto.createPrivateKey, and as a static import that would crash-loop the
/// process before listen and take every driver route down with it.
let v2Handler = null;
let v2LoadError = false;
app.use("/v2", (req, res, next) => {
  if (v2Handler) return v2Handler(req, res, next);
  res.set("Retry-After", "30").status(503).json({ error: v2LoadError ? "vakt_unavailable" : "starting" });
});

app.get("/health", (req, res) => res.json({ ok: true }));

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  import("./src/vakt.js")
    .then((m) => m.startVakt({ app, server }))           // returns the /v2 router; DB/worker failures only affect /v2
    .then((handler) => { v2Handler = handler; })
    .catch((e) => { v2LoadError = true; console.error("[vakt] failed to load /v2:", e?.code || e?.message); });
});
