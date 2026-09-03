/** Recognition: when a LIVE Shopify line may post to Ledger. */

const { deliveryModeFromTags, hasTag } = require("./tax");

function normStatus(v) {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

/**
 * @param {object} opts
 * @param {string} opts.fulfillmentStatus
 * @param {string} opts.paymentStatus
 * @param {string|string[]} opts.tags
 * @param {string} [opts.deliveryMode] — if already known
 */
function isRecognized({
  fulfillmentStatus,
  paymentStatus,
  tags,
  deliveryMode,
}) {
  if (hasTag(tags, "wa:hold")) {
    return { recognized: false, reason: "wa:hold" };
  }
  if (hasTag(tags, "wa:recognized")) {
    return { recognized: true, reason: "wa:recognized" };
  }

  const pay = normStatus(paymentStatus);
  const fulfill = normStatus(fulfillmentStatus);

  if (
    ["cancelled", "canceled", "voided", "refunded"].includes(pay) ||
    ["cancelled", "canceled"].includes(fulfill)
  ) {
    return { recognized: false, reason: "cancelled_or_refunded" };
  }

  const modeInfo = deliveryMode
    ? {
        mode: deliveryMode,
        taxChargeable: !["walkin", "self"].includes(deliveryMode),
      }
    : deliveryModeFromTags(tags);

  const paid = ["paid", "partially_paid", "partially paid"].includes(pay);
  const fulfilled = ["fulfilled", "delivered"].includes(fulfill);

  // Walk-in / self: paid is enough (cash/JazzCash in hand)
  if (
    (modeInfo.mode === "walkin" || modeInfo.mode === "self") &&
    paid
  ) {
    return { recognized: true, reason: `${modeInfo.mode}_paid` };
  }

  // Courier / default: need fulfilled + paid
  if (fulfilled && paid) {
    return { recognized: true, reason: "fulfilled_paid" };
  }

  if (!paid) return { recognized: false, reason: "payment_pending" };
  if (!fulfilled) return { recognized: false, reason: "unfulfilled" };
  return { recognized: false, reason: "unknown" };
}

module.exports = { isRecognized, normStatus };
