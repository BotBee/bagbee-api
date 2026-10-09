// ---------------------------------------------------------------------------
// /send-activation-request — the e-mail that asks an airline handler to activate
// inactive bag tags. It goes to a real handler, so it must come from a BagBee
// address, and Resend will only sign for a domain it has verified.
// ---------------------------------------------------------------------------
//
// Found 2026-09-27: the default sender had been Resend's onboarding@resend.dev
// test address since 2026-05-08, which Resend lets mail the account owner only,
// so every request to an airline address was refused with 403 and the driver saw
// "Sending mistókst". These tests pin the repair: the sender is the company
// mailbox, a sender Resend refuses is retried once from the subdomain Resend has
// verified, replies go to the real mailbox either way, and any other refusal is
// reported as-is rather than retried. A working BagBee sender is also a working
// relay, so the recipient must be one of the handlers and a tag number must look
// like one; and every attempt is bounded in time and idempotent, so a retap after
// an ambiguous failure cannot mail the handler twice.

import test from "node:test";
import assert from "node:assert/strict";
import { bootIndex, airtable, APP_TOKEN } from "./_indexHarness.js";

// index.js reads these at import, before the harness boots it.
process.env.RESEND_API_KEY = "harness-resend-key";
process.env.ACTIVATION_SEND_TIMEOUT_MS = "80";
for (const name of ["ACTIVATION_FROM", "ACTIVATION_FALLBACK_FROM", "ACTIVATION_REPLY_TO", "ACTIVATION_CC", "ACTIVATION_TO", "ACTIVATION_RECIPIENTS"]) {
  delete process.env[name];
}

const boot = await bootIndex();
test.after(() => boot.close());

const PRIMARY = "BagBee <bagbee@bagbee.is>";
const FALLBACK = "BagBee <bagbee@updates.bagbee.is>";
const AIRPORT_ASSOCIATES = "pax@airportassociates.com";
const ICELANDAIR = "paxservicemanagerskef@icelandair.is";

function post(body) {
  return boot.request("/send-activation-request", {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-token": APP_TOKEN },
    body: JSON.stringify(body),
  });
}

function resendCalls() {
  return airtable.calls
    .filter((c) => c.url.startsWith("https://api.resend.com/emails"))
    .map((c) => ({ headers: c.options.headers, message: JSON.parse(c.options.body) }));
}

/// Stands in for Resend: `decide(message)` returns the {status, body} for one send.
function resendAnswers(decide) {
  airtable.reset();
  airtable.reply = (url, options) => {
    if (!url.startsWith("https://api.resend.com/emails")) return { status: 200, body: JSON.stringify({ records: [] }) };
    return decide(JSON.parse(options.body));
  };
}

const ok = (id) => ({ status: 200, body: JSON.stringify({ id }) });

const domainNotVerified = {
  status: 403,
  body: JSON.stringify({
    statusCode: 403,
    name: "validation_error",
    message: "The bagbee.is domain is not verified. Please, add and verify your domain on https://resend.com/domains",
  }),
};

test("sender is the company mailbox; a Resend refusal of it is retried once from the verified subdomain", async () => {
  resendAnswers((m) => (m.from === PRIMARY ? domainNotVerified : ok("re_fallback")));

  const res = await post({ tagNumbers: ["0108005884", "0523914486"], to: ICELANDAIR });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, count: 2, id: "re_fallback", from: FALLBACK });

  const sends = resendCalls();
  assert.equal(sends.length, 2, "exactly one retry");
  assert.equal(sends[0].message.from, PRIMARY);
  assert.equal(sends[1].message.from, FALLBACK);
  assert.notEqual(sends[0].headers["Idempotency-Key"], sends[1].headers["Idempotency-Key"],
    "a different sender is a different payload, so it must not reuse the key");
  for (const { headers, message } of sends) {
    assert.equal(headers.Authorization, "Bearer harness-resend-key");
    assert.match(headers["Idempotency-Key"], /^activation-[0-9a-f]{64}$/);
    assert.deepEqual(message.to, [ICELANDAIR], "the handler the phone chose");
    assert.deepEqual(message.cc, ["bagbee@bagbee.is"], "ops copy");
    assert.equal(message.reply_to, "bagbee@bagbee.is", "a handler's reply lands in the real mailbox");
    assert.equal(message.subject, "Inactive bag tags — please activate (2)");
    // No Tag numbers row for either (the stub has none), so each is listed with
    // "—" for passenger, flight and date (test/activationDetailsRoutes.test.js
    // covers the details themselves).
    assert.match(message.text, /• 0108005884 — — — — — —\n• 0523914486 — — — — — —/);
    assert.match(message.html, /<code>0108005884<\/code>/);
  }
});

test("once bagbee.is is verified the first attempt succeeds and nothing is retried", async () => {
  resendAnswers(() => ok("re_primary"));

  const res = await post({ tagNumbers: ["0108000001"], to: AIRPORT_ASSOCIATES });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, count: 1, id: "re_primary", from: PRIMARY });
  assert.equal(resendCalls().length, 1);
});

