#!/usr/bin/env node
/**
 * Phase 5B — first-party attributed economics CLI.
 *
 *   npm run attribution:economics -- --days=7
 *   npm run attribution:economics -- --since=2026-08-01 --until=2026-09-06 --json
 *
 * Read-only — no Meta/Sheets mutations. Does not alter decision classifiers.
 */
require("dotenv").config();
const { hintForMetaError } = require("../meta/cli");
const {
  fetchOrdersForAttribution,
  resolveAttributionWindow,
} = require("../attribution/fetchOrders");
const {
  indexRecognizedShopifyOrderEconomics,
} = require("../attribution/ledgerJoin");
const { buildAttributedEconomics } = require("../attribution/entityEconomics");
const { printAttributedEconomics } = require("../attribution/economicsReport");
const { loadDecisionInputs } = require("../decisions/loadInputs");
const { loadLedger } = require("../profitability/books");

function parseArgs(argv) {
  const out = { json: false, days: null, since: null, until: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a.startsWith("--days=")) {
      out.days = Number(a.slice(7));
      continue;
    }
    if (a === "--days") {
      out.days = Number(argv[++i]);
      continue;
    }
    if (a.startsWith("--since=")) {
      out.since = a.slice(8);
      continue;
    }
    if (a === "--since") {
      out.since = argv[++i];
      continue;
    }
    if (a.startsWith("--until=")) {
      out.until = a.slice(8);
      continue;
    }
    if (a === "--until") {
      out.until = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }
  if (out.days != null && (!Number.isInteger(out.days) || out.days < 1)) {
    throw new Error("Invalid --days");
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const period = resolveAttributionWindow(args);

  const [orders, inputs, ledger] = await Promise.all([
    fetchOrdersForAttribution(period),
    loadDecisionInputs(period.since, period.until),
    loadLedger(),
  ]);

  const ledgerByOrderId = indexRecognizedShopifyOrderEconomics(
    ledger.data,
    ledger.header,
    period.since,
    period.until
  );

  const shopifyChannel = inputs.sales_by_channel?.Shopify || {};

  const report = buildAttributedEconomics({
    orders,
    ledgerByOrderId,
    metaEntities: {
      campaigns: inputs.campaigns || [],
      adsets: inputs.adsets || [],
      ads: inputs.ads || [],
    },
    meta_spend_total: inputs.meta?.totals?.spend || 0,
    shopify_channel: shopifyChannel,
    period,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printAttributedEconomics(report);
  }
}

main().catch((err) => {
  console.error("Attribution economics failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
