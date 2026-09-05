/**
 * Karachi calendar helpers for operational reporting (no external deps).
 */
const TIMEZONE = "Asia/Karachi";

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Current calendar YYYY-MM-DD in Asia/Karachi. */
function todayYmd(timezone = TIMEZONE) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA → YYYY-MM-DD
  return fmt.format(new Date());
}

function assertYmd(value, label = "date") {
  const s = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid ${label}=${value}; expected YYYY-MM-DD`);
  }
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new Error(`Invalid calendar ${label}=${value}`);
  }
  return s;
}

/** Subtract calendar days from YYYY-MM-DD (UTC date arithmetic). */
function addDaysYmd(ymd, deltaDays) {
  const s = assertYmd(ymd);
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(deltaDays));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(
    dt.getUTCDate()
  )}`;
}

/**
 * Trailing window ending on reportingDate inclusive.
 * days=7 → since = until - 6 days.
 */
function trailingWindow(reportingDate, days) {
  const until = assertYmd(reportingDate, "date");
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid days=${days}; expected positive integer`);
  }
  const since = addDaysYmd(until, -(n - 1));
  return { since, until, days: n };
}

function eachYmdInclusive(since, until) {
  const a = assertYmd(since, "since");
  const b = assertYmd(until, "until");
  if (a > b) throw new Error(`since (${a}) is after until (${b})`);
  const out = [];
  let cur = a;
  while (cur <= b) {
    out.push(cur);
    cur = addDaysYmd(cur, 1);
  }
  return out;
}

function formatDisplayDate(ymd) {
  const s = assertYmd(ymd);
  const [y, m, d] = s.split("-").map(Number);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${d} ${months[m - 1]} ${y}`;
}

module.exports = {
  TIMEZONE,
  todayYmd,
  assertYmd,
  addDaysYmd,
  trailingWindow,
  eachYmdInclusive,
  formatDisplayDate,
};
