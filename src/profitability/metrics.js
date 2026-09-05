/**
 * Pure profitability / break-even / blended metrics.
 * Meta spend is NEVER treated as an additional Books expense.
 */
const { round2 } = require("../books/tax");
const { safeDiv } = require("../meta/metrics");

const META_SPEND_TREATMENT =
  "analytical_replacement_only_not_additional_expense";

function pctOrNull(numerator, denominator) {
  const r = safeDiv(numerator, denominator);
  return r == null ? null : round2(r * 100);
}

/**
 * Core no-double-count formulas.
 *
 * books_net_profit already subtracts ledger Ads.
 * profit_before_ads adds Ads back; meta_adjusted_profit replaces with Meta spend.
 */
function computeMetaAdjusted({
  books_net_profit,
  ads_expense_booked,
  meta_spend,
  net_revenue_ex_tax,
}) {
  const profit_before_ads = round2(
    Number(books_net_profit || 0) + Number(ads_expense_booked || 0)
  );
  const meta_adjusted_profit = round2(
    profit_before_ads - Number(meta_spend || 0)
  );
  return {
    profit_before_ads,
    meta_adjusted_profit,
    meta_adjusted_margin_pct: pctOrNull(
      meta_adjusted_profit,
      net_revenue_ex_tax
    ),
    meta_spend_treatment: META_SPEND_TREATMENT,
  };
}

function computeBlended({
  net_revenue_ex_tax,
  meta_spend,
  recognized_orders,
  shopify_recognized_orders,
  meta_roas,
}) {
  const { computeAdLoadMetrics } = require("./salesMix");
  const adLoad = computeAdLoadMetrics({
    meta_spend,
    recognized_orders,
    shopify_recognized_orders,
  });

  return {
    blended_mer: safeDiv(net_revenue_ex_tax, meta_spend),
    // Alias kept for Phase 3 compatibility (= business-wide ad load)
    blended_ad_cost_per_recognized_order:
      adLoad.business_wide_ad_load_per_recognized_order,
    business_wide_ad_load_per_recognized_order:
      adLoad.business_wide_ad_load_per_recognized_order,
    shopify_ad_load_per_recognized_order:
      adLoad.shopify_ad_load_per_recognized_order,
    shopify_recognized_orders: Number(shopify_recognized_orders || 0),
    meta_attributed_roas: meta_roas == null ? null : Number(meta_roas),
    no_order_level_attribution: true,
    ad_load_notes: adLoad.notes,
    note:
      "blended_mer = Books net revenue / Meta spend. Not Meta-attributed ROAS. " +
      "business_wide_ad_load_per_recognized_order = Meta spend / all recognized orders (not attributed CAC). " +
      "shopify_ad_load_per_recognized_order = Meta spend / Shopify orders only (context, not CAC).",
  };
}

function computeBreakEven({
  profit_before_ads,
  recognized_orders,
  net_revenue_ex_tax,
}) {
  const pre_ad_profit_margin = safeDiv(profit_before_ads, net_revenue_ex_tax);
  const break_even_ad_spend = round2(Number(profit_before_ads || 0));

  let break_even_cpa = null;
  if (recognized_orders > 0 && profit_before_ads > 0) {
    break_even_cpa = round2(profit_before_ads / recognized_orders);
  }

  let break_even_roas = null;
  if (pre_ad_profit_margin != null && pre_ad_profit_margin > 0) {
    break_even_roas = round2(1 / pre_ad_profit_margin);
  }

  const warnings = [];
  if (profit_before_ads <= 0) {
    warnings.push(
      "profit_before_ads_non_positive — no positive pre-ad profit buffer for the period"
    );
  }

  return {
    break_even_ad_spend,
    break_even_cpa,
    pre_ad_profit_margin:
      pre_ad_profit_margin == null ? null : round2(pre_ad_profit_margin),
    break_even_roas,
    definitions: {
      break_even_ad_spend:
        "profit_before_ads — max Meta spend that leaves meta_adjusted_profit at zero (other costs unchanged)",
      break_even_cpa:
        "profit_before_ads / recognized_orders — blended business-level, not campaign attribution",
      break_even_roas:
        "1 / (profit_before_ads / net_revenue) when pre-ad margin > 0; else null",
    },
    warnings,
  };
}

function buildProfitabilityBundle({
  books,
  meta_spend,
  meta_roas,
}) {
  const adjusted = computeMetaAdjusted({
    books_net_profit: books.books_net_profit,
    ads_expense_booked: books.ads_expense_booked,
    meta_spend,
    net_revenue_ex_tax: books.net_revenue_ex_tax,
  });
  const blended = computeBlended({
    net_revenue_ex_tax: books.net_revenue_ex_tax,
    meta_spend,
    recognized_orders: books.recognized_orders,
    shopify_recognized_orders: books.shopify_recognized_orders,
    meta_roas,
  });
  const be = computeBreakEven({
    profit_before_ads: adjusted.profit_before_ads,
    recognized_orders: books.recognized_orders,
    net_revenue_ex_tax: books.net_revenue_ex_tax,
  });

  // Round blended ratios for JSON stability
  if (blended.blended_mer != null) {
    blended.blended_mer = round2(blended.blended_mer);
  }
  if (blended.blended_ad_cost_per_recognized_order != null) {
    blended.blended_ad_cost_per_recognized_order = round2(
      blended.blended_ad_cost_per_recognized_order
    );
  }
  if (blended.business_wide_ad_load_per_recognized_order != null) {
    blended.business_wide_ad_load_per_recognized_order = round2(
      blended.business_wide_ad_load_per_recognized_order
    );
  }
  if (blended.shopify_ad_load_per_recognized_order != null) {
    blended.shopify_ad_load_per_recognized_order = round2(
      blended.shopify_ad_load_per_recognized_order
    );
  }

  return {
    profitability: {
      ...adjusted,
      break_even_ad_spend: be.break_even_ad_spend,
      break_even_cpa: be.break_even_cpa,
      pre_ad_profit_margin: be.pre_ad_profit_margin,
      break_even_roas: be.break_even_roas,
      definitions: be.definitions,
    },
    blended,
    break_even_warnings: be.warnings,
  };
}

module.exports = {
  META_SPEND_TREATMENT,
  computeMetaAdjusted,
  computeBlended,
  computeBreakEven,
  buildProfitabilityBundle,
  pctOrNull,
};
