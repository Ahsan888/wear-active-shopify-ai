/**
 * Configurable pricing intelligence thresholds (Phase 8).
 */
const DEFAULT_THRESHOLDS = {
  min_gross_margin_pct: Math.max(
    0,
    Number(process.env.PRICING_MIN_GROSS_MARGIN_PCT) || 25
  ),
  max_default_discount_pct: 30,
  deep_clearance_review_pct: 35,
  // Simulation ladder
  discount_steps: [0, 5, 10, 15, 20, 25, 30, 35, 40],
  recommend_bands: [5, 10, 15, 20, 25, 30],
  increase_steps: [5, 10],
  // Sample gates
  min_units_30d_for_price_increase: 3,
  min_units_90d_for_clearance: 0, // NO_DEMAND already implies 0
  min_inventory_value_for_clearance: 5000,
};

function resolvePricingThresholds(overrides = {}) {
  const envMin = Number(process.env.PRICING_MIN_GROSS_MARGIN_PCT);
  const base = {
    ...DEFAULT_THRESHOLDS,
    ...(Number.isFinite(envMin) && envMin >= 0
      ? { min_gross_margin_pct: envMin }
      : {}),
  };
  return { ...base, ...overrides };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  resolvePricingThresholds,
};
