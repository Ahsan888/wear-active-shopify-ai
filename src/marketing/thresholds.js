/**
 * Phase 9 marketing decision thresholds.
 * Reuses Phase 3 entity/business ratios — does not redefine CPA/ROAS/BE CPA.
 */
const {
  ENTITY_ZERO_PURCHASE,
  ENTITY_WITH_PURCHASES,
  FUNNEL,
  BUSINESS_ADS,
} = require("../decisions/thresholds");

const MARKETING = {
  // Evidence confidence
  MIN_SPEND_FOR_MEDIUM: 5000,
  MIN_PURCHASES_FOR_MEDIUM: 3,
  MIN_SPEND_FOR_HIGH: 15000,
  MIN_PURCHASES_FOR_HIGH: 8,
  FP_COVERAGE_MEDIUM_GTE: 70,
  FP_POST_CAPTURE_ORDERS_MEDIUM_GTE: 10,

  // Priority scoring weights (deterministic, not ML)
  PRIORITY: {
    P1_MIN: 70,
    P2_MIN: 45,
    P3_MIN: 25,
  },

  // Period consistency
  WEAK_STATUSES: new Set([
    "high_cpa",
    "relatively_weak_cpa",
    "high_priority_spend_no_purchase",
    "spend_no_purchase",
    "weak_funnel",
  ]),
  STRONG_STATUSES: new Set(["scale_candidate", "strong"]),

  QUEUE_TOP_N: 10,

  STOCKOUT_CLASSES: new Set(["OUT_OF_STOCK", "CRITICAL", "LOW"]),
  PROMO_PRICING: new Set(["PROMOTION_CANDIDATE", "CLEARANCE_CANDIDATE"]),
};

module.exports = {
  MARKETING,
  ENTITY_ZERO_PURCHASE,
  ENTITY_WITH_PURCHASES,
  FUNNEL,
  BUSINESS_ADS,
};
