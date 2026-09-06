#!/usr/bin/env node
/**
 * Phase 9 marketing decision engine self-tests.
 */
const assert = require("assert");
const { classifyMetaEntity } = require("../decisions/entities");
const {
  classifyMarketingEntity,
  classifyMarketingEntities,
  creativeTestFromFunnel,
} = require("../marketing/classify");
const { derivePerformanceDirection } = require("../marketing/periods");
const { assessMarketingEvidence } = require("../marketing/evidence");
const { classifyAccountMarketingDecision } = require("../marketing/account");
const {
  buildOwnerActionQueue,
  priorityScore,
} = require("../marketing/queue");
const {
  buildMarketingDecisionReport,
  formatMarketingBriefActions,
} = require("../marketing/build");
const { indexEntityProductMap } = require("../marketing/mapping");

function test(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err.message || err);
    process.exitCode = 1;
  }
}

const accountMeta = {
  cpa: 2000,
  roas: 2.0,
  impressions: 100000,
  clicks: 3000,
  inline_link_clicks: 2800,
  landing_page_views: 2000,
  add_to_carts: 200,
  initiated_checkouts: 80,
  purchases: 40,
  ctr: 3.0,
};

function strongAd(overrides = {}) {
  return classifyMetaEntity(
    {
      ad_id: "ad-strong",
      ad_name: "Strong Ad",
      spend: 8000,
      purchases: 8,
      cpa: 1000,
      roas: 3.0,
      impressions: 20000,
      clicks: 800,
      inline_link_clicks: 750,
      landing_page_views: 600,
      add_to_carts: 60,
      initiated_checkouts: 25,
      ctr: 4.0,
      ...overrides,
    },
    accountMeta,
    {
      entity_type: "ad",
      business_health_ok: true,
      business_ads_ok: true,
      confidence_ok: true,
      accounting_scale_ok: true,
    }
  );
}

const bizCtx = {
  business_health: { status: "profitable" },
  business_advertising_safety: {
    status: "large_safety_margin",
    business_cpa_headroom_pct: 45,
    break_even_cpa: 5000,
    blended_ad_cost_per_recognized_order: 2000,
  },
  fp_immature: true,
};

test("strong entity → SCALE", () => {
  const e = strongAd();
  assert.strictEqual(e.status, "scale_candidate");
  const a = classifyMarketingEntity(e, bizCtx);
  assert.strictEqual(a.primary_action, "SCALE");
  assert.ok(["TEST_SCALE", "MODERATE_SCALE", "STRONG_SCALE"].includes(a.scale_strength));
  assert.ok(a.scale_guidance);
  assert.ok(!/\d+%/.test(a.scale_guidance)); // no exact budget %
});

test("strong entity + LOW stock → HOLD + INVENTORY_LIMITED", () => {
  const e = strongAd({ ad_id: "ad-low" });
  const mapIndex = indexEntityProductMap([
    { entity_type: "ad", entity_id: "ad-low", sku: "SKU-1" },
  ]);
  const a = classifyMarketingEntity(e, {
    ...bizCtx,
    mapIndex,
    inventoryBySku: new Map([
      ["SKU-1", { stock_class: "LOW", stock_trusted: true, inventory_value: 5000 }],
    ]),
    pricingBySku: new Map(),
  });
  assert.strictEqual(a.primary_action, "HOLD");
  assert.ok(a.constraints.includes("INVENTORY_LIMITED"));
  assert.ok(a.reason_codes.includes("INVENTORY_LIMITED"));
});

test("average entity → HOLD", () => {
  const e = classifyMetaEntity(
    {
      ad_id: "ad-avg",
      ad_name: "Avg",
      spend: 4000,
      purchases: 2,
      cpa: 2000,
      roas: 2.0,
      impressions: 5000,
      clicks: 150,
      ctr: 3.0,
    },
    accountMeta,
    {
      entity_type: "ad",
      business_health_ok: true,
      business_ads_ok: true,
      confidence_ok: true,
    }
  );
  const a = classifyMarketingEntity(e, bizCtx);
  assert.ok(["HOLD", "MONITOR"].includes(a.primary_action));
  assert.notStrictEqual(a.primary_action, "SCALE");
});

test("weak purchasing entity → REDUCE", () => {
  const e = classifyMetaEntity(
    {
      ad_id: "ad-weak",
      ad_name: "Weak CPA",
      spend: 10000,
      purchases: 4,
      cpa: 3000, // 1.5x account
      roas: 1.0,
      impressions: 10000,
      clicks: 300,
      ctr: 3.0,
    },
    accountMeta,
    { entity_type: "ad", business_health_ok: true, business_ads_ok: true }
  );
  assert.strictEqual(e.status, "high_cpa");
  const a = classifyMarketingEntity(e, bizCtx);
  assert.strictEqual(a.primary_action, "REDUCE");
});

