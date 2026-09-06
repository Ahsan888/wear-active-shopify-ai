/**
 * Price / discount simulation and floor math.
 *
 * Commercial simulation uses Shopify sticker price − Variant Master unit cost
 * (tax-inclusive sticker). Books recognized revenue is typically ex-tax;
 * expose both for transparency.
 */
const { round2, splitInclusiveTax } = require("../books/tax");
const { resolvePricingThresholds } = require("./thresholds");

function unitEconomics(stickerPrice, unitCost) {
  const price = Number(stickerPrice);
  const cost = Number(unitCost);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      current_price: Number.isFinite(price) ? price : null,
      unit_cost: Number.isFinite(cost) ? cost : null,
      unit_gp: null,
      unit_gm_pct: null,
      price_ex_tax: null,
      unit_gp_ex_tax: null,
      unit_gm_ex_tax_pct: null,
    };
  }
  const costOk = Number.isFinite(cost) ? cost : null;
  const unitGp = costOk == null ? null : round2(price - costOk);
  const unitGm =
    unitGp == null ? null : round2((unitGp / price) * 100);
  const { revenueExTax } = splitInclusiveTax(price, true);
  const unitGpEx =
    costOk == null ? null : round2(revenueExTax - costOk);
  const unitGmEx =
    unitGpEx == null || !(revenueExTax > 0)
      ? null
      : round2((unitGpEx / revenueExTax) * 100);
  return {
    current_price: round2(price),
    unit_cost: costOk == null ? null : round2(costOk),
    unit_gp: unitGp,
    unit_gm_pct: unitGm,
    price_ex_tax: revenueExTax,
    unit_gp_ex_tax: unitGpEx,
    unit_gm_ex_tax_pct: unitGmEx,
  };
}

/**
 * Minimum price to achieve min_gross_margin_pct on sticker basis.
 * price = cost / (1 - m)
 */
function minimumMarginPrice(unitCost, minMarginPct) {
  const cost = Number(unitCost);
  const m = Number(minMarginPct) / 100;
  if (!Number.isFinite(cost) || cost < 0) return null;
  if (!Number.isFinite(m) || m <= 0 || m >= 1) return null;
  return round2(cost / (1 - m));
}

function maximumSafeDiscountPct(currentPrice, floorPrice) {
  const price = Number(currentPrice);
  const floor = Number(floorPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(floor) || floor < 0) return null;
  if (floor >= price) return 0;
  return round2(((price - floor) / price) * 100);
}

/**
 * Simulate one discount scenario.
 * GP volume multiplier = current_gp / discounted_gp (units lift to preserve GP).
 */
function simulateDiscount(currentPrice, unitCost, discountPct) {
  const price = Number(currentPrice);
  const cost = Number(unitCost);
  const d = Number(discountPct);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(d) || d < 0) return null;

  const selling = round2(price * (1 - d / 100));
  const costOk = Number.isFinite(cost) ? cost : null;
  const currentGp = costOk == null ? null : round2(price - costOk);
  const unitGp = costOk == null ? null : round2(selling - costOk);
  const unitGm =
    unitGp == null || !(selling > 0) ? null : round2((unitGp / selling) * 100);

  let unitsToMatchRevenue = null;
  let unitsToMatchGp = null;
  if (selling > 0) {
    unitsToMatchRevenue = round2(price / selling);
  }
  if (unitGp != null && unitGp > 0 && currentGp != null && currentGp > 0) {
    unitsToMatchGp = round2(currentGp / unitGp);
  } else if (unitGp != null && unitGp <= 0) {
    unitsToMatchGp = null; // cannot preserve GP at non-positive GP
  }

  return {
    discount_pct: d,
    selling_price: selling,
    unit_cost: costOk == null ? null : round2(costOk),
    unit_gp: unitGp,
    unit_gm_pct: unitGm,
    units_required_to_match_current_revenue: unitsToMatchRevenue,
    units_required_to_match_current_gp: unitsToMatchGp,
    below_cost: costOk != null && selling < costOk,
  };
}

function simulateIncrease(currentPrice, unitCost, increasePct) {
  const price = Number(currentPrice);
  const cost = Number(unitCost);
  const inc = Number(increasePct);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(inc) || inc < 0) return null;
  const selling = round2(price * (1 + inc / 100));
  const costOk = Number.isFinite(cost) ? cost : null;
  const currentGp = costOk == null ? null : round2(price - costOk);
  const unitGp = costOk == null ? null : round2(selling - costOk);
  const unitGm =
    unitGp == null || !(selling > 0) ? null : round2((unitGp / selling) * 100);
  const gpUplift =
    currentGp == null || unitGp == null ? null : round2(unitGp - currentGp);
  return {
    increase_pct: inc,
    selling_price: selling,
    unit_gp: unitGp,
    unit_gm_pct: unitGm,
    gp_uplift_per_unit: gpUplift,
    label: "PRICE INCREASE TEST CANDIDATE",
  };
}

function buildSimulationLadder(currentPrice, unitCost, thresholds) {
  const t = resolvePricingThresholds(thresholds);
  return (t.discount_steps || [])
    .map((d) => simulateDiscount(currentPrice, unitCost, d))
    .filter(Boolean);
}

module.exports = {
  unitEconomics,
  minimumMarginPrice,
  maximumSafeDiscountPct,
  simulateDiscount,
  simulateIncrease,
  buildSimulationLadder,
};
