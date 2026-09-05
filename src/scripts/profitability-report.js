#!/usr/bin/env node
/**
 * Read-only blended Meta + Books profitability report.
 *
 * Usage:
 *   npm run profitability:report -- --days=7
 *   npm run profitability:report -- --since=2026-08-01 --until=2026-08-31
 *   npm run profitability:report -- --days=7 --json
 *
 * Never writes Sheets. Never mutates Meta. Never subtracts Meta spend
 * as an additional Books expense when Ledger Ads already exists.
 */
const { graphGet, getAdAccountId } = require("../meta/client");
const { enrichInsightRow } = require("../meta/metrics");
const {
  parseArgs,
  resolveDateRange,
  insightFieldsForLevel,
  hintForMetaError,
} = require("../meta/cli");
const { formatMoney, formatNumber, formatRoas, formatPct } = require("../meta/metrics");
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

const TIMEZONE = "Asia/Karachi";

async function fetchMetaAccountTotals(since, until) {
  const actId = getAdAccountId();
  const accountRes = await graphGet(actId, {
    fields: "id,name,currency,timezone_name,account_status",
  });
  const account = accountRes.data;
  const fields = insightFieldsForLevel("account");
  const insightsRes = await graphGet(`${actId}/insights`, {
    fields,
    level: "account",
    time_range: JSON.stringify({ since, until }),
    limit: 1,
  });
  const raw = insightsRes.data?.data || [];
  const totals = raw.length
    ? enrichInsightRow(raw[0])
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
    totals: {
      spend: totals.spend || 0,
      impressions: totals.impressions || 0,
      clicks: totals.clicks || 0,
      inline_link_clicks: totals.inline_link_clicks,
      landing_page_views: totals.landing_page_views || 0,
      add_to_carts: totals.add_to_carts || 0,
      initiated_checkouts: totals.initiated_checkouts || 0,
      purchases: totals.purchases || 0,
      purchase_value: totals.purchase_value || 0,
      cpa: totals.cpa,
      roas: totals.roas,
      cpm: totals.cpm,
      ctr: totals.ctr,
      cpc: totals.cpc,
      purchase_per_impression_pct: totals.purchase_per_impression_pct,
      lpv_to_atc_pct: totals.lpv_to_atc_pct,
      lpv_to_checkout_pct: totals.lpv_to_checkout_pct,
      lpv_to_purchase_pct: totals.lpv_to_purchase_pct,
      atc_to_checkout_pct: totals.atc_to_checkout_pct,
      checkout_to_purchase_pct: totals.checkout_to_purchase_pct,
      reach: totals.reach,
      frequency: totals.frequency,
    },
  };
}

function money(n, currency = "PKR") {
  return formatMoney(n, currency);
}

