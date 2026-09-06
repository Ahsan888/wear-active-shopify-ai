#!/usr/bin/env node
/**
 * Phase 8 pricing intelligence self-tests.
 */
const assert = require("assert");
const {
  unitEconomics,
  simulateDiscount,
  simulateIncrease,
  minimumMarginPrice,
  maximumSafeDiscountPct,
} = require("../pricing/simulate");
const { classifyPricingAction } = require("../pricing/classify");
const { buildPricingReport } = require("../pricing/build");
const { resolvePricingThresholds } = require("../pricing/thresholds");

function test(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err.message || err);
    process.exitCode = 1;
  }
}

test("unit GP = sticker − cost (example 2500/1200)", () => {
  const e = unitEconomics(2500, 1200);
  assert.strictEqual(e.unit_gp, 1300);
  assert.strictEqual(e.unit_gm_pct, 52);
  assert.ok(e.price_ex_tax < 2500); // tax-inclusive sticker
});

test("20% discount GP volume multiplier ~1.625", () => {
  const sim = simulateDiscount(2500, 1200, 20);
  assert.strictEqual(sim.selling_price, 2000);
  assert.strictEqual(sim.unit_gp, 800);
  assert.strictEqual(sim.units_required_to_match_current_gp, 1.63); // 1300/800 rounded
});

test("cost floor and min margin floor", () => {
  const floor = minimumMarginPrice(1500, 25);
  assert.strictEqual(floor, 2000); // 1500/0.75
  const maxSafe = maximumSafeDiscountPct(2499, 2000);
  assert.ok(maxSafe > 0 && maxSafe < 25);
});

test("never recommend below cost — max safe 0 if floor >= price", () => {
  assert.strictEqual(maximumSafeDiscountPct(1000, 1200), 0);
});

test("PROTECT or PRICE_INCREASE for CRITICAL with demand", () => {
  const a = classifyPricingAction({
    current_price: 2499,
    unit_cost: 1500,
    unit_gm_pct: 40,
    stock_class: "CRITICAL",
    units_sold_30d: 5,
    demand_trend: "stable",
    stock_trusted: true,
    data_quality_warnings: [],
  });
  assert.ok(
    ["PROTECT_PRICE", "PRICE_INCREASE_CANDIDATE"].includes(a.recommendation)
  );
});

test("PROTECT_PRICE when critical but weak sample", () => {
  const a = classifyPricingAction({
    current_price: 2499,
    unit_cost: 1500,
    unit_gm_pct: 40,
    stock_class: "CRITICAL",
    units_sold_30d: 1,
    demand_trend: "insufficient_data",
    stock_trusted: true,
    data_quality_warnings: [],
  });
  assert.strictEqual(a.recommendation, "PROTECT_PRICE");
});

test("CLEARANCE_CANDIDATE for NO_DEMAND with margin room", () => {
  const a = classifyPricingAction({
    current_price: 2499,
    unit_cost: 1500,
    unit_gm_pct: 40,
    stock_class: "NO_DEMAND",
    units_sold_30d: 0,
    units_sold_90d: 0,
    inventory_value: 37500,
    demand_trend: "insufficient_data",
    stock_trusted: true,
    data_quality_warnings: [],
  });
  assert.strictEqual(a.recommendation, "CLEARANCE_CANDIDATE");
  assert.ok(a.recommended_discount_pct >= 10);
  assert.ok(a.recommended_discount_pct <= 30);
  assert.ok(a.recommended_price < 2499);
});

test("PROMOTION_CANDIDATE for OVERSTOCK", () => {
  const a = classifyPricingAction({
    current_price: 3000,
    unit_cost: 1200,
    unit_gm_pct: 60,
    stock_class: "OVERSTOCK",
    units_sold_30d: 2,
    demand_trend: "slowing",
    inventory_value: 20000,
    stock_trusted: true,
    data_quality_warnings: [],
  });
  assert.strictEqual(a.recommendation, "PROMOTION_CANDIDATE");
});

test("PRICE_INCREASE_CANDIDATE for low stock + demand", () => {
  const a = classifyPricingAction({
    current_price: 2500,
    unit_cost: 1000,
    unit_gm_pct: 60,
    stock_class: "LOW",
    units_sold_30d: 8,
    demand_trend: "accelerating",
    stock_trusted: true,
    data_quality_warnings: [],
  });
  assert.strictEqual(a.recommendation, "PRICE_INCREASE_CANDIDATE");
  assert.ok(Array.isArray(a.price_increase_test));
  assert.ok(a.price_increase_test.some((t) => t.increase_pct === 5));
});

test("INSUFFICIENT_DATA for missing cost", () => {
  const a = classifyPricingAction({
    current_price: 2500,
    unit_cost: null,
    stock_class: "HEALTHY",
    units_sold_30d: 5,
    stock_trusted: true,
    data_quality_warnings: ["missing_cost"],
  });
  assert.strictEqual(a.recommendation, "INSUFFICIENT_DATA");
});

test("INSUFFICIENT_DATA for duplicate / untrusted stock", () => {
  const a = classifyPricingAction({
    current_price: 2500,
    unit_cost: 1000,
    stock_class: "OVERSTOCK",
    stock_trusted: false,
    data_quality_warnings: ["duplicate_shopify_sku"],
  });
  assert.strictEqual(a.recommendation, "INSUFFICIENT_DATA");
});

