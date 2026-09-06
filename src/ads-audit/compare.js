/**
 * Time comparison for ads audit.
 * Trailing 7/14/30 OVERLAP → contextual only.
 * Independent recent_7d / previous_7d / prior_16d → improving/stable/declining.
 */
const { toNumber, safeDiv } = require("../meta/metrics");
const {
  buildIndependentWindowRanges,
  TRAILING_NOTE,
} = require("../marketing/periods");
const { trailingWindow } = require("../operations/dates");

function metricSnapshot(row = {}) {
  return {
    spend: toNumber(row.spend) ?? 0,
    impressions: toNumber(row.impressions) ?? 0,
    purchases: toNumber(row.purchases) ?? 0,
    purchase_value: toNumber(row.purchase_value) ?? 0,
    ctr: toNumber(row.ctr),
    link_ctr: toNumber(row.link_ctr),
    cpc: toNumber(row.cpc),
    cpa: toNumber(row.cpa),
    roas: toNumber(row.roas),
    cpm: toNumber(row.cpm),
    landing_page_views: toNumber(row.landing_page_views) ?? 0,
  };
}

/**
 * Compare two independent snapshots for direction on a primary metric.
 * Requires minimum spend/impressions in BOTH periods.
 */
function compareIndependentSnapshots(recent, previous, opts = {}) {
  const minSpend = opts.min_spend ?? 500;
  const minImpressions = opts.min_impressions ?? 1000;
  const metric = opts.metric || "cpa"; // cpa down = improving; ctr/roas up = improving

  const a = metricSnapshot(recent || {});
  const b = metricSnapshot(previous || {});

  const enough =
    a.spend >= minSpend &&
    b.spend >= minSpend &&
    a.impressions >= minImpressions &&
    b.impressions >= minImpressions;

  if (!enough) {
    return {
      sufficient: false,
      direction: "insufficient",
      metric,
      recent: a,
      previous: b,
      note: "Independent periods lack sufficient spend/impressions for direction.",
    };
  }

  let recentVal;
  let prevVal;
  let higherIsBetter;

  if (metric === "ctr") {
    recentVal = a.link_ctr ?? a.ctr;
    prevVal = b.link_ctr ?? b.ctr;
    higherIsBetter = true;
  } else if (metric === "roas") {
    recentVal = a.roas;
    prevVal = b.roas;
    higherIsBetter = true;
  } else if (metric === "spend") {
    recentVal = a.spend;
    prevVal = b.spend;
    higherIsBetter = null; // neutral
  } else {
    // default CPA — only meaningful with purchases in at least one window
    recentVal = a.cpa;
    prevVal = b.cpa;
    higherIsBetter = false;
    if (!(a.purchases > 0 && b.purchases > 0)) {
      // fall back to CTR direction when CPA unavailable
      return compareIndependentSnapshots(recent, previous, {
        ...opts,
        metric: "ctr",
      });
    }
  }

  if (recentVal == null || prevVal == null || prevVal === 0) {
    return {
      sufficient: false,
      direction: "insufficient",
      metric,
      recent: a,
      previous: b,
      note: "Metric missing in one independent period.",
    };
  }

  const changePct = ((recentVal - prevVal) / Math.abs(prevVal)) * 100;
  const threshold = opts.change_pct_threshold ?? 15;

  let direction = "stable";
  if (higherIsBetter == null) {
    direction = Math.abs(changePct) < threshold ? "stable" : "changed";
  } else if (Math.abs(changePct) < threshold) {
    direction = "stable";
  } else if (higherIsBetter) {
    direction = changePct > 0 ? "improving" : "declining";
  } else {
    direction = changePct < 0 ? "improving" : "declining";
  }

  return {
    sufficient: true,
    direction,
    metric,
    change_pct: Math.round(changePct * 10) / 10,
    recent: a,
    previous: b,
    note: "Independent non-overlapping windows only.",
  };
}

function indexAdsById(rows = []) {
  const map = new Map();
  for (const r of rows) {
    if (r?.ad_id) map.set(String(r.ad_id), r);
  }
  return map;
}

/**
 * Attach independent + trailing period context to each primary ad.
 */
function attachAdPeriodCompare(primaryAds, periodBundles = {}) {
  const indep = periodBundles.independent || {};
  const trailing = periodBundles.trailing || {};

  const recentIdx = indexAdsById(indep.recent_7d?.ads);
  const prevIdx = indexAdsById(indep.previous_7d?.ads);
  const priorIdx = indexAdsById(indep.prior_16d?.ads);

  return (primaryAds || []).map((ad) => {
    const id = String(ad.ad_id);
    const recent = recentIdx.get(id);
    const previous = prevIdx.get(id);
    const prior = priorIdx.get(id);

    const independent_compare = compareIndependentSnapshots(recent, previous, {
      metric: "cpa",
    });

    const trailing_context = {
      note: TRAILING_NOTE,
      windows: {},
    };
    for (const days of ["7", "14", "30"]) {
      const bundle = trailing[days];
      if (!bundle) continue;
      const row = indexAdsById(bundle.ads).get(id);
      trailing_context.windows[days] = row
        ? metricSnapshot(row)
        : null;
    }

    return {
      ...ad,
      period_compare: {
        independent: {
          recent_7d: recent ? metricSnapshot(recent) : null,
          previous_7d: previous ? metricSnapshot(previous) : null,
          prior_16d: prior ? metricSnapshot(prior) : null,
          compare_recent_vs_previous: independent_compare,
        },
        trailing: trailing_context,
        direction: independent_compare.sufficient
          ? independent_compare.direction
          : "insufficient",
      },
      independent_compare,
    };
  });
}

function buildPeriodRanges(until) {
  return {
    trailing: {
      "7": trailingWindow(until, 7),
      "14": trailingWindow(until, 14),
      "30": trailingWindow(until, 30),
    },
    independent: buildIndependentWindowRanges(until),
  };
}

module.exports = {
  metricSnapshot,
  compareIndependentSnapshots,
  indexAdsById,
  attachAdPeriodCompare,
  buildPeriodRanges,
  TRAILING_NOTE,
};
