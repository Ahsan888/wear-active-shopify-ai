/**
 * Marketing evidence confidence + first-party maturity (Phase 9).
 * Three economic layers stay separate — this only scores evidence weight.
 */
const { MARKETING } = require("./thresholds");

function rankConfidence(level) {
  const order = { insufficient: 0, low: 1, medium: 2, high: 3 };
  return order[level] ?? 0;
}

/**
 * Cap confidence at a maximum level.
 */
function capConfidence(level, maxLevel) {
  if (rankConfidence(level) <= rankConfidence(maxLevel)) return level;
  return maxLevel;
}

/**
 * Account / period marketing evidence confidence.
 */
function assessMarketingEvidence(input = {}) {
  const metaSpend = Number(input.meta_spend) || 0;
  const metaPurchases = Number(input.meta_purchases) || 0;
  const fpCoverage = input.fp_attributed_coverage_pct;
  const fpOrders = Number(input.fp_post_capture_orders) || 0;
  const booksOrders = Number(input.books_recognized_orders) || 0;
  const cogsOk = input.cogs_complete !== false;
  const warnings = [...(input.warnings || [])];

  let level = "insufficient";
  if (metaSpend > 0 || metaPurchases > 0 || booksOrders > 0) {
    level = "low";
  }
  if (
    metaSpend >= MARKETING.MIN_SPEND_FOR_MEDIUM &&
    metaPurchases >= MARKETING.MIN_PURCHASES_FOR_MEDIUM &&
    booksOrders >= 3
  ) {
    level = "medium";
  }
  if (
    metaSpend >= MARKETING.MIN_SPEND_FOR_HIGH &&
    metaPurchases >= MARKETING.MIN_PURCHASES_FOR_HIGH &&
    booksOrders >= 10 &&
    cogsOk
  ) {
    level = "high";
  }

  // Phase 5 capture recently started — FP weight LOW/INSUFFICIENT by default
  const fpMature =
    fpCoverage != null &&
    Number(fpCoverage) >= MARKETING.FP_COVERAGE_MEDIUM_GTE &&
    fpOrders >= MARKETING.FP_POST_CAPTURE_ORDERS_MEDIUM_GTE;

  const fp_evidence = {
    status: fpMature ? "usable" : fpOrders > 0 ? "immature" : "insufficient",
    attributed_coverage_pct: fpCoverage == null ? null : Number(fpCoverage),
    post_capture_orders: fpOrders,
    note: fpMature
      ? "First-party attributed economics may inform diagnostics."
      : "First-party attribution immature — Meta decisions use platform evidence; FP not treated as verified.",
  };

  if (!fpMature) {
    warnings.push("ATTRIBUTION_IMMATURE");
    // Do not force overall evidence below low solely due to FP — Meta can still decide
  }

  if (!cogsOk) warnings.push("DATA_QUALITY_BLOCK");
  if (input.meta_fetch_failed) {
    level = "insufficient";
    warnings.push("META_DATA_FAILURE");
  }

  return {
    marketing_evidence_confidence: level,
    fp_evidence,
    fp_immature: !fpMature,
    warnings,
    layers: {
      business_affordability: "books_orders_vs_break_even_cpa",
      meta_platform: "meta_reported_cpa_roas_funnel",
      first_party_attributed: "phase_5b_post_capture_only",
    },
  };
}

/**
 * Per-entity confidence from spend/purchases + period consistency.
 */
function entityEvidenceConfidence(entity, periodConsistency, opts = {}) {
  const spend = Number(entity?.spend) || 0;
  const purchases = Number(entity?.purchases) || 0;
  let level = "insufficient";
  if (spend > 0) level = "low";
  if (
    spend >= MARKETING.MIN_SPEND_FOR_MEDIUM / 5 ||
    purchases >= MARKETING.MIN_PURCHASES_FOR_MEDIUM
  ) {
    level = "medium";
  }
  if (
    spend >= MARKETING.MIN_SPEND_FOR_MEDIUM &&
    purchases >= MARKETING.MIN_PURCHASES_FOR_MEDIUM
  ) {
    level = "high";
  }

  // Raise confidence when pattern repeats across periods
  if (periodConsistency?.strong_period_count >= 2 && level !== "insufficient") {
    if (level === "medium") level = "high";
    else if (level === "low") level = "medium";
  }
  if (periodConsistency?.weak_period_count >= 2 && level !== "insufficient") {
    if (level === "medium") level = "high";
    else if (level === "low") level = "medium";
  }

  if (opts.fp_immature) {
    // Cap presentation: Meta not FP-verified
    // Keep decision confidence but note — do not force insufficient
  }
  if (opts.data_quality_block) {
    level = capConfidence(level, "low");
  }
  return level;
}

module.exports = {
  assessMarketingEvidence,
  entityEvidenceConfidence,
  rankConfidence,
  capConfidence,
};
