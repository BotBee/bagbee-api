// ---------------------------------------------------------------------------
// Push payloads — PURE (spec §6.6)
// ---------------------------------------------------------------------------
//
// Nothing here touches the database, the clock or the network, so the "no
// customer data in a push" rule is a property of the function signatures and not
// of anyone's discipline: these builders are never given a stop name, an address,
// a customer name or a phone number, so they cannot leak one (§10.1).
//
// Iceland is UTC+0 all year, so every date/time here is plain UTC (see time.js).

import { hhmmToEpoch } from "../time.js";

const WEEKDAYS = ["sun.", "mán.", "þri.", "mið.", "fim.", "fös.", "lau."];
const MONTHS = ["jan", "feb", "mar", "apr", "maí", "jún", "júl", "ágú", "sep", "okt", "nóv", "des"];

/// "2026-09-17" -> "fim. 17. sep". Same output as the app's VaktFormat (§6.6).
export function fmtDateIs(date) {
  const d = new Date(`${String(date)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(date ?? "");
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}`;
}

/// Icelandic singular: 1, 21, 31 … but NOT 11. `11 töskur`, `21 taska`.
export function plural(n, one, many) {
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : many}`;
}

/// Driving shift labels (§6.6). Counter labels are the BSÍ ones below.
export const DRIVING_LABELS = { Morning: "Morgunvakt", Evening: "Kvöldvakt" };
export const COUNTER_LABELS = { Morning: "BSÍ · Morgunn", Midday: "BSÍ · Miðdagur", Custom: "BSÍ · Sérvakt" };
/// Used when Start/End are blank on a BSÍ row (§4.5). Custom has no default pair.
export const COUNTER_DEFAULT_HOURS = { Morning: ["09:00", "13:00"], Midday: ["13:00", "17:00"] };

export const PLAN_TITLES = {
  plan_published: "Áætlun morgundagsins er komin",
  plan_revised: "Áætlun uppfærð",
  plan_tonight: "Áætlun kvöldsins er komin",
};

/// `${label} ${date} · N stopp · N töskur · fyrsta stopp HH:MM`, with the last
/// part dropped when Optimo gave us no time for the first stop.
export function planBody({ label, date, stopCount, bagCount, firstStopAt }) {
  const head = `${label} ${fmtDateIs(date)} · ${stopCount} stopp · ${plural(bagCount, "taska", "töskur")}`;
  return firstStopAt ? `${head} · fyrsta stopp ${firstStopAt}` : head;
}

/// Plan push for a driving shift. `kind` is the push_log kind, which the sender
/// resolves per recipient (a late joiner gets plan_published, not "BREYTT:", §6.5).
export function planPushPayload({ kind, shiftRef, date, slot, planVersion, recipient, stopCount, bagCount, firstStopAt }) {
  const body = planBody({ label: DRIVING_LABELS[slot] || slot, date, stopCount, bagCount, firstStopAt });
  return {
    aps: {
      alert: {
        title: PLAN_TITLES[kind] || PLAN_TITLES.plan_published,
        body: kind === "plan_revised" ? `BREYTT: ${body}` : body,
      },
      sound: "default",
      category: "PLAN_PUBLISHED",
      "interruption-level": "time-sensitive",
      "relevance-score": 1,
      "thread-id": threadIdFor(shiftRef),
    },
    shiftRef,
    kind: "driving",
    date,
    slot,
    planVersion,
    recipient,
  };
}

/// "09–13" when both ends are on the hour, "09:30–13:00" otherwise (§6.6). The
/// en dash is deliberate: it is what the proposal's copy uses.
export function counterHours(startTime, endTime) {
  if (!startTime || !endTime) return null;
  const whole = startTime.endsWith(":00") && endTime.endsWith(":00");
  const cut = (t) => (whole ? t.slice(0, 2) : t);
  return `${cut(startTime)}–${cut(endTime)}`;
}

export function counterPushPayload({ shiftRef, date, slot, startTime, endTime, recipient }) {
  const [dStart, dEnd] = COUNTER_DEFAULT_HOURS[slot] || [];
  const hours = counterHours(startTime || dStart, endTime || dEnd);
  return {
    aps: {
      // A Sérvakt with no Start/End has no hours to show; the body still carries
      // the date and the label, which is better than printing "undefined".
      alert: {
        title: hours ? `Vaktin þín á morgun: BSÍ ${hours}` : "Vaktin þín á morgun: BSÍ",
        body: `${fmtDateIs(date)} · ${COUNTER_LABELS[slot] || slot}`,
      },
      sound: "default",
      category: "PLAN_PUBLISHED",
      "interruption-level": "time-sensitive",
      "relevance-score": 1,
      "thread-id": threadIdFor(shiftRef),
    },
    shiftRef,
    kind: "counter",
    date,
    slot,
    planVersion: 1,
    recipient,
  };
}

/// Mitt › "Senda prufutilkynningu" (§4.5). No category, so no Já/Kemst ekki
/// buttons, and no shift data at all — it proves the token, nothing else.
export function testPushPayload() {
  return {
    aps: {
      alert: { title: "Prufa", body: "Tilkynningar virka á þessu tæki." },
      sound: "default",
    },
    kind: "test",
  };
}

export function threadIdFor(shiftRef) {
  return `shift-${shiftRef}`;
}

/// `plan-<ref>` / `counter-<ref>`, ≤ 64 bytes (unit-tested). One collapse id per
/// shift means a revision REPLACES the earlier banner on the lock screen instead
/// of stacking a second one.
export function collapseIdFor(shiftRef) {
  return `${String(shiftRef).startsWith("bsi_") ? "counter" : "plan"}-${shiftRef}`;
}

/// apns-expiration: after this the push is pointless, so Apple should drop it
/// rather than deliver it when the phone comes back online mid-shift (§6.6).
/// Driving: the first stop's full datetime — an Evening starting 17:09 must not
/// be given its own 01:11 post-midnight stop as a start time.
export function expirationFor({ shiftRef, date, slot, firstStopDt, startTime }) {
  const seconds = (ms) => (Number.isFinite(ms) ? Math.floor(ms / 1000) : null);
  if (String(shiftRef || "").startsWith("bsi_")) {
    const [dStart] = COUNTER_DEFAULT_HOURS[slot] || [];
    return seconds(hhmmToEpoch(date, startTime || dStart || "23:59")) ?? 0;
  }
  if (firstStopDt) {
    const ms = firstStopDt instanceof Date ? firstStopDt.getTime() : Date.parse(firstStopDt);
    const at = seconds(ms);
    if (at) return at;
  }
  return seconds(hhmmToEpoch(date, slot === "Morning" ? "12:00" : "23:59")) ?? 0;
}

export default { planPushPayload, counterPushPayload, testPushPayload, collapseIdFor, expirationFor };