test("Resend's own test sender is treated as a refused sender too", async () => {
  // What Resend answers when `from` is onboarding@resend.dev and `to` is not the account owner.
  resendAnswers((m) => (m.from === PRIMARY
    ? { status: 403, body: JSON.stringify({ statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address (bagbee@bagbee.is). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain." }) }
    : ok("re_ok")));

  const res = await post({ tagNumbers: ["0108000002"], to: AIRPORT_ASSOCIATES });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).from, FALLBACK);
});

test("a retap with the same tags inside the window carries the same idempotency key", async () => {
  resendAnswers(() => ok("re_same"));
  await post({ tagNumbers: ["0108000010", "0108000011"], to: AIRPORT_ASSOCIATES });
  await post({ tagNumbers: ["0108000011", "0108000010"], to: AIRPORT_ASSOCIATES });
  const [first, second] = resendCalls();
  assert.equal(first.headers["Idempotency-Key"], second.headers["Idempotency-Key"], "order of tags does not matter");

  await post({ tagNumbers: ["0108000010", "0108000011"], to: ICELANDAIR });
  assert.notEqual(resendCalls()[2].headers["Idempotency-Key"], first.headers["Idempotency-Key"], "another handler is another mail");
});

test("a refusal that is not about the sender is reported once, with Resend's detail, and not retried", async () => {
  resendAnswers(() => ({
    status: 422,
    body: JSON.stringify({ statusCode: 422, name: "validation_error", message: "Missing `subject` field." }),
  }));

  const res = await post({ tagNumbers: ["0108000003"], to: AIRPORT_ASSOCIATES });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, "Failed to send email");
  assert.match(body.detail.message, /Missing `subject`/, "the phone can show why");
  assert.equal(resendCalls().length, 1, "no second sender for a problem the sender did not cause");
});

test("a non-JSON answer from Resend still surfaces as a readable detail", async () => {
  resendAnswers(() => ({ status: 502, body: "<html>Bad gateway</html>" }));

  const res = await post({ tagNumbers: ["0108000004"], to: AIRPORT_ASSOCIATES });
  assert.equal(res.status, 500);
  assert.match((await res.json()).detail.message, /Bad gateway/);
});

test("a Resend call that never answers is cut off, reported as a timeout, and NOT retried from another sender", async () => {
  resendAnswers(() => new Promise(() => {}));

  const started = Date.now();
  const res = await post({ tagNumbers: ["0108000005"], to: AIRPORT_ASSOCIATES });
  assert.ok(Date.now() - started < 2_000, "answers well inside the phone's 30 s");
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.detail.message, /did not answer within/);
  assert.equal(resendCalls().length, 1, "a send that may have been accepted is never repeated blind");
});

test("without `to`, the request goes to Airport Associates", async () => {
  resendAnswers(() => ok("re_default"));

  const res = await post({ tagNumbers: ["0523000001"] });
  assert.equal(res.status, 200);
  assert.deepEqual(resendCalls()[0].message.to, [AIRPORT_ASSOCIATES]);
});

test("the recipient must be one of the airline handlers (or our own mailbox for a test send)", async () => {
  resendAnswers(() => { throw new Error("must not be called"); });

  for (const to of ["victim@some-airline.example", "bagbee@bagbee.is.evil.example", "pax@airportassociates.com.example"]) {
    const res = await post({ tagNumbers: ["0108000006"], to });
    assert.equal(res.status, 400, to);
    assert.match((await res.json()).error, /not one of the airline handlers/);
  }
  assert.equal(resendCalls().length, 0);

  resendAnswers(() => ok("re_self"));
  const self = await post({ tagNumbers: ["0108000006"], to: "bagbee@bagbee.is" });
  assert.equal(self.status, 200, "a test send to ourselves is allowed");
  const spelled = await post({ tagNumbers: ["0108000006"], to: " PAX@AirportAssociates.com " });
  assert.equal(spelled.status, 200, "case and stray whitespace do not matter");
  assert.deepEqual(resendCalls()[1].message.to, ["PAX@AirportAssociates.com"], "sent as typed, once trimmed");
});

test("tag numbers are letters, digits and dashes only — no HTML, objects or novels", async () => {
  resendAnswers(() => { throw new Error("must not be called"); });

  const bad = [
    ['<a href="https://evil.example/login">sign in</a>'],
    [{ x: 1 }],
    [12345],
    ["0108000007", ""],
    ["x".repeat(33)],
    Array.from({ length: 201 }, (_, i) => String(1000000000 + i)),
  ];
  for (const tagNumbers of bad) {
    const res = await post({ tagNumbers, to: AIRPORT_ASSOCIATES });
    assert.equal(res.status, 400, JSON.stringify(tagNumbers).slice(0, 60));
  }
  assert.equal(resendCalls().length, 0);

  resendAnswers(() => ok("re_dash"));
  const res = await post({ tagNumbers: ["0108000008", "AB-12"], to: AIRPORT_ASSOCIATES });
  assert.equal(res.status, 200, "dashes and letters are real tag shapes");
});

test("an empty tag list is refused before any mail is attempted", async () => {
  resendAnswers(() => { throw new Error("must not be called"); });
  const res = await post({ tagNumbers: [] });
  assert.equal(res.status, 400);
  assert.equal(resendCalls().length, 0);
});
