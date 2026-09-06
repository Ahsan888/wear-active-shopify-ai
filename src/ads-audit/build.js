/**
 * Assemble the deep Meta ads audit payload (read-only).
 */
const { getAdAccountId } = require("../meta/client");
const { buildAccountFunnelBaselines } = require("../decisions/entities");
const { fetchAuditStructure, fetchPeriodBundle, emptyDataQuality } = require("./fetch");
const { diagnoseAd } = require("./diagnose");
const { buildCreativeEvidence, groupByCreative } = require("./creative");
const { buildFunnel } = require("./funnel");
const {
  attachAdPeriodCompare,
  buildPeriodRanges,
  metricSnapshot,
  TRAILING_NOTE,
} = require("./compare");

function moneyish(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  return Math.round(Number(n) * 100) / 100;
}

function findDuplicateNames(ads) {
  const byName = new Map();
  for (const ad of ads) {
    const name = String(ad.ad_name || "");
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(String(ad.ad_id));
  }
  const dupes = [];
  for (const [name, ids] of byName) {
    if (ids.length > 1) dupes.push({ name, ad_ids: ids, count: ids.length });
  }
  return dupes;
}

function joinAds(structure, primaryInsights) {
  const byId = new Map(primaryInsights.map((r) => [String(r.ad_id), r]));
  const campaignById = new Map(
    structure.campaigns.map((c) => [String(c.campaign_id), c])
  );
  const adsetById = new Map(
    structure.adsets.map((a) => [String(a.adset_id), a])
  );

  const joined = [];
  const seen = new Set();

  for (const meta of structure.adsCatalog) {
    const id = String(meta.ad_id);
    seen.add(id);
    const insight = byId.get(id);
    const campaign = campaignById.get(String(meta.campaign_id));
    const adset = adsetById.get(String(meta.adset_id));
    const base = insight || {
      ad_id: id,
      ad_name: meta.ad_name,
      campaign_id: meta.campaign_id,
      adset_id: meta.adset_id,
      spend: 0,
      impressions: 0,
      clicks: 0,
      purchases: 0,
      purchase_value: 0,
      add_to_carts: 0,
      initiated_checkouts: 0,
      landing_page_views: 0,
      ctr: null,
      cpc: null,
      cpa: null,
      roas: null,
      video: {},
    };
    joined.push({
      ...base,
      ad_id: id,
      ad_name: meta.ad_name || base.ad_name,
      campaign_id: meta.campaign_id || base.campaign_id,
      campaign_name: campaign?.name || base.campaign_name || null,
      adset_id: meta.adset_id || base.adset_id,
      adset_name: adset?.name || base.adset_name || null,
      status: meta.status,
      effective_status: meta.effective_status,
      creative_id: meta.creative_id,
      creative: meta.creative,
    });
  }

  // Insights-only ads (shouldn't happen often)
  for (const insight of primaryInsights) {
    const id = String(insight.ad_id);
    if (seen.has(id)) continue;
    joined.push({
      ...insight,
      status: null,
      effective_status: null,
      creative: null,
      creative_id: null,
    });
  }

  return joined.sort((a, b) => (b.spend || 0) - (a.spend || 0));
}

function classifyBuckets(diagnosedAds) {
  const working = [];
  const attention = [];
  const insufficient = [];

  for (const ad of diagnosedAds) {
    const d = ad.diagnosis?.primary_diagnosis;
    if (d === "INSUFFICIENT_DATA") insufficient.push(ad);
    else if (
      d === "HEALTHY" ||
      d === "STRONG_CREATIVE"
    ) {
      working.push(ad);
    } else {
      attention.push(ad);
    }
  }
  return { working, attention, insufficient };
}

