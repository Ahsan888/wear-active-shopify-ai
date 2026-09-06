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
    `price=${money(r.current_price)}  cost=${money(r.unit_cost)}  ` +
    `stickerGM=${pct(r.commercial_sticker_gm_pct ?? r.unit_gm_pct)}  ` +
    `acctGM=${pct(r.accounting_gm_ex_tax_pct)}  ` +
    `maxSafe=${pct(r.maximum_safe_discount_pct)}  ` +
    `${r.recommendation}  disc=${disc}  capital=${money(r.inventory_cost_capital_tied_up)}  ` +
    `lift=${num(r.required_unit_lift_to_preserve_gp, 2)}x  conf=${r.confidence}` +
    (r.immature_for_clearance ? "  immature" : "")
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
    `Convention: floors use ex-tax Books GM (${report.conventions?.pricing_floor || "accounting floor"})`
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
  console.log(
    `  Excluded immature (<90d): ${num(s.excluded_immature_clearance_count, 0)}`
  );
  console.log(
    `  Mixed-variant products:  ${num(s.mixed_variant_product_count, 0)}`
  );
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

  console.log("MIXED VARIANT PRODUCTS");
  const mixed = (report.mixed_variant_products || []).slice(0, 10);
  if (!mixed.length) console.log("  (none)");
  else {
    for (const m of mixed) {
      console.log(
        `  ${m.product}  → ${m.recommendation}  clearance=${m.clearance_variant_count} promo=${m.promotion_variant_count} protect=${m.protect_variant_count}`
      );
      if (m.explanation) console.log(`    ${m.explanation}`);
    }
  }
  console.log("");

  console.log("DISCOUNT ECONOMICS (top clearance)");
  for (const r of clearance.slice(0, 5)) {
    console.log(`  ${r.product} / ${r.variant} (${r.sku})`);
    console.log(
      `    stock=${num(r.current_stock, 0)}  30d=${num(r.units_sold_30d, 0)}  90d=${num(r.units_sold_90d, 0)}  class=${r.stock_class}  age=${num(r.selling_age_days, 0)}d`
    );
    console.log(
      `    price=${money(r.current_price)}  cost=${money(r.unit_cost)}  stickerGM=${pct(r.commercial_sticker_gm_pct ?? r.unit_gm_pct)}  acctGM=${pct(r.accounting_gm_ex_tax_pct)}`
    );
    console.log(
      `    floor=${money(r.minimum_margin_price)}  maxSafeDisc=${pct(r.maximum_safe_discount_pct)}  → ${r.recommended_discount_pct}% ${money(r.recommended_price)}`
    );
    console.log(
      `    disc stickerGP=${money(r.scenario?.commercial_sticker_gp ?? r.scenario?.unit_gp)}  disc acctGM=${pct(r.scenario?.accounting_gm_ex_tax_pct)}  lift=${num(r.required_unit_lift_to_preserve_gp, 2)}x  capital=${money(r.inventory_cost_capital_tied_up)}`
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
