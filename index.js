import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(cors());
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

/// Guards every route the app calls. Fails closed: if APP_TOKEN isn't set on the
/// server, nothing is served rather than everything.
function requireAppToken(req, res, next) {
  if (!APP_TOKEN) {
    console.error("APP_TOKEN is not set — refusing app requests");
    return res.status(503).json({ error: "Server not configured" });
  }

  const supplied = req.get("x-app-token") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(APP_TOKEN);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
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

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
