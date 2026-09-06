#!/usr/bin/env node
/**
 * Phase 6 customer & cohort economics self-tests.
 */
const assert = require("assert");
const {
  resolveCustomerIdentity,
  hashEmail,
  assertNoRawPii,
} = require("../customers/identity");
const {
  buildRecognizedCustomerOrders,
  assignOrderSequences,
} = require("../customers/orders");
const { buildCustomerEconomics } = require("../customers/build");
const { buildObservedCac } = require("../customers/cac");
const { cohortCheckpointMature, daysBetweenYmd } = require("../customers/dates");
const { emptyOrderEcon } = require("../attribution/ledgerJoin");

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

function econ(orderId, { rev = 1000, cogs = 400, units = 1, refunds = 0 } = {}) {
  const e = emptyOrderEcon();
  e.order_id = orderId;
  e.has_sale = true;
  e.revenue_ex_tax = rev;
  e.refunds = refunds;
  e.net_revenue_ex_tax = rev - refunds;
  e.cogs = cogs;
  e.gross_profit = rev - refunds - cogs;
  e.units = units;
  e.sale_lines = 1;
  return e;
}

function orderNode({
  id,
  name,
  createdAt,
  customerId = null,
  email = null,
  attrs = [],
}) {
  return {
    id: `gid://shopify/Order/${id}`,
    name: name || `#${id}`,
    createdAt,
    email,
    customer: customerId
      ? { id: `gid://shopify/Customer/${customerId}` }
      : null,
    customAttributes: attrs,
    customerJourneySummary: { ready: true, momentsCount: { count: 0 } },
  };
}

test("customer id preferred over email", () => {
  const id = resolveCustomerIdentity(
    orderNode({
      id: "1",
      createdAt: "2026-08-01",
      customerId: "99",
      email: "a@example.com",
    })
  );
  assert.strictEqual(id.customer_key, "shopify_customer:99");
  assert.strictEqual(id.identity_type, "shopify_customer");
});

test("email hashed immediately; never raw in key", () => {
  const email = "Buyer@Example.com";
  const id = resolveCustomerIdentity(
    orderNode({ id: "2", createdAt: "2026-08-01", email })
  );
  assert.strictEqual(id.identity_type, "email_hash");
  assert.ok(id.customer_key.startsWith("email_hash:"));
  assert.ok(!id.customer_key.includes("@"));
  assert.strictEqual(
    id.customer_key,
    `email_hash:${hashEmail(email)}`
  );
});

test("guest orders stay separate", () => {
  const a = resolveCustomerIdentity(
    orderNode({ id: "10", createdAt: "2026-08-01" })
  );
  const b = resolveCustomerIdentity(
    orderNode({ id: "11", createdAt: "2026-08-02" })
  );
  assert.strictEqual(a.identity_type, "guest");
  assert.notStrictEqual(a.customer_key, b.customer_key);
});

test("first-time / returning / third order sequencing", () => {
  const ledger = new Map([
    ["100", econ("100", { rev: 1000, cogs: 400 })],
    ["101", econ("101", { rev: 1200, cogs: 450 })],
    ["102", econ("102", { rev: 800, cogs: 300 })],
  ]);
  const orders = [
    orderNode({ id: "100", createdAt: "2026-06-01T10:00:00Z", customerId: "7" }),
    orderNode({ id: "101", createdAt: "2026-07-15T10:00:00Z", customerId: "7" }),
    orderNode({ id: "102", createdAt: "2026-08-20T10:00:00Z", customerId: "7" }),
  ];
  const { rows } = buildRecognizedCustomerOrders({
    orders,
    ledgerByOrderId: ledger,
  });
  assignOrderSequences(rows);
  assert.strictEqual(rows[0].order_sequence, 1);
  assert.strictEqual(rows[0].new_or_returning, "new_in_observed_history");
  assert.strictEqual(rows[1].order_sequence, 2);
  assert.strictEqual(rows[1].new_or_returning, "returning_in_observed_history");
  assert.strictEqual(rows[2].order_sequence, 3);
  assert.strictEqual(rows[2].new_or_returning, "returning_in_observed_history");
});

test("duplicate order prevention", () => {
  const ledger = new Map([["50", econ("50")]]);
  const orders = [
    orderNode({ id: "50", createdAt: "2026-08-01", customerId: "1" }),
    orderNode({ id: "50", createdAt: "2026-08-01", customerId: "1" }),
  ];
  const { rows } = buildRecognizedCustomerOrders({
    orders,
    ledgerByOrderId: ledger,
  });
  assert.strictEqual(rows.length, 1);
});

