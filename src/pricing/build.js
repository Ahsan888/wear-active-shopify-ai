/**
 * Build Phase 8 pricing & promotion intelligence report.
 * Advisory only — joins Shopify prices + inventory intelligence + Variant Master costs.
 *
 * Safe discounts use accounting (ex-tax) margin floors.
 * Product rollup blocks product-wide clearance when variants conflict.
 */
const { round2 } = require("../books/tax");
const { resolvePricingThresholds } = require("./thresholds");
const {
  unitEconomics,
  buildSimulationLadder,
  accountingSafeFloorPrice,
  maximumSafeDiscountPct,
  DEFAULT_TAX_CHARGEABLE,
} = require("./simulate");
const { classifyPricingAction } = require("./classify");
const { resolveClearanceMaturity } = require("./maturity");

function productKey(product, handle) {
  return String(product || handle || "Unknown").trim() || "Unknown";
}

const STOCKOUT_CLASSES = new Set(["OUT_OF_STOCK", "CRITICAL", "LOW"]);
const CLEARANCE_REC = "CLEARANCE_CANDIDATE";
const PROMO_RECS = new Set(["PROMOTION_CANDIDATE", "TEST_SMALL_DISCOUNT"]);
const PROTECT_RECS = new Set(["PROTECT_PRICE", "PRICE_INCREASE_CANDIDATE"]);

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
 * Product-level recommendation when variants share one Shopify price.
 * Never let CLEARANCE override PROTECT via naive priority.
 */
function resolveProductRecommendation(variants) {
  const sharedPrice =
    new Set(
      variants.map((v) => v.current_price).filter((p) => p != null && Number.isFinite(p))
    ).size <= 1;

  const hasStockout = variants.some((v) => STOCKOUT_CLASSES.has(v.stock_class));
  const clearanceVariants = variants.filter((v) => v.recommendation === CLEARANCE_REC);
  const promoVariants = variants.filter((v) => PROMO_RECS.has(v.recommendation));
  const protectVariants = variants.filter((v) => PROTECT_RECS.has(v.recommendation));

  const mixedInventorySignal =
    hasStockout && (clearanceVariants.length > 0 || promoVariants.length > 0);

  const baseCounts = {
    has_variant_stockout_risk: hasStockout,
    clearance_variant_count: clearanceVariants.length,
    promotion_variant_count: promoVariants.length,
    protect_variant_count: protectVariants.length,
    mixed_inventory_signal: mixedInventorySignal,
    shared_product_price: sharedPrice,
  };

  // Variant-specific pricing: keep independent guidance; no product-wide markdown
  if (!sharedPrice) {
    return {
      ...baseCounts,
      recommendation: mixedInventorySignal
        ? "MIXED_VARIANT_REVIEW"
        : dominantVariantRec(variants),
      recommended_discount_pct: null,
      recommended_price: null,
      confidence: mixedInventorySignal ? "medium" : null,
      explanation: mixedInventorySignal
        ? "Variant-specific prices present; review per size. Stock signals conflict across variants."
        : null,
      product_wide_markdown: false,
    };
  }

  // Shared product price + conflict → do not product-wide markdown
  if (mixedInventorySignal) {
    return {
      ...baseCounts,
      recommendation: protectVariants.length
        ? "PROTECT_PRICE_PRODUCT_WIDE"
        : "MIXED_VARIANT_REVIEW",
      recommended_discount_pct: null,
      recommended_price: null,
      confidence: "medium",
      explanation:
        "Some variants have excess/dead stock, while other variants have stockout risk. Do not apply product-wide markdown.",
      product_wide_markdown: false,
    };
  }

  // All clearance (or clearance-only actionable) → product clearance OK
  const actionable = variants.filter(
    (v) => v.recommendation && v.recommendation !== "INSUFFICIENT_DATA"
  );
  if (
    actionable.length > 0 &&
    actionable.every((v) => v.recommendation === CLEARANCE_REC)
  ) {
    const lead = clearanceVariants.sort(
      (a, b) =>
        (b.inventory_cost_capital_tied_up || 0) -
        (a.inventory_cost_capital_tied_up || 0)
    )[0];
    return {
      ...baseCounts,
      recommendation: CLEARANCE_REC,
      recommended_discount_pct: lead?.recommended_discount_pct ?? null,
      recommended_price: lead?.recommended_price ?? null,
      confidence: lead?.confidence || null,
      explanation: null,
      product_wide_markdown: true,
    };
  }

  if (
    actionable.length > 0 &&
    actionable.every((v) => PROMO_RECS.has(v.recommendation))
  ) {
    const lead = promoVariants[0];
    return {
      ...baseCounts,
      recommendation: lead.recommendation,
      recommended_discount_pct: lead.recommended_discount_pct ?? null,
      recommended_price: lead.recommended_price ?? null,
      confidence: lead.confidence || null,
      explanation: null,
      product_wide_markdown: true,
    };
  }

  if (
    actionable.length > 0 &&
    actionable.every((v) => PROTECT_RECS.has(v.recommendation))
  ) {
    return {
      ...baseCounts,
      recommendation: "PROTECT_PRICE",
      recommended_discount_pct: null,
      recommended_price: null,
      confidence: protectVariants[0]?.confidence || null,
      explanation: null,
      product_wide_markdown: false,
    };
  }

  return {
    ...baseCounts,
    recommendation: dominantVariantRec(variants),
    recommended_discount_pct: null,
    recommended_price: null,
    confidence: null,
    explanation: mixedInventorySignal
      ? "Some variants have excess/dead stock, while other variants have stockout risk. Do not apply product-wide markdown."
      : null,
    product_wide_markdown: false,
  };
}

