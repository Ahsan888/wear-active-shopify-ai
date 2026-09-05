/**
 * Extract attribution fields from a Shopify REST webhook order payload.
 * Used by Apps Script (ported) and Node tests.
 *
 * Webhook populates raw touch columns only.
 * Authoritative Attribution Status / Confidence / Phase come from
 * reporting normalizer via books:live-enrich — not from storefront classifiers.
 */
const { sheetSafe } = require("./sanitize");

function noteAttrsToObject(noteAttributes) {
  const out = {};
  for (const a of noteAttributes || []) {
    const k = a?.name || a?.key;
    if (k) out[String(k)] = a.value;
  }
  return out;
}

function extractWebhookAttribution(order) {
  const notes = noteAttrsToObject(order.note_attributes || order.noteAttributes);
  let payload = null;
  if (notes._wa_attr) {
    try {
      payload = JSON.parse(String(notes._wa_attr));
    } catch {
      payload = null;
    }
  }
  const first = payload?.first_touch || {};
  const last = payload?.last_touch || {};
  // Do not treat wa_attr_status as authoritative classification
  return {
    attribution_status: "",
    first_source: sheetSafe(first.source || notes.wa_ft_source || ""),
    first_campaign: sheetSafe(
      first.campaign || first.campaign_id || notes.wa_ft_campaign || ""
    ),
    first_content: sheetSafe(
      first.content || first.ad_id || notes.wa_ft_content || ""
    ),
    last_source: sheetSafe(last.source || notes.wa_lt_source || ""),
    last_campaign: sheetSafe(
      last.campaign || last.campaign_id || notes.wa_lt_campaign || ""
    ),
    last_content: sheetSafe(
      last.content || last.ad_id || notes.wa_lt_content || ""
    ),
    meta_click: Boolean(
      first.fbclid || first.fbc || last.fbclid || last.fbc || notes.wa_ft_fbclid
    )
      ? "Y"
      : "N",
    attribution_version: sheetSafe(
      String(payload?.version || notes.wa_attr_version || "")
    ),
    landing_site: order.landing_site || "",
    referring_site: order.referring_site || "",
    raw_payload: notes._wa_attr ? String(notes._wa_attr).slice(0, 1500) : "",
  };
}

const LIVE_ATTRIBUTION_HEADERS = [
  "Attribution Status",
  "First Touch Source",
  "First Touch Campaign",
  "First Touch Content",
  "Last Touch Source",
  "Last Touch Campaign",
  "Last Touch Content",
  "Meta Click ID Present",
  "Attribution Version",
];

module.exports = {
  noteAttrsToObject,
  extractWebhookAttribution,
  LIVE_ATTRIBUTION_HEADERS,
};
