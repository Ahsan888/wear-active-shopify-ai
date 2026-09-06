/**
 * Deterministic inventory classification, actions, restock qty, priority.
 */
const { round2 } = require("../books/tax");
const { resolveThresholds } = require("./thresholds");

function avgDailyUnits(units, days) {
  const u = Number(units) || 0;
  const d = Number(days) || 0;
  if (d <= 0) return 0;
  return u / d;
}

/**
 * Parse sellable stock. null / undefined / "" / non-numeric → null.
 * Never coerce null → 0.
 */
function parseStock(currentStock) {
  if (currentStock == null || currentStock === "") return null;
  const stock = Number(currentStock);
  if (!Number.isFinite(stock)) return null;
  return stock;
}

/**
 * days_of_cover = stock / avg_daily_30d
 * null when stock unknown or no 30d sales (do not fake a number).
 */
function daysOfCover(currentStock, unitsSold30d) {
  const stock = parseStock(currentStock);
  const sold = Number(unitsSold30d) || 0;
  if (stock == null) return null;
  if (sold <= 0) return null;
  return round2(stock / (sold / 30));
}

/**
 * Stock classification.
 * NO_DEMAND = stock > 0 and zero recognized sales in 90d.
 * NO_RECENT_DEMAND = stock > 0, zero 30d sales, but some 90d sales.
 * Cover bands use 30d velocity when present.
 */
function classifyStock(
  currentStock,
  daysCover,
  unitsSold30d,
  unitsSold90d,
  thresholds
) {
  const t = resolveThresholds(thresholds);
  const stock = parseStock(currentStock);
  if (stock == null) return "UNKNOWN";
  if (stock <= 0) return "OUT_OF_STOCK";

  const sold30 = Number(unitsSold30d) || 0;
  const sold90 = Number(unitsSold90d) || 0;

  if (sold90 <= 0) return "NO_DEMAND";
  if (sold30 <= 0) return "NO_RECENT_DEMAND";

  if (daysCover == null) return "UNKNOWN";
  if (daysCover <= t.critical_days) return "CRITICAL";
  if (daysCover <= t.low_days) return "LOW";
  if (daysCover <= t.healthy_days) return "HEALTHY";
  if (daysCover <= t.high_days) return "HIGH";
  return "OVERSTOCK";
}

function classifyDemandTrend(units7d, units30d, thresholds) {
  const t = resolveThresholds(thresholds);
  const u7 = Number(units7d) || 0;
  const u30 = Number(units30d) || 0;
  if (u7 + u30 < 2) return "insufficient_data";
  const daily7 = avgDailyUnits(u7, 7);
  const daily30 = avgDailyUnits(u30, 30);
  if (daily30 <= 0 && daily7 > 0) return "accelerating";
  if (daily30 <= 0) return "insufficient_data";
  const ratio = daily7 / daily30;
  if (ratio >= t.accel_ratio) return "accelerating";
  if (ratio <= t.slow_ratio) return "slowing";
  return "stable";
}

/**
 * Advisory action — demand + stock together.
 * Low stock alone without demand ≠ RESTOCK_NOW.
 */
function recommendAction({
  stock_class,
  days_of_cover,
  units_sold_30d,
  demand_trend,
  gross_margin_pct,
  stock_trusted = true,
  thresholds,
} = {}) {
  if (stock_trusted === false) return "MONITOR";
  if (stock_class === "UNKNOWN") return "MONITOR";

  const t = resolveThresholds(thresholds);
  const sold = Number(units_sold_30d) || 0;
  const meaningful = sold >= t.min_units_30d_for_restock;

  if (stock_class === "NO_DEMAND") return "NO_DEMAND_REVIEW";
  if (stock_class === "NO_RECENT_DEMAND") return "MONITOR";
  if (stock_class === "OVERSTOCK") {
    return sold <= 0 ? "NO_DEMAND_REVIEW" : "CLEARANCE_CANDIDATE";
  }
  if (stock_class === "HIGH") return "REDUCE_REORDER";
  if (stock_class === "HEALTHY") return "HEALTHY";
  if (stock_class === "OUT_OF_STOCK") {
    return meaningful ? "RESTOCK_NOW" : "MONITOR";
  }
  if (stock_class === "CRITICAL") {
    if (!meaningful) return "MONITOR";
    if (
      demand_trend === "slowing" &&
      (gross_margin_pct == null || gross_margin_pct < 10)
    ) {
      return "MONITOR";
    }
    return "RESTOCK_NOW";
  }
  if (stock_class === "LOW") {
    if (!meaningful) return "MONITOR";
    return demand_trend === "accelerating" || demand_trend === "stable"
      ? "RESTOCK_SOON"
      : "MONITOR";
  }
  return "MONITOR";
}

function recommendedRestockQty({
  current_stock,
  units_sold_30d,
  action,
  stock_trusted = true,
  thresholds,
} = {}) {
  if (stock_trusted === false) return null;
  const t = resolveThresholds(thresholds);
  const sold = Number(units_sold_30d) || 0;
  if (sold < t.min_units_30d_for_restock) return null;
  if (!["RESTOCK_NOW", "RESTOCK_SOON"].includes(action)) return null;
  const stock = parseStock(current_stock);
  if (stock == null) return null;
  const avg = avgDailyUnits(sold, 30);
  const target = t.target_days_of_cover * avg;
  const raw = Math.max(0, target - Math.max(0, stock));
  return Math.ceil(raw);
}

/**
 * Higher = more urgent restock / risk attention.
 * Dead-stock score uses inventory value when no/low demand.
 */
function priorityScore(row, thresholds) {
  const t = resolveThresholds(thresholds);
  const sold = Number(row.units_sold_30d) || 0;
  const cover = row.days_of_cover;
  const margin = Number(row.gross_margin_pct);
  const value = Number(row.inventory_value) || 0;
  const stock = parseStock(row.current_stock) ?? 0;

  if (
    row.stock_class === "NO_DEMAND" ||
    row.stock_class === "NO_RECENT_DEMAND" ||
    row.stock_class === "OVERSTOCK"
  ) {
    return round2(value * t.priority_value_weight * 10 + stock * 0.01);
  }

  let score = sold * t.priority_velocity_weight;
  if (cover != null && cover > 0) {
    score += (t.healthy_days / Math.max(cover, 0.5)) * t.priority_cover_weight;
  } else if (stock <= 0 && sold > 0) {
    score += 50;
  }
  if (Number.isFinite(margin) && margin > 0) {
    score += (margin / 100) * t.priority_margin_weight * 10;
  }
  if (row.demand_trend === "accelerating") score += 8;
  if (row.demand_trend === "slowing") score -= 4;
  return round2(score);
}

function confidenceForSku(row) {
  const warnings = row.data_quality_warnings || [];
  if (
    row.stock_trusted === false ||
    warnings.includes("duplicate_shopify_sku") ||
    warnings.includes("missing_sku") ||
    warnings.includes("missing_shopify_inventory")
  ) {
    return "insufficient";
  }
  if (warnings.includes("missing_cost") || warnings.includes("missing_variant_master")) {
    return "medium";
  }
  const sold = Number(row.units_sold_30d) || 0;
  if (sold >= 10) return "high";
  if (sold >= 3) return "medium";
  if (sold >= 1) return "low";
  return row.current_stock > 0 ? "low" : "insufficient";
}

module.exports = {
  avgDailyUnits,
  parseStock,
  daysOfCover,
  classifyStock,
  classifyDemandTrend,
  recommendAction,
  recommendedRestockQty,
  priorityScore,
  confidenceForSku,
};
