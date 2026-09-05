/**
 * Deterministic business-health classification (Meta-adjusted Books economics).
 */
const { BUSINESS } = require("./thresholds");

/**
 * @param {object} input
 * @param {number} input.meta_adjusted_profit
 * @param {number|null} input.meta_adjusted_margin_pct
 * @param {number|null} input.gross_margin_pct
 * @param {number} input.recognized_orders
 * @param {number} input.net_revenue_ex_tax
 */
function classifyBusinessHealth(input = {}) {
  const meta_adjusted_profit = Number(input.meta_adjusted_profit || 0);
  const mam =
    input.meta_adjusted_margin_pct == null
      ? null
      : Number(input.meta_adjusted_margin_pct);
  const gm =
    input.gross_margin_pct == null ? null : Number(input.gross_margin_pct);
  const orders = Number(input.recognized_orders || 0);
  const net = Number(input.net_revenue_ex_tax || 0);

  const evidence = {
    meta_adjusted_profit,
    meta_adjusted_margin_pct: mam,
    gross_margin_pct: gm,
    recognized_orders: orders,
    net_revenue_ex_tax: net,
  };

  if (orders < BUSINESS.MIN_ORDERS_INSUFFICIENT || net <= 0) {
    return {
      status: "insufficient_data",
      reason_code: "insufficient_orders_or_revenue",
      reason:
        orders < BUSINESS.MIN_ORDERS_INSUFFICIENT
          ? `Recognized orders (${orders}) below minimum ${BUSINESS.MIN_ORDERS_INSUFFICIENT}`
          : "Net revenue ex-tax is non-positive",
      evidence,
    };
  }

  if (meta_adjusted_profit < 0) {
    return {
      status: "unprofitable",
      reason_code: "meta_adjusted_profit_negative",
      reason: "Meta-adjusted profit is negative for the period",
      evidence,
    };
  }

  // strongly_profitable before profitable
  if (
    mam != null &&
    mam >= BUSINESS.META_ADJ_MARGIN_STRONG_GTE &&
    gm != null &&
    gm >= BUSINESS.GROSS_MARGIN_STRONG_GTE &&
    orders >= BUSINESS.MIN_ORDERS_STRONG
  ) {
    return {
      status: "strongly_profitable",
      reason_code: "strong_margins_and_volume",
      reason: `Meta-adjusted margin ${mam}% ≥ ${BUSINESS.META_ADJ_MARGIN_STRONG_GTE}%, gross margin ${gm}% ≥ ${BUSINESS.GROSS_MARGIN_STRONG_GTE}%, orders ${orders}`,
      evidence,
    };
  }

  if (
    mam != null &&
    mam >= BUSINESS.META_ADJ_MARGIN_PROFITABLE_GTE &&
    gm != null &&
    gm >= BUSINESS.GROSS_MARGIN_PROFITABLE_GTE &&
    orders >= BUSINESS.MIN_ORDERS_PROFITABLE
  ) {
    return {
      status: "profitable",
      reason_code: "profitable_margins",
      reason: `Meta-adjusted margin ${mam}% ≥ ${BUSINESS.META_ADJ_MARGIN_PROFITABLE_GTE}%, gross margin ${gm}% ≥ ${BUSINESS.GROSS_MARGIN_PROFITABLE_GTE}%`,
      evidence,
    };
  }

  if (mam != null && mam < BUSINESS.META_ADJ_MARGIN_BREAK_EVEN_LT) {
    return {
      status: "break_even",
      reason_code: "meta_adjusted_margin_near_zero",
      reason: `Meta-adjusted margin ${mam}% < ${BUSINESS.META_ADJ_MARGIN_BREAK_EVEN_LT}%`,
      evidence,
    };
  }

  if (
    mam != null &&
    mam >= BUSINESS.META_ADJ_MARGIN_BREAK_EVEN_LT &&
    mam < BUSINESS.META_ADJ_MARGIN_THIN_LT
  ) {
    return {
      status: "thin_margin",
      reason_code: "thin_meta_adjusted_margin",
      reason: `Meta-adjusted margin ${mam}% is thin (< ${BUSINESS.META_ADJ_MARGIN_THIN_LT}%)`,
      evidence,
    };
  }

  // Positive profit but didn't clear profitable thresholds (e.g. GM soft)
  return {
    status: "thin_margin",
    reason_code: "positive_but_below_profitable_thresholds",
    reason:
      "Meta-adjusted profit positive but margin/order/gross-margin thresholds for profitable not fully met",
    evidence,
  };
}

function isBusinessProfitableEnoughForScale(status) {
  return status === "profitable" || status === "strongly_profitable";
}

module.exports = {
  classifyBusinessHealth,
  isBusinessProfitableEnoughForScale,
};
