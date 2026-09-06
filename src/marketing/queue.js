/**
 * Owner action queue + deterministic priority (P1–P4).
 */
const { MARKETING } = require("./thresholds");

const ACTION_SEVERITY = {
  PAUSE: 40,
  REDUCE: 30,
  SCALE: 25,
  CREATIVE_TEST: 20,
  HOLD: 10,
  MONITOR: 5,
  INSUFFICIENT_DATA: 2,
  PROMOTION_TEST: 15,
};

const CONF_BONUS = { high: 15, medium: 8, low: 3, insufficient: 0 };

function priorityScore(action) {
  const primary = action.primary_action || "MONITOR";
  const secondary = action.secondary_action;
  let score = ACTION_SEVERITY[primary] || 5;
  if (secondary === "PROMOTION_TEST") {
    score += ACTION_SEVERITY.PROMOTION_TEST / 2;
  }
  score += CONF_BONUS[action.confidence] || 0;

  const spend = Number(action.spend) || 0;
  if (spend >= 20000) score += 20;
  else if (spend >= 10000) score += 12;
  else if (spend >= 5000) score += 6;
  else if (spend >= 2000) score += 3;

  if (action.constraints?.includes("INVENTORY_LIMITED")) score += 12;
  if (action.reason_codes?.includes("REPEATED_WEAK_PERFORMANCE")) score += 10;
  if (action.reason_codes?.includes("REPEATED_STRONG_PERFORMANCE")) score += 8;
  if (action.inventory?.inventory_capital >= 30000) score += 8;

  // Inventory-limited strong ads are high owner attention
  if (
    primary === "HOLD" &&
    action.constraints?.includes("INVENTORY_LIMITED") &&
    spend >= 3000
  ) {
    score += 15;
  }

  return Math.round(score);
}

function scoreToPriority(score) {
  if (score >= MARKETING.PRIORITY.P1_MIN) return "P1";
  if (score >= MARKETING.PRIORITY.P2_MIN) return "P2";
  if (score >= MARKETING.PRIORITY.P3_MIN) return "P3";
  return "P4";
}

function formatQueueReason(action) {
  const parts = [];
  if (action.spend != null) parts.push(`Rs ${Math.round(action.spend)} spend`);
  if (action.purchases != null) parts.push(`${action.purchases} purchases`);
  if (action.spend_vs_account_cpa != null && !(action.purchases > 0)) {
    parts.push(`${action.spend_vs_account_cpa}× account CPA evidence`);
  }
  if (action.entity_cpa_vs_account_ratio != null && action.purchases > 0) {
    parts.push(`${action.entity_cpa_vs_account_ratio}× account CPA`);
  }
  if (action.constraints?.includes("INVENTORY_LIMITED")) {
    parts.push(`inventory ${action.inventory?.stock_class || "limited"}`);
  }
  if (action.secondary_action === "PROMOTION_TEST") {
    parts.push(
      `${action.inventory?.recommended_discount_pct}% accounting-safe discount room`
    );
  }
  if (action.creative_test_reason) {
    parts.push(action.creative_test_reason);
  }
  const codes = (action.reason_codes || []).slice(0, 3).join(", ");
  if (codes) parts.push(codes);
  return parts.join(" · ") || "Review entity";
}

function buildOwnerActionQueue(actions = [], opts = {}) {
  const topN = opts.topN ?? MARKETING.QUEUE_TOP_N;
  const scored = (actions || []).map((a, i) => {
    const score = priorityScore(a);
    const priority = scoreToPriority(score);
    const display_action =
      a.constraints?.includes("INVENTORY_LIMITED") && a.primary_action === "HOLD"
        ? "HOLD (inventory-limited)"
        : a.secondary_action
          ? `${a.primary_action} + ${a.secondary_action}`
          : a.primary_action;
    return {
      ...a,
      priority,
      priority_score: score,
      queue_rank: null,
      title: `${display_action} — ${a.entity_name || a.entity_id || "entity"}`,
      reason: formatQueueReason(a),
      _stable: `${a.entity_type}:${a.entity_id}:${a.primary_action}:${i}`,
    };
  });

  scored.sort((a, b) => {
    if (b.priority_score !== a.priority_score) {
      return b.priority_score - a.priority_score;
    }
    if ((b.spend || 0) !== (a.spend || 0)) return (b.spend || 0) - (a.spend || 0);
    return String(a._stable).localeCompare(String(b._stable));
  });

  return scored.slice(0, topN).map((a, idx) => {
    const { _stable, ...rest } = a;
    return { ...rest, queue_rank: idx + 1 };
  });
}

/**
 * Standalone promotion opportunities from pricing (no Meta mapping required).
 */
function buildPromotionOpportunities(pricingReport, opts = {}) {
  const max = opts.max || 10;
  const list = [
    ...(pricingReport?.clearance_candidates || []),
    ...(pricingReport?.promotion_candidates || []),
  ]
    .filter(
      (r) =>
        r.recommended_discount_pct != null &&
        !r.immature_for_clearance &&
        (r.recommendation !== "CLEARANCE_CANDIDATE" || r.clearance_mature)
    )
    .sort(
      (a, b) =>
        (b.inventory_cost_capital_tied_up || 0) -
        (a.inventory_cost_capital_tied_up || 0)
    )
    .slice(0, max)
    .map((r) => ({
      primary_action: "MONITOR",
      secondary_action: "PROMOTION_TEST",
      entity_type: "product",
      entity_id: r.sku,
      entity_name: `${r.product || ""} / ${r.variant || ""}`.trim(),
      confidence: r.confidence || "medium",
      reason_codes: [
        r.recommendation === "CLEARANCE_CANDIDATE"
          ? "CLEARANCE_INVENTORY"
          : "PROMOTION_MARGIN_AVAILABLE",
      ],
      inventory: {
        stock_class: r.stock_class,
        pricing_recommendation: r.recommendation,
        recommended_discount_pct: r.recommended_discount_pct,
        inventory_capital: r.inventory_cost_capital_tied_up,
      },
      spend: null,
      purchases: null,
    }));

  return buildOwnerActionQueue(list, { topN: max });
}

module.exports = {
  priorityScore,
  scoreToPriority,
  buildOwnerActionQueue,
  buildPromotionOpportunities,
  formatQueueReason,
};
