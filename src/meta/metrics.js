/**
 * Meta Insights metric helpers.
 *
 * Action arrays (actions / action_values / cost_per_action_type) often include
 * overlapping purchase variants. We pick the first matching preferred type so
 * we do not sum and double-count.
 */

const PURCHASE_TYPES = [
  "purchase",
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
];

const ATC_TYPES = [
  "add_to_cart",
  "omni_add_to_cart",
  "offsite_conversion.fb_pixel_add_to_cart",
];

const CHECKOUT_TYPES = [
  "initiate_checkout",
  "omni_initiated_checkout",
  "offsite_conversion.fb_pixel_initiate_checkout",
];

const LPV_TYPES = ["landing_page_view", "omni_landing_page_view"];

function toNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeDiv(numerator, denominator) {
  const n = toNumber(numerator);
  const d = toNumber(denominator);
  if (n == null || d == null || d === 0) return null;
  return n / d;
}

/**
 * Find the first preferred action type present in a Meta action array.
 * Returns { action_type, value } or null.
 */
function pickAction(list, preferredTypes) {
  if (!Array.isArray(list) || !list.length) return null;
  const byType = new Map();
  for (const item of list) {
    if (!item || item.action_type == null) continue;
    const n = toNumber(item.value);
    if (n == null) continue;
    byType.set(String(item.action_type), n);
  }
  for (const type of preferredTypes) {
    if (byType.has(type)) {
      return { action_type: type, value: byType.get(type) };
    }
  }
  return null;
}

function actionValue(list, preferredTypes) {
  const hit = pickAction(list, preferredTypes);
  return hit ? hit.value : 0;
}

function actionValueOrNull(list, preferredTypes) {
  const hit = pickAction(list, preferredTypes);
  return hit ? hit.value : null;
}

function numField(row, key, fallback = 0) {
  const n = toNumber(row?.[key]);
  return n == null ? fallback : n;
}

function numFieldOrNull(row, key) {
  return toNumber(row?.[key]);
}

/**
 * Normalize one Insights row into Wear Active KPIs.
 * Does not invent attribution — only derives ratios from returned fields.
 */
function enrichInsightRow(row = {}) {
  const spend = numField(row, "spend", 0);
  const impressions = numField(row, "impressions", 0);
  const reach = numFieldOrNull(row, "reach");
  const clicks = numField(row, "clicks", 0);
  const linkClicks = numFieldOrNull(row, "inline_link_clicks");

  const purchases = actionValue(row.actions, PURCHASE_TYPES);
  const purchaseValue = actionValue(row.action_values, PURCHASE_TYPES);
  const addToCarts = actionValue(row.actions, ATC_TYPES);
  const checkouts = actionValue(row.actions, CHECKOUT_TYPES);
  const landingPageViews = actionValue(row.actions, LPV_TYPES);

  const purchasePick = pickAction(row.actions, PURCHASE_TYPES);
  const cpaFromMeta = actionValueOrNull(
    row.cost_per_action_type,
    PURCHASE_TYPES
  );

  const frequency =
    numFieldOrNull(row, "frequency") ??
    (reach && reach > 0 ? impressions / reach : null);
  const cpm =
    numFieldOrNull(row, "cpm") ??
    (impressions > 0 ? (spend / impressions) * 1000 : null);
  const ctr =
    numFieldOrNull(row, "ctr") ??
    (impressions > 0 ? (clicks / impressions) * 100 : null);
  const cpc =
    numFieldOrNull(row, "cpc") ?? (clicks > 0 ? spend / clicks : null);

  const cpa = purchases > 0 ? spend / purchases : cpaFromMeta;
  const roas = spend > 0 ? purchaseValue / spend : null;
  const purchaseCvr =
    impressions > 0 ? (purchases / impressions) * 100 : null;

  return {
    campaign_id: row.campaign_id || null,
    campaign_name: row.campaign_name || null,
    adset_id: row.adset_id || null,
    adset_name: row.adset_name || null,
    ad_id: row.ad_id || null,
    ad_name: row.ad_name || null,
    date_start: row.date_start || null,
    date_stop: row.date_stop || null,
    spend,
    impressions,
    reach: reach ?? 0,
    frequency,
    clicks,
    inline_link_clicks: linkClicks,
    cpm,
    ctr,
    cpc,
    purchases,
    purchase_value: purchaseValue,
    purchase_action_type: purchasePick?.action_type || null,
    cpa,
    roas,
    add_to_carts: addToCarts,
    initiated_checkouts: checkouts,
    landing_page_views: landingPageViews,
    purchase_cvr_pct: purchaseCvr,
  };
}

function sumRows(rows) {
  const blank = {
    spend: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    inline_link_clicks: 0,
    purchases: 0,
    purchase_value: 0,
    add_to_carts: 0,
    initiated_checkouts: 0,
    landing_page_views: 0,
  };

  for (const row of rows) {
    blank.spend += row.spend || 0;
    blank.impressions += row.impressions || 0;
    // Reach is not strictly additive across campaigns; sum is an upper-bound proxy.
    blank.reach += row.reach || 0;
    blank.clicks += row.clicks || 0;
    blank.inline_link_clicks += row.inline_link_clicks || 0;
    blank.purchases += row.purchases || 0;
    blank.purchase_value += row.purchase_value || 0;
    blank.add_to_carts += row.add_to_carts || 0;
    blank.initiated_checkouts += row.initiated_checkouts || 0;
    blank.landing_page_views += row.landing_page_views || 0;
  }

  const frequency =
    blank.reach > 0 ? blank.impressions / blank.reach : null;
  const cpm =
    blank.impressions > 0 ? (blank.spend / blank.impressions) * 1000 : null;
  const ctr =
    blank.impressions > 0 ? (blank.clicks / blank.impressions) * 100 : null;
  const cpc = blank.clicks > 0 ? blank.spend / blank.clicks : null;
  const cpa = blank.purchases > 0 ? blank.spend / blank.purchases : null;
  const roas = blank.spend > 0 ? blank.purchase_value / blank.spend : null;
  const purchaseCvr =
    blank.impressions > 0
      ? (blank.purchases / blank.impressions) * 100
      : null;

  return {
    ...blank,
    frequency,
    cpm,
    ctr,
    cpc,
    cpa,
    roas,
    purchase_cvr_pct: purchaseCvr,
    note:
      "Aggregated reach is summed across rows (not de-duplicated). Prefer account-level reach when exact unique reach is required.",
  };
}

function formatMoney(amount, currency = "PKR") {
  const n = toNumber(amount);
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat("en-PK", {
      style: "currency",
      currency: currency || "PKR",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency || ""} ${n.toFixed(2)}`.trim();
  }
}

function formatNumber(value, digits = 2) {
  const n = toNumber(value);
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function formatPct(value, digits = 2) {
  const n = toNumber(value);
  if (n == null) return "—";
  return `${n.toFixed(digits)}%`;
}

function formatRoas(value) {
  const n = toNumber(value);
  if (n == null) return "—";
  return `${n.toFixed(2)}x`;
}

module.exports = {
  PURCHASE_TYPES,
  ATC_TYPES,
  CHECKOUT_TYPES,
  LPV_TYPES,
  toNumber,
  safeDiv,
  pickAction,
  actionValue,
  enrichInsightRow,
  sumRows,
  formatMoney,
  formatNumber,
  formatPct,
  formatRoas,
};
