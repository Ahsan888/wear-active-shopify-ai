/**
 * Deterministic pricing recommendation classification (Phase 8).
 *
 * Discount safety uses accounting (ex-tax) gross margin floors.
 * CLEARANCE_CANDIDATE requires mature (≥90d) selling eligibility.
 */
const { round2 } = require("../books/tax");
const { resolvePricingThresholds } = require("./thresholds");
const {
  accountingSafeFloorPrice,
  maximumSafeDiscountPct,
  simulateDiscount,
  simulateIncrease,
  isDiscountAccountingSafe,
  DEFAULT_TAX_CHARGEABLE,
} = require("./simulate");

const PROTECT_STOCK = new Set(["OUT_OF_STOCK", "CRITICAL", "LOW"]);
const HOLD_STOCK = new Set(["HEALTHY"]);
const MODEST_STOCK = new Set(["HIGH"]);
const PROMO_STOCK = new Set(["OVERSTOCK", "NO_RECENT_DEMAND"]);
const CLEAR_STOCK = new Set(["NO_DEMAND"]);

/**
 * Pick conservative recommended discount band (≤30 default).
 * Only bands that pass accounting min GM are eligible.
 */
function pickRecommendedDiscountPct({
  stock_class,
  max_safe_discount_pct,
  inventory_value,
  demand_trend,
  thresholds,
  current_price,
  unit_cost,
  tax_chargeable = DEFAULT_TAX_CHARGEABLE,
}) {
  const t = resolvePricingThresholds(thresholds);
  const maxSafe =
    max_safe_discount_pct == null
      ? 0
      : Math.max(0, Number(max_safe_discount_pct));
  const hardCap = Math.min(t.max_default_discount_pct, maxSafe);

  if (hardCap < 5) {
    return { recommended_discount_pct: null, deep_clearance_review: false };
  }

  let target = 5;
  if (stock_class === "HIGH") {
    target = demand_trend === "slowing" ? 10 : 5;
  } else if (stock_class === "OVERSTOCK") {
    target =
      demand_trend === "slowing" || demand_trend === "insufficient_data"
        ? 15
        : 10;
  } else if (stock_class === "NO_RECENT_DEMAND") {
    target = 20;
  } else if (stock_class === "NO_DEMAND") {
    const val = Number(inventory_value) || 0;
    target = val >= (t.min_inventory_value_for_clearance || 0) * 2 ? 30 : 20;
  }

  const bands = (t.recommend_bands || []).filter((b) => b <= hardCap);
  if (!bands.length) {
    return { recommended_discount_pct: null, deep_clearance_review: false };
  }

  let chosen = null;
  for (const b of bands) {
    if (b > target) continue;
    if (
      !isDiscountAccountingSafe(
        current_price,
        unit_cost,
        b,
        t.min_gross_margin_pct,
        tax_chargeable
      )
    ) {
      continue;
    }
    chosen = b;
  }

  // If target bands failed, try smallest band that is still accounting-safe
  if (chosen == null) {
    for (const b of bands) {
      if (
        isDiscountAccountingSafe(
          current_price,
          unit_cost,
          b,
          t.min_gross_margin_pct,
          tax_chargeable
        )
      ) {
        chosen = b;
        break;
      }
    }
  }

  if (chosen == null) {
    return { recommended_discount_pct: null, deep_clearance_review: false };
  }

  const deepReview =
    maxSafe > t.max_default_discount_pct
      ? {
          deep_clearance_review: true,
          deep_clearance_max_safe_discount_pct: round2(maxSafe),
          note: "DEEP_CLEARANCE_REVIEW — discount >30% needs explicit owner review",
        }
      : { deep_clearance_review: false };

  return {
    recommended_discount_pct: chosen,
    ...deepReview,
  };
}

function floorFields(price, cost, t, taxChargeable) {
  const floor = accountingSafeFloorPrice(cost, t.min_gross_margin_pct, taxChargeable);
  const maxSafe =
    price != null && floor != null
      ? maximumSafeDiscountPct(price, floor)
      : null;
  return {
    minimum_margin_price: floor,
    maximum_safe_discount_pct: maxSafe,
  };
}

