#!/usr/bin/env node
/**
 * Pure-function tests for profitability (no Sheets / Meta network).
 * Usage: npm run profitability:test
 */
const assert = require("assert");
const {
  computeMetaAdjusted,
  computeBlended,
  computeBreakEven,
  META_SPEND_TREATMENT,
} = require("../profitability/metrics");
const {
  reconcileAds,
  isFullCalendarMonth,
  findDuplicateExpenseCandidates,
  matchRecurringToLedger,
} = require("../profitability/reconciliation");
const {
  aggregateLedgerPeriod,
  isAdsCategory,
  isDeliveryCategory,
} = require("../profitability/books");

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

test("no double counting of Meta spend", () => {
  const r = computeMetaAdjusted({
    books_net_profit: 50000,
    ads_expense_booked: 20000,
    meta_spend: 22000,
    net_revenue_ex_tax: 200000,
  });
  assert.strictEqual(r.profit_before_ads, 70000);
  assert.strictEqual(r.meta_adjusted_profit, 48000);
  assert.notStrictEqual(r.meta_adjusted_profit, 28000);
  assert.strictEqual(r.meta_spend_treatment, META_SPEND_TREATMENT);
});

test("exact Meta/Ledger match variance 0", () => {
  const rec = reconcileAds({
    since: "2026-08-01",
    until: "2026-08-31",
    meta_spend: 20000,
    ledger_ads_expense: 20000,
    recurring_ads_expense: 20000,
    ledgerAdsRows: [
      { date: "2026-08-01", category: "Ads", debit: 20000, description: "x", source: "Manual" },
    ],
    recurringAdsRows: [
      { date: "2026-08-01", category: "Ads", amount: 20000 },
    ],
    expenseRows: [
      { date: "2026-08-01", category: "Ads", debit: 20000, description: "x", source: "Manual" },
    ],
  });
  assert.strictEqual(rec.ad_reconciliation.meta_vs_ledger_variance, 0);
  assert.strictEqual(
    rec.ad_reconciliation.ad_spend_reconciliation_status,
    "matched_full_month"
  );
});

test("Meta vs Ledger variance", () => {
  const rec = reconcileAds({
    since: "2026-08-01",
    until: "2026-08-31",
    meta_spend: 22000,
    ledger_ads_expense: 20000,
    recurring_ads_expense: 20000,
    ledgerAdsRows: [],
    recurringAdsRows: [],
    expenseRows: [],
  });
  assert.strictEqual(rec.ad_reconciliation.meta_vs_ledger_variance, 2000);
});

test("missing Ledger Ads warns", () => {
  const rec = reconcileAds({
    since: "2026-08-01",
    until: "2026-08-31",
    meta_spend: 20000,
    ledger_ads_expense: 0,
    recurring_ads_expense: 0,
    ledgerAdsRows: [],
    recurringAdsRows: [],
    expenseRows: [],
  });
  assert.strictEqual(
    rec.ad_reconciliation.ad_spend_reconciliation_status,
    "ledger_ads_missing"
  );
  assert.ok(rec.warnings.some((w) => w.code === "ledger_ads_missing"));
});

test("partial period not comparable", () => {
  assert.strictEqual(isFullCalendarMonth("2026-08-01", "2026-08-07"), false);
  const rec = reconcileAds({
    since: "2026-08-01",
    until: "2026-08-07",
    meta_spend: 5000,
    ledger_ads_expense: 20000,
    recurring_ads_expense: 20000,
    ledgerAdsRows: [],
    recurringAdsRows: [],
    expenseRows: [],
  });
  assert.strictEqual(
    rec.ad_reconciliation.ad_spend_reconciliation_status,
    "partial_period_not_comparable"
  );
});

test("duplicate Ledger Ads warns but does not alter booked total", () => {
  const ledgerAdsRows = [
    {
      date: "2026-05-31",
      category: "Ads",
      debit: 75308,
      description: "Meta",
      source: "Manual",
    },
    {
      date: "2026-05-31",
      category: "Ads",
      debit: 75308,
      description: "Meta",
      source: "Manual",
    },
  ];
  const dups = findDuplicateExpenseCandidates(ledgerAdsRows);
  assert.strictEqual(dups.length, 1);
  assert.strictEqual(dups[0].count, 2);
  assert.strictEqual(dups[0].amount, 75308);

  const ledger_ads_expense = 75308 + 75308;
  const recurring_ads_expense = 75308;
  assert.strictEqual(ledger_ads_expense, 150616);

  const rec = reconcileAds({
    since: "2026-05-01",
    until: "2026-05-31",
    meta_spend: 0,
    ledger_ads_expense,
    recurring_ads_expense,
    ledgerAdsRows,
    recurringAdsRows: [
      { date: "2026-05-31", category: "Ads", amount: 75308 },
    ],
    expenseRows: ledgerAdsRows,
  });
  assert.strictEqual(rec.ad_reconciliation.ledger_ads_expense, 150616);
  assert.strictEqual(rec.ad_reconciliation.recurring_ads_expense, 75308);
  assert.ok(
    rec.warnings.some((w) => w.code === "possible_duplicate_ledger_expense")
  );
});

