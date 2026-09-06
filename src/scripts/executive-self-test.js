#!/usr/bin/env node
/**
 * Phase 11 executive OS self-tests.
 */
const assert = require("assert");
const {
  buildUnifiedOwnerQueue,
  buildWatchList,
  buildOwnerStatuses,
  buildExecutiveOperatingSystem,
  dedupeKey,
  normalizePriority,
} = require("../executive");
const { renderUnifiedDashboard } = require("../dashboard/html");
const { attachForecastAndExecutive } = require("../dashboard/attachExecutive");

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

test("normalizePriority maps synonyms", () => {
  assert.strictEqual(normalizePriority("critical"), "P1");
  assert.strictEqual(normalizePriority("HIGH"), "P2");
  assert.strictEqual(normalizePriority("medium"), "P3");
  assert.strictEqual(normalizePriority("x"), "P4");
});

test("executive queue dedupe", () => {
  const q = buildUnifiedOwnerQueue({
    marketing_queue: [
      {
        priority: "P1",
        primary_action: "PAUSE",
        entity_name: "Weak Ad",
        entity_id: "1",
        reason: "zero purchase",
      },
      {
        priority: "P1",
        primary_action: "PAUSE",
        entity_name: "Weak Ad",
        entity_id: "1",
        reason: "zero purchase",
      },
    ],
    topN: 10,
  });
  assert.strictEqual(q.length, 1);
  assert.ok(dedupeKey(q[0]).includes("pause"));
});

test("priority ordering P1 before P3", () => {
  const q = buildUnifiedOwnerQueue({
    marketing_queue: [
      { priority: "P3", primary_action: "HOLD", entity_name: "B", reason: "b" },
      { priority: "P1", primary_action: "PAUSE", entity_name: "A", reason: "a" },
    ],
    topN: 10,
  });
  assert.strictEqual(q[0].priority, "P1");
  assert.strictEqual(q[1].priority, "P3");
});

test("freshness present on executive OS", () => {
  const exec = buildExecutiveOperatingSystem({
    bundle: {
      date_range: { since: "2026-09-01", until: "2026-09-06" },
      business_health: { status: "profitable", reason: "ok" },
      business_advertising_safety: { status: "large_safety_margin" },
      shopify_context: { contribution_after_meta: 100 },
      marketing_decisions: {
        account_decision: { recommendation: "HOLD_SPEND" },
        evidence_quality: { fp_evidence: { status: "insufficient" } },
        owner_action_queue: [],
      },
      inventory: { summary: {} },
      customers: { summary: {} },
      data_quality: { warnings: [] },
    },
    forecast: { confidence: "MEDIUM", month_to_date: {}, scenarios: {} },
  });
  assert.ok(exec.freshness.last_refreshed);
  assert.ok(exec.freshness.books_through);
  assert.ok(exec.statuses.some((s) => s.area === "ATTRIBUTION"));
});

test("watch list separates from actions", () => {
  const watch = buildWatchList({
    marketing_decisions: {
      evidence_quality: { fp_immature: true, fp_evidence: { status: "insufficient" } },
    },
    shopify_context: { contribution_after_meta: -500 },
    inventory: { summary: { capital_at_risk_value: 100000 } },
    forecast: { confidence: "LOW" },
  });
  assert.ok(watch.length >= 2);
  assert.ok(watch.some((w) => /first-party/i.test(w.text)));
});

test("source labels and owner brief render in dashboard", () => {
  const report = {
    generated_at: "2026-09-06T12:00:00.000Z",
    date_range: {
      since: "2026-09-01",
      until: "2026-09-06",
      timezone: "Asia/Karachi",
      is_full_calendar_month: false,
    },
    books: {
      net_revenue_ex_tax: 50000,
      recognized_orders: 25,
      gross_profit: 20000,
      gross_margin_pct: 40,
      aov_ex_tax: 2000,
    },
    profitability: {
      meta_adjusted_profit: 5000,
      break_even_cpa: 2500,
      profit_before_ads: 10000,
    },
    business_health: { status: "profitable", reason: "Positive adjusted profit" },
    business_advertising_safety: {
      status: "large_safety_margin",
      business_cpa_headroom_pct: 30,
    },
    shopify_context: {
      contribution_after_meta: -1000,
      contribution_status: "negative_contribution",
      net_revenue_ex_tax: 20000,
    },
    meta: { totals: { spend: 8000, cpa: 1955 }, account: { currency: "PKR" } },
    sales_mix: { channels: [] },
    revenue_concentration: {},
    data_quality: { warnings: [] },
    recommendations: [],
    marketing_decisions: {
      account_decision: { recommendation: "HOLD_SPEND", guidance: "Steady" },
      evidence_quality: { fp_evidence: { status: "insufficient" } },
      owner_action_queue: [
        {
          priority: "P1",
          primary_action: "PAUSE",
          entity_name: "Weak Ad",
          reason: "spend no purchase",
          confidence: "medium",
        },
      ],
      data_quality: { blockers: [] },
    },
    inventory: { summary: { capital_at_risk_value: 90000, capital_at_risk_pct: 55 } },
    pricing: { clearance_candidates: [] },
    customers: { summary: { repeat_customer_rate_pct: 12 } },
    products: [],
  };
  attachForecastAndExecutive(report);
  const html = renderUnifiedDashboard(report);
  assert.ok(html.includes("OWNER BRIEF"));
  assert.ok(html.includes("Do This Today"));
  assert.ok(html.includes("Watch List"));
  assert.ok(html.includes("FORECAST — NOT ACTUAL") || html.includes("FORECAST"));
  assert.ok(html.includes('id="view-forecast"'));
  assert.ok(html.includes("src-badge"));
  assert.ok(html.includes("Weak Ad"));
  assert.ok(/Meta cost per purchase|break-even ad cost/i.test(html));
  assert.ok(html.includes("beforeprint"));
});

test("no Meta CPA vs Books BE CPA misuse copy on Overview", () => {
  const report = {
    generated_at: "2026-09-06T12:00:00.000Z",
    date_range: { since: "2026-09-01", until: "2026-09-06", timezone: "Asia/Karachi" },
    books: { net_revenue_ex_tax: 1, recognized_orders: 1, gross_profit: 1, gross_margin_pct: 1 },
    profitability: { meta_adjusted_profit: 1, break_even_cpa: 100, profit_before_ads: 1 },
    business_health: { status: "profitable" },
    business_advertising_safety: { status: "ok" },
    shopify_context: { contribution_after_meta: 0 },
    meta: { totals: { spend: 1, cpa: 50 }, account: { currency: "PKR" } },
    sales_mix: { channels: [] },
    revenue_concentration: {},
    data_quality: { warnings: [] },
    recommendations: [],
    products: [],
  };
  attachForecastAndExecutive(report);
  const html = renderUnifiedDashboard(report);
  assert.ok(/Do <strong>not<\/strong> compare Meta CPA/i.test(html) || /Do not compare Meta CPA/i.test(html) || html.includes("Do <strong>not</strong> compare Meta CPA") || /not<\/strong> compare Meta CPA/i.test(html));
});

if (!process.exitCode) {
  console.log("\nAll executive OS tests passed.");
}
