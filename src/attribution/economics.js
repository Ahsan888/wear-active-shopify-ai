/**
 * Pure helpers for first-party attributed economics (Phase 5B).
 * Observational attribution — not causal; does not replace Meta-reported metrics.
 */
const { round2 } = require("../books/tax");

function emptyEntityBucket(id, name = null) {
  return {
    id: id || null,
    name: name || null,
    matched: false,
    orders: 0,
    units: 0,
    revenue_ex_tax: 0,
    cogs: 0,
    gross_profit: 0,
    gross_margin_pct: null,
    meta_spend: 0,
    first_party_cpa: null,
    first_party_roas: null,
    gp_roas: null,
    contribution_after_meta: null,
    contribution_margin_pct: null,
    _order_ids: new Set(),
  };
}

function finalizeEntityBucket(bucket) {
  const orders = bucket._order_ids ? bucket._order_ids.size : bucket.orders;
  const revenue = round2(bucket.revenue_ex_tax);
  const cogs = round2(bucket.cogs);
  const gp = round2(bucket.gross_profit);
  const spend = round2(bucket.meta_spend);
  const out = {
    id: bucket.id,
    name: bucket.name,
    matched: Boolean(bucket.matched),
    orders,
    units: round2(bucket.units),
    revenue_ex_tax: revenue,
    cogs,
    gross_profit: gp,
    gross_margin_pct:
      revenue > 0 ? round2((gp / revenue) * 100) : null,
    meta_spend: spend,
    first_party_cpa: orders > 0 ? round2(spend / orders) : null,
    first_party_roas: spend > 0 ? round2(revenue / spend) : null,
    gp_roas: spend > 0 ? round2(gp / spend) : null,
    contribution_after_meta: round2(gp - spend),
    contribution_margin_pct:
      revenue > 0 ? round2(((gp - spend) / revenue) * 100) : null,
  };
  return out;
}

function addRecognizedOrderToBucket(bucket, orderEcon, orderKey) {
  if (!bucket || !orderEcon) return;
  const key = String(orderKey || orderEcon.order_id || "");
  if (key && bucket._order_ids.has(key)) return; // no double-count
  if (key) bucket._order_ids.add(key);
  bucket.orders = bucket._order_ids.size;
  bucket.units += Number(orderEcon.units) || 0;
  bucket.revenue_ex_tax += Number(orderEcon.net_revenue_ex_tax) || 0;
  bucket.cogs += Number(orderEcon.cogs) || 0;
  bucket.gross_profit += Number(orderEcon.gross_profit) || 0;
}

/**
 * Confidence for attributed economics sample.
 * coverage_pct < 70 caps at low (unless already insufficient).
 */
function attributedEconomicsConfidence({
  attributed_recognized_orders = 0,
  coverage_pct = null,
} = {}) {
  const n = Number(attributed_recognized_orders) || 0;
  let level;
  if (n < 5) level = "insufficient";
  else if (n < 10) level = "low";
  else if (n < 30) level = "medium";
  else level = "high";

  if (
    coverage_pct != null &&
    Number(coverage_pct) < 70 &&
    level !== "insufficient"
  ) {
    level = "low";
  }
  return level;
}

function pct(numerator, denominator) {
  const d = Number(denominator);
  if (!d) return null;
  return round2((Number(numerator) / d) * 100);
}

module.exports = {
  emptyEntityBucket,
  finalizeEntityBucket,
  addRecognizedOrderToBucket,
  attributedEconomicsConfidence,
  pct,
  round2,
};
