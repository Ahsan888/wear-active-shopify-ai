#!/usr/bin/env node
/**
 * Pure tests for Phase 3.5 sales provenance + dashboard rendering.
 */
const assert = require("assert");
const {
  saleChannel,
  addSaleToChannelAcc,
  emptyChannelAccumulators,
  finalizeChannelAcc,
  buildSalesMixSummary,
  computeAdLoadMetrics,
} = require("../profitability/salesMix");
const { aggregateLedgerPeriod } = require("../profitability/books");
const { classifyBusinessAdvertisingSafety } = require("../decisions/advertising");
const { buildDecisionReport } = require("../decisions/report");
const { renderDecisionDashboard } = require("../dashboard/html");
const { groupProductsByName } = require("../dashboard/groups");
const { escapeHtml } = require("../dashboard/format");

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

const ledgerHeader = [
  "Date",
  "Entry Type",
  "Source",
  "Category",
  "Description",
  "SKU",
  "Qty",
  "Debit",
  "Credit",
  "Owner",
  "Partner Split",
  "Ref Key",
  "Notes",
  "Created At",
];

test("Shopify sale identified by Shopify source", () => {
  assert.strictEqual(saleChannel("Shopify", "SALE:x"), "Shopify");
});

test("Shopify sale identified by Shopify SALE ref", () => {
  assert.strictEqual(saleChannel("Manual", "SALE:SHOPIFY|#100:a"), "Shopify");
  assert.strictEqual(saleChannel("", "SALE:SHOPIFY|oid|line"), "Shopify");
});

test("Manual sale maps to Manual", () => {
  assert.strictEqual(saleChannel("Manual", "SALE:MANUAL:1"), "Manual");
  assert.strictEqual(saleChannel("Walk-in", "SALE:WALKIN:1"), "Manual");
});

test("Other Sales maps to Other Sales", () => {
  assert.strictEqual(saleChannel("Other Sales", "SALE:OTHER:1"), "Other Sales");
});

test("Multi-line Shopify order counts once", () => {
  const acc = emptyChannelAccumulators();
  addSaleToChannelAcc(acc, {
    source: "Shopify",
    ref: "SALE:SHOPIFY|#55|line1",
    ymd: "2026-08-01",
    sku: "A",
    credit: 1000,
    qty: 1,
  });
  addSaleToChannelAcc(acc, {
    source: "Shopify",
    ref: "SALE:SHOPIFY|#55|line2",
    ymd: "2026-08-01",
    sku: "B",
    credit: 500,
    qty: 1,
  });
  const fin = finalizeChannelAcc(acc);
  assert.strictEqual(fin.Shopify.orders, 1);
  assert.strictEqual(fin.Shopify.revenue_ex_tax, 1500);
  assert.strictEqual(fin.Shopify.units, 2);
});

test("Multi-line Manual transaction counts by order-key behavior", () => {
  const acc = emptyChannelAccumulators();
  // Same uid → same order key
  addSaleToChannelAcc(acc, {
    source: "Manual",
    ref: "SALE:MANUAL-BATCH-9",
    ymd: "2026-08-02",
    sku: "A",
    credit: 2000,
    qty: 2,
  });
  addSaleToChannelAcc(acc, {
    source: "Manual",
    ref: "SALE:MANUAL-BATCH-9",
    ymd: "2026-08-02",
    sku: "B",
    credit: 1000,
    qty: 1,
  });
  const fin = finalizeChannelAcc(acc);
  assert.strictEqual(fin.Manual.orders, 1);
  assert.strictEqual(fin.Manual.revenue_ex_tax, 3000);
});

test("Revenue/units aggregate per channel", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "Sale", "Manual", "", "Tee", "S1", "2", "", "2000", "", "", "SALE:MANUAL:1", "", ""],
    ["2026-08-01", "Sale", "Other Sales", "", "Tee", "S1", "1", "", "500", "", "", "SALE:OTHER:1", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Shopify.revenue_ex_tax, 1000);
  assert.strictEqual(agg.sales_by_channel.Manual.revenue_ex_tax, 2000);
  assert.strictEqual(agg.sales_by_channel["Other Sales"].revenue_ex_tax, 500);
  assert.strictEqual(agg.sales_by_channel.Shopify.units, 1);
  assert.strictEqual(agg.sales_by_channel.Manual.units, 2);
});

