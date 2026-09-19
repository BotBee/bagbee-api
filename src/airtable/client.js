// ---------------------------------------------------------------------------
// Rate-limited, read-only Airtable client (spec §5.2)
// ---------------------------------------------------------------------------
//
// The existing airtableFetch/airtableFetchAll in index.js stay untouched, so
// /app/* carries zero risk from this file. This client exists because /v2 reads
// far more often than /app does and shares Airtable's 5 req/s per-base budget
// with Make, the website and the Mac scripts — one burst from here would show up
// as 429s in the booking flow.
//
// READ ONLY. There is deliberately no create/update/delete here: writing to
// Orders (tblWLlNxZvtkFSFXs) fires real customer emails.

import { BASE_ID, escapeFormulaValue } from "./fields.js";

const API_ROOT = "https://api.airtable.com/v0";
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_5XX_MS = 2_000;
const JOB_429_WAIT_MS = 30_000;
const DEFAULT_MAX_PAGES = 20;
const PAGE_SIZE = 100;
const ID_BATCH = 50;

/// Errors carry a snake_case `code` so routes can map them to the §4.5 bodies
/// without matching on message text.
export function airtableError(code, status = null) {
  const err = new Error(code);
  err.code = code;
  if (status !== null) err.status = status;
  return err;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// Token bucket, 4 requests/s with burst 4, FIFO. Airtable allows 5/s per base;
/// the fifth is left for everything else that talks to this base.
///
/// The queue is a promise chain, so waiters are served strictly in order — a
/// long page walk cannot starve an interactive login lookup behind it.
export function createTokenBucket({ rate = 4, burst = 4, now = Date.now, sleep = defaultSleep } = {}) {
  let tokens = burst;
  let last = now();
  let tail = Promise.resolve();

  async function waitForToken() {
    for (;;) {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) * rate) / 1000);
      last = t;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - tokens) / rate) * 1000));
    }
  }

  return {
    take() {
      const turn = tail.then(waitForToken);
      /// Keep the chain alive even if a caller is cancelled later.
      tail = turn.catch(() => {});
      return turn;
    },
  };
}

export function createAirtableClient({
  token,
  baseId = BASE_ID,
  fetchImpl = globalThis.fetch,
  bucket = createTokenBucket(),
  sleep = defaultSleep,
  logger = console,
} = {}) {
  /// Requests actually sent, for the job reports (§6.7 `airtableCalls`): the
  /// call budget in §5.5 is an estimate, and this is the number that checks it.
  const stats = { requests: 0 };

  /// One raw request. `interactive` callers are serving a person who is looking
  /// at a spinner: they never wait out a 429, they fail fast so the route can
  /// answer from cache or return 503 with Retry-After (§5.2).
  async function request(table, body, { interactive = false } = {}) {
    if (!token) throw airtableError("airtable_not_configured");

    let waited429 = false;
    let retried5xx = false;

    for (;;) {
      await bucket.take();
      stats.requests += 1;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetchImpl(`${API_ROOT}/${baseId}/${table}/listRecords`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        /// AbortError or a socket failure. Never log the body: formulas can
        /// contain a staff email address (§5.2).
        logger.error?.("[airtable] request failed", table, err?.name || "error");
        throw airtableError("airtable_unavailable");
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429) {
        if (interactive || waited429) {
          logger.warn?.("[airtable] 429", table);
          throw airtableError("airtable_busy", 429);
        }
        waited429 = true;
        await sleep(JOB_429_WAIT_MS);
        continue;
      }

      if (response.status >= 500) {
        if (retried5xx) {
          logger.error?.("[airtable]", response.status, table);
          throw airtableError("airtable_unavailable", response.status);
        }
        retried5xx = true;
        await sleep(RETRY_5XX_MS);
        continue;
      }

      if (!response.ok) {
        /// Status and table only — never the formula.
        logger.error?.("[airtable]", response.status, table);
        throw airtableError(response.status === 401 || response.status === 403 ? "airtable_forbidden" : "airtable_error", response.status);
      }

      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }
  }

  /// POST .../listRecords is Airtable's read endpoint. POST (not GET) because a
  /// filterByFormula listing 40 order numbers blows past the URL length limit.
  async function listAll(table, { filterByFormula, fields, sort, maxPages = DEFAULT_MAX_PAGES, interactive = false } = {}) {
    const records = [];
    let offset;
    let pages = 0;

    for (;;) {
      const body = { pageSize: PAGE_SIZE, returnFieldsByFieldId: true };
      if (filterByFormula) body.filterByFormula = filterByFormula;
      if (fields) body.fields = fields;
      if (sort) body.sort = sort;
      if (offset) body.offset = offset;

      const page = await request(table, body, { interactive });
      pages += 1;
      for (const r of page.records || []) records.push(r);
      offset = page.offset;
      if (!offset) break;

      if (pages >= maxPages) {
        /// Never silently truncate: a half-read shift window would quietly hide
        /// somebody's shift, which is worse than an error the app can retry.
        logger.error?.("[airtable] page cap hit", table);
        throw airtableError("airtable_truncated");
      }
    }

    return { records, pages };
  }

  /// RECORD_ID() batches of 50 — the only way to fetch a known set of rows in
  /// one call without a view.
  async function getByIds(table, ids, fields, { interactive = false } = {}) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    const out = [];
    for (let i = 0; i < unique.length; i += ID_BATCH) {
      const batch = unique.slice(i, i + ID_BATCH);
      const formula = `OR(${batch.map((id) => `RECORD_ID()='${escapeFormulaValue(id)}'`).join(",")})`;
      const { records } = await listAll(table, { filterByFormula: formula, fields, interactive });
      out.push(...records);
    }
    return out;
  }

  return { listAll, getByIds, request, stats };
}

