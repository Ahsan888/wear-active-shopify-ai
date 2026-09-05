#!/usr/bin/env node
/**
 * Lightweight pure-function tests for Meta helpers (no network).
 * Usage: npm run meta:test
 */
const assert = require("assert");
const {
  enrichInsightRow,
  deriveRateFields,
  actionValue,
  PURCHASE_TYPES,
  ATC_TYPES,
  CHECKOUT_TYPES,
} = require("../meta/metrics");
const { parseArgs, parseYmd, resolveDateRange } = require("../meta/cli");

function actions(...pairs) {
  return pairs.map(([action_type, value]) => ({ action_type, value }));
}

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

test("purchase first-match does not sum overlapping types", () => {
  const row = enrichInsightRow({
    spend: "100",
    impressions: "1000",
    actions: actions(
      ["purchase", 4],
      ["omni_purchase", 4],
      ["offsite_conversion.fb_pixel_purchase", 4]
    ),
    action_values: actions(
      ["purchase", 400],
      ["omni_purchase", 400],
      ["offsite_conversion.fb_pixel_purchase", 400]
    ),
  });
  assert.strictEqual(row.purchases, 4);
  assert.strictEqual(row.purchase_value, 400);
  assert.strictEqual(row.purchase_action_type, "purchase");
  assert.strictEqual(row.purchase_value_action_type, "purchase");
});

test("purchase falls back to omni when purchase missing", () => {
  const row = enrichInsightRow({
    actions: actions(
      ["omni_purchase", 3],
      ["offsite_conversion.fb_pixel_purchase", 9]
    ),
  });
  assert.strictEqual(row.purchases, 3);
  assert.strictEqual(row.purchase_action_type, "omni_purchase");
});

test("purchase falls back to pixel when only pixel present", () => {
  const row = enrichInsightRow({
    actions: actions(["offsite_conversion.fb_pixel_purchase", 2]),
  });
  assert.strictEqual(row.purchases, 2);
  assert.strictEqual(row.purchase_action_type, "offsite_conversion.fb_pixel_purchase");
});

test("ATC / checkout first-match does not sum aliases", () => {
  assert.strictEqual(
    actionValue(
      actions(
        ["add_to_cart", 5],
        ["omni_add_to_cart", 5],
        ["offsite_conversion.fb_pixel_add_to_cart", 5]
      ),
      ATC_TYPES
    ),
    5
  );
  assert.strictEqual(
    actionValue(
      actions(
        ["initiate_checkout", 2],
        ["omni_initiated_checkout", 2],
        ["offsite_conversion.fb_pixel_initiate_checkout", 2]
      ),
      CHECKOUT_TYPES
    ),
    2
  );
});

test("funnel ratio fields", () => {
  const rates = deriveRateFields({
    impressions: 1000,
    landing_page_views: 100,
    add_to_carts: 20,
    initiated_checkouts: 10,
    purchases: 5,
  });
  assert.strictEqual(rates.purchase_per_impression_pct, 0.5);
  assert.strictEqual(rates.lpv_to_atc_pct, 20);
  assert.strictEqual(rates.lpv_to_checkout_pct, 10);
  assert.strictEqual(rates.lpv_to_purchase_pct, 5);
  assert.strictEqual(rates.atc_to_checkout_pct, 50);
  assert.strictEqual(rates.checkout_to_purchase_pct, 50);
});

test("funnel ratios null when denominator zero", () => {
  const rates = deriveRateFields({
    impressions: 0,
    landing_page_views: 0,
    add_to_carts: 0,
    initiated_checkouts: 0,
    purchases: 0,
  });
  assert.strictEqual(rates.purchase_per_impression_pct, null);
  assert.strictEqual(rates.lpv_to_atc_pct, null);
  assert.strictEqual(rates.checkout_to_purchase_pct, null);
});

test("no purchase_cvr_pct field", () => {
  const row = enrichInsightRow({ impressions: 100, actions: actions(["purchase", 1]) });
  assert.strictEqual("purchase_cvr_pct" in row, false);
  assert.ok("purchase_per_impression_pct" in row);
});

test("reject invalid calendar dates", () => {
  assert.throws(() => parseYmd("2026-02-31"), /Invalid calendar date/);
  assert.throws(() => parseYmd("2026-13-01"), /Invalid calendar date/);
  assert.throws(() => parseYmd("2026-00-15"), /Invalid calendar date/);
  assert.throws(() => parseYmd("2026-04-31"), /Invalid calendar date/);
  assert.deepStrictEqual(parseYmd("2026-02-28"), { y: 2026, mo: 2, d: 28 });
  assert.deepStrictEqual(parseYmd("2024-02-29"), { y: 2024, mo: 2, d: 29 });
  assert.throws(() => parseYmd("2025-02-29"), /Invalid calendar date/);
});

test("reject invalid --days", () => {
  assert.throws(() => parseArgs(["--days=abc"]), /positive integer/);
  assert.throws(() => parseArgs(["--days=0"]), /positive integer/);
  assert.throws(() => parseArgs(["--days=-3"]), /positive integer|Unknown|Missing/);
  assert.throws(() => parseArgs(["--days=1.5"]), /positive integer/);
  assert.throws(() => parseArgs(["--days"]), /Missing value/);
  assert.deepStrictEqual(parseArgs(["--days=7"]).days, 7);
  assert.deepStrictEqual(parseArgs(["--days", "30"]).days, 30);
});

test("reject unknown flags", () => {
  assert.throws(() => parseArgs(["--levle=ad"]), /Unknown argument: --levle=ad/);
  assert.throws(() => parseArgs(["--level"]), /Missing value/);
});

test("default date range is 7 days when no flags", () => {
  const range = resolveDateRange({}, "Asia/Karachi");
  parseYmd(range.since);
  parseYmd(range.until);
  const start = new Date(`${range.since}T00:00:00Z`);
  const end = new Date(`${range.until}T00:00:00Z`);
  const days =
    Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  assert.strictEqual(days, 7);
});

test("purchase types export order unchanged", () => {
  assert.deepStrictEqual(PURCHASE_TYPES, [
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
  ]);
});

if (!process.exitCode) {
  console.log("\nAll meta pure-function tests passed.");
}
