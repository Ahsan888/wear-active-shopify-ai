/**
 * SKU demand from recognized Ledger Sale units (paid only — gifts excluded).
 */
const { round2 } = require("../books/tax");
const { addDaysYmd, assertYmd } = require("../operations/dates");
const { aggregateLedgerPeriod } = require("../profitability/books");

function windowEnding(until, days) {
  const u = assertYmd(until, "until");
  const since = addDaysYmd(u, -(Number(days) - 1));
  return { since, until: u, days: Number(days) };
}

/**
 * Map SKU → { units, revenue_ex_tax, cogs, gross_profit, product }
 * from a ledger aggregate products array.
 */
function productsToSkuMap(products = []) {
  const map = new Map();
  for (const p of products || []) {
    const sku = String(p.sku || "").trim();
    if (!sku) continue;
    const units = Number(p.units) || 0;
    const revenue = Number(p.revenue_ex_tax) || 0;
    const cogs = Number(p.cogs) || 0;
    map.set(sku, {
      sku,
      product: p.product || null,
      units,
      revenue_ex_tax: round2(revenue),
      cogs: round2(cogs),
      gross_profit: round2(revenue - cogs),
      gross_margin_pct:
        revenue > 0 ? round2(((revenue - cogs) / revenue) * 100) : null,
    });
  }
  return map;
}

/**
 * Build 7d / 14d / 30d demand maps ending on `until`.
 *
 * @param {object[]} ledgerRows
 * @param {string[]} ledgerHeader
 * @param {string} until YYYY-MM-DD
 * @param {object} catalogBySku Variant Master bySku
 */
function buildDemandWindows(ledgerRows, ledgerHeader, until, catalogBySku = {}) {
  const u = assertYmd(until, "until");
  const windows = {
    d7: windowEnding(u, 7),
    d14: windowEnding(u, 14),
    d30: windowEnding(u, 30),
  };

  function agg(w) {
    const a = aggregateLedgerPeriod(
      ledgerRows,
      ledgerHeader,
      w.since,
      w.until,
      catalogBySku
    );
    return productsToSkuMap(a.products);
  }

  return {
    until: u,
    windows,
    demand_7d: agg(windows.d7),
    demand_14d: agg(windows.d14),
    demand_30d: agg(windows.d30),
  };
}

function demandForSku(demandWindows, sku) {
  const key = String(sku || "").trim();
  const d7 = demandWindows.demand_7d.get(key);
  const d14 = demandWindows.demand_14d.get(key);
  const d30 = demandWindows.demand_30d.get(key);
  return {
    product: d30?.product || d14?.product || d7?.product || null,
    units_sold_7d: d7?.units || 0,
    units_sold_14d: d14?.units || 0,
    units_sold_30d: d30?.units || 0,
    revenue_30d: d30?.revenue_ex_tax || 0,
    cogs_30d: d30?.cogs || 0,
    gross_profit_30d: d30?.gross_profit || 0,
    gross_margin_pct: d30?.gross_margin_pct ?? null,
  };
}

module.exports = {
  windowEnding,
  productsToSkuMap,
  buildDemandWindows,
  demandForSku,
};
