/**
 * Attribution constants and allowlists (Phase 5A).
 */
const ATTRIBUTION_VERSION = 1;
const STORAGE_KEY = "wa_attribution_v1";
const CART_ATTR_PAYLOAD = "_wa_attr";
const DEFAULT_RETENTION_DAYS = 30;

/**
 * Capture go-live — set to the *actual* storefront tracking activation time
 * (ISO timestamp preferred, e.g. 2026-09-08T14:37:00+05:00).
 * Date-only values are accepted and treated as start-of-day in the local parse.
 * Do NOT set this until the Dawn theme capture script is published.
 */
const DEFAULT_CAPTURE_STARTED_AT =
  process.env.ATTRIBUTION_CAPTURE_STARTED_AT || "2026-09-06";

/** Parse capture start; accepts YYYY-MM-DD or full ISO timestamps. */
function parseCaptureStartedAt(value) {
  const raw = value || DEFAULT_CAPTURE_STARTED_AT;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ATTRIBUTION_CAPTURE_STARTED_AT: ${raw}`);
  }
  return d;
}

const ALLOWED_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "fbclid",
  "campaign_id",
  "adset_id",
  "ad_id",
]);

const MAX_STRING = 240;
const MAX_URL = 500;
const MAX_PAYLOAD = 1800;

const META_SOURCES = new Set([
  "facebook",
  "fb",
  "instagram",
  "ig",
  "meta",
  "an",
]);

module.exports = {
  ATTRIBUTION_VERSION,
  STORAGE_KEY,
  CART_ATTR_PAYLOAD,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_CAPTURE_STARTED_AT,
  parseCaptureStartedAt,
  ALLOWED_QUERY_PARAMS,
  MAX_STRING,
  MAX_URL,
  MAX_PAYLOAD,
  META_SOURCES,
};