/** Prefer protect/hold over clearance when aggregating without conflict rules. */
function dominantVariantRec(variants) {
  const rank = {
    PROTECT_PRICE: 0,
    PRICE_INCREASE_CANDIDATE: 1,
    HOLD_PRICE: 2,
    TEST_SMALL_DISCOUNT: 3,
    PROMOTION_CANDIDATE: 4,
    CLEARANCE_CANDIDATE: 5,
    INSUFFICIENT_DATA: 6,
    MIXED_VARIANT_REVIEW: 7,
    PROTECT_PRICE_PRODUCT_WIDE: 0,
  };
  let best = variants[0]?.recommendation || "INSUFFICIENT_DATA";
  let bestRank = rank[best] ?? 99;
  for (const v of variants) {
    const r = rank[v.recommendation] ?? 99;
    if (r < bestRank) {
      bestRank = r;
      best = v.recommendation;
    }
  }
  return best;
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
  const asOf = input.period?.until || new Date().toISOString().slice(0, 10);
  const taxChargeable = DEFAULT_TAX_CHARGEABLE;

  const rows = [];
  const warnings = [];
  let excludedImmatureClearance = 0;

  for (const sku of duplicates) {
    warnings.push(`duplicate_shopify_sku:${sku}`);
  }
  for (const m of missingSku.slice(0, 20)) {
    warnings.push(
      `missing_sku_on_priced_variant:${m.product}/${m.variant} price=${m.current_price}`
    );
  }

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
    const econ = unitEconomics(sticker, unitCost, taxChargeable);
    if (
      econ.unit_cost != null &&
      econ.current_price != null &&
      econ.unit_cost >= econ.current_price
    ) {
      dq.push("cost_gte_price");
    }

    const maturity = resolveClearanceMaturity(
      {
        variant_created_at: priceRow?.variant_created_at,
        product_published_at: priceRow?.product_published_at,
        product_created_at: priceRow?.product_created_at,
      },
      asOf
    );
    if (maturity.clearance_maturity_source === "unknown") {
      dq.push("missing_clearance_maturity");
    }

    const floor = accountingSafeFloorPrice(
      unitCost,
      thresholds.min_gross_margin_pct,
      taxChargeable
    );
    const maxSafe =
      sticker != null && floor != null
        ? maximumSafeDiscountPct(sticker, floor)
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
      commercial_sticker_gp: econ.commercial_sticker_gp,
      commercial_sticker_gm_pct: econ.commercial_sticker_gm_pct,
      unit_gp: econ.unit_gp,
      unit_gm_pct: econ.unit_gm_pct,
      price_ex_tax: econ.price_ex_tax,
      accounting_gp_ex_tax: econ.accounting_gp_ex_tax,
      accounting_gm_ex_tax_pct: econ.accounting_gm_ex_tax_pct,
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
      selling_age_days: maturity.selling_age_days,
      clearance_mature: maturity.clearance_mature,
      clearance_maturity_source: maturity.clearance_maturity_source,
      immature_for_clearance: maturity.immature_for_clearance,
      sellable_from: maturity.sellable_from,
      minimum_margin_price: floor,
      maximum_safe_discount_pct: maxSafe,
      simulations: buildSimulationLadder(
        sticker,
        unitCost,
        thresholds,
        taxChargeable
      ),
      data_quality_warnings: dq,
      tax_chargeable: taxChargeable,
      tax_note:
        "Sticker is tax-inclusive; PRICING_MIN_GROSS_MARGIN_PCT floors use ex-tax Books accounting (splitInclusiveTax). Commercial sticker GP is display-only.",
    };

    // Track would-be clearance blocked by maturity (NO_DEMAND + immature)
    if (
      base.stock_class === "NO_DEMAND" &&
      maturity.immature_for_clearance &&
      Number(base.current_stock) > 0 &&
      base.unit_cost != null &&
      base.current_price != null
    ) {
      excludedImmatureClearance += 1;
    }

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
        base.commercial_sticker_gp != null && scenario?.commercial_sticker_gp != null
          ? round2(base.commercial_sticker_gp - scenario.commercial_sticker_gp)
          : base.unit_gp != null && scenario?.unit_gp != null
            ? round2(base.unit_gp - scenario.unit_gp)
            : null,
      required_unit_lift_to_preserve_gp:
        scenario?.units_required_to_match_current_gp ?? null,
      inventory_cost_capital_tied_up: capitalTied,
      inventory_retail_value_current: currentRetail,
      inventory_retail_value_at_recommended_price: retailAtRecommended,
      note: action.note || null,
      immature_for_clearance:
        action.immature_for_clearance ?? base.immature_for_clearance,
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

  // Product aggregation — mixed-variant safety
  const productMap = new Map();
  for (const r of rows) {
    const key = productKey(r.product, r.sku);
    if (!productMap.has(key)) {
      productMap.set(key, {
        product: r.product || key,
        variants: [],
      });
    }
    productMap.get(key).variants.push(r);
  }

  const products = [...productMap.values()].map((p) => {
    const resolved = resolveProductRecommendation(p.variants);
    const capital = round2(
      p.variants.reduce(
        (s, v) => s + (Number(v.inventory_cost_capital_tied_up) || 0),
        0
      )
    );
    return {
      product: p.product,
      sku_count: p.variants.length,
      variant_prices: [
        ...new Set(
          p.variants
            .map((v) => v.current_price)
            .filter((x) => x != null && Number.isFinite(x))
        ),
      ],
      shared_product_price: resolved.shared_product_price,
      recommendation: resolved.recommendation,
      recommended_discount_pct: resolved.recommended_discount_pct,
      recommended_price: resolved.recommended_price,
      confidence: resolved.confidence,
      inventory_cost_capital_tied_up: capital,
      has_variant_stockout_risk: resolved.has_variant_stockout_risk,
      clearance_variant_count: resolved.clearance_variant_count,
      promotion_variant_count: resolved.promotion_variant_count,
      protect_variant_count: resolved.protect_variant_count,
      mixed_inventory_signal: resolved.mixed_inventory_signal,
      product_wide_markdown: resolved.product_wide_markdown,
      explanation: resolved.explanation,
    };
  });

  const mixedProducts = products.filter(
    (p) =>
      p.mixed_inventory_signal ||
      p.recommendation === "MIXED_VARIANT_REVIEW" ||
      p.recommendation === "PROTECT_PRICE_PRODUCT_WIDE"
  );

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

  const recRank = {
    CLEARANCE_CANDIDATE: 0,
    PROMOTION_CANDIDATE: 1,
    TEST_SMALL_DISCOUNT: 2,
    PRICE_INCREASE_CANDIDATE: 3,
    PROTECT_PRICE: 4,
    HOLD_PRICE: 5,
    INSUFFICIENT_DATA: 6,
  };

  return {
    generated_at: new Date().toISOString(),
    advisory_only: true,
    period: input.period || null,
    thresholds,
    conventions: {
      sticker_price: "Shopify variant price (tax-inclusive catalog sticker)",
      unit_cost: "Variant Master CostPerItem",
      commercial_sticker_gp: "sticker_price − unit_cost (display)",
      accounting_gp_ex_tax:
        "splitInclusiveTax(sticker).revenueExTax − unit_cost (Books convention; default courier taxable)",
      pricing_floor:
        "PRICING_MIN_GROSS_MARGIN_PCT applied to ex-tax revenue; converted back to inclusive sticker via inclusiveFromExTax",
      books_note:
        "Books recognized revenue is typically ex-tax; recommended discounts must not breach accounting min GM.",
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
      excluded_immature_clearance_count: excludedImmatureClearance,
      mixed_variant_product_count: mixedProducts.length,
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
    mixed_variant_products: mixedProducts,
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
      excluded_immature_clearance_count: excludedImmatureClearance,
    },
    sources: {
      price: "Shopify productVariants.price / compareAtPrice (ACTIVE)",
      cost: "Variant Master CostPerItem",
      inventory: "Phase 7 buildInventoryReport stock_class / demand / cover",
      demand: "Books Ledger recognized sales via inventory demand windows",
      maturity:
        "Shopify variant.createdAt / product.publishedAt / product.createdAt",
      tax: "src/books/tax.js splitInclusiveTax + inclusiveFromExTax (18% courier)",
    },
  };
}

module.exports = {
  buildPricingReport,
  indexPrices,
  productKey,
  resolveProductRecommendation,
};
