// Spec §10.1 test/confirm.pglite.test.js — POST /v2/me/shifts/:ref/confirm and the
// "Kemst ekki" office mail (§4.5, §4.8).
//
// The iOS side is an outbox: the same tap arrives again after a flaky network,
// from the lock screen and from the app. Everything below is about that — one row
// per tap, one mail per real change of mind, and an answer that is never lost over
// a wrong clock on somebody's phone.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";

import { loadConfig } from "../src/config.js";
import { createDb, initPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createV2Router } from "../src/routes/v2.js";
import { createThrottle } from "../src/auth/throttle.js";
import { createShiftsService } from "../src/staff/shifts.js";
import { createShiftDetail } from "../src/staff/shiftDetail.js";
import { declineSubject, isNotifiableTransition, renderDeclineText } from "../src/mail/declineMail.js";
import { clampAnsweredAt } from "../src/routes/meShifts.js";
import { ORDER, SHIFT, COUNTER, TABLES } from "../src/airtable/fields.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const LONG = "x".repeat(32);
const QUIET = { log() {}, error() {}, warn() {}, info() {} };

const TODAY = "2026-09-11";
const NOW_MS = Date.parse(`${TODAY}T09:00:00Z`);
const TOMORROW = "2026-09-12";
const IN_THREE = "2026-09-14";
const IN_TEN = "2026-09-21";
const THREE_AGO = "2026-09-08";

const RUNAR = "recRunar000000001";
const MATAS = "recMatas000000001";

const TOMORROW_SHIFT = "recShiftTomorrow1";
const SOON_SHIFT = "recShiftInThree01";
const FAR_SHIFT = "recShiftInTen0001";
const PAST_SHIFT = "recShiftThreeAgo1";
const NOT_MINE = "recShiftNotMine01";
const COUNTER_ROW = "recCounter0000001";
const GHOST_REF = "vakt_recGhost000000001";

const shiftRecords = [
  { id: TOMORROW_SHIFT, fields: { [SHIFT.date]: TOMORROW, [SHIFT.shift]: "Morning", [SHIFT.driver]: [RUNAR, MATAS] } },
  { id: SOON_SHIFT, fields: { [SHIFT.date]: IN_THREE, [SHIFT.shift]: "Evening", [SHIFT.driver]: [RUNAR] } },
  { id: FAR_SHIFT, fields: { [SHIFT.date]: IN_TEN, [SHIFT.shift]: "Morning", [SHIFT.driver]: [RUNAR] } },
  { id: PAST_SHIFT, fields: { [SHIFT.date]: THREE_AGO, [SHIFT.shift]: "Morning", [SHIFT.driver]: [RUNAR] } },
  { id: NOT_MINE, fields: { [SHIFT.date]: TOMORROW, [SHIFT.shift]: "Evening", [SHIFT.driver]: [MATAS] } },
];

const counterRecords = [
  { id: COUNTER_ROW, fields: { [COUNTER.date]: TOMORROW, [COUNTER.slot]: "Midday", [COUNTER.staff]: [RUNAR], [COUNTER.status]: "Scheduled" } },
];

const orderRecords = [
  {
    id: "recOrd00000000001",
    fields: {
      [ORDER.orderNumber]: "aaaa1", [ORDER.pickupDate]: TOMORROW, [ORDER.shiftFormula]: "Morning",
      [ORDER.paid]: true, [ORDER.totalBags]: 2, [ORDER.timeWindow]: "04:00 - 05:00",
    },
  },
];

function fakeAirtable() {
  return {
    async listAll(table) {
      if (table === TABLES.shifts) return { records: shiftRecords, pages: 1 };
      if (table === TABLES.counter) return { records: counterRecords, pages: 1 };
      if (table === TABLES.orders) return { records: orderRecords, pages: 1 };
      return { records: [], pages: 1 };
    },
    async getByIds() {
      return [];
    },
  };
}

const fakeRoster = {
  async getRoster() {
    return { byId: new Map([[RUNAR, { airtableId: RUNAR, displayName: "Rúnar" }], [MATAS, { airtableId: MATAS, displayName: "Matas" }]]), stale: false };
  },
};

// --- harness --------------------------------------------------------------