function classifyPricingAction(row, thresholds) {
  const t = resolvePricingThresholds(thresholds);
  const warnings = row.data_quality_warnings || [];
  const stock = row.stock_class || "UNKNOWN";
  const price = row.current_price;
  const cost = row.unit_cost;
  const trusted = row.stock_trusted !== false;
  const taxChargeable =
    row.tax_chargeable == null ? DEFAULT_TAX_CHARGEABLE : Boolean(row.tax_chargeable);
  const immature = Boolean(row.immature_for_clearance);
  const clearanceMature = row.clearance_mature === true;
  const maturityKnown = row.clearance_maturity_source && row.clearance_maturity_source !== "unknown";

  if (
    !trusted ||
    warnings.includes("duplicate_shopify_sku") ||
    warnings.includes("missing_cost") ||
    warnings.includes("missing_sku") ||
    price == null ||
    !(price > 0) ||
    cost == null ||
    stock === "UNKNOWN"
  ) {
    return {
      recommendation: "INSUFFICIENT_DATA",
      recommended_discount_pct: null,
      recommended_price: null,
      price_increase_test: null,
      confidence: "insufficient",
      immature_for_clearance: immature,
    };
  }

  if (cost >= price) {
    return {
      recommendation: "INSUFFICIENT_DATA",
      recommended_discount_pct: null,
      recommended_price: null,
      price_increase_test: null,
      confidence: "low",
      note: "cost_gte_price",
      immature_for_clearance: immature,
    };
  }

  const floors = floorFields(price, cost, t, taxChargeable);
  const { minimum_margin_price: floor, maximum_safe_discount_pct: maxSafe } = floors;

  const sold30 = Number(row.units_sold_30d) || 0;
  const stockQty = Number(row.current_stock);
  const trend = row.demand_trend || "insufficient_data";
  const gmAcct = row.accounting_gm_ex_tax_pct;

  const canIncrease =
    sold30 >= t.min_units_30d_for_price_increase &&
    (trend === "accelerating" || trend === "stable") &&
    PROTECT_STOCK.has(stock) &&
    gmAcct != null &&
    gmAcct >= t.min_gross_margin_pct;

  if (canIncrease) {
    const tests = (t.increase_steps || []).map((inc) =>
      simulateIncrease(price, cost, inc, taxChargeable)
    );
    return {
      recommendation: "PRICE_INCREASE_CANDIDATE",
      recommended_discount_pct: null,
      recommended_price: null,
      price_increase_test: tests,
      ...floors,
      confidence:
        sold30 >= 10 && trend === "accelerating" ? "high" : "medium",
      immature_for_clearance: immature,
    };
  }

  if (PROTECT_STOCK.has(stock)) {
    return {
      recommendation: "PROTECT_PRICE",
      recommended_discount_pct: null,
      recommended_price: null,
      price_increase_test: null,
      ...floors,
      confidence: sold30 >= 3 ? "medium" : "low",
      note: sold30 === 0 ? "low_stock_without_discount" : null,
      immature_for_clearance: immature,
    };
  }

  if (HOLD_STOCK.has(stock)) {
    return {
      recommendation: "HOLD_PRICE",
      recommended_discount_pct: null,
      recommended_price: null,
      price_increase_test: null,
      ...floors,
      confidence: sold30 >= 2 ? "medium" : "low",
      immature_for_clearance: immature,
    };
  }

  const pickOpts = {
    max_safe_discount_pct: maxSafe,
    inventory_value: row.inventory_value,
    demand_trend: trend,
    thresholds: t,
    current_price: price,
    unit_cost: cost,
    tax_chargeable: taxChargeable,
  };

  if (MODEST_STOCK.has(stock)) {
    const pick = pickRecommendedDiscountPct({
      ...pickOpts,
      stock_class: stock,
    });
    if (pick.recommended_discount_pct == null) {
      return {
        recommendation: "HOLD_PRICE",
        recommended_discount_pct: null,
        recommended_price: null,
        ...floors,
        confidence: "low",
        immature_for_clearance: immature,
      };
    }
    const sim = simulateDiscount(
      price,
      cost,
      pick.recommended_discount_pct,
      taxChargeable
    );
    return {
      recommendation: "TEST_SMALL_DISCOUNT",
      recommended_discount_pct: pick.recommended_discount_pct,
      recommended_price: sim?.selling_price ?? null,
      scenario: sim,
      ...floors,
      ...pick,
      confidence: "medium",
      immature_for_clearance: immature,
    };
  }

  // NO_DEMAND — clearance only when mature + stock + safe room
  if (CLEAR_STOCK.has(stock)) {
    const hasStock = Number.isFinite(stockQty) && stockQty > 0;
    if (!hasStock) {
      return {
        recommendation: "INSUFFICIENT_DATA",
        recommended_discount_pct: null,
        recommended_price: null,
        ...floors,
        confidence: "low",
        note: "no_demand_without_stock",
        immature_for_clearance: immature,
      };
    }

    if (!clearanceMature) {
      // Immature: never CLEARANCE; softer promotion/hold path
      const pick = pickRecommendedDiscountPct({
        ...pickOpts,
        stock_class: "NO_RECENT_DEMAND",
      });
      if (pick.recommended_discount_pct == null) {
        return {
          recommendation: maturityKnown ? "HOLD_PRICE" : "INSUFFICIENT_DATA",
          recommended_discount_pct: null,
          recommended_price: null,
          ...floors,
          confidence: "low",
          note: "immature_for_clearance",
          immature_for_clearance: true,
        };
      }
      const sim = simulateDiscount(
        price,
        cost,
        pick.recommended_discount_pct,
        taxChargeable
      );
      return {
        recommendation: "PROMOTION_CANDIDATE",
        recommended_discount_pct: pick.recommended_discount_pct,
        recommended_price: sim?.selling_price ?? null,
        scenario: sim,
        ...floors,
        ...pick,
        confidence: "low",
        note: "immature_for_clearance",
        immature_for_clearance: true,
      };
    }

    const pick = pickRecommendedDiscountPct({
      ...pickOpts,
      stock_class: stock,
    });
    if (pick.recommended_discount_pct == null) {
      return {
        recommendation: "HOLD_PRICE",
        recommended_discount_pct: null,
        recommended_price: null,
        ...floors,
        confidence: "low",
        note: "no_safe_discount_room",
        immature_for_clearance: false,
      };
    }
    const sim = simulateDiscount(
      price,
      cost,
      pick.recommended_discount_pct,
      taxChargeable
    );
    const value = Number(row.inventory_value) || 0;
    // High confidence only with known maturity + meaningful capital
    const canHigh =
      maturityKnown &&
      value >= t.min_inventory_value_for_clearance &&
      stock === "NO_DEMAND";
    return {
      recommendation: "CLEARANCE_CANDIDATE",
      recommended_discount_pct: pick.recommended_discount_pct,
      recommended_price: sim?.selling_price ?? null,
      scenario: sim,
      ...floors,
      ...pick,
      confidence: canHigh ? "high" : "medium",
      immature_for_clearance: false,
    };
  }

  if (PROMO_STOCK.has(stock)) {
    const pick = pickRecommendedDiscountPct({
      ...pickOpts,
      stock_class: stock,
    });
    if (pick.recommended_discount_pct == null) {
      return {
        recommendation: "HOLD_PRICE",
        recommended_discount_pct: null,
        recommended_price: null,
        ...floors,
        confidence: "low",
        immature_for_clearance: immature,
      };
    }
    const sim = simulateDiscount(
      price,
      cost,
      pick.recommended_discount_pct,
      taxChargeable
    );
    return {
      recommendation: "PROMOTION_CANDIDATE",
      recommended_discount_pct: pick.recommended_discount_pct,
      recommended_price: sim?.selling_price ?? null,
      scenario: sim,
      ...floors,
      ...pick,
      confidence: "medium",
      immature_for_clearance: immature,
    };
  }

  return {
    recommendation: "INSUFFICIENT_DATA",
    recommended_discount_pct: null,
    recommended_price: null,
    ...floors,
    confidence: "insufficient",
    immature_for_clearance: immature,
  };
}

module.exports = {
  classifyPricingAction,
  pickRecommendedDiscountPct,
  PROTECT_STOCK,
  HOLD_STOCK,
  MODEST_STOCK,
  PROMO_STOCK,
  CLEAR_STOCK,
};
