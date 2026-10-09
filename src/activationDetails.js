// ---------------------------------------------------------------------------
// Activation mail details — who and which flight each inactive bag tag is for
// ---------------------------------------------------------------------------
//
// The activation request (POST /app/deliveries/activation and the legacy
// POST /send-activation-request) used to list bare tag numbers, and the airline
// ground handler had to look every one up before they could act on it. Rúnar,
// 2026-10-09: include the flight number, flight date and passenger name.
//
// Where each value comes from, best first, field by field:
//
//   1. the Tag numbers row itself — a tag claimed from a boarding pass carries
//      Passenger Name, PNR, Flight and Flight Date;
//   2. the row's Úthringingar link — the per-passenger check-in row (name,
//      booking reference, flight number, flight date);
//   3. the order — the row's "Order No copy" link, else the Úthringingar row's
//      order link, else the row's "Order No" text: "Flugnúmer", "Dagsetning
//      flugs" and the booker's "Nafn viðskiptavinar". A tag printed from an order
//      in the app (0523490818, the first real send) carries only its Order No, so
//      this is all there is for it.
//
// A name from the order is the person who booked, not necessarily the person
// whose bag it is, so the mail says so ("name on booking") instead of passing it
// off as the passenger. A flight date is only ever taken alongside the flight it
// belongs to: a later source's date fills a gap only when that source names the
// same flight (or none). Nothing is guessed; a value no source has is "—".
//
// Cost: at most one read per table per request (Tag numbers only on the legacy
// route — the deliveries route has already read its rows), each skipped when no
// tag still needs it, all inside one short deadline. A lookup that fails or runs
// out of time is logged and the mail goes with what is known — bare tags if
// nothing is — because an activation request must never fail for the sake of
// its decoration.
//
// Pure on purpose, like airlineFees.js: no imports and no network of its own.
// index.js imports it statically (it cannot throw at import) and hands it a
// `read(table, params, signal)` over its Airtable client; the tests hand it a
// stub. READ ONLY: nothing here writes to Airtable, and Orders in particular is
// only ever read. Its one piece of state is `activationBodies` (see "Memo"
// below), an in-process map with no I/O.
//
// Úthringingar and Orders are read by field id (`returnFieldsByFieldId=true`),
// so a renamed column breaks nothing; Tag numbers by name, because the
// deliveries route reads those rows by name already. VERIFIED against the meta
// API 2026-10-09.

export const TAG_TABLE = "tblVyZakUmK0CY0YJ"; // Tag numbers
export const UTHRINGINGAR_TABLE = "tblT74xUkrvoehHEE"; // Úthringingar
export const ORDERS_TABLE = "tblWLlNxZvtkFSFXs"; // Nýtt/óflokkað (orders) — READ ONLY

/// The Tag numbers fields the details are drawn from, by name.
export const TAG_DETAIL_FIELDS = [
  "BagTag Number", // fldonTAeVHjlxnjzk
  "Order No", // fldy75pgiN0RVAOQx, the 5-character order number as text
  "Order No copy", // fldIDaPk4pqeMq2ci, link → Orders
  "Passenger Name", // fldtrjX7YkNJugdLP
  "PNR", // fldi8feJqfwbe4uwU
  "Flight", // fldGc9CEFykEFfjWT
  "Flight Date", // fldcaH03diEm9W9PX, date
  "Úthringingar", // fldVOG9cRc3RG1jwm, link → Úthringingar
];

/// Úthringingar, by field id.
export const UTHR = {
  name: "fldYRvjuH3FBd1gGK", // Nafn Viðskiptavinar (primary), the passenger
  bookingRef: "fldaHZnkTOO5ymvve", // Booking reference
  flight: "fldUt1NtRHZPfqdot", // Flight number
  flightDate: "fldkQ1DgV0HC08L8n", // Flight date, date
  order: "fldL9bBqpqSWcBxZh", // Nýtt/óflokkað, link → Orders
};

