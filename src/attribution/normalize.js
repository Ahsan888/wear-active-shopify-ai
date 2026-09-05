/**
 * Normalize order attribution evidence into a conservative status + confidence.
 */
const {
  ATTRIBUTION_VERSION,
  DEFAULT_CAPTURE_STARTED_AT,
  META_SOURCES,
  parseCaptureStartedAt,
} = require("./constants");
const { sanitizeString, sanitizeTimestamp } = require("./sanitize");
const {
  emptyTouch,
  isBlankTouch,
  isDirectTouch,
  isAttributableTouch,
  touchFromParams,
  touchFromJourneyVisit,
  applyVisit,
} = require("./touch");

function isMetaSource(source) {
  const s = String(source || "").toLowerCase();
  if (!s) return false;
  if (META_SOURCES.has(s)) return true;
  if (s.includes("facebook") || s.includes("instagram") || s.includes("meta"))
    return true;
  return false;
}

function hasMetaClickEvidence(touch) {
  return Boolean(touch?.fbclid || touch?.fbc);
}

function hasStableMetaIds(touch) {
  return Boolean(touch?.campaign_id || touch?.adset_id || touch?.ad_id);
}

function hasMetaUtm(touch) {
  return isMetaSource(touch?.source);
}

function confidenceFor(touch, status) {
  if (!touch || isBlankTouch(touch) || status === "unattributed" || status === "unknown") {
    return "none";
  }
  // _fbp alone never elevates confidence — supporting metadata only
  if (status === "meta_first_party") {
    if (hasMetaClickEvidence(touch) && hasStableMetaIds(touch)) return "high";
    if (hasMetaClickEvidence(touch) || hasStableMetaIds(touch)) return "high";
    if (hasMetaUtm(touch)) return "medium";
    return "low";
  }
  if (status === "paid_non_meta" || status === "organic") return "medium";
  if (status === "direct") return "low";
  return "low";
}

function classifyStatus(touch) {
  if (!touch || isBlankTouch(touch)) return "unattributed";
  if (isDirectTouch(touch)) return "direct";

  const medium = String(touch.medium || "").toLowerCase();
  const source = String(touch.source || "").toLowerCase();

  if (
    hasMetaClickEvidence(touch) ||
    hasStableMetaIds(touch) ||
    (isMetaSource(source) && (medium === "paid" || medium === "paid_social" || medium.includes("cpc") || medium.includes("ppc")))
  ) {
    return "meta_first_party";
  }

  if (isMetaSource(source) && (medium === "social" || medium === "organic" || !medium)) {
    // organic social / link-in-bio style
    if (medium === "paid" || medium === "paid_social") return "meta_first_party";
    return "organic";
  }

  if (
    medium === "paid" ||
    medium === "cpc" ||
    medium === "ppc" ||
    medium === "paid_social" ||
    medium === "display"
  ) {
    return "paid_non_meta";
  }

  if (
    medium === "organic" ||
    medium === "social" ||
    medium === "referral" ||
    medium === "email"
  ) {
    return "organic";
  }

  if (isAttributableTouch(touch)) return "unknown";
  return "unattributed";
}

function parseCartAttributePayload(attrs) {
  if (!attrs) return null;
  const list = Array.isArray(attrs)
    ? attrs
    : Object.entries(attrs).map(([key, value]) => ({ key, value }));
  const payload = list.find(
    (a) => a.key === "_wa_attr" || a.key === "wa_attr" || a.name === "_wa_attr"
  );
  if (!payload?.value) return null;
  try {
    const parsed = JSON.parse(String(payload.value));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return { _malformed: true };
  }
}

function flattenAttrsToTouch(attrs, prefix) {
  const map = {};
  const list = Array.isArray(attrs)
    ? attrs
    : Object.entries(attrs || {}).map(([key, value]) => ({ key, value }));
  for (const a of list) {
    const k = String(a.key || a.name || "");
    if (k.startsWith(prefix)) map[k.slice(prefix.length)] = a.value;
  }
  if (!Object.keys(map).length) return null;
  return {
    source: sanitizeString(map.source),
    medium: sanitizeString(map.medium),
    campaign: sanitizeString(map.campaign),
    content: sanitizeString(map.content),
    term: sanitizeString(map.term),
    fbclid: sanitizeString(map.fbclid, { max: 200 }),
    fbc: sanitizeString(map.fbc, { max: 200 }),
    fbp: sanitizeString(map.fbp, { max: 200 }),
    campaign_id: sanitizeString(map.campaign_id),
    adset_id: sanitizeString(map.adset_id),
    ad_id: sanitizeString(map.ad_id),
    landing_page: sanitizeString(map.landing, { url: true }),
    referrer: sanitizeString(map.referrer, { url: true }),
    timestamp: sanitizeTimestamp(map.at),
  };
}

/**
 * Normalize attribution for one Shopify order.
 */
