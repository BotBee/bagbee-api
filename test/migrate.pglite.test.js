// Spec §10.1 test/migrate.pglite.test.js — 001 applies on an empty DB, a second
// run is a no-op, and current_shift_confirmations returns the latest row.
// PGlite only: this Mac has no Postgres server (§10.2).

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createDb, initPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const STAFF_REC = "rec0123456789ABCD";              // rec + 14 chars, as the CHECK demands
const SHIFT_REF = `vakt_${STAFF_REC}`;

async function freshDb() {
  const config = loadConfig({ DATABASE_URL: "pglite:memory" });
  const db = createDb(config);
  await initPool(db, config);
  return db;
}

test("001 applies on an empty database and creates every slice-1 table", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());

  const applied = await migrate(db.pool, MIGRATIONS_DIR);
  assert.deepEqual(applied, ["001_vakt_init.sql"]);

  const { rows } = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  const names = rows.map((r) => r.table_name);
  for (const want of [
    "auth_throttle", "current_shift_confirmations", "devices", "job_runs", "otp_codes",
    "plan_snapshots", "push_log", "schema_migrations", "sessions", "shift_confirmations", "staff",
  ]) {
    assert.ok(names.includes(want), `missing ${want} (got ${names.join(", ")})`);
  }
});

test("sessions carries the three refresh hashes, superseded_refresh_hash included", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await migrate(db.pool, MIGRATIONS_DIR);

  const { rows } = await db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions'",
  );
  const cols = rows.map((r) => r.column_name);
  // Without superseded_refresh_hash a thief-first refresh is never detected (§4.3 (b)/(c)).
  for (const want of ["refresh_hash", "prev_refresh_hash", "superseded_refresh_hash", "revoked_reason", "expires_at"]) {
    assert.ok(cols.includes(want), `sessions.${want} missing`);
  }
});

test("a second migrate run is a no-op", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());

  assert.deepEqual(await migrate(db.pool, MIGRATIONS_DIR), ["001_vakt_init.sql"]);
  assert.deepEqual(await migrate(db.pool, MIGRATIONS_DIR), [], "second run must apply nothing");
  assert.deepEqual(await migrate(db.pool, MIGRATIONS_DIR), []);

  const { rows } = await db.query("SELECT version FROM schema_migrations");
  assert.deepEqual(rows.map((r) => r.version), ["001_vakt_init.sql"]);
});

test("current_shift_confirmations returns the latest answer per (shift_ref, staff_id)", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await migrate(db.pool, MIGRATIONS_DIR);

  const staff = await db.query(
    `INSERT INTO staff (airtable_record_id, name, login_email, airtable_status)
     VALUES ($1, $2, $3, 'Active') RETURNING id`,
    [STAFF_REC, "Prufa Prufudóttir", "prufa@example.is"],
  );
  const staffId = staff.rows[0].id;

  const insert = (answer, answeredAt) => db.query(
    `INSERT INTO shift_confirmations (shift_ref, shift_date, staff_id, answer, answered_at, source, client_event_id)
     VALUES ($1, '2026-09-17', $2, $3, $4, 'app', gen_random_uuid())`,
    [SHIFT_REF, staffId, answer, answeredAt],
  );
  await insert("no", "2026-09-16T19:00:00Z");
  await insert("yes", "2026-09-16T20:30:00Z");

  const { rows } = await db.query(
    "SELECT answer, answered_at FROM current_shift_confirmations WHERE shift_ref = $1",
    [SHIFT_REF],
  );
  assert.equal(rows.length, 1, "one current answer per person per shift");
  assert.equal(rows[0].answer, "yes");
});

test("the schema refuses malformed refs and answers", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await migrate(db.pool, MIGRATIONS_DIR);

  await assert.rejects(
    () => db.query(
      `INSERT INTO staff (airtable_record_id, name, login_email, airtable_status)
       VALUES ('notarecordid', 'X', 'x@example.is', 'Active')`,
    ),
    /airtable_record_id/,
  );

  const staff = await db.query(
    `INSERT INTO staff (airtable_record_id, name, login_email, airtable_status)
     VALUES ($1, 'X', 'x@example.is', 'Active') RETURNING id`,
    [STAFF_REC],
  );
  await assert.rejects(
    () => db.query(
      `INSERT INTO shift_confirmations (shift_ref, shift_date, staff_id, answer, answered_at, source, client_event_id)
       VALUES ('vakt_nope', '2026-09-17', $1, 'yes', now(), 'app', gen_random_uuid())`,
      [staff.rows[0].id],
    ),
    /shift_confirmations/,
  );
  await assert.rejects(
    () => db.query(
      `INSERT INTO shift_confirmations (shift_ref, shift_date, staff_id, answer, answered_at, source, client_event_id)
       VALUES ($1, '2026-09-17', $2, 'maybe', now(), 'app', gen_random_uuid())`,
      [SHIFT_REF, staff.rows[0].id],
    ),
    /shift_confirmations/,
  );
});

test("only one live OTP code per email is possible", async (t) => {
  const db = await freshDb();
  t.after(() => db.end());
  await migrate(db.pool, MIGRATIONS_DIR);

  const staff = await db.query(
    `INSERT INTO staff (airtable_record_id, name, login_email, airtable_status)
     VALUES ($1, 'X', 'x@example.is', 'Active') RETURNING id`,
    [STAFF_REC],
  );
  const staffId = staff.rows[0].id;
  const add = () => db.query(
    `INSERT INTO otp_codes (staff_id, email, code_hash, expires_at)
     VALUES ($1, 'x@example.is', 'h', now() + interval '10 minutes')`,
    [staffId],
  );
  await add();
  await assert.rejects(add, /otp_codes_one_live_per_email/);

  // Superseding the first one frees the slot, which is what request-code does.
  await db.query("UPDATE otp_codes SET invalidated_at = now(), invalidated_reason = 'superseded' WHERE email = 'x@example.is'");
  await add();
});

test("pglite is refused in production", async () => {
  const config = loadConfig({ DATABASE_URL: "pglite:memory", NODE_ENV: "production" });
  const db = createDb(config);
  await assert.rejects(() => initPool(db, config), /pglite/);
});
