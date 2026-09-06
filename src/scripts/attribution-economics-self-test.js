#!/usr/bin/env node
/**
 * Phase 5B attributed economics self-tests.
 */
const assert = require("assert");
const {
  indexRecognizedShopifyOrderEconomics,
  lookupOrderEconomics,
  shopifyOrderIdFromGid,
  shopifyOrderIdFromLedgerUid,
} = require("../attribution/ledgerJoin");
const {
  attributedEconomicsConfidence,
  addRecognizedOrderToBucket,
  emptyEntityBucket,
  finalizeEntityBucket,
} = require("../attribution/economics");
const { buildAttributedEconomics } = require("../attribution/entityEconomics");
const { matchMetaIds } = require("../attribution/metaMatch");
const { renderUnifiedDashboard } = require("../dashboard/html");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err.message || err);
  }
}

const LEDGER_HEADER = [
  "Date",
  "Entry Type",
  "Category",
  "Description",
  "SKU",
  "Qty",
  "Debit",
  "Credit",
  "Ref Key",
  "Source",
];

function saleRow(date, orderId, line, credit, qty = 1) {
  return [
    date,
    "Sale",
    "Shopify",
    "Tee",
    "SKU1",
    String(qty),
    "",
    String(credit),
    `SALE:SHOPIFY|${orderId}|${line}`,
    "Shopify",
  ];
}
function cogsRow(date, orderId, line, debit, qty = 1) {
  return [
    date,
    "COGS",
    "Shopify",
    "COGS Tee",
    "SKU1",
    String(qty),
    String(debit),
    "",
    `COGS:SHOPIFY|${orderId}|${line}`,
    "Shopify",
  ];
}

function gqlOrder(id, name, attrs) {
  return {
    id: `gid://shopify/Order/${id}`,
    name,
    createdAt: "2026-09-07T10:00:00+05:00",
    customAttributes: attrs || [],
  };
}

function waAttr(touch) {
  return [
    {
      key: "_wa_attr",
      value: JSON.stringify({
        version: 1,
        first_touch: touch,
        last_touch: touch,
        updated_at: "2026-09-07T10:00:00.000Z",
      }),
    },
  ];
}

test("shopifyOrderIdFromGid / ledger uid", () => {
  assert.strictEqual(
    shopifyOrderIdFromGid("gid://shopify/Order/12345"),
    "12345"
  );
  assert.strictEqual(
    shopifyOrderIdFromLedgerUid("SHOPIFY|12345|678"),
    "12345"
  );
});

test("ledger index reuses Sale+COGS; excludes unrecognized", () => {
  const rows = [
    saleRow("2026-09-07", "100", "a", 1000),
    cogsRow("2026-09-07", "100", "a", 400),
    // refunded-only / no sale should not count as recognized
    cogsRow("2026-09-07", "999", "x", 50),
  ];
  const idx = indexRecognizedShopifyOrderEconomics(
    rows,
    LEDGER_HEADER,
    "2026-09-01",
    "2026-09-10"
  );
  assert.ok(idx.has("100"));
  assert.ok(!idx.has("999"));
  const e = idx.get("100");
  assert.strictEqual(e.net_revenue_ex_tax, 1000);
  assert.strictEqual(e.cogs, 400);
  assert.strictEqual(e.gross_profit, 600);
});

test("cancelled/unrecognized GraphQL orders excluded from economics", () => {
  const idx = indexRecognizedShopifyOrderEconomics(
    [saleRow("2026-09-07", "100", "a", 1000), cogsRow("2026-09-07", "100", "a", 400)],
    LEDGER_HEADER,
    "2026-09-01",
    "2026-09-10"
  );
  const report = buildAttributedEconomics({
    orders: [
      gqlOrder("100", "#100", waAttr({
        source: "facebook",
        medium: "paid_social",
        campaign_id: "10",
        adset_id: "20",
        ad_id: "30",
        fbclid: "x",
      })),
      gqlOrder("200", "#200", waAttr({
        source: "facebook",
        medium: "paid_social",
        campaign_id: "10",
        fbclid: "y",
      })), // no ledger sale
    ],
    ledgerByOrderId: idx,
    metaEntities: {
      campaigns: [{ campaign_id: "10", campaign_name: "C", spend: 500 }],
      adsets: [{ adset_id: "20", adset_name: "S", spend: 500 }],
      ads: [{ ad_id: "30", ad_name: "A", spend: 500 }],
    },
    meta_spend_total: 500,
    shopify_channel: { net_revenue_ex_tax: 1000, orders: 1 },
    period: { since: "2026-09-01", until: "2026-09-10" },
  });
  assert.strictEqual(report.account.attributed_recognized_orders, 1);
  assert.strictEqual(report.account.attributed_revenue, 1000);
});