test("Total channel revenue equals total sale revenue", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "Sale", "Manual", "", "Tee", "S1", "1", "", "2500", "", "", "SALE:MANUAL:2", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  const sum =
    agg.sales_by_channel.Shopify.revenue_ex_tax +
    agg.sales_by_channel.Manual.revenue_ex_tax +
    agg.sales_by_channel["Other Sales"].revenue_ex_tax;
  assert.strictEqual(sum, agg.books.revenue_ex_tax);
});

test("Global recognized order count behavior unchanged", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1|a", "", ""],
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S2", "1", "", "500", "", "", "SALE:SHOPIFY|#1|b", "", ""],
    ["2026-08-01", "Sale", "Manual", "", "Tee", "S1", "1", "", "800", "", "", "SALE:MANUAL:9", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.books.recognized_orders, 2); // shopify order + manual
  assert.strictEqual(agg.books.shopify_recognized_orders, 1);
  assert.strictEqual(agg.books.manual_recognized_orders, 1);
});

test("Gifts do not become paid channel revenue", () => {
  const rows = [
    ["2026-08-01", "Gift", "Shopify", "", "Gift", "S1", "1", "", "0", "", "", "GIFT:SHOPIFY|#9:a", "", ""],
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Shopify.revenue_ex_tax, 1000);
  assert.strictEqual(agg.books.gift_units, 1);
  assert.strictEqual(agg.books.recognized_orders, 1);
});

test("business-wide ad load uses all recognized orders", () => {
  const m = computeAdLoadMetrics({
    meta_spend: 9000,
    recognized_orders: 30,
    shopify_recognized_orders: 18,
  });
  assert.strictEqual(m.business_wide_ad_load_per_recognized_order, 300);
});

test("Shopify ad load uses only Shopify recognized orders", () => {
  const m = computeAdLoadMetrics({
    meta_spend: 9000,
    recognized_orders: 30,
    shopify_recognized_orders: 18,
  });
  assert.strictEqual(m.shopify_ad_load_per_recognized_order, 500);
});

test("zero Shopify orders → Shopify ad load null", () => {
  const m = computeAdLoadMetrics({
    meta_spend: 9000,
    recognized_orders: 10,
    shopify_recognized_orders: 0,
  });
  assert.strictEqual(m.shopify_ad_load_per_recognized_order, null);
});

test("Shopify ad load never drives business ads safety", () => {
  // High Shopify load but low business-wide load → still large safety
  const safety = classifyBusinessAdvertisingSafety({
    meta_spend: 9000,
    recognized_orders: 29,
    break_even_cpa: 2670,
    break_even_ad_spend: 77400,
    net_revenue_ex_tax: 311000,
  });
  assert.strictEqual(safety.status, "large_safety_margin");
  const shopifyLoad = 9000 / 10; // if wrongly used with 10 shopify orders
  assert.ok(shopifyLoad > safety.business_wide_ad_load_per_recognized_order);
});

test("Meta CPA remains separate", () => {
  const report = buildDecisionReport({
    date_range: { since: "2026-08-01", until: "2026-08-07", is_full_calendar_month: false },
    books: {
      net_revenue_ex_tax: 100000,
      revenue_ex_tax: 100000,
      gross_margin_pct: 30,
      recognized_orders: 20,
      shopify_recognized_orders: 12,
    },
    profitability: {
      meta_adjusted_profit: 20000,
      meta_adjusted_margin_pct: 20,
      break_even_cpa: 2000,
      break_even_ad_spend: 40000,
      profit_before_ads: 40000,
    },
    blended: {
      business_wide_ad_load_per_recognized_order: 500,
      shopify_ad_load_per_recognized_order: 833.33,
      blended_ad_cost_per_recognized_order: 500,
    },
    sales_by_channel: {
      Shopify: { orders: 12, units: 20, revenue_ex_tax: 60000 },
      Manual: { orders: 5, units: 8, revenue_ex_tax: 30000 },
      "Other Sales": { orders: 3, units: 4, revenue_ex_tax: 10000 },
    },
    sales_mix: buildSalesMixSummary(
      {
        Shopify: { orders: 12, units: 20, revenue_ex_tax: 60000 },
        Manual: { orders: 5, units: 8, revenue_ex_tax: 30000 },
        "Other Sales": { orders: 3, units: 4, revenue_ex_tax: 10000 },
      },
      { recognized_orders: 20, recognized_units: 32, revenue_ex_tax: 100000 }
    ),
    meta: {
      account: { currency: "PKR" },
      totals: { spend: 10000, purchases: 4, cpa: 2500, roas: 1.2, impressions: 1000, ctr: 2 },
    },
    products: [],
    warnings: [],
    campaigns: [],
    ads: [],
  });
  assert.strictEqual(report.meta_efficiency.meta_attributed_cpa, 2500);
  assert.notStrictEqual(
    report.meta_efficiency.meta_attributed_cpa,
    report.business_advertising_safety.business_wide_ad_load_per_recognized_order
  );
  assert.strictEqual(report.shopify_context.shopify_ad_load_per_recognized_order, 833.33);
});

