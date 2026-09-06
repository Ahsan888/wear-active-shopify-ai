#!/usr/bin/env node
/**
 * Pure tests for Phase 3.5 sales provenance + dashboard rendering.
 */
const assert = require("assert");
const {
  saleChannel,
  addSaleToChannelAcc,
  addPaidCogsToChannelAcc,
  addRefundToChannelAcc,
  emptyChannelAccumulators,
  finalizeChannelAcc,
  buildSalesMixSummary,
  computeAdLoadMetrics,
  buildShopifyContributionContext,
  classifyShopifyContributionStatus,
  buildRevenueConcentration,
} = require("../profitability/salesMix");
const { aggregateLedgerPeriod } = require("../profitability/books");
const { classifyBusinessAdvertisingSafety } = require("../decisions/advertising");
const {
  buildDecisionReport,
  printDecisionReport,
} = require("../decisions/report");
const { renderDecisionDashboard } = require("../dashboard/html");
const { groupProductsByName } = require("../dashboard/groups");
const { escapeHtml } = require("../dashboard/format");

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

const ledgerHeader = [
  "Date",
  "Entry Type",
  "Source",
  "Category",
  "Description",
  "SKU",
  "Qty",
  "Debit",
  "Credit",
  "Owner",
  "Partner Split",
  "Ref Key",
  "Notes",
  "Created At",
];

test("Shopify sale identified by Shopify source", () => {
  assert.strictEqual(saleChannel("Shopify", "SALE:x"), "Shopify");
});

test("Shopify sale identified by Shopify SALE ref", () => {
  assert.strictEqual(saleChannel("Manual", "SALE:SHOPIFY|#100:a"), "Shopify");
  assert.strictEqual(saleChannel("", "SALE:SHOPIFY|oid|line"), "Shopify");
});

test("Manual sale maps to Manual", () => {
  assert.strictEqual(saleChannel("Manual", "SALE:MANUAL:1"), "Manual");
  assert.strictEqual(saleChannel("Walk-in", "SALE:WALKIN:1"), "Manual");
});

test("Other Sales maps to Other Sales", () => {
  assert.strictEqual(saleChannel("Other Sales", "SALE:OTHER:1"), "Other Sales");
});

test("Multi-line Shopify order counts once", () => {
  const acc = emptyChannelAccumulators();
  addSaleToChannelAcc(acc, {
    source: "Shopify",
    ref: "SALE:SHOPIFY|#55|line1",
    ymd: "2026-08-01",
    sku: "A",
    credit: 1000,
    qty: 1,
  });
  addSaleToChannelAcc(acc, {
    source: "Shopify",
    ref: "SALE:SHOPIFY|#55|line2",
    ymd: "2026-08-01",
    sku: "B",
    credit: 500,
    qty: 1,
  });
  const fin = finalizeChannelAcc(acc);
  assert.strictEqual(fin.Shopify.orders, 1);
  assert.strictEqual(fin.Shopify.revenue_ex_tax, 1500);
  assert.strictEqual(fin.Shopify.units, 2);
});

test("Multi-line Manual transaction counts by order-key behavior", () => {
  const acc = emptyChannelAccumulators();
  // Same uid → same order key
  addSaleToChannelAcc(acc, {
    source: "Manual",
    ref: "SALE:MANUAL-BATCH-9",
    ymd: "2026-08-02",
    sku: "A",
    credit: 2000,
    qty: 2,
  });
  addSaleToChannelAcc(acc, {
    source: "Manual",
    ref: "SALE:MANUAL-BATCH-9",
    ymd: "2026-08-02",
    sku: "B",
    credit: 1000,
    qty: 1,
  });
  const fin = finalizeChannelAcc(acc);
  assert.strictEqual(fin.Manual.orders, 1);
  assert.strictEqual(fin.Manual.revenue_ex_tax, 3000);
});

test("Revenue/units aggregate per channel", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "Sale", "Manual", "", "Tee", "S1", "2", "", "2000", "", "", "SALE:MANUAL:1", "", ""],
    ["2026-08-01", "Sale", "Other Sales", "", "Tee", "S1", "1", "", "500", "", "", "SALE:OTHER:1", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Shopify.revenue_ex_tax, 1000);
  assert.strictEqual(agg.sales_by_channel.Manual.revenue_ex_tax, 2000);
  assert.strictEqual(agg.sales_by_channel["Other Sales"].revenue_ex_tax, 500);
  assert.strictEqual(agg.sales_by_channel.Shopify.units, 1);
  assert.strictEqual(agg.sales_by_channel.Manual.units, 2);
});

test("Total channel revenue equals total sale revenue", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "Sale", "Manual", "", "Tee", "S1", "1", "", "2500", "", "", "SALE:MANUAL:2", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  const sum =
    agg.sales_by_channel.Shopify.revenue_ex_tax +
    agg.sales_by_channel.Manual.revenue_ex_tax +
    agg.sales_by_channel["Other Sales"].revenue_ex_tax;
  assert.strictEqual(sum, agg.books.revenue_ex_tax);
});

test("Global recognized order count behavior unchanged", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1|a", "", ""],
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S2", "1", "", "500", "", "", "SALE:SHOPIFY|#1|b", "", ""],
    ["2026-08-01", "Sale", "Manual", "", "Tee", "S1", "1", "", "800", "", "", "SALE:MANUAL:9", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.books.recognized_orders, 2); // shopify order + manual
  assert.strictEqual(agg.books.shopify_recognized_orders, 1);
  assert.strictEqual(agg.books.manual_recognized_orders, 1);
});

test("Gifts do not become paid channel revenue", () => {
  const rows = [
    ["2026-08-01", "Gift", "Shopify", "", "Gift", "S1", "1", "", "0", "", "", "GIFT:SHOPIFY|#9:a", "", ""],
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Shopify.revenue_ex_tax, 1000);
  assert.strictEqual(agg.books.gift_units, 1);
  assert.strictEqual(agg.books.recognized_orders, 1);
});

test("Shopify Sale + Shopify COGS → Shopify revenue and COGS", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Tee", "S1", "1", "400", "", "", "", "COGS:SHOPIFY|#1:a", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Shopify.revenue_ex_tax, 1000);
  assert.strictEqual(agg.sales_by_channel.Shopify.cogs, 400);
  assert.strictEqual(agg.sales_by_channel.Shopify.gross_profit, 600);
});

test("Manual Sale + Manual COGS → Manual", () => {
  const rows = [
    ["2026-08-01", "Sale", "Manual", "", "Tee", "S1", "1", "", "2000", "", "", "SALE:MANUAL:1", "", ""],
    ["2026-08-01", "COGS", "Manual", "", "COGS Tee", "S1", "1", "700", "", "", "", "COGS:MANUAL:1", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Manual.revenue_ex_tax, 2000);
  assert.strictEqual(agg.sales_by_channel.Manual.cogs, 700);
});

test("Other Sales Sale + COGS → Other Sales", () => {
  const rows = [
    ["2026-08-01", "Sale", "Other Sales", "", "Bulk", "S1", "10", "", "50000", "", "", "SALE:OTHER:1", "", ""],
    ["2026-08-01", "COGS", "Other Sales", "", "COGS Bulk", "S1", "10", "20000", "", "", "", "COGS:OTHER:1", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel["Other Sales"].revenue_ex_tax, 50000);
  assert.strictEqual(agg.sales_by_channel["Other Sales"].cogs, 20000);
});

test("Multi-line Shopify sale + corresponding COGS aggregates correctly", () => {
  const acc = emptyChannelAccumulators();
  addSaleToChannelAcc(acc, {
    source: "Shopify",
    ref: "SALE:SHOPIFY|#55|line1",
    ymd: "2026-08-01",
    sku: "A",
    credit: 1000,
    qty: 1,
  });
  addSaleToChannelAcc(acc, {
    source: "Shopify",
    ref: "SALE:SHOPIFY|#55|line2",
    ymd: "2026-08-01",
    sku: "B",
    credit: 500,
    qty: 1,
  });
  addPaidCogsToChannelAcc(acc, {
    source: "Shopify",
    ref: "COGS:SHOPIFY|#55|line1",
    debit: 400,
  });
  addPaidCogsToChannelAcc(acc, {
    source: "Shopify",
    ref: "COGS:SHOPIFY|#55|line2",
    debit: 200,
  });
  const fin = finalizeChannelAcc(acc);
  assert.strictEqual(fin.Shopify.orders, 1);
  assert.strictEqual(fin.Shopify.revenue_ex_tax, 1500);
  assert.strictEqual(fin.Shopify.cogs, 600);
  assert.strictEqual(fin.Shopify.gross_profit, 900);
});

test("Gift COGS excluded from paid Shopify contribution", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Tee", "S1", "1", "400", "", "", "", "COGS:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "Gift", "Shopify", "", "Gift", "S1", "1", "", "0", "", "", "GIFT:SHOPIFY|#9:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Gift", "S1", "1", "350", "", "", "", "COGS:SHOPIFY|#9:a", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Shopify.cogs, 400);
  assert.strictEqual(agg.books.cogs, 750);
  assert.strictEqual(agg.books.gift_cogs, 350);
  assert.strictEqual(agg.books.paid_cogs, 400);
});

test("Global Books COGS unchanged by channel split", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Tee", "S1", "1", "400", "", "", "", "COGS:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "Sale", "Manual", "", "Tee", "S1", "1", "", "2000", "", "", "SALE:MANUAL:1", "", ""],
    ["2026-08-01", "COGS", "Manual", "", "COGS Tee", "S1", "1", "700", "", "", "", "COGS:MANUAL:1", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.books.cogs, 1100);
  const channelSum =
    agg.sales_by_channel.Shopify.cogs +
    agg.sales_by_channel.Manual.cogs +
    agg.sales_by_channel["Other Sales"].cogs;
  assert.strictEqual(channelSum, agg.books.paid_cogs);
});

