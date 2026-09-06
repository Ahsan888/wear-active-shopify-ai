/**
 * Build inventory intelligence report from Shopify stock + Ledger demand + VM costs.
 * Advisory only — no writes.
 */
const { round2 } = require("../books/tax");
const { resolveThresholds } = require("./thresholds");
const { demandForSku } = require("./demand");
const {
  avgDailyUnits,
  daysOfCover,
  classifyStock,
  classifyDemandTrend,
  recommendAction,
  recommendedRestockQty,
  priorityScore,
  confidenceForSku,
} = require("./classify");

function productKey(productTitle, handle) {
  return String(productTitle || handle || "Unknown").trim() || "Unknown";
}

/**
 * @param {object} opts
 * @param {object[]} opts.shopifyVariants - from fetchShopifyInventory
 * @param {object} opts.demandWindows - from buildDemandWindows
 * @param {object} opts.catalogBySku - Variant Master bySku
 * @param {object} [opts.thresholds]
 * @param {{ since?: string, until: string }} opts.period
 */
function buildInventoryReport(opts = {}) {
  const thresholds = resolveThresholds(opts.thresholds || {});
  const catalogBySku = opts.catalogBySku || {};
  const demandWindows = opts.demandWindows;
  const variants = opts.shopifyVariants || [];
  const until = opts.period?.until || demandWindows?.until;

  const skuRows = [];
  const seenSku = new Set();
  const warnings = [];
  const missingCostSkus = [];
  const missingVmSkus = [];
  const missingSkuVariants = [];
  const negativeStock = [];
  const salesWithoutInventory = [];

  // Index Shopify by SKU (first wins; duplicates flagged)
  const bySku = new Map();
  for (const v of variants) {
    const sku = v.sku ? String(v.sku).trim() : "";
    if (!sku) {
      missingSkuVariants.push({
        product: v.product,
        variant: v.variant,
        current_stock: v.current_stock,
      });
      continue;
    }
    if (bySku.has(sku)) {
      warnings.push(`duplicate_shopify_sku:${sku}`);
      // Prefer summing stock for same SKU across variants (rare) — report both
      const prev = bySku.get(sku);
      const a = Number(prev.current_stock);
      const b = Number(v.current_stock);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        prev.current_stock = a + b;
        prev._duplicate_merged = true;
      }
      continue;
    }
    bySku.set(sku, { ...v, sku });
  }

  // Union of Shopify SKUs + demand SKUs (sales without inventory match)
  const allSkus = new Set([
    ...bySku.keys(),
    ...(demandWindows?.demand_30d?.keys?.() || []),
  ]);

  for (const sku of allSkus) {
    seenSku.add(sku);
    const inv = bySku.get(sku) || null;
    const vm = catalogBySku[sku] || null;
    const dem = demandForSku(demandWindows, sku);
    const dq = [];

    if (!inv) {
      dq.push("sales_without_inventory_match");
      salesWithoutInventory.push(sku);
    }
    if (!vm) {
      dq.push("missing_variant_master");
      missingVmSkus.push(sku);
    }
    const unitCost =
      vm && vm.costPerItem != null && Number.isFinite(Number(vm.costPerItem))
        ? Number(vm.costPerItem)
        : null;
    if (unitCost == null) {
      dq.push("missing_cost");
      missingCostSkus.push(sku);
    }
    if (inv && inv.current_stock == null) {
      dq.push("missing_shopify_inventory");
    }
    const stock = inv?.current_stock == null ? null : Number(inv.current_stock);
    if (stock != null && stock < 0) {
      dq.push("negative_stock");
      negativeStock.push(sku);
    }
    if (inv && stock != null && stock > 0 && dem.units_sold_30d === 0) {
      dq.push("inventory_without_sales_history");
    }

    const avgDaily = avgDailyUnits(dem.units_sold_30d, 30);
    const doc = daysOfCover(stock, dem.units_sold_30d);
    const stockClass = classifyStock(
      stock == null ? null : stock,
      doc,
      dem.units_sold_30d,
      thresholds
    );
    const trend = classifyDemandTrend(
      dem.units_sold_7d,
      dem.units_sold_30d,
      thresholds
    );
    const action = recommendAction({
      stock_class: stockClass,
      days_of_cover: doc,
      units_sold_30d: dem.units_sold_30d,
      demand_trend: trend,
      gross_margin_pct: dem.gross_margin_pct,
      thresholds,
    });
    const restockQty = recommendedRestockQty({
      current_stock: stock,
      units_sold_30d: dem.units_sold_30d,
      action,
      thresholds,
    });

    const inventoryValue =
      stock != null && unitCost != null && stock > 0
        ? round2(stock * unitCost)
        : stock != null && unitCost != null && stock === 0
          ? 0
          : null;

    const row = {
      sku,
      product: inv?.product || vm?.product || dem.product || null,
      variant: inv?.variant || null,
      size: inv?.size || "",
      color: inv?.color || "",
      current_stock: stock,
      unit_cost: unitCost,
      inventory_value: inventoryValue,
      units_sold_7d: dem.units_sold_7d,
      units_sold_14d: dem.units_sold_14d,
      units_sold_30d: dem.units_sold_30d,
      revenue_30d: dem.revenue_30d,
      gross_profit_30d: dem.gross_profit_30d,
      gross_margin_pct: dem.gross_margin_pct,
      avg_daily_units_30d: round2(avgDaily),
      days_of_cover: doc,
      stock_class: stockClass,
      stockout_risk: ["OUT_OF_STOCK", "CRITICAL", "LOW"].includes(stockClass),
      sell_through_class: stockClass,
      demand_trend: trend,
      recommended_action: action,
      recommended_restock_qty: restockQty,
      target_days_of_cover: thresholds.target_days_of_cover,
      data_quality_warnings: dq,
      confidence: null,
      priority_score: 0,
      in_shopify: Boolean(inv),
      in_variant_master: Boolean(vm),
    };
    row.confidence = confidenceForSku(row);
    row.priority_score = priorityScore(row, thresholds);
    skuRows.push(row);
  }

  for (const miss of missingSkuVariants) {
    warnings.push(
      `missing_sku:${miss.product || "?"} / ${miss.variant || "?"} stock=${miss.current_stock}`
    );
  }

  // Product aggregation — surface worst variant risk
  const productMap = new Map();
  for (const row of skuRows) {
    const key = productKey(row.product, row.sku);
    if (!productMap.has(key)) {
      productMap.set(key, {
        product: row.product || key,
        skus: [],
        current_stock: 0,
        inventory_value: 0,
        inventory_value_known: true,
        units_sold_30d: 0,
        revenue_30d: 0,
        gross_profit_30d: 0,
        critical_variant_count: 0,
        low_variant_count: 0,
        out_of_stock_variant_count: 0,
        worst_stock_class: "HEALTHY",
        has_variant_stockout_risk: false,
      });
    }
    const p = productMap.get(key);
    p.skus.push(row.sku);
    if (row.current_stock != null) p.current_stock += row.current_stock;
    if (row.inventory_value != null) {
      p.inventory_value = round2(p.inventory_value + row.inventory_value);
    } else if (row.current_stock > 0) {
      p.inventory_value_known = false;
    }
    p.units_sold_30d += row.units_sold_30d;
    p.revenue_30d = round2(p.revenue_30d + row.revenue_30d);
    p.gross_profit_30d = round2(p.gross_profit_30d + row.gross_profit_30d);
    if (row.stock_class === "OUT_OF_STOCK") p.out_of_stock_variant_count += 1;
    if (row.stock_class === "CRITICAL") p.critical_variant_count += 1;
    if (row.stock_class === "LOW") p.low_variant_count += 1;
    if (row.stockout_risk) p.has_variant_stockout_risk = true;
  }

  const classRank = {
    OUT_OF_STOCK: 0,
    CRITICAL: 1,
    LOW: 2,
    NO_DEMAND: 3,
    OVERSTOCK: 4,
    HIGH: 5,
    HEALTHY: 6,
    UNKNOWN: 7,
  };
  for (const p of productMap.values()) {
    let worst = "HEALTHY";
    let worstRank = 99;
    for (const sku of p.skus) {
      const row = skuRows.find((r) => r.sku === sku);
      if (!row) continue;
      const r = classRank[row.stock_class] ?? 50;
      if (r < worstRank) {
        worstRank = r;
        worst = row.stock_class;
      }
    }
    p.worst_stock_class = worst;
    p.sku_count = p.skus.length;
    p.inventory_value = p.inventory_value_known ? round2(p.inventory_value) : null;
    p.avg_daily_units_30d = round2(avgDailyUnits(p.units_sold_30d, 30));
    p.days_of_cover =
      p.units_sold_30d > 0 && p.current_stock != null
        ? daysOfCover(p.current_stock, p.units_sold_30d)
        : null;
  }

  const products = [...productMap.values()].sort(
    (a, b) =>
      Number(b.has_variant_stockout_risk) - Number(a.has_variant_stockout_risk) ||
      b.units_sold_30d - a.units_sold_30d
  );

  // Summaries — inventory value excludes missing-cost SKUs
  const valued = skuRows.filter((r) => r.inventory_value != null);
  const totalUnits = skuRows.reduce(
    (s, r) => s + (Number.isFinite(r.current_stock) ? r.current_stock : 0),
    0
  );
  const totalInventoryValue = round2(
    valued.reduce((s, r) => s + (r.inventory_value || 0), 0)
  );
  const atRiskClasses = new Set(["OVERSTOCK", "NO_DEMAND"]);
  const slowDeadValue = round2(
    valued
      .filter((r) => atRiskClasses.has(r.stock_class))
      .reduce((s, r) => s + (r.inventory_value || 0), 0)
  );
  const capitalAtRiskPct =
    totalInventoryValue > 0
      ? round2((slowDeadValue / totalInventoryValue) * 100)
      : null;

  const byClass = {};
  for (const r of skuRows) {
    byClass[r.stock_class] = (byClass[r.stock_class] || 0) + 1;
  }

  const restockPriorities = skuRows
    .filter((r) =>
      ["RESTOCK_NOW", "RESTOCK_SOON"].includes(r.recommended_action)
    )
    .sort((a, b) => b.priority_score - a.priority_score);

  const deadSlow = skuRows
    .filter(
      (r) =>
        r.stock_class === "NO_DEMAND" ||
        r.stock_class === "OVERSTOCK" ||
        r.recommended_action === "CLEARANCE_CANDIDATE"
    )
    .sort((a, b) => (b.inventory_value || 0) - (a.inventory_value || 0));

  const topSellers = [...skuRows]
    .filter((r) => r.units_sold_30d > 0)
    .sort((a, b) => b.units_sold_30d - a.units_sold_30d)
    .slice(0, 25);

  const criticalSkus = skuRows.filter((r) => r.stock_class === "CRITICAL");
  const lowSkus = skuRows.filter((r) => r.stock_class === "LOW");
  const overstockSkus = skuRows.filter((r) => r.stock_class === "OVERSTOCK");
  const noDemandSkus = skuRows.filter((r) => r.stock_class === "NO_DEMAND");
  const oosSkus = skuRows.filter((r) => r.stock_class === "OUT_OF_STOCK");

  return {
    generated_at: new Date().toISOString(),
    advisory_only: true,
    period: {
      until,
      demand_windows: demandWindows?.windows || null,
      since: opts.period?.since || demandWindows?.windows?.d30?.since || null,
    },
    thresholds,
    sources: {
      inventory: "Shopify productVariants.inventoryQuantity (ACTIVE products)",
      demand:
        "Books Ledger recognized Sale units (gift/PR excluded; refunds per Books rules)",
      unit_cost: "Variant Master CostPerItem",
    },
    summary: {
      sku_count: skuRows.length,
      product_count: products.length,
      total_units: round2(totalUnits),
      total_inventory_value: totalInventoryValue,
      inventory_value_excludes_missing_cost: true,
      missing_cost_sku_count: new Set(missingCostSkus).size,
      slow_dead_inventory_value: slowDeadValue,
      capital_at_risk_pct: capitalAtRiskPct,
      by_class: byClass,
      critical_sku_count: criticalSkus.length,
      low_sku_count: lowSkus.length,
      overstock_sku_count: overstockSkus.length,
      no_demand_sku_count: noDemandSkus.length,
      out_of_stock_sku_count: oosSkus.length,
      restock_priority_count: restockPriorities.length,
    },
    skus: skuRows.sort((a, b) => b.priority_score - a.priority_score),
    products,
    restock_priorities: restockPriorities,
    dead_slow_stock: deadSlow,
    top_sellers: topSellers,
    stockout_risks: skuRows
      .filter((r) => r.stockout_risk)
      .sort((a, b) => b.priority_score - a.priority_score),
    data_quality: {
      warnings: [
        ...warnings,
        ...[...new Set(missingCostSkus)].map((s) => `missing_cost:${s}`),
        ...[...new Set(missingVmSkus)].map((s) => `missing_variant_master:${s}`),
        ...salesWithoutInventory.map((s) => `sales_without_inventory:${s}`),
        ...negativeStock.map((s) => `negative_stock:${s}`),
        ...missingSkuVariants.map(
          (m) =>
            `missing_sku_on_variant:${m.product}/${m.variant} stock=${m.current_stock}`
        ),
      ],
      missing_cost_skus: [...new Set(missingCostSkus)],
      missing_variant_master_skus: [...new Set(missingVmSkus)],
      sales_without_inventory: salesWithoutInventory,
      negative_stock_skus: negativeStock,
      missing_sku_variants: missingSkuVariants,
    },
  };
}

module.exports = {
  buildInventoryReport,
  productKey,
};