test("guest customer in report", () => {
  const ledger = new Map([["60", econ("60", { rev: 500, cogs: 200 })]]);
  const report = buildCustomerEconomics({
    orders: [orderNode({ id: "60", createdAt: "2026-08-10T00:00:00Z" })],
    ledgerByOrderId: ledger,
    period: { since: "2026-08-01", until: "2026-08-31" },
    meta_spend_total: 0,
  });
  assert.strictEqual(report.summary.guest_unknown_customers, 1);
  assert.strictEqual(report.summary.recognized_customers_identified, 0);
});

test("revenue/COGS/GP reconciliation on period orders", () => {
  const ledger = new Map([
    ["1", econ("1", { rev: 1000, cogs: 400 })],
    ["2", econ("2", { rev: 2000, cogs: 700 })],
  ]);
  const report = buildCustomerEconomics({
    orders: [
      orderNode({ id: "1", createdAt: "2026-08-05", customerId: "1" }),
      orderNode({ id: "2", createdAt: "2026-08-12", customerId: "2" }),
    ],
    ledgerByOrderId: ledger,
    period: { since: "2026-08-01", until: "2026-08-31" },
  });
  assert.strictEqual(report.summary.revenue, 3000);
  assert.strictEqual(report.summary.cogs, 1100);
  assert.strictEqual(report.summary.gross_profit, 1900);
});

test("missing COGS flagged", () => {
  const ledger = new Map([
    ["9", econ("9", { rev: 1000, cogs: 0, units: 2 })],
  ]);
  const report = buildCustomerEconomics({
    orders: [
      orderNode({ id: "9", createdAt: "2026-08-05", customerId: "3" }),
    ],
    ledgerByOrderId: ledger,
    period: { since: "2026-08-01", until: "2026-08-31" },
  });
  assert.ok(
    report.data_quality.missing_cogs_order_ids.includes("9")
  );
});

test("30/60/90 repeat maturity + immature cohort null", () => {
  assert.strictEqual(
    cohortCheckpointMature("2026-08", "2026-09-06", 90),
    false
  );
  assert.strictEqual(
    cohortCheckpointMature("2026-05", "2026-09-06", 90),
    true
  );

  const ledger = new Map([
    ["201", econ("201", { rev: 1000, cogs: 400 })],
    ["202", econ("202", { rev: 1100, cogs: 420 })],
  ]);
  // First order May, second June — cohort 2026-05 matured for 90d by Sep 6
  const report = buildCustomerEconomics({
    orders: [
      orderNode({
        id: "201",
        createdAt: "2026-05-10T00:00:00Z",
        customerId: "40",
      }),
      orderNode({
        id: "202",
        createdAt: "2026-06-05T00:00:00Z",
        customerId: "40",
      }),
    ],
    ledgerByOrderId: ledger,
    period: { since: "2026-05-01", until: "2026-09-06" },
  });
  const may = report.cohorts.find((c) => c.cohort === "2026-05");
  assert.ok(may);
  assert.strictEqual(may.repeat_by_90d.matured, true);
  assert.ok(may.repeat_by_90d.rate_pct != null);

  const augCohortOnly = buildCustomerEconomics({
    orders: [
      orderNode({
        id: "201",
        createdAt: "2026-08-10T00:00:00Z",
        customerId: "41",
      }),
    ],
    ledgerByOrderId: new Map([["201", econ("201")]]),
    period: { since: "2026-08-01", until: "2026-09-06" },
  });
  const aug = augCohortOnly.cohorts.find((c) => c.cohort === "2026-08");
  assert.strictEqual(aug.repeat_by_90d.matured, false);
  assert.strictEqual(aug.repeat_by_90d.rate_pct, null);
});

test("days to second purchase", () => {
  assert.strictEqual(daysBetweenYmd("2026-06-01", "2026-06-21"), 20);
});

