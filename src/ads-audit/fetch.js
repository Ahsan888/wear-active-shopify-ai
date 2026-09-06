/**
 * Read-only Meta Marketing API fetchers for the deep ads audit.
 * Uses existing graphGet / graphGetAll — never POSTs or mutates ads.
 */
const { graphGet, graphGetAll, getAdAccountId } = require("../meta/client");
const { enrichAuditInsightRow } = require("./enrich");
const {
  insightFieldsForAuditLevel,
  coreInsightFieldsForLevel,
  CAMPAIGN_FIELDS,
  ADSET_FIELDS,
  AD_FIELDS_FULL,
  AD_FIELDS_LIGHT,
} = require("./fields");
const { normalizeCreative } = require("./creative");
const { summarizeTargeting } = require("./targeting");

function isFieldError(err) {
  const code = err?.meta?.code;
  const msg = String(err?.message || "");
  return code === 100 || /unknown field|nonexisting field|invalid parameter/i.test(msg);
}

async function fetchAccount() {
  const actId = getAdAccountId();
  const res = await graphGet(actId, {
    fields: "id,name,account_status,currency,timezone_name,business_name,amount_spent,balance",
  });
  return res.data;
}

/**
 * Fetch insights for a level. Tries full audit fields first; on unsupported
 * field errors, falls back to core fields and records unavailable metrics.
 */
async function fetchLevelInsights(actId, level, since, until, dataQuality) {
  const tryFields = [
    insightFieldsForAuditLevel(level),
    coreInsightFieldsForLevel(level),
  ];
  let lastErr = null;
  for (let i = 0; i < tryFields.length; i += 1) {
    try {
      const payload = await graphGetAll(`${actId}/insights`, {
        fields: tryFields[i],
        level,
        time_range: JSON.stringify({ since, until }),
        limit: 500,
      });
      const raw = Array.isArray(payload.data) ? payload.data : [];
      const pages = payload.paging?.pages || 1;
      if (i > 0) {
        dataQuality.unavailable_insight_fields.push({
          level,
          note: "Fell back to core insight fields after extended field request failed",
          error: lastErr?.message || null,
        });
      }
      dataQuality.pagination.push({
        path: `${actId}/insights`,
        level,
        since,
        until,
        pages,
        truncated: false,
        rows: raw.length,
      });
      return raw.map((row) =>
        enrichAuditInsightRow(row, {
          unavailable_fields:
            i > 0
              ? [
                  "outbound_clicks",
                  "video_play_actions",
                  "video_thruplay_watched_actions",
                  "video_p25_watched_actions",
                  "video_p50_watched_actions",
                  "video_p75_watched_actions",
                  "video_p95_watched_actions",
                  "video_p100_watched_actions",
                  "video_avg_time_watched_actions",
                ]
              : [],
        })
      );
    } catch (err) {
      lastErr = err;
      if (i === 0 && isFieldError(err)) continue;
      // Pagination truncation is thrown by graphGetAll — record it
      if (/pagination exceeded maxPages/i.test(String(err.message || ""))) {
        dataQuality.pagination.push({
          path: `${actId}/insights`,
          level,
          since,
          until,
          truncated: true,
          error: err.message,
        });
      }
      throw err;
    }
  }
  throw lastErr || new Error("Failed to fetch insights");
}

async function fetchAccountTotals(actId, since, until, dataQuality) {
  const rows = await fetchLevelInsights(
    actId,
    "account",
    since,
    until,
    dataQuality
  );
  if (!rows.length) {
    return enrichAuditInsightRow({});
  }
  return rows[0];
}

async function fetchCampaigns(actId, dataQuality) {
  try {
    const payload = await graphGetAll(`${actId}/campaigns`, {
      fields: CAMPAIGN_FIELDS,
      limit: 200,
    });
    const rows = Array.isArray(payload.data) ? payload.data : [];
    dataQuality.pagination.push({
      path: `${actId}/campaigns`,
      pages: payload.paging?.pages || 1,
      rows: rows.length,
      truncated: false,
    });
    return rows.map((c) => ({
      campaign_id: String(c.id),
      name: c.name || null,
      status: c.status || null,
      effective_status: c.effective_status || null,
      objective: c.objective || null,
      buying_type: c.buying_type || null,
      daily_budget: c.daily_budget != null ? Number(c.daily_budget) / 100 : null,
      lifetime_budget:
        c.lifetime_budget != null ? Number(c.lifetime_budget) / 100 : null,
      created_time: c.created_time || null,
      updated_time: c.updated_time || null,
    }));
  } catch (err) {
    dataQuality.errors.push({
      area: "campaigns",
      message: err.message || String(err),
    });
    return [];
  }
}

