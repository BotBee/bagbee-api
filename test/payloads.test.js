// Spec §10.1 test/payloads.test.js — Icelandic formatting, the exact copy from
// §6.6, and the two rules that matter most: a push carries no customer data, and
// it fits in APNs' 4 KB.

import test from "node:test";
import assert from "node:assert/strict";
import {
  fmtDateIs, plural, planBody, planPushPayload, counterPushPayload, testPushPayload,
  counterHours, collapseIdFor, expirationFor,
} from "../src/push/payloads.js";

const REF = "vakt_recAbcdefghij1234";
const BSI_REF = "bsi_recAbcdefghij1234";

test("fmtDateIs matches the proposal's format", () => {
  assert.equal(fmtDateIs("2026-09-17"), "fim. 17. sep");
  assert.equal(fmtDateIs("2026-02-12"), "fim. 12. feb");
  assert.equal(fmtDateIs("2026-09-13"), "sun. 13. sep");
  assert.equal(fmtDateIs("2026-01-01"), "fim. 1. jan");   // no leading zero
  assert.equal(fmtDateIs("2026-05-04"), "mán. 4. maí");
  assert.equal(fmtDateIs("2026-08-22"), "lau. 22. ágú");
});

test("Icelandic plurals: 1 and 21 singular, 11 plural", () => {
  assert.equal(plural(1, "taska", "töskur"), "1 taska");
  assert.equal(plural(11, "taska", "töskur"), "11 töskur");
  assert.equal(plural(21, "taska", "töskur"), "21 taska");
  assert.equal(plural(26, "taska", "töskur"), "26 töskur");
  assert.equal(plural(0, "taska", "töskur"), "0 töskur");
  assert.equal(plural(1, "pöntun", "pantanir"), "1 pöntun");
  assert.equal(plural(111, "taska", "töskur"), "111 töskur");
});

test("the plan body is the §6.6 template, first stop included only when known", () => {
  const args = { label: "Morgunvakt", date: "2026-09-17", stopCount: 11, bagCount: 26 };
  assert.equal(
    planBody({ ...args, firstStopAt: "05:25" }),
    "Morgunvakt fim. 17. sep · 11 stopp · 26 töskur · fyrsta stopp 05:25",
  );
  assert.equal(planBody(args), "Morgunvakt fim. 17. sep · 11 stopp · 26 töskur");
});

test("plan_published is the §6.6 payload, field for field", () => {
  const payload = planPushPayload({
    kind: "plan_published", shiftRef: REF, date: "2026-09-17", slot: "Morning",
    planVersion: 3, recipient: "recLCxvPg6oAKUfDp", stopCount: 11, bagCount: 26, firstStopAt: "05:25",
  });
  assert.deepEqual(payload, {
    aps: {
      alert: {
        title: "Áætlun morgundagsins er komin",
        body: "Morgunvakt fim. 17. sep · 11 stopp · 26 töskur · fyrsta stopp 05:25",
      },
      sound: "default",
      category: "PLAN_PUBLISHED",
      "interruption-level": "time-sensitive",
      "relevance-score": 1,
      "thread-id": `shift-${REF}`,
    },
    shiftRef: REF,
    kind: "driving",
    date: "2026-09-17",
    slot: "Morning",
    planVersion: 3,
    recipient: "recLCxvPg6oAKUfDp",
  });
});

test("a revision says BREYTT and keeps the same category and thread", () => {
  const base = {
    shiftRef: REF, date: "2026-09-17", slot: "Morning", planVersion: 4,
    recipient: "rec1", stopCount: 12, bagCount: 26, firstStopAt: "05:25",
  };
  const revised = planPushPayload({ ...base, kind: "plan_revised" });
  assert.equal(revised.aps.alert.title, "Áætlun uppfærð");
  assert.equal(revised.aps.alert.body, "BREYTT: Morgunvakt fim. 17. sep · 12 stopp · 26 töskur · fyrsta stopp 05:25");
  assert.equal(revised.aps.category, "PLAN_PUBLISHED");
  assert.equal(revised.aps["thread-id"], `shift-${REF}`);
  // Same collapse id, so the revision REPLACES the first banner (§6.6).
  assert.equal(collapseIdFor(REF), collapseIdFor(base.shiftRef));
});

test("tonight is today's Evening, with its own title and Kvöldvakt label", () => {
  const payload = planPushPayload({
    kind: "plan_tonight", shiftRef: REF, date: "2026-09-16", slot: "Evening",
    planVersion: 1, recipient: "rec1", stopCount: 4, bagCount: 1, firstStopAt: "17:09",
  });
  assert.equal(payload.aps.alert.title, "Áætlun kvöldsins er komin");
  assert.equal(payload.aps.alert.body, "Kvöldvakt mið. 16. sep · 4 stopp · 1 taska · fyrsta stopp 17:09");
  assert.equal(payload.aps["interruption-level"], "time-sensitive");
  assert.equal(payload.kind, "driving");
  assert.equal(payload.recipient, "rec1");
});

test("counter hours: 09–13 on the hour, 09:30–13:00 otherwise", () => {
  assert.equal(counterHours("09:00", "13:00"), "09–13");
  assert.equal(counterHours("09:30", "13:00"), "09:30–13:00");
  assert.equal(counterHours("13:00", "17:00"), "13–17");
  assert.equal(counterHours(null, "13:00"), null);
});

