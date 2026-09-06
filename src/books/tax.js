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

/**
 * Reverse of splitInclusiveTax — convert ex-tax revenue to tax-inclusive sticker.
 * Uses the same TAX_RATE / TAX_DIVISOR (do not invent a second rate).
 */
function inclusiveFromExTax(revenueExTax, taxChargeable) {
  const ex = parseMoney(revenueExTax);
  if (!(ex > 0)) return round2(ex);
  if (!taxChargeable) return round2(ex);
  return round2(ex * TAX_DIVISOR);
}

function deliveryModeFromTags(tags) {
  const list = Array.isArray(tags)
    ? tags.map((t) => String(t).toLowerCase().trim())
    : String(tags || "")
        .split(",")
        .map((t) => t.toLowerCase().trim())
        .filter(Boolean);

  if (list.includes("wa:hold")) return { mode: "hold", taxChargeable: false, hold: true };
  if (
    list.includes("wa:gift") ||
    list.includes("wa:pr") ||
    list.includes("delivery:gift")
  ) {
    return { mode: "gift", taxChargeable: false, hold: false };
  }
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

/** Other Sales / LIVE checkbox or Y/N/TRUE cell. */
function isTaxChargeableFlag(value) {
  if (value === true || value === 1) return true;
  const s = String(value ?? "")
    .trim()
    .toUpperCase();
  return s === "Y" || s === "YES" || s === "TRUE" || s === "CHECKED";
}

/** Normalize sheet date → yyyy-mm-dd (matches Apps Script OTHER: keys). */
function dateKey(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && value > 20000) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  if (value instanceof Date && !isNaN(value)) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

module.exports = {
  TAX_RATE,
  TAX_DIVISOR,
  parseMoney,
  round2,
  splitInclusiveTax,
  inclusiveFromExTax,
  deliveryModeFromTags,
  hasTag,
  isTaxChargeableFlag,
  dateKey,
};
