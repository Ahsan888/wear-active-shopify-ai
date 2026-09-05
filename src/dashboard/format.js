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
      "positive_contribution",
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
      "near_zero",
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
      "negative_contribution",
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

/**
 * CPA evidence cell for Meta entities.
 * Purchasing → entity CPA / account CPA ("vs account CPA")
 * Zero-purchase → CPA unavailable; spend / account CPA as spend evidence
 */
function cpaEvidenceParts(entity) {
  const purchases = Number(entity?.purchases || 0);
  if (purchases > 0) {
    const ratio =
      entity.vs_account_ratio != null
        ? entity.vs_account_ratio
        : entity.entity_cpa_vs_account_ratio;
    return {
      purchases,
      cpa_available: true,
      cpa: entity.cpa_display != null ? entity.cpa_display : entity.meta_attributed_cpa,
      ratio_label: "vs account CPA",
      ratio,
    };
  }
  const ratio =
    entity.vs_account_ratio != null
      ? entity.vs_account_ratio
      : entity.spend_vs_account_cpa;
  return {
    purchases: 0,
    cpa_available: false,
    cpa: null,
    ratio_label: "Spend evidence vs account CPA",
    ratio,
  };
}

function formatCpaEvidenceHtml(entity, { moneyFn, escapeFn } = {}) {
  const parts = cpaEvidenceParts(entity);
  const money = moneyFn || ((n) => String(n ?? "—"));
  const esc = escapeFn || escapeHtml;
  if (parts.cpa_available) {
    return {
      cpaHtml: money(parts.cpa),
      evidenceHtml:
        parts.ratio == null
          ? "—"
          : `${esc(parts.ratio)}× <span class="muted">${esc(parts.ratio_label)}</span>`,
    };
  }
  return {
    cpaHtml: "—",
    evidenceHtml:
      parts.ratio == null
        ? "—"
        : `${esc(parts.ratio)}× <span class="muted">${esc(parts.ratio_label)}</span>`,
  };
}

const TIPS = {
  business_wide_ad_load:
    "Actual Meta spend divided by all recognized business orders during the same period, including Shopify, Manual and Other Sales.",
  shopify_ad_load:
    "Actual Meta spend divided by recognized Shopify orders during the same period. This is blended context and does not mean every Shopify order came from Meta. Not CAC.",
  meta_cpa: "Meta spend divided by purchases attributed by Meta.",
  break_even_cpa:
    "Business profit available before ads divided by all recognized business orders. This is a business-wide safety threshold, not Meta-attributed CPA.",
  meta_adjusted_profit:
    "Books economics with booked Ads expense replaced analytically by actual date-aligned Meta spend. Meta spend is not double-counted.",
  books_net_profit:
    "Accounting result using booked Ledger expenses (including booked Ads).",
  books_gross_margin:
    "Official Books gross margin using Ledger net revenue and all official COGS, including Gift/PR COGS.",
  meta_roas: "Purchase value attributed by Meta divided by Meta spend.",
  blended_mer:
    "Recognized business revenue divided by Meta spend; not attributed ROAS.",
  affordability:
    "Measures whether the overall business economics can absorb current Meta spend. Includes Shopify, Manual and Other Sales. It is not a measure of ecommerce acquisition efficiency.",
  shopify_contribution:
    "Shopify net revenue minus Shopify COGS minus date-aligned Meta spend. Shared operating expenses are not allocated. Not Meta-attributed profit. Refunds do not automatically reverse COGS.",
  shopify_net_revenue:
    "Shopify net revenue is recognized Shopify revenue after Ledger refunds. COGS is Ledger-driven; refunds do not automatically reverse COGS unless corresponding accounting entries exist.",
  paid_sales_total:
    "Paid sales economics exclude Gift/PR COGS. Official Books gross margin, which includes Gift/PR COGS, is shown in Profitability.",
  paid_sales_gm:
    "Paid Sales GM uses recognized paid-channel net revenue and paid-channel COGS (excludes Gift/PR). Books GM includes all official Ledger COGS.",
  recognized_order:
    "An order satisfying the Books recognition rules.",
  open_pipeline:
    "Shopify orders not yet recognized into accounting revenue. Open pipeline is not recognized revenue.",
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
  cpaEvidenceParts,
  formatCpaEvidenceHtml,
};
