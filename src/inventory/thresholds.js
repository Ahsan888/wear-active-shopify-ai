/**
 * Configurable inventory intelligence thresholds (Phase 7).
 * Override via options or env where noted.
 */
const DEFAULT_THRESHOLDS = {
  critical_days: 7,
  low_days: 14,
  healthy_days: 45,
  high_days: 90,
  // Restock target days of cover
  target_days_of_cover: 45,
  // Min 30d units before treating velocity as meaningful for RESTOCK_NOW
  min_units_30d_for_restock: 2,
  // Acceleration: 7d daily vs 30d daily ratio bands
  accel_ratio: 1.25,
  slow_ratio: 0.75,
  // Priority weights (deterministic)
  priority_velocity_weight: 10,
  priority_cover_weight: 5,
  priority_margin_weight: 2,
  priority_value_weight: 0.001,
};

function resolveThresholds(overrides = {}) {
  const envTarget = Number(process.env.INVENTORY_TARGET_DAYS);
  const base = {
    ...DEFAULT_THRESHOLDS,
    ...(Number.isFinite(envTarget) && envTarget > 0
      ? { target_days_of_cover: envTarget }
      : {}),
  };
  return { ...base, ...overrides };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  resolveThresholds,
};