test("Channel split does not mutate existing product economics", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Tee", "S1", "1", "400", "", "", "", "COGS:SHOPIFY|#1:a", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  const prod = agg.products.find((p) => p.sku === "S1");
  assert.ok(prod);
  assert.strictEqual(prod.revenue_ex_tax, 1000);
  assert.strictEqual(prod.cogs, 400);
  assert.strictEqual(prod.gross_profit, 600);
});

test("Shopify GP = revenue - COGS; contribution = GP - Meta", () => {
  const ctx = buildShopifyContributionContext({
    sales_by_channel: {
      Shopify: {
        orders: 3,
        units: 3,
        revenue_ex_tax: 7153,
        refunds: 0,
        net_revenue_ex_tax: 7153,
        cogs: 2000,
        gross_profit: 5153,
        gross_margin_pct: 72.04,
      },
    },
    meta_spend: 8971,
    shopify_ad_load_per_recognized_order: 2990.33,
  });
  assert.strictEqual(ctx.gross_profit_before_ads, 5153);
  assert.strictEqual(ctx.contribution_after_meta, 5153 - 8971);
  assert.strictEqual(ctx.opex_allocated, false);
  assert.strictEqual(ctx.attribution_available, false);
});

test("Shopify sale + no refund → unchanged channel result", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Tee", "S1", "1", "400", "", "", "", "COGS:SHOPIFY|#1:a", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Shopify.revenue_ex_tax, 1000);
  assert.strictEqual(agg.sales_by_channel.Shopify.refunds, 0);
  assert.strictEqual(agg.sales_by_channel.Shopify.net_revenue_ex_tax, 1000);
  assert.strictEqual(agg.sales_by_channel.Shopify.gross_profit, 600);
});

test("Shopify refund reduces Shopify net revenue and GP", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Tee", "S1", "1", "400", "", "", "", "COGS:SHOPIFY|#1:a", "", ""],
    ["2026-08-02", "Refund", "Shopify", "", "Refund Tee", "S1", "1", "200", "", "", "", "REFUND:SHOPIFY|#1:a", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Shopify.revenue_ex_tax, 1000);
  assert.strictEqual(agg.sales_by_channel.Shopify.refunds, 200);
  assert.strictEqual(agg.sales_by_channel.Shopify.net_revenue_ex_tax, 800);
  assert.strictEqual(agg.sales_by_channel.Shopify.cogs, 400);
  assert.strictEqual(agg.sales_by_channel.Shopify.gross_profit, 400);
  assert.strictEqual(agg.books.refunds, 200);
  assert.strictEqual(agg.books.net_revenue_ex_tax, 800);
  assert.strictEqual(agg.books.cogs, 400);
  assert.strictEqual(agg.books.gross_profit, 400);
});

test("Shopify contribution uses net revenue denominator", () => {
  const ctx = buildShopifyContributionContext({
    sales_by_channel: {
      Shopify: {
        orders: 1,
        units: 1,
        revenue_ex_tax: 1000,
        refunds: 200,
        net_revenue_ex_tax: 800,
        cogs: 400,
        gross_profit: 400,
        gross_margin_pct: 50,
      },
    },
    meta_spend: 100,
    shopify_ad_load_per_recognized_order: 100,
  });
  assert.strictEqual(ctx.net_revenue_ex_tax, 800);
  assert.strictEqual(ctx.gross_profit_before_ads, 400);
  assert.strictEqual(ctx.contribution_after_meta, 300);
  assert.strictEqual(ctx.contribution_margin_after_meta_pct, 37.5);
});

test("Manual refund stays in Manual; Other Sales refund stays in Other Sales", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "Sale", "Manual", "", "Tee", "S1", "1", "", "2000", "", "", "SALE:MANUAL:1", "", ""],
    ["2026-08-01", "Sale", "Other Sales", "", "Bulk", "S1", "1", "", "5000", "", "", "SALE:OTHER:1", "", ""],
    ["2026-08-02", "Refund", "Manual", "", "Refund", "S1", "1", "300", "", "", "", "REFUND:MANUAL:1", "", ""],
    ["2026-08-02", "Refund", "Other Sales", "", "Refund", "S1", "1", "500", "", "", "", "REFUND:OTHER:1", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Shopify.refunds, 0);
  assert.strictEqual(agg.sales_by_channel.Shopify.net_revenue_ex_tax, 1000);
  assert.strictEqual(agg.sales_by_channel.Manual.refunds, 300);
  assert.strictEqual(agg.sales_by_channel.Manual.net_revenue_ex_tax, 1700);
  assert.strictEqual(agg.sales_by_channel["Other Sales"].refunds, 500);
  assert.strictEqual(agg.sales_by_channel["Other Sales"].net_revenue_ex_tax, 4500);
  assert.strictEqual(agg.books.refunds, 800);
  assert.strictEqual(agg.books.revenue_ex_tax, 8000);
  assert.strictEqual(agg.books.net_revenue_ex_tax, 7200);
});

test("Refund does not automatically reverse COGS", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Tee", "S1", "1", "400", "", "", "", "COGS:SHOPIFY|#1:a", "", ""],
    ["2026-08-02", "Refund", "Shopify", "", "Refund Tee", "S1", "1", "1000", "", "", "", "REFUND:SHOPIFY|#1:a", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Shopify.cogs, 400);
  assert.strictEqual(agg.sales_by_channel.Shopify.net_revenue_ex_tax, 0);
  assert.strictEqual(agg.sales_by_channel.Shopify.gross_profit, -400);
});

test("Explicit Ledger COGS reversal is respected", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Tee", "S1", "1", "400", "", "", "", "COGS:SHOPIFY|#1:a", "", ""],
    ["2026-08-02", "Refund", "Shopify", "", "Refund Tee", "S1", "1", "1000", "", "", "", "REFUND:SHOPIFY|#1:a", "", ""],
    ["2026-08-02", "COGS", "Shopify", "", "COGS reverse", "S1", "-1", "-400", "", "", "", "COGS:SHOPIFY|#1:rev", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_by_channel.Shopify.cogs, 0);
  assert.strictEqual(agg.books.cogs, 0);
});

test("zero/negative net Shopify revenue → safe contribution status, no Infinity", () => {
  const ctx = buildShopifyContributionContext({
    sales_by_channel: {
      Shopify: {
        orders: 1,
        units: 1,
        revenue_ex_tax: 500,
        refunds: 500,
        net_revenue_ex_tax: 0,
        cogs: 200,
        gross_profit: -200,
        gross_margin_pct: null,
      },
    },
    meta_spend: 100,
  });
  assert.strictEqual(ctx.contribution_margin_after_meta_pct, null);
  assert.strictEqual(ctx.contribution_status, "insufficient_data");
  assert.ok(Number.isFinite(ctx.contribution_after_meta));

  const neg = buildShopifyContributionContext({
    sales_by_channel: {
      Shopify: {
        orders: 1,
        units: 1,
        revenue_ex_tax: 500,
        refunds: 800,
        net_revenue_ex_tax: -300,
        cogs: 0,
        gross_profit: -300,
        gross_margin_pct: null,
      },
    },
    meta_spend: 50,
  });
  assert.strictEqual(neg.contribution_margin_after_meta_pct, null);
  assert.strictEqual(neg.contribution_status, "insufficient_data");
  assert.ok(Number.isFinite(neg.contribution_after_meta));
});

test("concentration uses net channel revenue; no-refund matches gross", () => {
  const noRefund = buildSalesMixSummary(
    {
      Shopify: {
        orders: 3,
        units: 3,
        revenue_ex_tax: 7153,
        refunds: 0,
        net_revenue_ex_tax: 7153,
        cogs: 0,
      },
      Manual: {
        orders: 25,
        units: 25,
        revenue_ex_tax: 56900,
        refunds: 0,
        net_revenue_ex_tax: 56900,
        cogs: 0,
      },
      "Other Sales": {
        orders: 1,
        units: 1,
        revenue_ex_tax: 247000,
        refunds: 0,
        net_revenue_ex_tax: 247000,
        cogs: 0,
      },
    },
    {
      revenue_ex_tax: 311053,
      net_revenue_ex_tax: 311053,
      refunds: 0,
      recognized_orders: 29,
      recognized_units: 29,
    }
  );
  const concNo = buildRevenueConcentration(noRefund);
  assert.strictEqual(concNo.basis, "net_revenue");
  assert.ok(concNo.dominant_channel_revenue_share_pct >= 79);
  assert.strictEqual(
    concNo.dominant_channel_revenue_share_pct,
    noRefund.channels.find((c) => c.channel === "Other Sales").net_revenue_share_pct
  );
  assert.strictEqual(
    noRefund.channels.find((c) => c.channel === "Other Sales").gross_revenue_share_pct,
    noRefund.channels.find((c) => c.channel === "Other Sales").net_revenue_share_pct
  );

  const withRefund = buildSalesMixSummary(
    {
      Shopify: {
        orders: 3,
        units: 3,
        revenue_ex_tax: 10000,
        refunds: 5000,
        net_revenue_ex_tax: 5000,
        cogs: 0,
      },
      Manual: {
        orders: 1,
        units: 1,
        revenue_ex_tax: 1000,
        refunds: 0,
        net_revenue_ex_tax: 1000,
        cogs: 0,
      },
      "Other Sales": {
        orders: 1,
        units: 1,
        revenue_ex_tax: 4000,
        refunds: 0,
        net_revenue_ex_tax: 4000,
        cogs: 0,
      },
    },
    {
      revenue_ex_tax: 15000,
      net_revenue_ex_tax: 10000,
      refunds: 5000,
      recognized_orders: 5,
      recognized_units: 5,
    }
  );
  const concRefund = buildRevenueConcentration(withRefund);
  assert.strictEqual(concRefund.dominant_channel, "Shopify");
  assert.strictEqual(concRefund.dominant_channel_revenue_share_pct, 50);
  assert.strictEqual(concRefund.is_materially_concentrated, false);
});

