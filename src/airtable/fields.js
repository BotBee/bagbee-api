// ---------------------------------------------------------------------------
// Airtable table and field ids (spec §5.1)
// ---------------------------------------------------------------------------
//
// Every read uses ids, never names: `returnFieldsByFieldId: true` on the way in
// and `{fldXXXXXXXXXXXXXX}` inside formulas on the way out. A rename in Airtable
// then breaks nothing — and renames happen (the Orders table is called
// "Nýtt/óflokkað" in the UI today, see memory: Airtable base).
//
// VERIFIED against the meta API 2026-09-16: all 56 ids below exist in
// appHB2bNYPAhfUcLv with the names and types the spec lists.

export const BASE_ID = "appHB2bNYPAhfUcLv";

export const TABLES = {
  staff: "tbllRYtP3sQGD8CIz", // Starfsmenn
  shifts: "tblaDEYYQ1Wg3gHO0", // Vaktaskipulag
  counter: "tblehUyLpe0t6to1Z", // BSÍ Counter Shifts
  orders: "tblWLlNxZvtkFSFXs", // Orders ("Nýtt/óflokkað"). READ ONLY.
  stops: "tblE3fYDSuk7dKPdF", // Optimo Stops
};

/// Starfsmenn. `name` has surrounding spaces on 4 rows, so always trim it.
export const STAFF = {
  name: "fldX5TNwfslcXkpkT",
  first: "fldWegjkxEgW1kgii",
  last: "fld3YhpqXuFzwj5pl",
  personalEmail: "fldKC0WKGJwOOzoj2",
  email: "fld4aPfa9tnNTpq5r",
  team: "fld269e3mmanYY8Yv",
  status: "fldS0z2EZSlrHWR5M",
  phone: "fldrtMAK5SDwYN7mW", // not read in slice 1
};

/// Vaktaskipulag (driving shifts).
export const SHIFT = {
  date: "fldx0Ga6El80HF9w6",
  shift: "fldMuKqNnqsldMk2R", // Morning | Evening
  vaktByrjar: "fldTgbLTldx9cC1M2", // dateTime, set on 1 of 1,799 rows
  driver: "fldAZ3J4BWJ9CXzwn", // link → Starfsmenn; 2+ links = two-person shift
  extraDriver: "fldnEfJe0V9x0B5O2",
  other: "fld5gcNpdDhxhfmdC", // Aðrir starfsmenn
  starfsmadur: "fldFuox3xirg0eu5M", // NOT read in slice 1 (§5.4)
  comment: "fldup2VyklPR8QXmy",
  totalBags: "fldTJCMVWvmo6YtJQ", // rollup, not used for counts (§4.5)
  orders: "fldA2BVu0AiTisLj5", // Pantanir á vakt, incomplete (§0.5)
};

/// BSÍ Counter Shifts.
export const COUNTER = {
  name: "fld3PTy5Tf93rlmNm",
  date: "fldYl4gO51LLK6UFc",
  slot: "fldV0Xq7s87r8nyu6", // Morning | Midday | Custom
  start: "fldXs33XvePsGoCbi", // text HH:MM
  end: "fldgCj3ESlpaH4enm", // text HH:MM
  staff: "fldU2BW7HDfhl68i0", // link → Starfsmenn
  status: "fldx19OG14v93SZ9m", // Open | Scheduled | Confirmed | Completed | Cancelled
  hours: "fld9h6ZaGyy1nDccW",
  notes: "fldhfJREfDaGEhaot",
};

/// Orders. READ ONLY — a create here fires real customer emails.
export const ORDER = {
  pickupDate: "fldYDA8Fuk8bU9tZA",
  orderNumber: "fldo3soPBdIjoOv7H", // Pöntunarnúmer (fx) = the Optimo orderNo base
  shiftFormula: "fldkdoNmHwjvu6JU9", // Morning | Evening | Unknown
  shiftLink: "fldCoRXUrWNxG1L7J", // link → Vaktaskipulag
  paid: "fldQEgArrB69AHTqy", // Greitt
  customerName: "flds4W4WLarQ5MBEg",
  pickupAddress: "fldA2biuvoFnabjur", // Heimilisfang
  deliveryAddress: "fldSXm2qLZgpDtDgO",
  timeWindow: "fldXyzfLIhi4G25p4", // Tímasetning
  totalBags: "fldqryDFmuPoFcHnw",
  requestedService: "fld1X7tjNHegjEE6W",
  reference: "fldAqtOvVsGju0Vhy",
  phone: "fldLNjUKpMHtre188", // Símanúmer
  stops: "fldmlXJcHEnzzgl6R",
};