// ---------------------------------------------------------------------------
// TTL cache with single-flight and a stale window (§5.3, §5.4)
// ---------------------------------------------------------------------------
//
// Lives here rather than in a new module so the file layout in §4.1 stays exact.
// Three behaviours matter and all three are about the driver in the van:
//  - single-flight, so three screens opening at once make one Airtable call;
//  - a stale window, so an Airtable outage shows yesterday's answer with
//    stale:true instead of an error screen at 05:00;
//  - an optional LRU cap, so an app that walks a year of custom ranges cannot
//    grow this map without bound (§5.4 caps the orders windows at 50).
export function createCache({ now = Date.now, max = 0, logger = console, label = "cache" } = {}) {
  const entries = new Map();

  function evictIfNeeded() {
    if (!max) return;
    while (entries.size > max) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  async function get(key, { ttlMs, staleMs = 0, load }) {
    const entry = entries.get(key);
    const age = entry ? now() - entry.fetchedAt : Infinity;
    if (entry && !entry.inflight && age < ttlMs) {
      return { value: entry.value, stale: false, fetchedAt: entry.fetchedAt };
    }
    if (entry?.inflight) return entry.inflight;

    const inflight = (async () => {
      try {
        const value = await load();
        const fetchedAt = now();
        entries.delete(key);
        entries.set(key, { value, fetchedAt });
        evictIfNeeded();
        return { value, stale: false, fetchedAt };
      } catch (err) {
        if (entry && now() - entry.fetchedAt < staleMs) {
          logger.warn?.(`[${label}] serving stale`, key, err?.code || err?.message || "error");
          entries.set(key, { value: entry.value, fetchedAt: entry.fetchedAt });
          return { value: entry.value, stale: true, fetchedAt: entry.fetchedAt };
        }
        entries.delete(key);
        throw err;
      }
    })();

    /// Keep any previous value while the refresh runs, so a failure can still
    /// fall back to it.
    entries.set(key, { ...(entry || {}), inflight });
    try {
      return await inflight;
    } finally {
      const current = entries.get(key);
      if (current?.inflight === inflight) delete current.inflight;
    }
  }

  return { get, clear: () => entries.clear(), size: () => entries.size };
}

export default createAirtableClient;