test("exposing channel refunds does not change business health/affordability", () => {
  const sales_by_channel = {
    Shopify: {
      orders: 3,
      units: 3,
      revenue_ex_tax: 8000,
      refunds: 847.44,
      net_revenue_ex_tax: 7152.56,
      cogs: 4773.3,
      gross_profit: 2379.26,
      gross_margin_pct: 33.26,
    },
    Manual: {
      orders: 25,
      units: 25,
      revenue_ex_tax: 56900,
      refunds: 0,
      net_revenue_ex_tax: 56900,
      cogs: 20000,
      gross_profit: 36900,
      gross_margin_pct: 64.85,
    },
    "Other Sales": {
      orders: 1,
      units: 1,
      revenue_ex_tax: 247000,
      refunds: 0,
      net_revenue_ex_tax: 247000,
      cogs: 80000,
      gross_profit: 167000,
      gross_margin_pct: 67.61,
    },
  };
  const sales_mix = buildSalesMixSummary(sales_by_channel, {
    recognized_orders: 29,
    recognized_units: 29,
    revenue_ex_tax: 311900,
    net_revenue_ex_tax: 311052.56,
    refunds: 847.44,
    paid_cogs: 104773.3,
  });
  const report = buildDecisionReport({
    date_range: {
      since: "2026-08-01",
      until: "2026-08-07",
      is_full_calendar_month: false,
    },
    books: {
      net_revenue_ex_tax: 311052.56,
      revenue_ex_tax: 311900,
      gross_margin_pct: 67,
      recognized_orders: 29,
    },
    profitability: {
      meta_adjusted_profit: 68461,
      meta_adjusted_margin_pct: 22,
      break_even_cpa: 2670,
      break_even_ad_spend: 77430,
      profit_before_ads: 77430,
    },
    blended: {
      business_wide_ad_load_per_recognized_order: 310,
      shopify_ad_load_per_recognized_order: 2990,
      blended_ad_cost_per_recognized_order: 310,
    },
    sales_by_channel,
    sales_mix,
    meta: {
      account: { currency: "PKR" },
      totals: { spend: 8971, purchases: 4, cpa: 2242, roas: 1.2 },
    },
    products: [],
    warnings: [],
    campaigns: [],
    ads: [],
  });
  assert.strictEqual(report.business_health.status, "strongly_profitable");
  assert.strictEqual(
    report.business_advertising_safety.status,
    "large_safety_margin"
  );
  assert.ok(report.executive_summary.one_liner.includes("ad-spend affordability"));
  assert.ok(!report.executive_summary.one_liner.includes("ads safety"));
});

test("positive contribution status", () => {
  const s = classifyShopifyContributionStatus({
    revenue_ex_tax: 10000,
    contribution_after_meta: 2000,
    contribution_margin_after_meta_pct: 20,
  });
  assert.strictEqual(s.status, "positive_contribution");
});

test("negative contribution status", () => {
  const s = classifyShopifyContributionStatus({
    revenue_ex_tax: 10000,
    contribution_after_meta: -3000,
    contribution_margin_after_meta_pct: -30,
  });
  assert.strictEqual(s.status, "negative_contribution");
});

test("near-zero contribution status", () => {
  const s = classifyShopifyContributionStatus({
    revenue_ex_tax: 10000,
    contribution_after_meta: 200,
    contribution_margin_after_meta_pct: 2,
  });
  assert.strictEqual(s.status, "near_zero");
});

test("zero Shopify revenue → insufficient_data", () => {
  const s = classifyShopifyContributionStatus({
    revenue_ex_tax: 0,
    contribution_after_meta: -100,
    contribution_margin_after_meta_pct: null,
  });
  assert.strictEqual(s.status, "insufficient_data");
});

test("zero Shopify orders → ad load null", () => {
  const m = computeAdLoadMetrics({
    meta_spend: 9000,
    recognized_orders: 10,
    shopify_recognized_orders: 0,
  });
  assert.strictEqual(m.shopify_ad_load_per_recognized_order, null);
  const ctx = buildShopifyContributionContext({
    sales_by_channel: {
      Shopify: {
        orders: 0,
        units: 0,
        revenue_ex_tax: 0,
        cogs: 0,
        gross_profit: 0,
        gross_margin_pct: null,
      },
    },
    meta_spend: 9000,
    shopify_ad_load_per_recognized_order: null,
  });
  assert.strictEqual(ctx.ad_load_per_recognized_order, null);
});

test("business health/affordability/scale unchanged by Shopify contribution", () => {
  const sales_by_channel = {
    Shopify: {
      orders: 3,
      units: 3,
      revenue_ex_tax: 7000,
      cogs: 3000,
      gross_profit: 4000,
      gross_margin_pct: 57.14,
    },
    Manual: {
      orders: 20,
      units: 20,
      revenue_ex_tax: 50000,
      cogs: 20000,
      gross_profit: 30000,
      gross_margin_pct: 60,
    },
    "Other Sales": {
      orders: 1,
      units: 1,
      revenue_ex_tax: 247000,
      cogs: 100000,
      gross_profit: 147000,
      gross_margin_pct: 59.51,
    },
  };
  const sales_mix = buildSalesMixSummary(sales_by_channel, {
    recognized_orders: 24,
    recognized_units: 24,
    revenue_ex_tax: 304000,
    paid_cogs: 123000,
  });
  const report = buildDecisionReport({
    date_range: {
      since: "2026-08-01",
      until: "2026-08-07",
      is_full_calendar_month: false,
    },
    books: {
      net_revenue_ex_tax: 304000,
      revenue_ex_tax: 304000,
      gross_margin_pct: 59.5,
      recognized_orders: 24,
      shopify_recognized_orders: 3,
    },
    profitability: {
      meta_adjusted_profit: 68000,
      meta_adjusted_margin_pct: 22,
      break_even_cpa: 2670,
      break_even_ad_spend: 64080,
      profit_before_ads: 64080,
    },
    blended: {
      business_wide_ad_load_per_recognized_order: 375,
      shopify_ad_load_per_recognized_order: 3000,
      blended_ad_cost_per_recognized_order: 375,
    },
    sales_by_channel,
    sales_mix,
    meta: {
      account: { currency: "PKR" },
      totals: {
        spend: 9000,
        purchases: 4,
        cpa: 2250,
        roas: 1.2,
        impressions: 1000,
        ctr: 2,
      },
    },
    products: [],
    warnings: [],
    campaigns: [],
    ads: [
      {
        id: "a1",
        name: "Winner",
        spend: 5000,
        purchases: 8,
        cpa: 625,
        roas: 3,
        impressions: 50000,
        ctr: 3,
        landing_page_views: 1000,
        add_to_carts: 80,
        initiated_checkouts: 40,
      },
    ],
  });
  assert.strictEqual(report.business_health.status, "strongly_profitable");
  assert.strictEqual(
    report.business_advertising_safety.status,
    "large_safety_margin"
  );
  assert.ok(report.shopify_context.contribution_after_meta < 0);
  assert.strictEqual(report.shopify_context.opex_allocated, false);
  // Negative Shopify contribution must not block scale gating inputs
  assert.strictEqual(
    report.business_advertising_safety.status,
    "large_safety_margin"
  );
});

test("Other Sales 79% → materially concentrated", () => {
  const mix = buildSalesMixSummary(
    {
      Shopify: { orders: 3, units: 3, revenue_ex_tax: 7153, cogs: 0 },
      Manual: { orders: 25, units: 25, revenue_ex_tax: 56900, cogs: 0 },
      "Other Sales": { orders: 1, units: 1, revenue_ex_tax: 247000, cogs: 0 },
    },
    { revenue_ex_tax: 311053, recognized_orders: 29, recognized_units: 29 }
  );
  const conc = buildRevenueConcentration(mix);
  assert.strictEqual(conc.dominant_channel, "Other Sales");
  assert.ok(conc.dominant_channel_revenue_share_pct >= 79);
  assert.strictEqual(conc.is_materially_concentrated, true);
  assert.strictEqual(conc.non_shopify_distortion_risk, true);
  assert.ok(/Other Sales/.test(conc.warning));
});

test("Manual 65% → materially concentrated", () => {
  const mix = buildSalesMixSummary(
    {
      Shopify: { orders: 5, units: 5, revenue_ex_tax: 20000, cogs: 0 },
      Manual: { orders: 20, units: 20, revenue_ex_tax: 65000, cogs: 0 },
      "Other Sales": { orders: 2, units: 2, revenue_ex_tax: 15000, cogs: 0 },
    },
    { revenue_ex_tax: 100000, recognized_orders: 27, recognized_units: 27 }
  );
  const conc = buildRevenueConcentration(mix);
  assert.strictEqual(conc.dominant_channel, "Manual");
  assert.strictEqual(conc.is_materially_concentrated, true);
  assert.strictEqual(conc.non_shopify_distortion_risk, true);
});

