/**
 * Safe funnel stage ratios + plain-English stage explanations.
 * Null when denominator is zero/missing. Never invents stages.
 */
const { safeDiv, pctRatio, toNumber } = require("../meta/metrics");

function stageCounts(row = {}) {
  return {
    impressions: toNumber(row.impressions) ?? 0,
    link_clicks:
      toNumber(row.inline_link_clicks) ??
      (row.inline_link_clicks == null ? null : 0),
    landing_page_views: toNumber(row.landing_page_views) ?? 0,
    add_to_carts: toNumber(row.add_to_carts) ?? 0,
    checkouts: toNumber(row.initiated_checkouts) ?? 0,
    purchases: toNumber(row.purchases) ?? 0,
  };
}

/**
 * @returns {{ stages, rates, explanations }}
 */
function buildFunnel(row = {}) {
  const impressions = toNumber(row.impressions);
  const link_clicks = toNumber(row.inline_link_clicks);
  const lpv = toNumber(row.landing_page_views);
  const atc = toNumber(row.add_to_carts);
  const checkout = toNumber(row.initiated_checkouts);
  const purchases = toNumber(row.purchases);

  const stages = {
    impressions: impressions ?? 0,
    link_clicks: link_clicks, // may be null if Meta did not return the field
    landing_page_views: lpv ?? 0,
    add_to_carts: atc ?? 0,
    checkouts: checkout ?? 0,
    purchases: purchases ?? 0,
  };

  const rates = {
    impression_to_link_click_pct: pctRatio(link_clicks, impressions),
    link_click_to_lpv_pct: pctRatio(lpv, link_clicks),
    lpv_to_atc_pct: pctRatio(atc, lpv),
    atc_to_checkout_pct: pctRatio(checkout, atc),
    checkout_to_purchase_pct: pctRatio(purchases, checkout),
    lpv_to_purchase_pct: pctRatio(purchases, lpv),
  };

  return {
    stages,
    rates,
    explanation: explainFunnel(stages, rates),
    attribution_note:
      "Meta-reported purchase attribution only — not Books/business economics.",
  };
}

/**
 * Pick one plain-English explanation when volume supports it.
 * Prefer the earliest materially weak stage.
 */
function explainFunnel(stages, rates, opts = {}) {
  const minLink = opts.min_link_clicks ?? 20;
  const minLpv = opts.min_lpv ?? 20;
  const minAtc = opts.min_atc ?? 5;
  const minCheckout = opts.min_checkout ?? 3;
  const weakPct = opts.weak_conversion_pct ?? 15; // absolute gate for very low transitions

  const link = stages.link_clicks;
  const lpv = stages.landing_page_views;
  const atc = stages.add_to_carts;
  const checkout = stages.checkouts;
  const purchases = stages.purchases;

  if (!(stages.impressions > 0)) {
    return {
      code: null,
      text: null,
      supported: false,
      reason: "no_impressions",
    };
  }

  // Click → LPV break
  if (
    link != null &&
    link >= minLink &&
    rates.link_click_to_lpv_pct != null &&
    rates.link_click_to_lpv_pct < weakPct
  ) {
    return {
      code: "CLICK_TO_LANDING_PROBLEM",
      text: "People are clicking, but few are reaching the product page.",
      supported: true,
      rate: rates.link_click_to_lpv_pct,
    };
  }

  // LPV → ATC break
  if (
    lpv >= minLpv &&
    rates.lpv_to_atc_pct != null &&
    rates.lpv_to_atc_pct < weakPct
  ) {
    return {
      code: "WEAK_PRODUCT_PAGE_CONVERSION",
      text: "Traffic reaches the site, but few visitors add the product to cart.",
      supported: true,
      rate: rates.lpv_to_atc_pct,
    };
  }

  // ATC → checkout break
  if (
    atc >= minAtc &&
    rates.atc_to_checkout_pct != null &&
    rates.atc_to_checkout_pct < weakPct
  ) {
    return {
      code: "WEAK_CHECKOUT_START",
      text: "People add to cart, but few start checkout.",
      supported: true,
      rate: rates.atc_to_checkout_pct,
    };
  }

  // Checkout → purchase break
  if (
    checkout >= minCheckout &&
    rates.checkout_to_purchase_pct != null &&
    rates.checkout_to_purchase_pct < 40
  ) {
    return {
      code: "WEAK_CHECKOUT_CONVERSION",
      text: "Checkout intent is healthy but purchase completion is weak.",
      supported: true,
      rate: rates.checkout_to_purchase_pct,
    };
  }

  // Healthy path (enough volume, no weak stage flagged)
  if (purchases > 0 && lpv >= minLpv) {
    return {
      code: "FUNNEL_INTACT",
      text: "Funnel stages look intact relative to available volume — no clear break identified.",
      supported: true,
      rate: rates.lpv_to_purchase_pct,
    };
  }

  return {
    code: null,
    text: null,
    supported: false,
    reason: "insufficient_stage_volume",
  };
}

module.exports = {
  stageCounts,
  buildFunnel,
  explainFunnel,
  safeDiv,
  pctRatio,
};