test("first-party Meta acquisition + unattributed customer", () => {
  const metaAttrs = [
    {
      key: "_wa_attr",
      value: JSON.stringify({
        version: 1,
        first_touch: {
          source: "facebook",
          medium: "paid",
          campaign_id: "120",
          adset_id: "130",
          ad_id: "140",
          timestamp: "2026-08-05T12:00:00Z",
        },
        last_touch: {
          source: "facebook",
          medium: "paid",
          campaign_id: "120",
          adset_id: "130",
          ad_id: "140",
          timestamp: "2026-08-05T12:00:00Z",
        },
      }),
    },
  ];
  const ledger = new Map([
    ["301", econ("301", { rev: 1500, cogs: 500 })],
    ["302", econ("302", { rev: 900, cogs: 300 })],
  ]);
  const report = buildCustomerEconomics({
    orders: [
      orderNode({
        id: "301",
        createdAt: "2026-08-05T12:00:00Z",
        customerId: "55",
        attrs: metaAttrs,
      }),
      orderNode({
        id: "302",
        createdAt: "2026-08-06T12:00:00Z",
        customerId: "56",
      }),
    ],
    ledgerByOrderId: ledger,
    period: { since: "2026-08-01", until: "2026-08-31" },
    history: { since: "2026-08-01", until: "2026-08-31" },
    meta_spend_total: 3000,
    capture_started_at: "2026-08-01T00:00:00+05:00",
    attribution_coverage_pct: 50,
  });
  const c55 = report.customers.find(
    (c) => c.customer_key === "shopify_customer:55"
  );
  const c56 = report.customers.find(
    (c) => c.customer_key === "shopify_customer:56"
  );
  assert.strictEqual(c55.first_order_acquisition, "Meta");
  assert.strictEqual(c55.first_order_attribution_phase, "post_capture");
  assert.ok(c56.first_order_acquisition !== "Meta");
  assert.strictEqual(report.observed_cac.meta_new_customers, 1);
  assert.strictEqual(
    report.observed_cac.first_party_observed_new_customer_cac,
    3000
  );
  assert.strictEqual(report.observed_cac.attribution_coverage_pct, 50);
});

test("pre_capture Meta customer excluded from FP CAC", () => {
  const metaAttrs = [
    {
      key: "_wa_attr",
      value: JSON.stringify({
        version: 1,
        first_touch: {
          source: "facebook",
          medium: "paid",
          campaign_id: "1",
          ad_id: "2",
          timestamp: "2026-07-01T12:00:00Z",
        },
        last_touch: {
          source: "facebook",
          medium: "paid",
          campaign_id: "1",
          ad_id: "2",
          timestamp: "2026-07-01T12:00:00Z",
        },
      }),
    },
  ];
  const report = buildCustomerEconomics({
    orders: [
      orderNode({
        id: "701",
        createdAt: "2026-07-15T12:00:00Z",
        customerId: "701",
        attrs: metaAttrs,
      }),
    ],
    ledgerByOrderId: new Map([["701", econ("701", { rev: 1000, cogs: 400 })]]),
    period: { since: "2026-07-01", until: "2026-07-31" },
    history: { since: "2026-07-01", until: "2026-07-31" },
    meta_spend_total: 5000,
    capture_started_at: "2026-09-06",
    attribution_coverage_pct: 80,
  });
  const c = report.customers[0];
  assert.strictEqual(c.first_order_acquisition, "Meta");
  assert.strictEqual(c.first_order_attribution_phase, "pre_capture");
  // Still appears in acquisition cohorts diagnostically
  assert.ok(
    report.acquisition_cohorts.some(
      (a) => a.acquisition === "Meta" && a.customers >= 1
    )
  );
  assert.strictEqual(report.observed_cac.post_capture_meta_new_customers, 0);
  assert.strictEqual(report.observed_cac.pre_capture_meta_new_customers_excluded, 1);
  assert.strictEqual(report.observed_cac.first_party_observed_new_customer_cac, null);
  assert.strictEqual(report.observed_cac.observed_gp_cac_ratio, null);
  assert.strictEqual(report.observed_cac.first_order_gp_after_observed_cac, null);
});

test("post_capture Meta customer included in FP CAC", () => {
  const metaAttrs = [
    {
      key: "_wa_attr",
      value: JSON.stringify({
        version: 1,
        first_touch: {
          source: "facebook",
          medium: "paid",
          campaign_id: "9",
          ad_id: "8",
          timestamp: "2026-09-07T12:00:00Z",
        },
        last_touch: {
          source: "facebook",
          medium: "paid",
          campaign_id: "9",
          ad_id: "8",
          timestamp: "2026-09-07T12:00:00Z",
        },
      }),
    },
  ];
  const report = buildCustomerEconomics({
    orders: [
      orderNode({
        id: "801",
        createdAt: "2026-09-07T12:00:00Z",
        customerId: "801",
        attrs: metaAttrs,
      }),
    ],
    ledgerByOrderId: new Map([
      ["801", econ("801", { rev: 2000, cogs: 800 })],
    ]),
    period: { since: "2026-09-06", until: "2026-09-10" },
    history: { since: "2026-09-06", until: "2026-09-10" },
    meta_spend_total: 1000,
    capture_started_at: "2026-09-06",
    attribution_coverage_pct: 60,
  });
  assert.strictEqual(
    report.customers[0].first_order_attribution_phase,
    "post_capture"
  );
  assert.strictEqual(report.observed_cac.post_capture_meta_new_customers, 1);
  assert.strictEqual(
    report.observed_cac.first_party_observed_new_customer_cac,
    1000
  );
  assert.ok(report.observed_cac.observed_gp_cac_ratio != null);
});

