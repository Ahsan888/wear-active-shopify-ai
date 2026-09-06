/**
 * Build Phase 8 pricing & promotion intelligence report.
 * Advisory only — joins Shopify prices + inventory intelligence + Variant Master costs.
 */
const { round2 } = require("../books/tax");
const { resolvePricingThresholds } = require("./thresholds");
const {
  unitEconomics,
  buildSimulationLadder,
  minimumMarginPrice,
  maximumSafeDiscountPct,
} = require("./simulate");
const { classifyPricingAction } = require("./classify");

function productKey(product, handle) {
  return String(product || handle || "Unknown").trim() || "Unknown";
}

/**
 * Index price rows by SKU; duplicates flagged, not trusted for pricing.
 */
function indexPrices(priceRows = []) {
  const bySku = new Map();
  const duplicates = new Set();
  const missingSku = [];
  for (const p of priceRows) {
    const sku = p.sku ? String(p.sku).trim() : "";
    if (!sku) {
      missingSku.push(p);
      continue;
    }
    if (bySku.has(sku)) {
      duplicates.add(sku);
      continue;
    }
    bySku.set(sku, p);
  }
  for (const sku of duplicates) {
    bySku.delete(sku);
  }
  return { bySku, duplicates: [...duplicates], missingSku };
}

/**
 * @param {object} input
 * @param {object[]} input.inventorySkus - from buildInventoryReport().skus
 * @param {object[]} input.shopifyPrices - from fetchVariantPrices()
 * @param {object} [input.catalogBySku]
 * @param {object} [input.thresholds]
 * @param {object} [input.customerDiagnostics] - optional Phase 6 summary
 * @param {{ since?: string, until?: string }} [input.period]
 */