test("Shopify 70% → concentrated but no non-Shopify distortion warning", () => {
  const mix = buildSalesMixSummary(
    {
      Shopify: { orders: 20, units: 20, revenue_ex_tax: 70000, cogs: 0 },
      Manual: { orders: 5, units: 5, revenue_ex_tax: 20000, cogs: 0 },
      "Other Sales": { orders: 2, units: 2, revenue_ex_tax: 10000, cogs: 0 },
    },
    { revenue_ex_tax: 100000, recognized_orders: 27, recognized_units: 27 }
  );
  const conc = buildRevenueConcentration(mix);
  assert.strictEqual(conc.dominant_channel, "Shopify");
  assert.strictEqual(conc.is_materially_concentrated, true);
  assert.strictEqual(conc.non_shopify_distortion_risk, false);
  assert.strictEqual(conc.warning, null);
});

test("40/35/25 mix → not materially concentrated", () => {
  const mix = buildSalesMixSummary(
    {
      Shopify: { orders: 10, units: 10, revenue_ex_tax: 40000, cogs: 0 },
      Manual: { orders: 8, units: 8, revenue_ex_tax: 35000, cogs: 0 },
      "Other Sales": { orders: 5, units: 5, revenue_ex_tax: 25000, cogs: 0 },
    },
    { revenue_ex_tax: 100000, recognized_orders: 23, recognized_units: 23 }
  );
  const conc = buildRevenueConcentration(mix);
  assert.strictEqual(conc.is_materially_concentrated, false);
  assert.strictEqual(conc.non_shopify_distortion_risk, false);
});

test("concentration warning never changes business health", () => {
  const sales_by_channel = {
    Shopify: {
      orders: 3,
      units: 3,
      revenue_ex_tax: 7153,
      cogs: 2000,
      gross_profit: 5153,
      gross_margin_pct: 72,
    },
    Manual: {
      orders: 25,
      units: 25,
      revenue_ex_tax: 56900,
      cogs: 20000,
      gross_profit: 36900,
      gross_margin_pct: 65,
    },
    "Other Sales": {
      orders: 1,
      units: 1,
      revenue_ex_tax: 247000,
      cogs: 80000,
      gross_profit: 167000,
      gross_margin_pct: 67.6,
    },
  };
  const sales_mix = buildSalesMixSummary(sales_by_channel, {
    recognized_orders: 29,
    recognized_units: 29,
    revenue_ex_tax: 311053,
    paid_cogs: 102000,
  });
  const report = buildDecisionReport({
    date_range: {
      since: "2026-08-01",
      until: "2026-08-07",
      is_full_calendar_month: false,
    },
    books: {
      net_revenue_ex_tax: 311053,
      revenue_ex_tax: 311053,
      gross_margin_pct: 67,
      recognized_orders: 29,
    },
    profitability: {
      meta_adjusted_profit: 68461,
      meta_adjusted_margin_pct: 22,
      break_even_cpa: 2670,
      break_even_ad_spend: 77430,
      profit_before_ads: 77430,
    },
    blended: {
      business_wide_ad_load_per_recognized_order: 310,
      shopify_ad_load_per_recognized_order: 2990,
      blended_ad_cost_per_recognized_order: 310,
    },
    sales_by_channel,
    sales_mix,
    meta: {
      account: { currency: "PKR" },
      totals: { spend: 8971, purchases: 4, cpa: 2242, roas: 1.2 },
    },
    products: [],
    warnings: [],
    campaigns: [],
    ads: [],
  });
  assert.ok(report.revenue_concentration.non_shopify_distortion_risk);
  assert.strictEqual(report.business_health.status, "strongly_profitable");
  assert.strictEqual(
    report.business_advertising_safety.status,
    "large_safety_margin"
  );
});

test("business-wide ad load uses all recognized orders", () => {
  const m = computeAdLoadMetrics({
    meta_spend: 9000,
    recognized_orders: 30,
    shopify_recognized_orders: 18,
  });
  assert.strictEqual(m.business_wide_ad_load_per_recognized_order, 300);
});

test("Shopify ad load uses only Shopify recognized orders", () => {
  const m = computeAdLoadMetrics({
    meta_spend: 9000,
    recognized_orders: 30,
    shopify_recognized_orders: 18,
  });
  assert.strictEqual(m.shopify_ad_load_per_recognized_order, 500);
});

test("zero Shopify orders → Shopify ad load null", () => {
  const m = computeAdLoadMetrics({
    meta_spend: 9000,
    recognized_orders: 10,
    shopify_recognized_orders: 0,
  });
  assert.strictEqual(m.shopify_ad_load_per_recognized_order, null);
});

test("Shopify ad load never drives business ads safety", () => {
  // High Shopify load but low business-wide load → still large safety
  const safety = classifyBusinessAdvertisingSafety({
    meta_spend: 9000,
    recognized_orders: 29,
    break_even_cpa: 2670,
    break_even_ad_spend: 77400,
    net_revenue_ex_tax: 311000,
  });
  assert.strictEqual(safety.status, "large_safety_margin");
  const shopifyLoad = 9000 / 10; // if wrongly used with 10 shopify orders
  assert.ok(shopifyLoad > safety.business_wide_ad_load_per_recognized_order);
});

test("Meta CPA remains separate", () => {
  const report = buildDecisionReport({
    date_range: { since: "2026-08-01", until: "2026-08-07", is_full_calendar_month: false },
    books: {
      net_revenue_ex_tax: 100000,
      revenue_ex_tax: 100000,
      gross_margin_pct: 30,
      recognized_orders: 20,
      shopify_recognized_orders: 12,
    },
    profitability: {
      meta_adjusted_profit: 20000,
      meta_adjusted_margin_pct: 20,
      break_even_cpa: 2000,
      break_even_ad_spend: 40000,
      profit_before_ads: 40000,
    },
    blended: {
      business_wide_ad_load_per_recognized_order: 500,
      shopify_ad_load_per_recognized_order: 833.33,
      blended_ad_cost_per_recognized_order: 500,
    },
    sales_by_channel: {
      Shopify: { orders: 12, units: 20, revenue_ex_tax: 60000 },
      Manual: { orders: 5, units: 8, revenue_ex_tax: 30000 },
      "Other Sales": { orders: 3, units: 4, revenue_ex_tax: 10000 },
    },
    sales_mix: buildSalesMixSummary(
      {
        Shopify: { orders: 12, units: 20, revenue_ex_tax: 60000 },
        Manual: { orders: 5, units: 8, revenue_ex_tax: 30000 },
        "Other Sales": { orders: 3, units: 4, revenue_ex_tax: 10000 },
      },
      { recognized_orders: 20, recognized_units: 32, revenue_ex_tax: 100000 }
    ),
    meta: {
      account: { currency: "PKR" },
      totals: { spend: 10000, purchases: 4, cpa: 2500, roas: 1.2, impressions: 1000, ctr: 2 },
    },
    products: [],
    warnings: [],
    campaigns: [],
    ads: [],
  });
  assert.strictEqual(report.meta_efficiency.meta_attributed_cpa, 2500);
  assert.notStrictEqual(
    report.meta_efficiency.meta_attributed_cpa,
    report.business_advertising_safety.business_wide_ad_load_per_recognized_order
  );
  assert.strictEqual(report.shopify_context.shopify_ad_load_per_recognized_order, 833.33);
});