async function serve({ envOver = {}, mailFails = false } = {}) {
  const config = loadConfig({
    DATABASE_URL: "pglite:memory",
    STAFF_JWT_SECRET: LONG,
    OTP_HMAC_SECRET: LONG,
    RESEND_OTP_API_KEY: "re_test_key",
    DECLINE_NOTIFY_EMAILS: "office@example.is, valgeir@example.is",
    ...envOver,
  });
  const db = createDb(config);
  await initPool(db, config);
  await migrate(db.pool, MIGRATIONS_DIR);
  db.ready = true;

  const people = {};
  for (const [key, airtableId, name] of [["runar", RUNAR, "Rúnar Árnason"], ["matas", MATAS, "Matas"]]) {
    const { rows: [staff] } = await db.query(
      `INSERT INTO staff (airtable_record_id, name, login_email, airtable_status)
       VALUES ($1, $2, $3, 'Active') RETURNING id`,
      [airtableId, name, `${key}@example.is`],
    );
    const { rows: [device] } = await db.query(
      "INSERT INTO devices (installation_id, staff_id) VALUES ($1, $2) RETURNING id",
      [crypto.randomUUID(), staff.id],
    );
    const { rows: [session] } = await db.query(
      `INSERT INTO sessions (staff_id, device_id, refresh_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '180 days') RETURNING id`,
      [staff.id, device.id, crypto.randomBytes(16).toString("hex")],
    );
    people[key] = { staffId: staff.id, deviceId: device.id, sessionId: session.id, airtableId };
  }

  let caller = people.runar;
  const mails = [];
  const now = () => NOW_MS;
  const clock = () => new Date(NOW_MS);
  const airtable = fakeAirtable();
  const shifts = createShiftsService({ airtable, config, now, logger: QUIET });
  const detail = createShiftDetail({ airtable, shifts, roster: fakeRoster, config, now, logger: QUIET });

  const app = express();
  app.use("/v2", express.json({ limit: "32kb" }));
  app.use("/v2", createV2Router({
    db,
    config,
    apns: () => ({ status: "missing", client: null }),
    hit: createThrottle(db, clock),
    clock,
    shifts,
    detail,
    identity: {
      loadStaffRow: async (id) => (await db.query("SELECT id, name FROM staff WHERE id = $1", [id])).rows[0] || null,
    },
    mailer: {
      async send(msg) {
        if (mailFails) throw Object.assign(new Error("resend 500"), { code: "mail_failed" });
        mails.push(msg);
        return { providerId: "test" };
      },
    },
    requireStaff: (req, res, next) => {
      req.staff = {
        id: caller.staffId, sessionId: caller.sessionId, deviceId: caller.deviceId,
        airtableId: caller.airtableId, teams: ["Drivers"], role: "staff",
      };
      next();
    },
  }));

  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const { port } = server.address();

  const confirm = async (ref, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/v2/me/shifts/${ref}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json() };
  };

  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  };

  return {
    db, confirm, get, mails, people,
    as: (who) => { caller = people[who]; },
    rows: async () => (await db.query("SELECT * FROM shift_confirmations ORDER BY id")).rows,
    close: async () => { await new Promise((r) => server.close(r)); await db.end(); },
  };
}

const answerFor = (over = {}) => ({
  answer: "yes",
  clientEventId: crypto.randomUUID(),
  answeredAt: `${TODAY}T08:59:30Z`,
  source: "app",
  planVersion: 3,
  ...over,
});

const REF = `vakt_${TOMORROW_SHIFT}`;

// --- the happy path -------------------------------------------------------

test("a yes is stored and echoed back in the documented shape", async (t) => {
  const h = await serve();
  t.after(h.close);

  const body = answerFor({ source: "push_action" });
  const res = await h.confirm(REF, body);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    confirmation: { answer: "yes", answeredAt: `${TODAY}T08:59:30Z`, planVersion: 3, source: "push_action" },
    officeNotified: false,                           // nobody was coming and then stopped
    duplicate: false,
  });

  const rows = await h.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shift_ref, REF);
  assert.equal(rows[0].shift_date.toISOString().slice(0, 10), TOMORROW);
  assert.equal(rows[0].staff_id, h.people.runar.staffId);
  assert.equal(rows[0].device_id, h.people.runar.deviceId, "the answering device is recorded");
  assert.equal(rows[0].session_id, h.people.runar.sessionId);
  assert.equal(rows[0].client_event_id, body.clientEventId);
  assert.equal(rows[0].received_at.toISOString().slice(0, 19), `${TODAY}T09:00:00`);
  assert.equal(h.mails.length, 0);
});

