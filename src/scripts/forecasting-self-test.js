#!/usr/bin/env node
/**
 * Phase 10 forecasting self-tests.
 */
const assert = require("assert");
const {
  daysInclusive,
  calendarMonthBounds,
  pace,
  projectRemaining,
  assessForecastConfidence,
  buildMonthForecast,
  buildInventoryForecast,
} = require("../forecasting");
const { attachForecastAndExecutive } = require("../dashboard/attachExecutive");
const { METRICS, tipText } = require("../dashboard/metrics");

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

test("forecast arithmetic: pace and projectRemaining", () => {
  assert.strictEqual(pace(100, 10), 10);
  assert.strictEqual(pace(null, 10), null);
  assert.strictEqual(pace(100, 0), null);
  assert.strictEqual(projectRemaining(100, 10, 5, 1), 150);
  assert.strictEqual(projectRemaining(100, 10, 5, 0.85), 142.5);
  assert.strictEqual(projectRemaining(100, null, 5, 1), 100);
});

test("daysInclusive and month bounds", () => {
  assert.strictEqual(daysInclusive("2026-09-01", "2026-09-01"), 1);
  assert.strictEqual(daysInclusive("2026-09-01", "2026-09-06"), 6);
  const b = calendarMonthBounds("2026-09-06");
  assert.strictEqual(b.since, "2026-09-01");
  assert.strictEqual(b.until, "2026-09-30");
  const feb = calendarMonthBounds("2026-02-10");
  assert.strictEqual(feb.until, "2026-02-28");
});

test("partial month remaining days", () => {
  const f = buildMonthForecast({
    mtd: {
      revenue: 60000,
      orders: 30,
      gross_profit: 24000,
      meta_spend: 12000,
      meta_adjusted_profit: 8000,
      aov: 2000,
    },
    pace_period: {
      revenue: 60000,
      orders: 30,
      gross_profit: 24000,
      meta_spend: 12000,
      meta_adjusted_profit: 8000,
      days: 6,
    },
    as_of: "2026-09-06",
    flags: { cogs_ok: true },
  });
  assert.strictEqual(f.calendar_month.days_elapsed, 6);
  assert.strictEqual(f.calendar_month.days_remaining, 24);
  assert.ok(f.scenarios.BASE.projected_revenue > 60000);
  assert.ok(f.scenarios.CONSERVATIVE.projected_revenue < f.scenarios.BASE.projected_revenue);
  assert.ok(f.scenarios.UPSIDE.projected_revenue > f.scenarios.BASE.projected_revenue);
  assert.strictEqual(f.forecast_not_actual, true);
});

test("month boundary: last day remaining is 0", () => {
  const f = buildMonthForecast({
    mtd: { revenue: 100000, orders: 50, gross_profit: 40000, meta_spend: 20000, meta_adjusted_profit: 10000 },
    pace_period: { revenue: 100000, orders: 50, gross_profit: 40000, meta_spend: 20000, days: 30 },
    as_of: "2026-09-30",
    flags: { cogs_ok: true },
  });
  assert.strictEqual(f.calendar_month.days_remaining, 0);
  assert.strictEqual(f.scenarios.BASE.projected_revenue, 100000);
});

test("insufficient history confidence", () => {
  assert.strictEqual(
    assessForecastConfidence({ observed_days: 2, books_orders: 2, cogs_ok: true }),
    "INSUFFICIENT"
  );
  assert.strictEqual(
    assessForecastConfidence({ observed_days: 5, books_orders: 5, cogs_ok: false }),
    "LOW"
  );
  assert.strictEqual(
    assessForecastConfidence({
      observed_days: 16,
      books_orders: 20,
      cogs_ok: true,
      volatile: false,
    }),
    "HIGH"
  );
});

test("null handling and no divide-by-zero", () => {
  const f = buildMonthForecast({
    mtd: {},
    pace_period: { days: 0 },
    as_of: "2026-09-06",
  });
  assert.strictEqual(f.confidence, "INSUFFICIENT");
  assert.ok(f.scenarios.BASE);
  assert.strictEqual(pace(50, 0), null);
});

