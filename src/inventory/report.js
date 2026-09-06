/**
 * Human-readable inventory intelligence report printer.
 */
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
  const sold90 =
    r.units_sold_90d != null ? ` sold90=${num(r.units_sold_90d, 0)}` : "";
  return (
    `  ${r.sku}  ${r.product || "?"} / ${r.variant || "—"}  ` +
    `stock=${num(r.current_stock, 0)}  sold30=${num(r.units_sold_30d, 0)}${sold90}  ` +
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
  if (p.demand_windows?.d90) {
    console.log(
      `90d demand (dead-stock): ${p.demand_windows.d90.since} → ${p.demand_windows.d90.until}`
    );
  }
  console.log("Advisory only — no Shopify/Sheets writes, no POs.");
  console.log("");
  console.log("SUMMARY");
  console.log(
    `  Total units (SKU-addressable trusted): ${num(s.total_units, 0)}`
  );
  console.log(`    scope: ${s.total_units_scope || "SKU-addressable trusted"}`);
  console.log(
    `  Shopify variants: ${num(s.shopify_variant_count, 0)}  addressable=${num(s.sku_addressable_variant_count, 0)}  missing-SKU=${num(s.missing_sku_variant_count, 0)}  duplicate-SKU variants=${num(s.duplicate_sku_variant_count, 0)}`
  );
  console.log(
    `  Unkeyed units (no SKU): ${num(s.unkeyed_inventory_units, 0)}  (likely bundle/set=${num(s.unkeyed_likely_bundle_set_units, 0)}, other=${num(s.unkeyed_other_units, 0)})`
  );
  console.log(
    `  Duplicate SKU units excluded: ${num(s.duplicate_sku_units_excluded, 0)}`
  );
  console.log(
    `  Safe Shopify total (addressable+unkeyed, excl duplicates): ${num(s.total_shopify_inventory_units_if_safe, 0)}`
  );
  console.log(`  Inventory value:          ${money(s.total_inventory_value)}`);
  console.log(
    `  (excludes missing-cost + duplicate-SKU SKUs)`
  );
  console.log(
    `  No-recent-demand value (30d soft): ${money(s.no_recent_demand_value)}`
  );
  console.log(`  Dead inventory value (90d): ${money(s.dead_inventory_value)}`);
  console.log(`  Overstock value:            ${money(s.overstock_value)}`);
  console.log(
    `  Capital at risk value:        ${money(s.capital_at_risk_value)}`
  );
  console.log(
    `  Capital at risk:              ${s.capital_at_risk_pct == null ? "—" : `${s.capital_at_risk_pct}%`}`
  );
  console.log(`  Critical SKUs:            ${s.critical_sku_count || 0}`);
  console.log(`  Low-stock SKUs:           ${s.low_sku_count || 0}`);
  console.log(`  Overstock SKUs:           ${s.overstock_sku_count || 0}`);
  console.log(`  No-demand SKUs (90d):     ${s.no_demand_sku_count || 0}`);
  console.log(
    `  No-recent-demand SKUs:      ${s.no_recent_demand_sku_count || 0}`
  );
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
  if ((dq.duplicate_skus || []).length) {
    console.log("  Duplicate SKU details:");
    for (const d of dq.duplicate_skus.slice(0, 10)) {
      console.log(
        `    ${d.sku}: ${d.variant_count} variants qtys=[${(d.quantities || []).join(",")}]`
      );
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
