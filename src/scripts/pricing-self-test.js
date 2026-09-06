#!/usr/bin/env node
/**
 * Phase 8 pricing intelligence self-tests (hardened).
 */
const assert = require("assert");
const {
  unitEconomics,
  simulateDiscount,
  simulateIncrease,
  minimumMarginPrice,
  minimumAccountingSafeStickerPrice,
  accountingSafeFloorPrice,
  maximumSafeDiscountPct,
  isDiscountAccountingSafe,
} = require("../pricing/simulate");
const { classifyPricingAction } = require("../pricing/classify");
const { buildPricingReport } = require("../pricing/build");
const { resolvePricingThresholds } = require("../pricing/thresholds");
const { resolveClearanceMaturity } = require("../pricing/maturity");
const { splitInclusiveTax, inclusiveFromExTax } = require("../books/tax");

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

const MATURE = {
  clearance_mature: true,
  immature_for_clearance: false,
  clearance_maturity_source: "product_published_at",
  selling_age_days: 120,
};

test("unit GP = sticker − cost (example 2500/1200) + accounting fields", () => {
  const e = unitEconomics(2500, 1200);
  assert.strictEqual(e.commercial_sticker_gp, 1300);
  assert.strictEqual(e.commercial_sticker_gm_pct, 52);
  assert.strictEqual(e.unit_gp, 1300);
  assert.ok(e.price_ex_tax < 2500);
  assert.ok(e.accounting_gp_ex_tax < e.commercial_sticker_gp);
  assert.ok(e.accounting_gm_ex_tax_pct < e.commercial_sticker_gm_pct);
});

test("20% discount GP volume multiplier ~1.625 (commercial)", () => {
  const sim = simulateDiscount(2500, 1200, 20);
  assert.strictEqual(sim.selling_price, 2000);
  assert.strictEqual(sim.unit_gp, 800);
  assert.strictEqual(sim.units_required_to_match_current_gp, 1.63); // 1300/800 rounded
  assert.ok(sim.accounting_gm_ex_tax_pct != null);
});

test("accounting floor is higher than commercial sticker floor (tax)", () => {
  const commercial = 1500 / 0.75; // 2000
  const acct = minimumAccountingSafeStickerPrice(1500, 25);
  assert.ok(acct > commercial);
  // required ex-tax 2000 → inclusive ~2360
  assert.strictEqual(acct, inclusiveFromExTax(2000, true));
  const floor = accountingSafeFloorPrice(1500, 25);
  assert.strictEqual(floor, acct);
  const maxSafe = maximumSafeDiscountPct(2499, floor);
  assert.ok(maxSafe > 0 && maxSafe < 10); // ~5.6%, not ~20%
});

test("minimumMarginPrice aliases accounting-safe sticker", () => {
  assert.strictEqual(
    minimumMarginPrice(1500, 25),
    minimumAccountingSafeStickerPrice(1500, 25)
  );
});

test("recommended discounts must not violate accounting min GM", () => {
  // At 2499 / 1500, only ~5% is accounting-safe under 25% min GM
  assert.strictEqual(isDiscountAccountingSafe(2499, 1500, 5, 25), true);
  assert.strictEqual(isDiscountAccountingSafe(2499, 1500, 10, 25), false);
  assert.strictEqual(isDiscountAccountingSafe(2499, 1500, 20, 25), false);
});

test("never recommend below cost — max safe 0 if floor >= price", () => {
  assert.strictEqual(maximumSafeDiscountPct(1000, 1200), 0);
});

