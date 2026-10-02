// Dagurinn's order screen (build 47, batch 2): the contact and flight fields on
// /app/route, and GET /app/stops/:optimoOrderNo/eta.
//
// Driven through the real index.js (test/_indexHarness.js). Its node-fetch stub
// takes every outbound call, Airtable's and OptimoRoute's alike, so `reply`
// below answers by URL. index.js reads OPTIMOROUTE_API_KEY and the ETA timeout
// once at import, which is why they are set before this file's boot — and why
// the "key missing" case is a second index.js in a child process.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { bootIndex, bootIndexChild, airtable, APP_TOKEN } from "./_indexHarness.js";

const OPTIMO_KEY = "harness-optimo-key";
process.env.OPTIMOROUTE_API_KEY = OPTIMO_KEY;
// Short, so the timeout case costs a fraction of a second rather than 4 s.
process.env.OPTIMO_ETA_TIMEOUT_MS = "150";

const boot = await bootIndex();
after(() => boot.close());

const auth = { headers: { "x-app-token": APP_TOKEN } };
const get = (path) => boot.request(path, auth);

const STOPS_TABLE = "tblE3fYDSuk7dKPdF";
const ORDERS_TABLE = "tblWLlNxZvtkFSFXs";
const isOptimo = (url) => url.startsWith("https://api.optimoroute.com/");
const optimoCalls = () => airtable.calls.filter((c) => isOptimo(c.url));
const ok = (body) => ({ status: 200, body: JSON.stringify(body) });

