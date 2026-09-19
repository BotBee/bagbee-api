// ---------------------------------------------------------------------------
// "Kemst ekki" office mail (spec §4.8)
// ---------------------------------------------------------------------------
//
// The one place slice 1 tells a human that something changed. It goes out on two
// transitions only — somebody who was coming is not coming any more, or somebody
// who said no is coming after all — because an office that gets a mail for every
// tap stops reading them.
//
// No links, no customer data: the body is a name, a shift, an answer and a time.
// It rides on the same Resend key as the login codes (RESEND_OTP_API_KEY), so a
// compromised ops key can never send from no-reply@bagbee.is.

import { fmtDateIs } from "../push/payloads.js";

/// The two button labels from §8.12, reused so the office reads exactly what the
/// driver tapped.
const ANSWER_TEXT = { yes: "Já, ég mæti", no: "Kemst ekki" };
const SOURCE_TEXT = { push_action: "úr tilkynningu", app: "í appinu" };

/// True only for the two transitions in §4.5: no email when an answer is merely
/// repeated, and none for yes → yes.
export function isNotifiableTransition(previousAnswer, answer) {
  if (answer === "no") return previousAnswer !== "no";
  if (answer === "yes") return previousAnswer === "no";
  return false;
}

export function declineSubject({ answer, name, label, date }) {
  const head = answer === "no" ? "Kemst ekki" : "Mætir samt";
  return `${head}: ${name} — ${label} ${fmtDateIs(date)}`;
}

/// answeredAt is rendered as plain UTC, which is Iceland time all year (time.js).
export function renderDeclineText({ answer, name, label, date, answeredAt, source }) {
  const d = answeredAt instanceof Date ? answeredAt : new Date(answeredAt);
  const hhmm = Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(11, 16);
  return [
    name,
    `${label} ${fmtDateIs(date)}`,
    `Svar: ${ANSWER_TEXT[answer] || answer}`,
    hhmm ? `Svarað kl. ${hhmm} ${SOURCE_TEXT[source] || SOURCE_TEXT.app}` : `Svarað ${SOURCE_TEXT[source] || SOURCE_TEXT.app}`,
    "",
    "— BagBee Vakt",
  ].join("\n");
}

export function createDeclineMailer({ config, mailer, log = console } = {}) {
  /// Returns the value for `officeNotified` in the confirm response (§4.5).
  /// It never throws: a mail failure must not lose an answer that is already
  /// committed in Postgres — the driver said they cannot come, and that is the
  /// part that matters.
  async function sendDeclineNotice({ answer, name, label, date, answeredAt, source }) {
    const to = config.declineNotifyEmails;
    // Empty DECLINE_NOTIFY_EMAILS = off, exactly like the guessing alert (§2.2).
    if (!to?.length) return false;

    const subject = declineSubject({ answer, name, label, date });
    const text = renderDeclineText({ answer, name, label, date, answeredAt, source });

    try {
      if (config.otpMailTransport === "log") {
        // Non-production only (§2.2). Counts as notified: in production this same
        // call posts to Resend, and the local smoke run should show the true path.
        log.log(`[confirm] decline mail (log transport): ${subject}`);
        return true;
      }
      await mailer.send({ to, subject, text, tag: "staff_shift_decline" });
      return true;
    } catch (err) {
      log.error?.("[confirm] decline mail failed:", err?.code || err?.message);
      return false;
    }
  }

  return { sendDeclineNotice };
}

export default createDeclineMailer;
