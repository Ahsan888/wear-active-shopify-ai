#!/usr/bin/env node
/**
 * Phase 7 inventory intelligence self-tests (pure / injected fixtures).
 */
const assert = require("assert");
const {
  daysOfCover,
  classifyStock,
  classifyDemandTrend,
  recommendAction,
  recommendedRestockQty,
  priorityScore,
  avgDailyUnits,
} = require("../inventory/classify");
const { resolveThresholds, DEFAULT_THRESHOLDS } = require("../inventory/thresholds");
const { productsToSkuMap, buildDemandWindows } = require("../inventory/demand");
const { buildInventoryReport } = require("../inventory/build");
const { aggregateLedgerPeriod } = require("../profitability/books");

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

function saleRow(date, sku, qty, credit, ref) {
  return [
    date,
    "Sale",
    "Shopify",
    "",
    "Item",
    sku,
    String(qty),
    "",
    String(credit),
    "",
    "",
    ref || `SALE:SHOPIFY|${sku}|${date}`,
    "",
    "",
  ];
}

function giftRow(date, sku, qty, ref) {
  return [
    date,
    "Gift",
    "Shopify",
    "Gift/PR",
    "PR",
    sku,
    String(qty),
    "",
    "",
    "",
    "",
    ref || `GIFT:${sku}-${date}`,
    "",
    "",
  ];
}

const t = resolveThresholds();

test("configurable thresholds override defaults", () => {
  const o = resolveThresholds({ critical_days: 3, target_days_of_cover: 60 });
  assert.strictEqual(o.critical_days, 3);
  assert.strictEqual(o.target_days_of_cover, 60);
  assert.strictEqual(DEFAULT_THRESHOLDS.critical_days, 7);
});

test("days of cover null when zero 30d sales", () => {
  assert.strictEqual(daysOfCover(40, 0), null);
  assert.strictEqual(daysOfCover(0, 0), null);
});

test("days of cover for fast seller / low stock", () => {
  // 15 sold in 30d → 0.5/day; 2 stock → 4 days cover → CRITICAL
  const doc = daysOfCover(2, 15);
  assert.ok(doc <= 7);
  assert.strictEqual(classifyStock(2, doc, 15, t), "CRITICAL");
});

test("slow seller / low stock is not RESTOCK_NOW without meaningful demand", () => {
  // 1 sold in 30d, 2 stock → cover = 60 → HIGH, but check low stock + tiny demand
  const doc = daysOfCover(2, 1);
  assert.ok(doc > 45);
  const action = recommendAction({
    stock_class: "CRITICAL",
    days_of_cover: 5,
    units_sold_30d: 1,
    demand_trend: "insufficient_data",
    thresholds: t,
  });
  assert.strictEqual(action, "MONITOR");
});

test("out of stock with demand → RESTOCK_NOW", () => {
  assert.strictEqual(classifyStock(0, null, 10, t), "OUT_OF_STOCK");
  assert.strictEqual(
    recommendAction({
      stock_class: "OUT_OF_STOCK",
      units_sold_30d: 10,
      demand_trend: "stable",
      thresholds: t,
    }),
    "RESTOCK_NOW"
  );
});

test("no-demand inventory classification", () => {
  assert.strictEqual(classifyStock(50, null, 0, t), "NO_DEMAND");
  assert.strictEqual(
    recommendAction({
      stock_class: "NO_DEMAND",
      units_sold_30d: 0,
      thresholds: t,
    }),
    "NO_DEMAND_REVIEW"
  );
});

test("overstock classification", () => {
  const doc = daysOfCover(200, 30); // 200 / 1 = 200 days
  assert.ok(doc > 90);
  assert.strictEqual(classifyStock(200, doc, 30, t), "OVERSTOCK");
});

test("7d acceleration vs slowdown", () => {
  // 7d: 14 units (2/day), 30d: 30 units (1/day) → accelerating
  assert.strictEqual(classifyDemandTrend(14, 30, t), "accelerating");
  // 7d: 2 units (~0.29/day), 30d: 30 (1/day) → slowing
  assert.strictEqual(classifyDemandTrend(2, 30, t), "slowing");
  assert.strictEqual(classifyDemandTrend(0, 0, t), "insufficient_data");
});

test("zero sales restock qty is null", () => {
  assert.strictEqual(
    recommendedRestockQty({
      current_stock: 0,
      units_sold_30d: 0,
      action: "RESTOCK_NOW",
      thresholds: t,
    }),
    null
  );
});

