/**
 * Human-readable customer & cohort economics printer.
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

function printBucket(label, b) {
  console.log(`  ${label}`);
  console.log(
    `    orders=${num(b.orders, 0)}  rev=${money(b.revenue)}  cogs=${money(b.cogs)}  gp=${money(b.gross_profit)}  gm=${pct(b.gross_margin_pct)}`
  );
  console.log(
    `    aov=${money(b.aov)}  gp/order=${money(b.gp_per_order)}  units/order=${num(b.units_per_order, 2)}`
  );
}

function printCustomerReport(report) {
  const s = report.summary || {};
  const p = report.period || {};
  console.log("");
  console.log("WEAR ACTIVE — CUSTOMER & COHORT ECONOMICS");
  console.log("=========================================");
  console.log(`Period: ${p.since} → ${p.until}`);
  const h = report.history || {};
  if (h.history_since) {
    console.log(
      `History window: ${h.history_since} → ${h.history_until} (${num(h.history_days, 0)}d)`
    );
  }
  console.log(`Confidence: ${report.confidence || "—"}`);
  console.log(
    "Advisory only — observed value within loaded history, not predictive LTV. No CRM/Shopify writes."
  );
  console.log("");

  console.log("SUMMARY");
  console.log(`  Recognized orders (joined):   ${num(s.recognized_orders, 0)}`);
  console.log(
    `  History join coverage:       ${s.history_join_coverage_pct == null ? "—" : pct(s.history_join_coverage_pct)} (${num(s.joined_recognized_shopify_orders, 0)}/${num(s.ledger_recognized_shopify_orders, 0)}; missing=${num(s.recognized_orders_missing_shopify_match_count, 0)})`
  );
  console.log(
    `  Identified customers:     ${num(s.recognized_customers_identified, 0)}`
  );
  console.log(
    `  New (in observed history):   ${num(s.new_in_observed_history_customers ?? s.new_customers, 0)}`
  );
  console.log(
    `  Returning (observed hist.):  ${num(s.returning_in_observed_history_customers ?? s.returning_customers, 0)}`
  );
  console.log(`  Guest/unknown:            ${num(s.guest_unknown_customers, 0)}`);
  console.log(`  First orders:             ${num(s.first_orders, 0)}`);
  console.log(`  Repeat orders:            ${num(s.repeat_orders, 0)}`);
  console.log(`  Revenue:                  ${money(s.revenue)}`);
  console.log(`  Gross profit:             ${money(s.gross_profit)}`);
  console.log(`  AOV:                      ${money(s.aov)}`);
  console.log(`  Revenue/customer:         ${money(s.revenue_per_identified_customer)}`);
  console.log(`  GP/customer:              ${money(s.gp_per_identified_customer)}`);
  console.log(`  Repeat customer rate:     ${pct(s.repeat_customer_rate_pct)}`);
  console.log(`  Repeat order share:       ${pct(s.repeat_order_share_pct)}`);
  console.log(`  Guest order share:        ${pct(s.guest_order_share_pct)}`);
  console.log("");

  console.log("NEW VS RETURNING (OBSERVED HISTORY)");
  console.log(
    `  ${report.new_vs_returning?.definition || "New/returning relative to loaded history only."}`
  );
  printBucket(
    "New-in-observed-history orders",
    report.new_vs_returning?.new_customer_orders || {}
  );
  printBucket(
    "Returning-in-observed-history orders",
    report.new_vs_returning?.returning_customer_orders || {}
  );
  console.log("");

  console.log("CUSTOMER VALUE (OBSERVED)");
  const ov = report.observed_customer_value || {};
  console.log(`  ${ov.label || "OBSERVED CUSTOMER VALUE"}`);
  console.log(`  ${ov.note || ""}`);
  console.log(
    `  avg orders=${num(ov.average_orders, 2)}  avg rev=${money(ov.average_revenue)}  avg gp=${money(ov.average_gp)}`
  );
  console.log("");

  console.log("REPURCHASE");
  const rp = report.repurchase || {};
  console.log(
    `  Median days to 2nd purchase: ${num(rp.median_days_to_second_order, 1)}`
  );
  console.log(
    `  Average days to 2nd purchase: ${num(rp.average_days_to_second_order, 1)}`
  );
  console.log(
    `  Repeat within 30d: ${pct(rp.repeat_within_30d?.rate_pct)} (n=${num(rp.repeat_within_30d?.eligible, 0)})`
  );
  console.log(
    `  Repeat within 60d: ${pct(rp.repeat_within_60d?.rate_pct)} (n=${num(rp.repeat_within_60d?.eligible, 0)})`
  );
  console.log(
    `  Repeat within 90d: ${pct(rp.repeat_within_90d?.rate_pct)} (n=${num(rp.repeat_within_90d?.eligible, 0)})`
  );
  console.log("");

  console.log("COHORTS");
  for (const c of (report.cohorts || []).slice(-12)) {
    const r30 = c.repeat_by_30d?.matured
      ? pct(c.repeat_by_30d.rate_pct)
      : "not matured";
    const r60 = c.repeat_by_60d?.matured
      ? pct(c.repeat_by_60d.rate_pct)
      : "not matured";
    const r90 = c.repeat_by_90d?.matured
      ? pct(c.repeat_by_90d.rate_pct)
      : "not matured";
    console.log(
      `  ${c.cohort}  cust=${num(c.customers, 0)}  rev/cust=${money(c.revenue_per_customer)}  gp/cust=${money(c.gp_per_customer)}  repeat=${pct(c.repeat_rate_pct)}  30d=${r30} 60d=${r60} 90d=${r90}`
    );
  }
  if (report.strongest_mature_cohort) {
    const sm = report.strongest_mature_cohort;
    console.log(
      `  Strongest mature (60d+): ${sm.cohort} gp/cust=${money(sm.gp_per_customer)} repeat=${pct(sm.repeat_rate_pct)}`
    );
  }
  console.log("");

  console.log("ACQUISITION COHORTS");
  for (const a of report.acquisition_cohorts || []) {
    console.log(
      `  ${a.acquisition}  cust=${num(a.customers, 0)}  rev/cust=${money(a.revenue_per_customer)}  gp/cust=${money(a.gp_per_customer)}  orders/cust=${num(a.orders_per_customer, 2)}  repeat=${pct(a.repeat_rate_pct)}`
    );
  }
  console.log("");

  console.log("OBSERVED CAC / GP:CAC");
  const cac = report.observed_cac || {};
  console.log(`  ${cac.label}`);
  console.log(`  Meta spend: ${money(cac.meta_spend)}`);
  console.log(
    `  Post-capture Meta-new customers: ${num(cac.post_capture_meta_new_customers ?? cac.meta_new_customers, 0)}`
  );
  console.log(
    `  Pre-capture Meta-new excluded: ${num(cac.pre_capture_meta_new_customers_excluded, 0)}`
  );
  console.log(
    `  FP observed new-customer CAC: ${money(cac.first_party_observed_new_customer_cac)}`
  );
  console.log(
    `  Observed GP/customer: ${money(cac.observed_gp_per_customer)}`
  );
  console.log(
    `  ${cac.observed_gp_cac_label || "OBSERVED GP:CAC"}: ${num(cac.observed_gp_cac_ratio, 2)}`
  );
  console.log(
    `  Attr. coverage (post-capture): ${cac.attribution_coverage_pct == null ? "—" : pct(cac.attribution_coverage_pct)}`
  );
  console.log(`  Confidence: ${cac.confidence}`);
  console.log("");

  console.log("DATA QUALITY");
  for (const w of report.data_quality?.warnings || []) {
    console.log(`  - ${w}`);
  }
  if (!(report.data_quality?.warnings || []).length) {
    console.log("  No warnings.");
  }
  console.log("");
}

module.exports = {
  printCustomerReport,
  money,
  num,
  pct,
};