test("PROTECT or PRICE_INCREASE for CRITICAL with demand", () => {
  const a = classifyPricingAction({
    current_price: 2499,
    unit_cost: 1500,
    unit_gm_pct: 40,
    accounting_gm_ex_tax_pct: 29,
    stock_class: "CRITICAL",
    units_sold_30d: 5,
    demand_trend: "stable",
    stock_trusted: true,
    data_quality_warnings: [],
    ...MATURE,
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
    accounting_gm_ex_tax_pct: 29,
    stock_class: "CRITICAL",
    units_sold_30d: 1,
    demand_trend: "insufficient_data",
    stock_trusted: true,
    data_quality_warnings: [],
    ...MATURE,
  });
  assert.strictEqual(a.recommendation, "PROTECT_PRICE");
});

test("CLEARANCE_CANDIDATE for mature NO_DEMAND with margin room", () => {
  const a = classifyPricingAction({
    current_price: 2499,
    unit_cost: 1500,
    unit_gm_pct: 40,
    accounting_gm_ex_tax_pct: 29,
    stock_class: "NO_DEMAND",
    current_stock: 25,
    units_sold_30d: 0,
    units_sold_90d: 0,
    inventory_value: 37500,
    demand_trend: "insufficient_data",
    stock_trusted: true,
    data_quality_warnings: [],
    ...MATURE,
  });
  assert.strictEqual(a.recommendation, "CLEARANCE_CANDIDATE");
  assert.ok(a.recommended_discount_pct >= 5);
  assert.ok(a.recommended_discount_pct <= 30);
  assert.ok(a.recommended_price < 2499);
  // Must stay above accounting floor (~2360)
  assert.ok(a.recommended_price >= a.minimum_margin_price - 0.01);
  assert.ok(a.recommended_discount_pct <= 5); // only 5% safe at this margin
});

test("30-day-old zero-sales SKU is NOT clearance", () => {
  const a = classifyPricingAction({
    current_price: 2499,
    unit_cost: 1500,
    accounting_gm_ex_tax_pct: 29,
    stock_class: "NO_DEMAND",
    current_stock: 25,
    units_sold_90d: 0,
    inventory_value: 37500,
    stock_trusted: true,
    data_quality_warnings: [],
    clearance_mature: false,
    immature_for_clearance: true,
    clearance_maturity_source: "variant_created_at",
    selling_age_days: 30,
  });
  assert.notStrictEqual(a.recommendation, "CLEARANCE_CANDIDATE");
  assert.strictEqual(a.immature_for_clearance, true);
  assert.ok(
    ["PROMOTION_CANDIDATE", "HOLD_PRICE", "INSUFFICIENT_DATA"].includes(
      a.recommendation
    )
  );
});

test("100-day-old zero-sales SKU can clearance", () => {
  const a = classifyPricingAction({
    current_price: 4000,
    unit_cost: 1500,
    accounting_gm_ex_tax_pct: 40,
    stock_class: "NO_DEMAND",
    current_stock: 20,
    units_sold_90d: 0,
    inventory_value: 30000,
    stock_trusted: true,
    data_quality_warnings: [],
    clearance_mature: true,
    immature_for_clearance: false,
    clearance_maturity_source: "product_published_at",
    selling_age_days: 100,
  });
  assert.strictEqual(a.recommendation, "CLEARANCE_CANDIDATE");
});

test("missing maturity evidence prevents high-confidence clearance", () => {
  const a = classifyPricingAction({
    current_price: 4000,
    unit_cost: 1500,
    accounting_gm_ex_tax_pct: 40,
    stock_class: "NO_DEMAND",
    current_stock: 20,
    units_sold_90d: 0,
    inventory_value: 30000,
    stock_trusted: true,
    data_quality_warnings: [],
    // Unknown maturity → immature → not clearance
    clearance_mature: false,
    immature_for_clearance: true,
    clearance_maturity_source: "unknown",
    selling_age_days: null,
  });
  assert.notStrictEqual(a.recommendation, "CLEARANCE_CANDIDATE");
  assert.notStrictEqual(a.confidence, "high");
});

