/**
 * Phase 11 — Executive operating system: owner brief, unified queue, freshness.
 */
const { round2 } = require("../books/tax");

function normalizePriority(p) {
  const s = String(p || "P4").toUpperCase();
  if (s === "CRITICAL" || s === "P1") return "P1";
  if (s === "HIGH" || s === "P2") return "P2";
  if (s === "MEDIUM" || s === "P3") return "P3";
  return "P4";
}

function dedupeKey(action) {
  return [
    action.area || "",
    action.primary_action || action.action || "",
    action.entity_name || action.entity_id || action.product || "",
  ]
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Merge marketing + inventory + pricing + data-quality into one owner queue.
 */
function buildUnifiedOwnerQueue(input = {}) {
  const out = [];
  const seen = new Set();

  function push(item) {
    const key = dedupeKey(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      priority: normalizePriority(item.priority),
      area: item.area || "Operations",
      primary_action: item.primary_action || item.action || "REVIEW",
      secondary_action: item.secondary_action || null,
      entity_name: item.entity_name || item.product || "Business",
      entity_id: item.entity_id || item.sku || null,
      what_to_do: item.what_to_do || item.title || null,
      why: item.why || item.reason || "",
      evidence: item.evidence || null,
      confidence: item.confidence || "medium",
      source: item.source || "CALCULATED",
      expandable_why: item.expandable_why || null,
    });
  }

  for (const a of input.marketing_queue || []) {
    push({
      ...a,
      area: "Marketing",
      source: "META",
      what_to_do: `${a.primary_action}${a.secondary_action ? " + " + a.secondary_action : ""} — ${a.entity_name || ""}`,
      why: a.reason || (a.reason_codes || []).slice(0, 3).join(", "),
      expandable_why: buildMarketingWhy(a),
    });
  }

  for (const s of (input.inventory_stockouts || []).slice(0, 8)) {
    if ((Number(s.units_sold_30d) || 0) <= 0) continue;
    push({
      priority: s.stock_class === "OUT_OF_STOCK" || s.stock_class === "CRITICAL" ? "P2" : "P3",
      area: "Inventory",
      primary_action: "REVIEW_STOCK",
      entity_name: `${s.product || ""} / ${s.sku || ""}`.trim(),
      entity_id: s.sku,
      why: `Stock class ${s.stock_class}; 30d sales ${s.units_sold_30d ?? "—"}; cover ${s.days_of_cover ?? "—"}d`,
      confidence: s.stock_trusted === false ? "low" : "medium",
      source: "SHOPIFY",
      what_to_do: "Review restock or protect advertising for this size",
    });
  }

  for (const c of (input.clearance_candidates || []).slice(0, 5)) {
    if (c.immature_for_clearance) continue;
    push({
      priority: "P3",
      area: "Pricing",
      primary_action: "PROMOTION_REVIEW",
      entity_name: `${c.product || ""} / ${c.variant || c.sku || ""}`.trim(),
      entity_id: c.sku,
      why: `${c.recommendation}; suggested ${c.recommended_discount_pct}% (accounting-safe); capital ${c.inventory_cost_capital_tied_up ?? "—"}`,
      confidence: c.confidence || "medium",
      source: "CALCULATED",
      what_to_do: "Review clearance/promotion — do not auto-discount",
    });
  }

  for (const w of (input.data_quality_blockers || []).slice(0, 5)) {
    push({
      priority: "P3",
      area: "Data Quality",
      primary_action: "FIX_DATA",
      entity_name: "Data quality",
      why: String(w),
      confidence: "medium",
      source: "CALCULATED",
      what_to_do: "Resolve data issue so recommendations stay trustworthy",
    });
  }

  const rank = { P1: 0, P2: 1, P3: 2, P4: 3 };
  out.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9));
  return out.slice(0, input.topN || 12);
}

function buildMarketingWhy(a) {
  const lines = [];
  if (a.primary_action === "PAUSE") {
    lines.push(
      `Meta reports ${a.spend != null ? `Rs ${Math.round(a.spend)}` : "spend"} and ${a.purchases ?? 0} purchases.`
    );
    if (a.spend_vs_account_cpa != null) {
      lines.push(
        `Spend evidence is ${a.spend_vs_account_cpa}× account Meta CPA — above the zero-purchase pause threshold.`
      );
    }
  } else if (a.primary_action === "REDUCE") {
    lines.push(
      `This ad underperforms account benchmarks (CPA ratio ${a.entity_cpa_vs_account_ratio ?? "—"}×).`
    );
  } else if (a.primary_action === "SCALE") {
    lines.push(
      `Meets controlled scale gates. Guidance: ${a.scale_guidance || "small scale test"} — no automatic budget change.`
    );
  } else if (a.constraints?.includes("INVENTORY_LIMITED")) {
    lines.push(
      "Meta performance looks strong but linked inventory is low/critical — hold scale."
    );
  } else {
    lines.push(a.reason || "See evidence in Marketing Decisions.");
  }
  lines.push(`Confidence: ${a.confidence || "—"}.`);
  if (a.warnings?.includes("ATTRIBUTION_IMMATURE")) {
    lines.push("First-party verification is not mature yet — Meta platform evidence only.");
  }
  return lines.join(" ");
}

