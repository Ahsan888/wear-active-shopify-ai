/**
 * Unified reporting bundle — assembles existing Phase 1–3.5 engines.
 * Presentation layer must not recompute accounting/business logic.
 */
const { buildDecisionReport } = require("../decisions/report");
const { groupProductsByName } = require("./groups");
const { round2 } = require("../books/tax");

/**
 * Annotate Meta entities for dashboard CPA semantics.
 * Purchasing: vs account CPA = entity CPA / account Meta CPA
 * Zero-purchase: CPA unavailable; show spend evidence vs account CPA
 */
function annotateEntityCpaEvidence(entity) {
  const purchases = Number(entity?.purchases || 0);
  if (purchases > 0) {
    return {
      ...entity,
      cpa_available: true,
      cpa_display: entity.meta_attributed_cpa,
      vs_account_label: "vs account CPA",
      vs_account_ratio:
        entity.entity_cpa_vs_account_ratio != null
          ? entity.entity_cpa_vs_account_ratio
          : null,
      spend_evidence_vs_account_cpa: entity.spend_vs_account_cpa,
    };
  }
  return {
    ...entity,
    cpa_available: false,
    cpa_display: null,
    vs_account_label: "Spend evidence vs account CPA",
    vs_account_ratio:
      entity.spend_vs_account_cpa != null ? entity.spend_vs_account_cpa : null,
    spend_evidence_vs_account_cpa: entity.spend_vs_account_cpa,
  };
}

function enrichProductGroups(products) {
  return groupProductsByName(products).map((g) => {
    const cogs = round2(
      g.skus.reduce((s, p) => s + Number(p.cogs || 0), 0)
    );
    const incomplete = g.skus.some(
      (p) =>
        p.status === "data_issue" ||
        p.reason_code === "missing_ledger_cogs" ||
        (Array.isArray(p.flags) &&
          p.flags.some((f) =>
            /missing_ledger_cogs|missing_cost|sku_missing/i.test(String(f))
          ))
    );
    const gp = round2(Number(g.gross_profit || 0));
    const rev = Number(g.revenue_ex_tax || 0);
    return {
      ...g,
      cogs,
      incomplete_cogs_coverage: incomplete,
      // Do not present authoritative GM when COGS coverage is incomplete
      gross_margin_pct: incomplete
        ? null
        : rev > 0
          ? round2((gp / rev) * 100)
          : null,
      aggregate_margin_note: incomplete
        ? "Aggregate margin incomplete — one or more SKUs have data issues / missing Ledger COGS"
        : null,
    };
  });
}

/**
 * Build a single unified reporting object from loaded decision inputs.
 * Does not mutate Ledger / Meta / Sheets.
 */
function buildUnifiedReportingBundle(inputs = {}) {
  const decisions = buildDecisionReport(inputs);
  const books = { ...(inputs.books || {}), ...(decisions.books || {}) };
  const profitability = {
    ...(inputs.profitability || {}),
    ...(decisions.profitability || {}),
  };

  const campaigns = (decisions.campaigns || []).map(annotateEntityCpaEvidence);
  const adsets = (decisions.adsets || []).map(annotateEntityCpaEvidence);
  const ads = (decisions.ads || []).map(annotateEntityCpaEvidence);

  return {
    generated_at: decisions.generated_at,
    title: "Wear Active — Reporting & Decision Intelligence",
    date_range: decisions.date_range,
    safety: {
      ...(decisions.safety || {}),
      advisory_only: true,
      mutations: "none",
      no_sheet_writes: true,
      no_meta_mutations: true,
      presentation_only: true,
    },
    executive_summary: decisions.executive_summary,
    business_health: decisions.business_health,
    business_advertising_safety: decisions.business_advertising_safety,
    shopify_context: decisions.shopify_context,
    sales_by_channel: decisions.sales_by_channel || inputs.sales_by_channel,
    sales_mix: decisions.sales_mix || inputs.sales_mix,
    revenue_concentration: decisions.revenue_concentration,
    meta_efficiency: decisions.meta_efficiency,
    roas_cross_provenance: decisions.roas_cross_provenance,
    meta: decisions.meta,
    books,
    profitability,
    blended: decisions.blended || inputs.blended,
    expense_by_category: inputs.expense_by_category || {},
    pipeline: inputs.pipeline || null,
    gift_product_costs: inputs.gift_product_costs || [],
    campaigns,
    adsets,
    ads,
    products: decisions.products,
    product_portfolio: decisions.product_portfolio,
    product_groups: enrichProductGroups(decisions.products || []),
    recommendations: decisions.recommendations,
    data_quality: decisions.data_quality,
    confidence: decisions.confidence,
    no_order_level_attribution: true,
    decisions: {
      business_health: decisions.business_health,
      business_advertising_safety: decisions.business_advertising_safety,
      shopify_context: decisions.shopify_context,
      meta_efficiency: decisions.meta_efficiency,
      recommendations: decisions.recommendations,
      confidence: decisions.confidence,
    },
    views: [
      "overview",
      "profitability",
      "sales",
      "products",
      "advertising",
      "decisions",
      "data-quality",
    ],
  };
}

/**
 * Strip anything that must never appear in embedded HTML JSON.
 * Report objects should never contain tokens; this is a safety net.
 */
function sanitizeBundleForEmbed(bundle) {
  const json = JSON.stringify(bundle);
  // Reject if obvious secret-looking patterns slip in
  const banned = [
    /EAA[A-Za-z0-9]+/,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
    /"access_token"\s*:/,
    /"private_key"\s*:/,
    /META_ACCESS_TOKEN\s*[:=]/,
    /SHOPIFY_ACCESS_TOKEN\s*[:=]/,
  ];
  for (const re of banned) {
    if (re.test(json)) {
      throw new Error(
        "Refusing to embed reporting JSON: possible secret material detected"
      );
    }
  }
  return bundle;
}

module.exports = {
  annotateEntityCpaEvidence,
  enrichProductGroups,
  buildUnifiedReportingBundle,
  sanitizeBundleForEmbed,
};