/// Orders, by field id. The order number is not read: it is the last five
/// characters of the record id (`Pöntunarnúmer (fx)` is RIGHT(RECORD_ID(), 5)).
export const ORDER = {
  name: "flds4W4WLarQ5MBEg", // Nafn viðskiptavinar, the booker
  flight: "fldIEvZmQVE6CzlZy", // Flugnúmer
  flightDate: "fld5Hv7d5CGlqx8e1", // Dagsetning flugs, date
};

export const LOOKUP_TIMEOUT_MS = 3_000;

const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
const ORDER_NUMBER = /^[A-Za-z0-9]{5}$/;
/// Formula terms per read: keeps the URL well inside Airtable's 16k limit even
/// for 32-character tags. A request is at most 200 tags, so at most two reads.
const TERMS_PER_READ = 100;
/// A value longer than this is not a name or a flight; it is cut, not dropped.
const MAX_VALUE = 80;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DASH = "—";
const INTRO = "Please activate these inactive bag tags:";
const ON_BOOKING = "name on booking";

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/// One line of text from an Airtable value: a string (or the first non-empty
/// one of a lookup's array, or a number), control and bidi-override characters
/// and line breaks folded to spaces, trimmed, at most 80 characters. Anything
/// else is null.
export function cleanValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const cleaned = cleanValue(item);
      if (cleaned) return cleaned;
    }
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return null;
  const s = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}\u2026` : s;
}

/// The first Airtable record id in a link field, or null.
function firstLink(value) {
  if (!Array.isArray(value)) return null;
  const id = value.find((v) => typeof v === "string" && RECORD_ID.test(v.trim()));
  return id ? id.trim() : null;
}

/// "2026-10-09" (or an ISO date-time) as "9 Oct 2026"; a date that does not
/// exist, or no date, is null; any other text is shown as it stands.
export function formatFlightDate(value) {
  const s = cleanValue(value);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  if (!m) return s;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null;
  return `${d} ${MONTHS[mo - 1]} ${y}`;
}

/// A flight number in one spelling: "fi 204", "FI204" and "FI0204" are one flight.
function flightKey(flight) {
  const s = String(flight).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = /^([A-Z0-9]{2})0*(\d{1,4}[A-Z]?)$/.exec(s);
  return m ? `${m[1]}${m[2]}` : s;
}

export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/// Single-quoted formula literal.
function quote(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function fromTagRow(fields = {}) {
  return {
    passenger: cleanValue(fields["Passenger Name"]),
    pnr: cleanValue(fields.PNR),
    flight: cleanValue(fields.Flight),
    flightDate: cleanValue(fields["Flight Date"]),
  };
}

function fromUthringingar(fields = {}) {
  return {
    passenger: cleanValue(fields[UTHR.name]),
    pnr: cleanValue(fields[UTHR.bookingRef]),
    flight: cleanValue(fields[UTHR.flight]),
    flightDate: cleanValue(fields[UTHR.flightDate]),
  };
}

function fromOrder(fields = {}) {
  return {
    passenger: cleanValue(fields[ORDER.name]),
    passengerOnBooking: true,
    pnr: null,
    flight: cleanValue(fields[ORDER.flight]),
    flightDate: cleanValue(fields[ORDER.flightDate]),
  };
}

/// The sources merged field by field, best first. A flight date travels with
/// its flight: once a flight is chosen, a later source's date fills the gap only
/// if that source names the same flight, or no flight at all.
export function mergeSources(sources) {
  const out = { passenger: null, passengerOnBooking: false, pnr: null, flight: null, flightDate: null };
  for (const s of sources) {
    if (!s) continue;
    if (!out.passenger && s.passenger) {
      out.passenger = s.passenger;
      out.passengerOnBooking = s.passengerOnBooking === true;
    }
    if (!out.pnr && s.pnr) out.pnr = s.pnr;
    if (!out.flight && s.flight) {
      out.flight = s.flight;
      if (!out.flightDate && s.flightDate) out.flightDate = s.flightDate;
    } else if (!out.flightDate && s.flightDate && (!s.flight || !out.flight || flightKey(s.flight) === flightKey(out.flight))) {
      out.flightDate = s.flightDate;
    }
  }
  return out;
}

const complete = (d) => Boolean(d.passenger && d.flight && d.flightDate);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// `terms` OR-ed together, at most 100 to a read, the reads one after another.
async function readWhere(read, table, terms, extraParams, signal) {
  const records = [];
  for (let i = 0; i < terms.length; i += TERMS_PER_READ) {
    if (signal?.aborted) throw new Error("aborted");
    const chunk = terms.slice(i, i + TERMS_PER_READ);
    const formula = chunk.length === 1 ? chunk[0] : `OR(${chunk.join(", ")})`;
    const got = await read(table, [["filterByFormula", formula], ...extraParams], signal);
    records.push(...(Array.isArray(got) ? got : []));
  }
  return records;
}

const byFieldId = (ids) => [["returnFieldsByFieldId", "true"], ...ids.map((id) => ["fields[]", id])];

/// The Tag numbers rows of `tagNumbers`, matched exactly (once trimmed).
async function readTagRows(read, tagNumbers, signal) {
  const unique = [...new Set(tagNumbers)];
  const terms = unique.map((t) => `TRIM({BagTag Number})=${quote(t)}`);
  return readWhere(read, TAG_TABLE, terms, TAG_DETAIL_FIELDS.map((f) => ["fields[]", f]), signal);
}

/// The best row per tag number: the one that says most about the bag, then the
/// newest. A tag claimed twice is still one bag.
function bestRowPerTag(records) {
  const score = (r) => {
    const f = r.fields || {};
    const own = fromTagRow(f);
    return [own.passenger, own.flight, own.flightDate, own.pnr, firstLink(f["Úthringingar"]), firstLink(f["Order No copy"]), cleanValue(f["Order No"])]
      .filter(Boolean).length;
  };
  const best = new Map();
  for (const record of records || []) {
    const tag = cleanValue(record?.fields?.["BagTag Number"]);
    if (!tag) continue;
    const held = best.get(tag);
    if (!held || score(record) > score(held) ||
        (score(record) === score(held) && String(record.createdTime || "") > String(held.createdTime || ""))) {
      best.set(tag, record);
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/// What the mail can say about each of `tagNumbers`.
///
/// `tagRecords`: the Tag numbers rows already in hand (fields by name, at least
/// TAG_DETAIL_FIELDS), or omitted to look the tags up. `read(table, params,
/// signal)` answers a list of records and may throw.
///
/// Never throws. Answers `{ details, problems }`: `details` is a Map from tag
/// number to `{ found, passenger, passengerOnBooking, pnr, flight, flightDate }`,
/// or null when even the tags could not be read (the mail then lists bare
/// tags); `problems` lists what went wrong, for the log.
export async function resolveActivationDetails({ tagNumbers, tagRecords, read, timeoutMs = LOOKUP_TIMEOUT_MS }) {
  const tags = [...new Set((tagNumbers || []).map(cleanValue).filter(Boolean))];
  const problems = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const { signal } = controller;
  const why = (stage, err) =>
    problems.push(`${stage}: ${signal.aborted ? `no answer within ${timeoutMs} ms` : err?.message || String(err)}`);

  try {
    let rows = tagRecords;
    if (!rows) {
      try {
        rows = await readTagRows(read, tags, signal);
      } catch (err) {
        why("Tag numbers", err);
        return { details: null, problems };
      }
    }
    const rowOf = bestRowPerTag(rows);

    // tag → { row, sources[] }; every tag gets an entry, found or not.
    const state = new Map(tags.map((tag) => {
      const row = rowOf.get(tag) || null;
      return [tag, { row, sources: row ? [fromTagRow(row.fields)] : [] }];
    }));
    const needs = (s, check = complete) => s.row && !check(mergeSources(s.sources));

    // 2. The per-passenger check-in row.
    const uthrIds = new Set();
    for (const s of state.values()) {
      const link = s.row && firstLink(s.row.fields?.["Úthringingar"]);
      if (link && needs(s, (d) => complete(d) && d.pnr)) uthrIds.add(link);
    }
    const uthrById = new Map();
    if (uthrIds.size) {
      try {
        const terms = [...uthrIds].map((id) => `RECORD_ID()=${quote(id)}`);
        for (const r of await readWhere(read, UTHRINGINGAR_TABLE, terms, byFieldId(Object.values(UTHR)), signal)) {
          if (r && uthrIds.has(r.id)) uthrById.set(r.id, r);
        }
      } catch (err) {
        why("Úthringingar", err);
      }
    }
    for (const s of state.values()) {
      const link = s.row && firstLink(s.row.fields?.["Úthringingar"]);
      const uthr = link && uthrById.get(link);
      if (uthr) {
        s.sources.push(fromUthringingar(uthr.fields));
        s.uthrOrder = firstLink(uthr.fields?.[UTHR.order]);
      }
    }

    // 3. The order: by its link, else the check-in row's link, else its number.
    const orderIds = new Set();
    const orderNumbers = new Set();
    for (const s of state.values()) {
      if (!needs(s)) continue;
      const f = s.row.fields || {};
      s.orderId = firstLink(f["Order No copy"]) || s.uthrOrder || null;
      const number = cleanValue(f["Order No"]);
      s.orderNumber = !s.orderId && number && ORDER_NUMBER.test(number) ? number : null;
      if (s.orderId) orderIds.add(s.orderId);
      else if (s.orderNumber) orderNumbers.add(s.orderNumber);
    }
    if (orderIds.size || orderNumbers.size) {
      try {
        const terms = [
          ...[...orderIds].map((id) => `RECORD_ID()=${quote(id)}`),
          ...[...orderNumbers].map((n) => `RIGHT(RECORD_ID(), 5)=${quote(n)}`),
        ];
        const orders = await readWhere(read, ORDERS_TABLE, terms, byFieldId(Object.values(ORDER)), signal);
        const byId = new Map(orders.filter((r) => r && typeof r.id === "string").map((r) => [r.id, r]));
        for (const s of state.values()) {
          let order = null;
          if (s.orderId) order = byId.get(s.orderId) || null;
          else if (s.orderNumber) {
            // Exact and case-sensitive, whatever Airtable's `=` does; two orders
            // ending alike would be a guess, so neither is taken.
            const hits = [...byId.values()].filter((r) => r.id.slice(-5) === s.orderNumber);
            order = hits.length === 1 ? hits[0] : null;
          }
          if (order) s.sources.push(fromOrder(order.fields));
        }
      } catch (err) {
        why("Orders", err);
      }
    }

    const details = new Map();
    for (const [tag, s] of state) details.set(tag, { found: Boolean(s.row), ...mergeSources(s.sources) });
    return { details, problems };
  } catch (err) {
    // Belt and braces: a bug above must cost the decoration, not the mail.
    why("details", err);
    return { details: null, problems };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const byTag = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/// The mail's text and HTML bodies. With `details` (a Map from
/// resolveActivationDetails), one row per tag, sorted by tag so the same tags
/// always make the same mail: Bag tag | Passenger | Flight | Flight date, and a
/// PNR column when any tag has one. Without, the bare list it always was.
export function renderActivationMail(tagNumbers, details) {
  if (!(details instanceof Map)) {
    const lines = tagNumbers.map((t) => `• ${t}`).join("\n");
    return {
      text: `${INTRO}\n\n${lines}\n`,
      html: `
    <p>${INTRO}</p>
    <ul>${tagNumbers.map((t) => `<li><code>${escapeHtml(t)}</code></li>`).join("")}</ul>
  `,
    };
  }

  const rows = [...tagNumbers].sort(byTag).map((tag) => {
    const d = details.get(cleanValue(tag)) || {};
    return {
      tag,
      passenger: d.passenger || null,
      onBooking: Boolean(d.passenger && d.passengerOnBooking),
      flight: d.flight || null,
      date: formatFlightDate(d.flightDate),
      pnr: d.pnr || null,
    };
  });
  const withPnr = rows.some((r) => r.pnr);

  const lines = rows.map((r) => {
    const passenger = r.passenger ? `${r.passenger}${r.onBooking ? ` (${ON_BOOKING})` : ""}` : DASH;
    return `• ${[r.tag, passenger, r.flight || DASH, r.date || DASH].join(" — ")}${r.pnr ? ` — PNR ${r.pnr}` : ""}`;
  });
  const text = `${INTRO}\n\n${lines.join("\n")}\n`;

  const cell = 'style="border:1px solid #cccccc;padding:6px 10px;text-align:left;vertical-align:top"';
  const head = ["Bag tag", "Passenger", "Flight", "Flight date", ...(withPnr ? ["PNR"] : [])]
    .map((h) => `<th ${cell}>${h}</th>`).join("");
  const body = rows.map((r) => {
    const passenger = r.passenger
      ? `${escapeHtml(r.passenger)}${r.onBooking ? ` <span style="color:#666666">(${ON_BOOKING})</span>` : ""}`
      : DASH;
    const cells = [
      `<code>${escapeHtml(r.tag)}</code>`,
      passenger,
      r.flight ? escapeHtml(r.flight) : DASH,
      r.date ? escapeHtml(r.date) : DASH,
      ...(withPnr ? [r.pnr ? escapeHtml(r.pnr) : DASH] : []),
    ];
    return `<tr>${cells.map((c) => `<td ${cell}>${c}</td>`).join("")}</tr>`;
  }).join("\n      ");
  const html = `
    <p>${INTRO}</p>
    <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:14px">
      <thead><tr style="background:#f2f2f2">${head}</tr></thead>
      <tbody>
      ${body}
      </tbody>
    </table>
  `;
  return { text, html };
}

// ---------------------------------------------------------------------------
// Memo — one body per idempotency key
// ---------------------------------------------------------------------------
//
// Resend answers a reused Idempotency-Key with the original response only when
// the payload is the same; the same key with a different payload is a 409
// (invalid_idempotent_request). The key is the tags, the handler, the sender
// and the ten-minute window, but the body now also depends on a lookup that
// runs again on every tap, and can come out differently: a timeout or a 429 on
// one tap and not the next, or a claim filling in the passenger in between.
// So a retap after a send that timed out at our end (and may well have gone)
// would carry the same key with a new body, be refused, leave the rows owed and
// unstamped, and the first tap after the window rolled over would mail the
// handler a second time.
//
// The memo pins the body to the key instead: the first body rendered for a
// handler and a tag set inside a window is the body every later send of the
// same tags to the same handler in that window carries, whatever the lookup
// says by then. A body from an earlier window is dropped the first time a later
// window is asked about. In-process, which is enough because Railway runs a
// single instance (the same assumption as withDeliveriesLock in index.js);
// held here rather than in index.js so a test can start each case empty.

/// More distinct sends than this in ten minutes is not a driver tapping Send;
/// the oldest is dropped rather than let the map grow.
const MEMO_MAX = 100;

export function createBodyMemo({ max = MEMO_MAX } = {}) {
  const held = new Map(); // key → { bucket, body }
  return {
    /// The body first rendered for `key` in window `bucket`; `render()` makes
    /// it the first time and its answer is kept for the rest of the window.
    body(bucket, key, render) {
      for (const [k, v] of held) if (v.bucket !== bucket) held.delete(k);
      const hit = held.get(key);
      if (hit) return hit.body;
      const body = render();
      held.set(key, { bucket, body });
      while (held.size > max) held.delete(held.keys().next().value);
      return body;
    },
    get size() {
      return held.size;
    },
    clear() {
      held.clear();
    },
  };
}

/// The process's memo, used by index.js's sendActivationMail.
export const activationBodies = createBodyMemo();