async function fetchAdsets(actId, dataQuality) {
  try {
    const payload = await graphGetAll(`${actId}/adsets`, {
      fields: ADSET_FIELDS,
      limit: 200,
    });
    const rows = Array.isArray(payload.data) ? payload.data : [];
    dataQuality.pagination.push({
      path: `${actId}/adsets`,
      pages: payload.paging?.pages || 1,
      rows: rows.length,
      truncated: false,
    });
    return rows.map((a) => {
      const targeting = a.targeting || null;
      const summary = summarizeTargeting(targeting, {
        optimization_goal: a.optimization_goal || null,
      });
      return {
        adset_id: String(a.id),
        campaign_id: a.campaign_id ? String(a.campaign_id) : null,
        name: a.name || null,
        status: a.status || null,
        effective_status: a.effective_status || null,
        optimization_goal: a.optimization_goal || null,
        billing_event: a.billing_event || null,
        bid_strategy: a.bid_strategy || null,
        daily_budget:
          a.daily_budget != null ? Number(a.daily_budget) / 100 : null,
        lifetime_budget:
          a.lifetime_budget != null ? Number(a.lifetime_budget) / 100 : null,
        start_time: a.start_time || null,
        end_time: a.end_time || null,
        attribution_spec: a.attribution_spec || null,
        destination_type: a.destination_type || null,
        is_dynamic_creative: Boolean(a.is_dynamic_creative),
        promoted_object: a.promoted_object || null,
        targeting,
        targeting_summary: summary,
        learning_phase_info: a.learning_phase_info || null,
      };
    });
  } catch (err) {
    dataQuality.errors.push({
      area: "adsets",
      message: err.message || String(err),
    });
    return [];
  }
}

async function fetchAdsCatalog(actId, dataQuality) {
  const attempts = [AD_FIELDS_FULL, AD_FIELDS_LIGHT];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      const payload = await graphGetAll(`${actId}/ads`, {
        fields: attempts[i],
        limit: 200,
      });
      const rows = Array.isArray(payload.data) ? payload.data : [];
      dataQuality.pagination.push({
        path: `${actId}/ads`,
        pages: payload.paging?.pages || 1,
        rows: rows.length,
        truncated: false,
        creative_fields: i === 0 ? "full" : "light",
      });
      if (i > 0) {
        dataQuality.missing_creative_metadata.push({
          note: "Fell back to light creative fields after full creative request failed",
          error: lastErr?.message || null,
        });
      }
      return rows.map((ad) => {
        const creative = normalizeCreative(ad.creative || {});
        if (creative.missing_fields?.length) {
          dataQuality.missing_creative_metadata.push({
            ad_id: String(ad.id),
            missing_fields: creative.missing_fields,
          });
        }
        return {
          ad_id: String(ad.id),
          ad_name: ad.name || null,
          campaign_id: ad.campaign_id ? String(ad.campaign_id) : null,
          adset_id: ad.adset_id ? String(ad.adset_id) : null,
          status: ad.status || null,
          effective_status: ad.effective_status || null,
          configured_status: ad.configured_status || null,
          creative_id: creative.creative_id,
          creative,
        };
      });
    } catch (err) {
      lastErr = err;
      if (i === 0 && isFieldError(err)) continue;
      dataQuality.errors.push({
        area: "ads_catalog",
        message: err.message || String(err),
      });
      return [];
    }
  }
  return [];
}

/**
 * Fetch structure + primary-window performance.
 */
async function fetchAuditStructure(since, until) {
  const dataQuality = emptyDataQuality();
  const account = await fetchAccount();
  const actId = account.id || getAdAccountId();

  if (String(actId) !== "act_4074524202691358") {
    dataQuality.warnings.push({
      code: "unexpected_ad_account",
      message: `Expected act_4074524202691358, got ${actId}`,
    });
  }

  const [campaigns, adsets, adsCatalog, accountTotals, campaignInsights, adsetInsights, adInsights] =
    await Promise.all([
      fetchCampaigns(actId, dataQuality),
      fetchAdsets(actId, dataQuality),
      fetchAdsCatalog(actId, dataQuality),
      fetchAccountTotals(actId, since, until, dataQuality),
      fetchLevelInsights(actId, "campaign", since, until, dataQuality),
      fetchLevelInsights(actId, "adset", since, until, dataQuality),
      fetchLevelInsights(actId, "ad", since, until, dataQuality),
    ]);

  return {
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency || "PKR",
      timezone_name: account.timezone_name || null,
      account_status: account.account_status ?? null,
      business_name: account.business_name || null,
    },
    actId,
    campaigns,
    adsets,
    adsCatalog,
    insights: {
      account: accountTotals,
      campaigns: campaignInsights,
      adsets: adsetInsights,
      ads: adInsights,
    },
    dataQuality,
  };
}

async function fetchPeriodBundle(actId, since, until, dataQuality) {
  const [account, campaigns, adsets, ads] = await Promise.all([
    fetchAccountTotals(actId, since, until, dataQuality),
    fetchLevelInsights(actId, "campaign", since, until, dataQuality),
    fetchLevelInsights(actId, "adset", since, until, dataQuality),
    fetchLevelInsights(actId, "ad", since, until, dataQuality),
  ]);
  return { since, until, account, campaigns, adsets, ads };
}

function emptyDataQuality() {
  return {
    unavailable_insight_fields: [],
    missing_creative_metadata: [],
    missing_destination_urls: [],
    duplicate_ad_names: [],
    zero_denominators: [],
    pagination: [],
    permission_limitations: [],
    errors: [],
    warnings: [],
    mutations: false,
    note: "Read-only audit — no Meta create/edit/pause/budget mutations.",
  };
}

module.exports = {
  fetchAccount,
  fetchAuditStructure,
  fetchPeriodBundle,
  fetchLevelInsights,
  fetchAccountTotals,
  fetchCampaigns,
  fetchAdsets,
  fetchAdsCatalog,
  emptyDataQuality,
  isFieldError,
};
