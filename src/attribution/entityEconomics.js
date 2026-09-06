/**
 * Build first-party attributed economics by Meta campaign / ad set / ad.
 *
 * Concepts kept separate:
 * 1. Meta-reported attribution (platform metrics / spend)
 * 2. First-party observed Shopify attribution (this module)
 * 3. Unattributed Shopify recognized orders
 *
 * Observational — not causal. Does not allocate unattributed orders.
 */
const { DEFAULT_CAPTURE_STARTED_AT } = require("./constants");
const { normalizeOrderAttribution, hasStableMetaIds } = require("./normalize");
const { matchMetaIds } = require("./metaMatch");
const {
  lookupOrderEconomics,
  shopifyOrderIdFromGid,
  normalizeShopifyOrderKey,
} = require("./ledgerJoin");
const {
  emptyEntityBucket,
  finalizeEntityBucket,
  addRecognizedOrderToBucket,
  attributedEconomicsConfidence,
  pct,
  round2,
} = require("./economics");

function metaRowId(row, level) {
  if (!row) return null;
  if (level === "campaign") return String(row.entity_id || row.campaign_id || "");
  if (level === "adset") return String(row.entity_id || row.adset_id || "");
  if (level === "ad") return String(row.entity_id || row.ad_id || "");
  return null;
}

function metaRowName(row, level) {
  if (!row) return null;
  if (level === "campaign") return row.entity_name || row.campaign_name || null;
  if (level === "adset") return row.entity_name || row.adset_name || null;
  if (level === "ad") return row.entity_name || row.ad_name || null;
  return null;
}

function ensureBucket(map, id, name, matched) {
  const key = String(id);
  if (!map.has(key)) {
    const b = emptyEntityBucket(key, name);
    b.matched = Boolean(matched);
    map.set(key, b);
  } else if (name && !map.get(key).name) {
    map.get(key).name = name;
  }
  if (matched) map.get(key).matched = true;
  return map.get(key);
}

function seedMetaSpend(map, rows, level) {
  for (const row of rows || []) {
    const id = metaRowId(row, level);
    if (!id) continue;
    const b = ensureBucket(map, id, metaRowName(row, level), true);
    b.meta_spend += Number(row.spend) || 0;
  }
}