test("restock quantity targets configurable days of cover", () => {
  // 30 sold → 1/day; target 45 → need 45; stock 10 → restock 35
  const qty = recommendedRestockQty({
    current_stock: 10,
    units_sold_30d: 30,
    action: "RESTOCK_NOW",
    thresholds: t,
  });
  assert.strictEqual(qty, 35);

  const qty60 = recommendedRestockQty({
    current_stock: 10,
    units_sold_30d: 30,
    action: "RESTOCK_SOON",
    thresholds: { ...t, target_days_of_cover: 60 },
  });
  assert.strictEqual(qty60, 50);
});

test("commercial rule: low stock + no demand ≠ RESTOCK_NOW", () => {
  assert.strictEqual(
    recommendAction({
      stock_class: "OUT_OF_STOCK",
      units_sold_30d: 0,
      demand_trend: "insufficient_data",
      thresholds: t,
    }),
    "MONITOR"
  );
  assert.strictEqual(
    recommendAction({
      stock_class: "CRITICAL",
      days_of_cover: 3,
      units_sold_30d: 0,
      demand_trend: "insufficient_data",
      thresholds: t,
    }),
    "MONITOR"
  );
});

test("gift/PR excluded from paid demand units", () => {
  const rows = [
    saleRow("2026-09-01", "SKU-A", 2, 2000),
    giftRow("2026-09-02", "SKU-A", 5, "GIFT:pr-1"),
  ];
  const agg = aggregateLedgerPeriod(
    rows,
    ledgerHeader,
    "2026-08-08",
    "2026-09-06",
    { "SKU-A": { sku: "SKU-A", product: "A", costPerItem: 100 } }
  );
  const map = productsToSkuMap(agg.products);
  assert.strictEqual(map.get("SKU-A").units, 2);
  assert.ok((agg.books.gift_units || 0) >= 5 || agg.gift_units_by_key);
});

test("build report: missing cost excluded from inventory value", () => {
  const until = "2026-09-06";
  const ledgerRows = [
    saleRow("2026-09-01", "HAS-COST", 30, 30000),
    saleRow("2026-09-01", "NO-COST", 5, 5000),
  ];
  const demandWindows = buildDemandWindows(
    ledgerRows,
    ledgerHeader,
    until,
    {
      "HAS-COST": { sku: "HAS-COST", product: "Tee", costPerItem: 500 },
    }
  );
  const report = buildInventoryReport({
    shopifyVariants: [
      {
        sku: "HAS-COST",
        product: "Tee",
        variant: "M",
        current_stock: 10,
      },
      {
        sku: "NO-COST",
        product: "Tee",
        variant: "L",
        current_stock: 20,
      },
    ],
    demandWindows,
    catalogBySku: {
      "HAS-COST": { sku: "HAS-COST", product: "Tee", costPerItem: 500 },
      // NO-COST missing from VM
    },
    period: { until },
  });
  assert.strictEqual(report.summary.total_inventory_value, 5000); // 10*500
  assert.ok(report.data_quality.missing_cost_skus.includes("NO-COST"));
  const noCost = report.skus.find((s) => s.sku === "NO-COST");
  assert.strictEqual(noCost.inventory_value, null);
});

test("build report: missing SKU match + negative stock", () => {
  const until = "2026-09-06";
  const demandWindows = buildDemandWindows([], ledgerHeader, until, {});
  const report = buildInventoryReport({
    shopifyVariants: [
      { sku: null, product: "Orphan", variant: "OS", current_stock: 3 },
      { sku: "NEG", product: "X", variant: "S", current_stock: -2 },
    ],
    demandWindows,
    catalogBySku: {},
    period: { until },
  });
  assert.ok(report.data_quality.missing_sku_variants.length >= 1);
  assert.ok(report.data_quality.negative_stock_skus.includes("NEG"));
});

test("build report: fast seller low stock restock priority", () => {
  const until = "2026-09-06";
  // All sales inside 30d window (since 2026-08-08)
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    const d = 8 + (i % 22); // Aug 8–29
    const day = String(d).padStart(2, "0");
    rows.push(saleRow(`2026-08-${day}`, "FAST", 1, 1000, `SALE:F|${i}`));
  }
  const demandWindows = buildDemandWindows(rows, ledgerHeader, until, {
    FAST: { sku: "FAST", product: "FastTee", costPerItem: 200 },
  });
  const report = buildInventoryReport({
    shopifyVariants: [
      { sku: "FAST", product: "FastTee", variant: "M", current_stock: 2 },
    ],
    demandWindows,
    catalogBySku: {
      FAST: { sku: "FAST", product: "FastTee", costPerItem: 200 },
    },
    period: { until },
  });
  const row = report.skus.find((s) => s.sku === "FAST");
  assert.ok(
    ["CRITICAL", "LOW"].includes(row.stock_class),
    `expected low cover class, got ${row.stock_class} cover=${row.days_of_cover}`
  );
  assert.strictEqual(row.recommended_action, "RESTOCK_NOW");
  assert.ok(row.recommended_restock_qty > 0);
  assert.ok(report.restock_priorities.some((r) => r.sku === "FAST"));
});

