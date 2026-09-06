/**
 * First-party observed new-customer CAC and observed GP:CAC.
 * Denominator is post_capture Meta first-party new customers only.
 */
const { round2 } = require("../books/tax");

function isFpCacEligible(c, periodSince, periodUntil) {
  return (
    Boolean(c?.identified) &&
    c.first_order_date >= periodSince &&
    c.first_order_date <= periodUntil &&
    c.first_order_acquisition === "Meta" &&
    c.first_order_attribution_phase === "post_capture"
  );
}

/**
 * @param {object} opts
 * @param {object[]} opts.customers - observed customer values (identified)
 * @param {string} opts.periodSince
 * @param {string} opts.periodUntil
 * @param {number} opts.metaSpendTotal - Meta spend for the analysis period
 * @param {number|null} opts.attributionCoveragePct - Phase 5 post-capture attributed coverage
 */
function buildObservedCac(opts = {}) {
  const {
    customers = [],
    periodSince,
    periodUntil,
    metaSpendTotal = 0,
    attributionCoveragePct = null,
  } = opts;

  const metaNew = customers.filter((c) =>
    isFpCacEligible(c, periodSince, periodUntil)
  );

  // Diagnostic: Meta acquisition in period but pre_capture (excluded from CAC)
  const preCaptureMetaNew = customers.filter(
    (c) =>
      c.identified &&
      c.first_order_date >= periodSince &&
      c.first_order_date <= periodUntil &&
      c.first_order_acquisition === "Meta" &&
      c.first_order_attribution_phase === "pre_capture"
  );

  const denom = metaNew.length;
  const spend = Number(metaSpendTotal) || 0;
  // Zero eligible → null (not 0)
  const cac = denom > 0 ? round2(spend / denom) : null;

  const observedGp = metaNew.reduce(
    (s, c) => s + (Number(c.lifetime_gp) || 0),
    0
  );
  const observedRev = metaNew.reduce(
    (s, c) => s + (Number(c.lifetime_recognized_revenue) || 0),
    0
  );
  const observedOrders = metaNew.reduce(
    (s, c) => s + (Number(c.recognized_orders) || 0),
    0
  );

  const gpPerCustomer = denom > 0 ? round2(observedGp / denom) : null;
  const revPerCustomer = denom > 0 ? round2(observedRev / denom) : null;
  const ordersPerCustomer = denom > 0 ? round2(observedOrders / denom) : null;

  const observedGpCac =
    cac != null && cac > 0 && gpPerCustomer != null
      ? round2(gpPerCustomer / cac)
      : null;
  const observedRevCac =
    cac != null && cac > 0 && revPerCustomer != null
      ? round2(revPerCustomer / cac)
      : null;

  const firstOrderGp = metaNew.reduce(
    (s, c) => s + (Number(c.first_order_gp) || 0),
    0
  );
  const firstOrderGpAfterCac =
    denom > 0 && cac != null
      ? round2(firstOrderGp / denom - cac)
      : null;

  let confidence = "insufficient";
  if (denom >= 30 && attributionCoveragePct != null && attributionCoveragePct >= 50) {
    confidence = "high";
  } else if (denom >= 15 && attributionCoveragePct != null && attributionCoveragePct >= 40) {
    confidence = "medium";
  } else if (denom >= 5) {
    confidence = "low";
  } else {
    confidence = "insufficient";
  }

  // Low / missing Phase 5 coverage caps confidence
  if (attributionCoveragePct == null) {
    if (confidence === "high" || confidence === "medium") confidence = "low";
    if (denom < 5) confidence = "insufficient";
  } else if (attributionCoveragePct < 25) {
    if (confidence !== "insufficient") confidence = "low";
    if (denom < 5) confidence = "insufficient";
  } else if (attributionCoveragePct < 40 && confidence === "high") {
    confidence = "medium";
  }

  return {
    label: "FIRST-PARTY OBSERVED NEW-CUSTOMER CAC",
    definition:
      "Period Meta spend ÷ identified customers whose first recognized order in period is post_capture with first-party Meta acquisition. Pre-capture journey Meta is excluded from this denominator.",
    meta_spend: round2(spend),
    meta_new_customers: denom,
    post_capture_meta_new_customers: denom,
    pre_capture_meta_new_customers_excluded: preCaptureMetaNew.length,
    first_party_observed_new_customer_cac: cac,
    observed_revenue_per_customer: revPerCustomer,
    observed_gp_per_customer: gpPerCustomer,
    observed_orders_per_customer: ordersPerCustomer,
    observed_revenue_cac_ratio: observedRevCac,
    observed_gp_cac_ratio: observedGpCac,
    observed_gp_cac_label: "OBSERVED GP:CAC",
    first_order_gp_after_observed_cac: firstOrderGpAfterCac,
    attribution_coverage_pct: attributionCoveragePct,
    confidence,
    notes: [
      "Not LTV:CAC — customer history is incomplete (observed value only).",
      "Does not mix Books customer counts with Meta-reported purchases.",
      "Unattributed / organic / pre_capture Meta customers are not in the CAC denominator.",
      "Observed GP:CAC and first_order_gp_after_observed_cac use the same post_capture-only set.",
    ],
  };
}

module.exports = {
  buildObservedCac,
  isFpCacEligible,
};
