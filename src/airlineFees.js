// ---------------------------------------------------------------------------
// Airline fee list — what the airline charges at the airport (GET /app/airline-fees)
// ---------------------------------------------------------------------------
//
// A price list the staff app shows a passenger at the door: extra bags, overweight,
// oversize, sports equipment, cabin bags — everything the airline charges on top
// of the ticket, per airline and, where the price depends on it, per destination
// zone. Kept in two Airtable tables so prices can be corrected without a release.
//
// Pure on purpose: no imports, no network, no clock of its own. index.js imports
// it statically (it cannot throw at import, so it cannot stop the driver routes
// from booting) and hands it Airtable's records; the tests hand it fixtures.
//
// Every read is by field id (`returnFieldsByFieldId=true`), so renaming a column
// in Airtable breaks nothing. VERIFIED against the meta API 2026-10-07.
//
// READ ONLY: nothing here, and nothing in the route, ever writes to Airtable.

export const AIRLINE_FEE_ZONES_TABLE = "tbl2CKpEVoBI2Dxp5"; // Airline fee zones
export const AIRLINE_FEES_TABLE = "tblfOdAJSsMAh5lMv"; // Airline fees

/// Airline fee zones.
export const ZONE = {
  zone: "fld1LHI7eIXBAUGkw", // internal name, the fallback label
  airline: "fldGf6EOxvdNpXY9f", // single select: Icelandair | Neos
  label: "fld88zpqdlwrAWaEK", // Icelandic label shown in the app
  destinations: "fldSutmDoaL6sME6d", // long text: IATA codes and city names, comma/newline separated
  sort: "fld8yiqhPJPtpAtbZ",
  active: "fldIPeaS5UHpyqEMV",
};

/// Airline fees.
export const FEE = {
  name: "fldQwQsdPXB6eai4D", // primary field, the fallback item text
  airline: "fldBEd8BlG7e2lE5K",
  zones: "fldH4UjV3cCSxmH2v", // links → zones; empty = every zone of the airline
  category: "fldWw5qsIkIpPaPwi",
  item: "fldFyq3hTvVryJje0",
  limits: "fldjzMtd4lPF714UD",
  airportPrice: "fldlLSl34RgkNUPcv",
  onlinePrice: "fldrrsEhLz50zQciP",
  currency: "fldYFTu32JOkH9jxt",
  per: "fld6m4GI0bEIPyQzt",
  notes: "fldmRvt75h3v7DNTu",
  sourceUrl: "fldudtx8ZxwxngefF",
  checkedOn: "fldVuOYyyXKtw7Mdi",
  confidence: "fldBN6JOAR5FXqr6q",
  sort: "fldFipdXGXgZ4oJbE",
  active: "flddB9g0709C9YpAI",
};

/// The airlines BagBee checks in for come first, in this order; any other airline
/// added in Airtable later follows alphabetically.
export const AIRLINE_ORDER = ["Icelandair", "Neos"];

/// A fee with no category is still worth showing, under "other".
export const DEFAULT_CATEGORY = "Annað";

const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})/;

/// The list-records query for one of the two tables: only Active rows, keyed by
/// field id.
///
/// Deliberately NO `fields[]`: Airtable refuses the whole read (422
/// UNKNOWN_FIELD_NAME) if any named field has been deleted, so listing all of
/// them would let tidying away Notes or Source URL silently freeze the list on
/// its last cached copy. Without it, only deleting the Active column (which the
/// filter needs) or a table can stop the list; the shaper reads only the ids it
/// knows and ignores any other column.
export function airlineFeeParams(fieldMap) {
  return [
    ["returnFieldsByFieldId", "true"],
    ["filterByFormula", `{${fieldMap.active}}`],
  ];
}

function text(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/// A row with no Sort sorts as 0, and is sent as 0, so a client that re-sorts
/// lands on the same order the server sent.
function sortOf(value) {
  return num(value) ?? 0;
}

function isoDate(value) {
  const m = typeof value === "string" ? ISO_DATE.exec(value.trim()) : null;
  return m ? m[1] : null;
}

function recordIds(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === "string" && RECORD_ID.test(id)) : [];
}