test("high-spend zero-purchase → PAUSE", () => {
  const e = classifyMetaEntity(
    {
      ad_id: "ad-zero",
      ad_name: "Zero",
      spend: 3000, // 1.5x account CPA
      purchases: 0,
      impressions: 8000,
      clicks: 100,
      ctr: 1.2,
    },
    accountMeta,
    { entity_type: "ad" }
  );
  assert.strictEqual(e.status, "high_priority_spend_no_purchase");
  const a = classifyMarketingEntity(e, bizCtx);
  assert.strictEqual(a.primary_action, "PAUSE");
  assert.ok(a.reason_codes.includes("ZERO_PURCHASE_SPEND"));
});

test("tiny zero-purchase sample → MONITOR", () => {
  const e = classifyMetaEntity(
    {
      ad_id: "ad-tiny",
      ad_name: "Tiny",
      spend: 200, // 0.1x account CPA
      purchases: 0,
      impressions: 500,
      clicks: 10,
    },
    accountMeta,
    { entity_type: "ad" }
  );
  assert.strictEqual(e.status, "insufficient_data");
  const a = classifyMarketingEntity(e, bizCtx);
  assert.ok(["MONITOR", "INSUFFICIENT_DATA"].includes(a.primary_action));
  assert.notStrictEqual(a.primary_action, "PAUSE");
});

test("low CTR sufficient impressions → CREATIVE_TEST", () => {
  const e = classifyMetaEntity(
    {
      ad_id: "ad-ctr",
      ad_name: "Low CTR",
      spend: 5000,
      purchases: 3,
      cpa: 1666,
      roas: 2.2,
      impressions: 50000,
      clicks: 200,
      ctr: 0.4, // << account 3.0
      inline_link_clicks: 180,
      landing_page_views: 150,
      add_to_carts: 20,
      initiated_checkouts: 8,
    },
    accountMeta,
    {
      entity_type: "ad",
      business_health_ok: true,
      business_ads_ok: true,
      confidence_ok: true,
    }
  );
  // May be weak_funnel or healthy with funnel warning
  const a = classifyMarketingEntity(
    {
      ...e,
      funnel_diagnostics: [
        {
          code: "creative_click_weak",
          volume: 50000,
          min_gate: 1000,
          meets_primary_volume: true,
        },
      ],
      has_funnel_warning: true,
      primary_weak_funnel: true,
      status: "weak_funnel",
    },
    bizCtx
  );
  assert.strictEqual(a.primary_action, "CREATIVE_TEST");
  assert.strictEqual(a.creative_test_reason, "LOW_CTR");
});

test("weak downstream conversion does not become creative-only", () => {
  const creative = creativeTestFromFunnel({
    funnel_diagnostics: [
      {
        code: "offer_atc_weak",
        volume: 100,
        min_gate: 40,
        meets_primary_volume: true,
      },
    ],
    has_funnel_warning: true,
  });
  assert.notStrictEqual(creative.action, "CREATIVE_TEST");
  assert.strictEqual(creative.creative_test_reason, "STRONG_CLICK_WEAK_CONVERSION");
});

test("repeated weakness raises confidence", () => {
  const e = classifyMetaEntity(
    {
      ad_id: "ad-rep",
      ad_name: "Repeat weak",
      spend: 12000,
      purchases: 4,
      cpa: 3000,
      roas: 1.0,
      impressions: 20000,
      clicks: 400,
      ctr: 2.0,
    },
    accountMeta,
    { entity_type: "ad" }
  );
  const a1 = classifyMarketingEntity(
    {
      ...e,
      period_consistency: {
        performance_direction: "WORSENING",
        weak_period_count: 1,
        strong_period_count: 0,
      },
    },
    bizCtx
  );
  const a2 = classifyMarketingEntity(
    {
      ...e,
      period_consistency: {
        performance_direction: "WORSENING",
        weak_period_count: 3,
        strong_period_count: 0,
      },
    },
    bizCtx
  );
  assert.ok(["REDUCE", "PAUSE"].includes(a2.primary_action));
  // Repeated weakness → higher confidence than single period
  const rank = { insufficient: 0, low: 1, medium: 2, high: 3 };
  assert.ok(rank[a2.confidence] >= rank[a1.confidence]);
});

test("repeated strength raises scale confidence", () => {
  const e = strongAd({ ad_id: "ad-rep-s" });
  const a1 = classifyMarketingEntity(
    {
      ...e,
      period_consistency: {
        performance_direction: "STABLE",
        weak_period_count: 0,
        strong_period_count: 1,
      },
    },
    bizCtx
  );
  const a2 = classifyMarketingEntity(
    {
      ...e,
      period_consistency: {
        performance_direction: "STABLE",
        weak_period_count: 0,
        strong_period_count: 3,
      },
    },
    bizCtx
  );
  assert.strictEqual(a2.primary_action, "SCALE");
  const rank = { insufficient: 0, low: 1, medium: 2, high: 3 };
  assert.ok(rank[a2.confidence] >= rank[a1.confidence]);
  assert.ok(a2.reason_codes.includes("REPEATED_STRONG_PERFORMANCE"));
});