function fixtureReport(overrides = {}) {
  const base = {
    generated_at: "2026-09-06T00:00:00.000Z",
    date_range: {
      since: "2026-08-31",
      until: "2026-09-06",
      timezone: "Asia/Karachi",
      is_full_calendar_month: false,
    },
    safety: { advisory_only: true, mutations: "none" },
    business_health: {
      status: "strongly_profitable",
      reason: "strong margins",
    },
    business_advertising_safety: {
      status: "large_safety_margin",
      meta_spend: 9000,
      business_wide_ad_load_per_recognized_order: 310,
      blended_ad_cost_per_recognized_order: 310,
      break_even_cpa: 2670,
      business_cpa_headroom: 2360,
      business_cpa_headroom_pct: 88,
      ad_spend_utilization_pct: 12,
    },
    shopify_context: {
      recognized_orders: 17,
      recognized_units: 100,
      revenue_ex_tax: 200000,
      refunds: 0,
      net_revenue_ex_tax: 200000,
      cogs: 80000,
      gross_profit_before_ads: 120000,
      gross_margin_before_ads_pct: 60,
      meta_spend: 9000,
      ad_load_per_recognized_order: 529,
      shopify_recognized_orders: 17,
      shopify_ad_load_per_recognized_order: 529,
      contribution_after_meta: 111000,
      contribution_margin_after_meta_pct: 55.5,
      contribution_status: "positive_contribution",
      attribution_available: false,
      opex_allocated: false,
      note: "Date-aligned Shopify contribution context using net recognized Shopify revenue after Ledger refunds.",
    },
    revenue_concentration: {
      dominant_channel: "Shopify",
      dominant_channel_revenue_share_pct: 64.3,
      dominant_channel_orders: 17,
      is_materially_concentrated: true,
      non_shopify_distortion_risk: false,
      warning: null,
      category: "business_context",
    },
    sales_mix: buildSalesMixSummary(
      {
        Shopify: {
          orders: 17,
          units: 100,
          revenue_ex_tax: 200000,
          cogs: 80000,
          gross_profit: 120000,
          gross_margin_pct: 60,
        },
        Manual: {
          orders: 9,
          units: 50,
          revenue_ex_tax: 90000,
          cogs: 30000,
          gross_profit: 60000,
          gross_margin_pct: 66.67,
        },
        "Other Sales": {
          orders: 3,
          units: 18,
          revenue_ex_tax: 21000,
          cogs: 7000,
          gross_profit: 14000,
          gross_margin_pct: 66.67,
        },
      },
      {
        recognized_orders: 29,
        recognized_units: 168,
        revenue_ex_tax: 311000,
        paid_cogs: 117000,
      }
    ),
    sales_by_channel: {
      Shopify: {
        orders: 17,
        units: 100,
        revenue_ex_tax: 200000,
        cogs: 80000,
        gross_profit: 120000,
        gross_margin_pct: 60,
      },
      Manual: {
        orders: 9,
        units: 50,
        revenue_ex_tax: 90000,
        cogs: 30000,
        gross_profit: 60000,
        gross_margin_pct: 66.67,
      },
      "Other Sales": {
        orders: 3,
        units: 18,
        revenue_ex_tax: 21000,
        cogs: 7000,
        gross_profit: 14000,
        gross_margin_pct: 66.67,
      },
    },
    books: {
      net_revenue_ex_tax: 311000,
      revenue_ex_tax: 311000,
      gross_margin_pct: 30,
      recognized_orders: 29,
      shopify_recognized_orders: 17,
    },
    profitability: {
      meta_adjusted_profit: 68000,
      meta_adjusted_margin_pct: 22,
      break_even_cpa: 2670,
      break_even_ad_spend: 77400,
    },
    meta_efficiency: {
      status: "ok",
      meta_attributed_cpa: 2250,
      meta_attributed_roas: 1.2,
      meta_attributed_purchases: 4,
      meta_spend: 9000,
    },
    meta: {
      account: { currency: "PKR", name: "WA" },
      totals: {
        spend: 9000,
        purchases: 4,
        cpa: 2250,
        roas: 1.2,
        impressions: 20000,
        ctr: 2.1,
      },
      funnel_baselines: {
        ctr: 2.1,
        lpv_to_atc_pct: 5,
        atc_to_checkout_pct: 60,
        checkout_to_purchase_pct: 50,
      },
    },
    products: [
      {
        sku: "WA-FF-1",
        product: "FlexFlow",
        status: "data_issue",
        reason_code: "missing_ledger_cogs",
        reason: "Missing Ledger COGS",
        revenue_ex_tax: 5000,
        units: 2,
        gross_profit: 5000,
        gross_margin_pct: 100,
        revenue_share_pct: 2,
        evidence: { expected_vm_cogs: 2000 },
        expected_vm_cogs: 2000,
      },
      {
        sku: "WA-FF-2",
        product: "FlexFlow",
        status: "data_issue",
        reason_code: "missing_ledger_cogs",
        reason: "Missing Ledger COGS",
        revenue_ex_tax: 5000,
        units: 2,
        gross_profit: 5000,
        gross_margin_pct: 100,
        revenue_share_pct: 2,
        evidence: { expected_vm_cogs: 2000 },
        expected_vm_cogs: 2000,
      },
    ],
    recommendations: [
      {
        id: "1",
        priority: "high",
        action: "review_high_cpa",
        area: "ad",
        entity_name: "Ad A",
        reason: "High CPA",
        reason_code: "high_cpa",
        confidence: "medium",
      },
      {
        id: "2",
        priority: "medium",
        action: "fix_product_data",
        area: "product",
        entity_name: "FlexFlow",
        reason: "Missing Ledger COGS",
        reason_code: "missing_ledger_cogs",
        confidence: "low",
      },
      {
        id: "3",
        priority: "low",
        action: "monitor",
        area: "product",
        entity_name: "Hero",
        reason: "Hero product",
        reason_code: "hero_product",
        confidence: "high",
      },
    ],
    ads: [],
    campaigns: [],
    confidence: {
      business: "high",
      advertising: "high",
      entities: "medium",
      products: "medium",
      attribution: "unavailable",
      notes: { attribution: "No Meta→Shopify attribution" },
    },
    data_quality: {
      warnings: [
        {
          code: "meta_vs_ledger_ads_variance",
          severity: "warning",
          message: "Meta spend differs from Ledger Ads",
        },
      ],
      ad_reconciliation: {
        meta_spend: 9000,
        ledger_ads_expense: 0,
        recurring_ads_expense: 0,
        meta_vs_ledger_variance: 9000,
        ad_spend_reconciliation_status: "partial_period_not_comparable",
      },
    },
    no_order_level_attribution: true,
  };
  return { ...base, ...overrides };
}

test("HTML renders business status", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("STRONGLY PROFITABLE"));
});

test("HTML shows Business Ad-Spend Affordability", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("Business Ad-Spend Affordability"));
  assert.ok(!html.includes(">Advertising Safety<"));
});

test("HTML shows Shopify context section", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("Shopify / Ecommerce Context"));
  assert.ok(html.includes("Contribution after Meta"));
});

test("HTML shows DATE-ALIGNED · NOT ATTRIBUTED", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("DATE-ALIGNED · NOT ATTRIBUTED"));
});

test("HTML shows Shopify revenue and COGS", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("Shopify gross revenue") || html.includes("Shopify net revenue"));
  assert.ok(html.includes("Shopify COGS"));
  assert.ok(html.includes("Shopify refunds"));
  assert.ok(html.includes("Shopify net revenue"));
});

test("HTML renders sales mix", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("Sales Mix"));
  assert.ok(html.includes("Net Revenue"));
  assert.ok(html.includes("Shopify"));
  assert.ok(html.includes("Manual"));
  assert.ok(html.includes("Other Sales"));
});

test("HTML renders Shopify ad-load label", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("Shopify ad load"));
});

test("HTML contains non-attribution / no-opex disclaimer", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(
    /does not mean every Shopify order came from Meta|Shared opex|opex is not allocated|Not attributed/i.test(
      html
    )
  );
});

test("negative Shopify contribution uses warning styling", () => {
  const html = renderDecisionDashboard(
    fixtureReport({
      shopify_context: {
        ...fixtureReport().shopify_context,
        contribution_after_meta: -5000,
        contribution_margin_after_meta_pct: -25,
        contribution_status: "negative_contribution",
      },
    })
  );
  assert.ok(html.includes("NEGATIVE CONTRIBUTION"));
  assert.ok(html.includes("tone-bad"));
});

test("positive contribution uses healthy styling", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("POSITIVE CONTRIBUTION"));
  assert.ok(/tone-ok[^>]*>POSITIVE CONTRIBUTION|POSITIVE CONTRIBUTION[\s\S]*tone-ok/i.test(html) || html.includes('tone-ok">POSITIVE CONTRIBUTION') || html.includes("pill tone-ok"));
});

test("non-Shopify concentration warning renders", () => {
  const html = renderDecisionDashboard(
    fixtureReport({
      revenue_concentration: {
        dominant_channel: "Other Sales",
        dominant_channel_revenue_share_pct: 79.4,
        dominant_channel_orders: 1,
        is_materially_concentrated: true,
        non_shopify_distortion_risk: true,
        warning:
          "79.4% of recognized revenue in this period came from Other Sales. Whole-business profitability and ad-spend affordability are therefore not representative of ecommerce performance alone.",
        category: "business_context",
      },
    })
  );
  assert.ok(html.includes("Business Mix Context"));
  assert.ok(html.includes("Other Sales"));
  assert.ok(html.includes("79.4%"));
});

test("business health card remains independent", () => {
  const html = renderDecisionDashboard(
    fixtureReport({
      shopify_context: {
        ...fixtureReport().shopify_context,
        contribution_status: "negative_contribution",
        contribution_after_meta: -10000,
      },
      revenue_concentration: {
        dominant_channel: "Other Sales",
        dominant_channel_revenue_share_pct: 79.4,
        is_materially_concentrated: true,
        non_shopify_distortion_risk: true,
        warning: "mix warning",
      },
    })
  );
  assert.ok(html.includes("Business Health"));
  assert.ok(html.includes("STRONGLY PROFITABLE"));
  assert.ok(html.includes("Business Ad-Spend Affordability"));
  assert.ok(html.includes("LARGE SAFETY MARGIN"));
});

test("terminal labels use Ad-Spend Affordability", () => {
  let out = "";
  const orig = console.log;
  console.log = (...args) => {
    out += args.join(" ") + "\n";
  };
  try {
    printDecisionReport(fixtureReport());
  } finally {
    console.log = orig;
  }
  assert.ok(out.includes("BUSINESS AD-SPEND AFFORDABILITY"));
  assert.ok(out.includes("SHOPIFY / ECOMMERCE CONTEXT"));
  assert.ok(out.includes("Contribution after Meta"));
  assert.ok(out.includes("Shopify refunds") || out.includes("Shopify net revenue"));
});