test("the answer comes back on the shift the next time the app asks", async (t) => {
  const h = await serve();
  t.after(h.close);

  await h.confirm(REF, answerFor({ answer: "no", source: "push_action", planVersion: 2 }));

  const { status, body } = await h.get("/v2/me/shifts");
  assert.equal(status, 200);
  const shift = body.shifts.find((s) => s.ref === REF);
  assert.deepEqual(shift.confirmation, {
    answer: "no",
    answeredAt: `${TODAY}T08:59:30Z`,
    planVersion: 2,
    source: "push_action",
  });
});

test("a counter shift is confirmable too", async (t) => {
  const h = await serve();
  t.after(h.close);

  const res = await h.confirm(`bsi_${COUNTER_ROW}`, answerFor());
  assert.equal(res.status, 200);
  assert.equal(res.body.confirmation.answer, "yes");
  assert.equal((await h.rows())[0].shift_ref, `bsi_${COUNTER_ROW}`);
});

// --- idempotency ----------------------------------------------------------

test("a replay of the same clientEventId returns the stored row and sends nothing", async (t) => {
  const h = await serve();
  t.after(h.close);

  const body = answerFor({ answer: "no" });
  const first = await h.confirm(REF, body);
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.officeNotified, true);
  assert.equal(h.mails.length, 1);

  // The outbox retries with the same id, and the second time it flips the answer
  // in the body too — the STORED row is what comes back, not the new payload.
  const replay = await h.confirm(REF, { ...body, answer: "yes", answeredAt: `${TODAY}T08:59:59Z` });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.officeNotified, false);
  assert.deepEqual(replay.body.confirmation, first.body.confirmation);

  assert.equal((await h.rows()).length, 1, "one tap, one row");
  assert.equal(h.mails.length, 1, "a replay never mails the office twice");
});

test("a clientEventId that belongs to another shift is a bad request, not someone else's row", async (t) => {
  const h = await serve();
  t.after(h.close);

  const body = answerFor();
  await h.confirm(REF, body);

  const reused = await h.confirm(`vakt_${SOON_SHIFT}`, { ...body, answer: "no" });
  assert.equal(reused.status, 400);
  assert.deepEqual(reused.body, { error: "invalid_request" });
  assert.equal((await h.rows()).length, 1);
  assert.equal(h.mails.length, 0);
});

test("two people answering the same shift keep separate answers", async (t) => {
  const h = await serve();
  t.after(h.close);

  await h.confirm(REF, answerFor({ answer: "yes" }));
  h.as("matas");
  await h.confirm(REF, answerFor({ answer: "no" }));

  const rows = await h.rows();
  assert.equal(rows.length, 2);
  const { rows: current } = await h.db.query(
    "SELECT staff_id, answer FROM current_shift_confirmations WHERE shift_ref = $1 ORDER BY answer",
    [REF],
  );
  assert.equal(current.length, 2);
  assert.equal(h.mails.length, 1, "only Matas's no reached the office");
});

// --- the office mail ------------------------------------------------------

