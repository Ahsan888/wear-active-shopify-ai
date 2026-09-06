/**
 * Deterministic marketing action classification (Phase 9).
 * Orchestrates Phase 3 entity status + inventory/pricing + period consistency.
 * No LLM. No budget math. Advisory only.
 *
 * REPEATED_* codes and REDUCE→PAUSE / STRONG_SCALE / confidence HIGH persistence
 * require independent non-overlapping period evidence — not overlapping 7/14/30.
 */
const { isBusinessProfitableEnoughForScale } = require("../decisions/business");
const { isBusinessAdsSafeForScale } = require("../decisions/advertising");
const { ENTITY_ZERO_PURCHASE, ENTITY_WITH_PURCHASES } = require("./thresholds");
const { entityEvidenceConfidence } = require("./evidence");
const { resolveInventoryMarketingContext } = require("./inventoryContext");
const {
  hasIndependentRepeatedWeakness,
  hasIndependentRepeatedStrength,
} = require("./periods");

function creativeTestFromFunnel(entity) {
  const diags = entity.funnel_diagnostics || [];
  const ctrWeak = diags.find((d) => d.code === "creative_click_weak");
  const downstream = diags.filter((d) => d.code !== "creative_click_weak");

  if (ctrWeak) {
    return {
      action: "CREATIVE_TEST",
      creative_test_reason: "LOW_CTR",
      reason_codes: ["WEAK_CTR"],
    };
  }

  if (downstream.length && !ctrWeak) {
    return {
      action: null,
      creative_test_reason: "STRONG_CLICK_WEAK_CONVERSION",
      reason_codes: ["WEAK_FUNNEL"],
      note: "Downstream conversion weak — landing/offer/pricing/checkout may be cause; not creative-only.",
    };
  }

  if (entity.has_funnel_warning) {
    return {
      action: null,
      creative_test_reason: "INSUFFICIENT_FUNNEL_DATA",
      reason_codes: ["WEAK_FUNNEL"],
    };
  }

  return null;
}

/**
 * STRONG_SCALE requires independent repeated strength.
 * Trailing overlap may support MODERATE_SCALE context only.
 */
function scaleStrength(periodConsistency, adsStatus) {
  const independentStrong = hasIndependentRepeatedStrength(periodConsistency);
  const trailingStrong =
    Number(
      periodConsistency?.trailing_window_consistency
        ?.strong_trailing_window_count ??
        periodConsistency?.strong_trailing_window_count
    ) || 0;

  if (independentStrong && adsStatus === "large_safety_margin") {
    return "STRONG_SCALE";
  }
  if (independentStrong) return "MODERATE_SCALE";
  if (trailingStrong >= 2) return "MODERATE_SCALE";
  return "TEST_SCALE";
}

function emptyPeriodConsistency() {
  return {
    trailing_direction: "INSUFFICIENT",
    strong_trailing_window_count: 0,
    weak_trailing_window_count: 0,
    trailing_window_consistency: {
      trailing_direction: "INSUFFICIENT",
      strong_trailing_window_count: 0,
      weak_trailing_window_count: 0,
    },
    independent_period_evidence: {
      available: false,
      independent_periods_compared: null,
      independent_strong_period_count: null,
      independent_weak_period_count: null,
    },
  };
}

/**
 * Classify one Phase-3-classified Meta entity into Phase 9 actions.
 */
