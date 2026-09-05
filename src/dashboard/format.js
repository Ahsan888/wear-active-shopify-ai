/**
 * Dashboard formatting helpers (display only — no business logic).
 */
const {
  formatMoney,
  formatNumber,
  formatPct,
  formatRoas,
} = require("../meta/metrics");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(n, currency = "PKR") {
  return formatMoney(n, currency);
}

function num(n, digits = 0) {
  return formatNumber(n, digits);
}

function pct(n) {
  return formatPct(n);
}

function roas(n) {
  return formatRoas(n);
}

function statusClass(status) {
  const s = String(status || "").toLowerCase();
  if (
    [
      "strongly_profitable",
      "profitable",
      "large_safety_margin",
      "healthy",
      "strong",
      "hero",
      "scale_candidate",
      "ok",
      "high",
    ].includes(s)
  ) {
    return "ok";
  }
  if (
    [
      "thin_margin",
      "near_break_even",
      "moderate",
      "watch",
      "relatively_weak_cpa",
      "data_issue",
      "medium",
      "warning",
      "partial_period_not_comparable",
    ].includes(s)
  ) {
    return "warn";
  }
  if (
    [
      "unprofitable",
      "above_break_even",
      "high_cpa",
      "spend_no_purchase",
      "high_priority_spend_no_purchase",
      "weak_funnel",
      "negative_margin",
      "critical",
      "low",
      "unavailable",
    ].includes(s)
  ) {
    return "bad";
  }
  return "neutral";
}

function prettyStatus(status) {
  return String(status || "—")
    .replace(/_/g, " ")
    .toUpperCase();
}

function tip(text) {
  return `<span class="tip" title="${escapeHtml(text)}">ⓘ</span>`;
}

const TIPS = {
  business_wide_ad_load:
    "Actual Meta spend divided by all recognized business orders during the same period, including Shopify, Manual and Other Sales.",
  shopify_ad_load:
    "Actual Meta spend divided by recognized Shopify orders during the same period. This is blended context and does not mean every Shopify order came from Meta.",
  meta_cpa: "Meta spend divided by purchases attributed by Meta.",
  break_even_cpa:
    "Business profit available before ads divided by all recognized business orders. This is a business-wide safety threshold, not Meta-attributed CPA.",
  meta_adjusted_profit:
    "Books profit with booked Ads expense replaced analytically by actual date-aligned Meta spend. Meta spend is not double-counted.",
  meta_roas: "Purchase value attributed by Meta divided by Meta spend.",
  blended_mer:
    "Recognized business revenue divided by Meta spend; not attributed ROAS.",
};

module.exports = {
  escapeHtml,
  money,
  num,
  pct,
  roas,
  statusClass,
  prettyStatus,
  tip,
  TIPS,
};