function printHuman(report) {
  const cur = report.meta.account?.currency || "PKR";
  const b = report.books;
  const m = report.meta.totals;
  const p = report.profitability;
  const blend = report.blended;
  const rec = report.ad_reconciliation;
  const pipe = report.pipeline;

  console.log("PERIOD");
  console.log(
    `  ${report.date_range.since} → ${report.date_range.until} (${report.date_range.timezone})` +
      (report.date_range.is_full_calendar_month ? "  [full calendar month]" : "  [partial period]")
  );
  console.log("");

  console.log("BOOKS — RECOGNIZED ACTUALS (Ledger)");
  console.log(`  Gross collected:              ${money(b.gross_collected, cur)}`);
  console.log(`  Output tax:                   ${money(b.output_tax, cur)}`);
  console.log(`  Revenue ex-tax:               ${money(b.revenue_ex_tax, cur)}`);
  console.log(`  Refunds:                      ${money(b.refunds, cur)}`);
  console.log(`  Net revenue ex-tax:           ${money(b.net_revenue_ex_tax, cur)}`);
  console.log(`  COGS:                         ${money(b.cogs, cur)}`);
  console.log(`  Gross profit:                 ${money(b.gross_profit, cur)}`);
  console.log(`  Gross margin:                 ${formatPct(b.gross_margin_pct)}`);
  console.log(`  Delivery expense:             ${money(b.delivery_expense, cur)}`);
  console.log(`  Ads expense booked (Ledger):  ${money(b.ads_expense_booked, cur)}`);
  console.log(`  Other non-ad opex:            ${money(b.other_non_ad_opex, cur)}`);
  console.log(`  Total opex:                   ${money(b.total_opex, cur)}`);
  console.log(`  Books net profit:             ${money(b.books_net_profit, cur)}`);
  console.log(`  Books net margin:             ${formatPct(b.books_net_margin_pct)}`);
  console.log(
    `  Recognized orders / paid units: ${b.recognized_orders} / ${formatNumber(b.recognized_units, 0)}` +
      (b.gift_units ? `  (gift units ${formatNumber(b.gift_units, 0)})` : "")
  );
  console.log(`  AOV (ex-tax):                 ${money(b.aov_ex_tax, cur)}`);
  console.log("");

  const mix = report.sales_mix?.channels || [];
  console.log("SALES MIX");
  if (!mix.length) {
    console.log("  (unavailable)");
  } else {
    for (const c of mix) {
      const pad = (c.channel + ":").padEnd(14);
      console.log(
        `  ${pad}${c.orders} orders · ${money(c.revenue_ex_tax, cur)} revenue · ${formatPct(c.revenue_share_pct)}`
      );
    }
  }
  console.log("");

  console.log("META ADS (Marketing API — attributed)");
  console.log(`  Account: ${report.meta.account?.name} (${report.meta.account?.id})`);
  console.log(`  Spend:                        ${money(m.spend, cur)}`);
  console.log(`  Impressions:                  ${formatNumber(m.impressions, 0)}`);
  console.log(`  Clicks / link clicks:         ${formatNumber(m.clicks, 0)} / ${formatNumber(m.inline_link_clicks, 0)}`);
  console.log(`  Landing page views:           ${formatNumber(m.landing_page_views, 0)}`);
  console.log(`  Add to carts:                 ${formatNumber(m.add_to_carts, 0)}`);
  console.log(`  Initiated checkouts:          ${formatNumber(m.initiated_checkouts, 0)}`);
  console.log(`  Purchases / purchase value:   ${formatNumber(m.purchases, 0)} / ${money(m.purchase_value, cur)}`);
  console.log(`  Meta CPA / Meta ROAS:         ${money(m.cpa, cur)} / ${formatRoas(m.roas)}`);
  console.log(
    `  LPV→ATC / ATC→IC / IC→Purch:  ${formatPct(m.lpv_to_atc_pct)} / ${formatPct(m.atc_to_checkout_pct)} / ${formatPct(m.checkout_to_purchase_pct)}`
  );
  console.log("");

  console.log("BLENDED PERFORMANCE (date-aligned — NOT order attribution)");
  console.log(`  Meta attributed ROAS:         ${formatRoas(blend.meta_attributed_roas)}`);
  console.log(
    `  Blended MER:                  ${blend.blended_mer == null ? "—" : `${Number(blend.blended_mer).toFixed(2)}x`}`
  );
  console.log(
    `  Business-wide ad load / order: ${money(blend.business_wide_ad_load_per_recognized_order ?? blend.blended_ad_cost_per_recognized_order, cur)}`
  );
  console.log(
    `  Shopify ad load / order:       ${money(blend.shopify_ad_load_per_recognized_order, cur)}`
  );
  console.log(`  Business break-even CPA:       ${money(p.break_even_cpa, cur)}`);
  console.log(
    "  Note: Shopify ad load = Meta spend ÷ Shopify orders (context only; not CAC / not attributed)."
  );
  console.log("  No Meta→Shopify order attribution applied.");
  console.log("");

  console.log("META-ADJUSTED PROFITABILITY (analytical / pro-forma)");
  console.log(`  Profit before ads:            ${money(p.profit_before_ads, cur)}`);
  console.log(`  Meta-adjusted profit:         ${money(p.meta_adjusted_profit, cur)}`);
  console.log(`  Meta-adjusted margin:         ${formatPct(p.meta_adjusted_margin_pct)}`);
  console.log(`  Break-even ad spend:          ${money(p.break_even_ad_spend, cur)}`);
  console.log(`  Break-even CPA (blended):     ${money(p.break_even_cpa, cur)}`);
  console.log(
    `  Pre-ad margin / BE ROAS:      ${p.pre_ad_profit_margin == null ? "—" : Number(p.pre_ad_profit_margin).toFixed(4)} / ${p.break_even_roas == null ? "—" : `${p.break_even_roas}x`}`
  );
  console.log(`  Meta spend treatment:         ${p.meta_spend_treatment}`);
  console.log("");

  console.log("ADS RECONCILIATION");
  console.log(`  Meta actual spend:            ${money(rec.meta_spend, cur)}`);
  console.log(`  Ledger Ads expense:           ${money(rec.ledger_ads_expense, cur)}`);
  console.log(`  Recurring Expenses Ads:       ${money(rec.recurring_ads_expense, cur)}`);
  console.log(`  Meta − Ledger variance:       ${money(rec.meta_vs_ledger_variance, cur)}`);
  console.log(`  Ledger − Recurring variance:  ${money(rec.ledger_vs_recurring_variance, cur)}`);
  console.log(`  Status:                       ${rec.ad_spend_reconciliation_status}`);
  if (rec.matching) {
    console.log(
      `  Match (heuristic):            matched ${rec.matching.likely_matched_recurring_ads_rows}/${rec.matching.recurring_ads_rows} recurring; ` +
        `unmatched ledger ${rec.matching.unmatched_ledger_ads_rows.length}`
    );
  }
  console.log("");

  console.log("PRODUCT ECONOMICS (Ledger Sale/COGS — no Meta allocation)");
  const top = (report.products || []).slice(0, 10);
  if (!top.length) {
    console.log("  (no product sales in range)");
  } else {
    for (const row of top) {
      console.log(
        `  ${row.sku || "(no sku)"}  ${row.product}  units=${formatNumber(row.units, 0)}  ` +
          `rev=${money(row.revenue_ex_tax, cur)}  cogs=${money(row.cogs, cur)}  ` +
          `gp=${money(row.gross_profit, cur)}  gm=${formatPct(row.gross_margin_pct)}` +
          (row.flags?.length ? `  [${row.flags.join(",")}]` : "")
      );
    }
    if (report.products.length > 10) {
      console.log(`  … ${report.products.length - 10} more SKUs in JSON`);
    }
  }
  console.log("");

  console.log("OPEN PIPELINE — NOT REVENUE");
  console.log(`  Open orders / units:          ${pipe.open_pipeline_orders} / ${formatNumber(pipe.open_pipeline_units, 0)}`);
  console.log(`  Open gross (customer value):  ${money(pipe.open_pipeline_gross, cur)}`);
  console.log("  Label: pipeline_not_revenue");
  console.log("");

  console.log("DATA QUALITY / WARNINGS");
  const warns = report.data_quality?.warnings || [];
  if (!warns.length) {
    console.log("  (none)");
  } else {
    for (const w of warns) {
      console.log(`  [${w.severity}] ${w.code}: ${w.message}`);
    }
  }
}