function normalizeOrderAttribution(order = {}, options = {}) {
  const warnings = [];
  const captureStarted =
    options.capture_started_at || DEFAULT_CAPTURE_STARTED_AT;
  const createdAt = order.createdAt || order.created_at || order.processed_at;
  const created = createdAt ? new Date(createdAt) : null;
  let captureStart;
  try {
    captureStart = parseCaptureStartedAt(captureStarted);
  } catch {
    captureStart = parseCaptureStartedAt(DEFAULT_CAPTURE_STARTED_AT);
  }
  // createdAt < capture_started_at → pre_capture; >= → post_capture
  const phase =
    created && !Number.isNaN(created.getTime()) && created < captureStart
      ? "pre_capture"
      : "post_capture";

  const attrs =
    order.customAttributes ||
    order.custom_attributes ||
    order.note_attributes ||
    [];

  const payload = parseCartAttributePayload(attrs);
  if (payload?._malformed) {
    warnings.push("malformed_attribution_payload");
  }

  let first = null;
  let last = null;
  let attribution_version = null;

  if (payload && !payload._malformed) {
    if (payload.version != null && Number(payload.version) !== ATTRIBUTION_VERSION) {
      warnings.push("unsupported_version");
    }
    attribution_version = Number(payload.version) || ATTRIBUTION_VERSION;
    first = payload.first_touch || null;
    last = payload.last_touch || null;
    if (first?.timestamp && !sanitizeTimestamp(first.timestamp)) {
      warnings.push("timestamp_invalid");
      first = { ...first, timestamp: null };
    }
  }

  if (!first) first = flattenAttrsToTouch(attrs, "wa_ft_");
  if (!last) last = flattenAttrsToTouch(attrs, "wa_lt_");

  // Shopify customer journey (historical + current)
  const journey = order.customerJourneySummary || order.customer_journey_summary;
  const journeyReady = journey == null ? null : journey.ready !== false;
  if (journey && journey.ready === false) {
    warnings.push("journey_not_ready");
  }
  if (journey?.firstVisit) {
    const jt = touchFromJourneyVisit(journey.firstVisit);
    if (!first || isBlankTouch(first)) first = jt;
    else if (isAttributableTouch(jt) && isDirectTouch(first)) first = jt;
  }
  if (journey?.lastVisit) {
    const jt = touchFromJourneyVisit(journey.lastVisit);
    // Prefer last attributable: if journey last is direct but first is paid, keep paid last
    if (isAttributableTouch(jt)) last = jt;
    else if (!last || isBlankTouch(last)) {
      if (isAttributableTouch(first)) last = first;
      else last = jt;
    } else if (isDirectTouch(jt) && isAttributableTouch(last)) {
      // keep attributable last
    } else if (isDirectTouch(jt) && isAttributableTouch(first)) {
      last = first;
    }
  }

  // REST landing_site query params
  const landing = order.landingSite || order.landing_site;
  if (landing && (!first || isBlankTouch(first))) {
    const params = require("./sanitize").parseUrlParams(landing);
    const t = touchFromParams(params, {
      landing_page: landing,
      referrer: order.referringSite || order.referring_site,
      timestamp: createdAt,
    });
    if (!isBlankTouch(t)) {
      first = t;
      if (!last || isBlankTouch(last)) last = t;
    }
  }

  first = first || emptyTouch();
  last = last || emptyTouch();

  // Direct return semantics: if last is direct but first is attributable, last_attributable = first
  let last_attributable = last;
  if (isDirectTouch(last) && isAttributableTouch(first)) {
    last_attributable = first;
  }

  const primary = isAttributableTouch(last_attributable)
    ? last_attributable
    : first;
  let status = classifyStatus(primary);

  const hasCartEvidence = Boolean(payload && !payload._malformed);
  const hasJourneyVisit = Boolean(journey?.firstVisit || journey?.lastVisit);
  if (
    phase === "post_capture" &&
    status === "unattributed" &&
    !hasCartEvidence &&
    !hasJourneyVisit
  ) {
    // Do not treat journey_not_ready alone as definitive missing attribution
    if (journey && journey.ready === false) {
      // journey_not_ready already warned — skip premature missing warning
    } else {
      warnings.push("post_capture_order_missing_attribution");
    }
  }

  if (hasMetaUtm(primary) && !hasMetaClickEvidence(primary) && !hasStableMetaIds(primary)) {
    warnings.push("meta_utm_without_click_id");
  }
  if (hasMetaClickEvidence(primary) && !primary.source) {
    warnings.push("click_id_without_utm");
  }
  if (primary.campaign && !primary.source) {
    warnings.push("utm_without_source");
  }

  const confidence = confidenceFor(primary, status);
  const meta_evidence = {
    click_id: hasMetaClickEvidence(primary),
    stable_ids: hasStableMetaIds(primary),
    utm_meta: isMetaSource(primary.source),
    fbp_only: Boolean(primary.fbp) && isBlankTouch({ ...primary, fbp: null }),
    campaign_id: primary.campaign_id || null,
    adset_id: primary.adset_id || null,
    ad_id: primary.ad_id || null,
  };

  return {
    attribution_version: attribution_version || ATTRIBUTION_VERSION,
    status,
    confidence,
    phase,
    first_touch: first,
    last_touch: last,
    last_attributable_touch: last_attributable,
    meta_evidence,
    warnings,
    journey_ready: journeyReady,
    source: primary.source || null,
    usable: status !== "unattributed" && status !== "unknown" && confidence !== "none"
      ? true
      : status !== "unattributed" && !isBlankTouch(primary),
  };
}

module.exports = {
  normalizeOrderAttribution,
  classifyStatus,
  confidenceFor,
  parseCartAttributePayload,
  hasMetaClickEvidence,
  hasStableMetaIds,
  isMetaSource,
  applyVisit,
};