test("product aggregation surfaces variant-level risk", () => {
  const until = "2026-09-06";
  const rows = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push(
      saleRow(
        `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
        "BLK-M",
        1,
        1000,
        `SALE:BM|${i}`
      )
    );
  }
  const demandWindows = buildDemandWindows(rows, ledgerHeader, until, {
    "BLK-M": { sku: "BLK-M", product: "Hoodie", costPerItem: 800 },
    "BLK-L": { sku: "BLK-L", product: "Hoodie", costPerItem: 800 },
  });
  const report = buildInventoryReport({
    shopifyVariants: [
      {
        sku: "BLK-M",
        product: "Hoodie",
        variant: "Black / M",
        current_stock: 1,
      },
      {
        sku: "BLK-L",
        product: "Hoodie",
        variant: "Black / L",
        current_stock: 80,
      },
    ],
    demandWindows,
    catalogBySku: {
      "BLK-M": { sku: "BLK-M", product: "Hoodie", costPerItem: 800 },
      "BLK-L": { sku: "BLK-L", product: "Hoodie", costPerItem: 800 },
    },
    period: { until },
  });
  const prod = report.products.find((p) => p.product === "Hoodie");
  assert.ok(prod);
  assert.ok(prod.current_stock > 40); // looks healthy in total
  assert.strictEqual(prod.has_variant_stockout_risk, true);
  assert.ok(["CRITICAL", "LOW", "OUT_OF_STOCK"].includes(prod.worst_stock_class));
});

test("duplicate Shopify SKU stock merged + warned", () => {
  const until = "2026-09-06";
  const demandWindows = buildDemandWindows([], ledgerHeader, until, {});
  const report = buildInventoryReport({
    shopifyVariants: [
      { sku: "DUP", product: "A", variant: "1", current_stock: 3 },
      { sku: "DUP", product: "A", variant: "2", current_stock: 4 },
    ],
    demandWindows,
    catalogBySku: { DUP: { sku: "DUP", product: "A", costPerItem: 10 } },
    period: { until },
  });
  const row = report.skus.find((s) => s.sku === "DUP");
  assert.strictEqual(row.current_stock, 7);
  assert.ok(
    report.data_quality.warnings.some((w) => w.includes("duplicate_shopify_sku:DUP"))
  );
});

test("inventory value reconciliation known costs only", () => {
  const until = "2026-09-06";
  const demandWindows = buildDemandWindows([], ledgerHeader, until, {});
  const report = buildInventoryReport({
    shopifyVariants: [
      { sku: "A", product: "P", variant: "1", current_stock: 10 },
      { sku: "B", product: "P", variant: "2", current_stock: 5 },
    ],
    demandWindows,
    catalogBySku: {
      A: { sku: "A", product: "P", costPerItem: 100 },
      B: { sku: "B", product: "P", costPerItem: 200 },
    },
    period: { until },
  });
  assert.strictEqual(report.summary.total_inventory_value, 2000);
  assert.strictEqual(report.summary.total_units, 15);
});

test("priority score favors velocity + low cover", () => {
  const hot = priorityScore(
    {
      units_sold_30d: 40,
      days_of_cover: 3,
      gross_margin_pct: 50,
      inventory_value: 1000,
      current_stock: 2,
      stock_class: "CRITICAL",
      demand_trend: "accelerating",
    },
    t
  );
  const cold = priorityScore(
    {
      units_sold_30d: 2,
      days_of_cover: 40,
      gross_margin_pct: 20,
      inventory_value: 1000,
      current_stock: 40,
      stock_class: "HEALTHY",
      demand_trend: "stable",
    },
    t
  );
  assert.ok(hot > cold);
});

test("avg daily units helper", () => {
  assert.strictEqual(avgDailyUnits(30, 30), 1);
  assert.strictEqual(avgDailyUnits(0, 30), 0);
});

if (!process.exitCode) {
  console.log("\nAll inventory self-tests passed.");
}
