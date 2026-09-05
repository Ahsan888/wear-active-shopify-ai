/**
 * Assemble decision intelligence report from Phase 1/2 inputs + classifiers.
 */
const { round2 } = require("../books/tax");
const {
  formatMoney,
  formatNumber,
  formatPct,
  formatRoas,
} = require("../meta/metrics");
const { classifyBusinessHealth, isBusinessProfitableEnoughForScale } = require("./business");
const {
  classifyBusinessAdvertisingSafety,
  buildMetaEfficiency,
  buildRoasCrossProvenanceDiagnostic,
  isBusinessAdsSafeForScale,
} = require("./advertising");
const {
  buildAccountFunnelBaselines,
  classifyMetaEntities,
} = require("./entities");
const { classifyProducts } = require("./products");
const { buildConfidenceAndGates } = require("./confidence");
const { buildRecommendations } = require("./recommendations");

/**
 * Pure assembly from already-loaded profitability + meta entity rows.
 */
function buildDecisionReport({
  date_range,
  books,
  profitability,
  blended,
  meta,
  products,
  warnings = [],
  ad_reconciliation = {},
  campaigns = [],
  ads = [],
  adsets = [],
} = {}) {
  const metaTotals = meta?.totals || {};
  const business_health = classifyBusinessHealth({
    meta_adjusted_profit: profitability?.meta_adjusted_profit,
    meta_adjusted_margin_pct: profitability?.meta_adjusted_margin_pct,
    gross_margin_pct: books?.gross_margin_pct,
    recognized_orders: books?.recognized_orders,
    net_revenue_ex_tax: books?.net_revenue_ex_tax,
  });

  const business_advertising_safety = classifyBusinessAdvertisingSafety({
    meta_spend: metaTotals.spend,
    recognized_orders: books?.recognized_orders,
    break_even_cpa: profitability?.break_even_cpa,
    break_even_ad_spend: profitability?.break_even_ad_spend,
    net_revenue_ex_tax: books?.net_revenue_ex_tax,
    blended_ad_cost_per_recognized_order:
      blended?.blended_ad_cost_per_recognized_order,
  });

  const meta_efficiency = buildMetaEfficiency(metaTotals);
  const roas_diagnostic = buildRoasCrossProvenanceDiagnostic({
    meta_roas: metaTotals.roas,
    break_even_roas: profitability?.break_even_roas,
    meta_adjusted_profit: profitability?.meta_adjusted_profit,
  });

  const { confidence, gates } = buildConfidenceAndGates({
    warnings,
    ad_reconciliation,
    books,
    is_full_calendar_month: Boolean(date_range?.is_full_calendar_month),
    meta_spend: metaTotals.spend,
  });

  const account_funnel_baselines = buildAccountFunnelBaselines(metaTotals);
  const entityOpts = {
    business_health_ok: isBusinessProfitableEnoughForScale(
      business_health.status
    ),
    business_ads_ok: isBusinessAdsSafeForScale(
      business_advertising_safety.status
    ),
    confidence_ok: gates.confidence_ok_for_scale,
    accounting_scale_ok: !gates.suppress_scale,
    account_funnel_baselines,
  };

  const classified_campaigns = classifyMetaEntities(
    campaigns,
    metaTotals,
    { ...entityOpts, entity_type: "campaign" }
  );
  const classified_ads = classifyMetaEntities(ads, metaTotals, {
    ...entityOpts,
    entity_type: "ad",
  });
  const classified_adsets = classifyMetaEntities(adsets, metaTotals, {
    ...entityOpts,
    entity_type: "adset",
  });

  const productResult = classifyProducts(products || []);

  const recommendations = buildRecommendations({
    business_health,
    business_advertising_safety,
    meta_efficiency,
    roas_diagnostic,
    campaigns: classified_campaigns,
    ads: classified_ads,
    productResult,
    confidence,
    gates,
    warnings,
  });

  const top_actions = recommendations
    .filter((r) => r.priority !== "info" || r.reason_code === "no_order_level_attribution")
    .slice(0, 8);

  const ads_needing_attention = classified_ads.filter((a) =>
    [
      "high_priority_spend_no_purchase",
      "spend_no_purchase",
      "high_cpa",
      "relatively_weak_cpa",
      "weak_funnel",
      "watch",
    ].includes(a.status)
  );
  const scale_candidates = [
    ...classified_ads,
    ...classified_campaigns,
  ].filter((e) => e.status === "scale_candidate");

  const one_liner = [
    `Business ${business_health.status}`,
    `ads safety ${business_advertising_safety.status}`,
    `Meta CPA ${
      meta_efficiency.meta_attributed_cpa == null
        ? "—"
        : round2(meta_efficiency.meta_attributed_cpa)
    } (attributed)`,
  ].join(" · ");

  return {
    generated_at: new Date().toISOString(),
    date_range,
    safety: {
      advisory_only: true,
      mutations: "none",
      no_sheet_writes: true,
      no_meta_mutations: true,
    },
    executive_summary: {
      business_status: business_health.status,
      business_advertising_safety_status: business_advertising_safety.status,
      meta_efficiency_status: meta_efficiency.status,
      one_liner,
      top_action_ids: top_actions.map((r) => r.id),
    },
    business_health,
    business_advertising_safety,
    meta_efficiency,
    roas_cross_provenance: roas_diagnostic,
    meta: {
      account: meta?.account || null,
      totals: metaTotals,
      funnel_baselines: account_funnel_baselines,
    },
    books: {
      net_revenue_ex_tax: books?.net_revenue_ex_tax,
      cogs: books?.cogs,
      gross_profit: books?.gross_profit,
      gross_margin_pct: books?.gross_margin_pct,
      books_net_profit: books?.books_net_profit,
      books_net_margin_pct: books?.books_net_margin_pct,
      recognized_orders: books?.recognized_orders,
      recognized_units: books?.recognized_units,
      gift_units: books?.gift_units,
      aov_ex_tax: books?.aov_ex_tax,
      ads_expense_booked: books?.ads_expense_booked,
    },
    profitability: {
      profit_before_ads: profitability?.profit_before_ads,
      meta_adjusted_profit: profitability?.meta_adjusted_profit,
      meta_adjusted_margin_pct: profitability?.meta_adjusted_margin_pct,
      break_even_ad_spend: profitability?.break_even_ad_spend,
      break_even_cpa: profitability?.break_even_cpa,
      break_even_roas: profitability?.break_even_roas,
      pre_ad_profit_margin: profitability?.pre_ad_profit_margin,
      meta_spend_treatment: profitability?.meta_spend_treatment,
    },
    blended,
    campaigns: classified_campaigns,
    adsets: classified_adsets,
    ads: classified_ads,
    products: productResult.products,
    product_portfolio: productResult.portfolio,
    recommendations,
    data_quality: {
      warnings,
      gates: gates.gates_applied,
      ad_reconciliation,
    },
    confidence: confidence,
    no_order_level_attribution: true,
  };
}

