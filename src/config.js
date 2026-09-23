// ---------------------------------------------------------------------------
// Environment, feature flags and the secrets rule (spec §2.2)
// ---------------------------------------------------------------------------
//
// This module must NEVER throw at import: index.js loads the /v2 graph after
// listen, but a config crash here would still poison every /v2 route and make
// the failure look like a database problem. Bad values fall back to the safe
// default and are reported through /v2/health as "missing"/"off", never by value.

/// A secret counts as *configured* only when it is set and at least this long.
/// Shorter than this and the feature it guards stays off, so a placeholder value
/// ("changeme") can never silently protect staff logins or the internal endpoints.
export const SECRET_MIN_LENGTH = 32;

const str = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => str(v).split(",").map((s) => s.trim()).filter(Boolean);

/// Secrets are read RAW (no trim): they are HMAC/JWT key material and must stay
/// byte-identical to what was pasted into Railway.
const secret = (v) => (typeof v === "string" ? v : "");
const isConfiguredSecret = (v) => typeof v === "string" && v.length >= SECRET_MIN_LENGTH;

/// "1"/"0" flags with an explicit default, so an empty Railway value does not
/// flip a job on or off by accident.
const flag01 = (v, dflt) => {
  const s = str(v);
  if (s === "1") return true;
  if (s === "0") return false;
  return dflt;
};

const oneOf = (v, allowed, dflt) => {
  const s = str(v).toLowerCase();
  return allowed.includes(s) ? s : dflt;
};

/// "HH:MM" with real hour/minute ranges; anything else falls back to the default.
const hhmm = (v, dflt) => {
  const s = str(v);
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return dflt;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? s : dflt;
};

/// private = Railway's internal network (the ${{Postgres.DATABASE_URL}} reference),
/// which is what slice 1 expects; public means the proxy URL, which needs
/// DATABASE_SSL=require (§3.1). Never returns the URL or the host itself.
export function dbNetworkOf(databaseUrl) {
  const url = str(databaseUrl);
  if (!url) return "missing";
  if (url.startsWith("pglite:")) return "pglite";
  try {
    return new URL(url).hostname.endsWith(".railway.internal") ? "private" : "public";
  } catch {
    return "public";
  }
}

