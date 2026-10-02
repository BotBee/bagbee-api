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

/// The order's searchable text as the formula builds it: the four fields
/// joined, lower-cased, then folded letter by letter.
const RECORD_TEXT =
  "LOWER({Nafn viðskiptavinar} & ' ' & {Heimilisfang} & ' ' & {Delivery Address} & ' ' & {Pöntunarnúmer (fx)})";

/// The words a formula FINDs, in order.
const foundWords = (formula) => [...formula.matchAll(/FIND\('((?:[^'\\]|\\.)*)', /g)].map((m) => m[1]);

test("a plain search matches name, pickup address, delivery address and order number, newest first", async () => {
  airtable.reset();
  const payload = { records: [{ id: "recTESTTESTTEST1", fields: { "Pöntunarnúmer (fx)": "i0lYC" } }] };
  airtable.reply = () => ({ status: 200, body: JSON.stringify(payload) });

  const res = await search("q=Laugavegur");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), payload, "Airtable's answer passes through unchanged");

  const params = onlyCall();
  const formula = params.get("filterByFormula");
  assert.ok(
    formula.startsWith("AND({Greitt}, FIND('laugavegur', SUBSTITUTE("),
    `no date clause at all without a window: the whole history is searched — ${formula.slice(0, 80)}`,
  );
  assert.ok(formula.includes(RECORD_TEXT), "all four fields, as one lower-cased text");
  assert.deepEqual(foundWords(formula), ["laugavegur"]);
  assert.ok(formula.endsWith(")"));
  assert.equal(params.get("maxRecords"), "100");
  assert.equal(params.get("sort[0][field]"), "Dagsetning pick-up");
  assert.equal(params.get("sort[0][direction]"), "desc");
});

// Build 47 review, 2026-10-02: the day tier on the phone ignores accents and
// matches every word on its own; the 7-day and all-orders tiers matched the raw
// string, so "jon" found Jón on the day and nothing one tier out.

test("accents and Icelandic letters are folded on both sides: 'jon' and 'Jón' are the same search", async () => {
  airtable.reset();
  await search(`q=${encodeURIComponent("Jón")}`);
  const accented = onlyCall().get("filterByFormula");

  airtable.reset();
  await search("q=jon");
  const plain = onlyCall().get("filterByFormula");

  assert.equal(accented, plain);
  assert.deepEqual(foundWords(plain), ["jon"]);

  // The record side folds the same letters the phone folds.
  for (const [letter, folded] of [["á", "a"], ["ó", "o"], ["ö", "o"], ["í", "i"], ["ú", "u"], ["é", "e"],
    ["ý", "y"], ["ð", "d"], ["þ", "th"], ["æ", "ae"], ["ø", "o"]]) {
    assert.ok(plain.includes(`SUBSTITUTE(`) && plain.includes(`, '${letter}', '${folded}')`), `${letter} → ${folded}`);
  }

  for (const [typed, expected] of [
    ["Þórunn", "thorunn"], ["Skólavörðustígur", "skolavordustigur"], ["Lækjargata", "laekjargata"],
    ["REYKJAVÍK", "reykjavik"], ["Müller", "muller"],
  ]) {
    airtable.reset();
    await search(`q=${encodeURIComponent(typed)}`);
    assert.deepEqual(foundWords(onlyCall().get("filterByFormula")), [expected], typed);
  }
});

// Build 47 review: the query was stripped of every accent while the record
// side folds only the letters the formula lists, so "Wiśniewski" typed exactly
// as booked looked for "wisniewski" in "wiśniewski" and found nothing. Both
// sides now fold with the same table; a letter it does not list matches itself.
test("a letter the fold table does not list is kept on the query, as the record keeps it", async () => {
  for (const [typed, expected] of [
    ["Wiśniewski", ["wiśniewski"]],
    ["Šimon Dvořák", ["šimon", "dvořak"]],
    ["Łukasz", ["lukasz"]],
    ["Jo\u0301n", ["jon"]],
  ]) {
    airtable.reset();
    await search(`q=${encodeURIComponent(typed)}`);
    const formula = onlyCall().get("filterByFormula");
    assert.deepEqual(foundWords(formula), expected, typed);
    // What the record side would hold for the booked name, after the formula's folds.
    for (const word of expected) {
      for (const letter of [...word].filter((c) => /[^\x00-\x7f]/.test(c))) {
        assert.ok(!formula.includes(`, '${letter}', `), `${letter} is not folded on the record side either`);
      }
    }
  }
});

test("every word must match on its own, anywhere in the order", async () => {
  airtable.reset();
  await search(`q=${encodeURIComponent("  Jón   Laugavegur ")}`);
  const formula = onlyCall().get("filterByFormula");

  assert.deepEqual(foundWords(formula), ["jon", "laugavegur"], "one FIND per word, in the AND");
  // Each word searches the same folded text — name and street can be in
  // different fields.
  const record = formula.slice(formula.indexOf("SUBSTITUTE("), formula.indexOf("), FIND('laugavegur'"));
  assert.ok(record.includes(RECORD_TEXT));
  assert.ok(formula.endsWith(`FIND('laugavegur', ${record}))`), "the second word looks in the same text");
});

test("a long query keeps the URL inside Airtable's limit", async () => {
  airtable.reset();
  const words = "Jón Þórunn Guðmundsdóttir Skólavörðustígur Reykjavík Ísland Hafnarfjörður Kópavogur";
  await search(`q=${encodeURIComponent(words)}&from=2026-09-29&to=2026-10-05`);
  const formula = onlyCall().get("filterByFormula");
  assert.equal(foundWords(formula).length, 6, "six words at most");
  assert.ok(airtable.calls[0].url.length < 16000, `URL is ${airtable.calls[0].url.length} characters`);
});

test("a query with nothing left after folding is refused like an empty one", async () => {
  airtable.reset();
  const res = await search(`q=${encodeURIComponent("\u0301 \u0308")}`);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "q is required" });
  assert.deepEqual(airtable.calls, []);
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
        "NOT(IS_AFTER({Dagsetning pick-up}, '2026-10-05')), FIND(",
    ),
    formula,
  );
  assert.deepEqual(foundWords(formula), ["jon"], "the text clause follows the window");
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
    formula.startsWith(`AND({Greitt}, {Dagsetning pick-up}, NOT(IS_BEFORE({Dagsetning pick-up}, '${today}')), FIND('x', `),
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
  assert.deepEqual(foundWords(formula), ["o\\'brien"]);
});

test("an Airtable failure keeps the existing error shape", async () => {
  airtable.reset();
  airtable.reply = () => ({ status: 422, body: '{"error":"INVALID_FILTER_BY_FORMULA"}' });

  const res = await search("q=x&from=2026-09-29&to=2026-10-05");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Airtable request failed" });
});