test("break-even edge cases", () => {
  const zeroRev = computeBreakEven({
    profit_before_ads: 1000,
    recognized_orders: 0,
    net_revenue_ex_tax: 0,
  });
  assert.strictEqual(zeroRev.break_even_cpa, null);
  assert.strictEqual(zeroRev.break_even_roas, null);

  const neg = computeBreakEven({
    profit_before_ads: -500,
    recognized_orders: 10,
    net_revenue_ex_tax: 10000,
  });
  assert.strictEqual(neg.break_even_cpa, null);
  assert.ok(neg.warnings.length);

  const ok = computeBreakEven({
    profit_before_ads: 20000,
    recognized_orders: 10,
    net_revenue_ex_tax: 100000,
  });
  assert.strictEqual(ok.break_even_cpa, 2000);
  assert.strictEqual(ok.break_even_roas, 5);
});

test("expense isolation Ads vs Delivery vs other", () => {
  assert.ok(isAdsCategory("Ads"));
  assert.ok(isAdsCategory("ads"));
  assert.ok(!isAdsCategory("Platform"));
  assert.ok(!isAdsCategory("Marketing"));
  assert.ok(isDeliveryCategory("Delivery"));

  const header = [
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
  const rows = [
    ["2026-08-10", "Sale", "Shopify", "", "Tee", "SKU1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-10", "COGS", "Shopify", "", "COGS Tee", "SKU1", "1", "400", "", "", "", "COGS:SHOPIFY|#1:a", "", ""],
    ["2026-08-10", "Expense", "Manual", "Delivery", "Courier", "", "", "100", "", "", "", "EXP:1", "", ""],
    ["2026-08-10", "Expense", "Manual", "Ads", "Meta", "", "", "200", "", "", "", "EXP:2", "", ""],
    ["2026-08-10", "Expense", "Manual", "Ops", "Rent chunk", "", "", "50", "", "", "", "EXP:3", "", ""],
    ["2026-08-10", "Expense", "Manual", "Platform", "Fees", "", "", "25", "", "", "", "EXP:4", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, header, "2026-08-01", "2026-08-31", {
    SKU1: { sku: "SKU1", product: "Tee", category: "Shirt", costPerItem: 400 },
  });
  assert.strictEqual(agg.books.delivery_expense, 100);
  assert.strictEqual(agg.books.ads_expense_booked, 200);
  assert.strictEqual(agg.books.other_non_ad_opex, 75);
  assert.strictEqual(agg.books.total_opex, 375);
  // gross profit = 1000 - 400 = 600; net = 600 - 375 = 225
  assert.strictEqual(agg.books.gross_profit, 600);
  assert.strictEqual(agg.books.books_net_profit, 225);
  assert.strictEqual(agg.products[0].sku, "SKU1");
  assert.strictEqual(agg.products[0].revenue_ex_tax, 1000);
});

test("gift rows do not add paid revenue", () => {
  const header = [
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
  const rows = [
    ["2026-08-10", "Gift", "Shopify", "", "Gift Tee", "SKU1", "1", "", "0", "", "", "GIFT:SHOPIFY|#9:a", "", ""],
    ["2026-08-10", "COGS", "Shopify", "", "COGS Gift", "SKU1", "1", "400", "", "", "", "COGS:SHOPIFY|#9:a", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, header, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.books.revenue_ex_tax, 0);
  assert.strictEqual(agg.books.cogs, 400);
  assert.ok(agg.gift_units_by_key.SKU1 === 1 || Object.keys(agg.gift_units_by_key).length >= 1);
});

test("blended MER labeling helpers", () => {
  const b = computeBlended({
    net_revenue_ex_tax: 100000,
    meta_spend: 20000,
    recognized_orders: 50,
    meta_roas: 1.5,
  });
  assert.strictEqual(b.blended_mer, 5);
  assert.strictEqual(b.blended_ad_cost_per_recognized_order, 400);
  assert.strictEqual(b.no_order_level_attribution, true);
});

test("full calendar month detection", () => {
  assert.strictEqual(isFullCalendarMonth("2026-05-01", "2026-05-31"), true);
  assert.strictEqual(isFullCalendarMonth("2026-02-01", "2026-02-28"), true);
  assert.strictEqual(isFullCalendarMonth("2026-02-01", "2026-02-29"), false);
  assert.strictEqual(isFullCalendarMonth("2024-02-01", "2024-02-29"), true);
});

test("recurring to ledger heuristic match", () => {
  const m = matchRecurringToLedger(
    [{ date: "2026-05-31", category: "Ads", amount: 75308 }],
    [
      { date: "2026-05-31", category: "Ads", debit: 75308 },
      { date: "2026-05-31", category: "Ads", debit: 75308 },
    ]
  );
  assert.strictEqual(m.likely_matched_recurring_ads_rows, 1);
  assert.strictEqual(m.unmatched_ledger_ads_rows.length, 1);
});

if (!process.exitCode) {
  console.log("\nAll profitability pure-function tests passed.");
}