function buildPricingReport(input = {}) {
  const thresholds = resolvePricingThresholds(input.thresholds || {});
  const invSkus = input.inventorySkus || [];
  const { bySku: priceBySku, duplicates, missingSku } = indexPrices(
    input.shopifyPrices || []
  );

  const rows = [];
  const warnings = [];

  for (const sku of duplicates) {
    warnings.push(`duplicate_shopify_sku:${sku}`);
  }
  for (const m of missingSku.slice(0, 20)) {
    warnings.push(
      `missing_sku_on_priced_variant:${m.product}/${m.variant} price=${m.current_price}`
    );
  }

  // Union: inventory SKUs + priced SKUs
  const allSkus = new Set([
    ...invSkus.map((s) => s.sku).filter(Boolean),
    ...priceBySku.keys(),
  ]);

  const invBySku = new Map(invSkus.map((s) => [s.sku, s]));

  for (const sku of allSkus) {
    const inv = invBySku.get(sku) || null;
    const priceRow = priceBySku.get(sku) || null;
    const dq = [...(inv?.data_quality_warnings || [])];

    if (duplicates.includes(sku)) dq.push("duplicate_shopify_sku");
    if (!priceRow) dq.push("missing_shopify_price");
    if (priceRow && (priceRow.current_price == null || !(priceRow.current_price > 0))) {
      dq.push("price_missing_or_zero");
    }

    const unitCost =
      inv?.unit_cost != null
        ? inv.unit_cost
        : input.catalogBySku?.[sku]?.costPerItem ?? null;
    if (unitCost == null) dq.push("missing_cost");

    const sticker = priceRow?.current_price ?? null;
    const econ = unitEconomics(sticker, unitCost);
    if (econ.unit_cost != null && econ.current_price != null && econ.unit_cost >= econ.current_price) {
      dq.push("cost_gte_price");
    }

    const floor = minimumMarginPrice(unitCost, thresholds.min_gross_margin_pct);
    const maxSafe =
      sticker != null && floor != null
        ? maximumSafeDiscountPct(sticker, Math.max(unitCost || 0, floor))
        : sticker != null && unitCost != null
          ? maximumSafeDiscountPct(sticker, unitCost)
          : null;

    const base = {
      sku,
      product: priceRow?.product || inv?.product || null,
      product_id: priceRow?.product_id || null,
      variant: priceRow?.variant || inv?.variant || null,
      size: priceRow?.size || inv?.size || "",
      color: priceRow?.color || inv?.color || "",
      current_price: econ.current_price,
      compare_at_price: priceRow?.compare_at_price ?? null,
      unit_cost: econ.unit_cost,
      unit_gp: econ.unit_gp,
      unit_gm_pct: econ.unit_gm_pct,
      price_ex_tax: econ.price_ex_tax,
      unit_gp_ex_tax: econ.unit_gp_ex_tax,
      unit_gm_ex_tax_pct: econ.unit_gm_ex_tax_pct,
      current_stock: inv?.current_stock ?? priceRow?.current_stock ?? null,
      stock_trusted: inv ? inv.stock_trusted !== false : true,
      stock_class: inv?.stock_class || "UNKNOWN",
      days_of_cover: inv?.days_of_cover ?? null,
      units_sold_7d: inv?.units_sold_7d || 0,
      units_sold_30d: inv?.units_sold_30d || 0,
      units_sold_90d: inv?.units_sold_90d || 0,
      demand_trend: inv?.demand_trend || "insufficient_data",
      inventory_value: inv?.inventory_value ?? null,
      inventory_action: inv?.recommended_action || null,
      minimum_margin_price: floor,
      maximum_safe_discount_pct: maxSafe,
      simulations: buildSimulationLadder(sticker, unitCost, thresholds),
      data_quality_warnings: dq,
      tax_note:
        "Sticker price is Shopify tax-inclusive; Books recognized revenue is typically ex-tax. Primary GP uses sticker − cost.",
    };

    const action = classifyPricingAction(base, thresholds);
    const recommendedPrice = action.recommended_price;
    const discPct = action.recommended_discount_pct;
    const scenario = action.scenario || null;

    let retailAtRecommended = null;
    let capitalTied = null;
    const stock = Number(base.current_stock);
    if (
      Number.isFinite(stock) &&
      stock > 0 &&
      recommendedPrice != null &&
      base.stock_trusted
    ) {
      retailAtRecommended = round2(stock * recommendedPrice);
    }
    if (
      Number.isFinite(stock) &&
      stock > 0 &&
      base.unit_cost != null &&
      base.stock_trusted
    ) {
      capitalTied =
        base.inventory_value != null
          ? base.inventory_value
          : round2(stock * base.unit_cost);
    }

    const currentRetail =
      Number.isFinite(stock) &&
      stock > 0 &&
      base.current_price != null &&
      base.stock_trusted
        ? round2(stock * base.current_price)
        : null;

    rows.push({
      ...base,
      recommendation: action.recommendation,
      recommended_discount_pct: discPct,
      recommended_price: recommendedPrice,
      price_increase_test: action.price_increase_test || null,
      deep_clearance_review: Boolean(action.deep_clearance_review),
      confidence: action.confidence || "insufficient",
      scenario,
      gp_sacrificed_per_unit:
        base.unit_gp != null && scenario?.unit_gp != null
          ? round2(base.unit_gp - scenario.unit_gp)
          : null,
      required_unit_lift_to_preserve_gp:
        scenario?.units_required_to_match_current_gp ?? null,
      inventory_cost_capital_tied_up: capitalTied,
      inventory_retail_value_current: currentRetail,
      inventory_retail_value_at_recommended_price: retailAtRecommended,
      note: action.note || null,
    });
  }

  const byRec = {};
  for (const r of rows) {
    byRec[r.recommendation] = (byRec[r.recommendation] || 0) + 1;
  }

  const clearance = rows
    .filter((r) => r.recommendation === "CLEARANCE_CANDIDATE")
    .sort(
      (a, b) =>
        (b.inventory_cost_capital_tied_up || 0) -
        (a.inventory_cost_capital_tied_up || 0)
    );
  const promotion = rows
    .filter((r) => r.recommendation === "PROMOTION_CANDIDATE")
    .sort(
      (a, b) =>
        (b.inventory_cost_capital_tied_up || 0) -
        (a.inventory_cost_capital_tied_up || 0)
    );
  const protect = rows
    .filter((r) => r.recommendation === "PROTECT_PRICE")
    .sort((a, b) => (b.units_sold_30d || 0) - (a.units_sold_30d || 0));
  const increase = rows
    .filter((r) => r.recommendation === "PRICE_INCREASE_CANDIDATE")
    .sort((a, b) => (b.units_sold_30d || 0) - (a.units_sold_30d || 0));
  const small = rows.filter((r) => r.recommendation === "TEST_SMALL_DISCOUNT");
  const hold = rows.filter((r) => r.recommendation === "HOLD_PRICE");
  const insufficient = rows.filter(
    (r) => r.recommendation === "INSUFFICIENT_DATA"
  );

  const sumCapital = (list) =>
    round2(
      list.reduce((s, r) => s + (Number(r.inventory_cost_capital_tied_up) || 0), 0)
    );

  // Product aggregation — worst inventory class + shared recommendation priority
  const productMap = new Map();
  const recRank = {
    CLEARANCE_CANDIDATE: 0,
    PROMOTION_CANDIDATE: 1,
    TEST_SMALL_DISCOUNT: 2,
    PRICE_INCREASE_CANDIDATE: 3,
    PROTECT_PRICE: 4,
    HOLD_PRICE: 5,
    INSUFFICIENT_DATA: 6,
  };
  for (const r of rows) {
    const key = productKey(r.product, r.sku);
    if (!productMap.has(key)) {
      productMap.set(key, {
        product: r.product || key,
        skus: [],
        current_price_set: new Set(),
        recommendation: r.recommendation,
        inventory_cost_capital_tied_up: 0,
        has_variant_stockout_risk: false,
      });
    }
    const p = productMap.get(key);
    p.skus.push(r.sku);
    if (r.current_price != null) p.current_price_set.add(r.current_price);
    if ((recRank[r.recommendation] ?? 99) < (recRank[p.recommendation] ?? 99)) {
      p.recommendation = r.recommendation;
      p.recommended_discount_pct = r.recommended_discount_pct;
      p.recommended_price = r.recommended_price;
      p.confidence = r.confidence;
    }
    p.inventory_cost_capital_tied_up = round2(
      p.inventory_cost_capital_tied_up +
        (Number(r.inventory_cost_capital_tied_up) || 0)
    );
    if (["OUT_OF_STOCK", "CRITICAL", "LOW"].includes(r.stock_class)) {
      p.has_variant_stockout_risk = true;
    }
  }
  const products = [...productMap.values()].map((p) => ({
    product: p.product,
    sku_count: p.skus.length,
    variant_prices: [...p.current_price_set],
    shared_product_price: p.current_price_set.size <= 1,
    recommendation: p.recommendation,
    recommended_discount_pct: p.recommended_discount_pct ?? null,
    recommended_price: p.recommended_price ?? null,
    confidence: p.confidence || null,
    inventory_cost_capital_tied_up: p.inventory_cost_capital_tied_up,
    has_variant_stockout_risk: p.has_variant_stockout_risk,
  }));

  const customerDiag = input.customerDiagnostics
    ? {
        note: "Phase 6 diagnostic only — not allocated to SKUs.",
        repeat_customer_rate_pct:
          input.customerDiagnostics.repeat_customer_rate_pct ?? null,
        returning_aov:
          input.customerDiagnostics.returning_aov ??
          input.customerDiagnostics.new_vs_returning?.returning_customer_orders
            ?.aov ??
          null,
        new_aov:
          input.customerDiagnostics.new_aov ??
          input.customerDiagnostics.new_vs_returning?.new_customer_orders?.aov ??
          null,
      }
    : null;

  return {
    generated_at: new Date().toISOString(),
    advisory_only: true,
    period: input.period || null,
    thresholds,
    conventions: {
      sticker_price: "Shopify variant price (tax-inclusive catalog sticker)",
      unit_cost: "Variant Master CostPerItem",
      unit_gp: "sticker_price − unit_cost (commercial)",
      books_note:
        "Books recognized revenue is typically ex-tax; sticker GP is not identical to Ledger line GP.",
      no_writes: true,
    },
    summary: {
      sku_count: rows.length,
      product_count: products.length,
      by_recommendation: byRec,
      protect_price_count: protect.length,
      hold_price_count: hold.length,
      test_small_discount_count: small.length,
      promotion_count: promotion.length,
      clearance_count: clearance.length,
      price_increase_count: increase.length,
      insufficient_count: insufficient.length,
      capital_tied_up_clearance: sumCapital(clearance),
      capital_tied_up_promotion: sumCapital(promotion),
      capital_tied_up_promotion_and_clearance: round2(
        sumCapital(clearance) + sumCapital(promotion)
      ),
    },
    skus: rows.sort((a, b) => {
      const ra = recRank[a.recommendation] ?? 50;
      const rb = recRank[b.recommendation] ?? 50;
      if (ra !== rb) return ra - rb;
      return (
        (b.inventory_cost_capital_tied_up || 0) -
        (a.inventory_cost_capital_tied_up || 0)
      );
    }),
    products,
    clearance_candidates: clearance,
    promotion_candidates: promotion,
    protect_price: protect,
    price_increase_candidates: increase,
    test_small_discount: small,
    customer_diagnostics: customerDiag,
    data_quality: {
      warnings: [
        ...warnings,
        ...rows
          .flatMap((r) =>
            (r.data_quality_warnings || []).map((w) => `${w}:${r.sku}`)
          )
          .slice(0, 80),
      ],
      duplicate_skus: duplicates,
      missing_sku_priced_variants: missingSku.length,
    },
    sources: {
      price: "Shopify productVariants.price / compareAtPrice (ACTIVE)",
      cost: "Variant Master CostPerItem",
      inventory: "Phase 7 buildInventoryReport stock_class / demand / cover",
      demand: "Books Ledger recognized sales via inventory demand windows",
    },
  };
}

module.exports = {
  buildPricingReport,
  indexPrices,
  productKey,
};
