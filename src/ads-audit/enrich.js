/**
 * Extended Insights enrichment for the deep ads audit.
 * Builds on meta/metrics.enrichInsightRow — never substitutes one metric for another.
 */
const {
  enrichInsightRow,
  pickAction,
  toNumber,
  safeDiv,
  pctRatio,
  LPV_TYPES,
} = require("../meta/metrics");

const metrics = require("../meta/metrics");

const VIDEO_PLAY_TYPES = ["video_view", "video_play", "omni_video_view"];
const VIDEO_3S_TYPES = [
  "video_view",
  "video_continuous_2_sec_watched_actions",
];

function firstActionListValue(list) {
  if (!Array.isArray(list) || !list.length) return null;
  // Meta video_* fields are action arrays: [{action_type, value}, ...]
  // Prefer first numeric value; preserve action_type provenance.
  for (const item of list) {
    const n = toNumber(item?.value);
    if (n != null) {
      return { action_type: item.action_type || null, value: n };
    }
  }
  return null;
}

function videoField(row, key) {
  const hit = firstActionListValue(row?.[key]);
  return {
    value: hit ? hit.value : null,
    action_type: hit?.action_type || null,
    source_field: key,
  };
}

function outboundClicks(row) {
  // Meta returns outbound_clicks as an action array, not a scalar.
  if (Array.isArray(row?.outbound_clicks)) {
    const hit = firstActionListValue(row.outbound_clicks);
    return hit
      ? { value: hit.value, action_type: hit.action_type, source: "outbound_clicks" }
      : { value: null, action_type: null, source: "outbound_clicks" };
  }
  const n = toNumber(row?.outbound_clicks);
  if (n != null) {
    return { value: n, action_type: null, source: "outbound_clicks_scalar" };
  }
  return { value: null, action_type: null, source: null };
}

function outboundCtr(row, impressions, outbound) {
  const fromApi = toNumber(row?.outbound_clicks_ctr);
  if (fromApi != null) {
    return { value: fromApi, source: "outbound_clicks_ctr" };
  }
  const derived = pctRatio(outbound, impressions);
  if (derived == null) return { value: null, source: null };
  return { value: derived, source: "derived_outbound_over_impressions" };
}

function costPerOutbound(row, spend, outbound) {
  if (Array.isArray(row?.cost_per_outbound_click)) {
    const hit = firstActionListValue(row.cost_per_outbound_click);
    if (hit) {
      return {
        value: hit.value,
        action_type: hit.action_type,
        source: "cost_per_outbound_click",
      };
    }
  }
  const scalar = toNumber(row?.cost_per_outbound_click);
  if (scalar != null) {
    return {
      value: scalar,
      action_type: null,
      source: "cost_per_outbound_click_scalar",
    };
  }
  const derived = safeDiv(spend, outbound);
  if (derived == null) return { value: null, action_type: null, source: null };
  return { value: derived, action_type: null, source: "derived_spend_over_outbound" };
}

function linkCtr(row, impressions, linkClicks) {
  const fromApi = toNumber(row?.inline_link_click_ctr);
  if (fromApi != null) {
    return { value: fromApi, source: "inline_link_click_ctr" };
  }
  const derived = pctRatio(linkClicks, impressions);
  if (derived == null) return { value: null, source: null };
  return { value: derived, source: "derived_link_clicks_over_impressions" };
}

function costPerLinkClick(row, spend, linkClicks) {
  const fromApi = toNumber(row?.cost_per_inline_link_click);
  if (fromApi != null) {
    return { value: fromApi, source: "cost_per_inline_link_click" };
  }
  const derived = safeDiv(spend, linkClicks);
  if (derived == null) return { value: null, source: null };
  return { value: derived, source: "derived_spend_over_link_clicks" };
}

function costPerLpv(row, spend, lpv) {
  const pick = pickAction(row?.cost_per_action_type, LPV_TYPES);
  if (pick) {
    return {
      value: pick.value,
      action_type: pick.action_type,
      source: "cost_per_action_type",
    };
  }
  const derived = safeDiv(spend, lpv);
  if (derived == null) return { value: null, action_type: null, source: null };
  return { value: derived, action_type: null, source: "derived_spend_over_lpv" };
}

/**
 * Enrich one Insights row with audit-specific traffic / video fields.
 * Unavailable metrics stay null — never substituted.
 */