function printDecisionReport(report, { currency = "PKR" } = {}) {
  const cur = report.meta?.account?.currency || currency;
  const bh = report.business_health;
  const bas = report.business_advertising_safety;
  const me = report.meta_efficiency;
  const p = report.profitability;
  const books = report.books;

  console.log("WEAR ACTIVE — DECISION REPORT");
  console.log(
    `${report.date_range.since} → ${report.date_range.until} (${report.date_range.timezone || "Asia/Karachi"})` +
      (report.date_range.is_full_calendar_month
        ? "  [full calendar month]"
        : "  [partial period]")
  );
  console.log("Advisory only — no Meta mutations, no Sheet writes.");
  console.log("");

  console.log("BUSINESS");
  console.log(`  Health:                    ${String(bh.status).toUpperCase()}`);
  console.log(`  Meta-adjusted profit:      ${formatMoney(p.meta_adjusted_profit, cur)}`);
  console.log(`  Meta-adjusted margin:      ${formatPct(p.meta_adjusted_margin_pct)}`);
  console.log(`  Gross margin:              ${formatPct(books.gross_margin_pct)}`);
  console.log(`  Recognized orders:         ${formatNumber(books.recognized_orders, 0)}`);
  console.log(`  Reason:                    ${bh.reason}`);
  console.log("");

  console.log("BUSINESS ADVERTISING SAFETY  (Meta spend ÷ Books orders vs BE CPA)");
  console.log(`  Status:                    ${String(bas.status).toUpperCase()}`);
  console.log(`  Meta spend:                ${formatMoney(bas.meta_spend, cur)}`);
  console.log(
    `  Blended ad cost / order:   ${formatMoney(bas.blended_ad_cost_per_recognized_order, cur)}`
  );
  console.log(`  Business break-even CPA:   ${formatMoney(bas.break_even_cpa, cur)}`);
  console.log(
    `  Business CPA headroom:     ${formatMoney(bas.business_cpa_headroom, cur)} (${formatPct(bas.business_cpa_headroom_pct)})`
  );
  console.log(
    `  Ad spend utilization:      ${formatPct(bas.ad_spend_utilization_pct)} of BE ad spend`
  );
  console.log("");

  console.log("META ATTRIBUTED EFFICIENCY  (platform — not business CAC)");
  console.log(`  Meta attributed CPA:       ${formatMoney(me.meta_attributed_cpa, cur)}`);
  console.log(`  Meta attributed ROAS:      ${formatRoas(me.meta_attributed_roas)}`);
  console.log(
    `  Meta attributed purchases: ${formatNumber(me.meta_attributed_purchases, 0)}`
  );
  const fb = report.meta?.funnel_baselines || {};
  console.log(
    `  Account funnel:            CTR ${formatPct(fb.ctr)} · LPV→ATC ${formatPct(fb.lpv_to_atc_pct)} · ATC→IC ${formatPct(fb.atc_to_checkout_pct)} · IC→Purch ${formatPct(fb.checkout_to_purchase_pct)}`
  );
  if (report.roas_cross_provenance?.warning) {
    console.log(`  Cross-provenance note:     ${report.roas_cross_provenance.warning}`);
  }
  console.log("");

  console.log("TOP ACTIONS");
  const tops = report.recommendations
    .filter((r) => r.priority !== "info")
    .slice(0, 8);
  if (!tops.length) {
    console.log("  (none beyond attribution disclaimer)");
  } else {
    tops.forEach((r, i) => {
      console.log(
        `  ${i + 1}. [${r.priority}] ${r.action} — ${r.entity_name || r.area}: ${r.reason}`
      );
    });
  }
  console.log("");

  console.log("ADS NEEDING ATTENTION");
  const attention = (report.ads || []).filter((a) =>
    [
      "high_priority_spend_no_purchase",
      "spend_no_purchase",
      "high_cpa",
      "weak_funnel",
    ].includes(a.status)
  );
  if (!attention.length) {
    console.log("  (none)");
  } else {
    for (const a of attention.slice(0, 8)) {
      console.log(
        `  [${a.status}] ${(a.entity_name || "").slice(0, 48)}  spend=${formatMoney(a.spend, cur)}  purch=${a.purchases}  vsAccCPA=${a.spend_vs_account_cpa ?? "—"}×`
      );
    }
  }
  console.log("");

  console.log("SCALE CANDIDATES  (controlled review only — no auto-scale)");
  const scales = [...(report.ads || []), ...(report.campaigns || [])].filter(
    (e) => e.status === "scale_candidate"
  );
  if (!scales.length) {
    console.log("  (none)");
  } else {
    for (const e of scales) {
      console.log(
        `  [${e.entity_type}] ${(e.entity_name || "").slice(0, 48)}  CPA=${formatMoney(e.meta_attributed_cpa, cur)}  ROAS=${formatRoas(e.meta_attributed_roas)}`
      );
    }
  }
  console.log("");

  console.log("PRODUCT OPPORTUNITIES / RISKS  (Books only — no product ROAS)");
  const interesting = (report.products || []).filter((p) =>
    [
      "hero",
      "high_volume_weak_margin",
      "negative_margin",
      "data_issue",
      "strong_margin_low_volume",
    ].includes(p.status)
  );
  if (!interesting.length) {
    console.log("  (none flagged)");
  } else {
    for (const p of interesting.slice(0, 10)) {
      console.log(
        `  [${p.status}] ${(p.product || p.sku || "?").slice(0, 40)}  gm=${formatPct(p.gross_margin_pct)}  revShare=${formatPct(p.revenue_share_pct)}`
      );
    }
  }
  console.log("");

  console.log("ACCOUNTING / DATA QUALITY");
  const warns = report.data_quality?.warnings || [];
  if (!warns.length) {
    console.log("  (none)");
  } else {
    for (const w of warns.slice(0, 10)) {
      console.log(`  [${w.severity || "info"}] ${w.code}: ${w.message}`);
    }
  }
  console.log("");

  console.log("CONFIDENCE");
  const c = report.confidence || {};
  console.log(
    `  Business ${String(c.business || "—").toUpperCase()} · Advertising ${String(c.advertising || "—").toUpperCase()} · Entities ${String(c.entities || "—").toUpperCase()} · Products ${String(c.products || "—").toUpperCase()}`
  );
  console.log(`  Attribution: UNAVAILABLE (no_order_level_attribution=true)`);
}

module.exports = {
  buildDecisionReport,
  printDecisionReport,
};