export function loadConfig(env = process.env) {
  /// Railway sets RAILWAY_ENVIRONMENT_NAME automatically, so a forgotten NODE_ENV
  /// can never turn on the OTP log transport or a `now` override in production.
  const isProduction = env.NODE_ENV === "production" || str(env.RAILWAY_ENVIRONMENT_NAME) !== "";

  const STAFF_JWT_SECRET = secret(env.STAFF_JWT_SECRET);
  const STAFF_JWT_SECRET_PREVIOUS = secret(env.STAFF_JWT_SECRET_PREVIOUS);
  const OTP_HMAC_SECRET = secret(env.OTP_HMAC_SECRET);
  const VAKT_INTERNAL_SECRET = secret(env.VAKT_INTERNAL_SECRET);

  const authConfigured = isConfiguredSecret(STAFF_JWT_SECRET) && isConfiguredSecret(OTP_HMAC_SECRET);
  const internalConfigured = isConfiguredSecret(VAKT_INTERNAL_SECRET);

  /// `log` prints the OTP to the console. It needs BOTH a non-production process
  /// and an explicit ALLOW_OTP_LOG=1, so neither one alone can leak login codes.
  const requestedMailTransport = oneOf(env.OTP_MAIL_TRANSPORT, ["resend", "log"], "resend");
  const logTransportAllowed = !isProduction && str(env.ALLOW_OTP_LOG) === "1";
  const otpMailTransport = requestedMailTransport === "log" && logTransportAllowed ? "log" : "resend";

  const RESEND_OTP_API_KEY = str(env.RESEND_OTP_API_KEY);
  const mailStatus = otpMailTransport === "log" ? "log" : RESEND_OTP_API_KEY ? "configured" : "missing";

  const DATABASE_URL = str(env.DATABASE_URL);
  const OPTIMOROUTE_API_KEY = str(env.OPTIMOROUTE_API_KEY);

  return {
    isProduction,

    // --- secrets (values; never logged, never served) ---
    STAFF_JWT_SECRET,
    STAFF_JWT_SECRET_PREVIOUS,
    OTP_HMAC_SECRET,
    VAKT_INTERNAL_SECRET,
    /// [current, previous] for verifyJwt, so STAFF_JWT_SECRET can rotate without
    /// signing everyone out. Empty when the secret is not configured.
    jwtSecrets: isConfiguredSecret(STAFF_JWT_SECRET)
      ? [STAFF_JWT_SECRET, ...(isConfiguredSecret(STAFF_JWT_SECRET_PREVIOUS) ? [STAFF_JWT_SECRET_PREVIOUS] : [])]
      : [],

    // --- secrets rule, as reported by /v2/health (§4.4) ---
    authConfigured,
    authStatus: authConfigured ? "configured" : "missing",
    internalConfigured,
    internalStatus: internalConfigured ? "configured" : "off",

    // --- database (§3.1) ---
    DATABASE_URL,
    /// disable → ssl:false (private network). require → ssl:{rejectUnauthorized:false},
    /// only needed if the public proxy URL is ever used. Never put sslmode= in the URL.
    DATABASE_SSL: oneOf(env.DATABASE_SSL, ["disable", "require"], "disable"),
    dbNetwork: dbNetworkOf(DATABASE_URL),

    // --- mail (§4.6) ---
    RESEND_OTP_API_KEY,
    // The verified Resend domain is updates.bagbee.is, a subdomain — Resend
    // refuses any other sender with a 403 (2026-09-23). The default matches it;
    // a reply address on the real mailbox is optional.
    OTP_FROM: str(env.OTP_FROM) || "BagBee <innskraning@updates.bagbee.is>",
    OTP_REPLY_TO: str(env.OTP_REPLY_TO) || "",
    otpMailTransport,
    mailStatus,

    // --- APNs (§7); the key itself is parsed lazily, never at boot ---
    APNS_KEY_P8: typeof env.APNS_KEY_P8 === "string" ? env.APNS_KEY_P8 : "",
    APNS_KEY_ID: str(env.APNS_KEY_ID),
    APNS_TEAM_ID: str(env.APNS_TEAM_ID),
    APNS_TOPIC: str(env.APNS_TOPIC) || "is.bagbee.app",

    // --- Airtable / OptimoRoute (read-only use) ---
    AIRTABLE_TOKEN: str(env.AIRTABLE_TOKEN),
    OPTIMOROUTE_API_KEY,
    optimoStatus: OPTIMOROUTE_API_KEY ? "configured" : "missing",

    // --- feature flags (§2.2) ---
    vaktShell: oneOf(env.VAKT_SHELL, ["on", "off"], "off"),
    staffLoginAllowlist: list(env.STAFF_LOGIN_ALLOWLIST),
    appRoutesAcceptStaffJwt: flag01(env.APP_ROUTES_ACCEPT_STAFF_JWT, false),
    pushMode: oneOf(env.PUSH_MODE, ["off", "pilot", "on"], "off"),
    workerEnabled: flag01(env.WORKER_ENABLED, true),
    planPushTonight: flag01(env.PLAN_PUSH_TONIGHT, true),
    planSlotSplit: hhmm(env.PLAN_SLOT_SPLIT, "16:00"),
    counterPushEnabled: flag01(env.COUNTER_PUSH_ENABLED, true),
    declineNotifyEmails: list(env.DECLINE_NOTIFY_EMAILS),

    /// A caller-supplied `now` (internal job endpoints, §4.7) is honoured only
    /// outside production, so a stray request can never move the clock on Railway.
    allowNowOverride: !isProduction,

    /// Informational in slice 1: the app shows nothing for it (§4.4).
    minAppBuild: 41,
  };
}

export default loadConfig;
