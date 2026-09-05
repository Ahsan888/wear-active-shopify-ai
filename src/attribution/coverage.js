/**
 * Attribution coverage and diagnostic aggregates.
 */
const { DEFAULT_CAPTURE_STARTED_AT } = require("./constants");
const { normalizeOrderAttribution } = require("./normalize");
const { matchMetaIds } = require("./metaMatch");
const { sheetSafe } = require("./sanitize");

function isShopifyEligibleOrder(order) {
  // Admin/manual empties often have no journey; still count as Shopify channel orders
  return Boolean(order && (order.name || order.id || order.order_number));
}

function buildAttributionDiagnostics(orders = [], options = {}) {
  const capture_started_at =
    options.capture_started_at || DEFAULT_CAPTURE_STARTED_AT;
  const metaEntities = options.metaEntities || {};

  const normalized = [];
  const warningsAgg = {};
  const statusCounts = {
    meta_first_party: 0,
    paid_non_meta: 0,
    organic: 0,
    direct: 0,
    unknown: 0,
    unattributed: 0,
  };
  const confidenceCounts = { high: 0, medium: 0, low: 0, none: 0 };
  const sourceDist = {};
  let campaignMatched = 0;
  let adsetMatched = 0;
  let adMatched = 0;
  let campaignPresent = 0;
  let adsetPresent = 0;
  let adPresent = 0;

  let eligible = 0;
  let usable = 0;
  let postCaptureEligible = 0;
  let postCaptureUsable = 0;

  for (const order of orders) {
    if (!isShopifyEligibleOrder(order)) continue;
    eligible += 1;
    const attr = normalizeOrderAttribution(order, { capture_started_at });
    const match = matchMetaIds(attr.meta_evidence, metaEntities);
    attr.match = match;
    normalized.push({ order_name: order.name, ...attr });

    if (attr.phase === "post_capture") {
      postCaptureEligible += 1;
      if (attr.usable) postCaptureUsable += 1;
    }

    if (attr.usable) usable += 1;
    statusCounts[attr.status] = (statusCounts[attr.status] || 0) + 1;
    confidenceCounts[attr.confidence] =
      (confidenceCounts[attr.confidence] || 0) + 1;

    const src = attr.source || attr.first_touch?.source || "(none)";
    sourceDist[src] = (sourceDist[src] || 0) + 1;

    for (const w of attr.warnings || []) {
      warningsAgg[w] = (warningsAgg[w] || 0) + 1;
    }

    if (match.campaign.id) {
      campaignPresent += 1;
      if (match.campaign.matched) campaignMatched += 1;
      else warningsAgg.campaign_id_unmatched =
        (warningsAgg.campaign_id_unmatched || 0) + 1;
    }
    if (match.adset.id) {
      adsetPresent += 1;
      if (match.adset.matched) adsetMatched += 1;
      else warningsAgg.adset_id_unmatched =
        (warningsAgg.adset_id_unmatched || 0) + 1;
    }
    if (match.ad.id) {
      adPresent += 1;
      if (match.ad.matched) adMatched += 1;
      else warningsAgg.ad_id_unmatched =
        (warningsAgg.ad_id_unmatched || 0) + 1;
    }
  }

  const denom = postCaptureEligible > 0 ? postCaptureEligible : eligible;
  const numer = postCaptureEligible > 0 ? postCaptureUsable : usable;
  const attribution_coverage_pct =
    denom > 0 ? Math.round((numer / denom) * 1000) / 10 : null;

  return {
    capture_started_at,
    shopify_orders: eligible,
    post_capture_orders: postCaptureEligible,
    usable_attribution: usable,
    post_capture_usable: postCaptureUsable,
    attribution_coverage_pct,
    coverage_basis:
      postCaptureEligible > 0 ? "post_capture" : "all_eligible",
    status_counts: statusCounts,
    confidence_counts: confidenceCounts,
    source_distribution: sourceDist,
    entity_ids: {
      campaign_present: campaignPresent,
      campaign_matched: campaignMatched,
      adset_present: adsetPresent,
      adset_matched: adsetMatched,
      ad_present: adPresent,
      ad_matched: adMatched,
    },
    warnings: warningsAgg,
    orders: normalized,
  };
}

function liveSheetAttributionColumns(attr) {
  return {
    "Attribution Status": sheetSafe(attr?.status || "unattributed"),
    "Attribution Confidence": sheetSafe(attr?.confidence || "none"),
    "Attribution Phase": sheetSafe(attr?.phase || ""),
    "First Touch Source": sheetSafe(attr?.first_touch?.source || ""),
    "First Touch Campaign": sheetSafe(
      attr?.first_touch?.campaign || attr?.first_touch?.campaign_id || ""
    ),
    "First Touch Content": sheetSafe(
      attr?.first_touch?.content || attr?.first_touch?.ad_id || ""
    ),
    "Last Touch Source": sheetSafe(
      attr?.last_attributable_touch?.source || attr?.last_touch?.source || ""
    ),
    "Last Touch Campaign": sheetSafe(
      attr?.last_attributable_touch?.campaign ||
        attr?.last_attributable_touch?.campaign_id ||
        ""
    ),
    "Last Touch Content": sheetSafe(
      attr?.last_attributable_touch?.content ||
        attr?.last_attributable_touch?.ad_id ||
        ""
    ),
    "Meta Click ID Present": attr?.meta_evidence?.click_id ? "Y" : "N",
    "Attribution Version": sheetSafe(
      String(attr?.attribution_version || "")
    ),
  };
}

module.exports = {
  buildAttributionDiagnostics,
  liveSheetAttributionColumns,
  isShopifyEligibleOrder,
};
