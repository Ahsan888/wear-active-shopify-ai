#!/usr/bin/env node
/**
 * Daily operational reporting pipeline.
 *
 *   npm run reports:daily
 *   npm run reports:daily -- --date=2026-09-06 --days=7
 *   npm run reports:daily -- --dry-run
 *   npm run reports:daily -- --no-delivery
 */
const { hintForMetaError } = require("../meta/cli");
const {
  parseDailyArgs,
  runDailyReport,
  printDailySummary,
} = require("../operations/daily");

async function main() {
  const args = parseDailyArgs(process.argv.slice(2));
  const result = await runDailyReport({
    date: args.date,
    days: args.days,
    dryRun: args.dryRun,
    noDelivery: args.noDelivery,
    forceDelivery: args.forceDelivery,
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          summary: result.summary,
          snapshot: result.snapshot,
          attention_summary: result.alertsResult.attention_summary,
          alerts: result.alertsResult.alerts.filter((a) => a.status === "active"),
          delivery: result.delivery?.audit || null,
        },
        null,
        2
      )
    );
  } else {
    printDailySummary(result);
    console.log("\n—— Daily brief ——");
    console.log(result.brief.text);
  }

  if (result.deliveryError) {
    console.error(
      "Delivery failed after reports were saved:",
      result.deliveryError.message || result.deliveryError
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Daily reporting failed:", err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
