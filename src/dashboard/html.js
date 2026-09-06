/**
 * Unified reporting dashboard — self-contained HTML from a reporting bundle.
 * Display-only — does not recompute Phase 2/3 classifiers.
 */
const {
  escapeHtml,
  money,
  num,
  pct,
  roas,
  statusClass,
  prettyStatus,
  tip,
  TIPS,
  formatCpaEvidenceHtml,
  sourceBadgeHtml,
} = require("./format");
const { groupRecommendationsByPriority } = require("./groups");
const { enrichProductGroups } = require("./bundle");
const { tipText } = require("./metrics");

const CHANNEL_ORDER = ["Shopify", "Manual", "Other Sales"];

const ATTENTION_STATUSES = [
  "high_priority_spend_no_purchase",
  "spend_no_purchase",
  "high_cpa",
  "weak_funnel",
  "watch",
  "relatively_weak_cpa",
];

const OPPORTUNITY_STATUSES = [
  "hero",
  "healthy_contributor",
  "strong_margin_low_volume",
];

const RISK_STATUSES = ["negative_margin", "high_volume_weak_margin"];

function card(label, value, sub = "", tone = "neutral", tipTextArg = null, source = null) {
  const tipHtml = tipTextArg ? ` ${tip(tipTextArg)}` : "";
  const badge = source ? ` ${sourceBadgeHtml(source)}` : "";
  return `<div class="card tone-${tone}">
    <div class="card-label">${escapeHtml(label)}${tipHtml}${badge}</div>
    <div class="card-value">${value}</div>
    ${sub ? `<div class="card-sub">${sub}</div>` : ""}
  </div>`;
}

function statusTone(status) {
  const s = String(status || "").toUpperCase();
  if (/HEALTHY|PROFITABLE|CONTRIBUTING|OK|USABLE|HOLD|MONITOR|OBSERVED/.test(s)) return "ok";
  if (/ATTENTION|NEAR|EXCESS|RESTOCK|COLLECTING|REVIEW|WARN|LIMITED|NEGATIVE/.test(s)) return "warn";
  if (/UNPROFITABLE|PAUSE|CRITICAL|BAD|ABOVE/.test(s)) return "bad";
  return "neutral";
}

function resolveProductGroups(report) {
  if (Array.isArray(report.product_groups) && report.product_groups.length) {
    return report.product_groups;
  }
  return enrichProductGroups(report.products || []);
}

function productFilterTag(group) {
  if (group.status === "data_issue") return "data-issues";
  if (RISK_STATUSES.includes(group.status)) return "risks";
  if (OPPORTUNITY_STATUSES.includes(group.status)) return "opportunities";
  return "all";
}

function adFilterAttr(entity) {
  const tags = ["all"];
  const st = String(entity.status || "");
  if (ATTENTION_STATUSES.includes(st)) tags.push("needs-attention");
  if (st === "scale_candidate") tags.push("scale-candidate");
  if (
    !entity.purchases ||
    Number(entity.purchases) === 0 ||
    st.includes("spend_no_purchase")
  ) {
    tags.push("zero-purchase");
  }
  if (st === "high_cpa") tags.push("high-cpa");
  if (entity.has_funnel_warning || st === "weak_funnel") {
    tags.push("funnel-warning");
  }
  return tags.join(" ");
}

function renderRecList(list) {
  if (!list.length) return `<p class="empty">None</p>`;
  return `<ul class="rec-list">${list
    .slice(0, 12)
    .map(
      (r) => `<li>
        <div class="rec-head"><strong>${escapeHtml(r.action)}</strong>
          <span class="muted">${escapeHtml(r.entity_name || r.area || "")}</span></div>
        <div>${escapeHtml(r.reason)}</div>
        <div class="muted">confidence: ${escapeHtml(r.confidence)} · ${escapeHtml(r.reason_code || "")}</div>
      </li>`
    )
    .join("")}</ul>`;
}

function renderMetaEntityRows(entities, cur, limit = 50) {
  if (!entities.length) {
    return `<tr><td colspan="8" class="empty">No rows in range.</td></tr>`;
  }
  return entities
    .slice(0, limit)
    .map((e) => {
      const cpa = formatCpaEvidenceHtml(e, {
        moneyFn: (n) => money(n, cur),
        escapeFn: escapeHtml,
      });
      return `<tr data-ad-filter="${adFilterAttr(e)}">
        <td>${escapeHtml((e.entity_name || e.entity_id || "—").slice(0, 64))}</td>
        <td><span class="pill tone-${statusClass(e.status)}">${escapeHtml(prettyStatus(e.status))}</span></td>
        <td>${money(e.spend, cur)}</td>
        <td>${num(e.impressions, 0)}</td>
        <td>${num(e.purchases, 0)}</td>
        <td>${cpa.cpaHtml}</td>
        <td>${cpa.evidenceHtml}</td>
        <td>${e.has_funnel_warning ? (e.primary_weak_funnel ? "Primary weak" : "Warning") : "—"}</td>
      </tr>`;
    })
    .join("");
}

function plRow(label, value, { bold = false, tipText = null } = {}) {
  const tipHtml = tipText ? ` ${tip(tipText)}` : "";
  const tag = bold ? "strong" : "span";
  return `<tr>
    <td>${escapeHtml(label)}${tipHtml}</td>
    <td><${tag}>${value}</${tag}></td>
  </tr>`;
}

const ACTION_LABELS = {
  PAUSE: "Pause",
  REDUCE: "Reduce",
  HOLD: "Hold",
  SCALE: "Scale",
  CREATIVE_TEST: "Creative test",
  PROMOTION_TEST: "Promotion test",
  INSUFFICIENT_DATA: "Insufficient data",
  MONITOR: "Hold",
};

const REASON_LABELS = {
  ZERO_PURCHASE_SPEND: "Spent enough for a normal purchase but generated none.",
  CPA_ABOVE_ACCOUNT: "Cost per purchase is materially worse than the account average.",
  HIGH_CPA: "Cost per purchase is too high for the current evidence.",
  ATTRIBUTION_IMMATURE: "First-party tracking is still new, so Meta results are not independently verified yet.",
  META_NOT_FP_VERIFIED: "Meta results are not yet independently verified by first-party tracking.",
  BUSINESS_PROFITABLE: "The overall business remains profitable.",
  LARGE_AD_SAFETY_MARGIN: "Current ad spend is comfortably within the business safety limit.",
  CLEARANCE_INVENTORY: "Mature inventory is tying up capital and has room for a safe promotion test.",
  HOLD_NEUTRAL: "There is no account-wide reason to change spend right now.",
  INSUFFICIENT_EVIDENCE: "There is not enough evidence to recommend a change yet.",
  WEAK_FUNNEL: "The journey from click to purchase is weaker than normal.",
};

