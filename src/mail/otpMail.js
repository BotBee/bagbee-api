// ---------------------------------------------------------------------------
// OTP email over Resend (spec §4.6)
// ---------------------------------------------------------------------------
//
// Resend over HTTPS, not SMTP: Gmail SMTP from this service failed on 465 and 587
// in May (§0.2) and Railway allows outbound SMTP only on Pro, while commit 4b866bd
// records that Resend worked from this same egress. It also keeps staff login off
// the bagbee@ Gmail app password, which grants IMAP over the whole shared mailbox
// and sat unrotated on the compromised laptop.
//
// The key is RESEND_OTP_API_KEY — dedicated, domain-restricted, and read by this
// file and declineMail.js only. RESEND_API_KEY stays with /send-activation-request,
// which accepts any `to` and injects unescaped HTML (W2).

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;
const LOGO_URL = "https://www.bagbee.is/images/bagbee-logo-green.png";

export const otpSubject = (code) => `BagBee kóði: ${code}`;

/// Adapted from the website's renderText; the first line is new copy, and the
/// "never share this" line is S14.
export const renderOtpText = (code) =>
  [
    "Innskráningarkóði fyrir BagBee Vakt:",
    "",
    `   ${code}`,
    "",
    "Gildir í 10 mínútur.",
    "Aldrei gefa neinum þennan kóða. BagBee biður aldrei um hann í síma eða tölvupósti.",
    "Ef þú baðst ekki um að skrá þig inn máttu hunsa þennan póst.",
    "",
    "— BagBee",
  ].join("\n");

/// Ported from bagbee-is-active/utils/staff/mailer.ts:41-66 with the four changes
/// in §4.6. Table-free and inline-styled, because that is what survives Mail.app,
/// Gmail and Outlook alike.
export const renderOtpHtml = (code) => `
<!doctype html>
<html><body style="font-family: Arial, Helvetica, sans-serif; color: #000929; max-width: 480px; margin: 0 auto; padding: 24px;">
  <div style="text-align: center; margin-bottom: 24px;">
    <img src="${LOGO_URL}" alt="BagBee" height="28" style="height:28px;width:auto;display:inline-block;" />
    <div style="font-size: 11px; color: #696f79; text-transform: uppercase; letter-spacing: 1px; margin-top: 6px;">BagBee Vakt</div>
  </div>
  <p style="font-size: 14px; line-height: 1.5;">Hæ,</p>
  <p style="font-size: 14px; line-height: 1.5;">
    Hér er innskráningarkóðinn þinn fyrir BagBee Vakt:
  </p>
  <div style="text-align: center; margin: 28px 0;">
    <div style="display: inline-block; font-size: 30px; font-weight: 700; letter-spacing: 8px; padding: 16px 28px; background: #f5f6fa; border: 1px solid #ecedf0; border-radius: 10px; color: #000929;">
      ${code}
    </div>
  </div>
  <p style="font-size: 13px; color: #696f79; line-height: 1.5;">
    Kóðinn gildir í 10 mínútur. Ef þú baðst ekki um að skrá þig inn máttu hunsa þennan póst.
  </p>
  <p style="font-size: 13px; color: #696f79; line-height: 1.5;">
    Aldrei gefa neinum þennan kóða. BagBee biður aldrei um hann í síma eða tölvupósti.
  </p>
  <p style="font-size: 12px; color: #a3a4a7; margin-top: 32px;">
    — BagBee
  </p>
</body></html>
`;

/// Subject for the OTP-guessing alert (§4.4, S11). The body carries the staff
/// name and a count only: never the address, never the code.
export const GUESS_ALERT_SUBJECT = "BagBee Vakt: margar rangar kóðatilraunir";

export const renderGuessAlertText = ({ name, count, windowHours = 24 }) =>
  [
    `${name || "Óþekktur starfsmaður"} — ${count} rangar kóðatilraunir á ${windowHours} klst.`,
    "",
    "Innskráningarkóðinn hefur verið gerður ógildur. Starfsmaðurinn getur beðið um nýjan kóða.",
    "",
    "— BagBee Vakt",
  ].join("\n");

export function createMailer({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
  /// One POST, one 10 s budget. Resend answers in well under a second in practice;
  /// the timeout exists so a hung socket cannot pin a post-response slot forever.
  async function send({ to, subject, text, html, idempotencyKey, tag }) {
    if (!config.RESEND_OTP_API_KEY) throw Object.assign(new Error("resend key missing"), { code: "mail_not_configured" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.RESEND_OTP_API_KEY}`,
          "Content-Type": "application/json",
          // UNVERIFIED support (§4.6); Resend ignores unknown headers today.
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: config.OTP_FROM,
          to: Array.isArray(to) ? to : [to],
          subject,
          text,
          ...(html ? { html } : {}),
          ...(tag ? { tags: [{ name: "type", value: tag }] } : {}),
        }),
      });
    } catch (err) {
      throw Object.assign(new Error(err?.name === "AbortError" ? "mail timeout" : "mail request failed"), { code: "mail_failed" });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The body can echo the recipient address, so only the status is logged (§1.3).
      throw Object.assign(new Error(`resend ${response.status}`), { code: "mail_failed", status: response.status });
    }
    const body = await response.json().catch(() => ({}));
    return { providerId: typeof body?.id === "string" ? body.id : null };
  }

  /// Returns the value for otp_codes.mail_status, so the caller writes exactly
  /// what happened: 'sent', 'logged' or (on a throw) 'failed'.
  async function sendOtpMail({ to, code, otpId, emailHash }) {
    if (config.otpMailTransport === "log") {
      // Reachable only outside production and with ALLOW_OTP_LOG=1 (§2.2). The
      // address itself still never reaches the log — the hash identifies the run.
      log.log(`[otp] code for h=${emailHash}: ${code}`);
      return { status: "logged", providerId: null };
    }
    const { providerId } = await send({
      to,
      subject: otpSubject(code),
      text: renderOtpText(code),
      html: renderOtpHtml(code),
      idempotencyKey: otpId ? `otp-${otpId}` : undefined,
      tag: "staff_otp",
    });
    return { status: "sent", providerId };
  }

  /// DECLINE_NOTIFY_EMAILS empty = off, exactly like the "Kemst ekki" mail (§2.2).
  async function sendGuessAlert({ name, count }) {
    const to = config.declineNotifyEmails;
    if (!to.length) return { status: "skipped" };
    const text = renderGuessAlertText({ name, count });
    if (config.otpMailTransport === "log") {
      log.log(`[otp] guess alert (log transport): ${name} ${count}`);
      return { status: "logged", providerId: null };
    }
    const { providerId } = await send({ to, subject: GUESS_ALERT_SUBJECT, text, tag: "staff_otp_alert" });
    return { status: "sent", providerId };
  }

  /// `send` is exported so declineMail.js can post through the same key, the same
  /// timeout and the same "status only, never the body" logging rule (§4.8).
  return { send, sendOtpMail, sendGuessAlert };
}

export default createMailer;
