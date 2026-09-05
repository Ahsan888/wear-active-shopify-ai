#!/usr/bin/env node
/**
 * Pure-function tests for Phase 3 decision intelligence.
 * No live Meta / Sheets calls.
 */
const assert = require("assert");
const { classifyBusinessHealth } = require("../decisions/business");
const {
  classifyBusinessAdvertisingSafety,
  buildRoasCrossProvenanceDiagnostic,
} = require("../decisions/advertising");
const {
  classifyMetaEntity,
  diagnoseFunnel,
  buildAccountFunnelBaselines,
} = require("../decisions/entities");
const { classifyProducts } = require("../decisions/products");
const { buildConfidenceAndGates } = require("../decisions/confidence");
const {
  buildRecommendations,
  sortRecommendations,
} = require("../decisions/recommendations");
const { buildDecisionReport } = require("../decisions/report");

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

test("business health status precedence strongly_profitable over profitable", () => {
  const r = classifyBusinessHealth({
    meta_adjusted_profit: 100000,
    meta_adjusted_margin_pct: 20,
    gross_margin_pct: 30,
    recognized_orders: 20,
    net_revenue_ex_tax: 500000,
  });
  assert.strictEqual(r.status, "strongly_profitable");
});

test("meta-adjusted positive profitable / negative unprofitable", () => {
  assert.strictEqual(
    classifyBusinessHealth({
      meta_adjusted_profit: 50000,
      meta_adjusted_margin_pct: 12,
      gross_margin_pct: 25,
      recognized_orders: 8,
      net_revenue_ex_tax: 400000,
    }).status,
    "profitable"
  );
  assert.strictEqual(
    classifyBusinessHealth({
      meta_adjusted_profit: -1000,
      meta_adjusted_margin_pct: -1,
      gross_margin_pct: 25,
      recognized_orders: 20,
      net_revenue_ex_tax: 400000,
    }).status,
    "unprofitable"
  );
});

test("business blended CPA comfortably below BE CPA → large_safety_margin", () => {
  const r = classifyBusinessAdvertisingSafety({
    meta_spend: 9000,
    recognized_orders: 29,
    break_even_cpa: 2670,
    break_even_ad_spend: 77400,
    net_revenue_ex_tax: 311000,
    blended_ad_cost_per_recognized_order: 310,
  });
  assert.strictEqual(r.status, "large_safety_margin");
  assert.ok(r.business_cpa_headroom_pct >= 40);
});

test("business blended CPA near BE", () => {
  const r = classifyBusinessAdvertisingSafety({
    meta_spend: 25000,
    recognized_orders: 10,
    break_even_cpa: 2700,
    break_even_ad_spend: 27000,
    net_revenue_ex_tax: 100000,
    blended_ad_cost_per_recognized_order: 2500,
  });
  assert.strictEqual(r.status, "near_break_even");
});

test("business blended CPA above BE", () => {
  const r = classifyBusinessAdvertisingSafety({
    meta_spend: 40000,
    recognized_orders: 10,
    break_even_cpa: 2700,
    break_even_ad_spend: 27000,
    net_revenue_ex_tax: 100000,
    blended_ad_cost_per_recognized_order: 4000,
  });
  assert.strictEqual(r.status, "above_break_even");
});

test("Meta CPA does NOT determine business health or business ads safety", () => {
  // High Meta CPA but low blended ad cost / order → still large safety
  const ads = classifyBusinessAdvertisingSafety({
    meta_spend: 9000,
    recognized_orders: 29,
    break_even_cpa: 2670,
    break_even_ad_spend: 77400,
    net_revenue_ex_tax: 311000,
  });
  assert.strictEqual(ads.status, "large_safety_margin");
  // Meta CPA 2236 would be "near" BE 2670 if wrongly compared — must not drive status
  assert.ok(ads.blended_ad_cost_per_recognized_order < 400);
  assert.ok(!("meta_attributed_cpa" in ads) || ads.meta_attributed_cpa == null);

  const health = classifyBusinessHealth({
    meta_adjusted_profit: 68000,
    meta_adjusted_margin_pct: 22,
    gross_margin_pct: 30,
    recognized_orders: 29,
    net_revenue_ex_tax: 311000,
  });
  assert.strictEqual(health.status, "strongly_profitable");
});

const accountMeta = {
  cpa: 2000,
  roas: 1.5,
  impressions: 50000,
  clicks: 1000,
  inline_link_clicks: 800,
  landing_page_views: 600,
  add_to_carts: 30,
  initiated_checkouts: 18,
  purchases: 10,
  ctr: 2.0,
  lpv_to_atc_pct: 5,
  atc_to_checkout_pct: 60,
  checkout_to_purchase_pct: 55,
};

