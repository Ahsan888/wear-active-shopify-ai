#!/usr/bin/env node
/**
 * Generate the unified Wear Active Reporting & Decision Intelligence dashboard.
 *
 * Usage:
 *   npm run reports:dashboard -- --days=7
 *   npm run reports:dashboard -- --since=2026-08-01 --until=2026-08-31
 *   npm run reports:dashboard -- --days=7 --open
 *
 * Read-only — no Sheet writes, no Meta mutations.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  parseArgs,
  resolveDateRange,
  hintForMetaError,
} = require("../meta/cli");
const { loadDecisionInputs, TIMEZONE } = require("../decisions/loadInputs");
const {
  buildUnifiedReportingBundle,
  sanitizeBundleForEmbed,
} = require("../dashboard/bundle");
const { renderUnifiedDashboard } = require("../dashboard/html");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function maybeOpen(filePath, shouldOpen) {
  if (!shouldOpen) return;
  if (process.platform === "darwin") {
    spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", filePath], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dateRange = resolveDateRange(args, TIMEZONE);
  const inputs = await loadDecisionInputs(dateRange.since, dateRange.until);
  const bundle = sanitizeBundleForEmbed(buildUnifiedReportingBundle(inputs));

  // Phase 5A — experimental attribution diagnostics (does not alter classifiers)
  try {
    const {
      fetchOrdersForAttribution,
    } = require("../attribution/fetchOrders");
    const {
      buildAttributionDiagnostics,
    } = require("../attribution/coverage");
    const {
      indexRecognizedShopifyOrderEconomics,
    } = require("../attribution/ledgerJoin");
    const {
      buildAttributedEconomics,
    } = require("../attribution/entityEconomics");
    const { loadLedger } = require("../profitability/books");

    const orders = await fetchOrdersForAttribution({
      since: dateRange.since,
      until: dateRange.until,
    });
    bundle.attribution = buildAttributionDiagnostics(orders, {
      metaEntities: {
        campaigns: inputs.campaigns || [],
        adsets: inputs.adsets || [],
        ads: inputs.ads || [],
      },
    });
    delete bundle.attribution.orders;

    const ledger = await loadLedger();
    const ledgerByOrderId = indexRecognizedShopifyOrderEconomics(
      ledger.data,
      ledger.header,
      dateRange.since,
      dateRange.until
    );
    bundle.attribution_economics = buildAttributedEconomics({
      orders,
      ledgerByOrderId,
      metaEntities: {
        campaigns: inputs.campaigns || [],
        adsets: inputs.adsets || [],
        ads: inputs.ads || [],
      },
      meta_spend_total: inputs.meta?.totals?.spend || 0,
      shopify_channel: inputs.sales_by_channel?.Shopify || {},
      period: { since: dateRange.since, until: dateRange.until },
    });
  } catch (err) {
    bundle.attribution = {
      error: String(err.message || err),
      experimental: true,
    };
  }

  // Phase 7 — inventory & demand intelligence (advisory only)
  try {
    const { loadLedger, loadVariantMaster } = require("../profitability/books");
    const { fetchShopifyInventory } = require("../inventory/fetchInventory");
    const { buildDemandWindows } = require("../inventory/demand");
    const { buildInventoryReport } = require("../inventory/build");
    const { resolveThresholds } = require("../inventory/thresholds");

    const [ledger, vm, shopifyVariants] = await Promise.all([
      loadLedger(),
      loadVariantMaster(),
      fetchShopifyInventory(),
    ]);
    const demandWindows = buildDemandWindows(
      ledger.data,
      ledger.header,
      dateRange.until,
      vm.bySku
    );
    bundle.inventory = buildInventoryReport({
      shopifyVariants,
      demandWindows,
      catalogBySku: vm.bySku,
      thresholds: resolveThresholds(),
      period: { since: dateRange.since, until: dateRange.until },
    });
  } catch (err) {
    bundle.inventory = {
      error: String(err.message || err),
      advisory_only: true,
    };
  }

  const html = renderUnifiedDashboard(bundle);

  const outDir = path.join(process.cwd(), "reports", "dashboard");
  ensureDir(outDir);
  const latestPath = path.join(outDir, "index.html");
  const datedName = `report-${dateRange.since}-to-${dateRange.until}.html`;
  const datedPath = path.join(outDir, datedName);

  fs.writeFileSync(latestPath, html, "utf8");
  fs.writeFileSync(datedPath, html, "utf8");

  console.log("Wear Active reporting dashboard generated.");
  console.log(`Period: ${dateRange.since} → ${dateRange.until}`);
  console.log(`Open: ${latestPath}`);
  console.log(`Also: ${datedPath}`);
  console.log("Advisory only — no Meta mutations, no Sheet writes.");

  maybeOpen(latestPath, Boolean(args.open));
}

main().catch((err) => {
  console.error("Reporting dashboard failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
