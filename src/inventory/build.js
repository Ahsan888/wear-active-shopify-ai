/**
 * Build inventory intelligence report from Shopify stock + Ledger demand + VM costs.
 * Advisory only — no writes.
 */
const { round2 } = require("../books/tax");
const { resolveThresholds } = require("./thresholds");
const { demandForSku } = require("./demand");
const {
  avgDailyUnits,
  parseStock,
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

function looksLikeBundleOrSet(product, variant) {
  const text = `${product || ""} ${variant || ""}`;
  return /\b(set|bundle|pack)\b/i.test(text);
}

function stockUnits(value) {
  const n = parseStock(value);
  return n == null ? 0 : n;
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
  const warnings = [];
  const missingCostSkus = [];
  const missingVmSkus = [];
  const missingSkuVariants = [];
  const negativeStock = [];
  const salesWithoutInventory = [];
  const duplicateSkuDetails = [];

  // Group Shopify variants by SKU — never sum duplicates
  const variantsBySku = new Map();
  let shopifyVariantCount = 0;
  let missingSkuVariantCount = 0;
  let unkeyedInventoryUnits = 0;
  let unkeyedLikelyBundleUnits = 0;
  let unkeyedOtherUnits = 0;

  for (const v of variants) {
    shopifyVariantCount += 1;
    const sku = v.sku ? String(v.sku).trim() : "";
    const units = stockUnits(v.current_stock);
    if (!sku) {
      missingSkuVariantCount += 1;
      const entry = {
        product: v.product,
        variant: v.variant,
        current_stock: v.current_stock,
        likely_virtual_bundle: looksLikeBundleOrSet(v.product, v.variant),
      };
      missingSkuVariants.push(entry);
      unkeyedInventoryUnits += units;
      if (entry.likely_virtual_bundle) unkeyedLikelyBundleUnits += units;
      else unkeyedOtherUnits += units;
      continue;
    }
    if (!variantsBySku.has(sku)) variantsBySku.set(sku, []);
    variantsBySku.get(sku).push({ ...v, sku });
  }

  const duplicateSkus = new Set();
  for (const [sku, list] of variantsBySku.entries()) {
    if (list.length <= 1) continue;
    duplicateSkus.add(sku);
    duplicateSkuDetails.push({
      sku,
      variant_count: list.length,
      variants: list.map((x) => ({
        product: x.product,
        variant: x.variant,
        current_stock: x.current_stock,
        variant_id: x.variant_id || null,
      })),
      quantities: list.map((x) => x.current_stock),
    });
    warnings.push(
      `duplicate_shopify_sku:${sku} variants=${list.length} qtys=[${list
        .map((x) => x.current_stock)
        .join(",")}]`
    );
  }

  let skuAddressableVariantCount = 0;
  let skuAddressableUnits = 0;
  let duplicateSkuVariantCount = 0;
  let duplicateSkuUnitsExcluded = 0;

  for (const [sku, list] of variantsBySku.entries()) {
    if (duplicateSkus.has(sku)) {
      duplicateSkuVariantCount += list.length;
      for (const x of list) duplicateSkuUnitsExcluded += stockUnits(x.current_stock);
      continue;
    }
    skuAddressableVariantCount += 1;
    skuAddressableUnits += stockUnits(list[0].current_stock);
  }

  // Safe total excludes duplicate-SKU variants (ambiguous). Unkeyed reported separately.
  // Bundle/set no-SKU variants are identified but still counted in unkeyed (not mixed into headline).
  const totalShopifyInventoryUnitsIfSafe = round2(
    skuAddressableUnits + unkeyedInventoryUnits
  );

  const allSkus = new Set([
    ...variantsBySku.keys(),
    ...(demandWindows?.demand_30d?.keys?.() || []),
    ...(demandWindows?.demand_90d?.keys?.() || []),
  ]);

  for (const sku of allSkus) {
    const list = variantsBySku.get(sku) || [];
    const isDuplicate = duplicateSkus.has(sku);
    const inv = !isDuplicate && list.length === 1 ? list[0] : null;
    const vm = catalogBySku[sku] || null;
    const dem = demandForSku(demandWindows, sku);
    const dq = [];

    if (isDuplicate) {
      dq.push("duplicate_shopify_sku");
    }
    if (!list.length) {
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

    const stockTrusted = Boolean(inv) && !isDuplicate;
    let stock = null;
    if (isDuplicate) {
      stock = null;
      dq.push("untrusted_duplicate_inventory");
    } else if (inv) {
      if (inv.current_stock == null || inv.current_stock === "") {
        dq.push("missing_shopify_inventory");
        stock = null;
      } else {
        stock = parseStock(inv.current_stock);
        if (stock == null) dq.push("missing_shopify_inventory");
      }
    }

    if (stock != null && stock < 0) {
      dq.push("negative_stock");
      negativeStock.push(sku);
    }
    if (stockTrusted && stock != null && stock > 0 && dem.units_sold_90d === 0) {
      dq.push("inventory_without_sales_history");
    } else if (
      stockTrusted &&
      stock != null &&
      stock > 0 &&
      dem.units_sold_30d === 0 &&
      dem.units_sold_90d > 0
    ) {
      dq.push("no_recent_30d_demand");
    }

    const avgDaily = avgDailyUnits(dem.units_sold_30d, 30);
    const doc = daysOfCover(stock, dem.units_sold_30d);
    const stockClass = classifyStock(
      stock,
      doc,
      dem.units_sold_30d,
      dem.units_sold_90d,
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
      stock_trusted: stockTrusted,
      thresholds,
    });
    const restockQty = recommendedRestockQty({
      current_stock: stock,
      units_sold_30d: dem.units_sold_30d,
      action,
      stock_trusted: stockTrusted,
      thresholds,
    });

    // Trusted valuation only — duplicates and missing cost excluded
    let inventoryValue = null;
    if (stockTrusted && stock != null && unitCost != null) {
      inventoryValue = stock > 0 ? round2(stock * unitCost) : 0;
    }

    const row = {
      sku,
      product:
        inv?.product ||
        list[0]?.product ||
        vm?.product ||
        dem.product ||
        null,
      variant: inv?.variant || null,
      size: inv?.size || "",
      color: inv?.color || "",
      current_stock: stock,
      stock_trusted: stockTrusted,
      duplicate_variants: isDuplicate
        ? list.map((x) => ({
            product: x.product,
            variant: x.variant,
            current_stock: x.current_stock,
            variant_id: x.variant_id || null,
          }))
        : null,
      unit_cost: unitCost,
      inventory_value: inventoryValue,
      units_sold_7d: dem.units_sold_7d,
      units_sold_14d: dem.units_sold_14d,
      units_sold_30d: dem.units_sold_30d,
      units_sold_90d: dem.units_sold_90d,
      revenue_30d: dem.revenue_30d,
      gross_profit_30d: dem.gross_profit_30d,
      gross_margin_pct: dem.gross_margin_pct,
      avg_daily_units_30d: round2(avgDaily),
      days_of_cover: doc,
      stock_class: stockClass,
      stockout_risk:
        stockTrusted &&
        ["OUT_OF_STOCK", "CRITICAL", "LOW"].includes(stockClass),
      sell_through_class: stockClass,
      demand_trend: trend,
      recommended_action: action,
      recommended_restock_qty: restockQty,
      target_days_of_cover: thresholds.target_days_of_cover,
      data_quality_warnings: dq,
      confidence: null,
      priority_score: 0,
      in_shopify: list.length > 0,
      in_variant_master: Boolean(vm),
    };
    row.confidence = confidenceForSku(row);
    row.priority_score = priorityScore(row, thresholds);
    skuRows.push(row);
  }

  for (const miss of missingSkuVariants) {
    const tag = miss.likely_virtual_bundle ? "likely_bundle_set" : "unkeyed";
    warnings.push(
      `missing_sku(${tag}):${miss.product || "?"} / ${miss.variant || "?"} stock=${miss.current_stock}`
    );
  }

  // Product aggregation — trusted SKUs only for stock totals
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
    if (row.stock_trusted && row.current_stock != null) {
      p.current_stock += row.current_stock;
    }
    if (row.inventory_value != null) {
      p.inventory_value = round2(p.inventory_value + row.inventory_value);
    } else if (row.stock_trusted && row.current_stock > 0) {
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
    NO_RECENT_DEMAND: 4,
    OVERSTOCK: 5,
    HIGH: 6,
    HEALTHY: 7,
    UNKNOWN: 8,
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
    p.inventory_value = p.inventory_value_known
      ? round2(p.inventory_value)
      : null;
    p.avg_daily_units_30d = round2(avgDailyUnits(p.units_sold_30d, 30));
    p.days_of_cover =
      p.units_sold_30d > 0 && p.current_stock != null
        ? daysOfCover(p.current_stock, p.units_sold_30d)
        : null;
  }

  const products = [...productMap.values()].sort(
    (a, b) =>
      Number(b.has_variant_stockout_risk) -
        Number(a.has_variant_stockout_risk) ||
      b.units_sold_30d - a.units_sold_30d
  );

  // Trusted valued rows only
  const valued = skuRows.filter(
    (r) => r.stock_trusted && r.inventory_value != null
  );
  const totalInventoryValue = round2(
    valued.reduce((s, r) => s + (r.inventory_value || 0), 0)
  );

  // Capital buckets — mutually exclusive by stock_class (no double count)
  const sumClassValue = (cls) =>
    round2(
      valued
        .filter((r) => r.stock_class === cls)
        .reduce((s, r) => s + (r.inventory_value || 0), 0)
    );

  const deadInventoryValue = sumClassValue("NO_DEMAND");
  const noRecentDemandValue = sumClassValue("NO_RECENT_DEMAND");
  const overstockValue = sumClassValue("OVERSTOCK");
  const capitalAtRiskValue = round2(deadInventoryValue + overstockValue);
  const capitalAtRiskPct =
    totalInventoryValue > 0
      ? round2((capitalAtRiskValue / totalInventoryValue) * 100)
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
        r.stock_class === "NO_RECENT_DEMAND" ||
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
  const noRecentSkus = skuRows.filter(
    (r) => r.stock_class === "NO_RECENT_DEMAND"
  );
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
      dead_stock_window: "90d recognized sales for NO_DEMAND; 30d soft NO_RECENT_DEMAND",
    },
    summary: {
      sku_count: skuRows.length,
      product_count: products.length,
      // Headline units = trusted SKU-addressable only (excludes no-SKU + duplicate SKUs)
      total_units: round2(skuAddressableUnits),
      total_units_scope:
        "SKU-addressable trusted variants only (excludes missing-SKU and duplicate-SKU variants)",
      shopify_variant_count: shopifyVariantCount,
      sku_addressable_variant_count: skuAddressableVariantCount,
      missing_sku_variant_count: missingSkuVariantCount,
      duplicate_sku_variant_count: duplicateSkuVariantCount,
      duplicate_sku_count: duplicateSkus.size,
      sku_addressable_units: round2(skuAddressableUnits),
      unkeyed_inventory_units: round2(unkeyedInventoryUnits),
      unkeyed_likely_bundle_set_units: round2(unkeyedLikelyBundleUnits),
      unkeyed_other_units: round2(unkeyedOtherUnits),
      duplicate_sku_units_excluded: round2(duplicateSkuUnitsExcluded),
      total_shopify_inventory_units_if_safe: totalShopifyInventoryUnitsIfSafe,
      total_inventory_value: totalInventoryValue,
      inventory_value_excludes_missing_cost: true,
      inventory_value_excludes_duplicate_skus: true,
      missing_cost_sku_count: new Set(missingCostSkus).size,
      no_recent_demand_value: noRecentDemandValue,
      dead_inventory_value: deadInventoryValue,
      overstock_value: overstockValue,
      capital_at_risk_value: capitalAtRiskValue,
      capital_at_risk_pct: capitalAtRiskPct,
      // Back-compat alias: capital at risk (dead + overstock), not 30d soft
      slow_dead_inventory_value: capitalAtRiskValue,
      by_class: byClass,
      critical_sku_count: criticalSkus.length,
      low_sku_count: lowSkus.length,
      overstock_sku_count: overstockSkus.length,
      no_demand_sku_count: noDemandSkus.length,
      no_recent_demand_sku_count: noRecentSkus.length,
      out_of_stock_sku_count: oosSkus.length,
      restock_priority_count: restockPriorities.length,
    },
    notes: {
      unkeyed_inventory:
        "Variants without SKUs are excluded from headline SKU-addressable units. Titles matching Set/Bundle/Pack are tagged likely_virtual_bundle and reported under unkeyed_likely_bundle_set_units — they may represent virtual/combo inventory rather than extra physical units.",
      duplicate_skus:
        "Duplicate Shopify SKUs are excluded from trusted stock, valuation, and restock math. Variant-level quantities are listed in data_quality.duplicate_skus.",
      capital_at_risk:
        "capital_at_risk_value = dead_inventory_value (NO_DEMAND / 90d) + overstock_value. no_recent_demand_value (30d soft) is reported separately and not included.",
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
      ],
      missing_cost_skus: [...new Set(missingCostSkus)],
      missing_variant_master_skus: [...new Set(missingVmSkus)],
      sales_without_inventory: salesWithoutInventory,
      negative_stock_skus: negativeStock,
      missing_sku_variants: missingSkuVariants,
      duplicate_skus: duplicateSkuDetails,
    },
  };
}

module.exports = {
  buildInventoryReport,
  productKey,
  looksLikeBundleOrSet,
};
