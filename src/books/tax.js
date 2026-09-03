/** Tax helpers — prices are tax-inclusive; 18% only on courier. */

const TAX_RATE = 0.18;
const TAX_DIVISOR = 1 + TAX_RATE; // 1.18

function parseMoney(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * @param {number} grossInclusive
 * @param {boolean} taxChargeable
 */
function splitInclusiveTax(grossInclusive, taxChargeable) {
  const gross = parseMoney(grossInclusive);
  if (!taxChargeable || !(gross > 0)) {
    return { gross, taxAmount: 0, revenueExTax: round2(gross) };
  }
  const taxAmount = round2(gross * (TAX_RATE / TAX_DIVISOR));
  const revenueExTax = round2(gross - taxAmount);
  return { gross, taxAmount, revenueExTax };
}

function deliveryModeFromTags(tags) {
  const list = Array.isArray(tags)
    ? tags.map((t) => String(t).toLowerCase().trim())
    : String(tags || "")
        .split(",")
        .map((t) => t.toLowerCase().trim())
        .filter(Boolean);

  if (list.includes("wa:hold")) return { mode: "hold", taxChargeable: false, hold: true };
  if (list.includes("delivery:walkin") || list.includes("delivery:walk-in")) {
    return { mode: "walkin", taxChargeable: false, hold: false };
  }
  if (list.includes("delivery:self")) {
    return { mode: "self", taxChargeable: false, hold: false };
  }
  if (list.includes("delivery:courier")) {
    return { mode: "courier", taxChargeable: true, hold: false };
  }
  // Default: courier / taxable (website orders)
  return { mode: "courier", taxChargeable: true, hold: false };
}

function hasTag(tags, needle) {
  const list = Array.isArray(tags)
    ? tags.map((t) => String(t).toLowerCase().trim())
    : String(tags || "")
        .split(",")
        .map((t) => t.toLowerCase().trim());
  return list.includes(String(needle).toLowerCase());
}

module.exports = {
  TAX_RATE,
  parseMoney,
  round2,
  splitInclusiveTax,
  deliveryModeFromTags,
  hasTag,
};
