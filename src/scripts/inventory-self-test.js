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
  parseStock,
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

test("null / undefined / non-numeric stock → null cover + UNKNOWN class", () => {
  assert.strictEqual(parseStock(null), null);
  assert.strictEqual(parseStock(undefined), null);
  assert.strictEqual(parseStock(""), null);
  assert.strictEqual(parseStock("abc"), null);
  assert.strictEqual(daysOfCover(null, 10), null);
  assert.strictEqual(daysOfCover(undefined, 10), null);
  assert.strictEqual(daysOfCover("x", 10), null);
  assert.strictEqual(classifyStock(null, null, 10, 10, t), "UNKNOWN");
  assert.strictEqual(classifyStock(undefined, null, 10, 10, t), "UNKNOWN");
  assert.strictEqual(classifyStock("bad", null, 10, 10, t), "UNKNOWN");
  // Must NOT treat null as OUT_OF_STOCK
  assert.notStrictEqual(classifyStock(null, null, 0, 0, t), "OUT_OF_STOCK");
});

test("numeric zero stock is OUT_OF_STOCK", () => {
  assert.strictEqual(classifyStock(0, null, 5, 5, t), "OUT_OF_STOCK");
});

test("days of cover null when zero 30d sales", () => {
  assert.strictEqual(daysOfCover(40, 0), null);
  assert.strictEqual(daysOfCover(0, 0), null);
});

test("days of cover for fast seller / low stock", () => {
  const doc = daysOfCover(2, 15);
  assert.ok(doc <= 7);
  assert.strictEqual(classifyStock(2, doc, 15, 15, t), "CRITICAL");
});