test("executive one-liner says ad-spend affordability", () => {
  const report = buildDecisionReport({
    date_range: {
      since: "2026-08-01",
      until: "2026-08-07",
      is_full_calendar_month: false,
    },
    books: {
      net_revenue_ex_tax: 100000,
      revenue_ex_tax: 100000,
      gross_margin_pct: 30,
      recognized_orders: 20,
    },
    profitability: {
      meta_adjusted_profit: 20000,
      meta_adjusted_margin_pct: 20,
      break_even_cpa: 2000,
      break_even_ad_spend: 40000,
      profit_before_ads: 40000,
    },
    blended: {
      business_wide_ad_load_per_recognized_order: 500,
      shopify_ad_load_per_recognized_order: 833.33,
      blended_ad_cost_per_recognized_order: 500,
    },
    sales_by_channel: {
      Shopify: {
        orders: 12,
        units: 20,
        revenue_ex_tax: 60000,
        refunds: 0,
        net_revenue_ex_tax: 60000,
        cogs: 0,
        gross_profit: 60000,
        gross_margin_pct: 100,
      },
      Manual: {
        orders: 5,
        units: 8,
        revenue_ex_tax: 30000,
        refunds: 0,
        net_revenue_ex_tax: 30000,
        cogs: 0,
        gross_profit: 30000,
        gross_margin_pct: 100,
      },
      "Other Sales": {
        orders: 3,
        units: 4,
        revenue_ex_tax: 10000,
        refunds: 0,
        net_revenue_ex_tax: 10000,
        cogs: 0,
        gross_profit: 10000,
        gross_margin_pct: 100,
      },
    },
    meta: {
      account: { currency: "PKR" },
      totals: { spend: 10000, purchases: 4, cpa: 2500, roas: 1.2 },
    },
    products: [],
    warnings: [],
    campaigns: [],
    ads: [],
  });
  assert.ok(
    report.executive_summary.one_liner.includes("ad-spend affordability")
  );
  assert.ok(!report.executive_summary.one_liner.includes("ads safety"));
});

test("HTML renders high/medium/low recommendations", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("<h3>High</h3>"));
  assert.ok(html.includes("<h3>Medium</h3>"));
  assert.ok(html.includes("<h3>Low</h3>"));
  assert.ok(html.includes("review_high_cpa"));
});

test("groups duplicate product names visually while preserving SKU evidence", () => {
  const groups = groupProductsByName(fixtureReport().products);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].sku_count, 2);
  assert.strictEqual(groups[0].skus.length, 2);
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("WA-FF-1"));
  assert.ok(html.includes("WA-FF-2"));
  assert.ok(html.includes("2 SKU"));
});

test("data issue product renders warning rather than hero styling", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("DATA ISSUE"));
  assert.ok(html.includes("missing_ledger_cogs") || html.includes("Missing Ledger COGS"));
  assert.ok(!html.includes(">HERO<"));
});

test("no scale candidate shows safe empty state", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("No ads currently have enough evidence for controlled scaling"));
});

test("scale candidate displays controlled-review language", () => {
  const html = renderDecisionDashboard(
    fixtureReport({
      ads: [
        {
          entity_type: "ad",
          entity_id: "1",
          entity_name: "Winner Ad",
          status: "scale_candidate",
          spend: 5000,
          purchases: 5,
          meta_attributed_cpa: 1000,
          meta_attributed_roas: 2,
          has_funnel_warning: false,
        },
      ],
    })
  );
  assert.ok(html.includes("Controlled budget increase candidate"));
  assert.ok(html.includes("do not auto-scale"));
});

test("accounting variance appears", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(html.includes("meta_vs_ledger_ads_variance") || html.includes("Meta − Ledger") || html.includes("Meta vs Ledger"));
});

test("tip spans render as HTML not escaped text", () => {
  const html = renderDecisionDashboard(fixtureReport());
  assert.ok(
    html.includes('<span class="tip" title='),
    "tip span should be real HTML"
  );
  assert.ok(
    !html.includes("&lt;span class=&quot;tip&quot;"),
    "tip span must not be HTML-escaped into visible text"
  );
  assert.ok(/Meta CPA\s*<span class="tip"/.test(html));
  assert.ok(/Meta ROAS\s*<span class="tip"/.test(html));
});

test("HTML escapes entity/product names correctly", () => {
  assert.strictEqual(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  const html = renderDecisionDashboard(
    fixtureReport({
      products: [
        {
          sku: "X",
          product: `<img src=x onerror=alert(1)>`,
          status: "hero",
          reason_code: "top",
          reason: "ok",
          revenue_ex_tax: 1000,
          units: 1,
          gross_profit: 400,
          gross_margin_pct: 40,
          revenue_share_pct: 10,
          cogs: 600,
        },
      ],
    })
  );
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img"));
});

test("embedded JSON is valid / safely escaped", () => {
  const html = renderDecisionDashboard(fixtureReport());
  const m = html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/);
  assert.ok(m, "report-data embed expected");
  const decoded = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const parsed = JSON.parse(decoded);
  assert.strictEqual(parsed.no_order_level_attribution, true);
  assert.ok(parsed.sales_mix);
});

// ——— Unified dashboard coverage ———
const {
  buildUnifiedReportingBundle,
  annotateEntityCpaEvidence,
  sanitizeBundleForEmbed,
} = require("../dashboard/bundle");
const { renderUnifiedDashboard } = require("../dashboard/html");
const { cpaEvidenceParts } = require("../dashboard/format");

function unifiedFixture(overrides = {}) {
  const base = fixtureReport({
    books: {
      ...fixtureReport().books,
      gross_collected: 320000,
      output_tax: 9000,
      refunds: 0,
      delivery_expense: 5000,
      other_non_ad_opex: 8000,
      total_opex: 22000,
      books_net_profit: 60000,
      books_net_margin_pct: 19,
      ads_expense_booked: 9000,
      recognized_units: 168,
      aov_ex_tax: 10724,
      gift_cogs: 0,
      paid_cogs: 117000,
      cogs: 117000,
      gross_profit: 194000,
    },
    profitability: {
      ...fixtureReport().profitability,
      profit_before_ads: 69000,
      pre_ad_profit_margin: 22,
      break_even_roas: 3.5,
      meta_spend_treatment:
        "analytical_replacement_only_not_additional_expense",
    },
    expense_by_category: { Delivery: 5000, Ads: 9000, Rent: 3000 },
    pipeline: {
      open_pipeline_orders: 4,
      open_pipeline_units: 6,
      open_pipeline_gross: 12000,
      pipeline_not_revenue: true,
    },
    campaigns: [
      {
        entity_type: "campaign",
        entity_id: "c1",
        entity_name: "Summer Campaign",
        status: "healthy",
        spend: 4000,
        purchases: 4,
        impressions: 10000,
        meta_attributed_cpa: 1000,
        meta_attributed_roas: 2,
        entity_cpa_vs_account_ratio: 0.44,
        spend_vs_account_cpa: 1.78,
        has_funnel_warning: false,
      },
    ],
    adsets: [
      {
        entity_type: "adset",
        entity_id: "as1",
        entity_name: "Broad Adset",
        status: "watch",
        spend: 2000,
        purchases: 0,
        impressions: 5000,
        meta_attributed_cpa: null,
        meta_attributed_roas: null,
        entity_cpa_vs_account_ratio: null,
        spend_vs_account_cpa: 0.89,
        has_funnel_warning: false,
      },
    ],
    ads: [
      {
        entity_type: "ad",
        entity_id: "a1",
        entity_name: "Purchase Ad",
        status: "high_cpa",
        spend: 4950,
        purchases: 2,
        impressions: 8000,
        meta_attributed_cpa: 2475,
        meta_attributed_roas: 1.1,
        entity_cpa_vs_account_ratio: 1.44,
        spend_vs_account_cpa: 2.89,
        has_funnel_warning: false,
      },
      {
        entity_type: "ad",
        entity_id: "a2",
        entity_name: "Zero Purchase Ad",
        status: "spend_no_purchase",
        spend: 2540,
        purchases: 0,
        impressions: 4000,
        meta_attributed_cpa: null,
        meta_attributed_roas: null,
        entity_cpa_vs_account_ratio: null,
        spend_vs_account_cpa: 1.13,
        has_funnel_warning: true,
      },
      {
        entity_type: "ad",
        entity_id: "a3",
        entity_name: "Scale Ad",
        status: "scale_candidate",
        spend: 5000,
        purchases: 5,
        impressions: 20000,
        meta_attributed_cpa: 1000,
        meta_attributed_roas: 2,
        entity_cpa_vs_account_ratio: 0.58,
        spend_vs_account_cpa: 2.91,
        has_funnel_warning: false,
      },
    ],
    no_order_level_attribution: true,
  });
  return { ...base, ...overrides };
}

test("unified views render", () => {
  const html = renderUnifiedDashboard(unifiedFixture());
  assert.ok(html.includes('id="view-overview"'));
  assert.ok(html.includes('id="view-profitability"'));
  assert.ok(html.includes('id="view-sales"') || html.includes("Sales"));
  assert.ok(html.includes('id="view-products"'));
  assert.ok(html.includes('id="view-advertising"'));
  assert.ok(html.includes('id="view-decisions"'));
  assert.ok(html.includes('id="view-data-quality"'));
  assert.ok(html.includes('data-view="overview"'));
  assert.ok(html.includes('data-view="profitability"'));
  assert.ok(html.includes('data-view="data-quality"'));
});

test("Books net profit and Meta-adjusted profit displayed", () => {
  const html = renderUnifiedDashboard(unifiedFixture());
  assert.ok(html.includes("Books net profit") || html.includes("Books Net Profit"));
  assert.ok(html.includes("Meta-adjusted"));
  assert.ok(
    /replaces booked Ads|not deducted twice|analytical/i.test(html)
  );
});

test("reconciliation and channels and Shopify contribution render", () => {
  const html = renderUnifiedDashboard(unifiedFixture());
  assert.ok(/reconcil|Meta.*Ledger|Ledger.*Recurring/i.test(html));
  assert.ok(html.includes("Shopify"));
  assert.ok(html.includes("Manual"));
  assert.ok(html.includes("Other Sales"));
  assert.ok(html.includes("Contribution after Meta") || html.includes("contribution after Meta"));
  assert.ok(/DATE-ALIGNED|NOT ATTRIBUTED/i.test(html));
});

