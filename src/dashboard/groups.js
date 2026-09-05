/**
 * Presentation grouping for dashboard (does not alter decision JSON SKUs).
 */
function groupProductsByName(products = []) {
  const map = new Map();
  for (const p of products) {
    const name = String(p.product || p.sku || "Unknown").trim() || "Unknown";
    if (!map.has(name)) {
      map.set(name, {
        product: name,
        status: p.status,
        reason_code: p.reason_code,
        reason: p.reason,
        skus: [],
        revenue_ex_tax: 0,
        units: 0,
        gross_profit: 0,
        revenue_share_pct: 0,
      });
    }
    const g = map.get(name);
    g.skus.push(p);
    g.revenue_ex_tax += Number(p.revenue_ex_tax || 0);
    g.units += Number(p.units || 0);
    g.gross_profit += Number(p.gross_profit || 0);
    g.revenue_share_pct += Number(p.revenue_share_pct || 0);
    // Prefer worst status for the group badge
    const rank = {
      negative_margin: 0,
      data_issue: 1,
      high_volume_weak_margin: 2,
      low_volume: 3,
      strong_margin_low_volume: 4,
      healthy_contributor: 5,
      hero: 6,
    };
    if ((rank[p.status] ?? 9) < (rank[g.status] ?? 9)) {
      g.status = p.status;
      g.reason_code = p.reason_code;
      g.reason = p.reason;
    }
  }

  return [...map.values()]
    .map((g) => ({
      ...g,
      sku_count: g.skus.length,
      gross_margin_pct:
        g.revenue_ex_tax > 0
          ? Math.round((g.gross_profit / g.revenue_ex_tax) * 10000) / 100
          : null,
    }))
    .sort((a, b) => b.revenue_ex_tax - a.revenue_ex_tax);
}

function groupRecommendationsByPriority(recommendations = []) {
  const buckets = { critical: [], high: [], medium: [], low: [], info: [] };
  for (const r of recommendations) {
    const p = buckets[r.priority] ? r.priority : "info";
    buckets[p].push(r);
  }
  return buckets;
}

module.exports = {
  groupProductsByName,
  groupRecommendationsByPriority,
};
