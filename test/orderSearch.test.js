// GET /app/orders/search — Dagurinn's widening search (build 47, 2026-10-02).
//
// Dagurinn searches the day on screen on the phone, then asks this route for
// the seven days around that day, then for every order. Three things changed
// here for that: the pickup address (what a stop shows, so what a driver types)
// is searched too, an optional from/to window limits the pickup day, and the
// answer is newest first so the 100-row cap goes to recent orders. `upcoming=1`
// and the plain search keep answering as before.
//
// Everything drives the real index.js through test/_indexHarness.js, so nothing
// here touches api.airtable.com.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { bootIndex, airtable, APP_TOKEN } from "./_indexHarness.js";

const boot = await bootIndex();
after(() => boot.close());

const ORDERS = "tblWLlNxZvtkFSFXs";
const AUTH = { "x-app-token": APP_TOKEN };

const search = (query) => boot.request(`/app/orders/search?${query}`, { headers: AUTH });

/// The one Airtable read a search makes, as the query it carried.
function onlyCall() {
  assert.equal(airtable.calls.length, 1, "a search is exactly one Airtable read");
  const url = new URL(airtable.calls[0].url);
  assert.equal(url.pathname, `/v0/appHB2bNYPAhfUcLv/${ORDERS}`);
  return url.searchParams;
}

test("a plain search matches name, pickup address, delivery address and order number, newest first", async () => {
  airtable.reset();
  const payload = { records: [{ id: "recTESTTESTTEST1", fields: { "Pöntunarnúmer (fx)": "i0lYC" } }] };
  airtable.reply = () => ({ status: 200, body: JSON.stringify(payload) });

  const res = await search("q=Laugavegur");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), payload, "Airtable's answer passes through unchanged");

  const params = onlyCall();
  assert.equal(
    params.get("filterByFormula"),
    "AND({Greitt}, OR(" +
      "FIND('laugavegur', LOWER({Nafn viðskiptavinar}))," +
      "FIND('laugavegur', LOWER({Heimilisfang}))," +
      "FIND('laugavegur', LOWER({Delivery Address}))," +
      "FIND('laugavegur', LOWER({Pöntunarnúmer (fx)}))" +
      "))",
    "no date clause at all without a window: the whole history is searched",
  );
  assert.equal(params.get("maxRecords"), "100");
  assert.equal(params.get("sort[0][field]"), "Dagsetning pick-up");
  assert.equal(params.get("sort[0][direction]"), "desc");
});

test("from/to limit the pickup day, inclusive, and drop undated orders", async () => {
  airtable.reset();

  const res = await search("q=Jón&from=2026-09-29&to=2026-10-05");
  assert.equal(res.status, 200);

  const formula = onlyCall().get("filterByFormula");
  assert.ok(
    formula.startsWith(
      "AND({Greitt}, {Dagsetning pick-up}, " +
        "NOT(IS_BEFORE({Dagsetning pick-up}, '2026-09-29')), " +
        "NOT(IS_AFTER({Dagsetning pick-up}, '2026-10-05')), OR(",
    ),
    formula,
  );
  assert.match(formula, /FIND\('jón', LOWER\(\{Heimilisfang\}\)\)/);
});

test("either end of the window works alone", async () => {
  airtable.reset();
  await search("q=x&from=2026-09-29");
  let formula = onlyCall().get("filterByFormula");
  assert.match(formula, /NOT\(IS_BEFORE\(\{Dagsetning pick-up\}, '2026-09-29'\)\)/);
  assert.doesNotMatch(formula, /IS_AFTER/);

  airtable.reset();
  await search("q=x&to=2026-10-05");
  formula = onlyCall().get("filterByFormula");
  assert.match(formula, /NOT\(IS_AFTER\(\{Dagsetning pick-up\}, '2026-10-05'\)\)/);
  assert.doesNotMatch(formula, /IS_BEFORE/);
});

test("a from or to that is not YYYY-MM-DD is a 400 and never reaches Airtable", async () => {
  airtable.reset();

  for (const query of [
    "q=x&from=2026-9-29",
    "q=x&to=05.10.2026",
    "q=x&from=2026-09-29')",
    "q=x&to=2026-10-05%27%2C%20TRUE()",
    "q=x&from=yesterday",
  ]) {
    const res = await search(query);
    assert.equal(res.status, 400, query);
    assert.match((await res.json()).error, /^(from|to) must be YYYY-MM-DD$/, query);
  }
  assert.deepEqual(airtable.calls, [], "a bad date is refused before the formula is built");
});

test("q is still required, window or not", async () => {
  airtable.reset();
  const res = await search("from=2026-09-29&to=2026-10-05");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "q is required" });
  assert.deepEqual(airtable.calls, []);
});

test("upcoming=1 still drops past pickups, and combines with a window", async () => {
  airtable.reset();
  const today = new Date().toISOString().slice(0, 10);

  await search("q=x&upcoming=1");
  let formula = onlyCall().get("filterByFormula");
  assert.ok(
    formula.startsWith(`AND({Greitt}, {Dagsetning pick-up}, NOT(IS_BEFORE({Dagsetning pick-up}, '${today}')), OR(`),
    formula,
  );

  airtable.reset();
  await search("q=x&upcoming=1&to=2099-01-01");
  formula = onlyCall().get("filterByFormula");
  assert.equal(formula.match(/\{Dagsetning pick-up\}, NOT/g).length, 1, "the date must be present once, not per clause");
  assert.match(formula, new RegExp(`NOT\\(IS_BEFORE\\(\\{Dagsetning pick-up\\}, '${today}'\\)\\)`));
  assert.match(formula, /NOT\(IS_AFTER\(\{Dagsetning pick-up\}, '2099-01-01'\)\)/);
});

test("the query stays a quoted literal: a quote cannot break out of the formula", async () => {
  airtable.reset();
  await search(`q=${encodeURIComponent("O'Brien")}`);
  const formula = onlyCall().get("filterByFormula");
  assert.match(formula, /FIND\('o\\'brien', LOWER\(\{Heimilisfang\}\)\)/);
});

test("an Airtable failure keeps the existing error shape", async () => {
  airtable.reset();
  airtable.reply = () => ({ status: 422, body: '{"error":"INVALID_FILTER_BY_FORMULA"}' });

  const res = await search("q=x&from=2026-09-29&to=2026-10-05");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });
});