function actionLabel(action) {
  const key = String(action || "INSUFFICIENT_DATA").toUpperCase();
  return ACTION_LABELS[key] || prettyStatus(key).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function actionTone(action) {
  const key = String(action || "").toUpperCase();
  if (key === "PAUSE") return "bad";
  if (key === "REDUCE") return "warn";
  if (key === "SCALE") return "ok";
  if (key === "CREATIVE_TEST") return "info";
  if (key === "PROMOTION_TEST") return "accent";
  if (key === "INSUFFICIENT_DATA") return "muted";
  return "neutral";
}

function friendlyReason(item = {}) {
  const codes = item.reason_codes || [];
  const reasonPriority = [
    "ZERO_PURCHASE_SPEND",
    "CPA_ABOVE_ACCOUNT",
    "HIGH_CPA",
    "WEAK_FUNNEL",
    "CLEARANCE_INVENTORY",
    "ATTRIBUTION_IMMATURE",
    "INSUFFICIENT_EVIDENCE",
    "LARGE_AD_SAFETY_MARGIN",
    "BUSINESS_PROFITABLE",
    "HOLD_NEUTRAL",
  ];
  const priorityCode = reasonPriority.find((code) => codes.includes(code));
  if (priorityCode) return REASON_LABELS[priorityCode];
  if (item.reason && !/\b[A-Z][A-Z0-9_]{3,}\b/.test(item.reason)) return item.reason;
  return "Review the current evidence before changing this item.";
}

function reasonDetails(item = {}) {
  const codes = item.reason_codes || [];
  return codes.length
    ? `<details class="reason-details"><summary>Technical details</summary><code>${escapeHtml(codes.join(", "))}</code></details>`
    : "";
}

function qualityStatus(dataQuality = {}) {
  const critical = dataQuality.blockers || [];
  const warnings = dataQuality.warnings || [];
  if (critical.length) return { label: "Important issue", tone: "bad" };
  if (warnings.length) return { label: "Limited", tone: "warn" };
  return { label: "Good", tone: "ok" };
}

function dataQualityLine(dataQuality) {
  const q = qualityStatus(dataQuality || {});
  return `<p class="quality-line">Data quality: <span class="pill tone-${q.tone}">${q.label}</span></p>`;
}

function accountPosture(recommendation) {
  const key = String(recommendation || "HOLD_SPEND").toUpperCase();
  const map = {
    HOLD_SPEND: ["Hold spend", "Overall ad spend is still affordable. Keep the account steady and act on weak ads individually."],
    SCALE_CAUTIOUSLY: ["Scale cautiously", "The account can support controlled growth, but increase only proven winners and review results frequently."],
    REDUCE_SPEND: ["Reduce spend", "Advertising is putting pressure on profit. Reduce weak areas first instead of making an indiscriminate cut."],
    DEFENSIVE_MODE: ["Defensive mode", "Protect cash and profitability now. Pause the weakest activity and avoid expansion until evidence improves."],
  };
  return map[key] || [prettyStatus(key), "Keep spend steady and use the ranked action queue for individual changes."];
}

function buildCtx(report) {
  const cur = report.meta?.account?.currency || "PKR";
  return {
    cur,
    report,
    bh: report.business_health || {},
    bas: report.business_advertising_safety || {},
    me: report.meta_efficiency || {},
    books: report.books || {},
    p: report.profitability || {},
    sc: report.shopify_context || {},
    mix: report.sales_mix?.channels || [],
    conf: report.confidence || {},
    fb: report.meta?.funnel_baselines || {},
    totals: report.meta?.totals || {},
    recon: report.data_quality?.ad_reconciliation || {},
    conc: report.revenue_concentration || {},
    recBuckets: groupRecommendationsByPriority(
      (report.recommendations || []).filter((r) => r.priority !== "info")
    ),
    contribTone: statusClass(report.shopify_context?.contribution_status),
    operational: report.operational || null,
  };
}

function renderTrendRows(trends, cur) {
  const metrics = trends?.metrics || {};
  const keys = [
    ["meta_spend", "Meta spend", true],
    ["meta_cpa", "Meta CPA", true],
    ["meta_roas", "Meta ROAS", false],
    ["shopify_net_revenue", "Shopify net revenue", true],
    ["shopify_contribution_after_meta", "Shopify contribution", true],
    ["meta_adjusted_profit", "Meta-adjusted profit", true],
    ["recognized_orders", "Recognized orders", false],
  ];
  const rows = keys
    .map(([key, label, isMoney]) => {
      const m = metrics[key];
      if (!m) return "";
      const fmt = (v) => {
        if (v == null) return "—";
        if (key === "meta_roas") return roas(v);
        if (key === "recognized_orders") return num(v, 0);
        if (isMoney) return money(v, cur);
        return String(v);
      };
      const change = !m.comparable
        ? `<span class="muted">${escapeHtml(m.reason === "not_comparable" ? "not comparable" : "no prior snapshot")}</span>`
        : `${m.delta == null ? "—" : isMoney ? money(m.delta, cur) : num(m.delta, 2)}${
            m.delta_pct == null ? "" : ` (${pct(m.delta_pct)})`
          }`;
      return `<tr>
        <td>${escapeHtml(label)}</td>
        <td>${fmt(m.current)}</td>
        <td>${fmt(m.previous)}</td>
        <td>${change}</td>
      </tr>`;
    })
    .join("");
  return rows;
}

function renderDailyAlertsSection(operational) {
  if (!operational) {
    return `<section>
    <h2>Daily Alerts</h2>
    <p class="empty">Historical trend data will appear after multiple daily snapshots. Run <code>npm run reports:daily</code>.</p>
  </section>`;
  }
  const alerts = operational.alerts || [];
  const active = alerts.filter((a) => a.status === "active");
  const resolved = alerts.filter((a) => a.lifecycle === "resolved");
  const bySev = (sev) =>
    active.filter((a) => a.severity === sev);
  const list = (items) =>
    items.length
      ? `<ul class="alert-list">${items
          .map(
            (a) =>
              `<li><span class="pill tone-${
                a.severity === "critical" || a.severity === "high"
                  ? "bad"
                  : a.severity === "medium"
                    ? "warn"
                    : "neutral"
              }">${escapeHtml(String(a.lifecycle || "new").toUpperCase())}</span> <strong>${escapeHtml(a.title)}</strong> — ${escapeHtml(a.message || "")}</li>`
          )
          .join("")}</ul>`
      : `<p class="empty">None</p>`;

  const attn = operational.attention_summary;
  return `<section>
    <div class="divider-label">Operational · Daily Alerts</div>
    <h2>Daily Alerts</h2>
    ${attn?.headline ? `<p class="summary-line">${escapeHtml(attn.headline)}</p>` : ""}
    <div class="grid-2">
      <div><h3>Critical</h3>${list(bySev("critical"))}</div>
      <div><h3>High</h3>${list(bySev("high"))}</div>
      <div><h3>Medium</h3>${list(bySev("medium"))}</div>
      <div><h3>Low / Info</h3>${list([...bySev("low"), ...bySev("info")])}</div>
    </div>
    ${
      resolved.length
        ? `<details style="margin-top:12px"><summary>Resolved (${resolved.length})</summary>${list(resolved)}</details>`
        : ""
    }
  </section>`;
}

function renderTrendsSection(operational, cur) {
  const trends = operational?.trends;
  if (!trends) {
    return `<section>
    <h2>Trends</h2>
    <p class="empty">Historical trend data will appear after multiple daily snapshots.</p>
  </section>`;
  }
  return `<section>
    <div class="divider-label">Operational · Comparable History</div>
    <h2>Trends</h2>
    <p class="note">${escapeHtml(trends.note || "vs previous comparable snapshot")}${
      trends.previous_reporting_date
        ? ` · prior ${escapeHtml(trends.previous_reporting_date)}`
        : ""
    }</p>
    <table class="trend-table">
      <thead><tr><th>Metric</th><th>Current</th><th>Previous</th><th>Change</th></tr></thead>
      <tbody>${renderTrendRows(trends, cur) || `<tr><td colspan="4" class="empty">No trend metrics.</td></tr>`}</tbody>
    </table>
  </section>`;
}

function renderOverview(ctx) {
  const { cur, bh, bas, books, p, sc, totals, conc } = ctx;
  const exec = ctx.report.executive || {};
  const fc = ctx.report.forecast || {};
  const md = ctx.report.marketing_decisions || {};
  const inv = ctx.report.inventory?.summary || {};
  const fresh = exec.freshness || {};
  const profitable = Number(p.meta_adjusted_profit) >= 0;
  const affordable = !["above_break_even", "unprofitable"].includes(bas.status);
  const shopifyHealthy = Number(sc.contribution_after_meta) >= 0;
  const inventoryRisk = Number(inv.capital_at_risk_pct || 0) >= 50;
  const urgent = (exec.do_this_today || md.owner_action_queue || []).some(
    (a) => a.priority === "P1" || a.primary_action === "PAUSE"
  );

  const statuses = exec.statuses || [];
  const statusCards = statuses
    .map(
      (s) => `<div class="owner-status tone-${statusTone(s.status)}">
      <div class="owner-status-area">${escapeHtml(s.area)}</div>
      <div class="owner-status-val">${escapeHtml(s.status)}</div>
      <div class="owner-status-why">${escapeHtml(s.why || "")}</div>
    </div>`
    )
    .join("");

  const actions = (exec.do_this_today || []).slice(0, 8);
  const fallbackActions = !actions.length
    ? (md.owner_action_queue || []).slice(0, 5).map((a) => ({
        ...a,
        area: "Marketing",
        what_to_do: a.primary_action,
        why: a.reason,
      }))
    : [];
  const queue = actions.length ? actions : fallbackActions;
  const actionRows = queue
    .map(
      (a) => `<tr>
    <td><span class="priority priority-${escapeHtml(a.priority || "P4")}">${escapeHtml(a.priority || "P4")}</span></td>
    <td><span class="action action-${actionTone(a.primary_action)}">${escapeHtml(actionLabel(a.primary_action))}</span></td>
    <td>${escapeHtml(a.area || "—")}</td>
    <td>${escapeHtml(a.what_to_do || a.entity_name || "—")}</td>
    <td>${escapeHtml(a.why || friendlyReason(a))}
      ${
        a.expandable_why
          ? `<details class="why-expand"><summary>Why am I seeing this?</summary><p>${escapeHtml(a.expandable_why)}</p>
             <p class="note">${sourceBadgeHtml(a.source || "CALCULATED")} Confidence: ${escapeHtml(a.confidence || "—")}</p></details>`
          : ""
      }
    </td>
    <td>${escapeHtml(String(a.confidence || "—").toUpperCase())}</td>
  </tr>`
    )
    .join("");

  const watchItems = (exec.watch_list || [])
    .map((w) => `<li><strong>${escapeHtml(w.area)}</strong> — ${escapeHtml(w.text)}</li>`)
    .join("");

  const mtd = fc.month_to_date || exec.forecast_summary?.month_to_date || {};
  const scen = (key) =>
    fc.scenarios?.[key] || exec.forecast_summary?.[key.toLowerCase()] || null;
  const conf = fc.confidence || exec.forecast_summary?.confidence || "—";

  return `<div id="view-overview" class="view active">
  ${
    ctx.operational?.snapshot?.period?.current_day_incomplete
      ? `<p class="note tone-warn">Today's Meta and order activity may still be incomplete.</p>`
      : ""
  }
  <section class="hero-section owner-brief">
    <div class="eyebrow">Daily owner screen</div>
    <h2>WEAR ACTIVE — OWNER BRIEF</h2>
    <p class="period-line">Period ${escapeHtml(fresh.period?.since || ctx.report.date_range?.since || "—")} → ${escapeHtml(fresh.period?.until || ctx.report.date_range?.until || "—")} · Last refreshed ${escapeHtml(fresh.last_refreshed || ctx.report.generated_at || "—")}</p>
    <div class="freshness-row">
      <span class="badge">Books through ${escapeHtml(fresh.books_through || "—")}</span>
      <span class="badge">Shopify through ${escapeHtml(fresh.shopify_through || "—")}</span>
      <span class="badge">Meta through ${escapeHtml(fresh.meta_through || "—")}</span>
      <span class="badge">Inventory through ${escapeHtml(fresh.inventory_through || "—")}</span>
      ${fresh.attribution_capture_started ? `<span class="badge">Attribution capture ${escapeHtml(fresh.attribution_capture_started)}</span>` : `<span class="badge">Attribution: collecting</span>`}
    </div>
    <div class="owner-status-grid">${statusCards || `<p class="empty-state">Run <code>npm run reports:owner</code> for full owner statuses.</p>`}</div>
  </section>

  <section>
    <div class="eyebrow">What should I do today?</div>
    <h2>Do This Today</h2>
    <p class="note">Ranked from existing marketing, inventory, pricing, and data-quality evidence. Advisory only — nothing is changed automatically.</p>
    <div class="table-wrap"><table class="action-table">
      <thead><tr><th>Priority</th><th>Action</th><th>Area</th><th>What to do</th><th>Why</th><th>Confidence</th></tr></thead>
      <tbody>${actionRows || `<tr><td colspan="6" class="empty-state">Nothing urgent needs action right now.</td></tr>`}</tbody>
    </table></div>
  </section>

  <section>
    <div class="eyebrow">What should I watch?</div>
    <h2>Watch List</h2>
    <p class="note">Important context that is not necessarily an urgent action today.</p>
    <ul class="watch-list">${watchItems || `<li class="empty-state">No watch items.</li>`}</ul>
  </section>

  <section>
    <div class="eyebrow">Where are we heading?</div>
    <h2>Month outlook ${sourceBadgeHtml("FORECAST")}</h2>
    <p class="callout warning"><strong>FORECAST — NOT ACTUAL.</strong> Deterministic pace projections. Confidence: <strong>${escapeHtml(String(conf))}</strong>.</p>
    ${
      conf === "INSUFFICIENT"
        ? `<p class="note tone-warn">Too little history to project month-end reliably — projections suppressed from decision-making.</p>`
        : `<div class="grid key-grid">
      ${card("ACTUAL MTD revenue", money(mtd.revenue, cur), `Orders ${num(mtd.orders, 0)} · Profit after Meta ${money(mtd.profit_after_meta, cur)}`, "neutral", TIPS.forecast, "BOOKS")}
      ${card("FORECAST revenue (Base)", money(scen("BASE")?.projected_revenue, cur), scen("BASE")?.assumption || "Recent pace continues", "neutral", TIPS.forecast, "FORECAST")}
      ${card("FORECAST pre-ad profit (Base)", money(scen("BASE")?.projected_profit_before_ads, cur), "Sales-pace estimate — not causal", "neutral", TIPS.forecast, "FORECAST")}
      ${card("FORECAST Meta spend (Base)", money(scen("BASE")?.projected_meta_spend, cur), "Spend-pace estimate", "neutral", TIPS.forecast, "FORECAST")}
      ${card("FORECAST profit after Meta (Base)", money(scen("BASE")?.projected_profit_after_meta, cur), "Pre-ad − Meta spend", "neutral", TIPS.forecast, "FORECAST")}
    </div>
    <div class="grid">
      ${card("Conservative revenue", money(scen("CONSERVATIVE")?.projected_revenue, cur), `Profit after Meta ${money(scen("CONSERVATIVE")?.projected_profit_after_meta, cur)}`, "neutral", TIPS.forecast, "FORECAST")}
      ${card("Upside revenue", money(scen("UPSIDE")?.projected_revenue, cur), `Profit after Meta ${money(scen("UPSIDE")?.projected_profit_after_meta, cur)}`, "neutral", TIPS.forecast, "FORECAST")}
    </div>
    <p class="note">Open the Forecast tab for full scenario table, spend what-ifs (no manufactured ROAS), and inventory cover.</p>`
    }
  </section>

  <section>
    <div class="eyebrow">How is the business doing?</div>
    <h2>Key numbers</h2>
    <div class="grid key-grid">
      ${card("Profit after actual Meta spend", money(p.meta_adjusted_profit, cur), "Books ads replaced with Meta spend", profitable ? "ok" : "bad", TIPS.meta_adjusted_profit, "CALCULATED")}
      ${card("Can we afford current ad spend?", affordable ? "Yes" : "No", `${pct(bas.business_cpa_headroom_pct)} headroom`, affordable ? "ok" : "bad", TIPS.affordability, "CALCULATED")}
      ${card("Shopify contribution after Meta", money(sc.contribution_after_meta, cur), shopifyHealthy ? "Contributing" : "Needs attention", shopifyHealthy ? "ok" : "warn", TIPS.shopify_contribution, "CALCULATED")}
      ${card("Inventory capital at risk", money(inv.capital_at_risk_value, cur), inv.capital_at_risk_pct == null ? "Unavailable" : pct(inv.capital_at_risk_pct), inventoryRisk ? "warn" : "neutral", TIPS.inventory_capital_at_risk, "CALCULATED")}
      ${card("Urgent today?", urgent ? "Yes" : "No", urgent ? "Handle P1/P2 below" : "No P1 actions", urgent ? "bad" : "ok")}
    </div>
    <div class="grid">
      ${card("Recognized net revenue", money(books.net_revenue_ex_tax, cur), "Ex-tax, after refunds", "neutral", tipText("net_revenue"), "BOOKS")}
      ${card("Gross margin", pct(books.gross_margin_pct), "After product cost, before opex", "neutral", TIPS.gross_margin, "BOOKS")}
      ${card("Recognized orders", num(books.recognized_orders, 0), "", "neutral", TIPS.recognized_order, "BOOKS")}
      ${card("Meta advertising spend", money(totals.spend, cur), "", "neutral", tipText("meta_spend"), "META")}
      ${card("Meta cost per purchase (CPA)", money(totals.cpa, cur), "Platform only — not affordability", "neutral", TIPS.meta_cpa, "META")}
      ${card("Break-even ad cost per sale", money(p.break_even_cpa, cur), "Business safety threshold", "neutral", TIPS.break_even_cpa, "CALCULATED")}
    </div>
    <p class="note">Do <strong>not</strong> compare Meta CPA to break-even ad cost for affordability. Affordability uses Meta spend ÷ Books recognized orders vs break-even.</p>
    ${conc.non_shopify_distortion_risk ? `<p class="callout warning"><strong>Business Mix Context:</strong> ${escapeHtml(conc.warning || "Profitability is mostly from non-Shopify sales.")}</p>` : ""}
  </section>

  <details class="secondary-section">
    <summary>Business, Shopify, and sales mix context</summary>
    <section>
      <h2>Business Health</h2>
      <p><span class="pill tone-${statusClass(bh.status)}">${escapeHtml(prettyStatus(bh.status))}</span> ${escapeHtml(bh.reason || "")}</p>
      <h3>Business Ad-Spend Affordability ${tip(TIPS.affordability)}</h3>
      <p><span class="pill tone-${statusClass(bas.status)}">${escapeHtml(prettyStatus(bas.status))}</span></p>
    </section>
    <section class="section-shopify">
      <div class="divider-label">Shopify / Ecommerce Context</div>
      <h2>Contribution after Meta</h2>
      <p><span class="pill tone-${statusClass(sc.contribution_status)}">${escapeHtml(prettyStatus(sc.contribution_status))}</span></p>
      <div class="grid">
        ${card("Shopify net revenue", money(sc.net_revenue_ex_tax, cur), "", "neutral", null, "BOOKS")}
        ${card("Shopify refunds", money(sc.refunds, cur), "", "neutral", null, "BOOKS")}
        ${card("Shopify COGS", money(sc.cogs, cur), "", "neutral", TIPS.cogs, "BOOKS")}
        ${card("Shopify ad load", money(sc.ad_load_per_recognized_order ?? sc.shopify_ad_load_per_recognized_order, cur), "DATE-ALIGNED · NOT ATTRIBUTED", "neutral", TIPS.shopify_ad_load, "CALCULATED")}
      </div>
    </section>
    <section>
      <h2>Sales Mix</h2>
      <table><thead><tr><th>Channel</th><th>Orders</th><th>Net Revenue</th></tr></thead><tbody>${ctx.mix.map((c) => `<tr><td>${escapeHtml(c.channel)}</td><td>${num(c.orders, 0)}</td><td>${money(c.net_revenue_ex_tax ?? c.revenue_ex_tax, cur)}</td></tr>`).join("") || `<tr><td colspan="3" class="empty-state">No channel data.</td></tr>`}</tbody></table>
      <p class="note">Meta CPA ${tip(TIPS.meta_cpa)} and Meta ROAS ${tip(TIPS.meta_roas)} are Meta-reported and remain separate from Shopify economics.</p>
    </section>
  </details>
  <details class="secondary-section">
    <summary>Trends and daily alerts</summary>
    ${renderTrendsSection(ctx.operational, cur)}
    ${renderDailyAlertsSection(ctx.operational)}
  </details>
  <section class="quality-section">
    <div class="eyebrow">Data quality and caveats</div>
    ${dataQualityLine(ctx.report.data_quality)}
    <p class="note">Detailed diagnostics are in the Data Quality tab.</p>
  </section>