function isoDay(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// /app/route — email, airline, flightNumber
// ---------------------------------------------------------------------------

const ORDER = {
  id: "recORDERORDER0001",
  fields: {
    "Pöntunarnúmer (fx)": "ab12C",
    "Nafn viðskiptavinar": "Anna Jónsdóttir",
    "Símanúmer": "+354 555 1234",
    "Tölvupóstfang": "  anna@example.com ",
    "Flugfélag": "Icelandair",
    "Flugnúmer": " FI204 ",
    "Heimilisfang": ["Laugavegur 27b"],
    "Requested service": "Check-in",
    "Reference": "",
    "Total amount of bags": 3,
    "Tímasetning": "18:00 - 19:00",
  },
};

function stopRecord(id, orderNo, stopNumber, extra = {}) {
  return {
    id,
    fields: {
      "Order Number": orderNo,
      stopNumber,
      scheduledAt: "18:30",
      Driver: "BagBee driver 1 1",
      latitude: 64.14,
      longitude: -21.93,
      locationName: "Anna",
      address: "Laugavegur 27b, Reykjavík",
      "Tracking URL": "https://track.example/1",
      ...extra,
    },
  };
}

function routeStub({ stops, orders }) {
  airtable.reset();
  airtable.reply = (url) => {
    if (url.includes(`/${STOPS_TABLE}?`)) return ok({ records: stops });
    if (url.includes(`/${ORDERS_TABLE}?`)) return ok({ records: orders });
    throw new Error(`unexpected fetch ${url}`);
  };
}

test("/app/route: a pickup stop carries email, airline and flightNumber beside every key it had", async () => {
  routeStub({
    stops: [stopRecord("recSTOPSTOPSTOP01", "ab12C", 1), stopRecord("recSTOPSTOPSTOP02", "ab12C-D", 2, { "Delivery completed": true })],
    orders: [ORDER],
  });
  const date = isoDay(0);

  const res = await get(`/app/route?date=${date}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.date, date);
  assert.equal(body.stopCount, 2);
  const [pickup, delivery] = body.drivers[0].stops;

  assert.deepEqual(pickup, {
    stopNumber: 1,
    scheduledAt: "18:30",
    driver: "BagBee driver 1 1",
    leg: "pickup",
    stopRecordId: "recSTOPSTOPSTOP01",
    optimoOrderNo: "ab12C",
    latitude: 64.14,
    longitude: -21.93,
    phone: "+354 555 1234",
    email: "anna@example.com",
    airline: "Icelandair",
    flightNumber: "FI204",
    done: false,
    locationName: "Anna",
    address: "Laugavegur 27b, Reykjavík",
    orderNumber: "ab12C",
    recordId: "recORDERORDER0001",
    customerName: "Anna Jónsdóttir",
    requestedService: "Check-in",
    reference: "",
    totalBags: 3,
    timeWindow: "18:00 - 19:00",
    trackingURL: "https://track.example/1",
  });

  // The delivery leg goes to an airline, never to a person: no contact at all,
  // but the airline it ends at is still on it.
  assert.equal(delivery.leg, "delivery");
  assert.equal(delivery.optimoOrderNo, "ab12C-D");
  assert.equal(delivery.done, true);
  assert.equal(delivery.phone, null);
  assert.equal(delivery.email, null);
  assert.equal(delivery.airline, "Icelandair");
  assert.equal(delivery.flightNumber, "FI204");
});

test("/app/route: the e-mail is sent for yesterday, today and tomorrow only; the phone is untouched", async () => {
  for (const [offset, expected] of [[-2, null], [-1, "anna@example.com"], [0, "anna@example.com"], [1, "anna@example.com"], [2, null], [30, null]]) {
    routeStub({ stops: [stopRecord("recSTOPSTOPSTOP01", "ab12C", 1)], orders: [ORDER] });
    const res = await get(`/app/route?date=${isoDay(offset)}`);
    assert.equal(res.status, 200, `day ${offset}`);
    const [stop] = (await res.json()).drivers[0].stops;
    assert.equal(stop.email, expected, `day ${offset}`);
    assert.equal(stop.phone, "+354 555 1234", `day ${offset}: phone keeps its old rule`);
    assert.equal(stop.airline, "Icelandair", `day ${offset}: the airline is not contact data`);
  }
});

test("/app/route: missing or blank contact and flight fields come back null, not empty strings", async () => {
  const bare = { id: "recORDERORDER0002", fields: { "Pöntunarnúmer (fx)": "zz9Q9", "Tölvupóstfang": "   ", "Flugfélag": "" } };
  routeStub({ stops: [stopRecord("recSTOPSTOPSTOP03", "zz9Q9", 1)], orders: [bare] });

  const [stop] = (await (await get(`/app/route?date=${isoDay(0)}`)).json()).drivers[0].stops;
  assert.equal(stop.email, null);
  assert.equal(stop.airline, null);
  assert.equal(stop.flightNumber, null);

  // A stop whose order is not found at all keeps the same shape.
  routeStub({ stops: [stopRecord("recSTOPSTOPSTOP04", "gone1", 1)], orders: [] });
  const [orphan] = (await (await get(`/app/route?date=${isoDay(0)}`)).json()).drivers[0].stops;
  assert.equal(orphan.email, null);
  assert.equal(orphan.airline, null);
  assert.equal(orphan.flightNumber, null);
  assert.equal(orphan.recordId, null);
});

// ---------------------------------------------------------------------------
// GET /app/stops/:optimoOrderNo/eta
// ---------------------------------------------------------------------------

/// get_scheduling_info as OptimoRoute documents it.
function scheduled({ at = "2026-10-02 19:40:00", live } = {}) {
  return {
    success: true,
    orderScheduled: true,
    scheduleInformation: {
      stopNumber: 4,
      scheduledAt: at.slice(11, 16),
      scheduledAtDt: at,
      arrivalTimeDt: at,
      driverSerial: "001",
      driverName: "BagBee driver 1",
      distance: 952,
      travelTime: 123,
      ...(live ? { liveEstimate: { arrivalTimeDt: live, startTimeDt: live } } : {}),
    },
  };
}

function optimoStub(answer) {
  airtable.reset();
  airtable.reply = (url, options) => {
    if (!isOptimo(url)) throw new Error(`unexpected fetch ${url}`);
    return typeof answer === "function" ? answer(url, options) : answer;
  };
}

test("eta is behind requireAppToken and never reaches OptimoRoute without it", async () => {
  airtable.reset();
  const res = await boot.request("/app/stops/ab12C/eta");
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
  assert.deepEqual(airtable.calls, []);
});

test("eta: a bad order number is 400 and never reaches OptimoRoute", async () => {
  airtable.reset();
  for (const bad of ["x".repeat(33), "ab%2712", "ab%20cd", "a.b", "ab_cd", "%C3%B0ab"]) {
    const res = await get(`/app/stops/${bad}/eta`);
    assert.equal(res.status, 400, bad);
    assert.match((await res.json()).error, /optimoOrderNo/, bad);
  }
  assert.deepEqual(airtable.calls, []);
});

test("eta: a live estimate answers live, with lateness in whole minutes", async () => {
  optimoStub(ok(scheduled({ at: "2026-10-02 19:40:00", live: "2026-10-02 19:52:00" })));

  const res = await get("/app/stops/live1/eta");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    orderNo: "live1",
    scheduledAt: "2026-10-02T19:40:00Z",
    liveArrivalAt: "2026-10-02T19:52:00Z",
    source: "live",
    lateMinutes: 12,
  });

  const [call] = optimoCalls();
  const url = new URL(call.url);
  assert.equal(`${url.origin}${url.pathname}`, "https://api.optimoroute.com/v1/get_scheduling_info");
  assert.equal(url.searchParams.get("orderNo"), "live1");
  assert.equal(url.searchParams.get("key"), OPTIMO_KEY);
  assert.ok(call.options.signal, "the call carries its own timeout");
});

test("eta: early is negative, and seconds round to the nearest minute", async () => {
  optimoStub(ok(scheduled({ at: "2026-10-02 19:40:00", live: "2026-10-02 19:35:00" })));
  assert.equal((await (await get("/app/stops/early1/eta")).json()).lateMinutes, -5);

  optimoStub(ok(scheduled({ at: "2026-10-02 19:40:00", live: "2026-10-02 19:52:40" })));
  assert.equal((await (await get("/app/stops/round1/eta")).json()).lateMinutes, 13);

  optimoStub(ok(scheduled({ at: "2026-10-02 23:50:00", live: "2026-10-03 00:05:00" })));
  const overMidnight = await (await get("/app/stops/night1-D/eta")).json();
  assert.equal(overMidnight.orderNo, "night1-D", "the delivery leg's own number goes through as given");
  assert.equal(overMidnight.lateMinutes, 15);
});

test("eta: scheduled with no live estimate answers planned", async () => {
  optimoStub(ok(scheduled({ at: "2026-10-02 08:05:00" })));

  const res = await get("/app/stops/plan1/eta");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    orderNo: "plan1",
    scheduledAt: "2026-10-02T08:05:00Z",
    liveArrivalAt: null,
    source: "planned",
    lateMinutes: null,
  });
});

test("eta: not scheduled, or an order OptimoRoute does not know, is 200 with source none", async () => {
  const none = (orderNo) => ({ orderNo, scheduledAt: null, liveArrivalAt: null, source: "none", lateMinutes: null });

  optimoStub(ok({ success: true, orderScheduled: false }));
  let res = await get("/app/stops/unsch1/eta");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), none("unsch1"));

  optimoStub(ok({ success: false, code: "ERR_ORD_NOT_FOUND", message: "the order with the matching `orderNo` was not found" }));
  res = await get("/app/stops/unknown1/eta");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), none("unknown1"));
});

test("eta: OptimoRoute down, refusing, unreadable or too slow is 502 {error}, and the key never reaches the log", async (t) => {
  const logged = [];
  const spy = t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));

  const cases = [
    ["http500", () => ({ status: 500, body: "Internal Server Error" })],
    ["http429", () => ({ status: 429, body: "" })],
    ["badkey", () => ok({ success: false, code: "AUTH_KEY_UNKNOWN", message: "wrong key" })],
    ["multi", () => ok({ success: false, code: "ERR_MULTIPLE_ORD_FOUND" })],
    ["garbled", () => ({ status: 200, body: "<html>" })],
    ["unreach", () => { throw new Error(`request to https://api.optimoroute.com/v1/get_scheduling_info?key=${OPTIMO_KEY} failed`); }],
    // Never answers; the route's own 150 ms timeout must give up for it.
    ["slow", () => new Promise(() => {})],
  ];
  for (const [orderNo, answer] of cases) {
    optimoStub(answer);
    const res = await get(`/app/stops/${orderNo}/eta`);
    assert.equal(res.status, 502, orderNo);
    assert.deepEqual(await res.json(), { error: "OptimoRoute request failed" }, orderNo);
  }

  spy.mock.restore();
  assert.ok(logged.length >= cases.length, "every failure is logged");
  for (const line of logged) assert.ok(!line.includes(OPTIMO_KEY), `key leaked: ${line}`);
});

test("eta: a failure is not cached — the next request asks OptimoRoute again", async () => {
  optimoStub({ status: 503, body: "" });
  assert.equal((await get("/app/stops/retry1/eta")).status, 502);
  assert.equal(optimoCalls().length, 1);

  airtable.reply = () => ok(scheduled({ live: "2026-10-02 19:41:00" }));
  const res = await get("/app/stops/retry1/eta");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).source, "live");
  assert.equal(optimoCalls().length, 2);
});