function buildWatchList(input = {}) {
  const watch = [];
  const md = input.marketing_decisions || {};
  const ev = md.evidence_quality || {};
  if (ev.fp_immature || ev.fp_evidence?.status === "insufficient") {
    watch.push({
      area: "Attribution",
      text: "First-party attribution is still collecting data — Meta numbers are not independently verified yet.",
    });
  }
  const sc = input.shopify_context || {};
  if (Number(sc.contribution_after_meta) < 0) {
    watch.push({
      area: "Shopify",
      text: `Shopify contribution after Meta remains negative (${sc.contribution_after_meta}).`,
    });
  }
  const inv = input.inventory?.summary || {};
  if (Number(inv.capital_at_risk_value) > 0) {
    watch.push({
      area: "Inventory",
      text: `About Rs ${Math.round(Number(inv.capital_at_risk_value)).toLocaleString("en-PK")} is tied up in dead/overstock inventory classes.`,
    });
  }
  if (input.forecast?.confidence === "LOW" || input.forecast?.confidence === "INSUFFICIENT") {
    watch.push({
      area: "Forecast",
      text: `Month-end forecast confidence is ${input.forecast.confidence} — treat projections cautiously.`,
    });
  }
  const bas = input.business_advertising_safety || {};
  if (bas.status === "near_break_even") {
    watch.push({
      area: "Ads",
      text: "Business ad affordability is near break-even — avoid aggressive scale.",
    });
  }
  return watch.slice(0, 8);
}

function statusSentence(area, status, why) {
  return { area, status, why: why || "" };
}

function buildOwnerStatuses(bundle = {}) {
  const bh = bundle.business_health || {};
  const bas = bundle.business_advertising_safety || {};
  const sc = bundle.shopify_context || {};
  const md = bundle.marketing_decisions || {};
  const inv = bundle.inventory?.summary || {};
  const cust = bundle.customers?.summary || {};
  const fp = md.evidence_quality?.fp_evidence || {};
  const dq = bundle.data_quality || {};

  const adsRec = md.account_decision?.recommendation || "HOLD_SPEND";
  const invStatus =
    Number(inv.capital_at_risk_pct) >= 40
      ? "HIGH EXCESS STOCK"
      : Number(inv.restock_now_count) > 0
        ? "RESTOCK PRESSURE"
        : "MONITOR";

  return [
    statusSentence(
      "BUSINESS",
      String(bh.status || "unknown").replace(/_/g, " ").toUpperCase(),
      bh.reason || "See Profitability for detail."
    ),
    statusSentence(
      "ADS",
      String(adsRec).replace(/_/g, " "),
      md.account_decision?.guidance ||
        `Affordability: ${bas.status || "—"}.`
    ),
    statusSentence(
      "SHOPIFY",
      Number(sc.contribution_after_meta) >= 0 ? "CONTRIBUTING" : "NEEDS ATTENTION",
      `Contribution after Meta: ${sc.contribution_after_meta ?? "—"}.`
    ),
    statusSentence(
      "INVENTORY",
      invStatus,
      inv.capital_at_risk_value != null
        ? `Capital at risk ≈ Rs ${Math.round(inv.capital_at_risk_value).toLocaleString("en-PK")}.`
        : "Inventory summary unavailable."
    ),
    statusSentence(
      "CUSTOMERS",
      cust.repeat_customer_rate_pct != null ? "OBSERVED" : "LIMITED DATA",
      cust.repeat_customer_rate_pct != null
        ? `Repeat rate ${cust.repeat_customer_rate_pct}% (observed — not predictive LTV).`
        : "Customer economics not loaded or insufficient."
    ),
    statusSentence(
      "ATTRIBUTION",
      fp.status === "usable" ? "USABLE" : "COLLECTING DATA",
      fp.note || "First-party capture maturity drives this status."
    ),
    statusSentence(
      "DATA QUALITY",
      (dq.warnings || []).length > 5 ? "NEEDS REVIEW" : "OK",
      (dq.warnings || []).length
        ? `${(dq.warnings || []).length} warnings — see Data Quality tab.`
        : "No major warnings on this load."
    ),
  ];
}