function sortEntities(list) {
  return list.sort((a, b) => {
    if (b.meta_spend !== a.meta_spend) return b.meta_spend - a.meta_spend;
    if (b.revenue_ex_tax !== a.revenue_ex_tax) return b.revenue_ex_tax - a.revenue_ex_tax;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * @param {object} input
 * @param {object[]} input.orders - Shopify GraphQL attribution orders
 * @param {Map} input.ledgerByOrderId - from indexRecognizedShopifyOrderEconomics
 * @param {object} input.metaEntities - { campaigns, adsets, ads }
 * @param {number} [input.meta_spend_total]
 * @param {object} [input.shopify_channel] - { net_revenue_ex_tax, cogs, orders, ... }
 * @param {string} [input.capture_started_at]
 * @param {{ since: string, until: string }} input.period
 */
function buildAttributedEconomics(input = {}) {
  const {
    orders = [],
    ledgerByOrderId,
    metaEntities = {},
    meta_spend_total = 0,
    shopify_channel = {},
    capture_started_at = DEFAULT_CAPTURE_STARTED_AT,
    period = {},
  } = input;

  const campaignsMap = new Map();
  const adsetsMap = new Map();
  const adsMap = new Map();

  seedMetaSpend(campaignsMap, metaEntities.campaigns, "campaign");
  seedMetaSpend(adsetsMap, metaEntities.adsets, "adset");
  seedMetaSpend(adsMap, metaEntities.ads, "ad");

  const warnings = [];
  let post_capture_recognized = 0;
  let recognized_orders = 0;
  let attributed_recognized_orders = 0;
  let unattributed_recognized_orders = 0;
  let attributed_revenue = 0;
  let attributed_cogs = 0;
  let attributed_gp = 0;
  let attributed_units = 0;
  let unattributed_revenue = 0;
  let stable_id_orders = 0;
  let unmatched_campaign_ids = 0;
  let unmatched_adset_ids = 0;
  let unmatched_ad_ids = 0;
  const seenOrderKeys = new Set();
  const attributedOrderKeys = new Set();

  for (const order of orders) {
    const econ = lookupOrderEconomics(ledgerByOrderId, order);
    if (!econ) continue; // not recognized / not in Ledger Sale

    const orderKey =
      normalizeShopifyOrderKey(shopifyOrderIdFromGid(order.id) || order.id) ||
      normalizeShopifyOrderKey(order.name) ||
      econ.order_id;
    if (!orderKey || seenOrderKeys.has(orderKey)) continue;
    seenOrderKeys.add(orderKey);

    recognized_orders += 1;
    const attr = normalizeOrderAttribution(order, { capture_started_at });
    if (attr.phase === "post_capture") post_capture_recognized += 1;

    const evidence = attr.meta_evidence || {};
    const match = matchMetaIds(evidence, metaEntities);
    const isFpMeta =
      attr.status === "meta_first_party" || hasStableMetaIds(attr.last_attributable_touch || attr.first_touch);

    if (!isFpMeta) {
      unattributed_recognized_orders += 1;
      unattributed_revenue += econ.net_revenue_ex_tax;
      continue;
    }

    attributed_recognized_orders += 1;
    attributedOrderKeys.add(orderKey);
    attributed_revenue += econ.net_revenue_ex_tax;
    attributed_cogs += econ.cogs;
    attributed_gp += econ.gross_profit;
    attributed_units += econ.units;

    if (hasStableMetaIds(attr.last_attributable_touch || attr.first_touch) || evidence.campaign_id || evidence.adset_id || evidence.ad_id) {
      stable_id_orders += 1;
    }

    if (match.campaign.id) {
      const b = ensureBucket(
        campaignsMap,
        match.campaign.id,
        match.campaign.entity
          ? metaRowName(match.campaign.entity, "campaign")
          : null,
        match.campaign.matched
      );
      addRecognizedOrderToBucket(b, econ, orderKey);
      if (!match.campaign.matched) unmatched_campaign_ids += 1;
    }
    if (match.adset.id) {
      const b = ensureBucket(
        adsetsMap,
        match.adset.id,
        match.adset.entity ? metaRowName(match.adset.entity, "adset") : null,
        match.adset.matched
      );
      addRecognizedOrderToBucket(b, econ, orderKey);
      if (!match.adset.matched) unmatched_adset_ids += 1;
    }
    if (match.ad.id) {
      const b = ensureBucket(
        adsMap,
        match.ad.id,
        match.ad.entity ? metaRowName(match.ad.entity, "ad") : null,
        match.ad.matched
      );
      addRecognizedOrderToBucket(b, econ, orderKey);
      if (!match.ad.matched) unmatched_ad_ids += 1;
    }
  }

  const shopify_recognized_revenue = round2(
    Number(shopify_channel.net_revenue_ex_tax) || 0
  );
  const shopify_recognized_orders = Number(shopify_channel.orders) || recognized_orders;

  attributed_revenue = round2(attributed_revenue);
  attributed_cogs = round2(attributed_cogs);
  attributed_gp = round2(attributed_gp);
  unattributed_revenue = round2(unattributed_revenue);

  const coverage_pct = pct(attributed_recognized_orders, recognized_orders);
  const stable_id_coverage_pct = pct(stable_id_orders, attributed_recognized_orders);
  const spend = round2(Number(meta_spend_total) || 0);
  const contribution = round2(attributed_gp - spend);

  const confidence = attributedEconomicsConfidence({
    attributed_recognized_orders,
    coverage_pct,
  });

  if (attributed_recognized_orders < 5) {
    warnings.push("small_attributed_sample");
  }
  if (coverage_pct != null && coverage_pct < 70) {
    warnings.push("attribution_coverage_below_70");
  }
  if (unmatched_campaign_ids || unmatched_adset_ids || unmatched_ad_ids) {
    warnings.push("unmatched_entity_ids");
  }

  const campaigns = sortEntities(
    [...campaignsMap.values()].map(finalizeEntityBucket)
  );
  const adsets = sortEntities(
    [...adsetsMap.values()].map(finalizeEntityBucket)
  );
  const ads = sortEntities([...adsMap.values()].map(finalizeEntityBucket));

  // Reconciliation: sum of matched campaign order economics vs attributed with campaign_id
  const campaignRevenueSum = round2(
    campaigns.filter((c) => c.orders > 0).reduce((s, c) => s + c.revenue_ex_tax, 0)
  );

  return {
    experimental: true,
    label: "FIRST-PARTY ATTRIBUTED ECONOMICS — EXPERIMENTAL",
    observational_note:
      "Meta spend is date-range entity spend. Shopify revenue is first-party observed attribution on recognized Ledger orders — not causal attribution.",
    period,
    capture_started_at,
    confidence,
    warnings,
    account: {
      shopify_recognized_orders,
      shopify_recognized_revenue,
      attributed_recognized_orders,
      attributed_revenue,
      unattributed_recognized_orders,
      unattributed_revenue,
      attributed_coverage_pct: coverage_pct,
      post_capture_recognized_orders: post_capture_recognized,
      stable_id_orders,
      stable_id_coverage_pct,
      attributed_units: round2(attributed_units),
      attributed_cogs,
      attributed_gross_profit: attributed_gp,
      attributed_gross_margin_pct:
        attributed_revenue > 0
          ? round2((attributed_gp / attributed_revenue) * 100)
          : null,
      meta_spend: spend,
      first_party_cpa:
        attributed_recognized_orders > 0
          ? round2(spend / attributed_recognized_orders)
          : null,
      first_party_roas: spend > 0 ? round2(attributed_revenue / spend) : null,
      gp_roas: spend > 0 ? round2(attributed_gp / spend) : null,
      first_party_attributed_contribution: contribution,
      contribution_margin_pct:
        attributed_revenue > 0
          ? round2((contribution / attributed_revenue) * 100)
          : null,
    },
    campaigns,
    adsets,
    ads,
    unmatched: {
      campaign_ids: unmatched_campaign_ids,
      adset_ids: unmatched_adset_ids,
      ad_ids: unmatched_ad_ids,
    },
    reconciliation: {
      attributed_revenue,
      sum_entity_campaign_revenue_with_orders: campaignRevenueSum,
      // May exceed attributed_revenue if some attributed orders lack campaign_id
      // or be lower if IDs missing — diagnostic only
      notes:
        "Entity rows use stable IDs only. Orders without campaign_id do not appear in campaign totals.",
    },
  };
}

module.exports = {
  buildAttributedEconomics,
  metaRowId,
  metaRowName,
};
