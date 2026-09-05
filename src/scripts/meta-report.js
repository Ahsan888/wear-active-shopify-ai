#!/usr/bin/env node
/**
 * Meta Ads performance report (account insights by campaign/adset/ad).
 *
 * Usage:
 *   npm run meta:report
 *   npm run meta:report -- --days=7
 *   npm run meta:report -- --since=2026-09-01 --until=2026-09-06
 *   npm run meta:report -- --level=ad
 *   npm run meta:report -- --json
 */
const { graphGet, graphGetAll, getAdAccountId } = require("../meta/client");
const {
  enrichInsightRow,
  sumRows,
  formatMoney,
  formatNumber,
  formatPct,
  formatRoas,
} = require("../meta/metrics");
const {
  parseArgs,
  resolveDateRange,
  normalizeLevel,
  insightFieldsForLevel,
  hintForMetaError,
} = require("../meta/cli");

async function fetchAccount() {
  const actId = getAdAccountId();
  const res = await graphGet(actId, {
    fields: "id,name,account_status,currency,timezone_name,business_name",
  });
  return res.data;
}

async function fetchInsights(actId, { since, until, level }) {
  const fields = insightFieldsForLevel(level);
  const payload = await graphGetAll(`${actId}/insights`, {
    fields,
    level,
    time_range: JSON.stringify({ since, until }),
    limit: 500,
  });
  const raw = Array.isArray(payload.data) ? payload.data : [];
  return raw.map(enrichInsightRow);
}

function printHuman({ account, dateRange, level, totals, rows }) {
  const cur = account.currency || "PKR";
  console.log("META ADS REPORT");
  console.log(`Account: ${account.name} (${account.id})`);
  console.log(`Currency: ${cur} | Timezone: ${account.timezone_name || "—"}`);
  console.log(`Range: ${dateRange.since} → ${dateRange.until}`);
  console.log(`Level: ${level}`);
  console.log("");
  console.log("TOTALS");
  console.log(`  Spend:                ${formatMoney(totals.spend, cur)}`);
  console.log(`  Purchases:            ${formatNumber(totals.purchases, 0)}`);
  console.log(
    `  Purchase value:       ${formatMoney(totals.purchase_value, cur)}`
  );
  console.log(`  CPA:                  ${formatMoney(totals.cpa, cur)}`);
  console.log(`  ROAS:                 ${formatRoas(totals.roas)}`);
  console.log(`  Impressions:          ${formatNumber(totals.impressions, 0)}`);
  console.log(`  Reach (summed):       ${formatNumber(totals.reach, 0)}`);
  console.log(`  Frequency (approx):   ${formatNumber(totals.frequency, 2)}`);
  console.log(`  CPM:                  ${formatMoney(totals.cpm, cur)}`);
  console.log(`  CTR:                  ${formatPct(totals.ctr)}`);
  console.log(`  CPC:                  ${formatMoney(totals.cpc, cur)}`);
  console.log(
    `  Landing page views:   ${formatNumber(totals.landing_page_views, 0)}`
  );
  console.log(
    `  Add to carts:         ${formatNumber(totals.add_to_carts, 0)}`
  );
  console.log(
    `  Initiated checkouts:  ${formatNumber(totals.initiated_checkouts, 0)}`
  );
  console.log("");

  const labelKey =
    level === "ad"
      ? "ad_name"
      : level === "adset"
        ? "adset_name"
        : level === "campaign"
          ? "campaign_name"
          : null;

  if (!labelKey) {
    console.log("(account-level only — no breakdown rows)");
    return;
  }

  console.log(`ROWS BY ${level.toUpperCase()} (spend desc)`);
  if (!rows.length) {
    console.log("  (no insights for this range)");
    return;
  }

  const ranked = [...rows].sort((a, b) => (b.spend || 0) - (a.spend || 0));
  for (const row of ranked) {
    const name = row[labelKey] || "(unnamed)";
    const id =
      level === "ad"
        ? row.ad_id
        : level === "adset"
          ? row.adset_id
          : row.campaign_id;
    console.log(`— ${name}`);
    console.log(`    id=${id}`);
    console.log(
      `    spend=${formatMoney(row.spend, cur)}  purchases=${formatNumber(row.purchases, 0)}  ` +
        `value=${formatMoney(row.purchase_value, cur)}  ROAS=${formatRoas(row.roas)}  CPA=${formatMoney(row.cpa, cur)}`
    );
    console.log(
      `    imps=${formatNumber(row.impressions, 0)}  CTR=${formatPct(row.ctr)}  ` +
        `LPV=${formatNumber(row.landing_page_views, 0)}  ATC=${formatNumber(row.add_to_carts, 0)}  IC=${formatNumber(row.initiated_checkouts, 0)}`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const level = normalizeLevel(args.level);
  const account = await fetchAccount();
  const dateRange = resolveDateRange(args, account.timezone_name);
  const actId = account.id || getAdAccountId();

  const rows = await fetchInsights(actId, { ...dateRange, level });
  const totals = sumRows(rows);

  const payload = {
    generated_at: new Date().toISOString(),
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency || null,
      timezone_name: account.timezone_name || null,
      account_status: account.account_status ?? null,
      business_name: account.business_name || null,
    },
    date_range: dateRange,
    level,
    totals,
    rows: [...rows].sort((a, b) => (b.spend || 0) - (a.spend || 0)),
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printHuman({
    account: payload.account,
    dateRange,
    level,
    totals,
    rows: payload.rows,
  });
}

main().catch((err) => {
  console.error(err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