test("HOLD_PRICE for HEALTHY", () => {
  const a = classifyPricingAction({
    current_price: 2500,
    unit_cost: 1000,
    unit_gm_pct: 60,
    stock_class: "HEALTHY",
    units_sold_30d: 4,
    demand_trend: "stable",
    stock_trusted: true,
    data_quality_warnings: [],
  });
  assert.strictEqual(a.recommendation, "HOLD_PRICE");
});

test("price increase simulation uplift", () => {
  const t = simulateIncrease(2000, 1000, 10);
  assert.strictEqual(t.selling_price, 2200);
  assert.strictEqual(t.unit_gp, 1200);
  assert.strictEqual(t.gp_uplift_per_unit, 200);
});

test("build report clears capital for clearance and excludes missing cost from trust", () => {
  const report = buildPricingReport({
    inventorySkus: [
      {
        sku: "DEAD-1",
        product: "StrideFlex Pants",
        variant: "Black / XL",
        current_stock: 25,
        unit_cost: 1500,
        inventory_value: 37500,
        stock_class: "NO_DEMAND",
        units_sold_30d: 0,
        units_sold_90d: 0,
        demand_trend: "insufficient_data",
        stock_trusted: true,
        data_quality_warnings: [],
      },
      {
        sku: "HOT-1",
        product: "MotionFit",
        variant: "L",
        current_stock: 2,
        unit_cost: 1450,
        inventory_value: 2900,
        stock_class: "CRITICAL",
        units_sold_30d: 6,
        units_sold_90d: 10,
        demand_trend: "stable",
        stock_trusted: true,
        data_quality_warnings: [],
      },
      {
        sku: "NOCOST",
        product: "X",
        variant: "M",
        current_stock: 10,
        unit_cost: null,
        stock_class: "OVERSTOCK",
        stock_trusted: true,
        data_quality_warnings: ["missing_cost"],
      },
    ],
    shopifyPrices: [
      {
        sku: "DEAD-1",
        product: "StrideFlex Pants",
        variant: "Black / XL",
        current_price: 2499,
      },
      {
        sku: "HOT-1",
        product: "MotionFit",
        variant: "L",
        current_price: 3999,
      },
      {
        sku: "NOCOST",
        product: "X",
        variant: "M",
        current_price: 1999,
      },
    ],
    period: { since: "2026-06-09", until: "2026-09-06" },
  });

  const dead = report.skus.find((s) => s.sku === "DEAD-1");
  assert.strictEqual(dead.recommendation, "CLEARANCE_CANDIDATE");
  assert.strictEqual(dead.inventory_cost_capital_tied_up, 37500);
  assert.ok(dead.recommended_discount_pct <= 30);

  const hot = report.skus.find((s) => s.sku === "HOT-1");
  assert.ok(
    ["PROTECT_PRICE", "PRICE_INCREASE_CANDIDATE"].includes(hot.recommendation)
  );

  const nocost = report.skus.find((s) => s.sku === "NOCOST");
  assert.strictEqual(nocost.recommendation, "INSUFFICIENT_DATA");

  assert.ok(report.summary.capital_tied_up_clearance >= 37500);
  assert.ok(report.clearance_candidates.some((c) => c.sku === "DEAD-1"));
});

test("configurable min margin via thresholds", () => {
  const t = resolvePricingThresholds({ min_gross_margin_pct: 30 });
  assert.strictEqual(t.min_gross_margin_pct, 30);
  const floor = minimumMarginPrice(1400, 30);
  assert.strictEqual(floor, 2000);
});

test("GP cannot be preserved when discounted GP <= 0", () => {
  const sim = simulateDiscount(1000, 900, 20); // sell 800 < cost
  assert.strictEqual(sim.below_cost, true);
  assert.strictEqual(sim.units_required_to_match_current_gp, null);
});

test("product aggregation surfaces variant stockout risk", () => {
  const report = buildPricingReport({
    inventorySkus: [
      {
        sku: "P-S",
        product: "Tee",
        variant: "S",
        current_stock: 1,
        unit_cost: 500,
        inventory_value: 500,
        stock_class: "CRITICAL",
        units_sold_30d: 4,
        demand_trend: "stable",
        stock_trusted: true,
        data_quality_warnings: [],
      },
      {
        sku: "P-L",
        product: "Tee",
        variant: "L",
        current_stock: 40,
        unit_cost: 500,
        inventory_value: 20000,
        stock_class: "OVERSTOCK",
        units_sold_30d: 1,
        demand_trend: "slowing",
        stock_trusted: true,
        data_quality_warnings: [],
      },
    ],
    shopifyPrices: [
      { sku: "P-S", product: "Tee", variant: "S", current_price: 1500 },
      { sku: "P-L", product: "Tee", variant: "L", current_price: 1500 },
    ],
  });
  const prod = report.products.find((p) => p.product === "Tee");
  assert.ok(prod);
  assert.strictEqual(prod.shared_product_price, true);
  assert.strictEqual(prod.has_variant_stockout_risk, true);
});

if (!process.exitCode) {
  console.log("\nAll pricing self-tests passed.");
}