test("organic/unattributed excluded from FP CAC", () => {
  const report = buildCustomerEconomics({
    orders: [
      orderNode({
        id: "901",
        createdAt: "2026-09-07T12:00:00Z",
        customerId: "901",
      }),
    ],
    ledgerByOrderId: new Map([["901", econ("901")]]),
    period: { since: "2026-09-06", until: "2026-09-10" },
    meta_spend_total: 2000,
    capture_started_at: "2026-09-06",
    attribution_coverage_pct: 50,
  });
  assert.notStrictEqual(report.customers[0].first_order_acquisition, "Meta");
  assert.strictEqual(report.observed_cac.first_party_observed_new_customer_cac, null);
  assert.strictEqual(report.observed_cac.post_capture_meta_new_customers, 0);
});

test("zero eligible => CAC null", () => {
  const cac = buildObservedCac({
    customers: [
      {
        identified: true,
        first_order_date: "2026-08-05",
        first_order_acquisition: "Meta",
        first_order_attribution_phase: "pre_capture",
        lifetime_gp: 600,
        lifetime_recognized_revenue: 1500,
        recognized_orders: 1,
        first_order_gp: 600,
      },
    ],
    periodSince: "2026-08-01",
    periodUntil: "2026-08-31",
    metaSpendTotal: 2000,
    attributionCoveragePct: 50,
  });
  assert.strictEqual(cac.meta_new_customers, 0);
  assert.strictEqual(cac.first_party_observed_new_customer_cac, null);
  assert.strictEqual(cac.observed_gp_cac_ratio, null);
});

test("low attribution coverage caps confidence", () => {
  const customers = [];
  for (let i = 0; i < 20; i += 1) {
    customers.push({
      identified: true,
      first_order_date: "2026-09-07",
      first_order_acquisition: "Meta",
      first_order_attribution_phase: "post_capture",
      lifetime_gp: 500,
      lifetime_recognized_revenue: 1200,
      recognized_orders: 1,
      first_order_gp: 500,
    });
  }
  const low = buildObservedCac({
    customers,
    periodSince: "2026-09-06",
    periodUntil: "2026-09-10",
    metaSpendTotal: 10000,
    attributionCoveragePct: 10,
  });
  assert.strictEqual(low.meta_new_customers, 20);
  assert.strictEqual(low.confidence, "low");

  const missing = buildObservedCac({
    customers,
    periodSince: "2026-09-06",
    periodUntil: "2026-09-10",
    metaSpendTotal: 10000,
    attributionCoveragePct: null,
  });
  assert.ok(["low", "insufficient"].includes(missing.confidence));
  assert.strictEqual(missing.attribution_coverage_pct, null);
});

test("CAC denominator = post_capture Meta new only", () => {
  const customers = [
    {
      identified: true,
      first_order_date: "2026-08-05",
      first_order_acquisition: "Meta",
      first_order_attribution_phase: "post_capture",
      lifetime_gp: 600,
      lifetime_recognized_revenue: 1500,
      recognized_orders: 1,
      first_order_gp: 600,
    },
    {
      identified: true,
      first_order_date: "2026-08-06",
      first_order_acquisition: "organic",
      first_order_attribution_phase: "post_capture",
      lifetime_gp: 400,
      lifetime_recognized_revenue: 900,
      recognized_orders: 1,
      first_order_gp: 400,
    },
    {
      identified: true,
      first_order_date: "2026-08-07",
      first_order_acquisition: "Meta",
      first_order_attribution_phase: "pre_capture",
      lifetime_gp: 800,
      lifetime_recognized_revenue: 2000,
      recognized_orders: 1,
      first_order_gp: 500,
    },
  ];
  const cac = buildObservedCac({
    customers,
    periodSince: "2026-08-01",
    periodUntil: "2026-08-31",
    metaSpendTotal: 2000,
    attributionCoveragePct: 55,
  });
  assert.strictEqual(cac.meta_new_customers, 1);
  assert.strictEqual(cac.pre_capture_meta_new_customers_excluded, 1);
  assert.strictEqual(cac.first_party_observed_new_customer_cac, 2000);
  assert.strictEqual(cac.observed_gp_cac_ratio, round2ish(600 / 2000));
});