test("matched campaign / ad economics", () => {
  const idx = indexRecognizedShopifyOrderEconomics(
    [
      saleRow("2026-09-07", "1", "a", 2000),
      cogsRow("2026-09-07", "1", "a", 800),
    ],
    LEDGER_HEADER,
    "2026-09-01",
    "2026-09-10"
  );
  const report = buildAttributedEconomics({
    orders: [
      gqlOrder("1", "#1", waAttr({
        source: "facebook",
        medium: "paid",
        campaign_id: "10",
        adset_id: "20",
        ad_id: "30",
        fbclid: "z",
      })),
    ],
    ledgerByOrderId: idx,
    metaEntities: {
      campaigns: [{ campaign_id: "10", campaign_name: "Camp", spend: 400 }],
      adsets: [{ adset_id: "20", adset_name: "Set", spend: 400 }],
      ads: [{ ad_id: "30", ad_name: "Ad", spend: 400 }],
    },
    meta_spend_total: 400,
    shopify_channel: { net_revenue_ex_tax: 2000, orders: 1 },
    period: { since: "2026-09-01", until: "2026-09-10" },
  });
  const camp = report.campaigns.find((c) => c.id === "10");
  const ad = report.ads.find((a) => a.id === "30");
  assert.ok(camp.matched);
  assert.strictEqual(camp.orders, 1);
  assert.strictEqual(camp.revenue_ex_tax, 2000);
  assert.strictEqual(camp.cogs, 800);
  assert.strictEqual(camp.gross_profit, 1200);
  assert.strictEqual(camp.meta_spend, 400);
  assert.strictEqual(camp.first_party_cpa, 400);
  assert.strictEqual(camp.first_party_roas, 5);
  assert.strictEqual(camp.gp_roas, 3);
  assert.strictEqual(camp.contribution_after_meta, 800);
  assert.ok(ad.matched);
  assert.strictEqual(ad.orders, 1);
});

test("unmatched IDs kept unmatched (no fuzzy)", () => {
  const m = matchMetaIds(
    { campaign_id: "999", adset_id: "888", ad_id: "777" },
    {
      campaigns: [{ campaign_id: "10", campaign_name: "Other" }],
      adsets: [{ adset_id: "20" }],
      ads: [{ ad_id: "30" }],
    }
  );
  assert.ok(!m.campaign.matched);
  assert.ok(!m.adset.matched);
  assert.ok(!m.ad.matched);

  const idx = indexRecognizedShopifyOrderEconomics(
    [saleRow("2026-09-07", "5", "a", 500), cogsRow("2026-09-07", "5", "a", 100)],
    LEDGER_HEADER,
    "2026-09-01",
    "2026-09-10"
  );
  const report = buildAttributedEconomics({
    orders: [
      gqlOrder("5", "#5", waAttr({
        source: "facebook",
        medium: "paid",
        campaign_id: "999",
        ad_id: "777",
        fbclid: "u",
      })),
    ],
    ledgerByOrderId: idx,
    metaEntities: {
      campaigns: [{ campaign_id: "10", spend: 100 }],
      adsets: [],
      ads: [{ ad_id: "30", spend: 100 }],
    },
    meta_spend_total: 100,
    shopify_channel: { net_revenue_ex_tax: 500, orders: 1 },
    period: { since: "2026-09-01", until: "2026-09-10" },
  });
  const camp = report.campaigns.find((c) => c.id === "999");
  assert.ok(camp);
  assert.ok(!camp.matched);
  assert.ok(report.unmatched.campaign_ids >= 1);
});