test("the office hears about a no, a change of mind, and nothing else", async (t) => {
  const h = await serve();
  t.after(h.close);

  /// The times climb, because `current_shift_confirmations` picks the answer with
  /// the latest answered_at — the last thing the person actually tapped, not the
  /// last row that happened to reach us.
  // yes → nothing
  await h.confirm(REF, answerFor({ answer: "yes", answeredAt: `${TODAY}T08:30:00Z` }));
  assert.equal(h.mails.length, 0);

  // yes → no: "Kemst ekki"
  const declined = await h.confirm(REF, answerFor({ answer: "no", source: "push_action", answeredAt: `${TODAY}T08:40:00Z` }));
  assert.equal(declined.body.officeNotified, true);
  assert.equal(h.mails.length, 1);
  assert.deepEqual(h.mails[0].to, ["office@example.is", "valgeir@example.is"]);
  assert.equal(h.mails[0].subject, "Kemst ekki: Rúnar Árnason — Morgunvakt lau. 12. sep");
  assert.match(h.mails[0].text, /^Rúnar Árnason\nMorgunvakt lau\. 12\. sep\nSvar: Kemst ekki\nSvarað kl\. 08:40 úr tilkynningu\n\n— BagBee Vakt$/);
  assert.equal(h.mails[0].html, undefined, "no HTML, no links, no customer data");

  // no → no again: already known, no second mail
  const again = await h.confirm(REF, answerFor({ answer: "no", answeredAt: `${TODAY}T08:45:00Z` }));
  assert.equal(again.body.officeNotified, false);
  assert.equal(h.mails.length, 1);

  // no → yes: "Mætir samt"
  const back = await h.confirm(REF, answerFor({ answer: "yes", answeredAt: `${TODAY}T08:50:00Z` }));
  assert.equal(back.body.officeNotified, true);
  assert.equal(h.mails.length, 2);
  assert.equal(h.mails[1].subject, "Mætir samt: Rúnar Árnason — Morgunvakt lau. 12. sep");
  assert.match(h.mails[1].text, /Svar: Já, ég mæti\nSvarað kl\. 08:50 í appinu/);

  // yes → yes: nothing again
  await h.confirm(REF, answerFor({ answer: "yes", answeredAt: `${TODAY}T08:55:00Z` }));
  assert.equal(h.mails.length, 2);
});