test("history join coverage + incomplete warning", () => {
  const ledger = new Map([
    ["501", econ("501")],
    ["502", econ("502")],
    ["999", econ("999")], // missing from GraphQL — no fabricated identity
  ]);
  const report = buildCustomerEconomics({
    orders: [
      orderNode({
        id: "501",
        createdAt: "2026-08-01",
        customerId: "90",
      }),
      orderNode({
        id: "502",
        createdAt: "2026-08-10",
        customerId: "90",
      }),
    ],
    ledgerByOrderId: ledger,
    period: { since: "2026-08-01", until: "2026-08-31" },
    history: { since: "2026-03-01", until: "2026-08-31" },
    attribution_coverage_pct: 40,
  });
  assert.strictEqual(report.history.history_since, "2026-03-01");
  assert.ok(report.history.history_days > 0);
  assert.strictEqual(report.summary.joined_recognized_shopify_orders, 2);
  assert.strictEqual(report.summary.ledger_recognized_shopify_orders, 3);
  assert.strictEqual(
    report.summary.recognized_orders_missing_shopify_match_count,
    1
  );
  assert.strictEqual(report.summary.history_join_coverage_pct, round2ish((2 / 3) * 100));
  assert.strictEqual(report.summary.history_incomplete, true);
  assert.ok(
    report.data_quality.warnings.some((w) => w.startsWith("history_incomplete"))
  );
  // missing order must not invent a customer
  assert.ok(
    !report.customers.some((c) => String(c.customer_key).includes("999"))
  );
});

function round2ish(n) {
  return Math.round(n * 100) / 100;
}

test("no raw email in report JSON", () => {
  const email = "secret.buyer@wearactive.test";
  const ledger = new Map([["77", econ("77")]]);
  const report = buildCustomerEconomics({
    orders: [
      orderNode({
        id: "77",
        createdAt: "2026-08-08",
        email,
      }),
    ],
    ledgerByOrderId: ledger,
    period: { since: "2026-08-01", until: "2026-08-31" },
  });
  const json = JSON.stringify(report);
  assert.ok(!json.includes(email));
  assert.ok(!json.includes("secret.buyer"));
  assertNoRawPii(json);
  assert.ok(
    report.period_orders[0].customer_key.startsWith("email_hash:")
  );
});

test("cohort reconciliation customer counts", () => {
  const ledger = new Map([
    ["401", econ("401")],
    ["402", econ("402")],
    ["403", econ("403")],
  ]);
  const report = buildCustomerEconomics({
    orders: [
      orderNode({
        id: "401",
        createdAt: "2026-07-02",
        customerId: "80",
      }),
      orderNode({
        id: "402",
        createdAt: "2026-07-10",
        customerId: "81",
      }),
      orderNode({
        id: "403",
        createdAt: "2026-08-03",
        customerId: "80",
      }),
    ],
    ledgerByOrderId: ledger,
    period: { since: "2026-07-01", until: "2026-08-31" },
  });
  const july = report.cohorts.find((c) => c.cohort === "2026-07");
  assert.strictEqual(july.customers, 2);
  const sumCohortCust = report.cohorts.reduce((s, c) => s + c.customers, 0);
  assert.strictEqual(sumCohortCust, report.customers.length);
});

test("same customer multiple orders observed value", () => {
  const ledger = new Map([
    ["501", econ("501", { rev: 1000, cogs: 400 })],
    ["502", econ("502", { rev: 1500, cogs: 500 })],
  ]);
  const report = buildCustomerEconomics({
    orders: [
      orderNode({
        id: "501",
        createdAt: "2026-07-01",
        customerId: "90",
      }),
      orderNode({
        id: "502",
        createdAt: "2026-08-01",
        customerId: "90",
      }),
    ],
    ledgerByOrderId: ledger,
    period: { since: "2026-07-01", until: "2026-08-31" },
  });
  const c = report.customers.find(
    (x) => x.customer_key === "shopify_customer:90"
  );
  assert.strictEqual(c.recognized_orders, 2);
  assert.strictEqual(c.lifetime_recognized_revenue, 2500);
  assert.strictEqual(c.lifetime_gp, 1600);
  assert.strictEqual(c.repeat_customer, true);
  assert.strictEqual(c.days_to_second_order, 31);
});

if (!process.exitCode) {
  console.log("\nAll customer economics self-tests passed.");
}