test("revenue concentration warning renders", () => {
  const html = renderUnifiedDashboard(
    unifiedFixture({
      revenue_concentration: {
        dominant_channel: "Other Sales",
        dominant_channel_revenue_share_pct: 79.4,
        dominant_channel_orders: 1,
        is_materially_concentrated: true,
        non_shopify_distortion_risk: true,
        warning:
          "79.4% of recognized net revenue came from Other Sales.",
        category: "business_context",
      },
    })
  );
  assert.ok(/Other Sales|79\.4|concentration|mix context/i.test(html));
});

test("missing Ledger COGS flagged; incomplete aggregate not hero GM", () => {
  const html = renderUnifiedDashboard(
    unifiedFixture({
      product_groups: [
        {
          product: "FlexFlow",
          status: "data_issue",
          reason_code: "missing_ledger_cogs",
          reason: "Missing Ledger COGS",
          sku_count: 2,
          revenue_ex_tax: 10000,
          units: 4,
          cogs: 0,
          gross_profit: 10000,
          incomplete_cogs_coverage: true,
          gross_margin_pct: null,
          aggregate_margin_note: "incomplete",
          skus: [
            {
              sku: "WA-FF-1",
              status: "data_issue",
              reason_code: "missing_ledger_cogs",
              revenue_ex_tax: 5000,
              cogs: 0,
              units: 2,
              gross_profit: 5000,
              gross_margin_pct: 100,
            },
          ],
        },
      ],
    })
  );
  assert.ok(/missing_ledger_cogs|DATA ISSUE|incomplete/i.test(html));
  assert.ok(!/>HERO</.test(html));
});

test("Meta account summary and funnel render", () => {
  const html = renderUnifiedDashboard(unifiedFixture());
  assert.ok(/Impressions|Landing|Add to Cart|Checkout|Purchase/i.test(html));
  assert.ok(html.includes("Summer Campaign") || html.includes("campaign"));
});

test("purchasing entity CPA ratio = entity CPA / account CPA", () => {
  const e = annotateEntityCpaEvidence({
    purchases: 2,
    meta_attributed_cpa: 2475,
    entity_cpa_vs_account_ratio: 1.44,
    spend_vs_account_cpa: 2.89,
  });
  const parts = cpaEvidenceParts(e);
  assert.strictEqual(parts.cpa_available, true);
  assert.strictEqual(parts.cpa, 2475);
  assert.strictEqual(parts.ratio, 1.44);
  assert.strictEqual(parts.ratio_label, "vs account CPA");
  // Must NOT use spend/account CPA as the purchasing ratio
  assert.notStrictEqual(parts.ratio, 2.89);
});

test("zero-purchase entity shows CPA unavailable + spend evidence label", () => {
  const e = annotateEntityCpaEvidence({
    purchases: 0,
    meta_attributed_cpa: null,
    entity_cpa_vs_account_ratio: null,
    spend_vs_account_cpa: 1.13,
  });
  const parts = cpaEvidenceParts(e);
  assert.strictEqual(parts.cpa_available, false);
  assert.strictEqual(parts.cpa, null);
  assert.strictEqual(parts.ratio, 1.13);
  assert.strictEqual(parts.ratio_label, "Spend evidence vs account CPA");

  const html = renderUnifiedDashboard(unifiedFixture());
  assert.ok(html.includes("Spend evidence vs account CPA"));
  assert.ok(html.includes("Zero Purchase Ad"));
  assert.ok(html.includes("Purchase Ad"));
});

test("scale candidate wording remains controlled", () => {
  const html = renderUnifiedDashboard(unifiedFixture());
  assert.ok(html.includes("Controlled budget increase candidate"));
  assert.ok(/do not auto-scale/i.test(html));
  assert.ok(!/guaranteed winner|automatically scale|profitable ad/i.test(html));
});

test("no product Meta ROAS claim", () => {
  const html = renderUnifiedDashboard(unifiedFixture());
  // Disclaimer wording is OK; do not claim product ROAS as a metric table
  assert.ok(
    /no product Meta ROAS|Books only|not product[- ]level/i.test(html) ||
      !/Product Meta ROAS\s*Rs/i.test(html)
  );
  assert.ok(!/product Meta ROAS\s*[:=]/i.test(html));
});

test("attribution unavailable, pipeline, confidence, print button", () => {
  const html = renderUnifiedDashboard(unifiedFixture());
  assert.ok(/ORDER-LEVEL ATTRIBUTION|attribution.*UNAVAILABLE|No Meta→Shopify/i.test(html));
  assert.ok(/Open pipeline|open_pipeline|not recognized revenue/i.test(html));
  assert.ok(/Confidence|Business/i.test(html));
  assert.ok(/Print|Save PDF|window\.print/i.test(html));
  assert.ok(html.includes("<style>") && html.includes("<script>"));
  assert.ok(!/cdn\.|unpkg|jsdelivr|googleapis\.com\/css/i.test(html));
});

test("embedded JSON escapes script end and rejects secrets", () => {
  const html = renderUnifiedDashboard(
    unifiedFixture({ evil: "</script><script>alert(1)</script>" })
  );
  const m = html.match(
    /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/
  );
  assert.ok(m);
  assert.ok(!m[1].includes("</script>"));
  assert.ok(m[1].includes("&lt;/script&gt;") || m[1].includes("&lt;"));
  const bundle = sanitizeBundleForEmbed(buildUnifiedReportingBundle({
    date_range: { since: "2026-08-01", until: "2026-08-07", is_full_calendar_month: false },
    books: { net_revenue_ex_tax: 1000, recognized_orders: 5, gross_margin_pct: 30 },
    profitability: { meta_adjusted_profit: 100, meta_adjusted_margin_pct: 10, break_even_cpa: 200, break_even_ad_spend: 1000 },
    blended: { business_wide_ad_load_per_recognized_order: 50 },
    meta: { account: { currency: "PKR" }, totals: { spend: 100, purchases: 1, cpa: 100, roas: 1 } },
    products: [],
    warnings: [],
    campaigns: [],
    ads: [],
    adsets: [],
  }));
  assert.ok(bundle.safety.no_sheet_writes);
  assert.throws(() =>
    sanitizeBundleForEmbed({ access_token: "EAAABCDEFG1234567890" })
  );
});

test("bundle does not mutate inputs / presentation only", () => {
  const inputs = {
    date_range: { since: "2026-08-01", until: "2026-08-07", is_full_calendar_month: false },
    books: {
      net_revenue_ex_tax: 100000,
      revenue_ex_tax: 100000,
      gross_margin_pct: 30,
      recognized_orders: 20,
      books_net_profit: 15000,
      ads_expense_booked: 5000,
    },
    profitability: {
      meta_adjusted_profit: 20000,
      meta_adjusted_margin_pct: 20,
      break_even_cpa: 2000,
      break_even_ad_spend: 40000,
      profit_before_ads: 20000,
    },
    blended: {
      business_wide_ad_load_per_recognized_order: 500,
      shopify_ad_load_per_recognized_order: 800,
    },
    sales_by_channel: {
      Shopify: { orders: 10, units: 10, revenue_ex_tax: 50000, refunds: 0, net_revenue_ex_tax: 50000, cogs: 20000, gross_profit: 30000, gross_margin_pct: 60 },
      Manual: { orders: 5, units: 5, revenue_ex_tax: 30000, refunds: 0, net_revenue_ex_tax: 30000, cogs: 10000, gross_profit: 20000, gross_margin_pct: 66 },
      "Other Sales": { orders: 5, units: 5, revenue_ex_tax: 20000, refunds: 0, net_revenue_ex_tax: 20000, cogs: 5000, gross_profit: 15000, gross_margin_pct: 75 },
    },
    meta: { account: { currency: "PKR" }, totals: { spend: 10000, purchases: 4, cpa: 2500, roas: 1.2, impressions: 1, ctr: 1 } },
    products: [],
    warnings: [],
    campaigns: [],
    ads: [],
    adsets: [],
    pipeline: { open_pipeline_orders: 1, open_pipeline_gross: 100, open_pipeline_units: 1 },
  };
  const before = JSON.stringify(inputs.books);
  const bundle = buildUnifiedReportingBundle(inputs);
  assert.strictEqual(JSON.stringify(inputs.books), before);
  assert.strictEqual(bundle.safety.presentation_only, true);
  assert.strictEqual(bundle.safety.no_meta_mutations, true);
});

test("paid-channel COGS/GP/GM from salesMix (excludes gift)", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Tee", "S1", "1", "400", "", "", "", "COGS:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "Sale", "Manual", "", "Tee", "S1", "1", "", "2000", "", "", "SALE:MANUAL:1", "", ""],
    ["2026-08-01", "COGS", "Manual", "", "COGS Tee", "S1", "1", "700", "", "", "", "COGS:MANUAL:1", "", ""],
    ["2026-08-01", "Sale", "Other Sales", "", "Bulk", "S1", "1", "", "3000", "", "", "SALE:OTHER:1", "", ""],
    ["2026-08-01", "COGS", "Other Sales", "", "COGS Bulk", "S1", "1", "1000", "", "", "", "COGS:OTHER:1", "", ""],
    ["2026-08-01", "Gift", "Shopify", "", "Gift", "S1", "1", "", "0", "", "", "GIFT:SHOPIFY|#9:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Gift", "S1", "1", "350", "", "", "", "COGS:SHOPIFY|#9:a", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  const t = agg.sales_mix.totals;
  assert.strictEqual(t.paid_channel_cogs, 2100);
  assert.strictEqual(t.cogs, 2100); // BC alias = paid channel sum
  assert.strictEqual(agg.books.gift_cogs, 350);
  assert.strictEqual(agg.books.cogs, 2450);
  assert.strictEqual(t.net_revenue_ex_tax, 6000);
  assert.strictEqual(t.paid_channel_gross_profit, 3900);
  assert.strictEqual(t.paid_channel_gross_margin_pct, 65);
  assert.strictEqual(agg.sales_mix.cogs_reconciliation.status, "reconciled");
  assert.strictEqual(agg.sales_mix.cogs_reconciliation.gift_cogs, 350);
  // Gift COGS lowers Books GM vs paid-channel GM
  assert.ok(agg.books.gross_margin_pct < t.paid_channel_gross_margin_pct);
});

