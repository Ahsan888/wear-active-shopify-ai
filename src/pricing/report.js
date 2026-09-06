/**
 * Human-readable pricing & promotion intelligence printer.
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

function pct(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Number(n).toFixed(1)}%`;
}

function lineCandidate(r) {
  const disc =
    r.recommended_discount_pct != null
      ? `${r.recommended_discount_pct}% → ${money(r.recommended_price)}`
      : "—";
  return (
    `  ${r.sku}  ${r.product || "?"} / ${r.variant || "—"}  ` +
    `stock=${num(r.current_stock, 0)}  class=${r.stock_class}  ` +
    `price=${money(r.current_price)}  cost=${money(r.unit_cost)}  gm=${pct(r.unit_gm_pct)}  ` +
    `${r.recommendation}  disc=${disc}  capital=${money(r.inventory_cost_capital_tied_up)}  ` +
    `lift=${num(r.required_unit_lift_to_preserve_gp, 2)}x  conf=${r.confidence}`
  );
}

function printPricingReport(report) {
  const s = report.summary || {};
  const p = report.period || {};
  console.log("");
  console.log("WEAR ACTIVE — PRICING & PROMOTION INTELLIGENCE");
  console.log("==============================================");
  if (p.since) console.log(`Period: ${p.since} → ${p.until}`);
  console.log("Advisory only — no Shopify price writes, no automatic discounts.");
  console.log(
    `Convention: ${report.conventions?.unit_gp || "sticker − cost"} · ${report.conventions?.books_note || ""}`
  );
  console.log("");

  console.log("SUMMARY");
  console.log(`  SKUs analyzed:           ${num(s.sku_count, 0)}`);
  console.log(`  Products:                ${num(s.product_count, 0)}`);
  console.log(`  PROTECT_PRICE:           ${num(s.protect_price_count, 0)}`);
  console.log(`  HOLD_PRICE:              ${num(s.hold_price_count, 0)}`);
  console.log(`  TEST_SMALL_DISCOUNT:     ${num(s.test_small_discount_count, 0)}`);
  console.log(`  PROMOTION_CANDIDATE:     ${num(s.promotion_count, 0)}`);
  console.log(`  CLEARANCE_CANDIDATE:     ${num(s.clearance_count, 0)}`);
  console.log(`  PRICE_INCREASE_CANDIDATE:${num(s.price_increase_count, 0)}`);
  console.log(`  INSUFFICIENT_DATA:       ${num(s.insufficient_count, 0)}`);
  console.log("");

  console.log("CAPITAL AT RISK");
  console.log(
    `  Clearance inventory cost capital:  ${money(s.capital_tied_up_clearance)}`
  );
  console.log(
    `  Promotion inventory cost capital:  ${money(s.capital_tied_up_promotion)}`
  );
  console.log(
    `  Combined:                          ${money(s.capital_tied_up_promotion_and_clearance)}`
  );
  console.log("");

  console.log("CLEARANCE CANDIDATES");
  const clearance = (report.clearance_candidates || []).slice(0, 10);
  if (!clearance.length) console.log("  (none)");
  else for (const r of clearance) console.log(lineCandidate(r));
  console.log("");

  console.log("PROMOTION CANDIDATES");
  const promo = (report.promotion_candidates || []).slice(0, 10);
  if (!promo.length) console.log("  (none)");
  else for (const r of promo) console.log(lineCandidate(r));
  console.log("");

  console.log("PRICE PROTECTION");
  const protect = (report.protect_price || []).slice(0, 10);
  if (!protect.length) console.log("  (none)");
  else for (const r of protect) console.log(lineCandidate(r));
  console.log("");

  console.log("PRICE INCREASE TESTS");
  const inc = (report.price_increase_candidates || []).slice(0, 10);
  if (!inc.length) console.log("  (none)");
  else {
    for (const r of inc) {
      const t5 = (r.price_increase_test || []).find((x) => x.increase_pct === 5);
      console.log(
        `  ${r.sku}  ${r.product}  price=${money(r.current_price)}  +5%→${money(t5?.selling_price)}  gp_uplift=${money(t5?.gp_uplift_per_unit)}  conf=${r.confidence}`
      );
    }
  }
  console.log("");

  console.log("DISCOUNT ECONOMICS (top clearance)");
  for (const r of clearance.slice(0, 5)) {
    console.log(`  ${r.product} / ${r.variant} (${r.sku})`);
    console.log(
      `    stock=${num(r.current_stock, 0)}  30d=${num(r.units_sold_30d, 0)}  90d=${num(r.units_sold_90d, 0)}  class=${r.stock_class}`
    );
    console.log(
      `    price=${money(r.current_price)}  cost=${money(r.unit_cost)}  gm=${pct(r.unit_gm_pct)}  → ${r.recommended_discount_pct}% ${money(r.recommended_price)}`
    );
    console.log(
      `    disc GP=${money(r.scenario?.unit_gp)}  disc GM=${pct(r.scenario?.unit_gm_pct)}  lift=${num(r.required_unit_lift_to_preserve_gp, 2)}x  capital=${money(r.inventory_cost_capital_tied_up)}`
    );
  }
  console.log("");

  console.log("DATA QUALITY");
  const warns = (report.data_quality?.warnings || []).slice(0, 30);
  if (!warns.length) console.log("  No warnings.");
  else for (const w of warns) console.log(`  - ${w}`);
  console.log("");
}

module.exports = {
  printPricingReport,
  money,
  num,
  pct,
};
