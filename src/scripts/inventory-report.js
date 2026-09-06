#!/usr/bin/env node
/**
 * Phase 7 — Inventory & Demand Intelligence (advisory only).
 *
 *   npm run inventory:report -- --days=30
 *   npm run inventory:report -- --since=2026-08-01 --until=2026-08-31 --json
 *
 * No Shopify inventory mutations, no Sheet writes, no POs.
 */
require("dotenv").config({ quiet: true });
const { parseArgs, resolveDateRange, hintForMetaError } = require("../meta/cli");
const { TIMEZONE } = require("../operations/dates");
const { loadLedger, loadVariantMaster } = require("../profitability/books");
const { fetchShopifyInventory } = require("../inventory/fetchInventory");
const { buildDemandWindows } = require("../inventory/demand");
const { buildInventoryReport } = require("../inventory/build");
const { printInventoryReport } = require("../inventory/report");
const { resolveThresholds } = require("../inventory/thresholds");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dateRange = resolveDateRange(args, TIMEZONE);
  // Demand windows are always trailing 7/14/30 ending on until
  const until = dateRange.until;

  const [ledger, vm, shopifyVariants] = await Promise.all([
    loadLedger(),
    loadVariantMaster(),
    fetchShopifyInventory(),
  ]);

  const demandWindows = buildDemandWindows(
    ledger.data,
    ledger.header,
    until,
    vm.bySku
  );

  const report = buildInventoryReport({
    shopifyVariants,
    demandWindows,
    catalogBySku: vm.bySku,
    thresholds: resolveThresholds(),
    period: { since: dateRange.since, until },
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printInventoryReport(report);
  }
}

main().catch((err) => {
  console.error("Inventory report failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