async function buildReport(dateRange) {
  const { since, until } = dateRange;
  const fullMonth = isFullCalendarMonth(since, until);

  const [ledger, recurring, vm, live, meta] = await Promise.all([
    loadLedger(),
    loadRecurringExpenses(),
    loadVariantMaster(),
    loadLiveOrders(),
    fetchMetaAccountTotals(since, until),
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
  const pipeline = aggregateOpenPipeline(live.data, live.header);

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
    warnings.push(
      buildWarning("break_even_note", "info", msg, {})
    );
  }
  for (const p of ledgerAgg.products) {
    for (const flag of p.flags || []) {
      if (flag === "sku_missing_from_variant_master" || flag === "missing_cost_per_item") {
        warnings.push(
          buildWarning(flag, "info", `${flag} for SKU ${p.sku || "(none)"}`, {
            sku: p.sku,
          })
        );
      }
    }
  }
  // Deduplicate warning codes with same message
  const seen = new Set();
  const uniqueWarnings = [];
  for (const w of warnings) {
    const key = `${w.code}|${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueWarnings.push(w);
  }

  return {
    generated_at: new Date().toISOString(),
    date_range: {
      since,
      until,
      timezone: meta.account.timezone_name || TIMEZONE,
      is_full_calendar_month: fullMonth,
    },
    books: ledgerAgg.books,
    sales_by_channel: ledgerAgg.sales_by_channel,
    sales_mix: ledgerAgg.sales_mix,
    meta: {
      account: meta.account,
      totals: meta.totals,
    },
    blended: bundle.blended,
    profitability: bundle.profitability,
    ad_reconciliation: recon.ad_reconciliation,
    pipeline,
    products: ledgerAgg.products,
    gift_product_costs: ledgerAgg.gift_product_costs,
    gift_units_by_key: ledgerAgg.gift_units_by_key,
    data_quality: {
      warnings: uniqueWarnings,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dateRange = resolveDateRange(args, TIMEZONE);
  const report = await buildReport(dateRange);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printHuman(report);
}

main().catch((err) => {
  console.error(err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
