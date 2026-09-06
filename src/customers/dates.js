/**
 * Date helpers + repurchase / cohort math for customer economics.
 */
const { addDaysYmd, assertYmd } = require("../operations/dates");

function daysBetweenYmd(a, b) {
  const x = assertYmd(a, "a");
  const y = assertYmd(b, "b");
  const [ay, am, ad] = x.split("-").map(Number);
  const [by, bm, bd] = y.split("-").map(Number);
  const t0 = Date.UTC(ay, am - 1, ad);
  const t1 = Date.UTC(by, bm - 1, bd);
  return Math.round((t1 - t0) / 86400000);
}

function monthKey(ymd) {
  return String(ymd || "").slice(0, 7);
}

function monthEndYmd(yyyyMm) {
  const [y, m] = String(yyyyMm).split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yyyyMm}-${String(last).padStart(2, "0")}`;
}

function median(nums) {
  const a = (nums || []).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function average(nums) {
  const a = (nums || []).filter((n) => Number.isFinite(n));
  if (!a.length) return null;
  return a.reduce((s, n) => s + n, 0) / a.length;
}

/**
 * Cohort checkpoint matured if until >= cohort_month_end + days.
 */
function cohortCheckpointMature(cohortMonth, until, days) {
  const end = monthEndYmd(cohortMonth);
  const maturedOn = addDaysYmd(end, days);
  return assertYmd(until, "until") >= maturedOn;
}

module.exports = {
  daysBetweenYmd,
  monthKey,
  monthEndYmd,
  median,
  average,
  cohortCheckpointMature,
};
