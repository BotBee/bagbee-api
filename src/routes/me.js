// ---------------------------------------------------------------------------
// GET /v2/me (spec §4.5)
// ---------------------------------------------------------------------------
//
// Mounted behind requireStaff, so this file never decides who you are. What it
// does decide, on every single call, is whether you are still staff: the roster is
// re-read (≤ 10 min cache) and someone who has gone Inactive is signed out of every
// device here and now, not at the next refresh (§4.5, S6).
//
// The app calls this at launch and after each safe point, which makes it the most
// frequent authenticated route in slice 1 — hence the session cache in
// requireStaff and the roster cache behind syncWithRoster: a normal call costs one
// Postgres query and no Airtable request at all.
//
// The shift routes turned out to want their own file: /v2/me/shifts, its detail
// and the confirm answer live in src/routes/meShifts.js, mounted ahead of this
// router for the same reason /me/devices is (§13, B4).

import express from "express";
import { isoSec } from "../time.js";

export function createMeRoutes({ db, config, identity }) {
  const router = express.Router();

  router.get("/", async (req, res, next) => {
    try {
      const staffRow = await identity.loadStaffRow(req.staff.id);
      // The row is gone (an ON DELETE CASCADE would have taken the session too):
      // treat it exactly like an Inactive person rather than 500.
      if (!staffRow) return res.status(403).json({ error: "staff_inactive" });

      const synced = await identity.syncWithRoster(staffRow);
      if (!synced.ok) return res.status(403).json({ error: "staff_inactive" });

      const { rows } = await db.query(
        `SELECT s.created_at AS session_created_at,
                d.id AS device_id, d.apns_token, d.apns_environment, d.invalidated_at
           FROM sessions s
           LEFT JOIN devices d ON d.id = s.device_id
          WHERE s.id = $1`,
        [req.staff.sessionId],
      );
      const row = rows[0] || {};

      res.json({
        staff: identity.staffProfile(synced.row),
        session: { id: req.staff.sessionId, createdAt: isoSec(row.session_created_at) },
        device: row.device_id
          ? {
              id: row.device_id,
              // "Can we actually reach this phone?" — a token that was invalidated
              // by a 410 or a hand-over is not a registration any more.
              pushRegistered: Boolean(row.apns_token) && row.invalidated_at === null,
              apnsEnvironment: row.apns_environment ?? null,
            }
          : null,
        features: { pushMode: config.pushMode },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createMeRoutes;