test("unattributed orders excluded from entity totals", () => {
  const idx = indexRecognizedShopifyOrderEconomics(
    [
      saleRow("2026-09-07", "1", "a", 1000),
      cogsRow("2026-09-07", "1", "a", 400),
      saleRow("2026-09-07", "2", "a", 800),
      cogsRow("2026-09-07", "2", "a", 300),
    ],
    LEDGER_HEADER,
    "2026-09-01",
    "2026-09-10"
  );
  const report = buildAttributedEconomics({
    orders: [
      gqlOrder("1", "#1", waAttr({
        source: "facebook",
        medium: "paid",
        campaign_id: "10",
        fbclid: "a",
      })),
      gqlOrder("2", "#2", []), // unattributed
    ],
    ledgerByOrderId: idx,
    metaEntities: {
      campaigns: [{ campaign_id: "10", spend: 200 }],
      adsets: [],
      ads: [],
    },
    meta_spend_total: 200,
    shopify_channel: { net_revenue_ex_tax: 1800, orders: 2 },
    period: { since: "2026-09-01", until: "2026-09-10" },
  });
  assert.strictEqual(report.account.attributed_revenue, 1000);
  assert.strictEqual(report.account.unattributed_revenue, 800);
  assert.strictEqual(
    report.campaigns.find((c) => c.id === "10").revenue_ex_tax,
    1000
  );
});

test("Meta spend with zero attributed orders", () => {
  const report = buildAttributedEconomics({
    orders: [],
    ledgerByOrderId: new Map(),
    metaEntities: {
      campaigns: [{ campaign_id: "10", spend: 300 }],
      adsets: [],
      ads: [],
    },
    meta_spend_total: 300,
    shopify_channel: { net_revenue_ex_tax: 0, orders: 0 },
    period: { since: "2026-09-01", until: "2026-09-10" },
  });
  const camp = report.campaigns.find((c) => c.id === "10");
  assert.strictEqual(camp.meta_spend, 300);
  assert.strictEqual(camp.orders, 0);
  assert.strictEqual(camp.first_party_roas, 0);
  assert.strictEqual(camp.contribution_after_meta, -300);
});

test("orders with zero Meta spend", () => {
  const idx = indexRecognizedShopifyOrderEconomics(
    [saleRow("2026-09-07", "1", "a", 900), cogsRow("2026-09-07", "1", "a", 300)],
    LEDGER_HEADER,
    "2026-09-01",
    "2026-09-10"
  );
  const report = buildAttributedEconomics({
    orders: [
      gqlOrder("1", "#1", waAttr({
        source: "facebook",
        medium: "paid",
        campaign_id: "10",
        fbclid: "a",
      })),
    ],
    ledgerByOrderId: idx,
    metaEntities: {
      campaigns: [{ campaign_id: "10", spend: 0 }],
      adsets: [],
      ads: [],
    },
    meta_spend_total: 0,
    shopify_channel: { net_revenue_ex_tax: 900, orders: 1 },
    period: { since: "2026-09-01", until: "2026-09-10" },
  });
  const camp = report.campaigns.find((c) => c.id === "10");
  assert.strictEqual(camp.meta_spend, 0);
  assert.strictEqual(camp.first_party_roas, null);
  assert.strictEqual(camp.contribution_after_meta, 600);
});

test("no double-counting order across same entity", () => {
  const b = emptyEntityBucket("10", "C");
  const econ = {
    order_id: "1",
    units: 1,
    net_revenue_ex_tax: 100,
    cogs: 40,
    gross_profit: 60,
  };
  addRecognizedOrderToBucket(b, econ, "1");
  addRecognizedOrderToBucket(b, econ, "1");
  const f = finalizeEntityBucket(b);
  assert.strictEqual(f.orders, 1);
  assert.strictEqual(f.revenue_ex_tax, 100);
});