test("eta: one OptimoRoute call per order number per 30 s, shared by callers asking at once", async (t) => {
  optimoStub(ok(scheduled({ live: "2026-10-02 19:45:00" })));

  const first = await (await get("/app/stops/cache1/eta")).json();
  const again = await (await get("/app/stops/cache1/eta")).json();
  assert.deepEqual(again, first);
  assert.equal(optimoCalls().length, 1, "the second request within 30 s is served from memory");

  // Another order number is its own entry.
  await get("/app/stops/cache2/eta");
  assert.equal(optimoCalls().length, 2);

  // Two phones opening the same order at the same moment share one call.
  const [a, b] = await Promise.all([get("/app/stops/cache3/eta"), get("/app/stops/cache3/eta")]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(optimoCalls().length, 3);

  // 30 s on, OptimoRoute is asked again and its new answer is served.
  const realNow = Date.now.bind(Date);
  t.mock.method(Date, "now", () => realNow() + 30_500);
  airtable.reply = () => ok(scheduled({ live: "2026-10-02 19:50:00" }));
  const later = await (await get("/app/stops/cache1/eta")).json();
  t.mock.restoreAll();
  assert.equal(optimoCalls().length, 4);
  assert.equal(later.liveArrivalAt, "2026-10-02T19:50:00Z");
  assert.equal(later.lateMinutes, 10);
});

test("eta: with OPTIMOROUTE_API_KEY unset the route refuses with 503 instead of calling out", async (t) => {
  const noKey = await bootIndexChild({ OPTIMOROUTE_API_KEY: null });
  t.after(() => noKey.close());

  const res = await noKey.request("/app/stops/ab12C/eta", auth);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "Server not configured" });
  assert.match(noKey.stderr, /OPTIMOROUTE_API_KEY is not set/);

  // The rest of the driver surface does not depend on the key.
  const route = await noKey.request(`/app/route?date=${isoDay(0)}`, auth);
  assert.equal(route.status, 200);
});