function classifyMarketingEntity(entity, ctx = {}) {
  const reason_codes = [];
  const constraints = [];
  const warnings = [];
  const business_health = ctx.business_health || {};
  const ads_safety = ctx.business_advertising_safety || {};
  const period = entity.period_consistency || emptyPeriodConsistency();

  const independentRepeatedWeak = hasIndependentRepeatedWeakness(period);
  const independentRepeatedStrong = hasIndependentRepeatedStrength(period);

  if (ctx.fp_immature) {
    warnings.push("ATTRIBUTION_IMMATURE");
    warnings.push("META_NOT_FP_VERIFIED");
  }

  const inv = resolveInventoryMarketingContext(entity, ctx);
  for (const c of inv.reason_codes || []) {
    if (c !== "INVENTORY_MAPPING_UNAVAILABLE") {
      reason_codes.push(c);
      if (c === "INVENTORY_LIMITED") constraints.push("INVENTORY_LIMITED");
    }
  }

  const businessOk = isBusinessProfitableEnoughForScale(business_health.status);
  const adsOk = isBusinessAdsSafeForScale(ads_safety.status);
  const defensive =
    ads_safety.status === "above_break_even" ||
    ads_safety.status === "near_break_even" ||
    business_health.status === "unprofitable";

  if (businessOk) reason_codes.push("BUSINESS_PROFITABLE");
  if (ads_safety.status === "large_safety_margin") {
    reason_codes.push("LARGE_AD_SAFETY_MARGIN");
  }
  if (defensive) {
    constraints.push("BUSINESS_AD_PRESSURE");
  }

  const ratio = entity.entity_cpa_vs_account_ratio;
  if (ratio != null && ratio <= ENTITY_WITH_PURCHASES.STRONG_CPA_LTE) {
    reason_codes.push("CPA_BELOW_ACCOUNT");
  }
  if (
    entity.entity_roas_vs_account_ratio != null &&
    entity.entity_roas_vs_account_ratio >=
      ENTITY_WITH_PURCHASES.SCALE_MIN_ROAS_X_ACCOUNT
  ) {
    reason_codes.push("ROAS_ABOVE_ACCOUNT");
  }

  // REPEATED_* only from independent non-overlapping buckets
  if (independentRepeatedStrong) {
    reason_codes.push("REPEATED_STRONG_PERFORMANCE");
  }
  if (independentRepeatedWeak) {
    reason_codes.push("REPEATED_WEAK_PERFORMANCE");
  }

  let primary_action = "MONITOR";
  let secondary_action = null;
  let scale_strength = null;
  let creative_test_reason = null;

  const status = entity.status;
  const spendX = entity.spend_vs_account_cpa;
  const purchases = Number(entity.purchases) || 0;

  if (status === "insufficient_data") {
    primary_action = "INSUFFICIENT_DATA";
    reason_codes.push("INSUFFICIENT_SPEND");
  } else if (status === "watch") {
    primary_action = "MONITOR";
    reason_codes.push("INSUFFICIENT_PURCHASES");
  } else if (status === "high_priority_spend_no_purchase") {
    // Direct spend-evidence rule — PAUSE immediately (not persistence-based)
    primary_action = "PAUSE";
    reason_codes.push("ZERO_PURCHASE_SPEND");
  } else if (status === "spend_no_purchase") {
    if (spendX != null && spendX >= ENTITY_ZERO_PURCHASE.WATCH_LT) {
      primary_action = "REDUCE";
      reason_codes.push("ZERO_PURCHASE_SPEND");
    } else {
      primary_action = "MONITOR";
      reason_codes.push("INSUFFICIENT_PURCHASES");
    }
  } else if (status === "high_cpa") {
    // Persistence escalation requires independent repeated weakness
    if (independentRepeatedWeak && purchases >= 3) {
      primary_action = "PAUSE";
      reason_codes.push("CPA_ABOVE_ACCOUNT");
    } else {
      primary_action = "REDUCE";
      reason_codes.push("CPA_ABOVE_ACCOUNT");
    }
  } else if (status === "relatively_weak_cpa") {
    primary_action = "REDUCE";
    reason_codes.push("CPA_ABOVE_ACCOUNT");
  } else if (status === "weak_funnel") {
    const creative = creativeTestFromFunnel(entity);
    if (creative?.action === "CREATIVE_TEST") {
      primary_action = "CREATIVE_TEST";
      creative_test_reason = creative.creative_test_reason;
      reason_codes.push(...(creative.reason_codes || []));
    } else {
      primary_action = "HOLD";
      creative_test_reason = creative?.creative_test_reason || null;
      reason_codes.push("WEAK_FUNNEL");
      if (creative?.note) warnings.push(creative.note);
    }
  } else if (status === "scale_candidate" || entity.scale_eligible) {
    if (inv.suppress_scale) {
      primary_action = "HOLD";
      constraints.push("INVENTORY_LIMITED");
      reason_codes.push("INVENTORY_LIMITED");
    } else if (defensive || !businessOk || !adsOk) {
      primary_action = "HOLD";
      reason_codes.push("DATA_QUALITY_BLOCK");
      constraints.push("SCALE_SUPPRESSED_BY_BUSINESS");
    } else if (ctx.data_quality_blocks_scale) {
      primary_action = "HOLD";
      reason_codes.push("DATA_QUALITY_BLOCK");
      constraints.push("DATA_QUALITY_BLOCK");
    } else {
      primary_action = "SCALE";
      scale_strength = scaleStrength(period, ads_safety.status);
      reason_codes.push("CONTROLLED_SCALE_CANDIDATE");
    }
  } else if (status === "strong" || status === "healthy") {
    const creative = creativeTestFromFunnel(entity);
    if (creative?.action === "CREATIVE_TEST" && status === "healthy") {
      primary_action = "CREATIVE_TEST";
      creative_test_reason = creative.creative_test_reason;
      reason_codes.push(...(creative.reason_codes || []));
    } else {
      primary_action = "HOLD";
    }
  } else {
    primary_action = "MONITOR";
  }

  if (
    inv.promotion_eligible &&
    !["PAUSE"].includes(primary_action) &&
    status !== "high_priority_spend_no_purchase" &&
    status !== "high_cpa"
  ) {
    secondary_action = "PROMOTION_TEST";
    reason_codes.push("PROMOTION_MARGIN_AVAILABLE");
  }

  if (inv.immature_for_clearance && secondary_action === "PROMOTION_TEST") {
    secondary_action = null;
  }

  let confidence = entityEvidenceConfidence(entity, period, {
    fp_immature: ctx.fp_immature,
    data_quality_block: ctx.data_quality_blocks_scale,
  });

  // Confidence HIGH from persistence only with independent repeated evidence
  if (primary_action === "SCALE" && independentRepeatedStrong) {
    if (confidence === "medium") confidence = "high";
    if (confidence === "low") confidence = "medium";
  }
  if (
    (primary_action === "REDUCE" || primary_action === "PAUSE") &&
    independentRepeatedWeak
  ) {
    if (confidence === "medium") confidence = "high";
    if (confidence === "low") confidence = "medium";
  }

  if (primary_action === "SCALE" && inv.inventory_action === "UNKNOWN") {
    if (confidence === "high") confidence = "medium";
    warnings.push("INVENTORY_MAPPING_UNAVAILABLE");
  }

  const guidance =
    primary_action === "SCALE"
      ? scale_strength === "STRONG_SCALE"
        ? "controlled budget increase"
        : "small scale test"
      : null;

  return {
    entity_type: entity.entity_type,
    entity_id: entity.entity_id,
    entity_name: entity.entity_name,
    meta_status: status,
    spend: entity.spend,
    purchases: entity.purchases,
    meta_cpa: entity.meta_attributed_cpa,
    meta_roas: entity.meta_attributed_roas,
    entity_cpa_vs_account_ratio: entity.entity_cpa_vs_account_ratio,
    spend_vs_account_cpa: entity.spend_vs_account_cpa,
    primary_action,
    secondary_action,
    scale_strength,
    scale_guidance: guidance,
    creative_test_reason,
    confidence,
    reason_codes: [...new Set(reason_codes)],
    constraints: [...new Set(constraints)],
    warnings: [...new Set(warnings)],
    period_consistency: period,
    inventory: {
      inventory_action: inv.inventory_action,
      stock_class: inv.stock_class,
      pricing_recommendation: inv.pricing_recommendation,
      recommended_discount_pct: inv.recommended_discount_pct,
      inventory_capital: inv.inventory_capital,
      mapping: inv.mapping,
    },
    attribution_note: ctx.fp_immature
      ? "meta_platform_only_fp_immature"
      : "meta_platform_with_fp_context",
    advisory_only: true,
    no_budget_automation: true,
  };
}

function classifyMarketingEntities(entities, ctx) {
  return (entities || []).map((e) => classifyMarketingEntity(e, ctx));
}

module.exports = {
  classifyMarketingEntity,
  classifyMarketingEntities,
  creativeTestFromFunnel,
  scaleStrength,
};