test("slow seller / low stock is not RESTOCK_NOW without meaningful demand", () => {
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
  assert.strictEqual(classifyStock(0, null, 10, 10, t), "OUT_OF_STOCK");
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

test("NO_DEMAND requires zero 90d sales", () => {
  assert.strictEqual(classifyStock(50, null, 0, 0, t), "NO_DEMAND");
  assert.strictEqual(
    recommendAction({
      stock_class: "NO_DEMAND",
      units_sold_30d: 0,
      thresholds: t,
    }),
    "NO_DEMAND_REVIEW"
  );
});

test("30d zero with 90d sales → NO_RECENT_DEMAND not dead", () => {
  assert.strictEqual(classifyStock(50, null, 0, 4, t), "NO_RECENT_DEMAND");
  assert.strictEqual(
    recommendAction({
      stock_class: "NO_RECENT_DEMAND",
      units_sold_30d: 0,
      thresholds: t,
    }),
    "MONITOR"
  );
});

test("overstock classification", () => {
  const doc = daysOfCover(200, 30);
  assert.ok(doc > 90);
  assert.strictEqual(classifyStock(200, doc, 30, 30, t), "OVERSTOCK");
});

test("7d acceleration vs slowdown", () => {
  assert.strictEqual(classifyDemandTrend(14, 30, t), "accelerating");
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
});

test("build report: missing cost excluded from inventory value", () => {
  const until = "2026-09-06";
  const ledgerRows = [
    saleRow("2026-09-01", "HAS-COST", 30, 30000),
    saleRow("2026-09-01", "NO-COST", 5, 5000),
  ];
  const demandWindows = buildDemandWindows(ledgerRows, ledgerHeader, until, {
    "HAS-COST": { sku: "HAS-COST", product: "Tee", costPerItem: 500 },
  });
  const report = buildInventoryReport({
    shopifyVariants: [
      { sku: "HAS-COST", product: "Tee", variant: "M", current_stock: 10 },
      { sku: "NO-COST", product: "Tee", variant: "L", current_stock: 20 },
    ],
    demandWindows,
    catalogBySku: {
      "HAS-COST": { sku: "HAS-COST", product: "Tee", costPerItem: 500 },
    },
    period: { until },
  });
  assert.strictEqual(report.summary.total_inventory_value, 5000);
  assert.ok(report.data_quality.missing_cost_skus.includes("NO-COST"));
  const noCost = report.skus.find((s) => s.sku === "NO-COST");
  assert.strictEqual(noCost.inventory_value, null);
});

test("build report: missing SKU match + negative stock + null stock UNKNOWN", () => {
  const until = "2026-09-06";
  const demandWindows = buildDemandWindows([], ledgerHeader, until, {});
  const report = buildInventoryReport({
    shopifyVariants: [
      { sku: null, product: "Orphan", variant: "OS", current_stock: 3 },
      { sku: "NEG", product: "X", variant: "S", current_stock: -2 },
      { sku: "NULLQ", product: "Y", variant: "M", current_stock: null },
    ],
    demandWindows,
    catalogBySku: {
      NEG: { sku: "NEG", product: "X", costPerItem: 10 },
      NULLQ: { sku: "NULLQ", product: "Y", costPerItem: 10 },
    },
    period: { until },
  });
  assert.ok(report.data_quality.missing_sku_variants.length >= 1);
  assert.ok(report.data_quality.negative_stock_skus.includes("NEG"));
  const nullq = report.skus.find((s) => s.sku === "NULLQ");
  assert.strictEqual(nullq.current_stock, null);
  assert.strictEqual(nullq.stock_class, "UNKNOWN");
  assert.strictEqual(report.summary.missing_sku_variant_count, 1);
  assert.strictEqual(report.summary.unkeyed_inventory_units, 3);
});

test("build report: fast seller low stock restock priority", () => {
  const until = "2026-09-06";
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    const d = 8 + (i % 22);
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
  assert.ok(["CRITICAL", "LOW"].includes(row.stock_class));
  assert.strictEqual(row.recommended_action, "RESTOCK_NOW");
  assert.ok(row.recommended_restock_qty > 0);
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
  // Ensure sales fall in 30d window (from Aug 8)
  const filtered = rows.filter((r) => r[0] >= "2026-08-08");
  const demandWindows = buildDemandWindows(
    filtered.length ? filtered : rows,
    ledgerHeader,
    until,
    {
      "BLK-M": { sku: "BLK-M", product: "Hoodie", costPerItem: 800 },
      "BLK-L": { sku: "BLK-L", product: "Hoodie", costPerItem: 800 },
    }
  );
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
  assert.ok(prod.current_stock > 40);
  assert.strictEqual(prod.has_variant_stockout_risk, true);
});

test("duplicate Shopify SKU excluded from valuation/restock — not summed", () => {
  const until = "2026-09-06";
  const demandWindows = buildDemandWindows(
    [saleRow("2026-09-01", "DUP", 10, 10000)],
    ledgerHeader,
    until,
    { DUP: { sku: "DUP", product: "A", costPerItem: 10 } }
  );
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
  assert.strictEqual(row.current_stock, null);
  assert.strictEqual(row.stock_trusted, false);
  assert.strictEqual(row.inventory_value, null);
  assert.strictEqual(row.recommended_restock_qty, null);
  assert.strictEqual(row.confidence, "insufficient");
  assert.strictEqual(row.stock_class, "UNKNOWN");
  assert.ok(report.data_quality.duplicate_skus.some((d) => d.sku === "DUP"));
  assert.deepStrictEqual(
    report.data_quality.duplicate_skus.find((d) => d.sku === "DUP").quantities,
    [3, 4]
  );
  assert.strictEqual(report.summary.duplicate_sku_units_excluded, 7);
  assert.strictEqual(report.summary.sku_addressable_units, 0);
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
  assert.strictEqual(report.summary.sku_addressable_units, 15);
  assert.strictEqual(report.summary.total_units, 15);
});

test("capital at risk excludes NO_RECENT_DEMAND; uses 90d dead + overstock", () => {
  const until = "2026-09-06";
  // DEAD: no sales in 90d
  // RECENT: sale only in older part of 90d window (before 30d)
  // OVER: high cover with recent sales
  const rows = [
    saleRow("2026-07-01", "RECENT", 3, 3000, "SALE:R1"), // in 90d, not in 30d (30d starts Aug 8)
    saleRow("2026-09-01", "OVER", 30, 30000, "SALE:O1"),
  ];
  const demandWindows = buildDemandWindows(rows, ledgerHeader, until, {
    DEAD: { sku: "DEAD", product: "D", costPerItem: 100 },
    RECENT: { sku: "RECENT", product: "R", costPerItem: 100 },
    OVER: { sku: "OVER", product: "O", costPerItem: 100 },
  });
  const report = buildInventoryReport({
    shopifyVariants: [
      { sku: "DEAD", product: "D", variant: "1", current_stock: 10 },
      { sku: "RECENT", product: "R", variant: "1", current_stock: 20 },
      { sku: "OVER", product: "O", variant: "1", current_stock: 200 },
    ],
    demandWindows,
    catalogBySku: {
      DEAD: { sku: "DEAD", product: "D", costPerItem: 100 },
      RECENT: { sku: "RECENT", product: "R", costPerItem: 100 },
      OVER: { sku: "OVER", product: "O", costPerItem: 100 },
    },
    period: { until },
  });
  const dead = report.skus.find((s) => s.sku === "DEAD");
  const recent = report.skus.find((s) => s.sku === "RECENT");
  const over = report.skus.find((s) => s.sku === "OVER");
  assert.strictEqual(dead.stock_class, "NO_DEMAND");
  assert.strictEqual(recent.stock_class, "NO_RECENT_DEMAND");
  assert.strictEqual(over.stock_class, "OVERSTOCK");
  assert.strictEqual(report.summary.dead_inventory_value, 1000);
  assert.strictEqual(report.summary.no_recent_demand_value, 2000);
  assert.strictEqual(report.summary.overstock_value, 20000);
  assert.strictEqual(report.summary.capital_at_risk_value, 21000); // dead+over, not recent
  assert.ok(
    Math.abs(
      report.summary.capital_at_risk_value -
        (report.summary.dead_inventory_value + report.summary.overstock_value)
    ) < 0.01
  );
});

test("unkeyed bundle/set units identified separately", () => {
  const until = "2026-09-06";
  const demandWindows = buildDemandWindows([], ledgerHeader, until, {});
  const report = buildInventoryReport({
    shopifyVariants: [
      {
        sku: null,
        product: "Men's Everyday Set",
        variant: "M / L",
        current_stock: 5,
      },
      { sku: "REAL", product: "Tee", variant: "M", current_stock: 8 },
      { sku: null, product: "Orphan Tee", variant: "OS", current_stock: 2 },
    ],
    demandWindows,
    catalogBySku: { REAL: { sku: "REAL", product: "Tee", costPerItem: 50 } },
    period: { until },
  });
  assert.strictEqual(report.summary.shopify_variant_count, 3);
  assert.strictEqual(report.summary.sku_addressable_variant_count, 1);
  assert.strictEqual(report.summary.missing_sku_variant_count, 2);
  assert.strictEqual(report.summary.sku_addressable_units, 8);
  assert.strictEqual(report.summary.unkeyed_inventory_units, 7);
  assert.strictEqual(report.summary.unkeyed_likely_bundle_set_units, 5);
  assert.strictEqual(report.summary.unkeyed_other_units, 2);
  assert.strictEqual(report.summary.total_units, 8);
  assert.strictEqual(report.summary.total_shopify_inventory_units_if_safe, 15);
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

test("90d demand window present in buildDemandWindows", () => {
  const until = "2026-09-06";
  const dw = buildDemandWindows(
    [saleRow("2026-07-01", "X", 2, 200)],
    ledgerHeader,
    until,
    {}
  );
  assert.ok(dw.windows.d90);
  assert.strictEqual(dw.windows.d90.days, 90);
  assert.strictEqual(dw.demand_90d.get("X").units, 2);
  assert.strictEqual(dw.demand_30d.has("X"), false);
});

if (!process.exitCode) {
  console.log("\nAll inventory self-tests passed.");
}
