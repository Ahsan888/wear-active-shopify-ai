/**
 * Confidence scoring + accounting / data-quality gates.
 */
const { CONFIDENCE_RANK, GATES } = require("./thresholds");

function minConfidence(a, b) {
  const ra = CONFIDENCE_RANK[a] ?? 0;
  const rb = CONFIDENCE_RANK[b] ?? 0;
  return ra <= rb ? a : b;
}

/**
 * @param {object} ctx
 * @param {object[]} ctx.warnings Phase 2 data_quality warnings
 * @param {object} ctx.ad_reconciliation
 * @param {object} ctx.books
 * @param {boolean} ctx.is_full_calendar_month
 * @param {number} ctx.meta_spend
 */
function buildConfidenceAndGates(ctx = {}) {
  const warnings = ctx.warnings || [];
  const codes = new Set(warnings.map((w) => w.code));
  const recon = ctx.ad_reconciliation || {};
  const books = ctx.books || {};
  const orders = Number(books.recognized_orders || 0);
  const metaSpend = Number(ctx.meta_spend || 0);

  const hasDuplicate = codes.has("possible_duplicate_ledger_expense");
  const variancePct = Math.abs(
    Number(recon.meta_vs_ledger_variance_pct || 0)
  );
  const severeVariance =
    ctx.is_full_calendar_month &&
    variancePct > GATES.META_LEDGER_VARIANCE_PCT_SEVERE;

  let business = "high";
  let advertising = "high";
  let entities = "medium"; // Meta attribution is always platform-reported
  let products = "high";

  const gates_applied = [];

  if (orders < 3) {
    business = minConfidence(business, "low");
    advertising = minConfidence(advertising, "low");
    gates_applied.push({
      code: "low_order_sample",
      effect: "downgrade_business_advertising_confidence",
    });
  } else if (orders < 10) {
    business = minConfidence(business, "medium");
  }

  if (hasDuplicate) {
    business = minConfidence(business, "medium");
    gates_applied.push({
      code: "possible_duplicate_ledger_expense",
      effect: "cap_business_confidence_medium_suppress_scale",
    });
  }

  if (severeVariance) {
    advertising = minConfidence(advertising, "medium");
    gates_applied.push({
      code: "severe_meta_ledger_ads_variance",
      effect: "cap_advertising_confidence_medium",
      variance_pct: variancePct,
    });
  }

  if (!(metaSpend > 0)) {
    advertising = minConfidence(advertising, "low");
    entities = "low";
    gates_applied.push({
      code: "zero_meta_spend",
      effect: "meta_efficiency_insufficient",
    });
  }

  const productDataIssues = warnings.filter(
    (w) =>
      w.code === "sku_missing_from_variant_master" ||
      w.code === "missing_cost_per_item"
  );
  if (productDataIssues.length) {
    products = minConfidence(products, "medium");
  }

  const suppress_scale =
    hasDuplicate ||
    CONFIDENCE_RANK[business] < CONFIDENCE_RANK.medium ||
    CONFIDENCE_RANK[advertising] < CONFIDENCE_RANK.medium;

  const confidence_ok_for_scale =
    !suppress_scale &&
    CONFIDENCE_RANK[entities] >= CONFIDENCE_RANK[GATES.MIN_CONFIDENCE_FOR_SCALE] &&
    CONFIDENCE_RANK[business] >= CONFIDENCE_RANK[GATES.MIN_CONFIDENCE_FOR_SCALE] &&
    CONFIDENCE_RANK[advertising] >=
      CONFIDENCE_RANK[GATES.MIN_CONFIDENCE_FOR_SCALE];

  return {
    confidence: {
      business,
      advertising,
      entities,
      products,
      attribution: "unavailable",
      no_order_level_attribution: true,
      notes: {
        attribution:
          "Meta→Shopify order attribution, product Meta ROAS, and campaign accounting profit are unavailable",
        entities:
          "Meta entity recommendations are medium confidence (platform-reported attribution)",
      },
    },
    gates: {
      has_duplicate_ledger_expense: hasDuplicate,
      severe_meta_ledger_variance: severeVariance,
      suppress_scale,
      confidence_ok_for_scale,
      gates_applied,
    },
  };
}

function productRecommendationConfidence(productStatus, baseProductsConfidence) {
  if (productStatus === "data_issue") return "low";
  return baseProductsConfidence || "medium";
}

module.exports = {
  buildConfidenceAndGates,
  minConfidence,
  productRecommendationConfidence,
};
