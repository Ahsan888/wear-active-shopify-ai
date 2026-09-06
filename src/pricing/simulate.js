/**
 * Price / discount simulation and floor math.
 *
 * Commercial (sticker) GP remains visible for storefront intuition.
 * Safe discount floors and recommendations use Books ex-tax accounting GM
 * via splitInclusiveTax / inclusiveFromExTax (default courier = taxable).
 */
const {
  round2,
  splitInclusiveTax,
  inclusiveFromExTax,
} = require("../books/tax");
const { resolvePricingThresholds } = require("./thresholds");

/** Default catalog pricing assumes courier/website taxable treatment. */
const DEFAULT_TAX_CHARGEABLE = true;

function unitEconomics(stickerPrice, unitCost, taxChargeable = DEFAULT_TAX_CHARGEABLE) {
  const price = Number(stickerPrice);
  const cost = Number(unitCost);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      current_price: Number.isFinite(price) ? price : null,
      unit_cost: Number.isFinite(cost) ? cost : null,
      commercial_sticker_gp: null,
      commercial_sticker_gm_pct: null,
      unit_gp: null,
      unit_gm_pct: null,
      price_ex_tax: null,
      accounting_gp_ex_tax: null,
      accounting_gm_ex_tax_pct: null,
      unit_gp_ex_tax: null,
      unit_gm_ex_tax_pct: null,
    };
  }
  const costOk = Number.isFinite(cost) ? cost : null;
  const commercialGp = costOk == null ? null : round2(price - costOk);
  const commercialGm =
    commercialGp == null ? null : round2((commercialGp / price) * 100);
  const { revenueExTax } = splitInclusiveTax(price, taxChargeable);
  const accountingGp =
    costOk == null ? null : round2(revenueExTax - costOk);
  const accountingGm =
    accountingGp == null || !(revenueExTax > 0)
      ? null
      : round2((accountingGp / revenueExTax) * 100);
  return {
    current_price: round2(price),
    unit_cost: costOk == null ? null : round2(costOk),
    commercial_sticker_gp: commercialGp,
    commercial_sticker_gm_pct: commercialGm,
    // Back-compat aliases (commercial sticker)
    unit_gp: commercialGp,
    unit_gm_pct: commercialGm,
    price_ex_tax: revenueExTax,
    accounting_gp_ex_tax: accountingGp,
    accounting_gm_ex_tax_pct: accountingGm,
    unit_gp_ex_tax: accountingGp,
    unit_gm_ex_tax_pct: accountingGm,
  };
}

/**
 * Commercial sticker min price for target GM on inclusive sticker (display only).
 * price = cost / (1 - m)
 */
function minimumCommercialMarginPrice(unitCost, minMarginPct) {
  const cost = Number(unitCost);
  const m = Number(minMarginPct) / 100;
  if (!Number.isFinite(cost) || cost < 0) return null;
  if (!Number.isFinite(m) || m <= 0 || m >= 1) return null;
  return round2(cost / (1 - m));
}

/**
 * Accounting-safe minimum sticker: ex-tax revenue must hit min GM, then
 * convert back to tax-inclusive using Books tax helpers.
 *
 * required_ex_tax = cost / (1 - min_margin)
 * minimum_safe_sticker = inclusiveFromExTax(required_ex_tax)
 */
function minimumAccountingSafeStickerPrice(
  unitCost,
  minMarginPct,
  taxChargeable = DEFAULT_TAX_CHARGEABLE
) {
  const cost = Number(unitCost);
  const m = Number(minMarginPct) / 100;
  if (!Number.isFinite(cost) || cost < 0) return null;
  if (!Number.isFinite(m) || m <= 0 || m >= 1) return null;

  const requiredExTax = round2(cost / (1 - m));
  let sticker = inclusiveFromExTax(requiredExTax, taxChargeable);

  // Guard rounding: bump sticker until accounting GM meets floor.
  for (let i = 0; i < 10; i += 1) {
    const { revenueExTax } = splitInclusiveTax(sticker, taxChargeable);
    if (!(revenueExTax > 0)) break;
    const gm = (revenueExTax - cost) / revenueExTax;
    if (gm + 1e-12 >= m) break;
    sticker = round2(sticker + 0.01);
  }
  return sticker;
}