test("Meta zero-purchase insufficient evidence", () => {
  const e = classifyMetaEntity(
    { spend: 200, purchases: 0, ad_id: "1", ad_name: "tiny" },
    accountMeta,
    { entity_type: "ad" }
  );
  assert.strictEqual(e.status, "insufficient_data");
});

test("Meta zero-purchase watch", () => {
  const e = classifyMetaEntity(
    { spend: 800, purchases: 0, ad_id: "2", ad_name: "watch" },
    accountMeta,
    { entity_type: "ad" }
  );
  assert.strictEqual(e.status, "watch");
});

test("Meta zero-purchase meaningful spend", () => {
  const e = classifyMetaEntity(
    { spend: 1800, purchases: 0, ad_id: "3", ad_name: "snp" },
    accountMeta,
    { entity_type: "ad" }
  );
  assert.strictEqual(e.status, "spend_no_purchase");
});

test("Meta high-priority zero-purchase", () => {
  const e = classifyMetaEntity(
    { spend: 3000, purchases: 0, ad_id: "4", ad_name: "hi" },
    accountMeta,
    { entity_type: "ad" }
  );
  assert.strictEqual(e.status, "high_priority_spend_no_purchase");
});

test("Entity high CPA vs account Meta CPA", () => {
  const e = classifyMetaEntity(
    {
      spend: 4000,
      purchases: 1,
      cpa: 4000,
      roas: 0.8,
      ad_id: "5",
      ad_name: "highcpa",
    },
    accountMeta,
    { entity_type: "ad" }
  );
  assert.strictEqual(e.status, "high_cpa");
});

test("Healthy Meta entity", () => {
  const e = classifyMetaEntity(
    {
      spend: 3000,
      purchases: 2,
      cpa: 1500,
      roas: 1.6,
      impressions: 500,
      ad_id: "6",
      ad_name: "ok",
    },
    accountMeta,
    { entity_type: "ad" }
  );
  assert.ok(["healthy", "strong"].includes(e.status));
});

test("Scale candidate when all gates pass", () => {
  const e = classifyMetaEntity(
    {
      spend: 5000,
      purchases: 4,
      cpa: 1250,
      roas: 1.8,
      impressions: 500,
      ad_id: "7",
      ad_name: "scale",
    },
    accountMeta,
    {
      entity_type: "ad",
      business_health_ok: true,
      business_ads_ok: true,
      confidence_ok: true,
      accounting_scale_ok: true,
    }
  );
  assert.strictEqual(e.status, "scale_candidate");
  assert.strictEqual(e.scale_eligible, true);
});

test("Scale suppressed because business economics weak", () => {
  const e = classifyMetaEntity(
    {
      spend: 5000,
      purchases: 4,
      cpa: 1250,
      roas: 1.8,
      ad_id: "8",
      ad_name: "noscale",
    },
    accountMeta,
    {
      entity_type: "ad",
      business_health_ok: false,
      business_ads_ok: true,
      confidence_ok: true,
      accounting_scale_ok: true,
    }
  );
  assert.notStrictEqual(e.status, "scale_candidate");
  assert.strictEqual(e.scale_eligible, false);
});

test("Scale suppressed because duplicate accounting warning", () => {
  const gates = buildConfidenceAndGates({
    warnings: [
      {
        code: "possible_duplicate_ledger_expense",
        severity: "warning",
        message: "dup",
      },
    ],
    ad_reconciliation: {},
    books: { recognized_orders: 20 },
    is_full_calendar_month: true,
    meta_spend: 10000,
  });
  assert.strictEqual(gates.gates.suppress_scale, true);
  assert.strictEqual(gates.gates.confidence_ok_for_scale, false);
  assert.strictEqual(gates.confidence.business, "medium");

  const e = classifyMetaEntity(
    {
      spend: 5000,
      purchases: 4,
      cpa: 1250,
      roas: 1.8,
      ad_id: "9",
      ad_name: "dupblock",
    },
    accountMeta,
    {
      entity_type: "ad",
      business_health_ok: true,
      business_ads_ok: true,
      confidence_ok: gates.gates.confidence_ok_for_scale,
      accounting_scale_ok: !gates.gates.suppress_scale,
    }
  );
  assert.notStrictEqual(e.status, "scale_candidate");
});

test("Weak CTR relative to account", () => {
  const d = diagnoseFunnel(
    {
      impressions: 5000,
      clicks: 20,
      ctr: 0.4,
      inline_link_clicks: 15,
      landing_page_views: 10,
      add_to_carts: 1,
      initiated_checkouts: 0,
      purchases: 0,
    },
    buildAccountFunnelBaselines(accountMeta)
  );
  assert.ok(d.diagnostics.some((x) => x.code === "creative_click_weak"));
});

