/**
 * Paid product decision classifications (Books only — no Meta allocation).
 */
const { round2 } = require("../books/tax");
const { PRODUCTS } = require("./thresholds");

function percentileSorted(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p))
  );
  return sorted[idx];
}

function classifyProducts(products = []) {
  const rows = (products || []).filter(
    (p) => Number(p.revenue_ex_tax || 0) > 0 || Number(p.cogs || 0) > 0
  );
  const totalRev = rows.reduce((s, p) => s + Number(p.revenue_ex_tax || 0), 0);
  const totalGp = rows.reduce((s, p) => s + Number(p.gross_profit || 0), 0);
  const totalUnits = rows.reduce((s, p) => s + Number(p.units || 0), 0);

  const margins = rows
    .map((p) => p.gross_margin_pct)
    .filter((m) => m != null && Number.isFinite(Number(m)))
    .map(Number)
    .sort((a, b) => a - b);
  const median_gm = percentileSorted(margins, 0.5);
  const p75_gm = percentileSorted(margins, 0.75);

  const withShares = rows.map((p) => {
    const rev = Number(p.revenue_ex_tax || 0);
    const gp = Number(p.gross_profit || 0);
    const units = Number(p.units || 0);
    return {
      ...p,
      revenue_share_pct: totalRev > 0 ? round2((rev / totalRev) * 100) : 0,
      gross_profit_share_pct: totalGp > 0 ? round2((gp / totalGp) * 100) : 0,
      unit_share_pct: totalUnits > 0 ? round2((units / totalUnits) * 100) : 0,
    };
  });

  const byGp = [...withShares].sort(
    (a, b) => Number(b.gross_profit || 0) - Number(a.gross_profit || 0)
  );
  const topGpKeys = new Set(
    byGp.slice(0, PRODUCTS.HERO_TOP_N_BY_GP).map((p) => productKey(p))
  );

  const classified = withShares.map((p) => {
    const flags = p.flags || [];
    const dataIssue =
      flags.includes("sku_missing_from_variant_master") ||
      flags.includes("missing_cost_per_item") ||
      (!p.sku && Number(p.revenue_ex_tax || 0) > 0);

    const base = {
      sku: p.sku || null,
      product: p.product || null,
      category: p.category || "",
      units: p.units,
      revenue_ex_tax: p.revenue_ex_tax,
      cogs: p.cogs,
      gross_profit: p.gross_profit,
      gross_margin_pct: p.gross_margin_pct,
      vm_cost_per_item: p.vm_cost_per_item ?? null,
      flags,
      revenue_share_pct: p.revenue_share_pct,
      gross_profit_share_pct: p.gross_profit_share_pct,
      unit_share_pct: p.unit_share_pct,
      no_meta_allocation: true,
    };

    if (dataIssue) {
      return {
        ...base,
        status: "data_issue",
        reason_code: "missing_sku_or_cost",
        reason: "Missing SKU and/or Variant Master cost data",
      };
    }
    if (Number(p.gross_profit || 0) < 0) {
      return {
        ...base,
        status: "negative_margin",
        reason_code: "negative_gross_profit",
        reason: "Paid product gross profit is negative",
      };
    }

    const gm = p.gross_margin_pct == null ? null : Number(p.gross_margin_pct);

    // Volume + weak margin before hero (top GP with thin margin is a risk)
    if (
      (p.revenue_share_pct >= PRODUCTS.HIGH_VOLUME_SHARE_GTE ||
        p.unit_share_pct >= PRODUCTS.HIGH_VOLUME_SHARE_GTE) &&
      gm != null &&
      gm < PRODUCTS.WEAK_MARGIN_LT
    ) {
      return {
        ...base,
        status: "high_volume_weak_margin",
        reason_code: "volume_with_weak_margin",
        reason: `Material share with gross margin ${gm}% < ${PRODUCTS.WEAK_MARGIN_LT}%`,
      };
    }

    const isTopGp = topGpKeys.has(productKey(p));
    if (
      isTopGp &&
      gm != null &&
      median_gm != null &&
      gm >= median_gm &&
      Number(p.units || 0) >= PRODUCTS.HERO_MIN_UNITS
    ) {
      return {
        ...base,
        status: "hero",
        reason_code: "top_gross_profit_contributor",
        reason: `Top-${PRODUCTS.HERO_TOP_N_BY_GP} by gross profit with margin ≥ portfolio median`,
      };
    }

    if (
      gm != null &&
      p75_gm != null &&
      gm >= p75_gm &&
      p.revenue_share_pct < PRODUCTS.STRONG_MARGIN_LOW_VOL_REV_SHARE_LT &&
      Number(p.units || 0) >= 1
    ) {
      return {
        ...base,
        status: "strong_margin_low_volume",
        reason_code: "high_margin_low_share",
        reason: `Gross margin ≥ p75 with revenue share < ${PRODUCTS.STRONG_MARGIN_LOW_VOL_REV_SHARE_LT}%`,
      };
    }

    if (
      p.revenue_share_pct < PRODUCTS.LOW_VOLUME_REV_SHARE_LT &&
      Number(p.units || 0) <= PRODUCTS.LOW_VOLUME_UNITS_LTE
    ) {
      return {
        ...base,
        status: "low_volume",
        reason_code: "low_volume_contributor",
        reason: "Low revenue share and low units",
      };
    }

    return {
      ...base,
      status: "healthy_contributor",
      reason_code: "healthy_contributor",
      reason: "Paid product economics within normal portfolio band",
    };
  });

  return {
    portfolio: {
      product_count: classified.length,
      median_gross_margin_pct: median_gm,
      p75_gross_margin_pct: p75_gm,
      total_revenue_ex_tax: round2(totalRev),
      total_gross_profit: round2(totalGp),
    },
    products: classified.sort(
      (a, b) => Number(b.gross_profit || 0) - Number(a.gross_profit || 0)
    ),
  };
}

function productKey(p) {
  return `${p.sku || ""}||${p.product || ""}||${p.revenue_ex_tax || 0}||${p.units || 0}`;
}

module.exports = {
  classifyProducts,
  percentileSorted,
};
