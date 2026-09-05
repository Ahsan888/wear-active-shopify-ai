/**
 * Named decision thresholds — tune here without hunting through classifiers.
 * All percentages are in percent units unless noted (e.g. 40 = 40%).
 */

/** Business health */
const BUSINESS = {
  MIN_ORDERS_INSUFFICIENT: 3,
  MIN_ORDERS_PROFITABLE: 5,
  MIN_ORDERS_STRONG: 10,
  META_ADJ_MARGIN_BREAK_EVEN_LT: 3,
  META_ADJ_MARGIN_THIN_LT: 10,
  META_ADJ_MARGIN_PROFITABLE_GTE: 10,
  META_ADJ_MARGIN_STRONG_GTE: 15,
  GROSS_MARGIN_PROFITABLE_GTE: 20,
  GROSS_MARGIN_STRONG_GTE: 25,
};

/**
 * Business advertising safety — blended Meta spend / Books recognized orders
 * vs break_even_cpa (same Books order denominator). NOT Meta attributed CPA.
 */
const BUSINESS_ADS = {
  HEADROOM_LARGE_GTE: 40,
  HEADROOM_HEALTHY_GTE: 20,
  HEADROOM_MODERATE_GTE: 10,
  HEADROOM_NEAR_GTE: 0,
};

/** Meta entity zero-purchase evidence vs account Meta CPA */
const ENTITY_ZERO_PURCHASE = {
  INSUFFICIENT_LT: 0.25,
  WATCH_LT: 0.75,
  SPEND_NO_PURCHASE_LT: 1.25,
  // >= 1.25 → high_priority_spend_no_purchase
};

/** Meta entity with purchases vs account Meta CPA / ROAS */
const ENTITY_WITH_PURCHASES = {
  HIGH_CPA_GT: 1.25,
  RELATIVELY_WEAK_CPA_GT: 1.1,
  STRONG_CPA_LTE: 0.85,
  STRONG_MIN_PURCHASES: 2,
  SCALE_MIN_PURCHASES: 3,
  SCALE_MIN_SPEND_X_ACCOUNT_CPA: 1.0,
  SCALE_MAX_CPA_X_ACCOUNT: 0.85,
  SCALE_MIN_ROAS_X_ACCOUNT: 1.1,
};

/** Funnel relative weakness + volume gates */
const FUNNEL = {
  WEAK_RELATIVE_LT: 0.6,
  CTR_MIN_IMPRESSIONS: 1000,
  CLICK_LPV_MIN_LINK_CLICKS: 30,
  LPV_ATC_MIN_LPV: 40,
  ATC_IC_MIN_ATC: 5,
  IC_PURCH_MIN_IC: 3,
  /** Single weak stage becomes primary weak_funnel only at ≥ this × min gate */
  PRIMARY_VOLUME_MULTIPLIER: 2,
};

/** Product portfolio rules */
const PRODUCTS = {
  HERO_TOP_N_BY_GP: 3,
  HERO_MIN_UNITS: 1,
  HIGH_VOLUME_SHARE_GTE: 5,
  WEAK_MARGIN_LT: 15,
  STRONG_MARGIN_LOW_VOL_REV_SHARE_LT: 5,
  LOW_VOLUME_REV_SHARE_LT: 2,
  LOW_VOLUME_UNITS_LTE: 2,
  /** Soft flag only — does not hard-fail product status */
  COGS_COVERAGE_WARN_LT: 0.5,
};

/** Accounting / confidence gates */
const GATES = {
  META_LEDGER_VARIANCE_PCT_SEVERE: 50,
  MIN_CONFIDENCE_FOR_SCALE: "medium",
};

const PRIORITY_RANK = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const CONFIDENCE_RANK = {
  unavailable: 0,
  low: 1,
  medium: 2,
  high: 3,
};

module.exports = {
  BUSINESS,
  BUSINESS_ADS,
  ENTITY_ZERO_PURCHASE,
  ENTITY_WITH_PURCHASES,
  FUNNEL,
  PRODUCTS,
  GATES,
  PRIORITY_RANK,
  CONFIDENCE_RANK,
};
