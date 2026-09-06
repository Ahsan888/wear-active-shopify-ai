#!/usr/bin/env node
/**
 * Phase 9 — Marketing Decision Engine (advisory only).
 *
 *   npm run marketing:decisions -- --days=30
 *   npm run marketing:decisions -- --days=7 --json
 *
 * Loads comparable 7/14/30 Meta entity evidence when possible.
 * No Meta mutations, no budget changes, no Shopify writes.
 */
require("dotenv").config({ quiet: true });
const { parseArgs, resolveDateRange, hintForMetaError } = require("../meta/cli");
const { loadDecisionInputs, fetchMetaBundle, TIMEZONE } = require("../decisions/loadInputs");
const { buildDecisionReport } = require("../decisions/report");
const {
  classifyMetaEntities,
  buildAccountFunnelBaselines,
} = require("../decisions/entities");
const {
  isBusinessProfitableEnoughForScale,
} = require("../decisions/business");
const { isBusinessAdsSafeForScale } = require("../decisions/advertising");
const {
  buildMarketingDecisionReport,
  printMarketingDecisionReport,
} = require("../marketing");

const { trailingWindow } = require("../operations/dates");
const { buildIndependentWindowRanges } = require("../marketing/periods");

async function classifyPeriodMeta(since, until, gateOpts) {
  const meta = await fetchMetaBundle(since, until);
  const baselines = buildAccountFunnelBaselines(meta.totals);
  const opts = {
    ...gateOpts,
    account_funnel_baselines: baselines,
    entity_type: "ad",
  };
  const ads = classifyMetaEntities(meta.ads, meta.totals, {
    ...opts,
    entity_type: "ad",
  });
  const campaigns = classifyMetaEntities(meta.campaigns, meta.totals, {
    ...opts,
    entity_type: "campaign",
  });
  return {
    ads,
    campaigns,
    meta_totals: meta.totals,
    since,
    until,
  };
}

async function maybeLoadPricingInventory(dateRange) {
  const out = { pricingReport: null, inventoryReport: null, customers: null };
  try {
    const { loadLedger, loadVariantMaster } = require("../profitability/books");
    const { fetchShopifyInventory } = require("../inventory/fetchInventory");
    const { buildDemandWindows } = require("../inventory/demand");
    const { buildInventoryReport } = require("../inventory/build");
    const { resolveThresholds } = require("../inventory/thresholds");
    const { fetchVariantPrices } = require("../pricing/fetchPrices");
    const { buildPricingReport } = require("../pricing/build");
    const { resolvePricingThresholds } = require("../pricing/thresholds");

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
    out.inventoryReport = buildInventoryReport({
      shopifyVariants,
      demandWindows,
      catalogBySku: vm.bySku,
      thresholds: resolveThresholds(),
      period: { since: dateRange.since, until: dateRange.until },
    });
    out.pricingReport = buildPricingReport({
      inventorySkus: out.inventoryReport.skus,
      shopifyPrices,
      catalogBySku: vm.bySku,
      thresholds: resolvePricingThresholds(),
      period: { since: dateRange.since, until: dateRange.until },
    });
  } catch (err) {
    out.pricingReport = { error: String(err.message || err) };
    out.inventoryReport = { error: String(err.message || err) };
  }
  return out;
}

async function maybeLoadAttribution(dateRange) {
  try {
    const { fetchShopifyOrders } = require("../attribution/fetchOrders");
    const { buildAttributionDiagnostics } = require("../attribution/coverage");
    const { buildAttributedEconomics } = require("../attribution/entityEconomics");
    const { loadLedger, loadVariantMaster } = require("../profitability/books");
    const { fetchMetaBundle: fetchMeta } = require("../decisions/loadInputs");

    const [orders, ledger, vm, meta] = await Promise.all([
      fetchShopifyOrders({ since: dateRange.since, until: dateRange.until }),
      loadLedger(),
      loadVariantMaster(),
      fetchMeta(dateRange.since, dateRange.until),
    ]);
    const diag = buildAttributionDiagnostics(orders, {
      since: dateRange.since,
      until: dateRange.until,
    });
    return buildAttributedEconomics({
      orders,
      ledgerRows: ledger.data,
      ledgerHeader: ledger.header,
      catalogBySku: vm.bySku,
      metaCampaigns: meta.campaigns,
      metaAdsets: meta.adsets,
      metaAds: meta.ads,
      metaTotals: meta.totals,
      attributionDiagnostics: diag,
      period: dateRange,
    });
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.days == null && !args.since && !args.until) {
    args.days = 30;
  }
  const dateRange = resolveDateRange(args, TIMEZONE);
  const primaryDays = args.days || 30;

  const inputs = await loadDecisionInputs(dateRange.since, dateRange.until);
  const decisionReport = buildDecisionReport(inputs);

  const gateOpts = {
    business_health_ok: isBusinessProfitableEnoughForScale(
      decisionReport.business_health?.status
    ),
    business_ads_ok: isBusinessAdsSafeForScale(
      decisionReport.business_advertising_safety?.status
    ),
    confidence_ok: decisionReport.gates?.confidence_ok_for_scale === true,
    accounting_scale_ok: decisionReport.gates?.suppress_scale !== true,
  };

  // Comparable overlapping Meta windows (contextual trend only)
  const periodClassified = {};
  const windows = [
    { days: 7 },
    { days: 14 },
    { days: 30 },
  ];
  for (const w of windows) {
    try {
      if (Number(primaryDays) === w.days) {
        periodClassified[String(w.days)] = {
          ads: decisionReport.ads,
          campaigns: decisionReport.campaigns,
          meta_totals: decisionReport.meta?.totals || inputs.meta?.totals,
          since: dateRange.since,
          until: dateRange.until,
        };
      } else {
        const range = trailingWindow(dateRange.until, w.days);
        periodClassified[String(w.days)] = await classifyPeriodMeta(
          range.since,
          range.until,
          gateOpts
        );
      }
    } catch (err) {
      periodClassified[String(w.days)] = {
        error: String(err.message || err),
        ads: [],
        campaigns: [],
      };
    }
  }

  // Independent non-overlapping buckets (recent_7d / previous_7d / prior_16d)
  const independentClassified = {};
  const indepRanges = buildIndependentWindowRanges(dateRange.until);
  for (const [key, range] of Object.entries(indepRanges)) {
    try {
      // Reuse trailing 7d fetch when dates match
      const trailing7 = periodClassified["7"];
      if (
        key === "recent_7d" &&
        trailing7 &&
        !trailing7.error &&
        trailing7.since === range.since &&
        trailing7.until === range.until
      ) {
        independentClassified[key] = trailing7;
      } else {
        independentClassified[key] = await classifyPeriodMeta(
          range.since,
          range.until,
          gateOpts
        );
      }
    } catch (err) {
      independentClassified[key] = {
        error: String(err.message || err),
        ads: [],
        campaigns: [],
        since: range.since,
        until: range.until,
      };
    }
  }

  const [invPricing, attributionEconomics] = await Promise.all([
    maybeLoadPricingInventory(dateRange),
    maybeLoadAttribution(dateRange),
  ]);

  const report = buildMarketingDecisionReport({
    decisionReport: {
      ...decisionReport,
      meta: inputs.meta,
    },
    periodClassified,
    independentClassified,
    attributionEconomics,
    pricingReport: invPricing.pricingReport,
    inventoryReport: invPricing.inventoryReport,
    primaryDays,
    period: dateRange,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printMarketingDecisionReport(report);
  }
}

main().catch((err) => {
  console.error("Marketing decisions failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