test("with DECLINE_NOTIFY_EMAILS unset the answer is still stored, just not mailed", async (t) => {
  const h = await serve({ envOver: { DECLINE_NOTIFY_EMAILS: "" } });
  t.after(h.close);

  const res = await h.confirm(REF, answerFor({ answer: "no" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.officeNotified, false);
  assert.equal(h.mails.length, 0);
  assert.equal((await h.rows())[0].answer, "no");
});

test("a mail failure never loses the answer", async (t) => {
  const h = await serve({ mailFails: true });
  t.after(h.close);

  const res = await h.confirm(REF, answerFor({ answer: "no" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.officeNotified, false, "the office was not told, and the app is told so");
  assert.equal((await h.rows())[0].answer, "no");
});

test("the mail texts are pure functions of the answer", () => {
  assert.equal(
    declineSubject({ answer: "no", name: "Matas", label: "BSÍ · Miðdagur", date: "2026-09-17" }),
    "Kemst ekki: Matas — BSÍ · Miðdagur fim. 17. sep",
  );
  assert.equal(
    declineSubject({ answer: "yes", name: "Matas", label: "Kvöldvakt", date: "2026-02-12" }),
    "Mætir samt: Matas — Kvöldvakt fim. 12. feb",
  );
  assert.match(
    renderDeclineText({ answer: "no", name: "Matas", label: "Kvöldvakt", date: "2026-09-17", answeredAt: new Date("2026-09-16T17:16:40Z"), source: "push_action" }),
    /Svarað kl\. 17:16 úr tilkynningu/,
  );

  assert.equal(isNotifiableTransition(null, "no"), true);
  assert.equal(isNotifiableTransition("yes", "no"), true);
  assert.equal(isNotifiableTransition("no", "no"), false);
  assert.equal(isNotifiableTransition("no", "yes"), true);
  assert.equal(isNotifiableTransition(null, "yes"), false);
  assert.equal(isNotifiableTransition("yes", "yes"), false);
});

// --- answeredAt clamping --------------------------------------------------

test("answeredAt is clamped to received_at when it cannot be believed", async (t) => {
  const h = await serve();
  t.after(h.close);

  const received = `${TODAY}T09:00:00Z`;
  for (const [label, answeredAt] of [
    ["missing", undefined],
    ["in the future", `${TODAY}T09:00:01Z`],
    ["older than 7 days", "2026-09-03T09:00:00Z"],
    ["not a date", "einhvern tímann"],
    ["not a string", 1757581200],
  ]) {
    const res = await h.confirm(REF, answerFor({ answeredAt, clientEventId: crypto.randomUUID() }));
    assert.equal(res.status, 200, label);
    assert.equal(res.body.confirmation.answeredAt, received, `expected ${label} to fall back to received_at`);
  }

  // Exactly on the edge of the window, and a normal tap a moment ago, are kept.
  const edge = await h.confirm(REF, answerFor({ answeredAt: "2026-09-04T09:00:01Z" }));
  assert.equal(edge.body.confirmation.answeredAt, "2026-09-04T09:00:01Z");

  assert.equal(clampAnsweredAt("2026-09-11T08:00:00Z", new Date(NOW_MS)).toISOString(), "2026-09-11T08:00:00.000Z");
  assert.equal(clampAnsweredAt(undefined, new Date(NOW_MS)).getTime(), NOW_MS);
});

// --- authorization and the date window ------------------------------------

test("another person's shift and an unknown ref are the same 404", async (t) => {
  const h = await serve();
  t.after(h.close);

  for (const ref of [`vakt_${NOT_MINE}`, GHOST_REF, "bsi_recCounter0000009"]) {
    const res = await h.confirm(ref, answerFor());
    assert.equal(res.status, 404, `expected 404 for ${ref}`);
    assert.deepEqual(res.body, { error: "not_found" });
  }
  assert.equal((await h.rows()).length, 0, "a refused confirm writes nothing");

  h.as("matas");
  const mine = await h.confirm(`vakt_${NOT_MINE}`, answerFor());
  assert.equal(mine.status, 200, "the person who IS on it can answer");
});

test("a shift in the past or more than a week out cannot be confirmed", async (t) => {
  const h = await serve();
  t.after(h.close);

  for (const ref of [`vakt_${PAST_SHIFT}`, `vakt_${FAR_SHIFT}`]) {
    const res = await h.confirm(ref, answerFor());
    assert.equal(res.status, 409, `expected 409 for ${ref}`);
    assert.deepEqual(res.body, { error: "shift_not_confirmable" });
  }
  assert.equal((await h.rows()).length, 0);

  // today+3 is inside the window.
  assert.equal((await h.confirm(`vakt_${SOON_SHIFT}`, answerFor())).status, 200);
});

// --- request validation ---------------------------------------------------

test("a malformed body is refused before anything is written", async (t) => {
  const h = await serve();
  t.after(h.close);

  const bad = [
    {},
    answerFor({ answer: undefined }),
    answerFor({ answer: "maybe" }),
    answerFor({ answer: "YES" }),
    answerFor({ clientEventId: undefined }),
    answerFor({ clientEventId: "not-a-uuid" }),
    answerFor({ source: "sms" }),
    answerFor({ planVersion: "3" }),
    answerFor({ planVersion: 3.5 }),
  ];
  for (const body of bad) {
    const res = await h.confirm(REF, body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.deepEqual(res.body, { error: "invalid_request" });
  }
  assert.equal((await h.rows()).length, 0);

  // A malformed ref is a bad request for the same reason: it is not a shift id.
  const badRef = await h.confirm("vakt_rec123", answerFor());
  assert.equal(badRef.status, 400);
  assert.deepEqual(badRef.body, { error: "invalid_request" });
});

test("source defaults to app and planVersion may be absent or null", async (t) => {
  const h = await serve();
  t.after(h.close);

  const res = await h.confirm(REF, { answer: "yes", clientEventId: crypto.randomUUID() });
  assert.equal(res.status, 200);
  assert.equal(res.body.confirmation.source, "app");
  assert.equal(res.body.confirmation.planVersion, null);

  const explicitNull = await h.confirm(REF, { answer: "yes", clientEventId: crypto.randomUUID(), planVersion: null });
  assert.equal(explicitNull.status, 200);
  assert.equal(explicitNull.body.confirmation.planVersion, null);
});

test("confirms have their own 120/h budget", async (t) => {
  const h = await serve();
  t.after(h.close);

  const windowStart = new Date(Math.floor(NOW_MS / 1000 / 3600) * 3600 * 1000);
  await h.db.query(
    "INSERT INTO auth_throttle (bucket, subject, window_start, hits) VALUES ('confirm_staff', $1, $2, 120)",
    [h.people.runar.staffId, windowStart],
  );

  const res = await h.confirm(REF, answerFor());
  assert.equal(res.status, 429);
  assert.equal(res.body.error, "rate_limited");
  assert.equal((await h.rows()).length, 0);
});