test("immature FP attribution does not block Meta SCALE", () => {
  const e = strongAd({ ad_id: "ad-fp" });
  const a = classifyMarketingEntity(e, { ...bizCtx, fp_immature: true });
  assert.strictEqual(a.primary_action, "SCALE");
  assert.ok(a.warnings.includes("ATTRIBUTION_IMMATURE"));
  assert.ok(a.warnings.includes("META_NOT_FP_VERIFIED"));
});

test("Meta-reported conversion never treated as FP verified", () => {
  const ev = assessMarketingEvidence({
    meta_spend: 20000,
    meta_purchases: 20,
    books_recognized_orders: 30,
    fp_attributed_coverage_pct: 5,
    fp_post_capture_orders: 1,
  });
  assert.strictEqual(ev.fp_immature, true);
  assert.notStrictEqual(ev.fp_evidence.status, "usable");
  assert.ok(ev.layers.first_party_attributed);
  assert.ok(ev.layers.meta_platform);
});

test("mature clearance + safe discount → secondary PROMOTION_TEST", () => {
  const e = classifyMetaEntity(
    {
      ad_id: "ad-promo",
      ad_name: "Promo Ad",
      spend: 4000,
      purchases: 2,
      cpa: 2000,
      roas: 2.0,
      impressions: 8000,
      clicks: 200,
      ctr: 2.5,
    },
    accountMeta,
    { entity_type: "ad", business_health_ok: true, business_ads_ok: true }
  );
  const mapIndex = indexEntityProductMap([
    { entity_type: "ad", entity_id: "ad-promo", sku: "CLEAR-1" },
  ]);
  const a = classifyMarketingEntity(e, {
    ...bizCtx,
    mapIndex,
    inventoryBySku: new Map([
      [
        "CLEAR-1",
        {
          stock_class: "NO_DEMAND",
          stock_trusted: true,
          inventory_value: 40000,
        },
      ],
    ]),
    pricingBySku: new Map([
      [
        "CLEAR-1",
        {
          recommendation: "CLEARANCE_CANDIDATE",
          recommended_discount_pct: 10,
          clearance_mature: true,
          immature_for_clearance: false,
          inventory_cost_capital_tied_up: 40000,
        },
      ],
    ]),
  });
  assert.strictEqual(a.secondary_action, "PROMOTION_TEST");
  assert.ok(a.reason_codes.includes("PROMOTION_MARGIN_AVAILABLE"));
});

test("immature clearance → no promotion escalation", () => {
  const e = classifyMetaEntity(
    {
      ad_id: "ad-imm",
      ad_name: "Imm",
      spend: 4000,
      purchases: 2,
      cpa: 2000,
      roas: 2.0,
      impressions: 8000,
      clicks: 200,
      ctr: 2.5,
    },
    accountMeta,
    { entity_type: "ad", business_health_ok: true, business_ads_ok: true }
  );
  const mapIndex = indexEntityProductMap([
    { entity_type: "ad", entity_id: "ad-imm", sku: "YOUNG-1" },
  ]);
  const a = classifyMarketingEntity(e, {
    ...bizCtx,
    mapIndex,
    inventoryBySku: new Map([
      ["YOUNG-1", { stock_class: "NO_DEMAND", stock_trusted: true }],
    ]),
    pricingBySku: new Map([
      [
        "YOUNG-1",
        {
          recommendation: "CLEARANCE_CANDIDATE",
          recommended_discount_pct: 10,
          clearance_mature: false,
          immature_for_clearance: true,
        },
      ],
    ]),
  });
  assert.notStrictEqual(a.secondary_action, "PROMOTION_TEST");
});

test("no product mapping → no inventory assumption", () => {
  const e = strongAd({ ad_id: "ad-unmap" });
  const a = classifyMarketingEntity(e, {
    ...bizCtx,
    mapIndex: indexEntityProductMap([]),
  });
  assert.strictEqual(a.inventory.inventory_action, "UNKNOWN");
  assert.strictEqual(a.primary_action, "SCALE"); // still can scale
});

test("business near break-even suppresses SCALE", () => {
  const e = strongAd({ ad_id: "ad-be" });
  const a = classifyMarketingEntity(e, {
    business_health: { status: "profitable" },
    business_advertising_safety: { status: "near_break_even" },
    fp_immature: true,
  });
  assert.strictEqual(a.primary_action, "HOLD");
  assert.ok(a.constraints.includes("SCALE_SUPPRESSED_BY_BUSINESS"));
});