/** @deprecated Prefer minimumAccountingSafeStickerPrice for floors. */
function minimumMarginPrice(unitCost, minMarginPct, taxChargeable = DEFAULT_TAX_CHARGEABLE) {
  return minimumAccountingSafeStickerPrice(unitCost, minMarginPct, taxChargeable);
}

/**
 * Combined advisory floor: never below unit cost; never below accounting min GM sticker.
 */
function accountingSafeFloorPrice(
  unitCost,
  minMarginPct,
  taxChargeable = DEFAULT_TAX_CHARGEABLE
) {
  const cost = Number(unitCost);
  if (!Number.isFinite(cost) || cost < 0) return null;
  const acct = minimumAccountingSafeStickerPrice(cost, minMarginPct, taxChargeable);
  return round2(Math.max(cost, acct == null ? cost : acct));
}

function maximumSafeDiscountPct(currentPrice, floorPrice) {
  const price = Number(currentPrice);
  const floor = Number(floorPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(floor) || floor < 0) return null;
  if (floor >= price) return 0;
  return round2(((price - floor) / price) * 100);
}

function scenarioEconomics(sellingPrice, unitCost, taxChargeable = DEFAULT_TAX_CHARGEABLE) {
  const selling = Number(sellingPrice);
  const costOk = Number.isFinite(Number(unitCost)) ? Number(unitCost) : null;
  if (!Number.isFinite(selling) || selling <= 0) {
    return {
      commercial_sticker_gp: null,
      commercial_sticker_gm_pct: null,
      accounting_gp_ex_tax: null,
      accounting_gm_ex_tax_pct: null,
      price_ex_tax: null,
    };
  }
  const commercialGp = costOk == null ? null : round2(selling - costOk);
  const commercialGm =
    commercialGp == null ? null : round2((commercialGp / selling) * 100);
  const { revenueExTax } = splitInclusiveTax(selling, taxChargeable);
  const accountingGp =
    costOk == null ? null : round2(revenueExTax - costOk);
  const accountingGm =
    accountingGp == null || !(revenueExTax > 0)
      ? null
      : round2((accountingGp / revenueExTax) * 100);
  return {
    commercial_sticker_gp: commercialGp,
    commercial_sticker_gm_pct: commercialGm,
    accounting_gp_ex_tax: accountingGp,
    accounting_gm_ex_tax_pct: accountingGm,
    price_ex_tax: revenueExTax,
  };
}

/**
 * Simulate one discount scenario.
 * Commercial GP volume multiplier uses sticker GP (lift intuition).
 * Accounting fields expose ex-tax margin safety.
 */
function simulateDiscount(
  currentPrice,
  unitCost,
  discountPct,
  taxChargeable = DEFAULT_TAX_CHARGEABLE
) {
  const price = Number(currentPrice);
  const cost = Number(unitCost);
  const d = Number(discountPct);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(d) || d < 0) return null;

  const selling = round2(price * (1 - d / 100));
  const costOk = Number.isFinite(cost) ? cost : null;
  const currentCommercialGp = costOk == null ? null : round2(price - costOk);
  const econ = scenarioEconomics(selling, costOk, taxChargeable);
  const unitGp = econ.commercial_sticker_gp;
  const unitGm = econ.commercial_sticker_gm_pct;

  let unitsToMatchRevenue = null;
  let unitsToMatchGp = null;
  if (selling > 0) {
    unitsToMatchRevenue = round2(price / selling);
  }
  if (unitGp != null && unitGp > 0 && currentCommercialGp != null && currentCommercialGp > 0) {
    unitsToMatchGp = round2(currentCommercialGp / unitGp);
  } else if (unitGp != null && unitGp <= 0) {
    unitsToMatchGp = null;
  }

  return {
    discount_pct: d,
    selling_price: selling,
    unit_cost: costOk == null ? null : round2(costOk),
    unit_gp: unitGp,
    unit_gm_pct: unitGm,
    commercial_sticker_gp: econ.commercial_sticker_gp,
    commercial_sticker_gm_pct: econ.commercial_sticker_gm_pct,
    price_ex_tax: econ.price_ex_tax,
    accounting_gp_ex_tax: econ.accounting_gp_ex_tax,
    accounting_gm_ex_tax_pct: econ.accounting_gm_ex_tax_pct,
    units_required_to_match_current_revenue: unitsToMatchRevenue,
    units_required_to_match_current_gp: unitsToMatchGp,
    below_cost: costOk != null && selling < costOk,
  };
}

