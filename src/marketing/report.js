/**
 * Human-readable Marketing Decision Engine printer.
 */
function money(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `Rs ${Number(n).toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;
}

function num(n, d = 1) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-PK", { maximumFractionDigits: d });
}

function lineAction(a) {
  const sec = a.secondary_action ? ` + ${a.secondary_action}` : "";
  return (
    `  [${a.priority || "—"}] ${a.primary_action}${sec}  ` +
    `${a.entity_name || a.entity_id || "?"}  ` +
    `spend=${money(a.spend)}  purch=${num(a.purchases, 0)}  ` +
    `conf=${a.confidence}  ${a.reason || (a.reason_codes || []).slice(0, 3).join(",")}`
  );
}

function printMarketingDecisionReport(report) {
  const s = report.summary || {};
  const acc = report.account_decision || {};
  const biz = report.business_context || {};
  const ev = report.evidence_quality || {};

  console.log("");
  console.log("WEAR ACTIVE — MARKETING DECISION ENGINE");
  console.log("=======================================");
  if (report.period?.since) {
    console.log(`Period: ${report.period.since} → ${report.period.until} (${report.primary_days}d)`);
  }
  console.log("Advisory only — no Meta mutations, no budget automation, no Shopify writes.");
  console.log("");

  console.log("ACCOUNT DECISION");
  console.log(`  Recommendation:  ${acc.recommendation}`);
  console.log(`  Confidence:      ${acc.confidence}`);
  console.log(`  Guidance:        ${acc.guidance || "—"}`);
  console.log(`  Reasons:         ${(acc.reason_codes || []).join(", ") || "—"}`);
  console.log("");

  console.log("BUSINESS CONTEXT");
  console.log(`  Health:          ${biz.business_health?.status || "—"}`);
  console.log(
    `  Ad affordability:${biz.business_advertising_safety?.status || "—"} ` +
      `(headroom ${num(biz.business_advertising_safety?.business_cpa_headroom_pct)}%)`
  );
  console.log(
    `  BE CPA:          ${money(biz.business_advertising_safety?.break_even_cpa)}  ` +
      `blended load ${money(biz.business_advertising_safety?.blended_ad_cost_per_recognized_order)}`
  );
  console.log(
    `  Customer CAC:    ${biz.customer?.observed_cac_status || "insufficient"}`
  );
  console.log("");

  console.log("EVIDENCE QUALITY");
  console.log(`  Marketing confidence: ${ev.marketing_evidence_confidence}`);
  console.log(
    `  FP attribution:       ${ev.fp_evidence?.status} ` +
      `(coverage ${num(ev.fp_evidence?.attributed_coverage_pct)}%, ` +
      `post-capture ${num(ev.fp_evidence?.post_capture_orders, 0)})`
  );
  console.log(`  Note: ${ev.fp_evidence?.note || "—"}`);
  console.log("");

  console.log("7 / 14 / 30 META SUMMARY");
  for (const d of ["7", "14", "30"]) {
    const m = report.meta_periods?.[d];
    if (!m) {
      console.log(`  ${d}d: (not loaded)`);
      continue;
    }
    console.log(
      `  ${d}d: spend=${money(m.spend)}  purch=${num(m.purchases, 0)}  ` +
        `CPA=${money(m.cpa)}  ROAS=${num(m.roas, 2)}x`
    );
  }
  console.log("");

  const queue = report.owner_action_queue || [];
  const p1 = queue.filter((a) => a.priority === "P1");
  const p2 = queue.filter((a) => a.priority === "P2");

  console.log("P1 ACTIONS");
  if (!p1.length) console.log("  (none)");
  else for (const a of p1) console.log(lineAction(a));
  console.log("");

  console.log("P2 ACTIONS");
  if (!p2.length) console.log("  (none)");
  else for (const a of p2) console.log(lineAction(a));
  console.log("");

  console.log("SCALE CANDIDATES");
  const scale = (report.scale_candidates || []).slice(0, 10);
  if (!scale.length) console.log("  (none)");
  else for (const a of scale) console.log(lineAction(a));
  console.log("");

  console.log("REDUCE / PAUSE");
  for (const a of [...(report.pause_candidates || []), ...(report.reduce_candidates || [])].slice(0, 12)) {
    console.log(lineAction(a));
  }
  if (
    !(report.pause_candidates || []).length &&
    !(report.reduce_candidates || []).length
  ) {
    console.log("  (none)");
  }
  console.log("");

  console.log("CREATIVE TESTS");
  const creative = (report.creative_tests || []).slice(0, 8);
  if (!creative.length) console.log("  (none)");
  else for (const a of creative) console.log(lineAction(a));
  console.log("");

  console.log("PROMOTION OPPORTUNITIES");
  const promo = (report.promotion_tests || []).slice(0, 8);
  if (!promo.length) console.log("  (none)");
  else for (const a of promo) console.log(lineAction(a));
  console.log("");

  console.log("INVENTORY CONSTRAINTS");
  const inv = (report.inventory_constraints || []).slice(0, 8);
  if (!inv.length) console.log("  (none — or no entity↔product mapping)");
  else for (const a of inv) console.log(lineAction(a));
  console.log("");

  console.log("MONITOR");
  console.log(`  HOLD=${num(s.hold_count, 0)}  MONITOR=${num(s.monitor_count, 0)}  INSUFFICIENT=${num(s.insufficient_count, 0)}`);
  console.log("");

  console.log("DATA QUALITY");
  for (const b of (report.data_quality?.blockers || []).slice(0, 20)) {
    console.log(`  - ${b}`);
  }
  console.log("");
}

module.exports = {
  printMarketingDecisionReport,
  money,
  num,
};