test("refunds reduce paid-channel net before GP/GM; zero net → GM null", () => {
  const rows = [
    ["2026-08-01", "Sale", "Shopify", "", "Tee", "S1", "1", "", "1000", "", "", "SALE:SHOPIFY|#1:a", "", ""],
    ["2026-08-01", "COGS", "Shopify", "", "COGS Tee", "S1", "1", "400", "", "", "", "COGS:SHOPIFY|#1:a", "", ""],
    ["2026-08-02", "Refund", "Shopify", "", "Refund", "S1", "1", "1000", "", "", "", "REFUND:SHOPIFY|#1:a", "", ""],
  ];
  const agg = aggregateLedgerPeriod(rows, ledgerHeader, "2026-08-01", "2026-08-31", {});
  assert.strictEqual(agg.sales_mix.totals.net_revenue_ex_tax, 0);
  assert.strictEqual(agg.sales_mix.totals.paid_channel_gross_profit, -400);
  assert.strictEqual(agg.sales_mix.totals.paid_channel_gross_margin_pct, null);
});

test("Sales HTML renders Paid Sales Total GM from upstream totals", () => {
  const mix = buildSalesMixSummary(
    {
      Shopify: {
        orders: 3,
        units: 3,
        revenue_ex_tax: 7153,
        refunds: 0,
        net_revenue_ex_tax: 7153,
        cogs: 4773,
        gross_profit: 2380,
        gross_margin_pct: 33.27,
      },
      Manual: {
        orders: 25,
        units: 25,
        revenue_ex_tax: 56900,
        refunds: 0,
        net_revenue_ex_tax: 56900,
        cogs: 20000,
        gross_profit: 36900,
        gross_margin_pct: 64.85,
      },
      "Other Sales": {
        orders: 1,
        units: 1,
        revenue_ex_tax: 247000,
        refunds: 0,
        net_revenue_ex_tax: 247000,
        cogs: 80000,
        gross_profit: 167000,
        gross_margin_pct: 67.61,
      },
    },
    {
      recognized_orders: 29,
      recognized_units: 29,
      revenue_ex_tax: 311053,
      net_revenue_ex_tax: 311053,
      refunds: 0,
      paid_cogs: 104773,
    }
  );
  assert.ok(mix.totals.paid_channel_gross_margin_pct != null);
  const html = renderUnifiedDashboard(
    unifiedFixture({
      sales_by_channel: mix.sales_by_channel,
      sales_mix: mix,
      books: {
        ...unifiedFixture().books,
        gross_margin_pct: 29.87,
        cogs: 105123,
        gift_cogs: 350,
        net_revenue_ex_tax: 311053,
      },
    })
  );
  assert.ok(html.includes("Paid Sales Total"));
  assert.ok(html.includes("Gift/PR"));
  assert.ok(html.includes("Paid Sales GM"));
  assert.ok(html.includes("Books GM") || /Gross margin/i.test(html));
  // Must show a numeric paid GM, not em dash alone in total row context
  assert.ok(
    html.includes(`${mix.totals.paid_channel_gross_margin_pct}%`) ||
      html.includes(String(mix.totals.paid_channel_gross_margin_pct))
  );
  // Renderer must not invent gross_margin_pct on totals
  assert.strictEqual(mix.totals.gross_margin_pct, undefined);
});

test("unified bundle passes paid_channel totals through", () => {
  const mix = buildSalesMixSummary(
    {
      Shopify: {
        orders: 1,
        units: 1,
        revenue_ex_tax: 1000,
        refunds: 0,
        net_revenue_ex_tax: 1000,
        cogs: 400,
        gross_profit: 600,
        gross_margin_pct: 60,
      },
      Manual: {
        orders: 0,
        units: 0,
        revenue_ex_tax: 0,
        refunds: 0,
        net_revenue_ex_tax: 0,
        cogs: 0,
        gross_profit: 0,
        gross_margin_pct: null,
      },
      "Other Sales": {
        orders: 0,
        units: 0,
        revenue_ex_tax: 0,
        refunds: 0,
        net_revenue_ex_tax: 0,
        cogs: 0,
        gross_profit: 0,
        gross_margin_pct: null,
      },
    },
    { revenue_ex_tax: 1000, net_revenue_ex_tax: 1000, refunds: 0, recognized_orders: 1 }
  );
  const bundle = buildUnifiedReportingBundle({
    date_range: {
      since: "2026-08-01",
      until: "2026-08-07",
      is_full_calendar_month: false,
    },
    books: {
      net_revenue_ex_tax: 1000,
      revenue_ex_tax: 1000,
      gross_margin_pct: 50,
      recognized_orders: 1,
      cogs: 500,
      gift_cogs: 100,
    },
    profitability: {
      meta_adjusted_profit: 100,
      meta_adjusted_margin_pct: 10,
      break_even_cpa: 200,
      break_even_ad_spend: 200,
      profit_before_ads: 200,
    },
    blended: { business_wide_ad_load_per_recognized_order: 50 },
    sales_by_channel: mix.sales_by_channel,
    sales_mix: mix,
    meta: {
      account: { currency: "PKR" },
      totals: { spend: 50, purchases: 1, cpa: 50, roas: 1 },
    },
    products: [],
    warnings: [],
    campaigns: [],
    ads: [],
    adsets: [],
  });
  assert.strictEqual(
    bundle.sales_mix.totals.paid_channel_gross_margin_pct,
    60
  );
  assert.strictEqual(bundle.sales_mix.totals.paid_channel_cogs, 400);
});

// ——— Dashboard UX hardening coverage ———
function marketingUxFixture(overrides = {}) {
  return unifiedFixture({
    marketing_decisions: {
      summary: { scale_count: 0, hold_count: 1, reduce_count: 0, pause_count: 1 },
      account_decision: { recommendation: "HOLD_SPEND", confidence: "high" },
      evidence_quality: {
        marketing_evidence_confidence: "medium",
        fp_evidence: { status: "immature", attributed_coverage_pct: null },
      },
      owner_action_queue: [{
        priority: "P1",
        primary_action: "PAUSE",
        entity_name: "Weak Ad",
        spend: 2500,
        purchases: 0,
        meta_cpa: null,
        confidence: "medium",
        reason_codes: ["ZERO_PURCHASE_SPEND"],
        reason: "Rs 2500 · ZERO_PURCHASE_SPEND",
      }],
      scale_candidates: [],
      reduce_candidates: [],
      pause_candidates: [],
      creative_tests: [],
      promotion_tests: [],
      inventory_constraints: [],
      data_quality: { blockers: [] },
      ...overrides,
    },
  });
}

test("Marketing action queue uses owner-friendly labels and complete columns", () => {
  const html = renderUnifiedDashboard(marketingUxFixture());
  assert.ok(html.includes("Ranked action queue"));
  for (const heading of ["Priority", "Action", "Ad / entity", "Why", "Spend", "Purchases", "CPA", "Confidence"]) {
    assert.ok(html.includes(heading), `missing ${heading}`);
  }
  assert.ok(html.includes("Spent enough for a normal purchase but generated none."));
  assert.ok(html.includes("Technical details"));
  assert.ok(!/<strong>ZERO_PURCHASE_SPEND<\/strong>/.test(html));
});

test("account posture has a clear explanation", () => {
  const html = renderUnifiedDashboard(marketingUxFixture());
  assert.ok(html.includes("Account posture"));
  assert.ok(html.includes("HOLD SPEND"));
  assert.ok(html.includes("Keep the account steady and act on weak ads individually."));
});

test("Overview renders Do This Today action queue", () => {
  const html = renderUnifiedDashboard(marketingUxFixture());
  assert.ok(html.includes("Do This Today") || html.includes("Top 5 actions"));
  assert.ok(html.includes("Weak Ad"));
  assert.ok(html.includes("priority-P1"));
});

test("null and insufficient states are explicit", () => {
  const html = renderUnifiedDashboard(marketingUxFixture());
  assert.ok(html.includes("No purchases"));
  assert.ok(html.includes("First-party attribution is still collecting data."));
  assert.ok(html.includes("No scale candidates currently meet the evidence threshold."));
  assert.ok(html.includes("No product mapping exists yet, so inventory constraints cannot be applied to Meta ads."));
});

test("print rendering expands details and preserves all views", () => {
  const html = renderUnifiedDashboard(marketingUxFixture());
  assert.ok(html.includes("beforeprint"));
  assert.ok(html.includes("afterprint"));
  assert.ok(/@media print[\s\S]*\.view \{ display: block !important/.test(html));
  assert.ok(/details\.secondary-section > \* \{ display: block !important/.test(html));
});

if (!process.exitCode) {
  console.log("\nAll dashboard / sales-mix / unified reporting tests passed.");
}

