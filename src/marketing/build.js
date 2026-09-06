/**
 * Assemble Phase 9 Marketing Decision Engine report.
 * Orchestrates existing Phase 2–8 intelligence — does not recompute COGS/CPA formulas.
 */
const { round2 } = require("../books/tax");
const { assessMarketingEvidence } = require("./evidence");
const {
  indexEntitiesById,
  attachPeriodConsistency,
} = require("./periods");
const { classifyMarketingEntities } = require("./classify");
const { classifyAccountMarketingDecision } = require("./account");
const {
  buildOwnerActionQueue,
  buildPromotionOpportunities,
} = require("./queue");
const {
  loadEntityProductMap,
  indexEntityProductMap,
} = require("./mapping");

function indexBySku(rows = []) {
  const m = new Map();
  for (const r of rows) {
    if (r?.sku) m.set(String(r.sku), r);
  }
  return m;
}

function countBy(actions, key, value) {
  return actions.filter((a) => a[key] === value).length;
}

/**
 * @param {object} input
 * @param {object} input.decisionReport - Phase 3 buildDecisionReport output (primary period)
 * @param {object} [input.periodClassified] - trailing { "7"|"14"|"30": {ads,campaigns,meta_totals} }
 * @param {object} [input.independentClassified] - { recent_7d|previous_7d|prior_16d: {ads,...} }
 * @param {object} [input.attributionEconomics]
 * @param {object} [input.pricingReport]
 * @param {object} [input.inventoryReport]
 * @param {object} [input.customerDiagnostics]
 * @param {object[]} [input.entityProductMap]
 * @param {string} [input.primaryDays]
 */