test("Weak LPV→ATC relative to account", () => {
  const d = diagnoseFunnel(
    {
      impressions: 5000,
      clicks: 100,
      ctr: 2,
      inline_link_clicks: 80,
      landing_page_views: 50,
      add_to_carts: 1,
      lpv_to_atc_pct: 2,
      initiated_checkouts: 0,
      purchases: 0,
    },
    { ...buildAccountFunnelBaselines(accountMeta), lpv_to_atc_pct: 5 }
  );
  assert.ok(d.diagnostics.some((x) => x.code === "offer_atc_weak"));
});

test("Funnel volume gate prevents noisy classification", () => {
  const d = diagnoseFunnel(
    {
      impressions: 100,
      clicks: 2,
      ctr: 0.1,
      inline_link_clicks: 2,
      landing_page_views: 1,
      add_to_carts: 0,
      initiated_checkouts: 0,
      purchases: 0,
    },
    buildAccountFunnelBaselines(accountMeta)
  );
  assert.strictEqual(d.diagnostics.length, 0);
});

test("Product hero top-3 GP", () => {
  const { products } = classifyProducts([
    {
      sku: "A",
      product: "HeroA",
      units: 10,
      revenue_ex_tax: 10000,
      cogs: 4000,
      gross_profit: 6000,
      gross_margin_pct: 60,
      flags: [],
    },
    {
      sku: "B",
      product: "B",
      units: 5,
      revenue_ex_tax: 5000,
      cogs: 2500,
      gross_profit: 2500,
      gross_margin_pct: 50,
      flags: [],
    },
    {
      sku: "C",
      product: "C",
      units: 4,
      revenue_ex_tax: 4000,
      cogs: 2000,
      gross_profit: 2000,
      gross_margin_pct: 50,
      flags: [],
    },
    {
      sku: "D",
      product: "D",
      units: 2,
      revenue_ex_tax: 1000,
      cogs: 400,
      gross_profit: 600,
      gross_margin_pct: 60,
      flags: [],
    },
  ]);
  assert.strictEqual(products.find((p) => p.sku === "A").status, "hero");
});

test("Strong-margin low-volume", () => {
  const { products } = classifyProducts([
    {
      sku: "BIG",
      product: "Big",
      units: 50,
      revenue_ex_tax: 90000,
      cogs: 60000,
      gross_profit: 30000,
      gross_margin_pct: 33,
      flags: [],
    },
    {
      sku: "B2",
      product: "Big2",
      units: 40,
      revenue_ex_tax: 80000,
      cogs: 52000,
      gross_profit: 28000,
      gross_margin_pct: 35,
      flags: [],
    },
    {
      sku: "B3",
      product: "Big3",
      units: 30,
      revenue_ex_tax: 70000,
      cogs: 45000,
      gross_profit: 25000,
      gross_margin_pct: 36,
      flags: [],
    },
    {
      sku: "SM",
      product: "Niche",
      units: 1,
      revenue_ex_tax: 2000,
      cogs: 400,
      gross_profit: 1600,
      gross_margin_pct: 80,
      flags: [],
    },
  ]);
  assert.strictEqual(
    products.find((p) => p.sku === "SM").status,
    "strong_margin_low_volume"
  );
});

test("High-volume weak-margin", () => {
  const { products } = classifyProducts([
    {
      sku: "W",
      product: "Weak",
      units: 40,
      revenue_ex_tax: 50000,
      cogs: 46000,
      gross_profit: 4000,
      gross_margin_pct: 8,
      flags: ["low_margin"],
    },
    {
      sku: "O",
      product: "Other",
      units: 5,
      revenue_ex_tax: 10000,
      cogs: 5000,
      gross_profit: 5000,
      gross_margin_pct: 50,
      flags: [],
    },
  ]);
  assert.strictEqual(
    products.find((p) => p.sku === "W").status,
    "high_volume_weak_margin"
  );
});

test("Negative margin product", () => {
  const { products } = classifyProducts([
    {
      sku: "N",
      product: "Neg",
      units: 2,
      revenue_ex_tax: 1000,
      cogs: 1500,
      gross_profit: -500,
      gross_margin_pct: -50,
      flags: ["negative_margin"],
    },
  ]);
  assert.strictEqual(products[0].status, "negative_margin");
});

test("Missing SKU/cost → data_issue", () => {
  const { products } = classifyProducts([
    {
      sku: null,
      product: "Cotton",
      units: 100,
      revenue_ex_tax: 200000,
      cogs: 100000,
      gross_profit: 100000,
      gross_margin_pct: 50,
      flags: [],
    },
  ]);
  assert.strictEqual(products[0].status, "data_issue");
});