</div>`;
}

function renderProfitability(ctx) {
  const { cur, books, p, recon, report } = ctx;
  const partialNote = !report.date_range?.is_full_calendar_month
    ? `<p class="note tone-warn">Partial period — month-over-month comparisons may be misleading.</p>`
    : "";

  const plRows = [
    plRow("Gross collected", money(books.gross_collected, cur)),
    plRow("Output tax", money(books.output_tax, cur)),
    plRow("Revenue ex-tax", money(books.revenue_ex_tax, cur)),
    plRow("Refunds", money(books.refunds, cur)),
    plRow("Net revenue ex-tax", money(books.net_revenue_ex_tax, cur)),
    plRow("COGS", money(books.cogs, cur)),
    plRow("Gross profit", money(books.gross_profit, cur)),
    plRow("Gross margin", pct(books.gross_margin_pct)),
    plRow("Delivery expense", money(books.delivery_expense, cur)),
    plRow("Ads expense booked (Ledger)", money(books.ads_expense_booked, cur)),
    plRow("Other non-ad opex", money(books.other_non_ad_opex, cur)),
    plRow("Total opex", money(books.total_opex, cur)),
    plRow("Books net profit", money(books.books_net_profit, cur), {
      bold: true,
      tipText: TIPS.books_net_profit,
    }),
    plRow("Books net margin", pct(books.books_net_margin_pct), { bold: true }),
  ].join("");

  const expenseEntries = Object.entries(report.expense_by_category || {}).sort(
    (a, b) => Number(b[1]) - Number(a[1])
  );
  const expenseRows = expenseEntries.length
    ? expenseEntries
        .map(
          ([cat, amt]) => `<tr>
        <td>${escapeHtml(cat)}</td>
        <td>${money(amt, cur)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="2" class="empty">No expense breakdown available.</td></tr>`;

  const currentAdCost = ctx.bas.business_wide_ad_load_per_recognized_order ?? ctx.bas.blended_ad_cost_per_recognized_order;
  const belowBreakEven = Number(currentAdCost) <= Number(p.break_even_cpa);

  return `<div id="view-profitability" class="view">
  ${partialNote}
  <section class="hero-section">
    <div class="eyebrow">What you need to know</div>
    <h2>Profit position</h2>
    <p class="executive-verdict">${belowBreakEven ? "Current advertising is comfortably below the business break-even level." : "Current advertising costs more per recognized sale than the business can safely absorb."}</p>
    <div class="grid key-grid">
      ${card("Net profit", money(books.books_net_profit, cur), "Books result", statusClass(ctx.bh.status), TIPS.books_net_profit)}
      ${card("Profit before ads", money(p.profit_before_ads, cur))}
      ${card("Meta spend", money(recon.meta_spend ?? ctx.totals.spend, cur))}
      ${card("Meta-adjusted profit", money(p.meta_adjusted_profit, cur), "Books ads replaced with actual Meta spend", statusClass(ctx.bh.status), TIPS.meta_adjusted_profit)}
      ${card("Maximum ad cost per sale", money(p.break_even_cpa, cur), "Before profit is exhausted", "neutral", TIPS.break_even_cpa)}
      ${card("Ad spend per recognized sale", money(currentAdCost, cur), "Across all recognized sales", belowBreakEven ? "ok" : "bad", TIPS.business_wide_ad_load)}
    </div>
  </section>
  <section>
    <div class="eyebrow">Supporting detail</div>
    <h2>Accounting detail</h2>
    <p class="note">Ledger-recognized revenue, direct costs, operating expenses, and booked profit for the selected period.</p>
    <table class="pl-table">
      <tbody>${plRows}</tbody>
    </table>
  </section>

  <section>
    <div class="divider-label">Analytical Adjustment · Meta</div>
    <h2>Meta-Adjusted Profitability</h2>
    <p class="waterfall">
      Books net <strong>${money(books.books_net_profit, cur)}</strong>
      + Ledger Ads <strong>${money(books.ads_expense_booked, cur)}</strong>
      = profit before ads <strong>${money(p.profit_before_ads, cur)}</strong>
      − Meta <strong>${money(recon.meta_spend ?? ctx.totals.spend, cur)}</strong>
      = adjusted <strong>${money(p.meta_adjusted_profit, cur)}</strong>
      (${pct(p.meta_adjusted_margin_pct)} margin)
    </p>
    <p class="note">Actual Meta spend replaces booked Ads for analytical profitability. It is not deducted twice.</p>
    <div class="grid">
      ${card("Profit before ads", money(p.profit_before_ads, cur))}
      ${card("Meta-adjusted profit", money(p.meta_adjusted_profit, cur), "", statusClass(ctx.bh.status), TIPS.meta_adjusted_profit)}
      ${card("Meta-adjusted margin", pct(p.meta_adjusted_margin_pct))}
      ${card("Break-even ad spend", money(p.break_even_ad_spend, cur))}
      ${card("Break-even CPA", money(p.break_even_cpa, cur), "", "neutral", TIPS.break_even_cpa)}
    </div>
  </section>

  <section>
    <h2>Ad Spend Reconciliation</h2>
    <p class="note">Compares date-aligned Meta delivery with booked and recurring advertising expense.</p>
    <div class="grid">
      ${card("Meta spend", money(recon.meta_spend, cur))}
      ${card("Ledger Ads", money(recon.ledger_ads_expense, cur))}
      ${card("Recurring Ads", money(recon.recurring_ads_expense, cur))}
      ${card("Meta − Ledger", money(recon.meta_vs_ledger_variance, cur), escapeHtml(recon.ad_spend_reconciliation_status || ""), statusClass(recon.ad_spend_reconciliation_status))}
    </div>
  </section>

  <section>
    <h2>Expense by Category</h2>
    <p class="note">Booked operating expenses ranked from highest to lowest.</p>
    <table class="money-table">
      <thead><tr><th>Category</th><th>Amount</th></tr></thead>
      <tbody>${expenseRows}</tbody>
    </table>
  </section>
</div>`;
}

function renderSales(ctx) {
  const { cur, report, sc, conc, books } = ctx;
  const sbc = report.sales_by_channel || {};
  const mixTotals = report.sales_mix?.totals || {};
  const channels = CHANNEL_ORDER.filter((n) => sbc[n]).concat(
    Object.keys(sbc).filter((k) => !CHANNEL_ORDER.includes(k))
  );

  const channelRows = channels
    .map((name) => {
      const c = sbc[name];
      const gm = pct(c.gross_margin_pct);
      return `<tr>
      <td>${escapeHtml(name)}</td>
      <td>${num(c.orders, 0)}</td>
      <td>${num(c.units, 0)}</td>
      <td>${money(c.revenue_ex_tax, cur)}</td>
      <td>${money(c.refunds ?? 0, cur)}</td>
      <td>${money(c.net_revenue_ex_tax ?? c.revenue_ex_tax, cur)}</td>
      <td>${money(c.cogs, cur)}</td>
      <td>${money(c.gross_profit, cur)}</td>
      <td>${gm}</td>
    </tr>`;
    })
    .join("");

  // Authoritative paid-sales totals from sales_mix (not recomputed in HTML)
  const paidOrders =
    mixTotals.orders != null ? mixTotals.orders : null;
  const paidUnits = mixTotals.units != null ? mixTotals.units : null;
  const paidGross =
    mixTotals.revenue_ex_tax != null ? mixTotals.revenue_ex_tax : null;
  const paidRefunds =
    mixTotals.refunds != null ? mixTotals.refunds : null;
  const paidNet =
    mixTotals.net_revenue_ex_tax != null
      ? mixTotals.net_revenue_ex_tax
      : null;
  const paidCogs =
    mixTotals.paid_channel_cogs != null
      ? mixTotals.paid_channel_cogs
      : mixTotals.cogs;
  const paidGp = mixTotals.paid_channel_gross_profit;
  const paidGm = pct(mixTotals.paid_channel_gross_margin_pct);

  const concSection = conc?.dominant_channel
    ? `<section>
    <h2>Revenue Concentration</h2>
    <p><strong>${escapeHtml(conc.dominant_channel)}</strong> — ${pct(conc.dominant_channel_revenue_share_pct)} net share · ${num(conc.dominant_channel_orders, 0)} orders</p>
    ${conc.warning ? `<p class="note">${escapeHtml(conc.warning)}</p>` : ""}
    ${conc.non_shopify_distortion_risk ? `<p class="note tone-warn">Non-Shopify concentration affects whole-business metrics — not representative of ecommerce alone.</p>` : ""}
  </section>`
    : "";

  return `<div id="view-sales" class="view">
  <section class="hero-section">
    <div class="eyebrow">What you need to know</div>
    <h2>Who is driving revenue?</h2>
    <div class="grid key-grid">
      ${CHANNEL_ORDER.map((name) => {
        const c = sbc[name] || {};
        return card(name, money(c.net_revenue_ex_tax ?? c.revenue_ex_tax, cur), `${num(c.orders, 0)} recognized orders`);
      }).join("")}
      ${card("Shopify GP before ads", money(sc.gross_profit_before_ads, cur))}
      ${card("Shopify contribution after Meta", money(sc.contribution_after_meta, cur), "After date-aligned Meta spend", statusClass(sc.contribution_status), TIPS.shopify_contribution)}
    </div>
    ${conc.non_shopify_distortion_risk ? `<p class="callout warning"><strong>Attention:</strong> Business profitability is mostly coming from non-Shopify sales, so it does not represent ecommerce performance on its own.</p>` : ""}
  </section>
  <section>
    <div class="eyebrow">Supporting detail</div>
    <h2>Channel economics</h2>
    <p class="note">Recognized paid-sales economics by channel. Gift/PR COGS is excluded here; official Books COGS (including Gift/PR) is on Profitability.</p>
    <table class="sales-table">
      <thead><tr>
        <th>Channel</th><th>Orders</th><th>Units</th><th>Gross</th><th>Refunds</th>
        <th>Net</th><th>COGS</th><th>GP</th><th>GM</th>
      </tr></thead>
      <tbody>
        ${channelRows || `<tr><td colspan="9" class="empty">No channel data.</td></tr>`}
        <tr class="total-row">
          <td><strong>Paid Sales Total ${tip(TIPS.paid_sales_total)}</strong></td>
          <td><strong>${num(paidOrders, 0)}</strong></td>
          <td><strong>${num(paidUnits, 0)}</strong></td>
          <td><strong>${money(paidGross, cur)}</strong></td>
          <td><strong>${money(paidRefunds, cur)}</strong></td>
          <td><strong>${money(paidNet, cur)}</strong></td>
          <td><strong>${money(paidCogs, cur)}</strong></td>
          <td><strong>${money(paidGp, cur)}</strong></td>
          <td><strong>${paidGm}</strong></td>
        </tr>
      </tbody>
    </table>
    <p class="note">${tip(TIPS.paid_sales_gm)} Paid Sales GM excludes Gift/PR COGS. Books GM (Profitability) includes official Ledger COGS.</p>
  </section>

  <section class="section-shopify">
    <h2>Shopify Contribution Waterfall ${tip(TIPS.shopify_contribution)}</h2>
    <div class="badge-row" style="margin-bottom:12px"><span class="badge">DATE-ALIGNED · NOT ATTRIBUTED</span></div>
    <div class="waterfall">
      Shopify net revenue <strong>${money(sc.net_revenue_ex_tax, cur)}</strong>
      − COGS <strong>${money(sc.cogs, cur)}</strong>
      = GP before ads <strong>${money(sc.gross_profit_before_ads, cur)}</strong>
      − Meta <strong>${money(sc.meta_spend, cur)}</strong>
      = contribution <strong>${money(sc.contribution_after_meta, cur)}</strong>
      (${pct(sc.contribution_margin_after_meta_pct)} margin)
    </div>
    <div class="grid" style="margin-top:14px">
      ${card("Shopify ad load / order", money(sc.ad_load_per_recognized_order ?? sc.shopify_ad_load_per_recognized_order, cur), "", "neutral", TIPS.shopify_ad_load)}
      ${card("Gross margin before ads", pct(sc.gross_margin_before_ads_pct))}
      ${card("Paid Sales GM", paidGm, "Excludes Gift/PR COGS", "neutral", TIPS.paid_sales_gm)}
      ${card("Books GM", pct(books.gross_margin_pct), "Includes Gift/PR COGS", "neutral", TIPS.books_gross_margin)}
    </div>
  </section>

  ${concSection}
</div>`;
}

function renderProducts(ctx) {
  const { cur, report } = ctx;
  const groups = resolveProductGroups(report);
  const hasIncomplete = groups.some((g) => g.incomplete_cogs_coverage);
  const opportunityCount = groups.filter((g) => OPPORTUNITY_STATUSES.includes(g.status)).length;
  const riskCount = groups.filter((g) => RISK_STATUSES.includes(g.status)).length;
  const issueCount = groups.filter((g) => g.status === "data_issue").length;
  const incompleteBanner = hasIncomplete
    ? `<p class="note tone-warn"><strong>Incomplete COGS coverage</strong> — aggregate margins may not be authoritative where Ledger COGS is missing.</p>`
    : "";

  const productCards = groups.length
    ? groups
        .map((g) => {
          const filter = productFilterTag(g);
          const gmDisplay = g.incomplete_cogs_coverage
            ? `<span class="pill tone-warn">incomplete</span>`
            : pct(g.gross_margin_pct);
          const skuDetails = g.skus
            .map((s) => {
              const ev = s.evidence || {};
              const extra =
                s.reason_code === "missing_ledger_cogs"
                  ? ` · expected VM COGS ${money(ev.expected_vm_cogs || s.expected_vm_cogs, cur)}`
                  : "";
              const highlight =
                s.status === "data_issue" ? ' class="data-issue-line"' : "";
              return `<li${highlight}><code>${escapeHtml(s.sku || "(no sku)")}</code> · <span class="pill tone-${statusClass(s.status)}">${escapeHtml(prettyStatus(s.status))}</span> · ${escapeHtml(s.reason_code || s.reason || "")}${extra}</li>`;
            })
            .join("");
          const cardClass =
            g.status === "data_issue"
              ? "product-card tone-warn data-issue-card"
              : `product-card tone-${statusClass(g.status)}`;
          return `<div class="${cardClass}" data-product-filter="${filter}">
          <div class="product-head">
            <h3>${escapeHtml(g.product)}</h3>
            <span class="pill tone-${statusClass(g.status)}">${escapeHtml(prettyStatus(g.status))}</span>
          </div>
          <div class="muted">${g.sku_count} SKU${g.sku_count === 1 ? "" : "s"} · rev ${money(g.revenue_ex_tax, cur)} · GP ${money(g.gross_profit, cur)} · GM ${gmDisplay}</div>
          ${g.aggregate_margin_note ? `<p class="note">${escapeHtml(g.aggregate_margin_note)}</p>` : ""}
          <p>${escapeHtml(g.reason || "")}</p>
          <details>
            <summary>SKU details (${g.sku_count})</summary>
            <ul class="sku-list">${skuDetails}</ul>
          </details>
        </div>`;
        })
        .join("")
    : `<p class="empty">No product rows in range.</p>`;

  return `<div id="view-products" class="view">
  <section class="hero-section">
    <div class="eyebrow">What you need to know</div>
    <h2>Product Portfolio</h2>
    <p class="note">Ledger product economics only — no Meta allocation or product-level ROAS.</p>
    <div class="grid key-grid">
      ${card("Products reviewed", num(groups.length, 0))}
      ${card("Opportunities", num(opportunityCount, 0), "Healthy or high-potential products", opportunityCount ? "ok" : "neutral")}
      ${card("Margin risks", num(riskCount, 0), "Products needing commercial review", riskCount ? "warn" : "neutral")}
      ${card("Data issues", num(issueCount, 0), "Fix these before trusting margin conclusions", issueCount ? "bad" : "ok")}
    </div>
  </section>
  <section>
    <div class="eyebrow">What needs action</div>
    <h2>Product detail</h2>
    ${incompleteBanner}
    <div class="filter-bar" id="product-filters">
      <button type="button" class="filter-btn active" data-pf="all">All</button>
      <button type="button" class="filter-btn" data-pf="opportunities">Opportunities</button>
      <button type="button" class="filter-btn" data-pf="risks">Risks</button>
      <button type="button" class="filter-btn" data-pf="data-issues">Data Issues</button>
    </div>
    ${productCards}
  </section>
</div>`;
}

function renderAdvertising(ctx) {
  const { cur, totals, fb, report } = ctx;
  const entityHead = `<tr>
    <th>Name</th><th>Status</th><th>Spend</th><th>Impr</th><th>Purch</th><th>CPA</th><th>Evidence</th><th>Funnel</th>
  </tr>`;

  const funnelSteps = [
    { label: "Impressions", value: num(totals.impressions, 0) },
    { label: "Clicks", value: num(totals.clicks, 0) },
    { label: "Landing page views", value: num(totals.landing_page_views, 0) },
    { label: "Add to carts", value: num(totals.add_to_carts, 0) },
    { label: "Checkouts", value: num(totals.initiated_checkouts, 0) },
    { label: "Purchases", value: num(totals.purchases, 0) },
  ];

  const funnelHtml = funnelSteps
    .map(
      (s, i) => `<div class="funnel-step">
      <div class="funnel-num">${i + 1}</div>
      <div><div class="muted">${escapeHtml(s.label)}</div><strong>${s.value}</strong></div>
    </div>`
    )
    .join("");

  return `<div id="view-advertising" class="view">
  <section class="hero-section">
    <div class="eyebrow">What you need to know · Meta-reported</div>
    <h2>Account performance</h2>
    <p class="note">Meta-attributed delivery and conversion efficiency for the selected reporting period.</p>
    <div class="grid">
      ${card("Spend", money(totals.spend, cur))}
      ${card("Meta-reported purchases", num(totals.purchases, 0))}
      ${card("Meta-reported cost per purchase", money(totals.cpa, cur), "", "neutral", TIPS.meta_cpa)}
      ${card("Meta-reported ROAS", roas(totals.roas), "", "neutral", TIPS.meta_roas)}
      ${card("CTR", pct(totals.ctr ?? fb.ctr))}
      ${card("CPM", money(totals.cpm, cur))}
    </div>
  </section>

  <section>
    <div class="eyebrow">Supporting detail</div>
    <h2>Account Funnel</h2>
    <p class="note">Volume progression from ad delivery through Meta-attributed purchase.</p>
    <div class="funnel">${funnelHtml}</div>
    <div class="grid" style="margin-top:12px">
      ${card("LPV→ATC", pct(fb.lpv_to_atc_pct ?? totals.lpv_to_atc_pct))}
      ${card("ATC→checkout", pct(fb.atc_to_checkout_pct ?? totals.atc_to_checkout_pct))}
      ${card("Checkout→purchase", pct(fb.checkout_to_purchase_pct ?? totals.checkout_to_purchase_pct))}
    </div>
  </section>

  <section>
    <div class="eyebrow">What needs action</div>
    <h2>Campaigns</h2>
    <p class="note">Use the evidence filters to isolate delivery risks and controlled growth candidates.</p>
    <div class="filter-bar" id="ad-filters">
      <button type="button" class="filter-btn active" data-af="all">All</button>
      <button type="button" class="filter-btn" data-af="needs-attention">Needs Attention</button>
      <button type="button" class="filter-btn" data-af="scale-candidate">Scale Candidates</button>
      <button type="button" class="filter-btn" data-af="zero-purchase">Zero Purchase</button>
      <button type="button" class="filter-btn" data-af="high-cpa">High CPA</button>
      <button type="button" class="filter-btn" data-af="funnel-warning">Funnel Warning</button>
    </div>
    <table class="ad-table">
      <thead>${entityHead}</thead>
      <tbody>${renderMetaEntityRows(report.campaigns || [], cur, 30)}</tbody>
    </table>
  </section>

  <section>
    <h2>Ad Sets</h2>
    <table class="ad-table">
      <thead>${entityHead}</thead>
      <tbody>${renderMetaEntityRows(report.adsets || [], cur, 40)}</tbody>
    </table>
  </section>

  <section>
    <h2>Ads</h2>
    <table class="ad-table">
      <thead>${entityHead}</thead>
      <tbody>${renderMetaEntityRows(report.ads || [], cur, 50)}</tbody>
    </table>
  </section>
</div>`;
}

function renderDecisions(ctx) {
  const { cur, report, bh, bas, me, recBuckets, totals } = ctx;
  const ex = report.executive_summary || {};

  const attention = (report.ads || []).filter((a) =>
    ATTENTION_STATUSES.includes(a.status)
  );

  const attentionRows = attention.length
    ? attention
        .slice(0, 20)
        .map((a) => {
          const cpa = formatCpaEvidenceHtml(a, {
            moneyFn: (n) => money(n, cur),
            escapeFn: escapeHtml,
          });
          return `<tr>
      <td>${escapeHtml((a.entity_name || "—").slice(0, 64))}</td>
      <td><span class="pill tone-${statusClass(a.status)}">${escapeHtml(prettyStatus(a.status))}</span></td>
      <td>${money(a.spend, cur)}</td>
      <td>${num(a.purchases, 0)}</td>
      <td>${cpa.cpaHtml}</td>
      <td>${cpa.evidenceHtml}</td>
      <td>${a.has_funnel_warning ? (a.primary_weak_funnel ? "Primary weak" : "Warning") : "—"}</td>
    </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="empty">No ads currently flagged for attention.</td></tr>`;

  const scales = [...(report.ads || []), ...(report.campaigns || [])].filter(
    (e) => e.status === "scale_candidate"
  );

  const scaleBlock = scales.length
    ? scales
        .map((e) => {
          const accCpa = totals.cpa;
          const improve =
            accCpa > 0 && e.meta_attributed_cpa != null
              ? Math.round((1 - e.meta_attributed_cpa / accCpa) * 1000) / 10
              : null;
          return `<div class="scale-card">
          <div class="scale-title">Controlled budget increase candidate</div>
          <h3>${escapeHtml(e.entity_name || e.entity_id || "—")}</h3>
          <div class="grid-3">
            <div><span class="muted">Spend</span><strong>${money(e.spend, cur)}</strong></div>
            <div><span class="muted">Purchases</span><strong>${num(e.purchases, 0)}</strong></div>
            <div><span class="muted">CPA</span><strong>${money(e.meta_attributed_cpa, cur)}</strong></div>
            <div><span class="muted">Account CPA</span><strong>${money(accCpa, cur)}</strong></div>
            <div><span class="muted">CPA improvement</span><strong>${improve == null ? "—" : `${improve}%`}</strong></div>
            <div><span class="muted">Meta ROAS</span><strong>${roas(e.meta_attributed_roas)} vs ${roas(totals.roas)}</strong></div>
          </div>
          <p class="note">Funnel warning: ${e.has_funnel_warning ? "yes" : "no"} · Advisory only — do not auto-scale.</p>
        </div>`;
        })
        .join("")
    : `<p class="empty">No ads currently have enough evidence for controlled scaling.</p>`;

  const groups = resolveProductGroups(report);
  const productDecisions = groups.length
    ? groups
        .slice(0, 20)
        .map(
          (g) => `<div class="product-card tone-${statusClass(g.status)}">
        <div class="product-head">
          <h3>${escapeHtml(g.product)}</h3>
          <span class="pill tone-${statusClass(g.status)}">${escapeHtml(prettyStatus(g.status))}</span>
        </div>
        <p>${escapeHtml(g.reason || g.reason_code || "")}</p>
        <div class="muted">${g.sku_count} SKU${g.sku_count === 1 ? "" : "s"} · rev ${money(g.revenue_ex_tax, cur)} · GP ${money(g.gross_profit, cur)}</div>
      </div>`
        )
        .join("")
    : `<p class="empty">No product decisions in range.</p>`;

  return `<div id="view-decisions" class="view">
  <section>
    <div class="divider-label">Cross-Channel · Advisory</div>
    <h2>Business Decision Summary</h2>
    <div class="grid">
      ${card("Business health", `<span class="pill tone-${statusClass(bh.status)}">${escapeHtml(prettyStatus(bh.status))}</span>`, escapeHtml(bh.reason || ""), statusClass(bh.status))}
      ${card("Ad-spend affordability", `<span class="pill tone-${statusClass(bas.status)}">${escapeHtml(prettyStatus(bas.status))}</span>`, "", statusClass(bas.status))}
      ${card("Meta efficiency", `<span class="pill tone-${statusClass(me.status)}">${escapeHtml(prettyStatus(me.status || "—"))}</span>`)}
    </div>
    ${ex.one_liner ? `<p class="summary-line">${escapeHtml(ex.one_liner)}</p>` : ""}
  </section>

  <section>
    <h2>Top Actions</h2>
    <div class="grid-2">
      <div><h3>High</h3>${renderRecList([...(recBuckets.critical || []), ...(recBuckets.high || [])])}</div>
      <div><h3>Medium</h3>${renderRecList(recBuckets.medium || [])}</div>
      <div><h3>Low</h3>${renderRecList(recBuckets.low || [])}</div>
    </div>
  </section>

  <section>
    <h2>Ads Needing Attention</h2>
    <p class="note">Entities with material cost, conversion, or funnel evidence that warrants review.</p>
    <table class="ad-table">
      <thead><tr><th>Ad</th><th>Status</th><th>Spend</th><th>Purch</th><th>CPA</th><th>Evidence</th><th>Funnel</th></tr></thead>
      <tbody>${attentionRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Scale Candidates</h2>
    <p class="note">Evidence-backed candidates for a controlled budget increase. Review manually before any change.</p>
    ${scaleBlock}
  </section>

  <section>
    <h2>Product Decisions</h2>
    <p class="note">Books product economics only — no product-level Meta ROAS or campaign attribution.</p>
    ${productDecisions}
  </section>
</div>`;
}

function renderDataQuality(ctx) {
  const { cur, report, recon, conf } = ctx;
  const warnings = report.data_quality?.warnings || [];
  const productIssues = (report.products || []).filter(
    (p) => p.status === "data_issue"
  );

  const warningList = warnings.length
    ? warnings
        .map(
          (w) =>
            `<li class="tone-${statusClass(w.severity || w.code)}"><strong>${escapeHtml(w.code)}</strong> — ${escapeHtml(w.message)}</li>`
        )
        .join("")
    : `<li class="empty">No accounting warnings.</li>`;

  const productIssueList = productIssues.length
    ? productIssues
        .slice(0, 25)
        .map(
          (p) =>
            `<li><code>${escapeHtml(p.sku || "(no sku)")}</code> · ${escapeHtml(p.product || "")} — ${escapeHtml(p.reason || p.reason_code || "data issue")}</li>`
        )
        .join("")
    : `<li class="empty">No product data issues flagged.</li>`;

  const mix = report.sales_mix?.channels || [];
  const channelRows = mix.length
    ? mix
        .map(
          (c) => `<tr>
        <td>${escapeHtml(c.channel)}</td>
        <td>${num(c.orders, 0)}</td>
        <td>${money(c.net_revenue_ex_tax ?? c.revenue_ex_tax, cur)}</td>
        <td>${pct(c.net_revenue_share_pct ?? c.revenue_share_pct)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">Channel coverage unavailable.</td></tr>`;

  const pipe = report.pipeline;
  const pipelineBlock = pipe
    ? `<section>
    <h2>Open Pipeline ${tip(TIPS.open_pipeline)}</h2>
    <div class="grid">
      ${card("Open orders", num(pipe.open_pipeline_orders, 0))}
      ${card("Open units", num(pipe.open_pipeline_units, 0))}
      ${card("Open gross (customer value)", money(pipe.open_pipeline_gross, cur))}
    </div>
    <p class="note">Open pipeline is not recognized revenue.</p>
  </section>`
    : `<section>
    <h2>Open Pipeline ${tip(TIPS.open_pipeline)}</h2>
    <p class="empty">Pipeline data not loaded for this report.</p>
  </section>`;

  return `<div id="view-data-quality" class="view">
  <section>
    <div class="divider-label">Trust Layer · Reporting Inputs</div>
    <h2>Accounting Warnings</h2>
    <p class="note">Issues that may affect how confidently the report can be interpreted.</p>
    <ul class="warn-list">${warningList}</ul>
  </section>

  <section>
    <h2>Ad Spend Reconciliation</h2>
    <div class="grid">
      ${card("Meta spend", money(recon.meta_spend, cur))}
      ${card("Ledger Ads", money(recon.ledger_ads_expense, cur))}
      ${card("Recurring Ads", money(recon.recurring_ads_expense, cur))}
      ${card("Meta − Ledger", money(recon.meta_vs_ledger_variance, cur), escapeHtml(recon.ad_spend_reconciliation_status || ""), statusClass(recon.ad_spend_reconciliation_status))}
    </div>
  </section>

  <section>
    <h2>Product Data Issues</h2>
    <ul>${productIssueList}</ul>
  </section>

  <section>
    <h2>Channel Coverage</h2>
    <table>
      <thead><tr><th>Channel</th><th>Orders</th><th>Net Revenue</th><th>Share</th></tr></thead>
      <tbody>${channelRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Attribution</h2>
    <p><span class="pill tone-bad">UNAVAILABLE</span></p>
    <p class="note">${escapeHtml(conf.notes?.attribution || "No Meta→Shopify order-level attribution is available. Attribution claims requiring Meta→Shopify joins are unavailable.")}</p>
  </section>

  ${pipelineBlock}

  <section>
    <h2>Confidence</h2>
    <div class="conf-grid">
      <div class="conf-item"><div class="muted">Business</div><strong class="tone-${statusClass(conf.business)}">${escapeHtml(prettyStatus(conf.business))}</strong></div>
      <div class="conf-item"><div class="muted">Advertising</div><strong class="tone-${statusClass(conf.advertising)}">${escapeHtml(prettyStatus(conf.advertising))}</strong></div>
      <div class="conf-item"><div class="muted">Entities</div><strong class="tone-${statusClass(conf.entities)}">${escapeHtml(prettyStatus(conf.entities))}</strong></div>
      <div class="conf-item"><div class="muted">Products</div><strong class="tone-${statusClass(conf.products)}">${escapeHtml(prettyStatus(conf.products))}</strong></div>
      <div class="conf-item"><div class="muted">Attribution</div><strong class="tone-bad">${escapeHtml(prettyStatus(conf.attribution || "unavailable"))}</strong></div>
    </div>
  </section>
</div>`;
}

function renderAttribution(ctx) {
  const attr = ctx.report?.attribution;
  if (!attr) {
    return `<div id="view-attribution" class="view">
  <section>
    <div class="divider-label">FIRST-PARTY ATTRIBUTION — EXPERIMENTAL</div>
    <h2>Attribution</h2>
    <p class="note">Attribution diagnostics are not loaded for this report. Run <code>npm run attribution:report</code> or regenerate the dashboard.</p>
    <p class="note">Phase 5A diagnostics only. Attributed economics live under <strong>Attr. Economics</strong> (experimental, observational).</p>
  </section>
</div>`;
  }

  const s = attr.status_counts || {};
  const c = attr.confidence_counts || {};
  const e = attr.entity_ids || {};
  const warnings = Object.entries(attr.warnings || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(
      ([code, n]) =>
        `<li><strong>${escapeHtml(code)}</strong> — ${num(n, 0)}</li>`
    )
    .join("");
  const sources = Object.entries(attr.source_distribution || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(
      ([src, n]) =>
        `<tr><td>${escapeHtml(src)}</td><td>${num(n, 0)}</td></tr>`
    )
    .join("");

  return `<div id="view-attribution" class="view">
  <section>
    <div class="divider-label">FIRST-PARTY ATTRIBUTION — EXPERIMENTAL</div>
    <h2>Attribution Coverage</h2>
    <p class="note">Conservative first-party + Shopify journey diagnostics. No attributed profit. Capture started ${escapeHtml(attr.capture_started_at || "—")} · basis ${escapeHtml(attr.coverage_basis || "—")}.</p>
    <div class="grid">
      ${card("Coverage", attr.attribution_coverage_pct == null ? "—" : pct(attr.attribution_coverage_pct))}
      ${card("Shopify orders", num(attr.shopify_orders, 0))}
      ${card("Post-capture orders", num(attr.post_capture_orders, 0))}
      ${card("Usable (basis)", num(attr.coverage_basis === "post_capture" ? attr.post_capture_usable : attr.usable_attribution, 0))}
      ${card("Meta first-party", num(s.meta_first_party, 0))}
      ${card("Unattributed", num(s.unattributed, 0))}
    </div>
  </section>
  <section>
    <h2>Status &amp; Confidence</h2>
    <div class="grid">
      ${card("Organic", num(s.organic, 0))}
      ${card("Direct", num(s.direct, 0))}
      ${card("Paid non-Meta", num(s.paid_non_meta, 0))}
      ${card("Unknown", num(s.unknown, 0))}
      ${card("High confidence", num(c.high, 0))}
      ${card("Medium", num(c.medium, 0))}
      ${card("Low", num(c.low, 0))}
      ${card("None", num(c.none, 0))}
    </div>
  </section>
  <section>
    <h2>Stable Meta ID Matching</h2>
    <div class="grid">
      ${card("Campaign matched", `${num(e.campaign_matched, 0)} / ${num(e.campaign_present, 0)}`)}
      ${card("Ad set matched", `${num(e.adset_matched, 0)} / ${num(e.adset_present, 0)}`)}
      ${card("Ad matched", `${num(e.ad_matched, 0)} / ${num(e.ad_present, 0)}`)}
    </div>
    <p class="note">Matching uses stable IDs only — no fuzzy ad-name joins.</p>
  </section>
  <section>
    <h2>Source Distribution</h2>
    <table><thead><tr><th>Source</th><th>Orders</th></tr></thead><tbody>${sources || `<tr><td colspan="2" class="empty">No sources.</td></tr>`}</tbody></table>
  </section>
  <section>
    <h2>Data Quality</h2>
    <ul class="warn-list">${warnings || `<li class="empty">No attribution warnings.</li>`}</ul>
  </section>
</div>`;
}

function renderEntityEconRows(rows) {
  return (rows || [])
    .slice(0, 20)
    .map((r) => {
      const label = r.name
        ? `${escapeHtml(r.name)} <span class="muted">(${escapeHtml(String(r.id))})</span>`
        : escapeHtml(String(r.id || "—"));
      const tag = r.matched ? "" : ` <span class="tone-warn">unmatched</span>`;
      return `<tr>
  <td>${label}${tag}</td>
  <td>${num(r.orders, 0)}</td>
  <td>${money(r.revenue_ex_tax)}</td>
  <td>${money(r.cogs)}</td>
  <td>${money(r.gross_profit)}</td>
  <td>${money(r.meta_spend)}</td>
  <td>${money(r.first_party_cpa)}</td>
  <td>${r.first_party_roas == null ? "—" : `${num(r.first_party_roas, 2)}x`}</td>
  <td>${r.gp_roas == null ? "—" : `${num(r.gp_roas, 2)}x`}</td>
  <td>${money(r.contribution_after_meta)}</td>
</tr>`;
    })
    .join("");
}

function renderAttributionEconomics(ctx) {
  const econ = ctx.report?.attribution_economics;
  if (!econ) {
    return `<div id="view-attr-economics" class="view">
  <section>
    <div class="divider-label">FIRST-PARTY ATTRIBUTED ECONOMICS — EXPERIMENTAL</div>
    <h2>Attributed Economics</h2>
    <p class="note">Not loaded for this report. Run <code>npm run attribution:economics</code> or regenerate the dashboard.</p>
    <p class="note">Observational first-party attribution only — not causal. Meta-reported metrics remain separate. Decision classifiers unchanged.</p>
  </section>
</div>`;
  }

  const a = econ.account || {};
  const warnList = (econ.warnings || [])
    .map((w) => `<li>${escapeHtml(w)}</li>`)
    .join("");
  const th = `<thead><tr>
  <th>Entity</th><th>Orders</th><th>Revenue</th><th>COGS</th><th>GP</th>
  <th>Meta spend</th><th>FP CPA</th><th>FP ROAS</th><th>GP ROAS</th><th>Contribution</th>
</tr></thead>`;

  return `<div id="view-attr-economics" class="view">
  <section>
    <div class="divider-label">FIRST-PARTY ATTRIBUTED ECONOMICS — EXPERIMENTAL</div>
    <h2>Account Summary</h2>
    <p class="note">${escapeHtml(econ.observational_note || "Observational attribution — not causal.")} Confidence: <strong>${escapeHtml(econ.confidence || "—")}</strong>.</p>
    <div class="grid">
      ${card("Shopify recognized rev", money(a.shopify_recognized_revenue))}
      ${card("Attributed revenue", money(a.attributed_revenue))}
      ${card("Unattributed revenue", money(a.unattributed_revenue))}
      ${card("Attributed coverage", a.attributed_coverage_pct == null ? "—" : pct(a.attributed_coverage_pct))}
      ${card("Meta spend", money(a.meta_spend))}
      ${card("Obs. GP − Meta spend", money(a.first_party_attributed_contribution))}
      ${card("Post-capture recog.", num(a.post_capture_recognized_orders, 0))}
      ${card("Post-capture attributed", num(a.post_capture_attributed_orders, 0))}
      ${card("Post-capture unattr.", num(a.post_capture_unattributed_orders, 0))}
      ${card("Stable-ID coverage", a.stable_id_coverage_pct == null ? "—" : pct(a.stable_id_coverage_pct))}
    </div>
    <p class="note">${escapeHtml(a.contribution_label || "Observed attributed GP less period Meta spend — coverage-sensitive, not true business contribution.")}</p>
  </section>
  <section>
    <h2>Campaigns</h2>
    <table>${th}<tbody>${renderEntityEconRows(econ.campaigns) || `<tr><td colspan="10" class="empty">None.</td></tr>`}</tbody></table>
  </section>
  <section>
    <h2>Ad Sets</h2>
    <table>${th}<tbody>${renderEntityEconRows(econ.adsets) || `<tr><td colspan="10" class="empty">None.</td></tr>`}</tbody></table>
  </section>
  <section>
    <h2>Ads</h2>
    <table>${th}<tbody>${renderEntityEconRows(econ.ads) || `<tr><td colspan="10" class="empty">None.</td></tr>`}</tbody></table>
  </section>
  <section>
    <h2>Data Quality</h2>
    <ul class="warn-list">${warnList || `<li class="empty">No economics warnings.</li>`}</ul>
    <p class="note">Unmatched ID occurrences — campaign ${num(econ.unmatched?.campaign_ids, 0)}, ad set ${num(econ.unmatched?.adset_ids, 0)}, ad ${num(econ.unmatched?.ad_ids, 0)}.</p>
  </section>
</div>`;
}

function invSkuRows(rows, cols = 8) {
  if (!rows?.length) {
    return `<tr><td colspan="${cols}" class="empty">None.</td></tr>`;
  }
  return rows
    .map(
      (r) => `<tr>
      <td>${escapeHtml(r.sku || "—")}</td>
      <td>${escapeHtml(r.product || "—")}<div class="muted">${escapeHtml(r.variant || "")}</div></td>
      <td>${num(r.current_stock, 0)}</td>
      <td>${r.days_of_cover == null ? "—" : num(r.days_of_cover, 1)}</td>
      <td>${num(r.units_sold_30d, 0)}</td>
      <td>${escapeHtml(r.stock_class || "—")}</td>
      <td>${escapeHtml(r.recommended_action || "—")}${
        r.recommended_restock_qty != null
          ? ` <span class="muted">(+${num(r.recommended_restock_qty, 0)})</span>`
          : ""
      }</td>
      <td>${money(r.inventory_value)}</td>
    </tr>`
    )
    .join("");
}

function renderInventory(ctx) {
  const inv = ctx.report?.inventory;
  if (!inv) {
    return `<div id="view-inventory" class="view">
  <section>
    <div class="divider-label">INVENTORY &amp; DEMAND INTELLIGENCE</div>
    <h2>Inventory</h2>
    <p class="note">Not loaded for this report. Run <code>npm run inventory:report</code> or regenerate the dashboard.</p>
    <p class="note">Advisory only — no Shopify inventory mutations, no purchase orders, no price changes.</p>
  </section>
</div>`;
  }
  if (inv.error) {
    return `<div id="view-inventory" class="view">
  <section>
    <div class="divider-label">INVENTORY &amp; DEMAND INTELLIGENCE</div>
    <h2>Inventory</h2>
    <p class="note tone-bad">${escapeHtml(inv.error)}</p>
  </section>
</div>`;
  }

  const s = inv.summary || {};
  const th = `<thead><tr>
  <th>SKU</th><th>Product / Variant</th><th>Stock</th><th>Days cover</th>
  <th>Sold 30d</th><th>Class</th><th>Action</th><th>Value</th>
</tr></thead>`;
  const warnList = (inv.data_quality?.warnings || [])
    .slice(0, 40)
    .map((w) => `<li>${escapeHtml(w)}</li>`)
    .join("");

  const productRows = (inv.products || [])
    .slice(0, 40)
    .map(
      (p) => `<tr>
      <td>${escapeHtml(p.product || "—")}</td>
      <td>${num(p.current_stock, 0)}</td>
      <td>${num(p.units_sold_30d, 0)}</td>
      <td>${money(p.inventory_value)}</td>
      <td>${escapeHtml(p.worst_stock_class || "—")}${
        p.has_variant_stockout_risk
          ? ` <span class="pill tone-bad">VARIANT RISK</span>`
          : ""
      }</td>
      <td>${num(p.critical_variant_count, 0)} / ${num(p.low_variant_count, 0)} / ${num(p.out_of_stock_variant_count, 0)}</td>
    </tr>`
    )
    .join("");

  return `<div id="view-inventory" class="view">
  <section class="hero-section">
    <div class="eyebrow">What you need to know</div>
    <h2>Inventory position</h2>
    <p class="executive-verdict">${Number(s.capital_at_risk_pct || 0) >= 50 ? "Too much inventory capital is tied up in dead stock and overstock." : "Inventory capital at risk is currently contained."}</p>
    <div class="grid key-grid">
      ${card("Total stock", num(s.total_shopify_inventory_units_if_safe ?? s.total_units, 0), "Sellable units where safe to count")}
      ${card("Capital tied up", money(s.total_inventory_value), "At product cost")}
      ${card("Dead stock · 90d", money(s.dead_inventory_value), `${num(s.no_demand_sku_count, 0)} SKUs with no demand`, "bad")}
      ${card("Overstock", money(s.overstock_value), `${num(s.overstock_sku_count, 0)} SKUs`, "warn")}
      ${card("Low / critical stock", `${num(s.low_sku_count, 0)} / ${num(s.critical_sku_count, 0)}`, "Low / critical SKUs", Number(s.critical_sku_count) ? "bad" : "warn")}
    </div>
    <p class="callout neutral"><strong>Watch, not dead:</strong> ${money(s.no_recent_demand_value)} has no recent demand over 30 days. The 90-day dead-stock figure above is the more serious signal.</p>
  </section>
  <section>
    <div class="eyebrow">What needs action · Restock risk</div>
    <h2>Restock Priorities</h2>
    <table>${th}<tbody>${invSkuRows((inv.restock_priorities || []).slice(0, 20))}</tbody></table>
  </section>
  <section>
    <h2>Stockout Risks</h2>
    <table>${th}<tbody>${invSkuRows((inv.stockout_risks || []).slice(0, 20))}</tbody></table>
  </section>
  <section>
    <div class="eyebrow">What needs action · Cash recovery</div>
    <h2>Dead stock and overstock</h2>
    <table>${th}<tbody>${invSkuRows((inv.dead_slow_stock || []).slice(0, 20))}</tbody></table>
  </section>
  <section>
    <h2>Top Sellers</h2>
    <table>${th}<tbody>${invSkuRows((inv.top_sellers || []).slice(0, 15))}</tbody></table>
  </section>
  <section>
    <h2>Product Summary</h2>
    <p class="note">Product totals can look healthy while a size/color is critical — VARIANT RISK flags that.</p>
    <table>
      <thead><tr>
        <th>Product</th><th>Units</th><th>Sold 30d</th><th>Value</th><th>Worst class</th><th>Crit / Low / OOS</th>
      </tr></thead>
      <tbody>${productRows || `<tr><td colspan="6" class="empty">None.</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2>Variant table (priority order)</h2>
    <table>${th}<tbody>${invSkuRows((inv.skus || []).slice(0, 50))}</tbody></table>
  </section>
  <section>
    <h2>Data Quality</h2>
    ${dataQualityLine(inv.data_quality)}
    <ul class="warn-list">${warnList || `<li class="empty">No inventory warnings.</li>`}</ul>
  </section>
</div>`;
}

function renderCustomers(ctx) {
  const cust = ctx.report?.customers;
  if (!cust) {
    return `<div id="view-customers" class="view">
  <section>
    <div class="divider-label">CUSTOMER &amp; COHORT ECONOMICS</div>
    <h2>Customers</h2>
    <p class="note">Not loaded for this report. Run <code>npm run customers:report</code> or regenerate the dashboard.</p>
    <p class="note">Observed customer value only — not predictive LTV. No CRM/email actions.</p>
  </section>
</div>`;
  }
  if (cust.error) {
    return `<div id="view-customers" class="view">
  <section>
    <div class="divider-label">CUSTOMER &amp; COHORT ECONOMICS</div>
    <h2>Customers</h2>
    <p class="note tone-bad">${escapeHtml(cust.error)}</p>
  </section>
</div>`;
  }

  const s = cust.summary || {};
  const nv = cust.new_vs_returning || {};
  const ov = cust.observed_customer_value || {};
  const rp = cust.repurchase || {};
  const cac = cust.observed_cac || {};
  const warnList = (cust.data_quality?.warnings || [])
    .map((w) => `<li>${escapeHtml(w)}</li>`)
    .join("");

  function bucketCards(label, b = {}) {
    return `<section>
    <h2>${escapeHtml(label)}</h2>
    <div class="grid">
      ${card("Orders", num(b.orders, 0))}
      ${card("Revenue", money(b.revenue))}
      ${card("GP", money(b.gross_profit))}
      ${card("GM", b.gross_margin_pct == null ? "—" : pct(b.gross_margin_pct))}
      ${card("AOV", money(b.aov))}
      ${card("GP/order", money(b.gp_per_order))}
    </div>
  </section>`;
  }

  const cohortRows = (cust.cohorts || [])
    .slice(-18)
    .map((c) => {
      const cell = (chk) =>
        chk?.matured ? (chk.rate_pct == null ? "—" : pct(chk.rate_pct)) : "—";
      return `<tr>
      <td>${escapeHtml(c.cohort)}</td>
      <td>${num(c.customers, 0)}</td>
      <td>${money(c.revenue_per_customer)}</td>
      <td>${money(c.gp_per_customer)}</td>
      <td>${c.repeat_rate_pct == null ? "—" : pct(c.repeat_rate_pct)}</td>
      <td>${cell(c.repeat_by_30d)}</td>
      <td>${cell(c.repeat_by_60d)}</td>
      <td>${cell(c.repeat_by_90d)}</td>
    </tr>`;
    })
    .join("");

  const acqRows = (cust.acquisition_cohorts || [])
    .map(
      (a) => `<tr>
      <td>${escapeHtml(a.acquisition)}</td>
      <td>${num(a.customers, 0)}</td>
      <td>${money(a.revenue_per_customer)}</td>
      <td>${money(a.gp_per_customer)}</td>
      <td>${num(a.orders_per_customer, 2)}</td>
      <td>${a.repeat_rate_pct == null ? "—" : pct(a.repeat_rate_pct)}</td>
    </tr>`
    )
    .join("");

  const topCust = (ov.top_customers || [])
    .slice(0, 20)
    .map(
      (c) => `<tr>
      <td><code>${escapeHtml(c.customer_key)}</code></td>
      <td>${num(c.recognized_orders, 0)}</td>
      <td>${money(c.lifetime_recognized_revenue)}</td>
      <td>${money(c.lifetime_gp)}</td>
      <td>${escapeHtml(c.first_order_date || "—")}</td>
      <td>${escapeHtml(c.cohort_month || "—")}</td>
      <td>${escapeHtml(c.first_order_acquisition || "—")}</td>
    </tr>`
    )
    .join("");

  return `<div id="view-customers" class="view">
  <section class="hero-section">
    <div class="eyebrow">What you need to know</div>
    <h2>Customer overview</h2>
    <p class="note">Recognized Shopify + Ledger economics. New/Returning = within loaded history only (not proven lifetime-first). Identity via Shopify customer ID (email hashed only if needed). Confidence: <strong>${escapeHtml(cust.confidence || "—")}</strong>.</p>
    <div class="grid">
      ${card("New customers", num(s.new_in_observed_history_customers ?? s.new_customers, 0), "Within loaded history")}
      ${card("Returning customers", num(s.returning_in_observed_history_customers ?? s.returning_customers, 0), "Within loaded history")}
      ${card("Repeat purchase rate", s.repeat_customer_rate_pct == null ? "Not enough data yet" : pct(s.repeat_customer_rate_pct))}
      ${card("Average value per customer", money(s.revenue_per_identified_customer))}
      ${card("Median days to second order", rp.median_days_to_second_order == null ? "Not enough data yet" : num(rp.median_days_to_second_order, 1))}
    </div>
  </section>
  ${bucketCards("New customer orders", nv.new_customer_orders)}
  ${bucketCards("Returning customer orders", nv.returning_customer_orders)}
  <section>
    <h2>Observed Customer Value</h2>
    <p class="note">${escapeHtml(ov.note || "Not predictive LTV.")}</p>
    <div class="grid">
      ${card("Avg orders", num(ov.average_orders, 2))}
      ${card("Avg revenue", money(ov.average_revenue))}
      ${card("Avg GP", money(ov.average_gp))}
    </div>
    <table>
      <thead><tr><th>Customer key</th><th>Orders</th><th>Revenue</th><th>GP</th><th>First</th><th>Cohort</th><th>Acquisition</th></tr></thead>
      <tbody>${topCust || `<tr><td colspan="7" class="empty">None.</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2>Repeat Purchase</h2>
    <div class="grid">
      ${card("Median days to 2nd", num(rp.median_days_to_second_order, 1))}
      ${card("Avg days to 2nd", num(rp.average_days_to_second_order, 1))}
      ${card("Repeat ≤30d", rp.repeat_within_30d?.rate_pct == null ? "—" : pct(rp.repeat_within_30d.rate_pct))}
      ${card("Repeat ≤60d", rp.repeat_within_60d?.rate_pct == null ? "—" : pct(rp.repeat_within_60d.rate_pct))}
      ${card("Repeat ≤90d", rp.repeat_within_90d?.rate_pct == null ? "—" : pct(rp.repeat_within_90d.rate_pct))}
    </div>
  </section>
  <section>
    <h2>Monthly Cohorts</h2>
    <p class="note">Immature 30/60/90 checkpoints show as — (cohort has not aged).</p>
    <table>
      <thead><tr><th>Cohort</th><th>Customers</th><th>Rev/cust</th><th>GP/cust</th><th>Repeat</th><th>30d</th><th>60d</th><th>90d</th></tr></thead>
      <tbody>${cohortRows || `<tr><td colspan="8" class="empty">None.</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2>Acquisition Cohorts</h2>
    <p class="note">First-order first-party acquisition. Unattributed customers are not allocated.</p>
    <table>
      <thead><tr><th>Acquisition</th><th>Customers</th><th>Rev/cust</th><th>GP/cust</th><th>Orders/cust</th><th>Repeat</th></tr></thead>
      <tbody>${acqRows || `<tr><td colspan="6" class="empty">None.</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2>First-party customer acquisition cost</h2>
    <p class="note">Sales we can directly connect to Meta. ${tip(TIPS.confidence)} Confidence: <strong>${escapeHtml(cac.confidence || "—")}</strong>.</p>
    ${cac.first_party_observed_new_customer_cac == null ? `<p class="empty-state">Not enough post-tracking data yet. First-party attribution is still collecting data.</p>` : ""}
    <div class="grid">
      ${card("Meta spend", money(cac.meta_spend))}
      ${card("New customers linked to Meta", num(cac.post_capture_meta_new_customers ?? cac.meta_new_customers, 0))}
      ${card("First-party CAC", cac.first_party_observed_new_customer_cac == null ? "Collecting data" : money(cac.first_party_observed_new_customer_cac))}
      ${card("How much eligible sales we can attribute", cac.attribution_coverage_pct == null ? "Collecting data" : pct(cac.attribution_coverage_pct))}
    </div>
  </section>
  <section>
    <h2>Data Quality</h2>
    <ul class="warn-list">${warnList || `<li class="empty">No customer warnings.</li>`}</ul>
  </section>
</div>`;
}

function pricingRows(list, cols = 7) {
  if (!list?.length) {
    return `<tr><td colspan="${cols}" class="empty">None.</td></tr>`;
  }
  return list
    .map((r) => {
      const discount = r.recommended_discount_pct == null ? "—" : pct(r.recommended_discount_pct);
      const suggested = r.recommended_price == null ? "Hold current price" : money(r.recommended_price);
      const afterMargin = r.scenario?.accounting_gm_ex_tax_pct ?? r.accounting_gm_ex_tax_pct;
      const why = r.recommended_discount_pct != null
        ? `${num(r.recommended_discount_pct, 0)}% is the largest recommended step while preserving the configured accounting margin floor.`
        : r.note || "Current economics do not support a safer price change.";
      return `<tr>
      <td>${escapeHtml(r.product || "—")}<div class="muted">${escapeHtml(r.variant || r.sku || "")}</div></td>
      <td>${money(r.current_price)}</td>
      <td><strong>${suggested}</strong></td>
      <td>${discount}</td>
      <td>${pct(afterMargin)}</td>
      <td>${money(r.inventory_cost_capital_tied_up)}</td>
      <td>${escapeHtml(why)}</td>
    </tr>`;
    })
    .join("");
}

function renderPricing(ctx) {
  const pr = ctx.report?.pricing;
  if (!pr) {
    return `<div id="view-pricing" class="view">
  <section>
    <div class="divider-label">PRICING &amp; PROMOTION INTELLIGENCE</div>
    <h2>Pricing</h2>
    <p class="note">Not loaded. Run <code>npm run pricing:report</code> or regenerate the dashboard.</p>
    <p class="note">Advisory only — no Shopify price writes, no automatic discounts.</p>
  </section>
</div>`;
  }
  if (pr.error) {
    return `<div id="view-pricing" class="view">
  <section>
    <div class="divider-label">PRICING &amp; PROMOTION INTELLIGENCE</div>
    <h2>Pricing</h2>
    <p class="note tone-bad">${escapeHtml(pr.error)}</p>
  </section>
</div>`;
  }

  const s = pr.summary || {};
  const th = `<thead><tr>
  <th>Product</th><th>Current price</th><th>Suggested price</th><th>Discount</th><th>Accounting margin after discount</th><th>Inventory capital</th><th>Why</th>
</tr></thead>`;
  const warnList = (pr.data_quality?.warnings || [])
    .slice(0, 40)
    .map((w) => `<li>${escapeHtml(w)}</li>`)
    .join("");

  const simRows = (pr.clearance_candidates || [])
    .slice(0, 8)
    .map((r) => {
      const sc = r.scenario || {};
      return `<tr>
      <td>${escapeHtml(r.product || "")} / ${escapeHtml(r.variant || "")}</td>
      <td>${money(r.current_price)} → ${money(r.recommended_price)} (${num(r.recommended_discount_pct, 0)}%)</td>
      <td>${money(r.commercial_sticker_gp ?? r.unit_gp)} → ${money(sc.commercial_sticker_gp ?? sc.unit_gp)}</td>
      <td>${pct(r.commercial_sticker_gm_pct ?? r.unit_gm_pct)} → ${pct(sc.commercial_sticker_gm_pct ?? sc.unit_gm_pct)}</td>
      <td>${pct(r.accounting_gm_ex_tax_pct)} → ${pct(sc.accounting_gm_ex_tax_pct)}</td>
      <td>${pct(r.maximum_safe_discount_pct)}</td>
      <td>${num(r.required_unit_lift_to_preserve_gp, 2)}x</td>
      <td>${money(r.inventory_cost_capital_tied_up)}</td>
      <td>${escapeHtml(r.confidence || "—")}</td>
    </tr>`;
    })
    .join("");
  const mixedRows = (pr.mixed_variant_products || [])
    .slice(0, 15)
    .map(
      (m) => `<tr>
      <td>${escapeHtml(m.product || "")}</td>
      <td><strong>${escapeHtml(m.recommendation || "—")}</strong></td>
      <td>${num(m.clearance_variant_count, 0)}</td>
      <td>${num(m.promotion_variant_count, 0)}</td>
      <td>${num(m.protect_variant_count, 0)}</td>
      <td>${escapeHtml(m.explanation || "—")}</td>
    </tr>`
    )
    .join("");

  const incRows = (pr.price_increase_candidates || [])
    .slice(0, 10)
    .map((r) => {
      const t5 = (r.price_increase_test || []).find((x) => x.increase_pct === 5);
      return `<tr>
      <td>${escapeHtml(r.sku || "")}</td>
      <td>${escapeHtml(r.product || "")}</td>
      <td>${money(r.current_price)}</td>
      <td>${money(t5?.selling_price)}</td>
      <td>${money(t5?.gp_uplift_per_unit)}</td>
      <td>${escapeHtml(r.stock_class || "")}</td>
      <td>${escapeHtml(r.confidence || "")}</td>
    </tr>`;
    })
    .join("");

  return `<div id="view-pricing" class="view">
  <section class="hero-section">
    <div class="eyebrow">What you need to know</div>
    <h2>Pricing opportunities</h2>
    <p class="note">Safe discounts use Books ex-tax GM floors (splitInclusiveTax). Sticker GP remains visible. Clearance requires ≥90d sellable age. Advisory only — no price writes.</p>
    <div class="grid">
      ${card("Clearance capital", money(s.capital_tied_up_clearance), `${num(s.clearance_count, 0)} mature candidates`, "warn")}
      ${card("Promotion capital", money(s.capital_tied_up_promotion), `${num(s.promotion_count, 0)} candidates`)}
      ${card("Mature clearance SKUs", num(s.clearance_count, 0))}
      ${card("Blocked because too new", num(s.excluded_immature_clearance_count, 0))}
      ${card("Mixed variants needing review", num(s.mixed_variant_product_count, 0), "Avoid product-wide markdowns", "warn")}
    </div>
  </section>
  <section class="recommendation-group group-clearance">
    <div class="eyebrow">What needs action</div>
    <h2>Clearance</h2>
    <table>${th}<tbody>${pricingRows((pr.clearance_candidates || []).slice(0, 20))}</tbody></table>
  </section>
  <section class="recommendation-group group-promotion">
    <h2>Promotion</h2>
    <table>${th}<tbody>${pricingRows((pr.promotion_candidates || []).slice(0, 20))}</tbody></table>
  </section>
  <section class="recommendation-group group-protect">
    <h2>Protect Price</h2>
    <table>${th}<tbody>${pricingRows((pr.protect_price || []).slice(0, 15))}</tbody></table>
  </section>
  <section class="recommendation-group group-hold">
    <h2>Hold</h2>
    <p class="note">${num(s.hold_price_count, 0)} SKUs should keep their current price. Supporting rows are available in the embedded report data.</p>
  </section>
  <section>
    <h2>Mixed Variant Review</h2>
    <p class="note">Shared-price products with both stockout risk and clearance/promo variants — do not apply product-wide markdown.</p>
    <table>
      <thead><tr><th>Product</th><th>Rec</th><th>Clearance vars</th><th>Promo vars</th><th>Protect vars</th><th>Explanation</th></tr></thead>
      <tbody>${mixedRows || `<tr><td colspan="6" class="empty">None.</td></tr>`}</tbody>
    </table>
  </section>
  <section class="recommendation-group group-increase">
    <h2>Price Increase Test</h2>
    <p class="note">PRICE INCREASE TEST CANDIDATE — not a guaranteed revenue improvement. Demand may change.</p>
    <table>
      <thead><tr><th>SKU</th><th>Product</th><th>Price</th><th>+5%</th><th>GP uplift/unit</th><th>Stock class</th><th>Conf</th></tr></thead>
      <tbody>${incRows || `<tr><td colspan="7" class="empty">None.</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2>Discount Simulator (clearance explainability)</h2>
    <table>
      <thead><tr>
        <th>Product</th><th>Price path</th><th>Sticker GP</th><th>Sticker GM</th><th>Acct GM</th><th>Max safe disc</th><th>Lift to hold GP</th><th>Capital</th><th>Conf</th>
      </tr></thead>
      <tbody>${simRows || `<tr><td colspan="9" class="empty">None.</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2>Data Quality</h2>
    <ul class="warn-list">${warnList || `<li class="empty">No pricing warnings.</li>`}</ul>
  </section>
</div>`;
}

function renderMarketingDecisions(ctx) {
  const md = ctx.report?.marketing_decisions;
  if (!md) {
    return `<div id="view-marketing" class="view">
  <section>
    <div class="divider-label">MARKETING DECISION ENGINE</div>
    <h2>Marketing Decisions</h2>
    <p class="note">Not loaded. Run <code>npm run marketing:decisions</code> or regenerate the dashboard.</p>
    <p class="note">Advisory only — no Meta mutations, no budget automation.</p>
  </section>
</div>`;
  }
  if (md.error) {
    return `<div id="view-marketing" class="view">
  <section>
    <div class="divider-label">MARKETING DECISION ENGINE</div>
    <h2>Marketing Decisions</h2>
    <p class="note tone-bad">${escapeHtml(md.error)}</p>
  </section>
</div>`;
  }

  const s = md.summary || {};
  const acc = md.account_decision || {};
  const ev = md.evidence_quality || {};
  const [posture, postureExplanation] = accountPosture(acc.recommendation);

  const queueRows = (md.owner_action_queue || [])
    .slice(0, 12)
    .map(
      (a) => `<tr>
      <td><span class="priority priority-${escapeHtml(a.priority || "P4")}">${escapeHtml(a.priority || "P4")}</span></td>
      <td><span class="action action-${actionTone(a.secondary_action || a.primary_action)}">${escapeHtml(actionLabel(a.secondary_action || a.primary_action))}</span></td>
      <td>${escapeHtml(a.entity_name || a.entity_id || "—")}</td>
      <td>${escapeHtml(friendlyReason(a))}${reasonDetails(a)}</td>
      <td>${money(a.spend, ctx.cur)}</td>
      <td>${a.purchases == null ? "Not applicable" : num(a.purchases, 0)}</td>
      <td>${a.meta_cpa == null ? (a.purchases == null ? "Not applicable" : Number(a.purchases) === 0 ? "No purchases" : "Not available") : money(a.meta_cpa, ctx.cur)}</td>
      <td><span class="confidence">${escapeHtml(a.confidence || "Unknown")}</span></td>
    </tr>`
    )
    .join("");

  const actionTable = (list, emptyMessage, cols = 7) => {
    if (!list?.length) {
      return `<tr><td colspan="${cols}" class="empty-state">${escapeHtml(emptyMessage)}</td></tr>`;
    }
    return list
      .slice(0, 12)
      .map(
        (a) => `<tr>
      <td>${escapeHtml(a.entity_name || a.entity_id || "—")}</td>
      <td><span class="action action-${actionTone(a.primary_action)}">${escapeHtml(actionLabel(a.primary_action))}</span></td>
      <td>${escapeHtml(friendlyReason(a))}${reasonDetails(a)}</td>
      <td>${money(a.spend, ctx.cur)}</td>
      <td>${num(a.purchases, 0)}</td>
      <td>${a.meta_cpa == null ? (a.purchases == null ? "Not applicable" : Number(a.purchases) === 0 ? "No purchases" : "Not available") : money(a.meta_cpa, ctx.cur)}</td>
      <td><span class="confidence">${escapeHtml(a.confidence || "Unknown")}</span></td>
    </tr>`
      )
      .join("");
  };

  const blockers = (md.data_quality?.blockers || [])
    .slice(0, 20)
    .map((b) => `<li>${escapeHtml(b)}</li>`)
    .join("");

  return `<div id="view-marketing" class="view">
  <section class="posture-card posture-${actionTone(acc.recommendation === "REDUCE_SPEND" ? "REDUCE" : acc.recommendation === "DEFENSIVE_MODE" ? "PAUSE" : acc.recommendation === "SCALE_CAUTIOUSLY" ? "SCALE" : "HOLD")}">
    <div class="eyebrow">Account posture</div>
    <div class="posture-title">${escapeHtml(posture.toUpperCase())}</div>
    <p class="posture-explanation">${escapeHtml(postureExplanation)}</p>
    <p class="note">Confidence: <strong>${escapeHtml(acc.confidence || "Unknown")}</strong> ${tip(TIPS.confidence)} · Advisory only; no automatic budget changes.</p>
  </section>
  <section>
    <div class="eyebrow">What to do now</div>
    <h2>Ranked action queue</h2>
    <div class="table-wrap"><table class="action-table marketing-queue">
      <thead><tr><th>Priority</th><th>Action</th><th>Ad / entity</th><th>Why</th><th>Spend</th><th>Purchases</th><th>CPA</th><th>Confidence ${tip(TIPS.confidence)}</th></tr></thead>
      <tbody>${queueRows || `<tr><td colspan="8" class="empty-state">No marketing actions currently meet the evidence threshold.</td></tr>`}</tbody>
    </table></div>
  </section>
  <details class="secondary-section">
    <summary>Action groups and supporting detail</summary>
    <section><h2>Scale</h2><table><thead><tr><th>Entity</th><th>Action</th><th>Why</th><th>Spend</th><th>Purchases</th><th>CPA</th><th>Confidence</th></tr></thead><tbody>${actionTable(md.scale_candidates, "No scale candidates currently meet the evidence threshold.")}</tbody></table></section>
    <section><h2>Hold</h2><p class="empty-state">${num(s.hold_count, 0)} entities should remain unchanged while evidence develops.</p></section>
    <section><h2>Reduce</h2><table><thead><tr><th>Entity</th><th>Action</th><th>Why</th><th>Spend</th><th>Purchases</th><th>CPA</th><th>Confidence</th></tr></thead><tbody>${actionTable(md.reduce_candidates, "No ads currently need a spend reduction.")}</tbody></table></section>
    <section><h2>Pause</h2><table><thead><tr><th>Entity</th><th>Action</th><th>Why</th><th>Spend</th><th>Purchases</th><th>CPA</th><th>Confidence</th></tr></thead><tbody>${actionTable(md.pause_candidates, "No ads currently meet the pause threshold.")}</tbody></table></section>
    <section><h2>Creative test</h2><table><thead><tr><th>Entity</th><th>Action</th><th>Why</th><th>Spend</th><th>Purchases</th><th>CPA</th><th>Confidence</th></tr></thead><tbody>${actionTable(md.creative_tests, "No creative tests are currently recommended.")}</tbody></table></section>
    <section><h2>Promotion test</h2><p class="note">A secondary recommendation only; this never creates discounts automatically.</p><table><thead><tr><th>Entity</th><th>Action</th><th>Why</th><th>Spend</th><th>Purchases</th><th>CPA</th><th>Confidence</th></tr></thead><tbody>${actionTable(md.promotion_tests, "No promotion tests are currently recommended.")}</tbody></table></section>
    <section><h2>Inventory constraints</h2><p class="note">Product mapping is required before stock constraints can be applied to a Meta ad.</p><table><thead><tr><th>Entity</th><th>Action</th><th>Why</th><th>Spend</th><th>Purchases</th><th>CPA</th><th>Confidence</th></tr></thead><tbody>${actionTable(md.inventory_constraints, "No product mapping exists yet, so inventory constraints cannot be applied to Meta ads.")}</tbody></table></section>
  </details>
  <section class="quality-section">
    <div class="eyebrow">Data quality and caveats</div>
    ${dataQualityLine(md.data_quality)}
    <p class="note">${ev.fp_evidence?.attributed_coverage_pct == null ? "First-party attribution is still collecting data." : `We can currently attribute ${pct(ev.fp_evidence.attributed_coverage_pct)} of eligible sales.`}</p>
    <details><summary>Detailed diagnostics</summary><ul class="warn-list">${blockers || `<li class="empty">No critical blockers.</li>`}</ul></details>
  </section>
</div>`;
}

function renderForecast(ctx) {
  const { cur } = ctx;
  const fc = ctx.report.forecast || {};
  const invf = ctx.report.inventory_forecast || {};
  if (!fc.scenarios && !fc.month_to_date) {
    return `<div id="view-forecast" class="view">
  <section class="hero-section">
    <div class="eyebrow">Planning</div>
    <h2>Forecast</h2>
    <p class="empty-state">No forecast attached. Run <code>npm run reports:owner</code>.</p>
  </section>
</div>`;
  }
  const mtd = fc.month_to_date || {};
  const base = fc.scenarios?.BASE || {};
  const scenRows = ["CONSERVATIVE", "BASE", "UPSIDE"]
    .map((k) => {
      const s = fc.scenarios?.[k];
      if (!s) return "";
      return `<tr>
        <td>${escapeHtml(k)}</td>
        <td>${escapeHtml(s.assumption || "")}</td>
        <td>${money(s.projected_revenue, cur)}</td>
        <td>${num(s.projected_orders, 0)}</td>
        <td>${money(s.projected_gross_profit, cur)}</td>
        <td>${money(s.projected_profit_before_ads, cur)}</td>
        <td>${money(s.projected_meta_spend, cur)}</td>
        <td>${money(s.projected_profit_after_meta, cur)}</td>
      </tr>`;
    })
    .join("");
  const spendRows = (fc.spend_scenarios || [])
    .map(
      (s) => `<tr>
      <td>${escapeHtml(s.label)}</td>
      <td>${money(s.projected_meta_spend, cur)}</td>
      <td>${money(s.projected_profit_before_ads, cur)}</td>
      <td>${money(s.projected_profit_after_meta, cur)}</td>
      <td>${escapeHtml(s.known)}</td>
      <td class="tone-warn">${escapeHtml(s.unknown)}</td>
    </tr>`
    )
    .join("");
  const coverRows = (invf.cover_where_evidence || [])
    .slice(0, 15)
    .map(
      (s) => `<tr>
      <td>${escapeHtml(s.product || "")}</td>
      <td>${escapeHtml(s.sku || "")}</td>
      <td>${escapeHtml(String(s.stock_class || ""))}</td>
      <td>${num(s.days_of_cover, 0)}</td>
      <td>${num(s.current_stock, 0)}</td>
    </tr>`
    )
    .join("");
  const stockoutRows = (invf.stockout_risks || [])
    .slice(0, 12)
    .map(
      (s) => `<tr>
      <td>${escapeHtml(s.product || "")}</td>
      <td>${escapeHtml(s.sku || "")}</td>
      <td>${escapeHtml(String(s.stock_class || ""))}</td>
      <td>${num(s.days_of_cover, 0)}</td>
      <td>${num(s.units_sold_30d, 0)}</td>
      <td>${escapeHtml(s.note || "")}</td>
    </tr>`
    )
    .join("");

  const planningCards = [];
  if (fc.planning?.target_gross_profit != null) {
    planningCards.push(
      card(
        "Target gross profit",
        money(fc.planning.target_gross_profit, cur),
        "Gross profit only — not net after ads",
        "neutral",
        null,
        "CALCULATED"
      )
    );
    planningCards.push(
      card(
        "Revenue required for target gross profit",
        money(fc.planning.revenue_required_for_target_gross_profit, cur),
        "Uses observed gross margin only",
        "neutral",
        null,
        "FORECAST"
      )
    );
  }
  if (fc.planning?.target_profit_after_meta != null) {
    planningCards.push(
      card(
        "Target profit after Meta (requested)",
        money(fc.planning.target_profit_after_meta, cur),
        fc.planning.target_profit_revenue_suppressed
          ? "Revenue path suppressed — insufficient defensible inputs"
          : "",
        "warn",
        null,
        "CALCULATED"
      )
    );
  }
  if (fc.planning?.orders_required_at_current_aov != null) {
    planningCards.push(
      card(
        "Orders at current AOV (gross-profit target)",
        num(fc.planning.orders_required_at_current_aov, 0),
        "",
        "neutral",
        TIPS.aov
      )
    );
  }
  if (fc.planning?.max_affordable_meta_spend_mtd_buffer != null) {
    planningCards.push(
      card(
        "Max affordable Meta (MTD pre-ad buffer)",
        money(fc.planning.max_affordable_meta_spend_mtd_buffer, cur)
      )
    );
  }

  return `<div id="view-forecast" class="view">
  <section class="hero-section">
    <div class="eyebrow">Planning · scenarios</div>
    <h2>Forecast ${sourceBadgeHtml("FORECAST")}</h2>
    <p class="callout warning"><strong>FORECAST — NOT ACTUAL.</strong> Deterministic pace projections only. Never written into Books, Ledger, Shopify, or Meta.</p>
    <p class="confidence-banner">Confidence: <strong>${escapeHtml(String(fc.confidence || "—"))}</strong> — ${escapeHtml(fc.confidence_note || "")}</p>
    <p class="note">${escapeHtml(fc.mtd_source_note || "")}</p>
    <h3>ACTUAL MTD</h3>
    <div class="grid key-grid">
      ${card("ACTUAL MTD revenue", money(mtd.revenue, cur), mtd.label || "ACTUAL", "neutral", tipText("net_revenue"), "BOOKS")}
      ${card("ACTUAL MTD orders", num(mtd.orders, 0), "", "neutral", TIPS.recognized_order, "BOOKS")}
      ${card("ACTUAL MTD gross profit", money(mtd.gross_profit, cur), "", "neutral", tipText("gross_profit"), "BOOKS")}
      ${card("ACTUAL MTD pre-ad profit", money(mtd.profit_before_ads, cur), "", "neutral", null, "CALCULATED")}
      ${card("ACTUAL MTD Meta spend", money(mtd.meta_spend, cur), "", "neutral", tipText("meta_spend"), "META")}
      ${card("ACTUAL MTD profit after Meta", money(mtd.profit_after_meta, cur), "", "neutral", TIPS.meta_adjusted_profit, "CALCULATED")}
    </div>
    <h3>BASE month-end forecast ${sourceBadgeHtml("FORECAST")}</h3>
    <div class="grid key-grid">
      ${card("FORECAST revenue", money(base.projected_revenue, cur), "Base scenario", "neutral", TIPS.forecast, "FORECAST")}
      ${card("FORECAST pre-ad profit", money(base.projected_profit_before_ads, cur), "Sales-pace estimate — not causal", "neutral", TIPS.forecast, "FORECAST")}
      ${card("FORECAST Meta spend", money(base.projected_meta_spend, cur), "Spend-pace estimate", "neutral", TIPS.forecast, "FORECAST")}
      ${card("FORECAST profit after Meta", money(base.projected_profit_after_meta, cur), "Pre-ad profit − Meta spend", "neutral", TIPS.forecast, "FORECAST")}
      ${card("Days left in month", num(fc.calendar_month?.days_remaining, 0), `${escapeHtml(fc.calendar_month?.since || "")} → ${escapeHtml(fc.calendar_month?.until || "")}`)}
    </div>
  </section>
  <section>
    <h2>Month-end scenarios</h2>
    <p class="note">Profit after Meta = projected pre-ad profit − projected Meta spend. Pre-ad profit follows the <strong>sales</strong> factor; Meta spend follows the <strong>spend</strong> factor. No causal revenue from higher spend.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Scenario</th><th>Assumption</th><th>FORECAST revenue</th><th>Orders</th><th>Gross profit</th><th>FORECAST pre-ad profit</th><th>FORECAST Meta spend</th><th>FORECAST profit after Meta</th></tr></thead>
      <tbody>${scenRows || `<tr><td colspan="8" class="empty-state">No scenarios.</td></tr>`}</tbody>
    </table></div>
  </section>
  <section>
    <h2>Meta spend what-ifs</h2>
    <p class="note">Changing spend is <strong>known</strong>. Incremental revenue is <strong>unknown</strong> — pre-ad profit is held at base pace (no causal ROAS).</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Scenario</th><th>FORECAST Meta spend</th><th>FORECAST pre-ad profit (held)</th><th>FORECAST profit after Meta</th><th>Known</th><th>Unknown</th></tr></thead>
      <tbody>${spendRows || `<tr><td colspan="6" class="empty-state">No spend scenarios.</td></tr>`}</tbody>
    </table></div>
  </section>
  ${
    fc.planning
      ? `<section>
    <h2>Target planning</h2>
    <div class="grid">${planningCards.join("") || `<p class="empty-state">No planning targets set.</p>`}</div>
    ${
      fc.planning.target_profit_revenue_suppressed
        ? `<p class="callout warning"><strong>Net target revenue suppressed.</strong> ${escapeHtml(fc.planning.target_profit_suppression_reason || "")}</p>`
        : ""
    }
    <p class="note">${escapeHtml(fc.planning.note || "")}</p>
  </section>`
      : ""
  }
  <section>
    <h2>Inventory outlook</h2>
    <p class="note">${escapeHtml(invf.note || "Stock depletion is not forecast from zero demand evidence.")}</p>
    <div class="grid">
      ${card("Capital likely tied up (observed)", money(invf.capital_at_risk, cur), invf.capital_at_risk_pct == null ? "" : pct(invf.capital_at_risk_pct), "warn", TIPS.inventory_capital_at_risk, "CALCULATED")}
    </div>
    <h3>Stock cover (where demand evidence exists)</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Product</th><th>SKU</th><th>Class</th><th>Days of cover</th><th>Stock</th></tr></thead>
      <tbody>${coverRows || `<tr><td colspan="5" class="empty-state">Insufficient demand evidence for cover samples.</td></tr>`}</tbody>
    </table></div>
    <h3>Stockout / low cover risks</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Product</th><th>SKU</th><th>Class</th><th>Cover</th><th>30d units</th><th>Note</th></tr></thead>
      <tbody>${stockoutRows || `<tr><td colspan="6" class="empty-state">No evidenced stockout risks.</td></tr>`}</tbody>
    </table></div>
  </section>
</div>`;
}

const STYLES = `
:root {
  --bg: #f5f4f0;
  --surface: #fffefa;
  --surface-raised: #ffffff;
  --ink: #17211f;
  --muted: #66736f;
  --faint: #8a9591;
  --line: #dfe4e1;
  --line-strong: #ccd5d1;
  --ok: #166534;
  --ok-bg: #eaf7ee;
  --warn: #8a520e;
  --warn-bg: #fff5dc;
  --bad: #a12a2a;
  --bad-bg: #fcebea;
  --neutral: #46514e;
  --accent: #0f766e;
  --accent-dark: #0b5f59;
  --accent-soft: #e9f6f3;
  --shadow: 0 12px 34px rgba(23,33,31,.055);
  --radius: 18px;
  --font: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: var(--font);
  color: var(--ink);
  background: var(--bg);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.layout { display: flex; min-height: 100vh; }
.sidebar {
  width: 238px;
  flex-shrink: 0;
  background: #fdfdfb;
  border-right: 1px solid var(--line);
  padding: 28px 16px;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}
.sidebar .brand {
  font-size: 12px;
  letter-spacing: .18em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 800;
  padding: 0 12px 22px;
}
.nav-btn {
  display: flex;
  align-items: center;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  padding: 11px 12px;
  border-radius: 11px;
  font-size: 13px;
  font-weight: 550;
  color: var(--muted);
  cursor: pointer;
  margin-bottom: 3px;
  transition: background .16s ease, color .16s ease, border-color .16s ease;
}
.nav-btn::before {
  content: "";
  width: 4px;
  height: 4px;
  margin-right: 10px;
  border-radius: 50%;
  background: var(--line-strong);
}
.nav-btn:hover { background: #f3f5f3; color: var(--ink); }
.nav-btn.active {
  background: var(--accent-soft);
  border-color: #cbe7e1;
  color: var(--accent-dark);
  font-weight: 700;
}
.nav-btn.active::before { width: 6px; height: 6px; margin-right: 8px; background: var(--accent); }
.main { flex: 1; min-width: 0; width: calc(100% - 238px); max-width: 1380px; padding: 34px 42px 72px; }
header.hero {
  position: relative;
  padding: 6px 0 26px;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--line-strong);
}
header.hero::after {
  content: "";
  position: absolute;
  left: 0;
  bottom: -1px;
  width: 72px;
  height: 2px;
  background: var(--accent);
}
header.hero > .brand {
  color: var(--accent);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .2em;
}
header.hero h1 {
  max-width: 760px;
  margin: 7px 0 2px;
  font-size: clamp(27px, 3vw, 40px);
  line-height: 1.12;
  letter-spacing: -.035em;
}
.subtitle { color: var(--muted); font-size: 15px; }
.period {
  color: var(--ink);
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -.01em;
  margin-top: 9px;
  font-variant-numeric: tabular-nums;
}
.badge-row { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; align-items: center; }
.badge {
  display: inline-flex;
  align-items: center;
  min-height: 27px;
  padding: 4px 9px;
  border-radius: 7px;
  background: rgba(255,255,255,.66);
  border: 1px solid var(--line);
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
}
.src-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .04em;
  vertical-align: middle;
  border: 1px solid var(--line);
  color: var(--muted);
  background: #f3f5f3;
}
.src-meta { background: #eef2ff; color: #3730a3; border-color: #c7d2fe; }
.src-shopify { background: #ecfdf5; color: #065f46; border-color: #a7f3d0; }
.src-books { background: #fff7ed; color: #9a3412; border-color: #fed7aa; }
.src-first-party { background: #f5f3ff; color: #5b21b6; border-color: #ddd6fe; }
.src-calculated { background: #f0fdfa; color: #0f766e; border-color: #99f6e4; }
.src-forecast { background: #fefce8; color: #854d0e; border-color: #fde68a; }
.owner-status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
  margin-top: 18px;
}
.owner-status {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 14px;
  background: var(--surface-raised);
}
.owner-status-area {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .12em;
  color: var(--faint);
}
.owner-status-val {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 750;
  letter-spacing: -.01em;
}
.owner-status-why {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.35;
}
.owner-status.tone-ok { border-color: #bbf7d0; background: var(--ok-bg); }
.owner-status.tone-warn { border-color: #fde68a; background: var(--warn-bg); }
.owner-status.tone-bad { border-color: #fecaca; background: var(--bad-bg); }
.watch-list { margin: 0; padding-left: 18px; }
.watch-list li { margin-bottom: 8px; color: var(--ink); }
.why-expand { margin-top: 6px; font-size: 12px; color: var(--muted); }
.why-expand summary { cursor: pointer; color: var(--accent-dark); font-weight: 600; }
.freshness-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.period-line { color: var(--muted); font-size: 14px; margin: 6px 0 0; }
.confidence-banner {
  margin: 10px 0 0;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--warn-bg);
  border: 1px solid #fde68a;
  font-size: 14px;
  color: var(--ink);
}
.btn-print {
  margin-left: auto;
  min-height: 36px;
  padding: 8px 15px;
  border-radius: 9px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  font-weight: 700;
  box-shadow: 0 4px 12px rgba(15,118,110,.13);
}
.btn-print:hover { background: var(--accent-dark); }
.view { display: none; }
.view.active { display: block; }
.eyebrow { margin-bottom: 8px; color: var(--accent); font-size: 10px; font-weight: 850; letter-spacing: .16em; text-transform: uppercase; }
.hero-section { border-color: #c8ddd8; background: linear-gradient(145deg, #f4fbf9 0, #fff 62%); }
.executive-verdict { max-width: 980px; margin: 0 0 20px; font-size: clamp(18px, 2vw, 25px); line-height: 1.4; letter-spacing: -.02em; font-weight: 650; }
.key-grid .card:first-child { grid-column: span 2; }
section {
  background: var(--surface-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 24px 26px;
  margin-bottom: 20px;
}
section h2 {
  margin: 0 0 15px;
  font-size: 18px;
  line-height: 1.25;
  letter-spacing: -.018em;
  color: var(--ink);
}
section h2::before {
  content: "";
  display: inline-block;
  width: 18px;
  height: 2px;
  margin: 0 9px 5px 0;
  background: var(--accent);
  border-radius: 2px;
}
section h3 { margin: 0 0 9px; font-size: 15px; letter-spacing: -.01em; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(175px, 1fr)); }
.grid-2 { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.grid-3 { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.card {
  border: 1px solid var(--line);
  border-radius: 13px;
  min-height: 112px;
  padding: 15px 16px;
  background: var(--surface);
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
}
.card-label {
  min-height: 18px;
  margin-bottom: 10px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: .055em;
  text-transform: uppercase;
}
.card-value {
  margin-top: auto;
  font-size: clamp(19px, 1.8vw, 24px);
  font-weight: 740;
  line-height: 1.18;
  letter-spacing: -.025em;
  font-variant-numeric: tabular-nums;
}
.card-sub { margin-top: 7px; color: var(--muted); font-size: 12px; line-height: 1.4; }
.tone-ok .card-value, .pill.tone-ok, .tone-ok { color: var(--ok); }
.tone-warn .card-value, .pill.tone-warn, .tone-warn { color: var(--warn); }
.tone-bad .card-value, .pill.tone-bad, .tone-bad { color: var(--bad); }
.tone-info, .action-info { color: #1d4ed8; }
.tone-accent, .action-accent { color: #7c3aed; }
.tone-muted, .action-muted { color: var(--faint); }
.pill {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #f3f5f3;
  font-size: 10px;
  font-weight: 800;
  line-height: 1.3;
  letter-spacing: .035em;
}
.tone-ok.pill, .product-card.tone-ok { border-color: #cce8d4; background: var(--ok-bg); }
.tone-warn.pill, .product-card.tone-warn { border-color: #efdcae; background: var(--warn-bg); }
.tone-bad.pill, .product-card.tone-bad { border-color: #efcecb; background: var(--bad-bg); }
table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
th, td {
  padding: 11px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: middle;
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #f5f7f5;
  color: var(--muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .055em;
  text-transform: uppercase;
}
thead th:first-child { border-radius: 9px 0 0 0; }
thead th:last-child { border-radius: 0 9px 0 0; }
tbody tr:nth-child(even):not(.total-row) { background: #fafbf9; }
tbody tr:hover:not(.total-row) { background: #f3f8f6; }
table th:not(:first-child), table td:not(:first-child) { text-align: right; }
.action-table th, .action-table td { text-align: left !important; }
.action-table td:nth-last-child(-n+3) { white-space: nowrap; }
.ad-table th:nth-child(2), .ad-table td:nth-child(2),
.ad-table th:last-child, .ad-table td:last-child { text-align: left; }
.pl-table td:last-child { width: 36%; text-align: right; }
.pl-table tr:nth-child(3) td,
.pl-table tr:nth-child(5) td,
.pl-table tr:nth-child(7) td,
.pl-table tr:nth-child(12) td { border-top: 1px solid var(--line-strong); }
.pl-table tr:nth-last-child(-n+2) td { background: #f0f7f5; font-size: 14px; }
.total-row { background: #eef5f2; }
.total-row td { border-top: 1px solid #c9ded8; border-bottom-color: #c9ded8; }
.muted { color: var(--muted); font-size: 13px; }
.note { max-width: 880px; margin: 9px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
section > h2 + .note, section > h2 + p.note { margin: -7px 0 17px; }
.empty { color: var(--muted); font-style: italic; }
.empty-state { padding: 20px !important; color: var(--muted); text-align: center !important; background: #fafbf9; font-style: normal; }
.tip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 4px;
  border: 1px solid #a8d5ce;
  border-radius: 50%;
  color: var(--accent);
  cursor: help;
  font-size: 10px;
  font-style: normal;
  vertical-align: 1px;
}
.waterfall {
  margin: 2px 0 14px;
  padding: 16px 18px;
  border-left: 3px solid var(--accent);
  border-radius: 0 12px 12px 0;
  background: #f5faf8;
  font-size: 14px;
  line-height: 2;
  font-variant-numeric: tabular-nums;
}
.waterfall strong { display: inline-block; color: var(--accent-dark); }
.summary-line {
  margin: 16px 0 0;
  padding: 13px 15px;
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
  font-size: 15px;
}
.callout { margin: 16px 0 0; padding: 12px 15px; border-left: 3px solid var(--line-strong); border-radius: 0 9px 9px 0; background: #f7f8f6; font-size: 13px; }
.callout.warning { border-color: var(--warn); background: var(--warn-bg); color: #68400d; }
.quality-line { margin: 0; font-size: 14px; }
.quality-section { box-shadow: none; background: #fafbf9; }
.secondary-section { margin-bottom: 20px; border: 1px solid var(--line); border-radius: var(--radius); background: #fff; }
.secondary-section > summary { margin: 0; padding: 17px 20px; color: var(--ink); font-weight: 700; }
.secondary-section > section { margin: 0 14px 14px; box-shadow: none; }
.priority { display: inline-grid; place-items: center; width: 36px; height: 30px; border-radius: 8px; background: #edf0ee; font-weight: 850; }
.priority-P1 { color: var(--bad); background: var(--bad-bg); border: 1px solid #efcecb; }
.priority-P2 { color: var(--warn); background: var(--warn-bg); border: 1px solid #efdcae; }
.priority-P3 { color: var(--accent-dark); background: var(--accent-soft); }
.action { display: inline-flex; padding: 5px 9px; border-radius: 7px; background: #f0f2f1; font-size: 11px; font-weight: 800; white-space: nowrap; }
.action-bad { color: var(--bad); background: var(--bad-bg); }
.action-warn { color: var(--warn); background: var(--warn-bg); }
.action-ok { color: var(--ok); background: var(--ok-bg); }
.action-info { background: #edf4ff; }
.action-accent { background: #f4efff; }
.confidence { color: var(--muted); font-size: 12px; text-transform: capitalize; }
.reason-details summary { margin-top: 5px; color: var(--muted); font-size: 11px; }
.reason-details code { display: block; margin-top: 5px; color: var(--faint); font-size: 10px; white-space: normal; }
.posture-card { padding: 30px; border-width: 1px 1px 1px 5px; }
.posture-title { font-size: clamp(29px, 4vw, 48px); line-height: 1; letter-spacing: -.04em; font-weight: 850; text-transform: uppercase; }
.posture-explanation { max-width: 800px; margin: 15px 0 4px; font-size: 17px; line-height: 1.55; }
.posture-bad { border-left-color: var(--bad); }
.posture-warn { border-left-color: var(--warn); }
.posture-ok { border-left-color: var(--ok); }
.posture-neutral { border-left-color: var(--accent); }
.recommendation-group { border-left-width: 4px; }
.group-clearance { border-left-color: var(--bad); }
.group-promotion { border-left-color: var(--accent); }
.group-hold { border-left-color: var(--line-strong); }
.group-protect { border-left-color: var(--ok); }
.group-increase { border-left-color: #7c3aed; }
.table-wrap { width: 100%; overflow-x: auto; }
.rec-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.rec-list li { border: 1px solid var(--line); border-radius: 11px; padding: 12px; background: #fbfcfa; }
.alert-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.alert-list li { border: 1px solid var(--line); border-radius: 11px; padding: 10px 12px; background: #fbfcfa; font-size: 13px; line-height: 1.4; }
.trend-table th, .trend-table td { padding: 8px 10px; }
.muted { color: var(--muted); }
.rec-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
.product-card { border-radius: 13px; padding: 16px; margin-bottom: 11px; border: 1px solid var(--line); background: var(--surface); }
.product-card.data-issue-card { border-color: #e6c36b; box-shadow: none; }
.data-issue-line { color: var(--warn); font-weight: 600; }
.product-head { display: flex; justify-content: space-between; gap: 10px; align-items: start; }
.product-card h3 { margin: 0 0 4px; font-size: 15px; }
.sku-list { margin: 8px 0 0; padding-left: 18px; font-size: 12px; }
details summary { cursor: pointer; font-size: 13px; color: var(--accent); margin-top: 8px; }
.scale-card { border: 1px solid #b9ddd6; border-radius: 14px; padding: 17px; background: #f0f9f7; margin-bottom: 12px; }
.scale-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); font-weight: 700; }
.scale-card .grid-3 > div { display: flex; flex-direction: column; gap: 4px; padding-top: 10px; border-top: 1px solid #d4e9e4; }
.scale-card .grid-3 strong { font-variant-numeric: tabular-nums; }
.conf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
.conf-item { border: 1px solid var(--line); border-radius: 11px; padding: 13px; background: var(--surface); }
.section-shopify {
  position: relative;
  overflow: hidden;
  border-color: #b6dcd5;
  background: linear-gradient(135deg, #eff9f6 0, #fff 54%);
}
.section-shopify::after {
  content: "SHOPIFY CONTEXT";
  position: absolute;
  top: 18px;
  right: 22px;
  color: rgba(15,118,110,.09);
  font-size: 20px;
  font-weight: 850;
  letter-spacing: .08em;
  pointer-events: none;
}
.section-context {
  border-color: #e7cf96;
  background: #fffbef;
  box-shadow: 0 10px 26px rgba(138,82,14,.045);
}
.divider-label {
  margin: 0 0 9px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .16em;
  text-transform: uppercase;
}
.filter-bar {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 3px;
  max-width: 100%;
  margin-bottom: 17px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: #f1f3f1;
}
.filter-btn {
  padding: 7px 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.filter-btn:hover { color: var(--ink); }
.filter-btn.active {
  border-color: #cbd3d0;
  background: #fff;
  color: var(--accent-dark);
  box-shadow: 0 1px 3px rgba(23,33,31,.07);
}
.funnel {
  display: grid;
  grid-template-columns: repeat(6, minmax(110px, 1fr));
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 3px;
}
.funnel-step {
  position: relative;
  display: flex;
  gap: 10px;
  align-items: center;
  min-height: 74px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
}
.funnel-step:not(:last-child)::after {
  content: "›";
  position: absolute;
  z-index: 2;
  right: -8px;
  color: var(--accent);
  font-size: 18px;
  font-weight: 800;
}
.funnel-num {
  width: 25px; height: 25px; border-radius: 7px; background: var(--accent-soft);
  color: var(--accent); font-weight: 800; font-size: 11px;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.funnel-step strong { font-size: 17px; font-variant-numeric: tabular-nums; }
.warn-list { padding-left: 18px; }
footer { margin-top: 20px; color: var(--muted); font-size: 12px; text-align: center; }
@media (max-width: 1080px) {
  .main { padding: 28px 26px 64px; }
  .grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  section { padding: 21px 22px; }
}
@media (max-width: 768px) {
  .layout { flex-direction: column; }
  .sidebar {
    z-index: 10;
    width: 100%;
    height: auto;
    position: sticky;
    display: flex;
    flex-wrap: nowrap;
    gap: 5px;
    padding: 10px 12px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .sidebar .brand { display: none; }
  .nav-btn { width: auto; flex: 0 0 auto; min-width: auto; text-align: center; font-size: 12px; padding: 8px 11px; margin: 0; }
  .nav-btn::before { display: none; }
  .main { padding: 16px 14px 48px; }
  header.hero { padding-top: 10px; }
  .btn-print { margin-left: 0; }
  section { padding: 18px 16px; border-radius: 14px; }
  section h2 { font-size: 17px; }
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .key-grid .card:first-child { grid-column: auto; }
  .card { min-height: 106px; padding: 13px; }
  .card-value { font-size: 19px; overflow-wrap: anywhere; }
  .section-shopify::after { display: none; }
  table { display: block; overflow-x: auto; white-space: nowrap; }
  .ad-table th:nth-child(n+4), .ad-table td:nth-child(n+4) { display: none; }
}
@media (max-width: 460px) {
  .grid { grid-template-columns: 1fr; }
  .card { min-height: 96px; }
}
@media print {
  .sidebar, .filter-bar, .btn-print, .nav-btn { display: none !important; }
  .layout { display: block; }
  .main { max-width: none; padding: 0; }
  .view { display: block !important; page-break-inside: avoid; }
  header.hero { margin-bottom: 14px; }
  section { padding: 14px; box-shadow: none; break-inside: avoid; }
  .card { min-height: 0; }
  th { position: static; }
  body { background: #fff; }
  details.secondary-section > * { display: block !important; }
  .table-wrap { overflow: visible; }
}
`;

const SCRIPTS = `
function showView(id) {
  document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
  document.querySelectorAll('.nav-btn').forEach(function(b) { b.classList.remove('active'); });
  var el = document.getElementById('view-' + id);
  if (el) el.classList.add('active');
  var btn = document.querySelector('.nav-btn[data-view="' + id + '"]');
  if (btn) btn.classList.add('active');
}
document.querySelectorAll('.nav-btn').forEach(function(btn) {
  btn.addEventListener('click', function() { showView(btn.getAttribute('data-view')); });
});
var printBtn = document.getElementById('print-btn');
if (printBtn) printBtn.addEventListener('click', function() { window.print(); });
var printDetails = [];
window.addEventListener('beforeprint', function() {
  printDetails = Array.prototype.map.call(document.querySelectorAll('details'), function(d) { return d.open; });
  document.querySelectorAll('details').forEach(function(d) { d.open = true; });
});
window.addEventListener('afterprint', function() {
  document.querySelectorAll('details').forEach(function(d, i) { d.open = !!printDetails[i]; });
});
document.querySelectorAll('#product-filters .filter-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('#product-filters .filter-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    var f = btn.getAttribute('data-pf');
    document.querySelectorAll('.product-card[data-product-filter]').forEach(function(card) {
      var tags = card.getAttribute('data-product-filter');
      card.style.display = (f === 'all' || tags === f) ? '' : 'none';
    });
  });
});
document.querySelectorAll('#ad-filters .filter-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('#ad-filters .filter-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    var f = btn.getAttribute('data-af');
    document.querySelectorAll('tr[data-ad-filter]').forEach(function(row) {
      var tags = (row.getAttribute('data-ad-filter') || '').split(' ');
      row.style.display = (f === 'all' || tags.indexOf(f) >= 0) ? '' : 'none';
    });
  });
});
`;

function renderUnifiedDashboard(report) {
  const ctx = buildCtx(report);
  const jsonBlob = escapeHtml(JSON.stringify(report));
  const dr = report.date_range || {};
  const isFull = dr.is_full_calendar_month;

  const navItems = [
    ["overview", "Overview"],
    ["marketing", "Marketing"],
    ["profitability", "Profitability"],
    ["sales", "Sales"],
    ["inventory", "Inventory"],
    ["pricing", "Pricing"],
    ["customers", "Customers"],
    ["attribution", "Attribution"],
    ["attr-economics", "Attr. Economics"],
    ["advertising", "Advertising"],
    ["forecast", "Forecast"],
    ["products", "Products"],
    ["decisions", "Decisions"],
    ["data-quality", "Data Quality"],
  ];

  const navHtml = navItems
    .map(
      ([id, label]) =>
        `<button type="button" class="nav-btn${id === "overview" ? " active" : ""}" data-view="${id}">${escapeHtml(label)}</button>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Wear Active — Reporting &amp; Decision Intelligence</title>
<style>${STYLES}</style>
</head>
<body>
<div class="layout">
  <nav class="sidebar" aria-label="Dashboard views">
    <div class="brand">Wear Active</div>
    ${navHtml}
  </nav>
  <main class="main">
    <header class="hero">
      <div class="brand">WEAR ACTIVE</div>
      <h1>Owner Operating Dashboard</h1>
      <div class="period">${escapeHtml(dr.since)} → ${escapeHtml(dr.until)}</div>
      <div class="badge-row">
        <span class="badge">${escapeHtml(dr.timezone || "Asia/Karachi")}</span>
        <span class="badge">Generated ${escapeHtml(report.generated_at || "")}</span>
        <span class="badge">${isFull ? "Full calendar month" : "Partial period"}</span>
        <span class="badge">READ ONLY</span>
        <span class="badge">FORECAST ≠ ACTUAL</span>
        <button type="button" class="btn-print" id="print-btn">Print / Save PDF</button>
      </div>
    </header>

    ${renderOverview(ctx)}
    ${renderMarketingDecisions(ctx)}
    ${renderProfitability(ctx)}
    ${renderSales(ctx)}
    ${renderInventory(ctx)}
    ${renderPricing(ctx)}
    ${renderCustomers(ctx)}
    ${renderAttribution(ctx)}
    ${renderAttributionEconomics(ctx)}
    ${renderAdvertising(ctx)}
    ${renderForecast(ctx)}
    ${renderProducts(ctx)}
    ${renderDecisions(ctx)}
    ${renderDataQuality(ctx)}

    <footer>
      Wear Active Owner Operating Dashboard · Advisory only · Forecasts are not Books facts · No Meta mutations · No Sheet writes
    </footer>
  </main>
</div>
<script type="application/json" id="report-data">${jsonBlob}</script>
<script>${SCRIPTS}</script>
</body>
</html>`;
}

function renderDecisionDashboard(report) {
  return renderUnifiedDashboard(report);
}

module.exports = {
  renderUnifiedDashboard,
  renderDecisionDashboard,
};
