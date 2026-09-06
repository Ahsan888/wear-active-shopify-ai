/**
 * Print / format Phase 5B attributed economics report.
 */
const { round2 } = require("./economics");

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `Rs ${round2(Number(n)).toLocaleString("en-PK")}`;
}

function num(n, d = 0) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-PK", {
    maximumFractionDigits: d,
    minimumFractionDigits: d,
  });
}

function pct(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${round2(Number(n))}%`;
}

function roas(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${round2(Number(n))}x`;
}

function printEntityTable(title, rows) {
  console.log(title);
  if (!rows.length) {
    console.log("  (none)");
    console.log("");
    return;
  }
  for (const r of rows.slice(0, 25)) {
    const label = r.name ? `${r.name} (${r.id})` : r.id;
    const match = r.matched ? "" : " [unmatched]";
    console.log(`  ${label}${match}`);
    console.log(
      `    orders ${num(r.orders, 0)}  rev ${money(r.revenue_ex_tax)}  COGS ${money(r.cogs)}  GP ${money(r.gross_profit)}`
    );
    console.log(
      `    Meta spend ${money(r.meta_spend)}  FP CPA ${money(r.first_party_cpa)}  FP ROAS ${roas(r.first_party_roas)}  GP ROAS ${roas(r.gp_roas)}  contrib ${money(r.contribution_after_meta)}`
    );
  }
  if (rows.length > 25) console.log(`  … ${rows.length - 25} more`);
  console.log("");
}

function printAttributedEconomics(report) {
  const a = report.account || {};
  console.log("WEAR ACTIVE — FIRST-PARTY ATTRIBUTED ECONOMICS");
  console.log("EXPERIMENTAL · observational attribution · not causal");
  console.log(
    `Period: ${report.period?.since || "—"} → ${report.period?.until || "—"}`
  );
  console.log(`Confidence: ${report.confidence}`);
  console.log("");

  console.log("ACCOUNT SUMMARY");
  console.log(`  Shopify recognized revenue     ${money(a.shopify_recognized_revenue)}`);
  console.log(`  Attributed revenue              ${money(a.attributed_revenue)}`);
  console.log(`  Unattributed revenue           ${money(a.unattributed_revenue)}`);
  console.log(`  Attributed coverage            ${pct(a.attributed_coverage_pct)}`);
  console.log(`  Post-capture recognized        ${num(a.post_capture_recognized_orders, 0)}`);
  console.log(`  Stable-ID coverage (of attr.)  ${pct(a.stable_id_coverage_pct)}`);
  console.log(`  Meta spend                     ${money(a.meta_spend)}`);
  console.log(`  FP attributed contribution     ${money(a.first_party_attributed_contribution)}`);
  console.log(`  FP CPA                         ${money(a.first_party_cpa)}`);
  console.log(`  FP ROAS                        ${roas(a.first_party_roas)}`);
  console.log(`  GP ROAS                        ${roas(a.gp_roas)}`);
  console.log("");

  if (report.warnings?.length) {
    console.log("WARNINGS");
    for (const w of report.warnings) console.log(`  - ${w}`);
    console.log("");
  }

  printEntityTable("CAMPAIGNS", report.campaigns || []);
  printEntityTable("AD SETS", report.adsets || []);
  printEntityTable("ADS", report.ads || []);

  const u = report.unmatched || {};
  console.log("UNMATCHED IDS (order occurrences)");
  console.log(`  campaign ${num(u.campaign_ids, 0)}  adset ${num(u.adset_ids, 0)}  ad ${num(u.ad_ids, 0)}`);
  console.log("");
  console.log(
    "Note: Meta-reported metrics remain separate. Unattributed orders are not allocated across campaigns."
  );
}

module.exports = {
  printAttributedEconomics,
  money,
  num,
  pct,
  roas,
};
