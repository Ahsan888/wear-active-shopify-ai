/**
 * Clearance maturity — do not treat every NO_DEMAND SKU as a full 90d opportunity.
 *
 * Prefer variant createdAt when newer than product publish/create (variant
 * could not sell before it existed). Conservative when dates are missing.
 */
const CLEARANCE_MATURITY_DAYS = 90;

function parseIsoDate(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function daysBetween(fromDate, asOfDate) {
  const from = fromDate instanceof Date ? fromDate : parseIsoDate(fromDate);
  const asOf = asOfDate instanceof Date ? asOfDate : parseIsoDate(asOfDate);
  if (!from || !asOf) return null;
  const ms = asOf.getTime() - from.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 86400000);
}

/**
 * @param {object} dates
 * @param {string|null} [dates.variant_created_at]
 * @param {string|null} [dates.product_published_at]
 * @param {string|null} [dates.product_created_at]
 * @param {string|Date} asOf - usually report until date
 * @param {number} [minDays=90]
 */
function resolveClearanceMaturity(dates = {}, asOf, minDays = CLEARANCE_MATURITY_DAYS) {
  const variantCreated = parseIsoDate(dates.variant_created_at);
  const productPublished = parseIsoDate(dates.product_published_at);
  const productCreated = parseIsoDate(dates.product_created_at);

  let sellableFrom = null;
  let source = "unknown";

  if (productPublished) {
    sellableFrom = productPublished;
    source = "product_published_at";
  } else if (productCreated) {
    sellableFrom = productCreated;
    source = "product_created_at";
  }

  if (variantCreated) {
    if (!sellableFrom || variantCreated > sellableFrom) {
      sellableFrom = variantCreated;
      source = "variant_created_at";
    }
  }

  if (!sellableFrom) {
    return {
      selling_age_days: null,
      clearance_mature: false,
      clearance_maturity_source: "unknown",
      immature_for_clearance: true,
      sellable_from: null,
    };
  }

  const age = daysBetween(sellableFrom, asOf || new Date());
  if (age == null || age < 0) {
    return {
      selling_age_days: age,
      clearance_mature: false,
      clearance_maturity_source: source,
      immature_for_clearance: true,
      sellable_from: sellableFrom.toISOString(),
    };
  }

  const mature = age >= minDays;
  return {
    selling_age_days: age,
    clearance_mature: mature,
    clearance_maturity_source: source,
    immature_for_clearance: !mature,
    sellable_from: sellableFrom.toISOString(),
  };
}

module.exports = {
  CLEARANCE_MATURITY_DAYS,
  resolveClearanceMaturity,
  daysBetween,
  parseIsoDate,
};
