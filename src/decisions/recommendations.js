/**
 * Deterministic recommendation engine (no LLM).
 */
const { PRIORITY_RANK } = require("./thresholds");
const { productRecommendationConfidence } = require("./confidence");

let _seq = 0;
function nextId(prefix = "rec") {
  _seq += 1;
  return `${prefix}_${String(_seq).padStart(3, "0")}`;
}

function resetRecommendationIds() {
  _seq = 0;
}

function rec(partial) {
  return {
    id: nextId(),
    priority: "medium",
    area: "advertising",
    action: "monitor",
    entity_type: "account",
    entity_id: null,
    entity_name: null,
    reason_code: "monitor",
    reason: "",
    evidence: {},
    confidence: "medium",
    attribution_note: "blended_comparison",
    ...partial,
  };
}

/**
 * Build prioritized recommendations from classified decision slices.
 */
function buildRecommendations({
  business_health,
  business_advertising_safety,
  meta_efficiency,
  roas_diagnostic,
  campaigns = [],
  ads = [],
  productResult,
  confidence,
  gates,
  warnings = [],
} = {}) {
  resetRecommendationIds();
  const out = [];

  // Always state attribution boundary
  out.push(
    rec({
      priority: "info",
      area: "data_quality",
      action: "monitor",
      reason_code: "no_order_level_attribution",
      reason:
        "No Meta→Shopify order attribution — Books profitability and Meta platform results are separate populations",
      confidence: "unavailable",
      attribution_note: "unavailable",
      evidence: { no_order_level_attribution: true },
    })
  );

  if (business_health?.status === "unprofitable") {
    out.push(
      rec({
        priority: "critical",
        area: "business",
        action: "protect_margin",
        reason_code: "unprofitable_period",
        reason: business_health.reason,
        evidence: business_health.evidence,
        confidence: confidence?.business || "high",
        attribution_note: "books_only",
      })
    );
  } else if (business_health?.status === "thin_margin") {
    out.push(
      rec({
        priority: "high",
        area: "business",
        action: "protect_margin",
        reason_code: "thin_margin",
        reason: business_health.reason,
        evidence: business_health.evidence,
        confidence: confidence?.business || "high",
        attribution_note: "books_only",
      })
    );
  }

  if (business_advertising_safety?.status === "above_break_even") {
    out.push(
      rec({
        priority: "high",
        area: "advertising",
        action: "review_spend_pressure",
        reason_code: "blended_ad_cost_above_break_even",
        reason:
          "Blended Meta spend per recognized order exceeds business break-even CPA",
        evidence: {
          blended_ad_cost_per_recognized_order:
            business_advertising_safety.blended_ad_cost_per_recognized_order,
          break_even_cpa: business_advertising_safety.break_even_cpa,
          business_cpa_headroom_pct:
            business_advertising_safety.business_cpa_headroom_pct,
        },
        confidence: confidence?.advertising || "medium",
        attribution_note: "blended_comparison",
      })
    );
  } else if (business_advertising_safety?.status === "near_break_even") {
    out.push(
      rec({
        priority: "medium",
        area: "advertising",
        action: "monitor",
        reason_code: "business_cpa_near_break_even",
        reason: "Business CPA headroom is thin — avoid aggressive scale",
        evidence: {
          business_cpa_headroom_pct:
            business_advertising_safety.business_cpa_headroom_pct,
        },
        confidence: confidence?.advertising || "medium",
        attribution_note: "blended_comparison",
      })
    );
  }

  if (roas_diagnostic?.contradictory_with_meta_adjusted_profit) {
    out.push(
      rec({
        priority: "info",
        area: "data_quality",
        action: "monitor",
        reason_code: "roas_cross_provenance_contradiction",
        reason: roas_diagnostic.warning,
        evidence: {
          meta_roas: roas_diagnostic.meta_roas,
          break_even_roas: roas_diagnostic.break_even_roas,
          roas_safety_ratio: roas_diagnostic.roas_safety_ratio,
        },
        confidence: "low",
        attribution_note: "blended_comparison",
      })
    );
  }

  if (gates?.has_duplicate_ledger_expense) {
    out.push(
      rec({
        priority: "high",
        area: "accounting",
        action: "investigate_accounting",
        reason_code: "possible_duplicate_ledger_expense",
        reason:
          "Possible duplicate Ledger Ads expense — scale recommendations suppressed until reconciled",
        evidence: {},
        confidence: "medium",
        attribution_note: "books_only",
      })
    );
  }

  if (gates?.severe_meta_ledger_variance) {
    out.push(
      rec({
        priority: "medium",
        area: "accounting",
        action: "investigate_accounting",
        reason_code: "meta_vs_ledger_ads_variance",
        reason:
          "Full-month Meta spend differs substantially from Ledger Ads — reconcile before treating Books Ads as Meta truth",
        evidence: {},
        confidence: "medium",
        attribution_note: "blended_comparison",
      })
    );
  }

  if (meta_efficiency?.status === "insufficient_data") {
    out.push(
      rec({
        priority: "info",
        area: "advertising",
        action: "monitor",
        reason_code: "zero_meta_spend",
        reason: "No Meta spend in range — platform efficiency unavailable",
        confidence: "low",
        attribution_note: "meta_attributed_only",
      })
    );
  }

  const attentionStatuses = new Set([
    "high_priority_spend_no_purchase",
    "spend_no_purchase",
    "high_cpa",
    "weak_funnel",
  ]);

  for (const entity of [...ads, ...campaigns]) {
    if (!attentionStatuses.has(entity.status)) continue;
    const isHigh =
      entity.status === "high_priority_spend_no_purchase" ||
      entity.status === "high_cpa";
    let action = "monitor";
    if (
      entity.status === "spend_no_purchase" ||
      entity.status === "high_priority_spend_no_purchase"
    ) {
      action = "review_spend_no_purchase";
    } else if (entity.status === "high_cpa") {
      action = "review_high_cpa";
    } else if (entity.status === "weak_funnel") {
      action = "investigate_funnel";
    }
    out.push(
      rec({
        priority: isHigh ? "high" : "medium",
        area: entity.entity_type || "ad",
        action,
        entity_type: entity.entity_type,
        entity_id: entity.entity_id,
        entity_name: entity.entity_name,
        reason_code: entity.reason_code || entity.status,
        reason: entity.reason,
        evidence: {
          spend: entity.spend,
          purchases: entity.purchases,
          spend_vs_account_cpa: entity.spend_vs_account_cpa,
          entity_cpa_vs_account_ratio: entity.entity_cpa_vs_account_ratio,
          funnel_diagnostics: entity.funnel_diagnostics,
        },
        confidence: confidence?.entities || "medium",
        attribution_note: "meta_attributed_only",
      })
    );
  }

  // Soft funnel warnings on otherwise efficient entities (info / low)
  for (const entity of [...ads, ...campaigns]) {
    if (!entity.has_funnel_warning) continue;
    if (entity.status === "weak_funnel") continue;
    if (
      ![
        "healthy",
        "strong",
        "scale_candidate",
        "relatively_weak_cpa",
      ].includes(entity.status)
    ) {
      continue;
    }
    out.push(
      rec({
        priority: "low",
        area: entity.entity_type || "ad",
        action: "investigate_funnel",
        entity_type: entity.entity_type,
        entity_id: entity.entity_id,
        entity_name: entity.entity_name,
        reason_code: "funnel_warning_non_primary",
        reason:
          "Funnel stage(s) below account baseline with only borderline evidence — status remains CPA-based; scale blocked until resolved",
        evidence: {
          status: entity.status,
          funnel_diagnostics: entity.funnel_diagnostics,
        },
        confidence: confidence?.entities || "medium",
        attribution_note: "meta_attributed_only",
      })
    );
  }

  for (const entity of [...ads, ...campaigns]) {
    if (entity.status !== "scale_candidate") continue;
    out.push(
      rec({
        priority: "medium",
        area: entity.entity_type || "ad",
        action: "candidate_for_controlled_budget_increase",
        entity_type: entity.entity_type,
        entity_id: entity.entity_id,
        entity_name: entity.entity_name,
        reason_code: "scale_candidate",
        reason:
          "Candidate for controlled budget increase review — advisory only; do not auto-scale",
        evidence: {
          spend: entity.spend,
          purchases: entity.purchases,
          scale_checks: entity.scale_checks,
          meta_attributed_cpa: entity.meta_attributed_cpa,
          meta_attributed_roas: entity.meta_attributed_roas,
        },
        confidence: confidence?.entities || "medium",
        attribution_note: "meta_attributed_only",
      })
    );
  }

  const products = productResult?.products || [];
  for (const p of products) {
    if (p.status === "negative_margin") {
      out.push(
        rec({
          priority: "high",
          area: "product",
          action: "protect_margin",
          entity_type: "sku",
          entity_id: p.sku,
          entity_name: p.product,
          reason_code: "negative_margin",
          reason: p.reason,
          evidence: {
            gross_profit: p.gross_profit,
            gross_margin_pct: p.gross_margin_pct,
          },
          confidence: productRecommendationConfidence(
            p.status,
            confidence?.products
          ),
          attribution_note: "books_only",
        })
      );
    } else if (p.status === "high_volume_weak_margin") {
      out.push(
        rec({
          priority: "medium",
          area: "product",
          action: "protect_margin",
          entity_type: "sku",
          entity_id: p.sku,
          entity_name: p.product,
          reason_code: "high_volume_weak_margin",
          reason: p.reason,
          evidence: {
            revenue_share_pct: p.revenue_share_pct,
            gross_margin_pct: p.gross_margin_pct,
          },
          confidence: productRecommendationConfidence(
            p.status,
            confidence?.products
          ),
          attribution_note: "books_only",
        })
      );
    } else if (
      p.status === "data_issue" &&
      (p.reason_code === "missing_ledger_cogs" || p.revenue_share_pct >= 5)
    ) {
      out.push(
        rec({
          priority: "medium",
          area: "product",
          action: "fix_product_data",
          entity_type: "sku",
          entity_id: p.sku,
          entity_name: p.product,
          reason_code: p.reason_code || "missing_sku_or_cost",
          reason: p.reason,
          evidence: {
            revenue_share_pct: p.revenue_share_pct,
            flags: p.flags,
            ...(p.evidence || {}),
            expected_vm_cogs: p.expected_vm_cogs,
            cogs_coverage_ratio: p.cogs_coverage_ratio,
          },
          confidence: "low",
          attribution_note: "books_only",
        })
      );
    } else if (p.status === "hero") {
      out.push(
        rec({
          priority: "low",
          area: "product",
          action: "monitor",
          entity_type: "sku",
          entity_id: p.sku,
          entity_name: p.product,
          reason_code: "hero_product",
          reason: p.reason,
          evidence: {
            gross_profit: p.gross_profit,
            gross_profit_share_pct: p.gross_profit_share_pct,
          },
          confidence: productRecommendationConfidence(
            p.status,
            confidence?.products
          ),
          attribution_note: "books_only",
        })
      );
    }
  }

  return sortRecommendations(out);
}

function sortRecommendations(list) {
  return [...list].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 99;
    const pb = PRIORITY_RANK[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id));
  });
}

module.exports = {
  buildRecommendations,
  sortRecommendations,
  resetRecommendationIds,
};