function buildMarketingDecisionReport(input = {}) {
  const decision = input.decisionReport || {};
  const primaryDays = String(input.primaryDays || decision.date_range?.days || 30);
  const ads = decision.ads || [];
  const campaigns = decision.campaigns || [];

  const trailingIndexes = {};
  const periodMeta = {};
  for (const days of ["7", "14", "30"]) {
    const snap = input.periodClassified?.[days];
    if (snap?.ads) {
      trailingIndexes[days] = indexEntitiesById(snap.ads);
    }
    if (snap?.meta_totals) {
      periodMeta[days] = {
        spend: snap.meta_totals.spend ?? null,
        purchases: snap.meta_totals.purchases ?? null,
        cpa: snap.meta_totals.cpa ?? null,
        roas: snap.meta_totals.roas ?? null,
      };
    }
  }
  trailingIndexes[primaryDays] = indexEntitiesById(
    ads.map((a) => ({ ...a, _period_days: primaryDays }))
  );

  const independentIndexes = {};
  const independentMeta = {};
  const independentKeys = Object.keys(input.independentClassified || {});
  const independentAvailable = independentKeys.length > 0;
  for (const key of independentKeys) {
    const snap = input.independentClassified[key];
    if (snap?.ads) {
      independentIndexes[key] = indexEntitiesById(snap.ads);
    }
    if (snap?.meta_totals || snap?.since) {
      independentMeta[key] = {
        since: snap.since || null,
        until: snap.until || null,
        spend: snap.meta_totals?.spend ?? null,
        purchases: snap.meta_totals?.purchases ?? null,
        cpa: snap.meta_totals?.cpa ?? null,
        roas: snap.meta_totals?.roas ?? null,
        error: snap.error || null,
      };
    }
  }

  const periodOpts = {
    trailingIndexes,
    independentIndexes,
    independentAvailable,
  };

  const adsWithPeriods = attachPeriodConsistency(
    ads.map((a) => ({ ...a, _period_days: primaryDays })),
    periodOpts
  );

  const mapLoaded =
    input.entityProductMap != null
      ? {
          rows: input.entityProductMap,
          source: "injected",
          note: "explicit_id_map",
        }
      : loadEntityProductMap(input.mappingFile);
  const mapIndex = indexEntityProductMap(mapLoaded.rows);

  const pricingSkus = input.pricingReport?.skus || [];
  const inventorySkus = input.inventoryReport?.skus || [];

  const evidence = assessMarketingEvidence({
    meta_spend: decision.meta_efficiency?.meta_spend,
    meta_purchases: decision.meta_efficiency?.meta_attributed_purchases,
    fp_attributed_coverage_pct:
      input.attributionEconomics?.account?.attributed_coverage_pct ??
      input.attributionEconomics?.attributed_coverage_pct ??
      null,
    fp_post_capture_orders:
      input.attributionEconomics?.account?.post_capture_recognized_orders ??
      input.attributionEconomics?.post_capture_recognized_orders ??
      0,
    books_recognized_orders: decision.books?.recognized_orders,
    cogs_complete: !(decision.data_quality?.warnings || []).some((w) =>
      /cogs|missing.?cost/i.test(String(w))
    ),
    warnings: decision.warnings || [],
    meta_fetch_failed: Boolean(input.meta_fetch_failed),
  });

  const ctx = {
    business_health: decision.business_health,
    business_advertising_safety: decision.business_advertising_safety,
    fp_immature: evidence.fp_immature,
    data_quality_blocks_scale: Boolean(
      decision.gates?.suppress_scale ||
        decision.confidence?.gates?.suppress_scale
    ),
    mapIndex,
    inventoryBySku: indexBySku(inventorySkus),
    pricingBySku: indexBySku(pricingSkus),
  };

  const entityActions = classifyMarketingEntities(adsWithPeriods, ctx);

  // Also classify top campaigns
  const campaignTrailing = {};
  for (const days of ["7", "14", "30"]) {
    const snap = input.periodClassified?.[days];
    if (snap?.campaigns) {
      campaignTrailing[days] = indexEntitiesById(snap.campaigns);
    }
  }
  campaignTrailing[primaryDays] = indexEntitiesById(campaigns);
  const campaignIndependent = {};
  for (const key of independentKeys) {
    const snap = input.independentClassified[key];
    if (snap?.campaigns) {
      campaignIndependent[key] = indexEntitiesById(snap.campaigns);
    }
  }
  const campaignsWithPeriods = attachPeriodConsistency(
    campaigns.map((c) => ({ ...c, _period_days: primaryDays })),
    {
      trailingIndexes: campaignTrailing,
      independentIndexes: campaignIndependent,
      independentAvailable,
    }
  );
  const campaignActions = classifyMarketingEntities(campaignsWithPeriods, ctx);

  // Prefer ad-level actions for queue; include campaigns only if no child ads scored
  const queueSource = [...entityActions];

  const account = classifyAccountMarketingDecision({
    business_health: decision.business_health,
    business_advertising_safety: decision.business_advertising_safety,
    meta_efficiency: decision.meta_efficiency,
    evidence,
    entityActions,
  });

  const owner_queue = buildOwnerActionQueue(queueSource);

  // Promotion opportunities (product-level, no Meta mutation)
  const promotion_opportunities = buildPromotionOpportunities(
    input.pricingReport
  );

  // Merge promo product actions into queue if not already represented via mapping
  const promoQueueExtra = promotion_opportunities
    .filter((p) => (p.inventory?.inventory_capital || 0) >= 20000)
    .slice(0, 3);
  const mergedQueue = buildOwnerActionQueue(
    [
      ...queueSource,
      ...promoQueueExtra.map((p) => ({
        ...p,
        spend: Math.min(p.inventory?.inventory_capital || 0, 15000) / 3,
      })),
    ],
    { topN: 10 }
  );

  const inventory_constrained = entityActions.filter(
    (a) =>
      a.constraints?.includes("INVENTORY_LIMITED") &&
      (a.meta_status === "scale_candidate" ||
        a.meta_status === "strong" ||
        a.primary_action === "HOLD")
  );

  const byAction = {};
  for (const a of entityActions) {
    byAction[a.primary_action] = (byAction[a.primary_action] || 0) + 1;
  }

  const confDist = {};
  for (const a of entityActions) {
    confDist[a.confidence] = (confDist[a.confidence] || 0) + 1;
  }

  const data_quality = {
    blockers: [
      ...evidence.warnings,
      ...(mapLoaded.rows.length === 0
        ? ["INVENTORY_MAPPING_UNAVAILABLE"]
        : []),
      ...(input.pricingReport?.error ? ["PRICING_INCOMPLETE"] : []),
      ...(input.inventoryReport?.error ? ["INVENTORY_UNTRUSTED"] : []),
    ],
    mapping: {
      source: mapLoaded.source,
      note: mapLoaded.note,
      mapped_entities: mapLoaded.rows.length,
    },
    warnings: [
      ...(decision.data_quality?.warnings || []).slice(0, 40),
      ...(input.pricingReport?.data_quality?.warnings || []).slice(0, 20),
    ],
  };

  const customer_context = input.customerDiagnostics
    ? {
        note: "Phase 6 diagnostic only — not predictive LTV; does not justify unprofitable acquisition.",
        repeat_customer_rate_pct:
          input.customerDiagnostics.repeat_customer_rate_pct ?? null,
        returning_aov: input.customerDiagnostics.returning_aov ?? null,
        observed_cac_status: evidence.fp_immature
          ? "insufficient"
          : "observed_only",
      }
    : {
        note: "Customer economics not loaded.",
        observed_cac_status: "insufficient",
      };

  return {
    generated_at: new Date().toISOString(),
    advisory_only: true,
    no_meta_mutations: true,
    no_shopify_mutations: true,
    no_budget_automation: true,
    no_exact_budget_recommendations: true,
    period: decision.date_range || input.period || null,
    primary_days: Number(primaryDays),
    economic_layers: evidence.layers,
    evidence_quality: evidence,
    account_decision: account,
    business_context: {
      business_health: decision.business_health,
      business_advertising_safety: decision.business_advertising_safety,
      shopify_context: decision.shopify_context
        ? {
            contribution_status: decision.shopify_context.contribution_status,
            net_revenue: decision.shopify_context.net_revenue_ex_tax,
            note: "Shopify channel context — not Meta attribution.",
          }
        : null,
      customer: customer_context,
    },
    meta_periods: periodMeta,
    meta_independent_periods: independentMeta,
    period_evidence_note:
      "Trailing 7/14/30 windows overlap (contextual). Independent recent_7d/previous_7d/prior_16d support REPEATED_* only.",
    independent_periods_available: independentAvailable,
    summary: {
      entities_scored: entityActions.length,
      campaigns_scored: campaignActions.length,
      by_primary_action: byAction,
      scale_count: countBy(entityActions, "primary_action", "SCALE"),
      hold_count: countBy(entityActions, "primary_action", "HOLD"),
      reduce_count: countBy(entityActions, "primary_action", "REDUCE"),
      pause_count: countBy(entityActions, "primary_action", "PAUSE"),
      creative_test_count: countBy(
        entityActions,
        "primary_action",
        "CREATIVE_TEST"
      ),
      monitor_count: countBy(entityActions, "primary_action", "MONITOR"),
      insufficient_count: countBy(
        entityActions,
        "primary_action",
        "INSUFFICIENT_DATA"
      ),
      promotion_test_count: entityActions.filter(
        (a) => a.secondary_action === "PROMOTION_TEST"
      ).length,
      inventory_constrained_count: inventory_constrained.length,
      confidence_distribution: confDist,
      repeated_weak_entity_count: entityActions.filter((a) =>
        a.reason_codes?.includes("REPEATED_WEAK_PERFORMANCE")
      ).length,
      repeated_strong_entity_count: entityActions.filter((a) =>
        a.reason_codes?.includes("REPEATED_STRONG_PERFORMANCE")
      ).length,
    },
    repeated_weak_entities: entityActions.filter((a) =>
      a.reason_codes?.includes("REPEATED_WEAK_PERFORMANCE")
    ),
    repeated_strong_entities: entityActions.filter((a) =>
      a.reason_codes?.includes("REPEATED_STRONG_PERFORMANCE")
    ),
    owner_action_queue: mergedQueue,
    scale_candidates: entityActions.filter((a) => a.primary_action === "SCALE"),
    hold: entityActions.filter((a) => a.primary_action === "HOLD"),
    reduce_candidates: entityActions.filter((a) => a.primary_action === "REDUCE"),
    pause_candidates: entityActions.filter((a) => a.primary_action === "PAUSE"),
    creative_tests: entityActions.filter(
      (a) => a.primary_action === "CREATIVE_TEST"
    ),
    promotion_tests: [
      ...entityActions.filter((a) => a.secondary_action === "PROMOTION_TEST"),
      ...promotion_opportunities.slice(0, 10),
    ],
    inventory_constraints: inventory_constrained,
    monitor: entityActions.filter((a) => a.primary_action === "MONITOR"),
    entities: entityActions,
    campaigns: campaignActions,
    data_quality,
    sources: {
      decisions: "Phase 3 buildDecisionReport / classifyMetaEntity",
      profitability: "Phase 2 Books + Meta spend affordability",
      attribution: "Phase 5/5B (diagnostic weight only when immature)",
      inventory: "Phase 7",
      pricing: "Phase 8",
      customers: "Phase 6 diagnostic",
      mapping: mapLoaded.note,
    },
  };
}

