/**
 * Creative evidence records — structured only, no AI interpretation.
 */

function firstDefined(...vals) {
  for (const v of vals) {
    if (v != null && v !== "") return v;
  }
  return null;
}

function detectFormat(creative = {}) {
  if (creative.video_id) return "video";
  if (creative.asset_feed_spec) return "dynamic_creative_or_asset_feed";
  if (creative.image_hash || creative.image_url || creative.thumbnail_url) {
    return "image";
  }
  if (creative.object_type) return String(creative.object_type).toLowerCase();
  return null;
}

function extractDestination(creative = {}) {
  return firstDefined(
    creative.link_url,
    creative.object_url,
    creative.object_story_spec?.link_data?.link,
    creative.object_story_spec?.video_data?.call_to_action?.value?.link,
    creative.asset_feed_spec?.link_urls?.[0]?.website_url
  );
}

function extractCta(creative = {}) {
  return firstDefined(
    creative.call_to_action_type,
    creative.object_story_spec?.link_data?.call_to_action?.type,
    creative.object_story_spec?.video_data?.call_to_action?.type,
    Array.isArray(creative.asset_feed_spec?.call_to_action_types)
      ? creative.asset_feed_spec.call_to_action_types[0]
      : null
  );
}

function extractPrimaryText(creative = {}) {
  return firstDefined(
    creative.body,
    creative.object_story_spec?.link_data?.message,
    creative.object_story_spec?.video_data?.message,
    Array.isArray(creative.asset_feed_spec?.bodies)
      ? creative.asset_feed_spec.bodies[0]?.text
      : null
  );
}

function extractHeadline(creative = {}) {
  return firstDefined(
    creative.title,
    creative.object_story_spec?.link_data?.name,
    creative.object_story_spec?.link_data?.title,
    Array.isArray(creative.asset_feed_spec?.titles)
      ? creative.asset_feed_spec.titles[0]?.text
      : null
  );
}

function extractDescription(creative = {}) {
  return firstDefined(
    creative.object_story_spec?.link_data?.description,
    Array.isArray(creative.asset_feed_spec?.descriptions)
      ? creative.asset_feed_spec.descriptions[0]?.text
      : null
  );
}

/**
 * Normalize creative object from Meta ad.creative payload.
 */
function normalizeCreative(raw = {}) {
  const creative_id = raw.id || raw.creative_id || null;
  const missing = [];
  const format = detectFormat(raw);
  const primary_text = extractPrimaryText(raw);
  const headline = extractHeadline(raw);
  const description = extractDescription(raw);
  const cta = extractCta(raw);
  const destination = extractDestination(raw);
  const thumbnail_url = firstDefined(raw.thumbnail_url, raw.image_url);
  const image_url = raw.image_url || null;
  const video_id = raw.video_id || null;
  const image_hash = raw.image_hash || null;

  if (!creative_id) missing.push("creative_id");
  if (!format) missing.push("format");
  if (!primary_text) missing.push("primary_text");
  if (!headline) missing.push("headline");
  if (!cta) missing.push("cta");
  if (!destination) missing.push("destination_url");
  if (!thumbnail_url) missing.push("thumbnail_url");

  return {
    creative_id: creative_id ? String(creative_id) : null,
    name: raw.name || null,
    format,
    object_type: raw.object_type || null,
    primary_text,
    headline,
    description,
    cta,
    destination_url: destination,
    image_url,
    thumbnail_url,
    video_id: video_id ? String(video_id) : null,
    image_hash,
    instagram_permalink_url: raw.instagram_permalink_url || null,
    effective_object_story_id: raw.effective_object_story_id || null,
    has_asset_feed: Boolean(raw.asset_feed_spec),
    is_dynamic_creative_indicator: Boolean(raw.asset_feed_spec),
    url_tags: raw.url_tags || null,
    missing_fields: missing,
  };
}

/**
 * Per-ad creative evidence row (structured, no AI).
 */