function fixtureReport(overrides = {}) {
  const base = {
    generated_at: "2026-09-06T00:00:00.000Z",
    date_range: {
      since: "2026-08-31",
      until: "2026-09-06",
      timezone: "Asia/Karachi",
      is_full_calendar_month: false,
    },
    safety: { advisory_only: true, mutations: "none" },
    business_health: {
      status: "strongly_profitable",
      reason: "strong margins",
    },
    business_advertising_safety: {
      status: "large_safety_margin",
      meta_spend: 9000,
      business_wide_ad_load_per_recognized_order: 310,
      blended_ad_cost_per_recognized_order: 310,
      break_even_cpa: 2670,
      business_cpa_headroom: 2360,
      business_cpa_headroom_pct: 88,
      ad_spend_utilization_pct: 12,
    },
    shopify_context: {
      shopify_recognized_orders: 17,
      shopify_ad_load_per_recognized_order: 529,
      note: "Meta spend divided by recognized Shopify orders. Not CAC.",
    },
    sales_mix: buildSalesMixSummary(
      {
        Shopify: { orders: 17, units: 100, revenue_ex_tax: 200000 },
        Manual: { orders: 9, units: 50, revenue_ex_tax: 90000 },
        "Other Sales": { orders: 3, units: 18, revenue_ex_tax: 21000 },
      },
      { recognized_orders: 29, recognized_units: 168, revenue_ex_tax: 311000 }
    ),
    sales_by_channel: {
      Shopify: { orders: 17, units: 100, revenue_ex_tax: 200000 },
      Manual: { orders: 9, units: 50, revenue_ex_tax: 90000 },
      "Other Sales": { orders: 3, units: 18, revenue_ex_tax: 21000 },
    },
    books: {
      net_revenue_ex_tax: 311000,
      revenue_ex_tax: 311000,
      gross_margin_pct: 30,
      recognized_orders: 29,
      shopify_recognized_orders: 17,
    },
    profitability: {
      meta_adjusted_profit: 68000,
      meta_adjusted_margin_pct: 22,
      break_even_cpa: 2670,
      break_even_ad_spend: 77400,
    },
    meta_efficiency: {
      status: "ok",
      meta_attributed_cpa: 2250,
      meta_attributed_roas: 1.2,
      meta_attributed_purchases: 4,
      meta_spend: 9000,
    },
    meta: {
      account: { currency: "PKR", name: "WA" },
      totals: {
        spend: 9000,
        purchases: 4,
        cpa: 2250,
        roas: 1.2,
        impressions: 20000,
        ctr: 2.1,
      },
      funnel_baselines: {
        ctr: 2.1,
        lpv_to_atc_pct: 5,
        atc_to_checkout_pct: 60,
        checkout_to_purchase_pct: 50,
      },
    },
    products: [
      {
        sku: "WA-FF-1",
        product: "FlexFlow",
        status: "data_issue",
        reason_code: "missing_ledger_cogs",
        reason: "Missing Ledger COGS",
        revenue_ex_tax: 5000,
        units: 2,
        gross_profit: 5000,
        gross_margin_pct: 100,
        revenue_share_pct: 2,
        evidence: { expected_vm_cogs: 2000 },
        expected_vm_cogs: 2000,
      },
      {
        sku: "WA-FF-2",
        product: "FlexFlow",
        status: "data_issue",
        reason_code: "missing_ledger_cogs",
        reason: "Missing Ledger COGS",
        revenue_ex_tax: 5000,
        units: 2,
        gross_profit: 5000,
        gross_margin_pct: 100,
        revenue_share_pct: 2,
        evidence: { expected_vm_cogs: 2000 },
        expected_vm_cogs: 2000,
      },
    ],
    recommendations: [
      {
        id: "1",
        priority: "high",
        action: "review_high_cpa",
        area: "ad",
        entity_name: "Ad A",
        reason: "High CPA",
        reason_code: "high_cpa",
        confidence: "medium",
      },
      {
        id: "2",
        priority: "medium",
        action: "fix_product_data",
        area: "product",
        entity_name: "FlexFlow",
        reason: "Missing Ledger COGS",
        reason_code: "missing_ledger_cogs",
        confidence: "low",
      },
      {
        id: "3",
        priority: "low",
        action: "monitor",
        area: "product",
        entity_name: "Hero",
        reason: "Hero product",
        reason_code: "hero_product",
        confidence: "high",
      },
    ],
    ads: [],
    campaigns: [],
    confidence: {
      business: "high",
      advertising: "high",
      entities: "medium",
      products: "medium",
      attribution: "unavailable",
      notes: { attribution: "No Meta→Shopify attribution" },
    },
    data_quality: {
      warnings: [
        {
          code: "meta_vs_ledger_ads_variance",
          severity: "warning",
          message: "Meta spend differs from Ledger Ads",
        },
      ],
      ad_reconciliation: {
        meta_spend: 9000,
        ledger_ads_expense: 0,
        recurring_ads_expense: 0,
        meta_vs_ledger_variance: 9000,
        ad_spend_reconciliation_status: "partial_period_not_comparable",
      },
    },
    no_order_level_attribution: true,
  };
  return { ...base, ...overrides };
}