function simulateIncrease(
  currentPrice,
  unitCost,
  increasePct,
  taxChargeable = DEFAULT_TAX_CHARGEABLE
) {
  const price = Number(currentPrice);
  const cost = Number(unitCost);
  const inc = Number(increasePct);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(inc) || inc < 0) return null;
  const selling = round2(price * (1 + inc / 100));
  const costOk = Number.isFinite(cost) ? cost : null;
  const currentGp = costOk == null ? null : round2(price - costOk);
  const econ = scenarioEconomics(selling, costOk, taxChargeable);
  const unitGp = econ.commercial_sticker_gp;
  const gpUplift =
    currentGp == null || unitGp == null ? null : round2(unitGp - currentGp);
  return {
    increase_pct: inc,
    selling_price: selling,
    unit_gp: unitGp,
    unit_gm_pct: econ.commercial_sticker_gm_pct,
    commercial_sticker_gp: econ.commercial_sticker_gp,
    commercial_sticker_gm_pct: econ.commercial_sticker_gm_pct,
    accounting_gp_ex_tax: econ.accounting_gp_ex_tax,
    accounting_gm_ex_tax_pct: econ.accounting_gm_ex_tax_pct,
    gp_uplift_per_unit: gpUplift,
    label: "PRICE INCREASE TEST CANDIDATE",
  };
}

function isDiscountAccountingSafe(
  currentPrice,
  unitCost,
  discountPct,
  minMarginPct,
  taxChargeable = DEFAULT_TAX_CHARGEABLE
) {
  const sim = simulateDiscount(currentPrice, unitCost, discountPct, taxChargeable);
  if (!sim || sim.below_cost) return false;
  const floor = accountingSafeFloorPrice(unitCost, minMarginPct, taxChargeable);
  if (floor != null && sim.selling_price + 1e-9 < floor) return false;
  const gm = sim.accounting_gm_ex_tax_pct;
  if (gm == null || gm + 1e-9 < Number(minMarginPct)) return false;
  return true;
}

function buildSimulationLadder(
  currentPrice,
  unitCost,
  thresholds,
  taxChargeable = DEFAULT_TAX_CHARGEABLE
) {
  const t = resolvePricingThresholds(thresholds);
  return (t.discount_steps || [])
    .map((d) => simulateDiscount(currentPrice, unitCost, d, taxChargeable))
    .filter(Boolean)
    .map((sim) => ({
      ...sim,
      accounting_floor_ok: isDiscountAccountingSafe(
        currentPrice,
        unitCost,
        sim.discount_pct,
        t.min_gross_margin_pct,
        taxChargeable
      ),
    }));
}

module.exports = {
  DEFAULT_TAX_CHARGEABLE,
  unitEconomics,
  minimumCommercialMarginPrice,
  minimumAccountingSafeStickerPrice,
  accountingSafeFloorPrice,
  minimumMarginPrice,
  maximumSafeDiscountPct,
  simulateDiscount,
  simulateIncrease,
  isDiscountAccountingSafe,
  buildSimulationLadder,
  scenarioEconomics,
};