function buildCreativeEvidence(ad, diagnosis = null) {
  const creative = ad.creative || normalizeCreative({
    id: ad.creative_id,
    name: ad.creative_name,
    title: ad.creative_title,
    body: ad.creative_body,
    image_url: ad.creative_image_url,
    thumbnail_url: ad.creative_thumbnail_url,
    video_id: ad.creative_video_id,
    call_to_action_type: ad.creative_cta,
    link_url: ad.creative_destination,
    object_type: ad.creative_format,
  });

  return {
    ad_id: ad.ad_id ? String(ad.ad_id) : null,
    ad_name: ad.ad_name || null,
    campaign_id: ad.campaign_id || null,
    adset_id: ad.adset_id || null,
    creative_id: creative.creative_id,
    format: creative.format,
    hook_text: creative.primary_text,
    headline: creative.headline,
    description: creative.description,
    cta: creative.cta,
    destination: creative.destination_url,
    thumbnail_url: creative.thumbnail_url,
    spend: ad.spend ?? 0,
    impressions: ad.impressions ?? 0,
    ctr: ad.ctr ?? null,
    link_ctr: ad.link_ctr ?? null,
    cpc: ad.cpc ?? null,
    landing_page_views: ad.landing_page_views ?? 0,
    add_to_carts: ad.add_to_carts ?? 0,
    checkouts: ad.initiated_checkouts ?? 0,
    purchases: ad.purchases ?? 0,
    cpa: ad.cpa ?? null,
    roas: ad.roas ?? null,
    video: ad.video || null,
    diagnosis: diagnosis?.primary_diagnosis || ad.primary_diagnosis || null,
    confidence: diagnosis?.confidence || ad.diagnosis_confidence || null,
    missing_creative_fields: creative.missing_fields || [],
  };
}

/**
 * Group evidence by creative_id (exact ads remain listed).
 */
function groupByCreative(evidenceRows = []) {
  const map = new Map();
  for (const row of evidenceRows) {
    const key = row.creative_id ? String(row.creative_id) : `no_creative:${row.ad_id}`;
    if (!map.has(key)) {
      map.set(key, {
        creative_id: row.creative_id,
        format: row.format,
        primary_text: row.hook_text,
        headline: row.headline,
        cta: row.cta,
        destination: row.destination,
        thumbnail_url: row.thumbnail_url,
        ads: [],
        spend: 0,
        purchases: 0,
        purchase_value: 0,
        impressions: 0,
        landing_page_views: 0,
        video_plays: 0,
        thruplays: 0,
        diagnoses: [],
      });
    }
    const g = map.get(key);
    g.ads.push({
      ad_id: row.ad_id,
      ad_name: row.ad_name,
      spend: row.spend,
      purchases: row.purchases,
      cpa: row.cpa,
      roas: row.roas,
      diagnosis: row.diagnosis,
      confidence: row.confidence,
    });
    g.spend += Number(row.spend) || 0;
    g.purchases += Number(row.purchases) || 0;
    g.impressions += Number(row.impressions) || 0;
    g.landing_page_views += Number(row.landing_page_views) || 0;
    if (row.video?.plays) g.video_plays += Number(row.video.plays) || 0;
    if (row.video?.thruplays) g.thruplays += Number(row.video.thruplays) || 0;
    if (row.diagnosis) g.diagnoses.push(row.diagnosis);
    // Prefer non-null creative metadata from any ad
    if (!g.format && row.format) g.format = row.format;
    if (!g.primary_text && row.hook_text) g.primary_text = row.hook_text;
    if (!g.headline && row.headline) g.headline = row.headline;
    if (!g.cta && row.cta) g.cta = row.cta;
    if (!g.destination && row.destination) g.destination = row.destination;
    if (!g.thumbnail_url && row.thumbnail_url) g.thumbnail_url = row.thumbnail_url;
  }

  const groups = [...map.values()].map((g) => {
    const cpa = g.purchases > 0 ? g.spend / g.purchases : null;
    // ROAS needs purchase_value — sum from ads if present on evidence
    return {
      ...g,
      ad_count: g.ads.length,
      cpa,
      roas: null, // filled by caller when purchase_value available
      diagnoses_unique: [...new Set(g.diagnoses)],
    };
  });

  return groups.sort((a, b) => b.spend - a.spend);
}

module.exports = {
  normalizeCreative,
  buildCreativeEvidence,
  groupByCreative,
  detectFormat,
  extractDestination,
  extractCta,
  extractPrimaryText,
  extractHeadline,
};