test("Meta ROAS vs BE ROAS does not independently flip advertising health", () => {
  const ads = classifyBusinessAdvertisingSafety({
    meta_spend: 9000,
    recognized_orders: 29,
    break_even_cpa: 2670,
    break_even_ad_spend: 77400,
    net_revenue_ex_tax: 311000,
  });
  assert.strictEqual(ads.status, "large_safety_margin");
  const diag = buildRoasCrossProvenanceDiagnostic({
    meta_roas: 1.21,
    break_even_roas: 4.02,
    meta_adjusted_profit: 68000,
  });
  assert.strictEqual(diag.label, "cross_provenance_diagnostic");
  assert.strictEqual(diag.contradictory_with_meta_adjusted_profit, true);
  // Health unchanged by ROAS diagnostic
  assert.strictEqual(ads.status, "large_safety_margin");
});

test("Attribution always unavailable for Meta→Shopify claims", () => {
  const report = buildDecisionReport({
    date_range: {
      since: "2026-08-01",
      until: "2026-08-07",
      timezone: "Asia/Karachi",
      is_full_calendar_month: false,
    },
    books: {
      net_revenue_ex_tax: 100000,
      gross_margin_pct: 30,
      recognized_orders: 20,
      recognized_units: 50,
    },
    profitability: {
      meta_adjusted_profit: 20000,
      meta_adjusted_margin_pct: 20,
      break_even_cpa: 2000,
      break_even_ad_spend: 40000,
      break_even_roas: 4,
      profit_before_ads: 40000,
    },
    blended: { blended_ad_cost_per_recognized_order: 500 },
    meta: {
      account: { currency: "PKR" },
      totals: {
        spend: 10000,
        purchases: 5,
        cpa: 2000,
        roas: 1.5,
        purchase_value: 15000,
        impressions: 10000,
        clicks: 200,
        landing_page_views: 150,
        add_to_carts: 10,
        initiated_checkouts: 6,
        ctr: 2,
        lpv_to_atc_pct: 6.6,
        atc_to_checkout_pct: 60,
        checkout_to_purchase_pct: 83,
      },
    },
    products: [],
    warnings: [],
    campaigns: [],
    ads: [],
  });
  assert.strictEqual(report.no_order_level_attribution, true);
  assert.strictEqual(report.confidence.attribution, "unavailable");
  assert.ok(
    report.recommendations.some(
      (r) => r.reason_code === "no_order_level_attribution"
    )
  );
});

test("Recommendation priority ordering", () => {
  const sorted = sortRecommendations([
    { id: "a", priority: "info" },
    { id: "b", priority: "critical" },
    { id: "c", priority: "medium" },
    { id: "d", priority: "high" },
  ]);
  assert.deepStrictEqual(
    sorted.map((r) => r.priority),
    ["critical", "high", "medium", "info"]
  );
});

test("Zero Meta spend → meta efficiency insufficient", () => {
  const report = buildDecisionReport({
    date_range: {
      since: "2026-01-01",
      until: "2026-01-07",
      is_full_calendar_month: false,
    },
    books: {
      net_revenue_ex_tax: 50000,
      gross_margin_pct: 30,
      recognized_orders: 10,
    },
    profitability: {
      meta_adjusted_profit: 10000,
      meta_adjusted_margin_pct: 20,
      break_even_cpa: 1500,
      break_even_ad_spend: 15000,
      break_even_roas: 4,
      profit_before_ads: 15000,
    },
    blended: { blended_ad_cost_per_recognized_order: 0 },
    meta: { account: {}, totals: { spend: 0, purchases: 0 } },
    products: [],
    warnings: [],
    campaigns: [],
    ads: [],
  });
  assert.strictEqual(report.meta_efficiency.status, "insufficient_data");
});

test("Zero Books orders → insufficient_data business health", () => {
  const r = classifyBusinessHealth({
    meta_adjusted_profit: 0,
    meta_adjusted_margin_pct: null,
    gross_margin_pct: null,
    recognized_orders: 0,
    net_revenue_ex_tax: 0,
  });
  assert.strictEqual(r.status, "insufficient_data");
  const ads = classifyBusinessAdvertisingSafety({
    meta_spend: 5000,
    recognized_orders: 0,
    break_even_cpa: null,
    break_even_ad_spend: 0,
    net_revenue_ex_tax: 0,
  });
  assert.strictEqual(ads.status, "insufficient_data");
});

test("Tiny 1-purchase high ROAS ad is NOT scale_candidate", () => {
  const e = classifyMetaEntity(
    {
      spend: 100,
      purchases: 1,
      cpa: 100,
      roas: 22,
      ad_id: "tiny",
      ad_name: "lucky",
    },
    accountMeta,
    {
      entity_type: "ad",
      business_health_ok: true,
      business_ads_ok: true,
      confidence_ok: true,
      accounting_scale_ok: true,
    }
  );
  assert.notStrictEqual(e.status, "scale_candidate");
});

if (!process.exitCode) {
  console.log("\nAll decision intelligence pure-function tests passed.");
}
