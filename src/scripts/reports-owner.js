#!/usr/bin/env node
/**
 * Owner operating command — Phases 1–11 in one pass.
 *
 *   npm run reports:owner -- --days=30
 *   npm run reports:owner -- --since=2026-09-01 --until=2026-09-06 --open
 *
 * Loads data → engines → forecasting → executive OS → dashboard + owner brief.
 * Read-only — no Sheet / Meta / Shopify mutations. Forecasts never enter Books.
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
const { attachForecastAndExecutive } = require("../dashboard/attachExecutive");
const { calendarMonthBounds } = require("../forecasting");
const { printOwnerBrief } = require("../executive");

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

/** Shared enrichment used by reports:dashboard and reports:owner */
async function enrichBundlePhases(bundle, dateRange, args = {}) {
  // Phase 5A/5B
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
        campaigns: bundle.campaigns || [],
        adsets: bundle.adsets || [],
        ads: bundle.ads || [],
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
        campaigns: bundle.campaigns || [],
        adsets: bundle.adsets || [],
        ads: bundle.ads || [],
      },
      meta_spend_total: bundle.meta?.totals?.spend || 0,
      shopify_channel: bundle.sales_by_channel?.Shopify || {},
      period: { since: dateRange.since, until: dateRange.until },
    });
  } catch (err) {
    bundle.attribution = {
      error: String(err.message || err),
      experimental: true,
    };
  }

  // Phase 7
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
    bundle._pricing_vm = vm;
  } catch (err) {
    bundle.inventory = {
      error: String(err.message || err),
      advisory_only: true,
    };
  }

  // Phase 6
  try {
    const { addDaysYmd } = require("../operations/dates");
    const { loadLedger } = require("../profitability/books");
    const {
      fetchOrdersForAttribution,
    } = require("../attribution/fetchOrders");
    const {
      indexRecognizedShopifyOrderEconomics,
    } = require("../attribution/ledgerJoin");
    const { buildCustomerEconomics } = require("../customers/build");
    const { assertNoRawPii } = require("../customers/identity");

    const historyDays = Math.max(
      180,
      Number(process.env.CUSTOMER_HISTORY_DAYS) || 540
    );
    const history = {
      since: addDaysYmd(dateRange.until, -(historyDays - 1)),
      until: dateRange.until,
    };
    const maxPages = Math.max(
      40,
      Number(process.env.CUSTOMER_ORDER_MAX_PAGES) || 80
    );

    const [orders, ledger] = await Promise.all([
      fetchOrdersForAttribution({ ...history, maxPages }),
      loadLedger(),
    ]);
    const ledgerByOrderId = indexRecognizedShopifyOrderEconomics(
      ledger.data,
      ledger.header,
      history.since,
      history.until
    );
    const report = buildCustomerEconomics({
      orders,
      ledgerByOrderId,
      period: dateRange,
      history,
      meta_spend_total: bundle.meta?.totals?.spend || 0,
      attribution_coverage_pct:
        bundle.attribution_economics?.account?.attributed_coverage_pct ?? null,
    });
    report.customers = (report.customers || []).slice(0, 100);
    report.period_orders = (report.period_orders || []).slice(0, 200);
    assertNoRawPii(JSON.stringify(report));
    bundle.customers = report;
  } catch (err) {
    bundle.customers = {
      error: String(err.message || err),
      advisory_only: true,
    };
  }

  // Phase 8
  try {
    const { fetchVariantPrices } = require("../pricing/fetchPrices");
    const { buildPricingReport } = require("../pricing/build");
    const { resolvePricingThresholds } = require("../pricing/thresholds");
    const { loadVariantMaster } = require("../profitability/books");

    const vm = bundle._pricing_vm || (await loadVariantMaster());
    const shopifyPrices = await fetchVariantPrices();
    bundle.pricing = buildPricingReport({
      inventorySkus: bundle.inventory?.skus || [],
      shopifyPrices,
      catalogBySku: vm.bySku,
      thresholds: resolvePricingThresholds(),
      period: dateRange,
      customerDiagnostics: bundle.customers?.summary
        ? {
            repeat_customer_rate_pct:
              bundle.customers.summary.repeat_customer_rate_pct,
            new_vs_returning: bundle.customers.new_vs_returning,
          }
        : null,
    });
  } catch (err) {
    bundle.pricing = {
      error: String(err.message || err),
      advisory_only: true,
    };
  }

  // Phase 9
  try {
    const {
      buildMarketingFromUnifiedBundle,
    } = require("../marketing");
    bundle.marketing_decisions = buildMarketingFromUnifiedBundle(bundle, {
      primaryDays: args.days || 30,
    });
  } catch (err) {
    bundle.marketing_decisions = {
      error: String(err.message || err),
      advisory_only: true,
    };
  }

  // Phase 10 + 11 — calendar MTD load when period is not already month-to-date
  let mtdBundle = null;
  try {
    const asOf = dateRange.until;
    const bounds = calendarMonthBounds(asOf);
    if (dateRange.since !== bounds.since) {
      const mtdInputs = await loadDecisionInputs(bounds.since, asOf);
      mtdBundle = buildUnifiedReportingBundle(mtdInputs);
    }
  } catch (err) {
    console.warn(
      "Calendar MTD load failed — forecast will use period proxy:",
      err.message || err
    );
  }

  attachForecastAndExecutive(bundle, {
    mtdBundle,
    as_of: dateRange.until,
    attribution_capture_started:
      process.env.ATTRIBUTION_CAPTURE_STARTED || null,
  });

  delete bundle._pricing_vm;
  return bundle;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dateRange = resolveDateRange(args, TIMEZONE);
  const inputs = await loadDecisionInputs(dateRange.since, dateRange.until);
  let bundle = sanitizeBundleForEmbed(buildUnifiedReportingBundle(inputs));
  bundle = await enrichBundlePhases(bundle, dateRange, args);

  const html = renderUnifiedDashboard(bundle);

  const outDir = path.join(process.cwd(), "reports", "dashboard");
  ensureDir(outDir);
  const latestPath = path.join(outDir, "index.html");
  const datedName = `report-${dateRange.since}-to-${dateRange.until}.html`;
  const datedPath = path.join(outDir, datedName);
  const briefPath = path.join(outDir, "owner-brief.json");

  fs.writeFileSync(latestPath, html, "utf8");
  fs.writeFileSync(datedPath, html, "utf8");
  fs.writeFileSync(
    briefPath,
    JSON.stringify(bundle.executive || {}, null, 2),
    "utf8"
  );

  console.log("Wear Active OWNER operating report generated.");
  console.log(`Period: ${dateRange.since} → ${dateRange.until}`);
  console.log(`Dashboard: ${latestPath}`);
  console.log(`Owner brief JSON: ${briefPath}`);
  console.log("Advisory only — forecasts are NOT Books facts.");

  if (bundle.executive) printOwnerBrief(bundle.executive);

  maybeOpen(latestPath, Boolean(args.open));
}

module.exports = { enrichBundlePhases };

if (require.main === module) {
  main().catch((err) => {
    console.error("Owner report failed:", err.message || err);
    const hint = hintForMetaError(err);
    if (hint) console.error(hint);
    process.exitCode = 1;
  });
}