test("business above break-even → defensive account", () => {
  const acc = classifyAccountMarketingDecision({
    business_health: { status: "profitable" },
    business_advertising_safety: { status: "above_break_even" },
    meta_efficiency: { meta_spend: 50000, meta_attributed_cpa: 3000 },
    evidence: { marketing_evidence_confidence: "medium", fp_immature: true },
    entityActions: [],
  });
  assert.strictEqual(acc.recommendation, "DEFENSIVE_MODE");
  assert.strictEqual(acc.no_exact_budget, true);
});

test("missing COGS / data quality blocks strong economic claims path", () => {
  const e = strongAd({ ad_id: "ad-dq" });
  // Phase 3 would not mark scale_candidate if accounting_ok false —
  // simulate classified strong without scale_eligible
  const a = classifyMarketingEntity(
    { ...e, status: "strong", scale_eligible: false },
    {
      ...bizCtx,
      data_quality_blocks_scale: true,
    }
  );
  assert.notStrictEqual(a.primary_action, "SCALE");
});

test("action queue ranking deterministic", () => {
  const actions = classifyMarketingEntities(
    [
      {
        ...classifyMetaEntity(
          {
            ad_id: "z",
            ad_name: "Z",
            spend: 500,
            purchases: 0,
            impressions: 100,
            clicks: 5,
          },
          accountMeta,
          { entity_type: "ad" }
        ),
      },
      {
        ...classifyMetaEntity(
          {
            ad_id: "a",
            ad_name: "A pause",
            spend: 5000,
            purchases: 0,
            impressions: 10000,
            clicks: 100,
          },
          accountMeta,
          { entity_type: "ad" }
        ),
      },
    ],
    bizCtx
  );
  const q1 = buildOwnerActionQueue(actions);
  const q2 = buildOwnerActionQueue(actions);
  assert.deepStrictEqual(
    q1.map((x) => x.entity_id),
    q2.map((x) => x.entity_id)
  );
  assert.ok(priorityScore(q1[0]) >= priorityScore(q1[q1.length - 1]));
});

test("no exact budget recommendation in report", () => {
  const e = strongAd();
  const report = buildMarketingDecisionReport({
    decisionReport: {
      date_range: { since: "2026-08-08", until: "2026-09-06", days: 30 },
      business_health: { status: "profitable" },
      business_advertising_safety: {
        status: "large_safety_margin",
        business_cpa_headroom_pct: 40,
        break_even_cpa: 4000,
        blended_ad_cost_per_recognized_order: 2000,
      },
      meta_efficiency: {
        meta_spend: 50000,
        meta_attributed_cpa: 2000,
        meta_attributed_roas: 2,
        meta_attributed_purchases: 25,
      },
      books: { recognized_orders: 40 },
      ads: [e],
      campaigns: [],
      warnings: [],
      data_quality: { warnings: [] },
      confidence: {},
      gates: { suppress_scale: false },
    },
    entityProductMap: [],
    primaryDays: 30,
  });
  assert.strictEqual(report.no_exact_budget_recommendations, true);
  assert.strictEqual(report.no_meta_mutations, true);
  const blob = JSON.stringify(report);
  assert.ok(!/increase budget by \d+%/i.test(blob));
  assert.ok(!/\+30%/.test(blob));
});

test("performance direction helper", () => {
  const d = derivePerformanceDirection({
    "7": "high_cpa",
    "14": "high_cpa",
    "30": "healthy",
  });
  assert.ok(["WORSENING", "STABLE"].includes(d.performance_direction));
  assert.ok(d.weak_period_count >= 2);
});

test("brief actions max 3", () => {
  const report = {
    owner_action_queue: [
      { priority: "P1", primary_action: "PAUSE", entity_name: "A", reason: "r1" },
      { priority: "P1", primary_action: "REDUCE", entity_name: "B", reason: "r2" },
      { priority: "P2", primary_action: "HOLD", entity_name: "C", reason: "r3", constraints: ["INVENTORY_LIMITED"] },
      { priority: "P2", primary_action: "SCALE", entity_name: "D", reason: "r4" },
    ],
  };
  const lines = formatMarketingBriefActions(report, 3);
  assert.strictEqual(lines.length, 3);
});

test("no Meta/Shopify write modules in marketing package surface", () => {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "../marketing");
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/graphPost\s*\(/i.test(src));
    assert.ok(!/priceSet|inventoryAdjust|campaign\.update|ad\.update/i.test(src));
    assert.ok(!/require\(["'].*shopify.*write/i.test(src));
  }
});

if (!process.exitCode) {
  console.log("\nAll marketing decision self-tests passed.");
}
