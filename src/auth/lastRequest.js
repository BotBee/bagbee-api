/// The outcome of the most recent request-code, for /v2/health.
///
/// A code request answers 200 whether or not a mail went out — that is the
/// point, a stranger must learn nothing — which leaves the owner with only the
/// deploy log to find out why a code never arrived. This keeps the last
/// outcome, with no address and no code, so the health page can say
/// "no-match", "allowlist", "sent" or "failed: resend 403" in plain sight.
let last = null;

export function noteRequestCode(outcome, detail = null) {
  last = { at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), outcome, detail };
}

export function lastRequestCode() {
  return last;
}
