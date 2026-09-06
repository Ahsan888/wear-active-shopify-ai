/**
 * Metric dictionary / registry — display names, definitions, provenance.
 * Presentation layer only; does not recompute accounting formulas.
 */
const SOURCE = {
  META: "META",
  SHOPIFY: "SHOPIFY",
  BOOKS: "BOOKS",
  FIRST_PARTY: "FIRST-PARTY",
  CALCULATED: "CALCULATED",
  FORECAST: "FORECAST",
};

/**
 * @typedef {object} MetricDef
 * @property {string} id
 * @property {string} display_name
 * @property {string} plain_english
 * @property {string} source
 * @property {string} [period]
 * @property {string} [interpretation]
 * @property {string} [formula]
 * @property {string} [caveat]
 * @property {string} [units]
 * @property {boolean} [tax_ex]
 */

/** @type {Record<string, MetricDef>} */
const METRICS = {
  meta_cpa: {
    id: "meta_cpa",
    display_name: "Meta cost per purchase (CPA)",
    plain_english:
      "What Meta says we paid in advertising for each purchase it attributes to ads.",
    source: SOURCE.META,
    formula: "Meta spend ÷ Meta-attributed purchases",
    interpretation: "Platform performance only — not business affordability.",
    caveat: "Must NOT be compared to Books break-even CPA for affordability.",
    units: "PKR / purchase",
  },
  meta_roas: {
    id: "meta_roas",
    display_name: "Meta return on ad spend (ROAS)",
    plain_english: "Purchase value Meta reports for each rupee of ad spend.",
    source: SOURCE.META,
    formula: "Meta purchase value ÷ Meta spend",
    caveat: "Meta-reported; not Books recognized revenue.",
    units: "ratio",
  },
  meta_spend: {
    id: "meta_spend",
    display_name: "Meta advertising spend",
    plain_english: "How much we spent on Meta ads in this period.",
    source: SOURCE.META,
    units: "PKR",
  },
  business_ad_load: {
    id: "business_ad_load",
    display_name: "Ad spend per recognized sale",
    plain_english:
      "How much Meta advertising spend we incurred for every sale recognized in our books.",
    source: SOURCE.CALCULATED,
    formula: "Meta spend ÷ Books recognized orders (all channels)",
    interpretation: "Business affordability input — same denominator as break-even CPA.",
    caveat: "Not Meta-attributed CAC. Includes Shopify, Manual, and Other Sales orders.",
    units: "PKR / order",
  },
  break_even_cpa: {
    id: "break_even_cpa",
    display_name: "Break-even ad cost per sale",
    plain_english:
      "How much we could spend on ads per recognized sale before using up the business's pre-ad profit.",
    source: SOURCE.CALCULATED,
    formula: "Profit before ads ÷ Books recognized orders",
    interpretation: "Business-wide safety threshold.",
    caveat: "Not Meta-attributed CPA. Do not compare Meta CPA to this for affordability.",
    units: "PKR / order",
  },
  meta_adjusted_profit: {
    id: "meta_adjusted_profit",
    display_name: "Profit after actual Meta spend",
    plain_english:
      "Books profit with booked Ads replaced by actual Meta spend for this period (not double-counted).",
    source: SOURCE.CALCULATED,
    formula: "Books net profit + booked Ads − Meta spend",
    units: "PKR",
    tax_ex: true,
  },
  books_net_profit: {
    id: "books_net_profit",
    display_name: "Books net profit",
    plain_english: "Accounting profit using booked Ledger expenses (including booked Ads).",
    source: SOURCE.BOOKS,
    units: "PKR",
    tax_ex: true,
  },
  net_revenue: {
    id: "net_revenue",
    display_name: "Recognized net revenue",
    plain_english: "Sales revenue recognized in Books after tax treatment and refunds.",
    source: SOURCE.BOOKS,
    units: "PKR",
    tax_ex: true,
  },
  gross_profit: {
    id: "gross_profit",
    display_name: "Gross profit",
    plain_english: "Revenue left after product cost (COGS), before operating expenses.",
    source: SOURCE.BOOKS,
    formula: "Net revenue − COGS",
    units: "PKR",
    tax_ex: true,
  },
  gross_margin: {
    id: "gross_margin",
    display_name: "Gross margin",
    plain_english: "Share of revenue left after product cost, before operating expenses.",
    source: SOURCE.BOOKS,
    formula: "Gross profit ÷ net revenue",
    units: "%",
  },
  recognized_orders: {
    id: "recognized_orders",
    display_name: "Recognized orders",
    plain_english: "Orders that satisfy Books recognition rules (counted in accounting).",
    source: SOURCE.BOOKS,
    units: "count",
  },
  shopify_contribution: {
    id: "shopify_contribution",
    display_name: "Shopify contribution after Meta",
    plain_english:
      "Shopify net revenue minus Shopify COGS minus date-aligned Meta spend. Shared overhead is not allocated.",
    source: SOURCE.CALCULATED,
    caveat: "Not Meta-attributed profit. DATE-ALIGNED · NOT ATTRIBUTED.",
    units: "PKR",
    tax_ex: true,
  },
  aov: {
    id: "aov",
    display_name: "Average order value (AOV)",
    plain_english: "Average recognized net revenue per recognized order.",
    source: SOURCE.BOOKS,
    formula: "Net revenue ÷ recognized orders",
    units: "PKR",
    tax_ex: true,
  },
  cogs: {
    id: "cogs",
    display_name: "Cost of goods (COGS)",
    plain_english: "Product cost of items sold, from Variant Master / Ledger.",
    source: SOURCE.BOOKS,
    units: "PKR",
  },
  ctr: {
    id: "ctr",
    display_name: "Click-through rate (CTR)",
    plain_english: "Share of ad impressions that resulted in a click.",
    source: SOURCE.META,
    formula: "Clicks ÷ impressions",
    units: "%",
  },
  cpc: {
    id: "cpc",
    display_name: "Cost per click (CPC)",
    plain_english: "Average Meta spend for each click.",
    source: SOURCE.META,
    units: "PKR",
  },
  cpm: {
    id: "cpm",
    display_name: "Cost per 1,000 impressions (CPM)",
    plain_english: "Average Meta spend to show the ad one thousand times.",
    source: SOURCE.META,
    units: "PKR",
  },
  mer: {
    id: "mer",
    display_name: "Marketing efficiency ratio (MER)",
    plain_english: "Total recognized Books revenue per rupee of Meta spend.",
    source: SOURCE.CALCULATED,
    formula: "Books net revenue ÷ Meta spend",
    caveat: "Not Meta-attributed ROAS.",
    units: "ratio",
  },
  attribution_coverage: {
    id: "attribution_coverage",
    display_name: "First-party attribution coverage",
    plain_english:
      "Share of post-capture recognized Shopify orders we can link to Meta with first-party evidence.",
    source: SOURCE.FIRST_PARTY,
    caveat: "Immature while capture is new. Never treat Meta-reported purchases as FP-verified.",
    units: "%",
  },
  repeat_rate: {
    id: "repeat_rate",
    display_name: "Repeat purchase rate",
    plain_english: "Share of customers in the period who bought more than once (observed history).",
    source: SOURCE.CALCULATED,
    caveat: "Not predictive LTV.",
    units: "%",
  },
  inventory_capital_at_risk: {
    id: "inventory_capital_at_risk",
    display_name: "Inventory capital at risk",
    plain_english: "Product cost tied up in dead/slow and overstock inventory classes.",
    source: SOURCE.CALCULATED,
    units: "PKR",
  },
  forecast_revenue: {
    id: "forecast_revenue",
    display_name: "Forecast revenue",
    plain_english: "Projected recognized revenue — not an actual Books figure.",
    source: SOURCE.FORECAST,
    caveat: "FORECAST — NOT ACTUAL. Deterministic pace projection.",
    units: "PKR",
    tax_ex: true,
  },
};

function getMetric(id) {
  return METRICS[id] || null;
}

function tipText(id) {
  const m = METRICS[id];
  if (!m) return "";
  const parts = [m.plain_english];
  if (m.formula) parts.push(`Formula: ${m.formula}`);
  if (m.caveat) parts.push(m.caveat);
  return parts.join(" ");
}

function sourceBadge(source) {
  const s = String(source || "").toUpperCase();
  const known = Object.values(SOURCE);
  const label = known.includes(s) ? s : "CALCULATED";
  return label;
}

/** Expand TIPS from registry for dashboard tip() helper. */
function tipsFromRegistry() {
  const out = {};
  for (const [id, m] of Object.entries(METRICS)) {
    out[id] = tipText(id);
  }
  return out;
}

module.exports = {
  SOURCE,
  METRICS,
  getMetric,
  tipText,
  sourceBadge,
  tipsFromRegistry,
};
