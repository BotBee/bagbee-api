// ---------------------------------------------------------------------------
// OptimoRoute read client (spec §6.2)
// ---------------------------------------------------------------------------
//
// READ ONLY. The only endpoint this module knows is get_routes: there is no
// planning call, no update_completion_details, nothing that could move a stop
// or tick a delivery. The website's crons own every OptimoRoute write.
//
// Two things about the key: it travels in the query string, so the URL is never
// logged (a failed request logs the date and the error name only); and OR allows
// at most 5 concurrent requests per account, shared with the Vercel crons, so
// calls from here are strictly serial through a promise chain.

const API_ROOT = "https://api.optimoroute.com/v1";
const REQUEST_TIMEOUT_MS = 20_000;

export function optimoError(code, status = null) {
  const err = new Error(code);
  err.code = code;
  if (status !== null) err.status = status;
  return err;
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/// "BagBee driver 1 01" — driverName + serial minus its leading zero, the same
/// label rule as optimoEnrich.ts:191 and Make's substring(driverSerial;1;3), so
/// the snapshot's driver labels match what Airtable's Optimo Stops rows carry.
export function driverLabelOf(route) {
  const name = str(route?.driverName);
  if (!name) return "Unassigned";
  return `${name} ${String(route?.driverSerial ?? "").slice(1)}`.trim();
}

/// One get_routes response → normalized stops (§6.2). `routeDate` is the date
/// the routes were asked for: OR answers route-dated by construction, so its
/// post-midnight stops on D+1 belong to D (§5.4) without any clock rule.
export function normalizeRoutes(json, date) {
  const routes = Array.isArray(json?.routes) ? json.routes : [];
  const stops = [];
  const drivers = [];
  for (const route of routes) {
    const driver = driverLabelOf(route);
    drivers.push({ driver, dispatchState: str(route?.dispatchStatus?.state) || null });
    for (const stop of Array.isArray(route?.stops) ? route.stops : []) {
      const orderNo = str(stop?.orderNo);
      // Depot, start and end rows carry no orderNo — same filter as Make and the website.
      if (!orderNo) continue;
      stops.push({
        orderNo,
        base: orderNo.replace(/-D$/i, ""),
        leg: /-D$/i.test(orderNo) ? "delivery" : "pickup",
        stopNumber: Number.isFinite(Number(stop?.stopNumber)) ? Number(stop.stopNumber) : null,
        scheduledAt: str(stop?.scheduledAt) || null,
        scheduledAtDt: str(stop?.scheduledAtDt) || null,
        routeDate: date,
        driver,
        locationName: str(stop?.locationName) || null,
        address: str(stop?.address) || null,
        latitude: numOrNull(stop?.latitude),
        longitude: numOrNull(stop?.longitude),
      });
    }
  }
  return { date, stops, drivers, routeCount: routes.length };
}

export function createOptimoClient({ apiKey, fetchImpl = globalThis.fetch, logger = console, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  /// Strictly serial: every call waits for the previous one to settle, whatever
  /// the outcome, and a rejection never breaks the chain for the next caller.
  let tail = Promise.resolve();

  async function fetchRoutes(date) {
    if (!apiKey) throw optimoError("optimo_not_configured");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw optimoError("optimo_bad_date");

    const url = new URL(`${API_ROOT}/get_routes`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("date", date);
    url.searchParams.set("includeDispatchStatus", "true");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url.toString(), { method: "GET", signal: controller.signal });
    } catch (err) {
      // The error name only. The URL, and therefore the key, stays out of the log.
      logger.error?.("[optimo] get_routes failed", date, err?.name || "error");
      throw optimoError("optimo_unavailable");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      logger.error?.("[optimo] get_routes", date, response.status);
      throw optimoError(response.status === 429 ? "optimo_busy" : "optimo_unavailable", response.status);
    }

    let json;
    try {
      const text = await response.text();
      json = text ? JSON.parse(text) : {};
    } catch {
      logger.error?.("[optimo] get_routes bad body", date);
      throw optimoError("optimo_unavailable");
    }
    if (json?.success === false) {
      // OR's own "no", e.g. a bad key or a date it will not serve. `message` is
      // OR's text and carries no key.
      logger.error?.("[optimo] get_routes error", date, str(json?.message) || "unknown");
      throw optimoError("optimo_error");
    }
    return normalizeRoutes(json, date);
  }

  /// getRoutes(D) → { date, stops, drivers, routeCount }.
  function getRoutes(date) {
    const turn = tail.then(() => fetchRoutes(date));
    tail = turn.catch(() => {});
    return turn;
  }

  return { getRoutes };
}

export default createOptimoClient;