function enrichAuditInsightRow(row = {}, options = {}) {
  const base = enrichInsightRow(row);
  const unavailable = [...(options.unavailable_fields || [])];

  const outbound = outboundClicks(row);
  const linkCtrHit = linkCtr(
    row,
    base.impressions,
    base.inline_link_clicks
  );
  const outboundCtrHit = outboundCtr(
    row,
    base.impressions,
    outbound.value
  );
  const costLink = costPerLinkClick(
    row,
    base.spend,
    base.inline_link_clicks
  );
  const costOut = costPerOutbound(row, base.spend, outbound.value);
  const costLpv = costPerLpv(row, base.spend, base.landing_page_views);

  const video_plays = videoField(row, "video_play_actions");
  const video_thruplays = videoField(row, "video_thruplay_watched_actions");
  const video_3s = videoField(row, "video_continuous_2_sec_watched_actions");
  const video_p25 = videoField(row, "video_p25_watched_actions");
  const video_p50 = videoField(row, "video_p50_watched_actions");
  const video_p75 = videoField(row, "video_p75_watched_actions");
  const video_p95 = videoField(row, "video_p95_watched_actions");
  const video_p100 = videoField(row, "video_p100_watched_actions");
  const video_avg = videoField(row, "video_avg_time_watched_actions");
  const video_30s = videoField(row, "video_30_sec_watched_actions");

  // Fallback: 3s-ish from actions video_view when dedicated field unavailable
  let video_3sec_plays = video_3s.value;
  let video_3sec_source = video_3s.source_field;
  let video_3sec_action_type = video_3s.action_type;
  if (video_3sec_plays == null && Array.isArray(row.actions)) {
    const fromActions = pickAction(row.actions, VIDEO_PLAY_TYPES);
    if (fromActions) {
      video_3sec_plays = fromActions.value;
      video_3sec_action_type = fromActions.action_type;
      video_3sec_source = "actions";
    }
  }

  for (const key of [
    "outbound_clicks",
    "outbound_clicks_ctr",
    "cost_per_outbound_click",
    "inline_link_click_ctr",
    "cost_per_inline_link_click",
    "video_play_actions",
    "video_thruplay_watched_actions",
    "video_continuous_2_sec_watched_actions",
    "video_p25_watched_actions",
    "video_p50_watched_actions",
    "video_p75_watched_actions",
    "video_p95_watched_actions",
    "video_p100_watched_actions",
    "video_avg_time_watched_actions",
    "video_30_sec_watched_actions",
  ]) {
    if (unavailable.includes(key)) continue;
    // Mark as unavailable only when field was requested but returned nothing
    // and we have no alternate provenance — callers may pass unavailable_fields.
  }

  return {
    ...base,
    outbound_clicks: outbound.value,
    outbound_clicks_action_type: outbound.action_type,
    outbound_clicks_source: outbound.source,
    outbound_ctr: outboundCtrHit.value,
    outbound_ctr_source: outboundCtrHit.source,
    link_ctr: linkCtrHit.value,
    link_ctr_source: linkCtrHit.source,
    cost_per_link_click: costLink.value,
    cost_per_link_click_source: costLink.source,
    cost_per_outbound_click: costOut.value,
    cost_per_outbound_click_source: costOut.source,
    cost_per_landing_page_view: costLpv.value,
    cost_per_landing_page_view_action_type: costLpv.action_type,
    cost_per_landing_page_view_source: costLpv.source,
    video: {
      plays: video_plays.value,
      plays_action_type: video_plays.action_type,
      plays_source: video_plays.value != null ? video_plays.source_field : null,
      thruplays: video_thruplays.value,
      thruplays_action_type: video_thruplays.action_type,
      thruplays_source:
        video_thruplays.value != null ? video_thruplays.source_field : null,
      three_sec_plays: video_3sec_plays,
      three_sec_plays_action_type: video_3sec_action_type,
      three_sec_plays_source: video_3sec_plays != null ? video_3sec_source : null,
      p25: video_p25.value,
      p25_source: video_p25.value != null ? video_p25.source_field : null,
      p50: video_p50.value,
      p50_source: video_p50.value != null ? video_p50.source_field : null,
      p75: video_p75.value,
      p75_source: video_p75.value != null ? video_p75.source_field : null,
      p95: video_p95.value,
      p95_source: video_p95.value != null ? video_p95.source_field : null,
      p100: video_p100.value,
      p100_source: video_p100.value != null ? video_p100.source_field : null,
      avg_watch_time_sec: video_avg.value,
      avg_watch_time_source:
        video_avg.value != null ? video_avg.source_field : null,
      thirty_sec_plays: video_30s.value,
      thirty_sec_plays_source:
        video_30s.value != null ? video_30s.source_field : null,
    },
    impression_to_link_click_pct: pctRatio(
      base.inline_link_clicks,
      base.impressions
    ),
    link_click_to_lpv_pct: pctRatio(
      base.landing_page_views,
      base.inline_link_clicks
    ),
    lpv_to_atc_pct: base.lpv_to_atc_pct,
    atc_to_checkout_pct: base.atc_to_checkout_pct,
    checkout_to_purchase_pct: base.checkout_to_purchase_pct,
    lpv_to_purchase_pct: base.lpv_to_purchase_pct,
  };
}

function extractVideoMetrics(row) {
  return enrichAuditInsightRow(row).video;
}

module.exports = {
  enrichAuditInsightRow,
  extractVideoMetrics,
  firstActionListValue,
  videoField,
  outboundClicks,
  VIDEO_PLAY_TYPES,
  VIDEO_3S_TYPES,
  // re-export for tests
  pickAction: metrics.pickAction,
  actionValue: metrics.actionValue,
  toNumber: metrics.toNumber,
  safeDiv: metrics.safeDiv,
  pctRatio: metrics.pctRatio,
};
