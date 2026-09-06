#!/usr/bin/env node
/**
 * Deep Meta Ads Audit (read-only).
 *
 *   npm run ads:audit -- --days=30
 *   npm run ads:audit -- --days=14 --json
 *
 * Writes:
 *   reports/ads-audit/index.html
 *   reports/ads-audit/ads-audit.json
 *
 * Never creates/edits/pauses ads or changes budgets.
 */
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { parseArgs, resolveDateRange, hintForMetaError } = require("../meta/cli");
const { getAdAccountId } = require("../meta/client");
const { buildAdsAudit, renderAdsAuditHtml } = require("../ads-audit");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.days == null && !args.since && !args.until) {
    args.days = 30;
  }

  const actId = getAdAccountId();
  if (actId !== "act_4074524202691358") {
    console.warn(
      `Warning: META_AD_ACCOUNT_ID is ${actId}, expected act_4074524202691358`
    );
  }

  // Resolve dates using account timezone when possible
  let timezone = "Asia/Karachi";
  try {
    const { fetchAccount } = require("../ads-audit/fetch");
    const account = await fetchAccount();
    timezone = account.timezone_name || timezone;
  } catch {
    // continue with Karachi default
  }

  const dateRange = resolveDateRange(args, timezone);
  const days =
    args.days ||
    Math.round(
      (new Date(dateRange.until) - new Date(dateRange.since)) / 86400000
    ) + 1;

  console.log("WEAR ACTIVE — META ADS AUDIT (read-only)");
  console.log(`Account: ${actId}`);
  console.log(`Range:   ${dateRange.since} → ${dateRange.until} (${days}d)`);
  console.log("Fetching structure + performance + creatives + targeting...");

  const audit = await buildAdsAudit({
    since: dateRange.since,
    until: dateRange.until,
    days,
  });

  const outDir = path.join(process.cwd(), "reports", "ads-audit");
  ensureDir(outDir);
  const jsonPath = path.join(outDir, "ads-audit.json");
  const htmlPath = path.join(outDir, "index.html");

  fs.writeFileSync(jsonPath, JSON.stringify(audit, null, 2));
  fs.writeFileSync(htmlPath, renderAdsAuditHtml(audit));

  const s = audit.summary || {};
  console.log("");
  console.log("ACCOUNT SUMMARY (primary window)");
  console.log(`  Spend:           ${s.spend}`);
  console.log(`  Meta purchases:  ${s.purchases}`);
  console.log(`  Meta revenue:    ${s.purchase_value}`);
  console.log(`  Meta ROAS:       ${s.roas}`);
  console.log(`  Meta CPA:        ${s.cpa}`);
  console.log(`  CTR:             ${s.ctr}`);
  console.log(`  CPC:             ${s.cpc}`);
  console.log(`  LPV:             ${s.landing_page_views}`);
  console.log("");
  console.log(
    `Active: campaigns=${audit.structure?.counts?.active_campaigns} ` +
      `adsets=${audit.structure?.counts?.active_adsets} ` +
      `ads=${audit.structure?.counts?.active_ads}`
  );
  console.log("");
  console.log("WRITTEN");
  console.log(`  ${htmlPath}`);
  console.log(`  ${jsonPath}`);

  if (args.json) {
    // Already written; also echo path marker for pipelines
    console.log(`JSON=${jsonPath}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