test("campaign totals reconcile with attributable order totals", () => {
  const idx = indexRecognizedShopifyOrderEconomics(
    [
      saleRow("2026-09-07", "1", "a", 1000),
      cogsRow("2026-09-07", "1", "a", 400),
      saleRow("2026-09-07", "2", "a", 500),
      cogsRow("2026-09-07", "2", "a", 200),
    ],
    LEDGER_HEADER,
    "2026-09-01",
    "2026-09-10"
  );
  const report = buildAttributedEconomics({
    orders: [
      gqlOrder("1", "#1", waAttr({
        source: "facebook",
        medium: "paid",
        campaign_id: "10",
        fbclid: "a",
      })),
      gqlOrder("2", "#2", waAttr({
        source: "facebook",
        medium: "paid",
        campaign_id: "10",
        fbclid: "b",
      })),
    ],
    ledgerByOrderId: idx,
    metaEntities: {
      campaigns: [{ campaign_id: "10", spend: 100 }],
      adsets: [],
      ads: [],
    },
    meta_spend_total: 100,
    shopify_channel: { net_revenue_ex_tax: 1500, orders: 2 },
    period: { since: "2026-09-01", until: "2026-09-10" },
  });
  const camp = report.campaigns.find((c) => c.id === "10");
  assert.strictEqual(camp.revenue_ex_tax, 1500);
  assert.strictEqual(camp.orders, 2);
  assert.strictEqual(report.account.attributed_revenue, 1500);
  assert.strictEqual(
    report.reconciliation.sum_entity_campaign_revenue_with_orders,
    1500
  );
});

test("coverage/confidence gates", () => {
  assert.strictEqual(
    attributedEconomicsConfidence({ attributed_recognized_orders: 3 }),
    "insufficient"
  );
  assert.strictEqual(
    attributedEconomicsConfidence({
      attributed_recognized_orders: 7,
      coverage_pct: 80,
    }),
    "low"
  );
  assert.strictEqual(
    attributedEconomicsConfidence({
      attributed_recognized_orders: 15,
      coverage_pct: 80,
    }),
    "medium"
  );
  assert.strictEqual(
    attributedEconomicsConfidence({
      attributed_recognized_orders: 40,
      coverage_pct: 80,
    }),
    "high"
  );
  assert.strictEqual(
    attributedEconomicsConfidence({
      attributed_recognized_orders: 40,
      coverage_pct: 50,
    }),
    "low"
  );
});

test("adset_id indexed in metaMatch", () => {
  const m = matchMetaIds(
    { adset_id: "55" },
    { campaigns: [], adsets: [{ adset_id: "55", adset_name: "S" }], ads: [] }
  );
  assert.ok(m.adset.matched);
});

test("dashboard experimental economics label", () => {
  const html = renderUnifiedDashboard({
    attribution_economics: {
      confidence: "low",
      observational_note: "Observational",
      account: {
        shopify_recognized_revenue: 1000,
        attributed_revenue: 400,
        unattributed_revenue: 600,
        attributed_coverage_pct: 40,
        meta_spend: 200,
        first_party_attributed_contribution: 50,
        post_capture_recognized_orders: 2,
        stable_id_coverage_pct: 50,
      },
      campaigns: [],
      adsets: [],
      ads: [],
      unmatched: {},
      warnings: ["small_attributed_sample"],
    },
  });
  assert.ok(/FIRST-PARTY ATTRIBUTED ECONOMICS — EXPERIMENTAL/.test(html));
  assert.ok(/view-attr-economics/.test(html));
  assert.ok(/Attr\. Economics/.test(html));
});

test("lookupOrderEconomics joins gid to ledger", () => {
  const idx = indexRecognizedShopifyOrderEconomics(
    [saleRow("2026-09-07", "42", "a", 100), cogsRow("2026-09-07", "42", "a", 40)],
    LEDGER_HEADER,
    "2026-09-01",
    "2026-09-10"
  );
  const e = lookupOrderEconomics(idx, {
    id: "gid://shopify/Order/42",
    name: "#99",
  });
  assert.ok(e);
  assert.strictEqual(e.net_revenue_ex_tax, 100);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
