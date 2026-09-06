#!/usr/bin/env node
/**
 * Phase 8 — Pricing & Promotion Intelligence (advisory only).
 *
 *   npm run pricing:report -- --days=90
 *   npm run pricing:report -- --since=2026-06-01 --until=2026-09-06 --json
 *
 * No Shopify price writes, no automatic discounts.
 */
require("dotenv").config({ quiet: true });
const { parseArgs, resolveDateRange, hintForMetaError } = require("../meta/cli");
const { TIMEZONE } = require("../operations/dates");
const { loadLedger, loadVariantMaster } = require("../profitability/books");
const { fetchShopifyInventory } = require("../inventory/fetchInventory");
const { buildDemandWindows } = require("../inventory/demand");
const { buildInventoryReport } = require("../inventory/build");
const { resolveThresholds } = require("../inventory/thresholds");
const { fetchVariantPrices } = require("../pricing/fetchPrices");
const { buildPricingReport } = require("../pricing/build");
const { printPricingReport } = require("../pricing/report");
const { resolvePricingThresholds } = require("../pricing/thresholds");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.days == null && !args.since && !args.until) {
    args.days = 90;
  }
  const dateRange = resolveDateRange(args, TIMEZONE);

  const [ledger, vm, shopifyVariants, shopifyPrices] = await Promise.all([
    loadLedger(),
    loadVariantMaster(),
    fetchShopifyInventory(),
    fetchVariantPrices(),
  ]);

  const demandWindows = buildDemandWindows(
    ledger.data,
    ledger.header,
    dateRange.until,
    vm.bySku
  );

  const inventory = buildInventoryReport({
    shopifyVariants,
    demandWindows,
    catalogBySku: vm.bySku,
    thresholds: resolveThresholds(),
    period: { since: dateRange.since, until: dateRange.until },
  });

  const report = buildPricingReport({
    inventorySkus: inventory.skus,
    shopifyPrices,
    catalogBySku: vm.bySku,
    thresholds: resolvePricingThresholds(),
    period: dateRange,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printPricingReport(report);
  }
}

main().catch((err) => {
  console.error("Pricing report failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
