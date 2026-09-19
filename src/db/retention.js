// ---------------------------------------------------------------------------
// Retention job (spec §3.4) — daily at 03:30
// ---------------------------------------------------------------------------
//
// Exactly the five DELETEs of §3.4 and nothing else. shift_confirmations is kept
// on purpose: its retention belongs to the proposal's GDPR work, not to a cron
// that could quietly erase the record of who said "Kemst ekki".

const STEPS = [
  ["otp_codes", "DELETE FROM otp_codes WHERE created_at < now() - interval '30 days'"],
  ["auth_throttle", "DELETE FROM auth_throttle WHERE window_start < now() - interval '2 days'"],
  ["plan_snapshots", "DELETE FROM plan_snapshots WHERE plan_date < current_date - 60"],
  ["push_log", "DELETE FROM push_log WHERE created_at < now() - interval '180 days'"],
  [
    "sessions",
    `DELETE FROM sessions
      WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '90 days')
         OR expires_at < now() - interval '30 days'`,
  ],
];

/// Returns { job: "retention", deleted: { table: count } }.
export async function runRetention({ db, log = console } = {}) {
  const deleted = {};
  for (const [table, sql] of STEPS) {
    const { rowCount } = await db.query(sql);
    deleted[table] = rowCount ?? 0;
  }
  log.log?.(`[retention] ${Object.entries(deleted).map(([t, n]) => `${t}=${n}`).join(" ")}`);
  return { job: "retention", deleted };
}

export default runRetention;
