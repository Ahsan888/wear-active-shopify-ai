/**
 * Account-level marketing recommendation (Phase 9).
 */
const { isBusinessProfitableEnoughForScale } = require("../decisions/business");
const { isBusinessAdsSafeForScale } = require("../decisions/advertising");

function classifyAccountMarketingDecision({
  business_health,
  business_advertising_safety,
  meta_efficiency,
  evidence,
  entityActions = [],
} = {}) {
  const bh = business_health?.status;
  const ads = business_advertising_safety?.status;
  const reason_codes = [];
  const warnings = [];

  if (evidence?.fp_immature) {
    warnings.push("ATTRIBUTION_IMMATURE");
    reason_codes.push("ATTRIBUTION_IMMATURE");
  }

  const scaleCount = entityActions.filter((a) => a.primary_action === "SCALE")
    .length;
  const pauseCount = entityActions.filter((a) => a.primary_action === "PAUSE")
    .length;
  const reduceCount = entityActions.filter((a) => a.primary_action === "REDUCE")
    .length;

  let recommendation = "HOLD_SPEND";
  let confidence = evidence?.marketing_evidence_confidence || "low";

  if (
    bh === "insufficient_data" ||
    ads === "insufficient_data" ||
    evidence?.marketing_evidence_confidence === "insufficient"
  ) {
    recommendation = "INSUFFICIENT_DATA";
    reason_codes.push("INSUFFICIENT_SPEND");
    confidence = "insufficient";
  } else if (bh === "unprofitable" || ads === "above_break_even") {
    recommendation = "DEFENSIVE_MODE";
    reason_codes.push(
      ads === "above_break_even"
        ? "BLENDED_ABOVE_BREAK_EVEN"
        : "BUSINESS_UNPROFITABLE"
    );
    confidence = "high";
  } else if (ads === "near_break_even" || bh === "thin_margin") {
    recommendation = "REDUCE_SPEND";
    reason_codes.push("NEAR_BREAK_EVEN_OR_THIN_MARGIN");
  } else if (
    isBusinessProfitableEnoughForScale(bh) &&
    isBusinessAdsSafeForScale(ads) &&
    scaleCount > 0 &&
    pauseCount === 0
  ) {
    recommendation = "SCALE_CAUTIOUSLY";
    reason_codes.push("BUSINESS_PROFITABLE");
    if (ads === "large_safety_margin") reason_codes.push("LARGE_AD_SAFETY_MARGIN");
  } else if (
    (ads === "near_break_even" || bh === "thin_margin" || pauseCount >= 3) &&
    reduceCount + pauseCount > scaleCount
  ) {
    recommendation = "REDUCE_SPEND";
    reason_codes.push("REPEATED_WEAK_PERFORMANCE");
  } else {
    recommendation = "HOLD_SPEND";
    reason_codes.push("HOLD_NEUTRAL");
    if (isBusinessProfitableEnoughForScale(bh)) {
      reason_codes.push("BUSINESS_PROFITABLE");
    }
    if (ads === "large_safety_margin") {
      reason_codes.push("LARGE_AD_SAFETY_MARGIN");
    }
  }

  return {
    recommendation,
    confidence,
    reason_codes: [...new Set(reason_codes)],
    warnings: [...new Set(warnings)],
    business_health: bh || null,
    business_advertising_safety: ads || null,
    meta_platform: {
      spend: meta_efficiency?.meta_spend ?? null,
      cpa: meta_efficiency?.meta_attributed_cpa ?? null,
      roas: meta_efficiency?.meta_attributed_roas ?? null,
      purchases: meta_efficiency?.meta_attributed_purchases ?? null,
      note: "Meta-reported platform metrics only — not FP verified.",
    },
    entity_action_counts: {
      scale: scaleCount,
      pause: pauseCount,
      reduce: reduceCount,
    },
    guidance:
      recommendation === "SCALE_CAUTIOUSLY"
        ? "Consider small scale tests on strong entities only — no automatic budget changes."
        : recommendation === "DEFENSIVE_MODE"
          ? "Protect margin — review high-spend weak entities before any increase."
          : recommendation === "REDUCE_SPEND"
            ? "Reduce pressure on weak entities; do not increase account spend."
            : "Hold overall spend posture; act on the entity queue (reduce/pause/creative as listed).",
    advisory_only: true,
    no_exact_budget: true,
  };
}

module.exports = {
  classifyAccountMarketingDecision,
};