test("resolveClearanceMaturity: 30d immature, 100d mature, unknown conservative", () => {
  const asOf = "2026-09-06";
  const young = resolveClearanceMaturity(
    { variant_created_at: "2026-08-07T00:00:00Z" },
    asOf
  );
  assert.ok(young.selling_age_days < 90);
  assert.strictEqual(young.clearance_mature, false);

  const old = resolveClearanceMaturity(
    { product_published_at: "2026-05-01T00:00:00Z" },
    asOf
  );
  assert.ok(old.selling_age_days >= 90);
  assert.strictEqual(old.clearance_mature, true);

  const unk = resolveClearanceMaturity({}, asOf);
  assert.strictEqual(unk.clearance_mature, false);
  assert.strictEqual(unk.clearance_maturity_source, "unknown");
});

test("PROMOTION_CANDIDATE for OVERSTOCK", () => {
  const a = classifyPricingAction({
    current_price: 3000,
    unit_cost: 1200,
    unit_gm_pct: 60,
    accounting_gm_ex_tax_pct: 50,
    stock_class: "OVERSTOCK",
    units_sold_30d: 2,
    demand_trend: "slowing",
    inventory_value: 20000,
    stock_trusted: true,
    data_quality_warnings: [],
    ...MATURE,
  });
  assert.strictEqual(a.recommendation, "PROMOTION_CANDIDATE");
  assert.ok(
    isDiscountAccountingSafe(
      3000,
      1200,
      a.recommended_discount_pct,
      25
    )
  );
});

test("PRICE_INCREASE_CANDIDATE for low stock + demand", () => {
  const a = classifyPricingAction({
    current_price: 2500,
    unit_cost: 1000,
    unit_gm_pct: 60,
    accounting_gm_ex_tax_pct: 52,
    stock_class: "LOW",
    units_sold_30d: 8,
    demand_trend: "accelerating",
    stock_trusted: true,
    data_quality_warnings: [],
    ...MATURE,
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
    accounting_gm_ex_tax_pct: 52,
    stock_class: "HEALTHY",
    units_sold_30d: 4,
    demand_trend: "stable",
    stock_trusted: true,
    data_quality_warnings: [],
    ...MATURE,
  });
  assert.strictEqual(a.recommendation, "HOLD_PRICE");
});

test("price increase simulation uplift", () => {
  const t = simulateIncrease(2000, 1000, 10);
  assert.strictEqual(t.selling_price, 2200);
  assert.strictEqual(t.unit_gp, 1200);
  assert.strictEqual(t.gp_uplift_per_unit, 200);
});

test("no safe 5% → do not recommend discount", () => {
  // Thin margin: sticker barely covers accounting floor
  const floor = accountingSafeFloorPrice(2000, 25);
  // price just above floor by <5%
  const price = Math.round(floor * 1.03);
  const a = classifyPricingAction({
    current_price: price,
    unit_cost: 2000,
    accounting_gm_ex_tax_pct: 26,
    stock_class: "OVERSTOCK",
    current_stock: 10,
    inventory_value: 20000,
    stock_trusted: true,
    data_quality_warnings: [],
    ...MATURE,
  });
  assert.ok(
    a.recommended_discount_pct == null || a.recommendation === "HOLD_PRICE"
  );
  if (a.recommendation === "PROMOTION_CANDIDATE") {
    assert.fail("should not promote without safe band");
  }
});