test("HTML renders business status", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("STRONGLY PROFITABLE"));
});

test("HTML renders sales mix", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("Sales Mix"));
  assert.ok(html.includes("Shopify"));
  assert.ok(html.includes("Manual"));
  assert.ok(html.includes("Other Sales"));
});

test("HTML renders Shopify ad-load label", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("Shopify ad load"));
});

test("HTML contains non-attribution disclaimer", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(/Not CAC|does not mean every Shopify order came from Meta|No Meta→Shopify/i.test(html));
});

test("HTML renders high/medium/low recommendations", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("<h3>High</h3>"));
  assert.ok(html.includes("<h3>Medium</h3>"));
  assert.ok(html.includes("<h3>Low</h3>"));
  assert.ok(html.includes("review_high_cpa"));
});

test("groups duplicate product names visually while preserving SKU evidence", () => {
  const groups = groupProductsByName(fixtureReport().products);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].sku_count, 2);
  assert.strictEqual(groups[0].skus.length, 2);
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("WA-FF-1"));
  assert.ok(html.includes("WA-FF-2"));
  assert.ok(html.includes("2 SKU"));
});

test("data issue product renders warning rather than hero styling", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("DATA ISSUE"));
  assert.ok(html.includes("missing_ledger_cogs") || html.includes("Missing Ledger COGS"));
  assert.ok(!html.includes(">HERO<"));
});

test("no scale candidate shows safe empty state", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("No ads currently have enough evidence for controlled scaling"));
});

test("scale candidate displays controlled-review language", () => {
  const html = renderDecisionDashboard(
    fixtureReport({
      ads: [
        {
          entity_type: "ad",
          entity_id: "1",
          entity_name: "Winner Ad",
          status: "scale_candidate",
          spend: 5000,
          purchases: 5,
          meta_attributed_cpa: 1000,
          meta_attributed_roas: 2,
          has_funnel_warning: false,
        },
      ],
    })
  );
  assert.ok(html.includes("Controlled review candidate"));
  assert.ok(html.includes("do not auto-scale"));
});

test("accounting variance appears", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("meta_vs_ledger_ads_variance") || html.includes("Meta − Ledger"));
});

test("HTML escapes entity/product names correctly", () => {
  assert.strictEqual(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  const html = renderDecisionDashboard(
    fixtureReport({
      products: [
        {
          sku: "X",
          product: `<img src=x onerror=alert(1)>`,
          status: "hero",
          reason_code: "top",
          reason: "ok",
          revenue_ex_tax: 1000,
          units: 1,
          gross_profit: 400,
          gross_margin_pct: 40,
          revenue_share_pct: 10,
          cogs: 600,
        },
      ],
    })
  );
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img"));
});

test("embedded JSON is valid / safely escaped", () => {
  const html = renderDecisionDashboard(fixtureReport());
  const m = html.match(/<script type="application\/json" id="decision-data">([\s\S]*?)<\/script>/);
  assert.ok(m);
  const decoded = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const parsed = JSON.parse(decoded);
  assert.strictEqual(parsed.no_order_level_attribution, true);
  assert.ok(parsed.sales_mix);
});

if (!process.exitCode) {
  console.log("\nAll dashboard / sales-mix pure-function tests passed.");
}
