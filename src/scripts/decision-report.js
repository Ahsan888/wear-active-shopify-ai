#!/usr/bin/env node
/**
 * Read-only decision intelligence report (Phase 3).
 *
 * Usage:
 *   npm run decisions:report -- --days=7
 *   npm run decisions:report -- --days=14
 *   npm run decisions:report -- --days=30
 *   npm run decisions:report -- --since=2026-08-01 --until=2026-08-31
 *   npm run decisions:report -- --days=7 --json
 *
 * Advisory only — never writes Sheets, never mutates Meta.
 */
const { graphGet, graphGetAll, getAdAccountId } = require("../meta/client");
const { enrichInsightRow } = require("../meta/metrics");
const {
  parseArgs,
  resolveDateRange,
  insightFieldsForLevel,
  hintForMetaError,
} = require("../meta/cli");
const {
  loadLedger,
  loadRecurringExpenses,
  loadVariantMaster,
  loadLiveOrders,
  aggregateLedgerPeriod,
  aggregateRecurringAds,
  aggregateOpenPipeline,
} = require("../profitability/books");
const { buildProfitabilityBundle } = require("../profitability/metrics");
const {
  reconcileAds,
  isFullCalendarMonth,
  buildWarning,
} = require("../profitability/reconciliation");
const {
  buildDecisionReport,
  printDecisionReport,
} = require("../decisions/report");

const TIMEZONE = "Asia/Karachi";

async function fetchMetaBundle(since, until) {
  const actId = getAdAccountId();
  const accountRes = await graphGet(actId, {
    fields: "id,name,currency,timezone_name,account_status",
  });
  const account = accountRes.data;

  async function level(lvl) {
    const fields = insightFieldsForLevel(lvl);
    const payload = await graphGetAll(`${actId}/insights`, {
      fields,
      level: lvl,
      time_range: JSON.stringify({ since, until }),
      limit: 500,
    });
    return (payload.data || []).map(enrichInsightRow);
  }

  const [accountRows, campaigns, ads] = await Promise.all([
    level("account"),
    level("campaign"),
    level("ad"),
  ]);

  const totals = accountRows.length
    ? accountRows[0]
    : enrichInsightRow({
        spend: 0,
        impressions: 0,
        clicks: 0,
        actions: [],
        action_values: [],
      });

  return {
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency || "PKR",
      timezone_name: account.timezone_name || TIMEZONE,
    },
    totals,
    campaigns,
    ads,
  };
}

async function loadPhase2Inputs(since, until) {
  const fullMonth = isFullCalendarMonth(since, until);
  const [ledger, recurring, vm, live, meta] = await Promise.all([
    loadLedger(),
    loadRecurringExpenses(),
    loadVariantMaster(),
    loadLiveOrders(),
    fetchMetaBundle(since, until),
  ]);

  const ledgerAgg = aggregateLedgerPeriod(
    ledger.data,
    ledger.header,
    since,
    until,
    vm.bySku
  );
  const recurringAgg = aggregateRecurringAds(
    recurring.data,
    recurring.header,
    since,
    until
  );
  // Pipeline loaded for data-quality completeness; not revenue
  aggregateOpenPipeline(live.data, live.header);

  const meta_spend = meta.totals.spend || 0;
  const bundle = buildProfitabilityBundle({
    books: ledgerAgg.books,
    meta_spend,
    meta_roas: meta.totals.roas,
  });

  const recon = reconcileAds({
    since,
    until,
    meta_spend,
    ledger_ads_expense: ledgerAgg.books.ads_expense_booked,
    recurring_ads_expense: recurringAgg.recurring_ads_expense,
    ledgerAdsRows: ledgerAgg.ads_rows,
    recurringAdsRows: recurringAgg.recurring_ads_rows,
    expenseRows: ledgerAgg.expense_rows,
  });

  const warnings = [...recon.warnings];
  for (const msg of bundle.break_even_warnings || []) {
    warnings.push(buildWarning("break_even_note", "info", msg, {}));
  }
  for (const p of ledgerAgg.products) {
    for (const flag of p.flags || []) {
      if (
        flag === "sku_missing_from_variant_master" ||
        flag === "missing_cost_per_item"
      ) {
        warnings.push(
          buildWarning(flag, "info", `${flag} for SKU ${p.sku || "(none)"}`, {
            sku: p.sku,
          })
        );
      }
    }
  }
  const seen = new Set();
  const uniqueWarnings = [];
  for (const w of warnings) {
    const key = `${w.code}|${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueWarnings.push(w);
  }

  return {
    date_range: {
      since,
      until,
      timezone: meta.account.timezone_name || TIMEZONE,
      is_full_calendar_month: fullMonth,
    },
    books: ledgerAgg.books,
    profitability: bundle.profitability,
    blended: bundle.blended,
    meta: {
      account: meta.account,
      totals: meta.totals,
    },
    products: ledgerAgg.products,
    warnings: uniqueWarnings,
    ad_reconciliation: recon.ad_reconciliation,
    campaigns: meta.campaigns,
    ads: meta.ads,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dateRange = resolveDateRange(args, TIMEZONE);
  const inputs = await loadPhase2Inputs(dateRange.since, dateRange.until);
  const report = buildDecisionReport(inputs);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printDecisionReport(report);
  }
}

main().catch((err) => {
  console.error("Decision report failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
