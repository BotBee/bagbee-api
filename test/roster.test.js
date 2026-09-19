// §5.3 — the Starfsmenn lookups. Not named in the §10.1 table (B3's auth tests
// use a roster fake), but the login path depends on this module getting the
// Active check and the "exactly one match" rule right, so it is covered here.

import test from "node:test";
import assert from "node:assert/strict";

import { STAFF, TABLES } from "../src/airtable/fields.js";
import { createRoster, normalizeStaffRecord } from "../src/staff/roster.js";

const silent = { error: () => {}, warn: () => {}, info: () => {} };

function staffRecord({ id, name, first = "", email = "", personal = "", teams = ["Drivers"], status = "Active" }) {
  return {
    id,
    fields: {
      [STAFF.name]: name,
      [STAFF.first]: first,
      [STAFF.email]: email,
      [STAFF.personalEmail]: personal,
      [STAFF.team]: teams,
      [STAFF.status]: status,
    },
  };
}

function fakeAirtable(records) {
  const calls = [];
  return {
    calls,
    async listAll(table, opts = {}) {
      calls.push({ table, ...opts });
      return { records: typeof records === "function" ? records(opts) : records, pages: 1 };
    },
    async getByIds(table, ids, fields) {
      calls.push({ table, ids, fields });
      const all = typeof records === "function" ? records({}) : records;
      return all.filter((r) => ids.includes(r.id));
    },
  };
}

test("normalizeStaffRecord trims the name and derives the role from Team", () => {
  const s = normalizeStaffRecord(
    staffRecord({ id: "recRunar000000001", name: "  Rúnar Ólafsson ", first: "Rúnar", email: "RUNA@Example.is", teams: ["Office", "Drivers"] })
  );
  assert.equal(s.name, "Rúnar Ólafsson");
  assert.equal(s.displayName, "Rúnar");
  assert.equal(s.email, "runa@example.is");
  assert.equal(s.role, "owner");
  assert.equal(s.active, true);

  const driver = normalizeStaffRecord(staffRecord({ id: "recMatas000000001", name: "Matas", teams: ["Drivers"] }));
  assert.equal(driver.role, "staff");
  assert.equal(driver.displayName, "Matas", "a blank First falls back to the trimmed Name");
});

test("findActiveStaffByEmail asks Airtable for Active rows on either address", async () => {
  const airtable = fakeAirtable([staffRecord({ id: "recRunar000000001", name: "Rúnar", email: "runa@example.is" })]);
  const roster = createRoster({ airtable, logger: silent });

  const found = await roster.findActiveStaffByEmail(" Runa@Example.IS ");
  assert.equal(found.airtableId, "recRunar000000001");

  const call = airtable.calls[0];
  assert.equal(call.table, TABLES.staff);
  assert.equal(call.interactive, true, "the login path must not wait out a 429");
  assert.ok(call.filterByFormula.includes(`{${STAFF.status}}='Active'`));
  assert.ok(call.filterByFormula.includes("'runa@example.is'"), "the address is lower-cased before the lookup");
  assert.ok(call.filterByFormula.includes(`{${STAFF.personalEmail}}`));
});

test("an ambiguous or missing match answers the same as an unknown address", async () => {
  const two = [
    staffRecord({ id: "recDupe0000000001", name: "A", email: "shared@example.is" }),
    staffRecord({ id: "recDupe0000000002", name: "B", email: "shared@example.is" }),
  ];
  const warned = [];
  const roster = createRoster({ airtable: fakeAirtable(two), logger: { ...silent, warn: (...a) => warned.push(a) } });

  assert.equal(await roster.findActiveStaffByEmail("shared@example.is"), null);
  assert.equal(warned[0][0], "[roster] ambiguous email match");
  assert.ok(!JSON.stringify(warned).includes("@"), "the log line carries a count, not an address");

  const empty = createRoster({ airtable: fakeAirtable([]), logger: silent });
  assert.equal(await empty.findActiveStaffByEmail("nobody@example.is"), null);
  assert.equal(await empty.findActiveStaffByEmail(""), null);
});

test("getRoster caches for 10 minutes and getRosterEntry reads from it", async () => {
  const airtable = fakeAirtable([
    staffRecord({ id: "recRunar000000001", name: "Rúnar", teams: ["Office"] }),
    staffRecord({ id: "recMatas000000001", name: "Matas", status: "Inactive" }),
  ]);
  let clock = 1_000;
  const roster = createRoster({ airtable, now: () => clock, logger: silent });

  const first = await roster.getRoster();
  assert.equal(first.byId.size, 2);
  await roster.getRoster();
  assert.equal(airtable.calls.length, 1, "the second call is served from cache");

  clock += 11 * 60 * 1000;
  await roster.getRoster();
  assert.equal(airtable.calls.length, 2, "past the TTL it refreshes");

  const { entry } = await roster.getRosterEntry("recMatas000000001");
  assert.equal(entry.active, false, "the Active re-check must see the current status");
  assert.equal((await roster.getRosterEntry("recNobody00000001")).entry, null);
});

test("getStaffById refuses anything that is not a record id", async () => {
  const airtable = fakeAirtable([staffRecord({ id: "recRunar000000001", name: "Rúnar" })]);
  const roster = createRoster({ airtable, logger: silent });

  assert.equal((await roster.getStaffById("recRunar000000001")).name, "Rúnar");
  assert.equal(await roster.getStaffById("not-an-id"), null);
  assert.equal(await roster.getStaffById(null), null);
  assert.equal(airtable.calls.length, 1, "a malformed id never reaches Airtable");
});
