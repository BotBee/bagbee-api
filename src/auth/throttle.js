// ---------------------------------------------------------------------------
// Fixed-window rate limits (spec §4.1 `hit(bucket, subject, windowSec, limit)`)
// ---------------------------------------------------------------------------
//
// The counters live in Postgres, not in memory, because Railway can run more than
// one instance during a deploy and a per-process limiter would silently double
// every limit at exactly the wrong moment.
//
// `subject` is never raw PII: emails and IPs are HMACed with OTP_HMAC_SECRET by
// throttleSubject() (§4.4); per-staff buckets use the staff uuid, which is ours.

const HIT = `
  INSERT INTO auth_throttle (bucket, subject, window_start, hits)
  VALUES ($1, $2, $3, 1)
  ON CONFLICT (bucket, subject, window_start)
  DO UPDATE SET hits = auth_throttle.hits + 1
  RETURNING hits`;

const PEEK = "SELECT hits FROM auth_throttle WHERE bucket = $1 AND subject = $2 AND window_start = $3";

export function createThrottle(db, clock = () => new Date()) {
  const windowOf = (windowSec) => {
    const nowSec = Math.floor(clock().getTime() / 1000);
    const startSec = Math.floor(nowSec / windowSec) * windowSec;
    // Time to the next window, never 0: a Retry-After of 0 invites a hot loop.
    return { nowSec, startSec, retryAfterSeconds: Math.max(1, startSec + windowSec - nowSec) };
  };

  /// Counts the request first, then answers whether it was allowed, so a caller
  /// that ignores `allowed` still gets throttled on the next one.
  async function hit(bucket, subject, windowSec, limit) {
    const { startSec, retryAfterSeconds } = windowOf(windowSec);
    const { rows } = await db.query(HIT, [bucket, subject, new Date(startSec * 1000)]);
    const hits = rows[0]?.hits ?? 1;
    return { allowed: hits <= limit, hits, limit, retryAfterSeconds };
  }

  /// Reads a bucket WITHOUT counting. verify-code needs this: the per-email fail
  /// buckets must be consulted before the code is compared, but they may only be
  /// incremented by an actual wrong guess against a live code (§4.4), or a correct
  /// login would spend the same budget that is meant to stop guessing.
  hit.peek = async function peek(bucket, subject, windowSec, limit) {
    const { startSec, retryAfterSeconds } = windowOf(windowSec);
    const { rows } = await db.query(PEEK, [bucket, subject, new Date(startSec * 1000)]);
    const hits = rows[0]?.hits ?? 0;
    return { allowed: hits < limit, hits, limit, retryAfterSeconds };
  };

  return hit;
}

/// The HTTP half of a limit, shared by every /v2 route that has one.
///
/// It COUNTS FIRST and answers afterwards, so a client that ignores the 429 is
/// still limited on its next try, and it returns a boolean rather than writing
/// the success path: the caller reads `if (await limited(...)) return;` and the
/// response is already sent when it is true.
export async function limited(res, hit, { bucket, windowSec, limit }, subject) {
  const r = await hit(bucket, subject, windowSec, limit);
  if (r.allowed) return false;
  res.set("Retry-After", String(r.retryAfterSeconds));
  res.status(429).json({ error: "rate_limited", retryAfterSeconds: r.retryAfterSeconds });
  return true;
}

export default createThrottle;