/// "KEF, CPH\nKaupmannahöfn; Copenhagen" → ["KEF", "CPH", "Kaupmannahöfn", "Copenhagen"].
/// Commas, newlines and semicolons all separate; blanks and repeats (ignoring
/// case) are dropped and the first spelling is kept.
export function parseDestinations(value) {
  if (typeof value !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const part of value.split(/[,;\r\n]+/)) {
    const entry = part.trim();
    const key = entry.toLocaleLowerCase("is");
    if (!entry || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function airlineRank(name) {
  const i = AIRLINE_ORDER.indexOf(name);
  return i === -1 ? AIRLINE_ORDER.length : i;
}

function byAirline(a, b) {
  return airlineRank(a.name) - airlineRank(b.name) || a.name.localeCompare(b.name, "is");
}

function bySortThen(key) {
  return (a, b) => a.sort - b.sort || a[key].localeCompare(b[key], "is") || a.id.localeCompare(b.id);
}

/// Airtable's records → the /app/airline-fees body.
///
/// Only Active rows are served (the query already asks for them; this checks
/// again so a row can never slip through a changed formula). A fee's `zoneIds`
/// keep only active zones of the fee's own airline, and EMPTY means every zone,
/// so a fee whose links all point at switched-off, deleted or foreign zones is
/// dropped rather than widened to every destination. A fee with no airline takes
/// its zones' airline; one with neither, or with no item text at all, is dropped.
export function shapeAirlineFees(zoneRecords, feeRecords, { fetchedAt = new Date() } = {}) {
  const zones = new Map(); // recId → { airline, zone }
  for (const record of zoneRecords || []) {
    const f = record?.fields || {};
    if (f[ZONE.active] !== true || !RECORD_ID.test(record.id || "")) continue;
    const airline = text(f[ZONE.airline]);
    const label = text(f[ZONE.label]) || text(f[ZONE.zone]);
    if (!airline || !label) continue;
    zones.set(record.id, {
      airline,
      zone: {
        id: record.id,
        label,
        destinations: parseDestinations(f[ZONE.destinations]),
        sort: sortOf(f[ZONE.sort]),
      },
    });
  }

  const airlines = new Map(); // name → { name, zones, fees }
  const airlineEntry = (name) => {
    if (!airlines.has(name)) airlines.set(name, { name, zones: [], fees: [] });
    return airlines.get(name);
  };
  for (const { airline, zone } of zones.values()) airlineEntry(airline).zones.push(zone);

  for (const record of feeRecords || []) {
    const f = record?.fields || {};
    if (f[FEE.active] !== true || !RECORD_ID.test(record.id || "")) continue;

    const linked = recordIds(f[FEE.zones]);
    const live = linked.filter((id) => zones.has(id));
    const airline = text(f[FEE.airline]) || (live.length ? zones.get(live[0]).airline : null);
    if (!airline) continue;
    const zoneIds = live.filter((id) => zones.get(id).airline === airline);
    if (linked.length && !zoneIds.length) continue;

    const item = text(f[FEE.item]) || text(f[FEE.name]);
    if (!item) continue;

    airlineEntry(airline).fees.push({
      id: record.id,
      zoneIds,
      category: text(f[FEE.category]) || DEFAULT_CATEGORY,
      item,
      limits: text(f[FEE.limits]),
      airportPrice: num(f[FEE.airportPrice]),
      onlinePrice: num(f[FEE.onlinePrice]),
      currency: text(f[FEE.currency]),
      per: text(f[FEE.per]),
      notes: text(f[FEE.notes]),
      sourceUrl: text(f[FEE.sourceUrl]),
      checkedOn: isoDate(f[FEE.checkedOn]),
      confidence: text(f[FEE.confidence]),
      sort: sortOf(f[FEE.sort]),
    });
  }

  const list = [...airlines.values()].sort(byAirline);
  for (const entry of list) {
    entry.zones.sort(bySortThen("label"));
    entry.fees.sort(bySortThen("item"));
  }
  return { updatedAt: fetchedAt.toISOString(), airlines: list };
}

/// Holds the last good answer for `ttlMs` and falls back to it when a refresh
/// fails. `get()` resolves `{ payload, stale, error? }`: `stale` is true when the
/// payload is an older one served because `load` just failed (`error` says why).
/// It rejects only when `load` fails and there has never been a good answer.
///
/// Concurrent callers share one `load` (the promise is held, not the answer), so
/// a dozen phones opening the list at once cost Airtable one read per table. A
/// failure is never cached: the next request tries Airtable again.
export function createStaleCache({ load, ttlMs, now = Date.now }) {
  let good = null; // { at, payload }
  let inflight = null;

  async function refresh() {
    const payload = await load();
    good = { at: now(), payload };
    return payload;
  }

  return {
    async get() {
      if (good && now() - good.at < ttlMs) return { payload: good.payload, stale: false };
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      try {
        return { payload: await inflight, stale: false };
      } catch (error) {
        if (good) return { payload: good.payload, stale: true, error };
        throw error;
      }
    },
  };
}
