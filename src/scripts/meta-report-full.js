#!/usr/bin/env node
/**
 * Full Meta Ads export: campaign + adset + ad insights (+ light ad metadata).
 * Writes under reports/meta/<since>_to_<until>/ (gitignored data files).
 *
 * Usage:
 *   npm run meta:report:full -- --days=7
 *   npm run meta:report:full -- --since=2026-08-01 --until=2026-09-05
 */
const fs = require("fs");
const path = require("path");
const { graphGet, graphGetAll, getAdAccountId } = require("../meta/client");
const { enrichInsightRow, sumRows } = require("../meta/metrics");
const {
  parseArgs,
  resolveDateRange,
  insightFieldsForLevel,
  hintForMetaError,
} = require("../meta/cli");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c)).join(",");
  const lines = rows.map((row) =>
    columns.map((c) => csvEscape(row[c])).join(",")
  );
  return [header, ...lines].join("\n") + "\n";
}

async function fetchAccount() {
  const actId = getAdAccountId();
  const res = await graphGet(actId, {
    fields: "id,name,account_status,currency,timezone_name,business_name",
  });
  return res.data;
}

async function fetchLevelInsights(actId, level, since, until) {
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

async function fetchAccountTotals(actId, since, until) {
  const fields = insightFieldsForLevel("account");
  const payload = await graphGetAll(`${actId}/insights`, {
    fields,
    level: "account",
    time_range: JSON.stringify({ since, until }),
    limit: 1,
  });
  const raw = Array.isArray(payload.data) ? payload.data : [];
  if (!raw.length) return sumRows([]);
  return enrichInsightRow(raw[0]);
}

/**
 * Light ad object metadata — avoid deep/fragile creative field trees.
 */
async function fetchAdMetadata(actId) {
  const payload = await graphGetAll(`${actId}/ads`, {
    fields: [
      "id",
      "name",
      "status",
      "effective_status",
      "campaign_id",
      "adset_id",
      "creative{id,name,title,body,image_url,thumbnail_url,video_id}",
    ].join(","),
    limit: 200,
  });
  const ads = Array.isArray(payload.data) ? payload.data : [];
  return ads.map((ad) => {
    const creative = ad.creative || {};
    return {
      ad_id: ad.id,
      ad_name: ad.name,
      status: ad.status || null,
      effective_status: ad.effective_status || null,
      campaign_id: ad.campaign_id || null,
      adset_id: ad.adset_id || null,
      creative_id: creative.id || null,
      creative_name: creative.name || null,
      creative_title: creative.title || null,
      creative_body: creative.body || null,
      creative_image_url: creative.image_url || null,
      creative_thumbnail_url: creative.thumbnail_url || null,
      creative_video_id: creative.video_id || null,
    };
  });
}

function insightCsvColumns(level) {
  const base = [
    "spend",
    "impressions",
    "reach",
    "frequency",
    "clicks",
    "inline_link_clicks",
    "cpm",
    "ctr",
    "cpc",
    "purchases",
    "purchase_value",
    "purchase_action_type",
    "purchase_value_action_type",
    "cpa",
    "roas",
    "add_to_carts",
    "initiated_checkouts",
    "landing_page_views",
    "purchase_per_impression_pct",
    "lpv_to_atc_pct",
    "lpv_to_checkout_pct",
    "lpv_to_purchase_pct",
    "atc_to_checkout_pct",
    "checkout_to_purchase_pct",
    "date_start",
    "date_stop",
  ];
  if (level === "campaign") {
    return ["campaign_id", "campaign_name", ...base];
  }
  if (level === "adset") {
    return ["campaign_id", "campaign_name", "adset_id", "adset_name", ...base];
  }
  return [
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    ...base,
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const account = await fetchAccount();
  const dateRange = resolveDateRange(args, account.timezone_name);
  const actId = account.id || getAdAccountId();
  const { since, until } = dateRange;

  console.log(`Fetching Meta full report for ${account.name} (${actId})`);
  console.log(`Range: ${since} → ${until}`);

  const [accountTotals, campaigns, adsets, adsInsights, adsMeta] =
    await Promise.all([
      fetchAccountTotals(actId, since, until),
      fetchLevelInsights(actId, "campaign", since, until),
      fetchLevelInsights(actId, "adset", since, until),
      fetchLevelInsights(actId, "ad", since, until),
      fetchAdMetadata(actId).catch((err) => {
        console.warn(
          `Ad metadata fetch warning: ${err.message || err} (continuing with insights only)`
        );
        return [];
      }),
    ]);

  const metaByAdId = new Map(adsMeta.map((a) => [String(a.ad_id), a]));
  const adsJoined = adsInsights.map((row) => {
    const meta = metaByAdId.get(String(row.ad_id)) || {};
    return { ...row, ...meta, ad_id: row.ad_id, ad_name: row.ad_name || meta.ad_name };
  });

  // Include ads that have metadata but zero insights in-range
  for (const meta of adsMeta) {
    if (!adsJoined.some((r) => String(r.ad_id) === String(meta.ad_id))) {
      adsJoined.push({
        ...enrichInsightRow({}),
        ...meta,
        spend: 0,
        impressions: 0,
        purchases: 0,
        purchase_value: 0,
      });
    }
  }

  const folderName = `${since}_to_${until}`;
  const outDir = path.join(process.cwd(), "reports", "meta", folderName);
  ensureDir(outDir);

  const summary = {
    generated_at: new Date().toISOString(),
    source: "meta_marketing_api",
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency || null,
      timezone_name: account.timezone_name || null,
      account_status: account.account_status ?? null,
      business_name: account.business_name || null,
    },
    date_range: dateRange,
    totals: accountTotals,
    counts: {
      campaigns: campaigns.length,
      adsets: adsets.length,
      // ads_with_insights = Insights rows for the selected date range
      ads_with_insights: adsInsights.length,
      // ads_metadata = ads fetched from the account ads catalog (all ads)
      ads_metadata: adsMeta.length,
      // ads_total_exported = joined export rows (insights ∪ metadata; may include 0-spend ads)
      ads_total_exported: adsJoined.length,
    },
    files: {
      summary: "summary.json",
      campaigns_csv: "campaigns.csv",
      adsets_csv: "adsets.csv",
      ads_csv: "ads.csv",
      ads_json: "ads.json",
      campaigns_json: "campaigns.json",
      adsets_json: "adsets.json",
    },
  };

  fs.writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2)
  );
  fs.writeFileSync(
    path.join(outDir, "campaigns.json"),
    JSON.stringify(
      {
        generated_at: summary.generated_at,
        account_id: account.id,
        date_range: dateRange,
        rows: campaigns.sort((a, b) => (b.spend || 0) - (a.spend || 0)),
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(outDir, "adsets.json"),
    JSON.stringify(
      {
        generated_at: summary.generated_at,
        account_id: account.id,
        date_range: dateRange,
        rows: adsets.sort((a, b) => (b.spend || 0) - (a.spend || 0)),
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(outDir, "ads.json"),
    JSON.stringify(
      {
        generated_at: summary.generated_at,
        account_id: account.id,
        date_range: dateRange,
        rows: adsJoined.sort((a, b) => (b.spend || 0) - (a.spend || 0)),
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(outDir, "campaigns.csv"),
    toCsv(
      campaigns.sort((a, b) => (b.spend || 0) - (a.spend || 0)),
      insightCsvColumns("campaign")
    )
  );
  fs.writeFileSync(
    path.join(outDir, "adsets.csv"),
    toCsv(
      adsets.sort((a, b) => (b.spend || 0) - (a.spend || 0)),
      insightCsvColumns("adset")
    )
  );
  fs.writeFileSync(
    path.join(outDir, "ads.csv"),
    toCsv(
      adsJoined.sort((a, b) => (b.spend || 0) - (a.spend || 0)),
      [
        ...insightCsvColumns("ad"),
        "status",
        "effective_status",
        "creative_id",
        "creative_name",
        "creative_title",
        "creative_body",
        "creative_image_url",
        "creative_thumbnail_url",
        "creative_video_id",
      ]
    )
  );

  console.log("");
  console.log("META FULL REPORT WRITTEN");
  console.log(`  ${outDir}`);
  console.log(
    `  totals: spend=${accountTotals.spend} purchases=${accountTotals.purchases} roas=${accountTotals.roas}`
  );
  console.log(
    `  rows: campaigns=${campaigns.length} adsets=${adsets.length} ` +
      `ads_with_insights=${adsInsights.length} ads_metadata=${adsMeta.length} ` +
      `ads_total_exported=${adsJoined.length}`
  );
}

main().catch((err) => {
  console.error(err.message || err);
  const hint = hintForMetaError(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
});
