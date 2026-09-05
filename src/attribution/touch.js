/**
 * Build / merge first-touch and last-attributable-touch records.
 */
const { sanitizeString, sanitizeTimestamp, parseUrlParams } = require("./sanitize");
const { DEFAULT_RETENTION_DAYS } = require("./constants");

function emptyTouch() {
  return {
    source: null,
    medium: null,
    campaign: null,
    content: null,
    term: null,
    fbclid: null,
    fbc: null,
    fbp: null,
    campaign_id: null,
    adset_id: null,
    ad_id: null,
    landing_page: null,
    referrer: null,
    timestamp: null,
  };
}

function isBlankTouch(t) {
  if (!t) return true;
  // _fbp alone is supporting Meta browser context — not acquisition evidence
  return !(
    t.source ||
    t.medium ||
    t.campaign ||
    t.content ||
    t.term ||
    t.fbclid ||
    t.fbc ||
    t.campaign_id ||
    t.adset_id ||
    t.ad_id
  );
}

function isDirectTouch(t) {
  if (!t) return true;
  if (isBlankTouch(t)) return true;
  const src = String(t.source || "").toLowerCase();
  const med = String(t.medium || "").toLowerCase();
  if (src === "direct" || src === "(direct)") return true;
  if (!src && !med && !t.fbclid && !t.fbc && !t.campaign_id) return true;
  return false;
}

function isAttributableTouch(t) {
  return t && !isBlankTouch(t) && !isDirectTouch(t);
}

function touchFromParams(params, extras = {}) {
  const p = params || {};
  const campaign_id =
    sanitizeString(p.campaign_id) ||
    (/^\d{10,}$/.test(String(p.utm_campaign || ""))
      ? String(p.utm_campaign)
      : null);
  const ad_id =
    sanitizeString(p.ad_id) ||
    (/^\d{10,}$/.test(String(p.utm_content || ""))
      ? String(p.utm_content)
      : null);
  const adset_id =
    sanitizeString(p.adset_id) ||
    (/^\d{10,}$/.test(String(p.utm_term || "")) ? String(p.utm_term) : null);

  return {
    source: sanitizeString(p.utm_source || extras.source),
    medium: sanitizeString(p.utm_medium || extras.medium),
    campaign: sanitizeString(
      /^\d{10,}$/.test(String(p.utm_campaign || ""))
        ? null
        : p.utm_campaign || extras.campaign
    ),
    content: sanitizeString(
      /^\d{10,}$/.test(String(p.utm_content || ""))
        ? null
        : p.utm_content || extras.content
    ),
    term: sanitizeString(
      /^\d{10,}$/.test(String(p.utm_term || ""))
        ? null
        : p.utm_term || extras.term
    ),
    fbclid: sanitizeString(p.fbclid || extras.fbclid, { max: 200 }),
    fbc: sanitizeString(extras.fbc, { max: 200 }),
    fbp: sanitizeString(extras.fbp, { max: 200 }),
    campaign_id,
    adset_id,
    ad_id,
    landing_page: sanitizeString(extras.landing_page, { url: true }),
    referrer: sanitizeString(extras.referrer, { url: true }),
    timestamp: sanitizeTimestamp(extras.timestamp) || new Date().toISOString(),
  };
}

function touchFromJourneyVisit(visit) {
  if (!visit) return emptyTouch();
  const utm = visit.utmParameters || {};
  const params = {
    utm_source: utm.source,
    utm_medium: utm.medium,
    utm_campaign: utm.campaign,
    utm_content: utm.content,
    utm_term: utm.term,
  };
  return touchFromParams(params, {
    source: visit.source,
    landing_page: visit.landingPage,
    referrer: visit.referrerUrl,
    timestamp: visit.occurredAt,
  });
}

function isExpiredTouch(touch, now, retentionDays) {
  if (!touch?.timestamp) return true;
  const t = new Date(touch.timestamp).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > retentionDays * 86400000;
}

/**
 * Merge visit into stored attribution state.
 * - first_touch: set once within retention; never overwritten by direct
 * - last_touch: update only on attributable visits (not internal/direct)
 * - expired window + direct → clear stale acquisition evidence
 */
function applyVisit(state, visitTouch, { now = new Date(), retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  const version = 1;
  const current = state && typeof state === "object" ? state : { version };
  let first = current.first_touch || null;
  let last = current.last_touch || null;

  const firstExpired = first ? isExpiredTouch(first, now, retentionDays) : true;
  const lastExpired = last ? isExpiredTouch(last, now, retentionDays) : true;

  if (firstExpired) first = null;
  if (lastExpired) last = null;

  let nextFirst = first;
  if (!first || isBlankTouch(first)) {
    if (isAttributableTouch(visitTouch)) nextFirst = visitTouch;
    else if (!first && isDirectTouch(visitTouch)) nextFirst = visitTouch;
    else if (!first) nextFirst = visitTouch;
  } else if (isDirectTouch(visitTouch)) {
    // keep paid first touch within retention
    nextFirst = first;
  }

  let nextLast = last;
  if (isAttributableTouch(visitTouch)) {
    nextLast = visitTouch;
  } else if (!last && isAttributableTouch(nextFirst)) {
    nextLast = nextFirst;
  } else if (!last && isDirectTouch(visitTouch) && !isAttributableTouch(nextFirst)) {
    nextLast = visitTouch;
  }
  // direct return does not erase last attributable within retention

  return {
    version,
    first_touch: nextFirst,
    last_touch: nextLast,
    updated_at: now.toISOString(),
  };
}

function touchFromLandingUrl(url, extras = {}) {
  const params = parseUrlParams(url);
  return touchFromParams(params, {
    ...extras,
    landing_page: extras.landing_page || url,
  });
}

module.exports = {
  emptyTouch,
  isBlankTouch,
  isDirectTouch,
  isAttributableTouch,
  isExpiredTouch,
  touchFromParams,
  touchFromJourneyVisit,
  touchFromLandingUrl,
  applyVisit,
};
