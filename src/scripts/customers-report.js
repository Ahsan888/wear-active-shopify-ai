#!/usr/bin/env node
/**
 * Phase 6 — Customer & Cohort Economics (advisory only).
 *
 *   npm run customers:report -- --days=90
 *   npm run customers:report -- --since=2026-06-01 --until=2026-09-06 --json
 *
 * No CRM/Shopify/Meta mutations. Observed value only — not predictive LTV.
 */
require("dotenv").config({ quiet: true });
const { parseArgs, resolveDateRange, hintForMetaError } = require("../meta/cli");
const { TIMEZONE, addDaysYmd } = require("../operations/dates");
const { loadLedger } = require("../profitability/books");
const { loadDecisionInputs } = require("../decisions/loadInputs");
const {
  fetchOrdersForAttribution,
} = require("../attribution/fetchOrders");
const {
  indexRecognizedShopifyOrderEconomics,
} = require("../attribution/ledgerJoin");
const { buildCustomerEconomics } = require("../customers/build");
const { printCustomerReport } = require("../customers/report");
const { assertNoRawPii } = require("../customers/identity");

const DEFAULT_HISTORY_DAYS = Math.max(
  180,
  Number(process.env.CUSTOMER_HISTORY_DAYS) || 540
);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Default days=90 for customer report when unspecified
  if (args.days == null && !args.since && !args.until) {
    args.days = 90;
  }
  const period = resolveDateRange(args, TIMEZONE);

  const historyUntil = period.until;
  const historySince = addDaysYmd(historyUntil, -(DEFAULT_HISTORY_DAYS - 1));
  const history = { since: historySince, until: historyUntil };

  const maxPages = Math.max(
    40,
    Number(process.env.CUSTOMER_ORDER_MAX_PAGES) || 80
  );

  const [orders, ledger, inputs] = await Promise.all([
    fetchOrdersForAttribution({ ...history, maxPages }),
    loadLedger(),
    loadDecisionInputs(period.since, period.until),
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
    period,
    history,
    meta_spend_total: inputs.meta?.totals?.spend || 0,
  });

  // Never emit raw email
  const json = JSON.stringify(report);
  assertNoRawPii(json);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printCustomerReport(report);
  }
}

main().catch((err) => {
  console.error("Customer economics failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
