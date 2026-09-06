/**
 * Meta Insights + object field lists for the deep ads audit (read-only).
 * Prefer requesting optional video / outbound fields; callers record failures
 * in data_quality rather than inventing values.
 */

const BASE_INSIGHT_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "frequency",
  "cpm",
  "ctr",
  "clicks",
  "inline_link_clicks",
  "inline_link_click_ctr",
  "cpc",
  "cost_per_inline_link_click",
  "outbound_clicks",
  "outbound_clicks_ctr",
  "cost_per_outbound_click",
  "actions",
  "action_values",
  "cost_per_action_type",
  "video_play_actions",
  "video_p25_watched_actions",
  "video_p50_watched_actions",
  "video_p75_watched_actions",
  "video_p95_watched_actions",
  "video_p100_watched_actions",
  "video_avg_time_watched_actions",
  "video_thruplay_watched_actions",
  "video_continuous_2_sec_watched_actions",
  "video_30_sec_watched_actions",
];

function insightFieldsForAuditLevel(level) {
  const base = [...BASE_INSIGHT_FIELDS];
  if (level === "account") return base.join(",");
  if (level === "campaign") {
    return ["campaign_id", "campaign_name", ...base].join(",");
  }
  if (level === "adset") {
    return [
      "campaign_id",
      "campaign_name",
      "adset_id",
      "adset_name",
      ...base,
    ].join(",");
  }
  return [
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    ...base,
  ].join(",");
}

/** Core fields that must succeed; video/outbound are optional overlays. */
const CORE_INSIGHT_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "frequency",
  "cpm",
  "ctr",
  "clicks",
  "inline_link_clicks",
  "cpc",
  "actions",
  "action_values",
  "cost_per_action_type",
];

function coreInsightFieldsForLevel(level) {
  const base = [...CORE_INSIGHT_FIELDS];
  if (level === "account") return base.join(",");
  if (level === "campaign") {
    return ["campaign_id", "campaign_name", ...base].join(",");
  }
  if (level === "adset") {
    return [
      "campaign_id",
      "campaign_name",
      "adset_id",
      "adset_name",
      ...base,
    ].join(",");
  }
  return [
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    ...base,
  ].join(",");
}

const CAMPAIGN_FIELDS = [
  "id",
  "name",
  "status",
  "effective_status",
  "objective",
  "buying_type",
  "daily_budget",
  "lifetime_budget",
  "created_time",
  "updated_time",
].join(",");

const ADSET_FIELDS = [
  "id",
  "name",
  "campaign_id",
  "status",
  "effective_status",
  "optimization_goal",
  "billing_event",
  "bid_strategy",
  "daily_budget",
  "lifetime_budget",
  "start_time",
  "end_time",
  "attribution_spec",
  "targeting",
  "promoted_object",
  "destination_type",
  "is_dynamic_creative",
  "learning_phase_info",
  "configured_status",
].join(",");

/**
 * Ad object + creative metadata. Nested creative fields are best-effort;
 * fetch.js falls back to a lighter creative field set on API rejection.
 */
const AD_FIELDS_FULL = [
  "id",
  "name",
  "campaign_id",
  "adset_id",
  "status",
  "effective_status",
  "configured_status",
  "creative{id,name,title,body,image_url,thumbnail_url,video_id,object_type,call_to_action_type,link_url,object_url,image_hash,url_tags,effective_object_story_id,instagram_permalink_url,asset_feed_spec,object_story_spec}",
].join(",");

const AD_FIELDS_LIGHT = [
  "id",
  "name",
  "campaign_id",
  "adset_id",
  "status",
  "effective_status",
  "configured_status",
  "creative{id,name,title,body,image_url,thumbnail_url,video_id,object_type,call_to_action_type,link_url}",
].join(",");

module.exports = {
  BASE_INSIGHT_FIELDS,
  CORE_INSIGHT_FIELDS,
  insightFieldsForAuditLevel,
  coreInsightFieldsForLevel,
  CAMPAIGN_FIELDS,
  ADSET_FIELDS,
  AD_FIELDS_FULL,
  AD_FIELDS_LIGHT,
};
