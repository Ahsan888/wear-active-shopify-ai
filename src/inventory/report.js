/**
 * Human-readable inventory intelligence report printer.
 */
const { round2 } = require("../books/tax");

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `Rs ${Number(n).toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;
}

function num(n, digits = 1) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-PK", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function lineSku(r) {
  const cover = r.days_of_cover == null ? "∞/n/a" : `${num(r.days_of_cover, 1)}d`;
  const restock =
    r.recommended_restock_qty == null
      ? ""
      : ` restock≈${r.recommended_restock_qty}`;
  return (
    `  ${r.sku}  ${r.product || "?"} / ${r.variant || "—"}  ` +
    `stock=${num(r.current_stock, 0)}  sold30=${num(r.units_sold_30d, 0)}  ` +
    `cover=${cover}  ${r.stock_class}  ${r.recommended_action}${restock}  ` +
    `value=${money(r.inventory_value)}  conf=${r.confidence}`
  );
}

function printInventoryReport(report) {
  const s = report.summary || {};
  const p = report.period || {};
  console.log("");
  console.log("WEAR ACTIVE — INVENTORY INTELLIGENCE");
  console.log("====================================");
  console.log(`Period demand windows ending: ${p.until || "—"}`);
  if (p.demand_windows?.d30) {
    console.log(
      `30d demand: ${p.demand_windows.d30.since} → ${p.demand_windows.d30.until}`
    );
  }
  console.log("Advisory only — no Shopify/Sheets writes, no POs.");
  console.log("");
  console.log("SUMMARY");
  console.log(`  Total units:              ${num(s.total_units, 0)}`);
  console.log(`  Inventory value:          ${money(s.total_inventory_value)}`);
  console.log(
    `  (excludes ${s.missing_cost_sku_count || 0} SKUs with missing cost)`
  );
  console.log(`  Slow/dead inventory value:${money(s.slow_dead_inventory_value)}`);
  console.log(
    `  Capital at risk:          ${s.capital_at_risk_pct == null ? "—" : `${s.capital_at_risk_pct}%`}`
  );
  console.log(`  Critical SKUs:            ${s.critical_sku_count || 0}`);
  console.log(`  Low-stock SKUs:           ${s.low_sku_count || 0}`);
  console.log(`  Overstock SKUs:           ${s.overstock_sku_count || 0}`);
  console.log(`  No-demand SKUs:           ${s.no_demand_sku_count || 0}`);
  console.log(`  Out of stock SKUs:        ${s.out_of_stock_sku_count || 0}`);
  console.log("");

  console.log("RESTOCK PRIORITIES");
  const restock = (report.restock_priorities || []).slice(0, 15);
  if (!restock.length) {
    console.log("  (none)");
  } else {
    for (const r of restock) console.log(lineSku(r));
  }
  console.log("");

  console.log("DEAD / SLOW STOCK");
  const dead = (report.dead_slow_stock || []).slice(0, 15);
  if (!dead.length) {
    console.log("  (none)");
  } else {
    for (const r of dead) console.log(lineSku(r));
  }
  console.log("");

  console.log("TOP SELLERS");
  const top = (report.top_sellers || []).slice(0, 10);
  if (!top.length) {
    console.log("  (none)");
  } else {
    for (const r of top) console.log(lineSku(r));
  }
  console.log("");

  console.log("PRODUCT SUMMARY");
  const products = (report.products || []).slice(0, 20);
  for (const pr of products) {
    const risk = pr.has_variant_stockout_risk ? " VARIANT_RISK" : "";
    console.log(
      `  ${pr.product}  units=${num(pr.current_stock, 0)}  sold30=${num(pr.units_sold_30d, 0)}  ` +
        `value=${money(pr.inventory_value)}  worst=${pr.worst_stock_class}  ` +
        `crit=${pr.critical_variant_count} low=${pr.low_variant_count} oos=${pr.out_of_stock_variant_count}${risk}`
    );
  }
  console.log("");

  console.log("DATA QUALITY");
  const dq = report.data_quality || {};
  const warns = (dq.warnings || []).slice(0, 40);
  if (!warns.length) {
    console.log("  No warnings.");
  } else {
    for (const w of warns) console.log(`  - ${w}`);
    if ((dq.warnings || []).length > 40) {
      console.log(`  … +${dq.warnings.length - 40} more`);
    }
  }
  console.log("");
  console.log(
    `Sources: inventory=${report.sources?.inventory}; demand=${report.sources?.demand}; cost=${report.sources?.unit_cost}`
  );
  console.log("");
}

module.exports = {
  printInventoryReport,
  money,
  num,
};