/** Format top marketing lines for daily brief / owner email (max 3). */
function formatMarketingBriefActions(marketingReport, max = 3) {
  const queue = marketingReport?.owner_action_queue || [];
  return queue.slice(0, max).map((a, i) => {
    const action =
      a.secondary_action && a.primary_action === "MONITOR"
        ? a.secondary_action.replace(/_/g, " ")
        : a.constraints?.includes("INVENTORY_LIMITED")
          ? "HOLD"
          : a.primary_action;
    const name = a.entity_name || a.entity_id || "entity";
    const reason = (a.reason || "").slice(0, 100);
    return {
      rank: i + 1,
      priority: a.priority,
      text: `${action} — ${name} — ${reason}`,
      entity_id: a.entity_id,
      primary_action: a.primary_action,
      secondary_action: a.secondary_action || null,
    };
  });
}

/**
 * Build marketing decisions from a unified reporting bundle (dashboard/daily).
 * Multi-period Meta windows optional — omit for lightweight daily attach.
 */
function buildMarketingFromUnifiedBundle(bundle = {}, extras = {}) {
  return buildMarketingDecisionReport({
    decisionReport: {
      date_range: bundle.date_range,
      business_health: bundle.business_health,
      business_advertising_safety: bundle.business_advertising_safety,
      shopify_context: bundle.shopify_context,
      meta_efficiency: bundle.meta_efficiency,
      books: bundle.books,
      ads: bundle.ads || [],
      campaigns: bundle.campaigns || [],
      warnings: bundle.data_quality?.warnings || [],
      data_quality: bundle.data_quality,
      confidence: bundle.confidence,
      meta: bundle.meta,
      gates: bundle.gates,
    },
    attributionEconomics: extras.attributionEconomics || bundle.attribution_economics,
    pricingReport: extras.pricingReport || bundle.pricing,
    inventoryReport: extras.inventoryReport || bundle.inventory,
    customerDiagnostics: extras.customerDiagnostics || bundle.customers?.summary,
    periodClassified: extras.periodClassified,
    entityProductMap: extras.entityProductMap,
    primaryDays:
      extras.primaryDays ||
      bundle.date_range?.days ||
      bundle.operational?.days ||
      30,
    period: bundle.date_range,
  });
}

module.exports = {
  buildMarketingDecisionReport,
  formatMarketingBriefActions,
  buildMarketingFromUnifiedBundle,
  indexBySku,
};