function activeFilter(rows, statusKey = "effective_status") {
  const active = new Set(["ACTIVE", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "PENDING_REVIEW", "IN_PROCESS"]);
  // "currently running" → prefer ACTIVE only for counts; keep paused for structure
  return {
    active: (rows || []).filter((r) => r[statusKey] === "ACTIVE"),
    delivering_or_active: (rows || []).filter(
      (r) => r[statusKey] === "ACTIVE" || r[statusKey] === "WITH_ISSUES"
    ),
    all: rows || [],
  };
}

/**
 * Build full audit. Fetches live Meta data when structure not injected.
 */
async function buildAdsAudit({ since, until, days = 30 } = {}) {
  const structure = await fetchAuditStructure(since, until);
  const actId = structure.actId || getAdAccountId();
  const dataQuality = structure.dataQuality || emptyDataQuality();

  const ranges = buildPeriodRanges(until);
  const trailing = {};
  const independent = {};

  // Trailing overlapping windows (contextual)
  for (const daysKey of ["7", "14", "30"]) {
    const range = ranges.trailing[daysKey];
    if (range.since === since && range.until === until && Number(days) === Number(daysKey)) {
      trailing[daysKey] = {
        since: range.since,
        until: range.until,
        account: structure.insights.account,
        campaigns: structure.insights.campaigns,
        adsets: structure.insights.adsets,
        ads: structure.insights.ads,
      };
    } else {
      trailing[daysKey] = await fetchPeriodBundle(
        actId,
        range.since,
        range.until,
        dataQuality
      );
    }
  }

  // Independent non-overlapping
  for (const key of ["recent_7d", "previous_7d", "prior_16d"]) {
    const range = ranges.independent[key];
    // Reuse trailing 7d if identical
    if (
      trailing["7"] &&
      trailing["7"].since === range.since &&
      trailing["7"].until === range.until
    ) {
      independent[key] = { ...trailing["7"], key };
    } else {
      independent[key] = {
        ...(await fetchPeriodBundle(
          actId,
          range.since,
          range.until,
          dataQuality
        )),
        key,
      };
    }
  }

  // Primary window = requested since/until (usually 30d)
  const primaryAdsInsights = structure.insights.ads;
  const accountPrimary = structure.insights.account;
  let joined = joinAds(structure, primaryAdsInsights);

  joined = attachAdPeriodCompare(joined, { trailing, independent });

  const baselines = buildAccountFunnelBaselines(accountPrimary);
  const diagnosed = joined.map((ad) => {
    const diagnosis = diagnoseAd(ad, accountPrimary, {
      account_funnel_baselines: baselines,
    });
    const funnel = buildFunnel(ad);
    return {
      ...ad,
      diagnosis,
      funnel,
      primary_diagnosis: diagnosis.primary_diagnosis,
      diagnosis_confidence: diagnosis.confidence,
    };
  });

  dataQuality.duplicate_ad_names = findDuplicateNames(diagnosed);
  for (const ad of diagnosed) {
    if (!ad.creative?.destination_url) {
      dataQuality.missing_destination_urls.push({ ad_id: ad.ad_id });
    }
    const rates = ad.funnel?.rates || {};
    for (const [k, v] of Object.entries(rates)) {
      if (v == null) {
        dataQuality.zero_denominators.push({ ad_id: ad.ad_id, rate: k });
      }
    }
  }
  // Cap noisy zero_denominator list
  if (dataQuality.zero_denominators.length > 200) {
    dataQuality.zero_denominators = dataQuality.zero_denominators.slice(0, 200);
    dataQuality.warnings.push({
      code: "zero_denominator_list_truncated",
      message: "zero_denominators list truncated to 200 entries",
    });
  }

  const creativeEvidence = diagnosed.map((ad) =>
    buildCreativeEvidence(ad, ad.diagnosis)
  );
  // Attach purchase_value into creative groups
  const creativeGroups = groupByCreative(creativeEvidence).map((g) => {
    let purchase_value = 0;
    for (const adRef of g.ads) {
      const full = diagnosed.find((a) => String(a.ad_id) === String(adRef.ad_id));
      purchase_value += Number(full?.purchase_value) || 0;
    }
    return {
      ...g,
      purchase_value,
      roas: g.spend > 0 ? purchase_value / g.spend : null,
    };
  });

  const buckets = classifyBuckets(diagnosed);
  const campaignsActive = activeFilter(structure.campaigns);
  const adsetsActive = activeFilter(structure.adsets);
  const adsActive = activeFilter(diagnosed);

  const adTable = diagnosed.map((ad) => ({
    ad_id: ad.ad_id,
    ad_name: ad.ad_name,
    campaign_id: ad.campaign_id,
    campaign_name: ad.campaign_name,
    adset_id: ad.adset_id,
    adset_name: ad.adset_name,
    status: ad.effective_status || ad.status,
    spend: moneyish(ad.spend),
    impressions: ad.impressions,
    ctr: ad.ctr,
    cpc: ad.cpc,
    lpv: ad.landing_page_views,
    atc: ad.add_to_carts,
    checkout: ad.initiated_checkouts,
    purchases: ad.purchases,
    cpa: ad.cpa,
    roas: ad.roas,
    diagnosis: ad.primary_diagnosis,
    confidence: ad.diagnosis_confidence,
  }));

  const audienceView = structure.adsets.map((adset) => {
    const perf =
      structure.insights.adsets.find(
        (r) => String(r.adset_id) === String(adset.adset_id)
      ) || null;
    return {
      adset_id: adset.adset_id,
      name: adset.name,
      campaign_id: adset.campaign_id,
      status: adset.effective_status || adset.status,
      optimization_goal: adset.optimization_goal,
      bid_strategy: adset.bid_strategy,
      daily_budget: adset.daily_budget,
      targeting_summary: adset.targeting_summary,
      beginner_summary: adset.targeting_summary?.beginner_summary || null,
      performance: perf
        ? metricSnapshot(perf)
        : metricSnapshot({}),
      causality_note:
        "Audience performance is observational — do not conclude causality from ad set results alone.",
    };
  });

  const summary = {
    spend: accountPrimary.spend,
    purchases: accountPrimary.purchases,
    purchase_value: accountPrimary.purchase_value,
    roas: accountPrimary.roas,
    cpa: accountPrimary.cpa,
    ctr: accountPrimary.ctr,
    cpc: accountPrimary.cpc,
    landing_page_views: accountPrimary.landing_page_views,
    impressions: accountPrimary.impressions,
    clicks: accountPrimary.clicks,
    attribution_note:
      "Meta-reported purchase attribution — distinct from Books/business economics. Do not compare Meta CPA to Books break-even CPA for affordability.",
  };

  const formats = [
    ...new Set(
      creativeEvidence.map((c) => c.format).filter(Boolean)
    ),
  ];

  const placements = [
    ...new Set(
      audienceView
        .map((a) => a.targeting_summary?.placements?.text)
        .filter(Boolean)
    ),
  ];

  return {
    generated_at: new Date().toISOString(),
    source: "meta_marketing_api",
    read_only: true,
    no_mutations: true,
    account: structure.account,
    date_range: { since, until, days },
    summary,
    periods: {
      trailing_note: TRAILING_NOTE,
      trailing: {
        "7": {
          since: trailing["7"].since,
          until: trailing["7"].until,
          totals: metricSnapshot(trailing["7"].account),
        },
        "14": {
          since: trailing["14"].since,
          until: trailing["14"].until,
          totals: metricSnapshot(trailing["14"].account),
        },
        "30": {
          since: trailing["30"].since,
          until: trailing["30"].until,
          totals: metricSnapshot(trailing["30"].account),
        },
      },
      independent: {
        recent_7d: {
          since: independent.recent_7d.since,
          until: independent.recent_7d.until,
          totals: metricSnapshot(independent.recent_7d.account),
        },
        previous_7d: {
          since: independent.previous_7d.since,
          until: independent.previous_7d.until,
          totals: metricSnapshot(independent.previous_7d.account),
        },
        prior_16d: {
          since: independent.prior_16d.since,
          until: independent.prior_16d.until,
          totals: metricSnapshot(independent.prior_16d.account),
        },
      },
    },
    structure: {
      campaigns: structure.campaigns,
      adsets: structure.adsets.map((a) => ({
        ...a,
        // Drop bulky raw targeting from default JSON if huge — keep summary
        targeting: a.targeting,
      })),
      ads: structure.adsCatalog,
      counts: {
        campaigns: structure.campaigns.length,
        adsets: structure.adsets.length,
        ads: structure.adsCatalog.length,
        active_campaigns: campaignsActive.active.length,
        active_adsets: adsetsActive.active.length,
        active_ads: adsActive.active.length,
      },
    },
    highlights: {
      what_is_working: buckets.working.slice(0, 15).map(briefAd),
      what_needs_attention: buckets.attention.slice(0, 15).map(briefAd),
      what_does_not_have_enough_data: buckets.insufficient
        .slice(0, 15)
        .map(briefAd),
      top_ads_by_purchases: [...diagnosed]
        .sort((a, b) => (b.purchases || 0) - (a.purchases || 0))
        .filter((a) => (a.purchases || 0) > 0)
        .slice(0, 10)
        .map(briefAd),
      top_ads_by_roas: [...diagnosed]
        .filter((a) => (a.purchases || 0) > 0 && a.roas != null)
        .sort((a, b) => (b.roas || 0) - (a.roas || 0))
        .slice(0, 10)
        .map(briefAd),
      lowest_cpa_ads: [...diagnosed]
        .filter((a) => (a.purchases || 0) > 0 && a.cpa != null)
        .sort((a, b) => (a.cpa || 0) - (b.cpa || 0))
        .slice(0, 10)
        .map(briefAd),
      highest_spend_zero_purchase: [...diagnosed]
        .filter((a) => !(a.purchases > 0) && (a.spend || 0) > 0)
        .sort((a, b) => (b.spend || 0) - (a.spend || 0))
        .slice(0, 10)
        .map(briefAd),
      best_ctr_ads: [...diagnosed]
        .filter((a) => (a.impressions || 0) >= 1000 && a.ctr != null)
        .sort((a, b) => (b.ctr || 0) - (a.ctr || 0))
        .slice(0, 10)
        .map(briefAd),
      weakest_ctr_ads: [...diagnosed]
        .filter((a) => (a.impressions || 0) >= 1000 && a.ctr != null)
        .sort((a, b) => (a.ctr || 0) - (b.ctr || 0))
        .slice(0, 10)
        .map(briefAd),
    },
    ads: diagnosed,
    ad_table: adTable,
    funnels: diagnosed
      .filter((a) => (a.spend || 0) > 0 || (a.impressions || 0) > 0)
      .slice(0, 40)
      .map((ad) => ({
        ad_id: ad.ad_id,
        ad_name: ad.ad_name,
        spend: ad.spend,
        diagnosis: ad.primary_diagnosis,
        funnel: ad.funnel,
        plain_english: ad.diagnosis?.plain_english || null,
      })),
    creative_evidence: creativeEvidence,
    creative_groups: creativeGroups,
    audiences: audienceView,
    creative_formats_running: formats,
    placements_observed: placements,
    data_quality: dataQuality,
  };
}

function briefAd(ad) {
  return {
    ad_id: ad.ad_id,
    ad_name: ad.ad_name,
    spend: moneyish(ad.spend),
    purchases: ad.purchases,
    cpa: ad.cpa,
    roas: ad.roas,
    ctr: ad.ctr,
    diagnosis: ad.primary_diagnosis || ad.diagnosis?.primary_diagnosis,
    confidence: ad.diagnosis_confidence || ad.diagnosis?.confidence,
  };
}

module.exports = {
  buildAdsAudit,
  joinAds,
  findDuplicateNames,
  classifyBuckets,
  briefAd,
};