function buildFreshness(input = {}) {
  return {
    last_refreshed: new Date().toISOString(),
    period: input.period || null,
    books_through: input.period?.until || null,
    shopify_through: input.period?.until || null,
    meta_through: input.period?.until || null,
    inventory_through: input.period?.until || null,
    attribution_capture_started: input.attribution_capture_started || null,
    notes: [
      "Timestamps reflect the report period end, not live streaming clocks.",
      input.period?.current_day_incomplete
        ? "Current day may still be incomplete."
        : null,
    ].filter(Boolean),
  };
}

/**
 * Assemble executive OS payload for Overview.
 */
function buildExecutiveOperatingSystem(input = {}) {
  const statuses = buildOwnerStatuses(input.bundle || {});
  const do_this_today = buildUnifiedOwnerQueue({
    marketing_queue: input.bundle?.marketing_decisions?.owner_action_queue,
    inventory_stockouts: input.bundle?.inventory?.stockout_risks,
    clearance_candidates: input.bundle?.pricing?.clearance_candidates,
    data_quality_blockers: [
      ...(input.bundle?.marketing_decisions?.data_quality?.blockers || []),
      ...(input.bundle?.data_quality?.warnings || []).slice(0, 5),
    ],
    topN: 10,
  });
  const watch_list = buildWatchList({
    marketing_decisions: input.bundle?.marketing_decisions,
    shopify_context: input.bundle?.shopify_context,
    inventory: input.bundle?.inventory,
    forecast: input.forecast,
    business_advertising_safety: input.bundle?.business_advertising_safety,
  });
  const freshness = buildFreshness({
    period: input.bundle?.date_range || input.period,
    attribution_capture_started: input.attribution_capture_started,
  });

  return {
    title: "WEAR ACTIVE — OWNER BRIEF",
    generated_at: new Date().toISOString(),
    advisory_only: true,
    freshness,
    statuses,
    do_this_today,
    watch_list,
    forecast_summary: input.forecast
      ? {
          label: "FORECAST — NOT ACTUAL",
          confidence: input.forecast.confidence,
          month_to_date: input.forecast.month_to_date,
          conservative: input.forecast.scenarios?.CONSERVATIVE || null,
          base: input.forecast.scenarios?.BASE || null,
          upside: input.forecast.scenarios?.UPSIDE || null,
        }
      : null,
  };
}

function printOwnerBrief(exec) {
  console.log("");
  console.log(exec.title || "WEAR ACTIVE — OWNER BRIEF");
  console.log("================================");
  if (exec.freshness?.period?.since) {
    console.log(
      `Period: ${exec.freshness.period.since} → ${exec.freshness.period.until}`
    );
  }
  console.log(`Last refreshed: ${exec.freshness?.last_refreshed || "—"}`);
  console.log("");
  console.log("STATUS");
  for (const s of exec.statuses || []) {
    console.log(`  ${s.area}: ${s.status}`);
    if (s.why) console.log(`    ${s.why}`);
  }
  console.log("");
  console.log("DO THIS TODAY");
  const actions = (exec.do_this_today || []).slice(0, 8);
  if (!actions.length) console.log("  (nothing urgent)");
  else {
    for (const a of actions) {
      console.log(
        `  [${a.priority}] ${a.primary_action} — ${a.entity_name} (${a.area})`
      );
      console.log(`    Why: ${a.why}`);
    }
  }
  console.log("");
  console.log("WATCH LIST");
  if (!(exec.watch_list || []).length) console.log("  (none)");
  else for (const w of exec.watch_list) console.log(`  - [${w.area}] ${w.text}`);
  console.log("");
  if (exec.forecast_summary) {
    const f = exec.forecast_summary;
    console.log("WHERE WE ARE HEADING (FORECAST — NOT ACTUAL)");
    console.log(`  Confidence: ${f.confidence}`);
    const mtd = f.month_to_date || {};
    console.log(
      `  MTD actual: rev ${mtd.revenue ?? "—"} · orders ${mtd.orders ?? "—"} · profit ${mtd.profit_after_meta ?? "—"}`
    );
    for (const key of ["conservative", "base", "upside"]) {
      const s = f[key];
      if (!s) continue;
      console.log(
        `  ${key}: rev ${s.projected_revenue ?? "—"} · pre-ad ${s.projected_profit_before_ads ?? "—"} · Meta ${s.projected_meta_spend ?? "—"} · after Meta ${s.projected_profit_after_meta ?? "—"}`
      );
    }
    console.log("");
  }
}

module.exports = {
  buildUnifiedOwnerQueue,
  buildWatchList,
  buildOwnerStatuses,
  buildFreshness,
  buildExecutiveOperatingSystem,
  printOwnerBrief,
  normalizePriority,
  dedupeKey,
};