/// Optimo Stops. Fallback source for the plan when no snapshot is fresh (§5.5).
export const STOP = {
  orderNumber: "fldS3KzI6QMI0tuhu", // "-D" marks the delivery leg
  id: "fldTFRMuKfvyuXItD",
  relatedOrder: "fldLtOXA088GfGp3h",
  orderDate: "fldyw2ObQ015FwW3y", // lookup: Dagsetning pick-up (from Related Order)
  stopNumber: "fldEmbcZ84vvgqpZL",
  scheduledAt: "fldjE1YgXR5vEQL1l", // HH:MM
  scheduledAtDt: "fldF1VruFzCMJFDxb", // "YYYY-MM-DD HH:MM:SS", may be D+1
  driver: "fldjCmx0OQ3jkAE1Z", // Optimo slot label, not a person
  address: "fld7GpTsJIC5tEQ0z",
  locationName: "fld8UMord4GQT1Pwu",
  latitude: "fldncAqZhal0vRP0V",
  longitude: "fldU51CvLpFnLiQ5J",
  pickupCompleted: "fldC4VDeNVBEnifi5",
  deliveryCompleted: "fldmbHmXaVglIwev4",
  trackingURL: "fldeGys1p7KBzYx13",
};

// --- explicit field lists -------------------------------------------------
// Reads always name the fields they want. Asking for everything would pull
// customer notes and phone numbers into memory on every roster refresh.

/// Login lookup: enough to build the staff row and decide the role.
export const STAFF_LOOKUP_FIELDS = [
  STAFF.name,
  STAFF.first,
  STAFF.personalEmail,
  STAFF.email,
  STAFF.team,
  STAFF.status,
];

/// Crew names, the Active re-check and the owner check (§5.3).
export const ROSTER_FIELDS = [STAFF.name, STAFF.first, STAFF.team, STAFF.status];

export const SHIFT_FIELDS = [
  SHIFT.date,
  SHIFT.shift,
  SHIFT.vaktByrjar,
  SHIFT.driver,
  SHIFT.extraDriver,
  SHIFT.other,
  SHIFT.comment,
];

export const COUNTER_FIELDS = [
  COUNTER.name,
  COUNTER.date,
  COUNTER.slot,
  COUNTER.start,
  COUNTER.end,
  COUNTER.staff,
  COUNTER.status,
  COUNTER.notes,
];

/// The shifts list only needs to count Greitt orders and their bags (§4.5).
export const ORDER_COUNT_FIELDS = [
  ORDER.pickupDate,
  ORDER.orderNumber,
  ORDER.shiftFormula,
  ORDER.shiftLink,
  ORDER.paid,
  ORDER.totalBags,
];

/// The detail join needs the customer-facing fields as well (§5.1, §5.5).
export const ORDER_DETAIL_FIELDS = [
  ORDER.pickupDate,
  ORDER.orderNumber,
  ORDER.shiftFormula,
  ORDER.shiftLink,
  ORDER.paid,
  ORDER.customerName,
  ORDER.pickupAddress,
  ORDER.deliveryAddress,
  ORDER.timeWindow,
  ORDER.totalBags,
  ORDER.requestedService,
  ORDER.reference,
  ORDER.phone,
];

export const STOP_FIELDS = [
  STOP.orderNumber,
  STOP.orderDate,
  STOP.stopNumber,
  STOP.scheduledAt,
  STOP.scheduledAtDt,
  STOP.driver,
  STOP.address,
  STOP.locationName,
  STOP.latitude,
  STOP.longitude,
  STOP.pickupCompleted,
  STOP.deliveryCompleted,
  STOP.trackingURL,
];

/// Airtable formula values are single-quoted, so a quote in user input would
/// break out of the literal. Same logic as index.js:88-90 (§5.3 says copy it
/// rather than import it, so /v2 never reaches into the legacy module).
export function escapeFormulaValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