test("build report: mature clearance + capital; immature excluded from clearance", () => {
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
        sku: "YOUNG-1",
        product: "NewDrop",
        variant: "M",
        current_stock: 25,
        unit_cost: 1500,
        inventory_value: 37500,
        stock_class: "NO_DEMAND",
        units_sold_90d: 0,
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
        product_published_at: "2026-04-01T00:00:00Z",
      },
      {
        sku: "YOUNG-1",
        product: "NewDrop",
        variant: "M",
        current_price: 2499,
        variant_created_at: "2026-08-07T00:00:00Z",
      },
      {
        sku: "HOT-1",
        product: "MotionFit",
        variant: "L",
        current_price: 3999,
        product_published_at: "2025-01-01T00:00:00Z",
      },
      {
        sku: "NOCOST",
        product: "X",
        variant: "M",
        current_price: 1999,
        product_published_at: "2025-01-01T00:00:00Z",
      },
    ],
    period: { since: "2026-06-09", until: "2026-09-06" },
  });

  const dead = report.skus.find((s) => s.sku === "DEAD-1");
  assert.strictEqual(dead.recommendation, "CLEARANCE_CANDIDATE");
  assert.strictEqual(dead.inventory_cost_capital_tied_up, 37500);
  assert.ok(dead.recommended_discount_pct <= 5);
  assert.ok(dead.commercial_sticker_gm_pct != null);
  assert.ok(dead.accounting_gm_ex_tax_pct != null);
  assert.ok(dead.accounting_gm_ex_tax_pct < dead.commercial_sticker_gm_pct);

  const young = report.skus.find((s) => s.sku === "YOUNG-1");
  assert.notStrictEqual(young.recommendation, "CLEARANCE_CANDIDATE");
  assert.strictEqual(young.immature_for_clearance, true);

  const hot = report.skus.find((s) => s.sku === "HOT-1");
  assert.ok(
    ["PROTECT_PRICE", "PRICE_INCREASE_CANDIDATE"].includes(hot.recommendation)
  );

  const nocost = report.skus.find((s) => s.sku === "NOCOST");
  assert.strictEqual(nocost.recommendation, "INSUFFICIENT_DATA");

  assert.ok(report.summary.capital_tied_up_clearance >= 37500);
  assert.ok(report.clearance_candidates.some((c) => c.sku === "DEAD-1"));
  assert.ok(report.summary.excluded_immature_clearance_count >= 1);
});

test("clearance XL + low M shared price => no product-wide clearance", () => {
  const report = buildPricingReport({
    inventorySkus: [
      {
        sku: "P-XL",
        product: "Tee",
        variant: "XL",
        current_stock: 40,
        unit_cost: 500,
        inventory_value: 20000,
        stock_class: "NO_DEMAND",
        units_sold_90d: 0,
        stock_trusted: true,
        data_quality_warnings: [],
      },
      {
        sku: "P-M",
        product: "Tee",
        variant: "M",
        current_stock: 2,
        unit_cost: 500,
        inventory_value: 1000,
        stock_class: "LOW",
        units_sold_30d: 4,
        demand_trend: "stable",
        stock_trusted: true,
        data_quality_warnings: [],
      },
    ],
    shopifyPrices: [
      {
        sku: "P-XL",
        product: "Tee",
        variant: "XL",
        current_price: 1500,
        product_published_at: "2025-01-01T00:00:00Z",
      },
      {
        sku: "P-M",
        product: "Tee",
        variant: "M",
        current_price: 1500,
        product_published_at: "2025-01-01T00:00:00Z",
      },
    ],
    period: { until: "2026-09-06" },
  });
  const xl = report.skus.find((s) => s.sku === "P-XL");
  assert.strictEqual(xl.recommendation, "CLEARANCE_CANDIDATE");
  const prod = report.products.find((p) => p.product === "Tee");
  assert.ok(prod);
  assert.strictEqual(prod.shared_product_price, true);
  assert.strictEqual(prod.has_variant_stockout_risk, true);
  assert.strictEqual(prod.mixed_inventory_signal, true);
  assert.ok(
    ["MIXED_VARIANT_REVIEW", "PROTECT_PRICE_PRODUCT_WIDE"].includes(
      prod.recommendation
    )
  );
  assert.notStrictEqual(prod.recommendation, "CLEARANCE_CANDIDATE");
  assert.ok(prod.explanation && /product-wide markdown/i.test(prod.explanation));
});