test("forecast vs actual separation", () => {
  const f = buildMonthForecast({
    mtd: { revenue: 10, orders: 5, gross_profit: 4, meta_spend: 2, meta_adjusted_profit: 1 },
    pace_period: { revenue: 10, orders: 5, gross_profit: 4, meta_spend: 2, days: 10 },
    as_of: "2026-09-10",
    flags: { cogs_ok: true },
  });
  assert.strictEqual(f.month_to_date.label.includes("ACTUAL"), true);
  assert.strictEqual(f.forecast_not_actual, true);
  assert.strictEqual(f.no_writes, true);
  for (const s of Object.values(f.scenarios)) {
    assert.ok(s.note.toLowerCase().includes("not a guarantee") || s.assumption);
  }
});

test("spend scenarios never invent causal ROAS", () => {
  const f = buildMonthForecast({
    mtd: { revenue: 100, orders: 10, gross_profit: 40, meta_spend: 50, meta_adjusted_profit: 10 },
    pace_period: { revenue: 100, orders: 10, gross_profit: 40, meta_spend: 50, days: 10 },
    as_of: "2026-09-10",
    flags: { cogs_ok: true },
  });
  assert.ok(f.spend_scenarios.length >= 4);
  for (const s of f.spend_scenarios) {
    assert.ok(/not projected|causal roas|unknown/i.test(s.unknown));
    assert.ok(!("projected_revenue" in s));
  }
});

test("inventory forecast suppresses zero-demand depletion", () => {
  const inv = buildInventoryForecast({
    summary: { capital_at_risk_value: 50000, capital_at_risk_pct: 40 },
    skus: [
      {
        sku: "A",
        product: "Tee",
        stock_class: "CRITICAL",
        units_sold_30d: 0,
        days_of_cover: null,
        stock_trusted: true,
        current_stock: 2,
      },
      {
        sku: "B",
        product: "Jogger",
        stock_class: "LOW",
        units_sold_30d: 12,
        days_of_cover: 8,
        stock_trusted: true,
        current_stock: 5,
      },
    ],
    stockout_risks: [
      {
        sku: "B",
        product: "Jogger",
        stock_class: "LOW",
        units_sold_30d: 12,
        days_of_cover: 8,
      },
    ],
  });
  assert.ok(inv.forecast_not_actual);
  assert.ok(inv.cover_where_evidence.every((s) => (s.days_of_cover != null)));
  assert.ok(!inv.cover_where_evidence.some((s) => s.sku === "A"));
});

test("attachForecast never writes forecast into books facts", () => {
  const bundle = {
    date_range: { since: "2026-09-01", until: "2026-09-06" },
    books: { net_revenue_ex_tax: 1000, recognized_orders: 5, gross_profit: 400, aov_ex_tax: 200 },
    profitability: { meta_adjusted_profit: 100, profit_before_ads: 300 },
    meta: { totals: { spend: 150 } },
    products: [],
    marketing_decisions: { owner_action_queue: [] },
    inventory: { summary: {}, skus: [] },
    pricing: {},
    data_quality: { warnings: [] },
  };
  attachForecastAndExecutive(bundle);
  assert.ok(bundle.forecast);
  assert.ok(bundle.executive);
  assert.strictEqual(bundle.books.net_revenue_ex_tax, 1000);
  assert.strictEqual(bundle.books.forecast_values_never_written, true);
  assert.notStrictEqual(bundle.books.net_revenue_ex_tax, bundle.forecast.scenarios.BASE.projected_revenue);
});

test("beginner-friendly metric definitions exist", () => {
  for (const id of [
    "meta_cpa",
    "break_even_cpa",
    "business_ad_load",
    "meta_adjusted_profit",
    "gross_margin",
    "forecast_revenue",
  ]) {
    assert.ok(METRICS[id], id);
    assert.ok(METRICS[id].plain_english.length > 20, id);
    assert.ok(tipText(id).length > 10, id);
  }
  assert.ok(METRICS.meta_cpa.caveat.toLowerCase().includes("break-even"));
});

test("Meta CPA and Books BE CPA remain conceptually distinct in registry", () => {
  assert.notStrictEqual(METRICS.meta_cpa.formula, METRICS.break_even_cpa.formula);
  assert.ok(/must not/i.test(METRICS.meta_cpa.caveat));
});

if (!process.exitCode) {
  console.log("\nAll forecasting tests passed.");
}
