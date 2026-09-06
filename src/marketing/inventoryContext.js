/**
 * Inventory / pricing constraints for marketing actions.
 * Only applied when explicit entity→product mapping exists.
 */
const { MARKETING } = require("./thresholds");
const { lookupEntityProduct } = require("./mapping");

function resolveInventoryMarketingContext(entity, ctx = {}) {
  const mapIndex = ctx.mapIndex;
  const mapped = lookupEntityProduct(entity, mapIndex);

  if (!mapped) {
    return {
      inventory_action: "UNKNOWN",
      mapping: null,
      suppress_scale: false,
      promotion_eligible: false,
      stock_class: null,
      pricing_recommendation: null,
      inventory_capital: null,
      reason_codes: ["INVENTORY_MAPPING_UNAVAILABLE"],
    };
  }

  const invBySku = ctx.inventoryBySku || new Map();
  const pricingBySku = ctx.pricingBySku || new Map();
  const inv = mapped.sku ? invBySku.get(mapped.sku) : null;
  const pricing = mapped.sku ? pricingBySku.get(mapped.sku) : null;

  // Fallback: match product title exact among pricing rows
  let pricingRow = pricing;
  let invRow = inv;
  if (!pricingRow && mapped.product && ctx.pricingByProduct) {
    pricingRow = ctx.pricingByProduct.get(mapped.product) || null;
  }
  if (!invRow && mapped.product && ctx.inventoryByProduct) {
    invRow = ctx.inventoryByProduct.get(mapped.product) || null;
  }

  const stock_class = invRow?.stock_class || null;
  const stock_trusted = invRow ? invRow.stock_trusted !== false : false;
  const pricing_recommendation = pricingRow?.recommendation || null;
  const immature = Boolean(pricingRow?.immature_for_clearance);
  const disc = pricingRow?.recommended_discount_pct;
  const safeDisc = disc != null && disc >= 5;

  const suppress_scale =
    stock_trusted &&
    stock_class &&
    MARKETING.STOCKOUT_CLASSES.has(stock_class);

  const promotion_eligible =
    stock_trusted &&
    pricing_recommendation &&
    MARKETING.PROMO_PRICING.has(pricing_recommendation) &&
    safeDisc &&
    !immature &&
    (pricing_recommendation !== "CLEARANCE_CANDIDATE" ||
      pricingRow?.clearance_mature === true);

  const reason_codes = [];
  if (suppress_scale) reason_codes.push("INVENTORY_LIMITED");
  if (promotion_eligible) {
    if (pricing_recommendation === "CLEARANCE_CANDIDATE") {
      reason_codes.push("CLEARANCE_INVENTORY");
    }
    reason_codes.push("PROMOTION_MARGIN_AVAILABLE");
  }
  if (immature) reason_codes.push("IMMATURE_CLEARANCE");
  if (invRow && !stock_trusted) reason_codes.push("INVENTORY_UNTRUSTED");

  return {
    inventory_action: suppress_scale
      ? "SUPPRESS_SCALE"
      : promotion_eligible
        ? "PROMOTION_OPPORTUNITY"
        : stock_class || "MAPPED_NO_SIGNAL",
    mapping: mapped,
    suppress_scale,
    promotion_eligible,
    stock_class,
    pricing_recommendation,
    recommended_discount_pct: disc ?? null,
    inventory_capital:
      pricingRow?.inventory_cost_capital_tied_up ??
      invRow?.inventory_value ??
      null,
    immature_for_clearance: immature,
    reason_codes,
  };
}

module.exports = {
  resolveInventoryMarketingContext,
};