test("all variants clearance => product clearance allowed", () => {
  const report = buildPricingReport({
    inventorySkus: [
      {
        sku: "A-S",
        product: "DeadTee",
        variant: "S",
        current_stock: 10,
        unit_cost: 500,
        inventory_value: 5000,
        stock_class: "NO_DEMAND",
        stock_trusted: true,
        data_quality_warnings: [],
      },
      {
        sku: "A-L",
        product: "DeadTee",
        variant: "L",
        current_stock: 12,
        unit_cost: 500,
        inventory_value: 6000,
        stock_class: "NO_DEMAND",
        stock_trusted: true,
        data_quality_warnings: [],
      },
    ],
    shopifyPrices: [
      {
        sku: "A-S",
        product: "DeadTee",
        current_price: 2000,
        product_published_at: "2025-01-01T00:00:00Z",
      },
      {
        sku: "A-L",
        product: "DeadTee",
        current_price: 2000,
        product_published_at: "2025-01-01T00:00:00Z",
      },
    ],
    period: { until: "2026-09-06" },
  });
  const prod = report.products.find((p) => p.product === "DeadTee");
  assert.strictEqual(prod.recommendation, "CLEARANCE_CANDIDATE");
  assert.strictEqual(prod.product_wide_markdown, true);
  assert.strictEqual(prod.mixed_inventory_signal, false);
});

test("variant-specific prices retain per-variant guidance", () => {
  const report = buildPricingReport({
    inventorySkus: [
      {
        sku: "V-S",
        product: "Sized",
        variant: "S",
        current_stock: 1,
        unit_cost: 500,
        inventory_value: 500,
        stock_class: "CRITICAL",
        units_sold_30d: 5,
        demand_trend: "stable",
        stock_trusted: true,
        data_quality_warnings: [],
      },
      {
        sku: "V-XL",
        product: "Sized",
        variant: "XL",
        current_stock: 30,
        unit_cost: 500,
        inventory_value: 15000,
        stock_class: "NO_DEMAND",
        stock_trusted: true,
        data_quality_warnings: [],
      },
    ],
    shopifyPrices: [
      {
        sku: "V-S",
        product: "Sized",
        current_price: 1500,
        product_published_at: "2025-01-01T00:00:00Z",
      },
      {
        sku: "V-XL",
        product: "Sized",
        current_price: 1800,
        product_published_at: "2025-01-01T00:00:00Z",
      },
    ],
    period: { until: "2026-09-06" },
  });
  const s = report.skus.find((x) => x.sku === "V-S");
  const xl = report.skus.find((x) => x.sku === "V-XL");
  assert.ok(["PROTECT_PRICE", "PRICE_INCREASE_CANDIDATE"].includes(s.recommendation));
  assert.strictEqual(xl.recommendation, "CLEARANCE_CANDIDATE");
  const prod = report.products.find((p) => p.product === "Sized");
  assert.strictEqual(prod.shared_product_price, false);
  assert.strictEqual(prod.product_wide_markdown, false);
  // Variant rows remain independently actionable
  assert.ok(report.clearance_candidates.some((c) => c.sku === "V-XL"));
});

test("configurable min margin via thresholds", () => {
  const t = resolvePricingThresholds({ min_gross_margin_pct: 30 });
  assert.strictEqual(t.min_gross_margin_pct, 30);
  const floor = minimumAccountingSafeStickerPrice(1400, 30);
  const { revenueExTax } = splitInclusiveTax(floor, true);
  const gm = (revenueExTax - 1400) / revenueExTax;
  assert.ok(gm + 1e-9 >= 0.3);
});

test("GP cannot be preserved when discounted GP <= 0", () => {
  const sim = simulateDiscount(1000, 900, 20); // sell 800 < cost
  assert.strictEqual(sim.below_cost, true);
  assert.strictEqual(sim.units_required_to_match_current_gp, null);
});

if (!process.exitCode) {
  console.log("\nAll pricing self-tests passed.");
}