test("the counter payload carries the actions, the label and the recipient", () => {
  const payload = counterPushPayload({
    shiftRef: BSI_REF, date: "2026-09-17", slot: "Morning", startTime: null, endTime: null, recipient: "recX",
  });
  assert.equal(payload.aps.alert.title, "Vaktin þín á morgun: BSÍ 09–13");   // blank Start/End → fixed hours
  assert.equal(payload.aps.alert.body, "fim. 17. sep · BSÍ · Morgunn");
  assert.equal(payload.aps.category, "PLAN_PUBLISHED");
  assert.equal(payload.aps["interruption-level"], "time-sensitive");
  assert.equal(payload.aps["thread-id"], `shift-${BSI_REF}`);
  assert.equal(payload.kind, "counter");
  assert.equal(payload.planVersion, 1);
  assert.equal(payload.recipient, "recX");

  const custom = counterPushPayload({ shiftRef: BSI_REF, date: "2026-09-17", slot: "Midday", startTime: "09:30", endTime: "13:00", recipient: "recX" });
  assert.equal(custom.aps.alert.title, "Vaktin þín á morgun: BSÍ 09:30–13:00");
  assert.equal(custom.aps.alert.body, "fim. 17. sep · BSÍ · Miðdagur");

  // A Sérvakt with no Start/End has no hours to print; the date and label remain.
  const sérvakt = counterPushPayload({ shiftRef: BSI_REF, date: "2026-09-17", slot: "Custom", recipient: "recX" });
  assert.equal(sérvakt.aps.alert.title, "Vaktin þín á morgun: BSÍ");
  assert.equal(sérvakt.aps.alert.body, "fim. 17. sep · BSÍ · Sérvakt");
});

test("no stop name, address, customer name or phone reaches a payload", () => {
  // The builder is given a snapshot-shaped object whose in-app fields name a real
  // customer; only the counted fields may come out the other side (§6.6).
  const snapshot = {
    shiftRef: REF, date: "2026-09-17", slot: "Morning", planVersion: 3,
    stopCount: 11, bagCount: 26, firstStopAt: "05:25",
    firstStopName: "Neha Verma", address: "Laugavegur 12, 101 Reykjavík", phone: "+3546601234",
    locationName: "Neha Verma", routes: [{ driver: "Matas", stops: [{ locationName: "Neha Verma" }] }],
  };
  const json = JSON.stringify(planPushPayload({ ...snapshot, kind: "plan_published", recipient: "rec1" }));
  for (const forbidden of ["Neha", "Verma", "Laugavegur", "6601234", "locationName", "address", "phone"]) {
    assert.ok(!json.includes(forbidden), `payload leaked ${forbidden}`);
  }
});

test("collapse ids are ≤ 64 bytes and payloads ≤ 4096 bytes", () => {
  for (const ref of [REF, BSI_REF]) {
    assert.ok(Buffer.byteLength(collapseIdFor(ref)) <= 64, `${collapseIdFor(ref)} too long`);
  }
  assert.equal(collapseIdFor(REF), `plan-${REF}`);
  assert.equal(collapseIdFor(BSI_REF), `counter-${BSI_REF}`);

  const big = planPushPayload({
    kind: "plan_revised", shiftRef: REF, date: "2026-09-17", slot: "Evening", planVersion: 99,
    recipient: "recLCxvPg6oAKUfDp", stopCount: 999, bagCount: 9999, firstStopAt: "23:59",
  });
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(testPushPayload())) <= 4096);
});

test("the test push has no category, so it shows no Já/Kemst ekki buttons", () => {
  const payload = testPushPayload();
  assert.equal(payload.aps.alert.title, "Prufa");
  assert.equal(payload.aps.alert.body, "Tilkynningar virka á þessu tæki.");
  assert.ok(!("category" in payload.aps));
  assert.ok(!("shiftRef" in payload));
});

test("apns-expiration is the shift start estimate, not the post-midnight stop", () => {
  const evening = expirationFor({
    shiftRef: REF, date: "2026-09-16", slot: "Evening",
    firstStopDt: "2026-09-16T17:09:00Z",
  });
  assert.equal(evening, Date.parse("2026-09-16T17:09:00Z") / 1000);

  // No first stop: noon for a Morning, end of day for an Evening.
  assert.equal(expirationFor({ shiftRef: REF, date: "2026-09-17", slot: "Morning" }), Date.parse("2026-09-17T12:00:00Z") / 1000);
  assert.equal(expirationFor({ shiftRef: REF, date: "2026-09-17", slot: "Evening" }), Date.parse("2026-09-17T23:59:00Z") / 1000);

  // Counter: date + Start, falling back to the fixed hours.
  assert.equal(expirationFor({ shiftRef: BSI_REF, date: "2026-09-17", slot: "Morning" }), Date.parse("2026-09-17T09:00:00Z") / 1000);
  assert.equal(
    expirationFor({ shiftRef: BSI_REF, date: "2026-09-17", slot: "Midday", startTime: "13:30" }),
    Date.parse("2026-09-17T13:30:00Z") / 1000,
  );
});
