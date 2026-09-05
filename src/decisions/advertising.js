/**
 * Business advertising safety (blended) vs Meta attributed platform efficiency.
 * These MUST stay separate — Meta CPA ≠ Books break-even CPA denominators.
 */
const { round2 } = require("../books/tax");
const { safeDiv } = require("../meta/metrics");
const { BUSINESS, BUSINESS_ADS } = require("./thresholds");

function pctOrNull(numerator, denominator) {
  const r = safeDiv(numerator, denominator);
  return r == null ? null : round2(r * 100);
}

/**
 * Primary period-level advertising economics (same Books order denominator).
 */
function classifyBusinessAdvertisingSafety({
  meta_spend,
  recognized_orders,
  break_even_cpa,
  break_even_ad_spend,
  net_revenue_ex_tax,
  blended_ad_cost_per_recognized_order: blendedIn,
} = {}) {
  const spend = Number(meta_spend || 0);
  const orders = Number(recognized_orders || 0);
  const beCpa =
    break_even_cpa == null || !(Number(break_even_cpa) > 0)
      ? null
      : Number(break_even_cpa);
  const beSpend =
    break_even_ad_spend == null ? null : Number(break_even_ad_spend);
  const net = Number(net_revenue_ex_tax || 0);

  const blended =
    blendedIn != null
      ? Number(blendedIn)
      : orders > 0
        ? round2(spend / orders)
        : null;

  const business_cpa_headroom =
    beCpa != null && blended != null ? round2(beCpa - blended) : null;
  const business_cpa_headroom_pct =
    beCpa != null && blended != null && beCpa > 0
      ? round2(((beCpa - blended) / beCpa) * 100)
      : null;
  const ad_spend_utilization_pct =
    beSpend != null && beSpend > 0 ? pctOrNull(spend, beSpend) : null;

  const base = {
    blended_ad_cost_per_recognized_order: blended,
    break_even_cpa: beCpa,
    business_cpa_headroom,
    business_cpa_headroom_pct,
    ad_spend_utilization_pct,
    meta_spend: round2(spend),
    recognized_orders: orders,
    comparison_type: "blended_meta_spend_per_books_order_vs_break_even_cpa",
    note:
      "Uses Books recognized-order denominator for both blended ad cost and break-even CPA. Not Meta attributed CPA.",
  };

  if (
    orders < BUSINESS.MIN_ORDERS_INSUFFICIENT ||
    beCpa == null ||
    !(beCpa > 0) ||
    net <= 0
  ) {
    return {
      status: "insufficient_data",
      reason_code: "insufficient_orders_or_break_even",
      reason:
        orders < BUSINESS.MIN_ORDERS_INSUFFICIENT
          ? "Too few recognized orders for business CPA safety"
          : beCpa == null || !(beCpa > 0)
            ? "break_even_cpa missing or non-positive"
            : "No usable net revenue",
      ...base,
    };
  }

  const h = business_cpa_headroom_pct;
  let status;
  let reason_code;
  if (h >= BUSINESS_ADS.HEADROOM_LARGE_GTE) {
    status = "large_safety_margin";
    reason_code = "business_cpa_headroom_large";
  } else if (h >= BUSINESS_ADS.HEADROOM_HEALTHY_GTE) {
    status = "healthy";
    reason_code = "business_cpa_headroom_healthy";
  } else if (h >= BUSINESS_ADS.HEADROOM_MODERATE_GTE) {
    status = "moderate";
    reason_code = "business_cpa_headroom_moderate";
  } else if (h >= BUSINESS_ADS.HEADROOM_NEAR_GTE) {
    status = "near_break_even";
    reason_code = "business_cpa_headroom_near_zero";
  } else {
    status = "above_break_even";
    reason_code = "blended_ad_cost_above_break_even_cpa";
  }

  return {
    status,
    reason_code,
    reason: `Business CPA headroom ${h}% (blended ${blended} vs BE CPA ${beCpa})`,
    ...base,
  };
}

/**
 * Platform Meta efficiency — separate from business advertising safety.
 */
function buildMetaEfficiency(metaTotals = {}) {
  const spend = Number(metaTotals.spend || 0);
  if (!(spend > 0)) {
    return {
      status: "insufficient_data",
      reason_code: "zero_meta_spend",
      meta_attributed_cpa: null,
      meta_attributed_roas: null,
      meta_attributed_purchases: Number(metaTotals.purchases || 0),
      meta_spend: 0,
      note: "Meta attributed platform metrics only — not business CAC.",
    };
  }
  return {
    status: "ok",
    meta_attributed_cpa:
      metaTotals.cpa == null ? null : Number(metaTotals.cpa),
    meta_attributed_roas:
      metaTotals.roas == null ? null : Number(metaTotals.roas),
    meta_attributed_purchases: Number(metaTotals.purchases || 0),
    meta_spend: round2(spend),
    purchase_value: Number(metaTotals.purchase_value || 0),
    note: "Meta attributed platform metrics only — not business CAC.",
  };
}

/**
 * Cross-provenance ROAS diagnostic — MUST NOT flip advertising health alone.
 */
function buildRoasCrossProvenanceDiagnostic({
  meta_roas,
  break_even_roas,
  meta_adjusted_profit,
} = {}) {
  const mr = meta_roas == null ? null : Number(meta_roas);
  const be = break_even_roas == null ? null : Number(break_even_roas);
  const ratio =
    mr != null && be != null && be > 0 ? round2(mr / be) : null;
  const contradictory =
    ratio != null &&
    ratio < 0.5 &&
    Number(meta_adjusted_profit || 0) > 0;

  return {
    label: "cross_provenance_diagnostic",
    meta_roas: mr,
    break_even_roas: be,
    roas_safety_ratio: ratio,
    contradictory_with_meta_adjusted_profit: contradictory,
    warning: contradictory
      ? "Meta ROAS is far below Books break-even ROAS while Meta-adjusted profit is positive — do not treat ROAS gap as business unprofitability (different populations)."
      : null,
    note:
      "Compares Meta attributed purchase value/spend to Books blended break-even ROAS. Not attributable order-level profit.",
  };
}

function isBusinessAdsSafeForScale(status) {
  return (
    status === "large_safety_margin" ||
    status === "healthy" ||
    status === "moderate"
  );
}

module.exports = {
  classifyBusinessAdvertisingSafety,
  buildMetaEfficiency,
  buildRoasCrossProvenanceDiagnostic,
  isBusinessAdsSafeForScale,
};
