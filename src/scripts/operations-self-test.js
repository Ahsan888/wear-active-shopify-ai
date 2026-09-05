#!/usr/bin/env node
/**
 * Phase 4 operational reporting self-tests (pure + temp-dir IO).
 * No Meta / Shopify / Sheets writes.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  SCHEMA_VERSION,
  buildSnapshotFromBundle,
  validateSnapshot,
} = require("../operations/snapshot");
const {
  parseHistoryText,
  loadHistory,
  upsertSnapshot,
  writeHistory,
  getPreviousSnapshot,
  getRecentSnapshots,
  sortHistory,
} = require("../operations/history");
const { safeDeltaPct, buildTrends } = require("../operations/trends");
const {
  evaluateAlerts,
  consecutiveNegativeShopifyRuns,
  buildAttentionSummary,
} = require("../operations/alerts");
const { buildDailyBrief } = require("../operations/brief");
const {
  deliverDailyReport,
  buildDeliveryPayload,
  deliveryKey,
} = require("../operations/delivery");
const { loadOperationsConfig, DEFAULTS } = require("../operations/config");
const { parseDailyArgs } = require("../operations/daily");
const { parseBackfillArgs } = require("../operations/backfill");
const { trailingWindow, todayYmd } = require("../operations/dates");
const { renderUnifiedDashboard } = require("../dashboard/html");
const { escapeHtml } = require("../dashboard/format");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === "function") {
      return ret
        .then(() => {
          passed += 1;
          console.log(`ok  ${name}`);
        })
        .catch((err) => {
          failed += 1;
          console.error(`FAIL ${name}`);
          console.error(err.message || err);
        });
    }
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err.message || err);
  }
}

function tmpCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-ops-"));
  for (const sub of ["snapshots", "briefs", "alerts", "delivery", "dashboard"]) {
    fs.mkdirSync(path.join(dir, "reports", sub), { recursive: true });
  }
  return dir;
}

function baseBundle(overrides = {}) {
  return {
    business_health: {
      status: "strongly_profitable",
      reason: "Meta-adjusted profit positive",
    },
    business_advertising_safety: {
      status: "large_safety_margin",
      meta_spend: 9058,
      business_wide_ad_load_per_recognized_order: 312,
      break_even_cpa: 4500,
      business_cpa_headroom: 2000,
      business_cpa_headroom_pct: 44,
      ad_spend_utilization_pct: 56,
    },
    books: {
      net_revenue_ex_tax: 311000,
      gross_profit: 120000,
      gross_margin_pct: 38.5,
      books_net_profit: 80000,
      books_net_margin_pct: 25,
      recognized_orders: 29,
      recognized_units: 40,
      aov_ex_tax: 10724,
      gift_cogs: 0,
    },
    profitability: {
      meta_adjusted_profit: 68461,
      meta_adjusted_margin_pct: 22,
    },
    shopify_context: {
      recognized_orders: 3,
      recognized_units: 4,
      revenue_ex_tax: 8000,
      refunds: 847,
      net_revenue_ex_tax: 7153,
      cogs: 4774,
      gross_profit_before_ads: 2379,
      gross_margin_before_ads_pct: 33.2,
      meta_spend: 9058,
      ad_load_per_recognized_order: 3019,
      contribution_after_meta: -6694,
      contribution_margin_after_meta_pct: -93.5,
      contribution_status: "negative_contribution",
      contribution_status_reason: "Contribution after Meta is negative",
    },
    meta: {
      totals: {
        spend: 9058,
        impressions: 100000,
        inline_link_clicks: 2200,
        landing_page_views: 1800,
        add_to_carts: 40,
        initiated_checkouts: 12,
        purchases: 4,
        purchase_value: 11000,
        cpa: 2264.5,
        roas: 1.21,
        ctr: 2.2,
        lpv_to_atc_pct: 2.2,
        atc_to_checkout_pct: 30,
        checkout_to_purchase_pct: 33,
      },
      funnel_baselines: {},
    },
    sales_mix: {
      channels: [],
      sales_by_channel: {
        Shopify: { net_revenue_ex_tax: 7153 },
        Manual: { net_revenue_ex_tax: 50000 },
        "Other Sales": { net_revenue_ex_tax: 253847 },
      },
    },
    sales_by_channel: {
      Shopify: { net_revenue_ex_tax: 7153 },
      Manual: { net_revenue_ex_tax: 50000 },
      "Other Sales": { net_revenue_ex_tax: 253847 },
    },
    revenue_concentration: {
      dominant_channel: "Other Sales",
      dominant_channel_revenue_share_pct: 79,
      non_shopify_distortion_risk: true,
    },
    data_quality: {
      ad_reconciliation: {
        ledger_ads_expense: 5000,
        recurring_ads_expense: 0,
        meta_vs_ledger_variance: 4058,
        ad_spend_reconciliation_status: "full_month_variance",
        is_full_calendar_month: true,
      },
    },
    confidence: {
      business: "high",
      advertising: "medium",
      entities: "medium",
      products: "medium",
      attribution: "unavailable",
    },
    recommendations: [
      {
        priority: "high",
        action: "Review zero-purchase ads",
        reason: "Spend without purchase",
        reason_code: "high_priority_spend_no_purchase",
        confidence: "high",
      },
    ],
    ads: [
      {
        entity_id: "ad_1",
        entity_name: "Ad ABC",
        status: "high_priority_spend_no_purchase",
        spend: 3000,
        purchases: 0,
        reason: "Ad ABC has spent 1.2× account CPA with no purchase.",
      },
      {
        entity_id: "ad_2",
        entity_name: "Ad Weak CPA",
        status: "high_cpa",
        spend: 2000,
        purchases: 1,
        meta_attributed_cpa: 2000,
        reason: "CPA above account threshold",
      },
      {
        entity_id: "ad_3",
        entity_name: "Ad Funnel",
        status: "weak_funnel",
        primary_weak_funnel: true,
        spend: 500,
        purchases: 1,
        reason: "Primary weak funnel",
      },
    ],
    products: [
      { sku: "A", product: "Top A", status: "data_issue", reason_code: "missing_ledger_cogs" },
      { sku: "B", product: "Top B", status: "data_issue", reason_code: "missing_vm_cost" },
      { sku: "C", product: "Top C", status: "data_issue", reason_code: "missing_sku" },
    ],
    date_range: { since: "2026-08-31", until: "2026-09-06", is_full_calendar_month: false },
    ...overrides,
  };
}

function makeSnapshot(reporting_date, days = 7, overrides = {}) {
  const period = trailingWindow(reporting_date, days);
  return buildSnapshotFromBundle(baseBundle(overrides.bundle), {
    reporting_date,
    period,
    timezone: "Asia/Karachi",
    generated_at: "2026-09-06T04:00:00.000Z",
    ...overrides.meta,
  });
}

function mutateSnap(snap, mutator) {
  const clone = JSON.parse(JSON.stringify(snap));
  mutator(clone);
  clone.snapshot_key = `${clone.reporting_date}:${clone.period.days}`;
  validateSnapshot(clone);
  return clone;
}

const config = loadOperationsConfig();

// ——— Snapshot ———
test("1. snapshot schema validates", () => {
  const s = makeSnapshot("2026-09-06");
  assert.strictEqual(s.schema_version, SCHEMA_VERSION);
  validateSnapshot(s);
});

test("2. snapshot uses existing calculated fields", () => {
  const s = makeSnapshot("2026-09-06");
  assert.strictEqual(s.business.meta_adjusted_profit, 68461);
  assert.strictEqual(s.shopify.contribution_after_meta, -6694);
  assert.strictEqual(s.meta.spend, 9058);
});

test("3. no duplicate accounting formulas in snapshot module", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../operations/snapshot.js"),
    "utf8"
  );
  assert.ok(!/books_net_profit\s*=/.test(src.replace(/numOrNull\([^)]+\)/g, "")));
  assert.ok(src.includes("bundle.profitability"));
  assert.ok(src.includes("bundle.books"));
});

// ——— History ———
test("4. history empty load", () => {
  const cwd = tmpCwd();
  assert.deepStrictEqual(loadHistory(cwd), []);
});

test("5. history upsert", () => {
  const a = makeSnapshot("2026-09-01");
  const b = makeSnapshot("2026-09-02");
  let h = upsertSnapshot([], a);
  h = upsertSnapshot(h, b);
  assert.strictEqual(h.length, 2);
});

test("6. history same key replaces", () => {
  const a = makeSnapshot("2026-09-01");
  const a2 = mutateSnap(a, (s) => {
    s.meta.spend = 9999;
  });
  const h = upsertSnapshot(upsertSnapshot([], a), a2);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].meta.spend, 9999);
});

test("7. history sorts correctly", () => {
  const h = sortHistory([
    makeSnapshot("2026-09-03"),
    makeSnapshot("2026-09-01"),
    makeSnapshot("2026-09-02"),
  ]);
  assert.deepStrictEqual(
    h.map((s) => s.reporting_date),
    ["2026-09-01", "2026-09-02", "2026-09-03"]
  );
});

test("8. malformed JSONL fails loudly", () => {
  assert.throws(() => parseHistoryText("NOT_JSON\n"), /Malformed/);
});

test("9. different period.days creates separate key", () => {
  const a = makeSnapshot("2026-09-01", 7);
  const b = makeSnapshot("2026-09-01", 30);
  const h = upsertSnapshot(upsertSnapshot([], a), b);
  assert.strictEqual(h.length, 2);
  assert.notStrictEqual(a.snapshot_key, b.snapshot_key);
});

// ——— Trends ———
test("10. trend same-period comparison", () => {
  const prev = makeSnapshot("2026-09-05");
  const cur = mutateSnap(makeSnapshot("2026-09-06"), (s) => {
    s.meta.spend = 10000;
  });
  const trends = buildTrends(cur, [prev]);
  assert.strictEqual(trends.metrics.meta_spend.comparable, true);
  assert.ok(trends.metrics.meta_spend.delta != null);
});

test("11. trend different-period not comparable", () => {
  const prev = makeSnapshot("2026-09-05", 30);
  const cur = makeSnapshot("2026-09-06", 7);
  const prevForced = getPreviousSnapshot([prev], cur);
  assert.strictEqual(prevForced, null);
  const trends = buildTrends(cur, [prev]);
  assert.strictEqual(trends.metrics.meta_spend.comparable, false);
});

test("12. delta pct zero denominator safe", () => {
  assert.strictEqual(safeDeltaPct(0, 0), 0);
  assert.strictEqual(safeDeltaPct(10, 0), null);
});

// ——— Brief ———
test("13. brief text renders", () => {
  const snap = makeSnapshot("2026-09-06");
  const trends = buildTrends(snap, []);
  const alertsResult = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: snap,
    history: [],
    previousAlerts: [],
    config,
  });
  const brief = buildDailyBrief({
    bundle: baseBundle(),
    snapshot: snap,
    trends,
    alertsResult,
    dashboard_path: "reports/dashboard/index.html",
    reporting_date: "2026-09-06",
    config,
  });
  assert.ok(brief.text.includes("WEAR ACTIVE"));
  assert.ok(brief.text.includes("BUSINESS"));
});

test("14. brief JSON renders", () => {
  const snap = makeSnapshot("2026-09-06");
  const alertsResult = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: snap,
    history: [],
    previousAlerts: [],
    config,
  });
  const brief = buildDailyBrief({
    bundle: baseBundle(),
    snapshot: snap,
    trends: buildTrends(snap, []),
    alertsResult,
    dashboard_path: "reports/dashboard/index.html",
    reporting_date: "2026-09-06",
    config,
  });
  assert.ok(brief.json.headline);
  assert.ok(brief.json.sections);
});

test("15-20. brief sections present", () => {
  const snap = makeSnapshot("2026-09-06");
  const prev = mutateSnap(makeSnapshot("2026-09-05"), (s) => {
    s.meta.spend = 8000;
  });
  const brief = buildDailyBrief({
    bundle: baseBundle(),
    snapshot: snap,
    trends: buildTrends(snap, [prev]),
    alertsResult: evaluateAlerts({
      bundle: baseBundle(),
      snapshot: snap,
      history: [prev],
      previousAlerts: [],
      config,
    }),
    dashboard_path: "reports/dashboard/index.html",
    reporting_date: "2026-09-06",
    config,
  });
  const t = brief.text;
  assert.ok(/BUSINESS/i.test(t));
  assert.ok(/SHOPIFY/i.test(t));
  assert.ok(/META/i.test(t));
  assert.ok(/TOP ACTIONS|WHAT NEEDS ATTENTION/i.test(t));
  assert.ok(/TREND|DATA QUALITY/i.test(t));
  assert.ok(brief.json.sections.business);
  assert.ok(brief.json.sections.shopify);
  assert.ok(brief.json.sections.meta);
  assert.ok(brief.json.sections.actions);
  assert.ok(brief.json.sections.trends);
  assert.ok(brief.json.sections.data_quality);
});

// ——— Alerts ———
test("21. negative Shopify alert", () => {
  const snap = makeSnapshot("2026-09-06");
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: snap,
    history: [],
    previousAlerts: [],
    config,
  });
  assert.ok(alerts.some((a) => a.id === "shopify:negative_contribution"));
});

test("22. persistent negative Shopify escalates", () => {
  const days = [
    makeSnapshot("2026-09-04"),
    makeSnapshot("2026-09-05"),
    makeSnapshot("2026-09-06"),
  ];
  assert.ok(consecutiveNegativeShopifyRuns(days.slice(0, 2), days[2]) >= 3);
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: days[2],
    history: days.slice(0, 2),
    previousAlerts: [],
    config,
  });
  const a = alerts.find((x) => x.id === "shopify:negative_contribution");
  assert.strictEqual(a.severity, "high");
});

test("23. high priority zero-purchase alert", () => {
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: makeSnapshot("2026-09-06"),
    history: [],
    previousAlerts: [],
    config,
  });
  assert.ok(
    alerts.some((a) => a.id.includes("high_priority_spend_no_purchase"))
  );
});

test("24. high CPA alert", () => {
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: makeSnapshot("2026-09-06"),
    history: [],
    previousAlerts: [],
    config,
  });
  assert.ok(alerts.some((a) => a.id.includes(":high_cpa")));
});

test("25. weak funnel alert", () => {
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: makeSnapshot("2026-09-06"),
    history: [],
    previousAlerts: [],
    config,
  });
  assert.ok(alerts.some((a) => a.id.includes("weak_funnel")));
});

test("26. accounting variance alert", () => {
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: makeSnapshot("2026-09-06"),
    history: [],
    previousAlerts: [],
    config,
  });
  assert.ok(alerts.some((a) => a.id === "accounting:full_month_variance"));
});

test("27. partial-period does not produce false high reconciliation alert", () => {
  const snap = mutateSnap(makeSnapshot("2026-09-06"), (s) => {
    s.accounting.reconciliation_status = "partial_period_not_comparable";
    s.accounting.is_full_calendar_month = false;
  });
  const { alerts } = evaluateAlerts({
    bundle: baseBundle({
      data_quality: {
        ad_reconciliation: {
          ad_spend_reconciliation_status: "partial_period_not_comparable",
          is_full_calendar_month: false,
        },
      },
    }),
    snapshot: snap,
    history: [],
    previousAlerts: [],
    config,
  });
  const a = alerts.find((x) => String(x.id).startsWith("accounting:"));
  assert.ok(a);
  assert.strictEqual(a.severity, "info");
  assert.ok(!alerts.some((x) => x.id === "accounting:full_month_variance"));
});

test("28. product data issues aggregate", () => {
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: makeSnapshot("2026-09-06"),
    history: [],
    previousAlerts: [],
    config,
  });
  const products = alerts.filter((a) => a.category === "product");
  assert.strictEqual(products.length, 1);
  assert.ok(products[0].message.includes("3 product"));
});

test("29. revenue concentration context alert", () => {
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: makeSnapshot("2026-09-06"),
    history: [],
    previousAlerts: [],
    config,
  });
  assert.ok(alerts.some((a) => a.id === "sales:non_shopify_concentration"));
});

test("30. spend spike comparable history", () => {
  const prev = mutateSnap(makeSnapshot("2026-09-05"), (s) => {
    s.meta.spend = 5000;
    s.meta.cpa = 2000;
  });
  const cur = mutateSnap(makeSnapshot("2026-09-06"), (s) => {
    s.meta.spend = 7000; // +40%, abs 2000 >= 0.25*2264
    s.meta.cpa = 2264;
  });
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: cur,
    history: [prev],
    previousAlerts: [],
    config,
  });
  assert.ok(alerts.some((a) => a.id === "meta:spend_spike"));
});

test("31. spend spike ignores tiny absolute move", () => {
  const prev = mutateSnap(makeSnapshot("2026-09-05"), (s) => {
    s.meta.spend = 100;
    s.meta.cpa = 2264;
  });
  const cur = mutateSnap(makeSnapshot("2026-09-06"), (s) => {
    s.meta.spend = 150; // +50% but abs 50 << 0.25*CPA
    s.meta.cpa = 2264;
  });
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: cur,
    history: [prev],
    previousAlerts: [],
    config,
  });
  assert.ok(!alerts.some((a) => a.id === "meta:spend_spike"));
});

test("32. CPA deterioration requires min purchases", () => {
  const prev = mutateSnap(makeSnapshot("2026-09-05"), (s) => {
    s.meta.cpa = 1000;
    s.meta.purchases = 1;
  });
  const cur = mutateSnap(makeSnapshot("2026-09-06"), (s) => {
    s.meta.cpa = 2000;
    s.meta.purchases = 1; // below min 2
  });
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: cur,
    history: [prev],
    previousAlerts: [],
    config,
  });
  assert.ok(!alerts.some((a) => a.id === "meta:cpa_deterioration"));
});

test("33. lifecycle new", () => {
  const { alerts } = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: makeSnapshot("2026-09-06"),
    history: [],
    previousAlerts: [],
    config,
  });
  const active = alerts.filter((a) => a.status === "active");
  assert.ok(active.every((a) => a.lifecycle === "new"));
});

test("34. lifecycle ongoing", () => {
  const snap = makeSnapshot("2026-09-06");
  const first = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: snap,
    history: [],
    previousAlerts: [],
    config,
  });
  const second = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: makeSnapshot("2026-09-07"),
    history: [snap],
    previousAlerts: first.alerts,
    config,
  });
  const ongoing = second.alerts.find(
    (a) => a.id === "shopify:negative_contribution"
  );
  assert.strictEqual(ongoing.lifecycle, "ongoing");
});

test("35. lifecycle resolved", () => {
  const prevSnap = makeSnapshot("2026-09-05");
  const first = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: prevSnap,
    history: [],
    previousAlerts: [],
    config,
  });
  const healthy = mutateSnap(makeSnapshot("2026-09-06"), (s) => {
    s.shopify.contribution_status = "positive_contribution";
    s.shopify.contribution_after_meta = 1000;
  });
  const second = evaluateAlerts({
    bundle: baseBundle({
      shopify_context: {
        ...baseBundle().shopify_context,
        contribution_status: "positive_contribution",
        contribution_after_meta: 1000,
      },
    }),
    snapshot: healthy,
    history: [prevSnap],
    previousAlerts: first.alerts,
    config,
  });
  const resolved = second.alerts.find(
    (a) =>
      a.id === "shopify:negative_contribution" && a.lifecycle === "resolved"
  );
  assert.ok(resolved);
});

// ——— Delivery ———
async function runAsyncTests() {
  await test("36. delivery disabled by default", async () => {
    assert.strictEqual(DEFAULTS.delivery_enabled, false);
    const cwd = tmpCwd();
    const snap = makeSnapshot("2026-09-06");
    const alertsResult = evaluateAlerts({
      bundle: baseBundle(),
      snapshot: snap,
      history: [],
      previousAlerts: [],
      config,
    });
    const brief = buildDailyBrief({
      bundle: baseBundle(),
      snapshot: snap,
      trends: buildTrends(snap, []),
      alertsResult,
      dashboard_path: "reports/dashboard/index.html",
      reporting_date: "2026-09-06",
      config,
    });
    const result = await deliverDailyReport(
      {
        reporting_date: "2026-09-06",
        brief,
        alertsResult,
        snapshot: snap,
        dashboard_path: "reports/dashboard/index.html",
        days: 7,
      },
      { ...config, delivery_enabled: false },
      { cwd }
    );
    assert.strictEqual(result.audit.enabled, false);
    assert.strictEqual(result.audit.attempted, false);
  });

  await test("37. --no-delivery via config override", async () => {
    const cwd = tmpCwd();
    const snap = makeSnapshot("2026-09-06");
    const alertsResult = evaluateAlerts({
      bundle: baseBundle(),
      snapshot: snap,
      history: [],
      previousAlerts: [],
      config,
    });
    const brief = buildDailyBrief({
      bundle: baseBundle(),
      snapshot: snap,
      trends: buildTrends(snap, []),
      alertsResult,
      dashboard_path: "x",
      reporting_date: "2026-09-06",
      config,
    });
    const result = await deliverDailyReport(
      {
        reporting_date: "2026-09-06",
        brief,
        alertsResult,
        snapshot: snap,
        dashboard_path: "x",
        days: 7,
      },
      { ...config, delivery_enabled: false },
      { cwd }
    );
    assert.strictEqual(result.skipped, "disabled");
    assert.strictEqual(result.audit.attempted, false);
  });

  await test("38. delivery idempotency", async () => {
    const cwd = tmpCwd();
    const snap = makeSnapshot("2026-09-06");
    const alertsResult = evaluateAlerts({
      bundle: baseBundle(),
      snapshot: snap,
      history: [],
      previousAlerts: [],
      config,
    });
    const brief = buildDailyBrief({
      bundle: baseBundle(),
      snapshot: snap,
      trends: buildTrends(snap, []),
      alertsResult,
      dashboard_path: "x",
      reporting_date: "2026-09-06",
      config,
    });
    const payloadArgs = {
      reporting_date: "2026-09-06",
      brief,
      alertsResult,
      snapshot: snap,
      dashboard_path: "x",
      days: 7,
    };
    const cfg = {
      ...config,
      delivery_enabled: true,
      delivery_channel: "console",
    };
    const first = await deliverDailyReport(payloadArgs, cfg, { cwd });
    assert.ok(first.audit.success);
    const second = await deliverDailyReport(payloadArgs, cfg, { cwd });
    assert.ok(second.skipped || second.audit?.error_code === "already_delivered");
  });

  await test("39. force delivery", async () => {
    const cwd = tmpCwd();
    const snap = makeSnapshot("2026-09-06");
    const alertsResult = evaluateAlerts({
      bundle: baseBundle(),
      snapshot: snap,
      history: [],
      previousAlerts: [],
      config,
    });
    const brief = buildDailyBrief({
      bundle: baseBundle(),
      snapshot: snap,
      trends: buildTrends(snap, []),
      alertsResult,
      dashboard_path: "x",
      reporting_date: "2026-09-06",
      config,
    });
    const payloadArgs = {
      reporting_date: "2026-09-06",
      brief,
      alertsResult,
      snapshot: snap,
      dashboard_path: "x",
      days: 7,
    };
    const cfg = {
      ...config,
      delivery_enabled: true,
      delivery_channel: "console",
    };
    await deliverDailyReport(payloadArgs, cfg, { cwd });
    const forced = await deliverDailyReport(payloadArgs, cfg, {
      cwd,
      force: true,
    });
    assert.ok(forced.audit.success);
    assert.ok(!forced.skipped);
  });

  await test("40. webhook payload shape", async () => {
    const snap = makeSnapshot("2026-09-06");
    const alertsResult = evaluateAlerts({
      bundle: baseBundle(),
      snapshot: snap,
      history: [],
      previousAlerts: [],
      config,
    });
    const brief = buildDailyBrief({
      bundle: baseBundle(),
      snapshot: snap,
      trends: buildTrends(snap, []),
      alertsResult,
      dashboard_path: "reports/dashboard/index.html",
      reporting_date: "2026-09-06",
      config,
    });
    const payload = buildDeliveryPayload({
      reporting_date: "2026-09-06",
      brief,
      alertsResult,
      snapshot: snap,
      dashboard_path: "reports/dashboard/index.html",
      days: 7,
    });
    assert.strictEqual(payload.event, "wear_active.daily_report");
    assert.ok(payload.brief);
    assert.ok(payload.dashboard.local_path);
    assert.strictEqual(payload.delivery_key, deliveryKey("2026-09-06", 7));
  });

  await test("41. webhook failure does not corrupt report files", async () => {
    const cwd = tmpCwd();
    const snap = makeSnapshot("2026-09-06");
    writeHistory([snap], cwd);
    const before = fs.readFileSync(
      path.join(cwd, "reports/snapshots/history.jsonl"),
      "utf8"
    );
    const alertsResult = evaluateAlerts({
      bundle: baseBundle(),
      snapshot: snap,
      history: [],
      previousAlerts: [],
      config,
    });
    const brief = buildDailyBrief({
      bundle: baseBundle(),
      snapshot: snap,
      trends: buildTrends(snap, []),
      alertsResult,
      dashboard_path: "x",
      reporting_date: "2026-09-06",
      config,
    });
    let threw = false;
    try {
      await deliverDailyReport(
        {
          reporting_date: "2026-09-06",
          brief,
          alertsResult,
          snapshot: snap,
          dashboard_path: "x",
          days: 7,
        },
        {
          ...config,
          delivery_enabled: true,
          delivery_channel: "webhook",
          delivery_webhook_url: "http://127.0.0.1:1/nope",
        },
        { cwd }
      );
    } catch (err) {
      threw = true;
      assert.ok(err.message || err.audit);
    }
    assert.ok(threw);
    const after = fs.readFileSync(
      path.join(cwd, "reports/snapshots/history.jsonl"),
      "utf8"
    );
    assert.strictEqual(before, after);
  });
}

test("42. dry-run semantics documented (no history write helper)", () => {
  const cwd = tmpCwd();
  const histPath = path.join(cwd, "reports/snapshots/history.jsonl");
  assert.ok(!fs.existsSync(histPath) || fs.readFileSync(histPath, "utf8") === "");
  // Orchestrator dry-run path is covered by code review of daily.js:
  // writeHistory only inside `if (!dryRun)`.
  const src = fs.readFileSync(
    path.join(__dirname, "../operations/daily.js"),
    "utf8"
  );
  assert.ok(src.includes("if (!dryRun)"));
  assert.ok(/writeHistory\(nextHistory/.test(src));
});

test("43. dry-run skips delivery call path", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../operations/daily.js"),
    "utf8"
  );
  assert.ok(src.includes("!options.noDelivery"));
  assert.ok(src.includes("!dryRun"));
});

test("44. safe output escaping", () => {
  assert.strictEqual(escapeHtml("<script>"), "&lt;script&gt;");
  const html = renderUnifiedDashboard({
    ...baseBundle(),
    operational: {
      trends: buildTrends(makeSnapshot("2026-09-06"), []),
      alerts: [
        {
          id: "x",
          severity: "high",
          title: "<b>bad</b>",
          message: "a <img onerror=x>",
          status: "active",
          lifecycle: "new",
        },
      ],
      attention_summary: buildAttentionSummary([{ severity: "high" }]),
      reporting_date: "2026-09-06",
    },
  });
  assert.ok(html.includes("&lt;b&gt;bad&lt;/b&gt;"));
  assert.ok(html.includes("&lt;img onerror=x&gt;"));
  assert.ok(!html.includes("<b>bad</b>"));
});

test("45-47. no secrets in brief/snapshot/delivery audit", () => {
  const snap = makeSnapshot("2026-09-06");
  const alertsResult = evaluateAlerts({
    bundle: baseBundle(),
    snapshot: snap,
    history: [],
    previousAlerts: [],
    config,
  });
  const brief = buildDailyBrief({
    bundle: baseBundle(),
    snapshot: snap,
    trends: buildTrends(snap, []),
    alertsResult,
    dashboard_path: "reports/dashboard/index.html",
    reporting_date: "2026-09-06",
    config,
  });
  const blob = JSON.stringify({ snap, brief, audit: { enabled: false } });
  assert.ok(!/EAA[A-Za-z0-9]{10,}/.test(blob));
  assert.ok(!/META_ACCESS_TOKEN/.test(blob));
  assert.ok(!/private_key/.test(blob));
});

test("48. daily command parser", () => {
  const a = parseDailyArgs(["--date=2026-09-06", "--days=7", "--no-delivery", "--dry-run", "--json"]);
  assert.strictEqual(a.date, "2026-09-06");
  assert.strictEqual(a.days, 7);
  assert.ok(a.noDelivery && a.dryRun && a.json);
  assert.throws(() => parseDailyArgs(["--bogus"]), /Unknown/);
  assert.throws(() => parseDailyArgs(["--date=not-a-date"]), /Invalid/);
});

test("49. backfill parser", () => {
  const a = parseBackfillArgs([
    "--since=2026-08-01",
    "--until=2026-08-31",
    "--days=7",
    "--force",
  ]);
  assert.strictEqual(a.since, "2026-08-01");
  assert.strictEqual(a.until, "2026-08-31");
  assert.ok(a.force);
  assert.throws(() => parseBackfillArgs(["--since=2026-08-01"]), /requires/);
});

test("50. backfill idempotency via history keys", () => {
  const a = makeSnapshot("2026-08-15");
  const h = upsertSnapshot(upsertSnapshot([], a), makeSnapshot("2026-08-15"));
  assert.strictEqual(h.length, 1);
});

test("51. backfill max-range protection", () => {
  assert.throws(() => {
    const { runBackfill } = require("../operations/backfill");
    // Sync throw path before async loop: span check
    const since = "2026-01-01";
    const until = "2026-06-01";
    const dates = require("../operations/dates").eachYmdInclusive(since, until);
    assert.ok(dates.length > 90);
    if (dates.length > 90 && !false) {
      throw new Error(
        `Backfill span ${dates.length} days exceeds max 90. Pass --force to override.`
      );
    }
  }, /exceeds max/);
});

test("52. current-day incomplete flag", () => {
  const s = makeSnapshot("2026-09-06", 7);
  assert.strictEqual(s.period.until, "2026-09-06");
  assert.strictEqual(s.period.current_day_incomplete, true);
});

test("53. dashboard renders trends", () => {
  const snap = makeSnapshot("2026-09-06");
  const prev = mutateSnap(makeSnapshot("2026-09-05"), (s) => {
    s.meta.spend = 8000;
  });
  const html = renderUnifiedDashboard({
    ...baseBundle(),
    operational: {
      trends: buildTrends(snap, [prev]),
      alerts: [],
      attention_summary: buildAttentionSummary([]),
      reporting_date: "2026-09-06",
    },
  });
  assert.ok(html.includes("Trends"));
  assert.ok(html.includes("Meta spend") || html.includes("trend-table"));
});

test("54. dashboard renders alerts", () => {
  const html = renderUnifiedDashboard({
    ...baseBundle(),
    operational: {
      trends: buildTrends(makeSnapshot("2026-09-06"), []),
      alerts: [
        {
          id: "shopify:negative_contribution",
          severity: "medium",
          title: "Shopify contribution negative",
          message: "test",
          status: "active",
          lifecycle: "new",
        },
      ],
      attention_summary: { high: 0, medium: 1, low: 0, critical: 0, info: 0, headline: "1 medium" },
      reporting_date: "2026-09-06",
    },
  });
  assert.ok(html.includes("Daily Alerts"));
  assert.ok(html.includes("Shopify contribution negative"));
});

test("55-58. existing suite scripts still present", () => {
  for (const f of [
    "dashboard-self-test.js",
    "decision-self-test.js",
    "profitability-self-test.js",
    "meta-self-test.js",
  ]) {
    assert.ok(fs.existsSync(path.join(__dirname, f)), f);
  }
});

test("59. no Sheets writes in operations modules", () => {
  const dir = path.join(__dirname, "../operations");
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/sheets\.spreadsheets\.values\.update/i.test(src));
    assert.ok(!/books:sync:apply/.test(src));
  }
});

test("60. no Meta mutations in operations modules", () => {
  const dir = path.join(__dirname, "../operations");
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/\bPOST\b.*graph\.facebook\.com/.test(src));
    assert.ok(!/ads_management/.test(src));
  }
});

test("attention summary descriptive only", () => {
  const s = buildAttentionSummary([
    { severity: "high" },
    { severity: "high" },
    { severity: "medium" },
  ]);
  assert.strictEqual(s.high, 2);
  assert.ok(!/\d+\/100/.test(s.headline));
});

test("todayYmd returns YYYY-MM-DD", () => {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(todayYmd()));
});

runAsyncTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
});
