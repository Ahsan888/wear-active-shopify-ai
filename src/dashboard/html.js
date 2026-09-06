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
} = require("./format");
const { groupRecommendationsByPriority } = require("./groups");
const { enrichProductGroups } = require("./bundle");

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

function card(label, value, sub = "", tone = "neutral", tipText = null) {
  const tipHtml = tipText ? ` ${tip(tipText)}` : "";
  return `<div class="card tone-${tone}">
    <div class="card-label">${escapeHtml(label)}${tipHtml}</div>
    <div class="card-value">${value}</div>
    ${sub ? `<div class="card-sub">${sub}</div>` : ""}
  </div>`;
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
  const { cur, bh, bas, me, books, p, sc, mix, fb, totals, conc, recBuckets, contribTone } =
    ctx;

  const salesRows = mix
    .map(
      (c) => `<tr>
      <td>${escapeHtml(c.channel)}</td>
      <td>${num(c.orders, 0)}</td>
      <td>${pct(c.order_share_pct)}</td>
      <td title="${escapeHtml(`Gross ${money(c.revenue_ex_tax, cur)} − refunds ${money(c.refunds || 0, cur)}`)}">${money(c.net_revenue_ex_tax != null ? c.net_revenue_ex_tax : c.revenue_ex_tax, cur)}</td>
      <td>${pct(c.net_revenue_share_pct != null ? c.net_revenue_share_pct : c.revenue_share_pct)}</td>
    </tr>`
    )
    .join("");

  const concBlock = conc.non_shopify_distortion_risk
    ? `<section class="section-context">
    <h2>Business Mix Context</h2>
    <p><strong>${escapeHtml(conc.dominant_channel)}</strong> contributed <strong>${pct(conc.dominant_channel_revenue_share_pct)}</strong> of recognized revenue in this period.</p>
    <p class="note">${escapeHtml(conc.warning || "")}</p>
  </section>`
    : conc.is_materially_concentrated
      ? `<section class="section-context">
    <h2>Revenue Concentration</h2>
    <p><strong>${escapeHtml(conc.dominant_channel)}</strong> contributed <strong>${pct(conc.dominant_channel_revenue_share_pct)}</strong> of net revenue.</p>
    ${conc.warning ? `<p class="note">${escapeHtml(conc.warning)}</p>` : ""}
  </section>`
      : "";

  return `<div id="view-overview" class="view active">
  ${
    ctx.operational?.snapshot?.period?.current_day_incomplete
      ? `<p class="note tone-warn">Today's Meta and order activity may still be incomplete.</p>`
      : ""
  }
  <section>
    <div class="divider-label">Whole Business · Recognized Actuals</div>
    <h2>Business Health</h2>
    <p class="note">The top-line financial position across every recognized sales channel for this reporting period.</p>
    <div class="grid">
      ${card("Health status", `<span class="pill tone-${statusClass(bh.status)}">${escapeHtml(prettyStatus(bh.status))}</span>`, escapeHtml(bh.reason || ""), statusClass(bh.status))}
      ${card("Meta-adjusted profit", money(p.meta_adjusted_profit, cur), "Profit after actual Meta spend", statusClass(bh.status), TIPS.meta_adjusted_profit)}
      ${card("Meta-adjusted margin", pct(p.meta_adjusted_margin_pct))}
      ${card("Net recognized revenue", money(books.net_revenue_ex_tax, cur))}
      ${card("Gross margin", pct(books.gross_margin_pct))}
      ${card("Recognized orders", num(books.recognized_orders, 0))}
    </div>
  </section>

  <section>
    <div class="divider-label">Whole Business · Spend Capacity</div>
    <h2>Business Ad-Spend Affordability ${tip(TIPS.affordability)}</h2>
    <p class="note">Whole-business view. Manual and Other Sales contribute to the economics. Not ecommerce acquisition efficiency.</p>
    <div class="grid">
      ${card("Status", `<span class="pill tone-${statusClass(bas.status)}">${escapeHtml(prettyStatus(bas.status))}</span>`, "", statusClass(bas.status))}
      ${card("Meta spend", money(bas.meta_spend, cur))}
      ${card("Business-wide ad load / order", money(bas.business_wide_ad_load_per_recognized_order ?? bas.blended_ad_cost_per_recognized_order, cur), "", "neutral", TIPS.business_wide_ad_load)}
      ${card("Business break-even CPA", money(bas.break_even_cpa, cur), "", "neutral", TIPS.break_even_cpa)}
      ${card("Headroom", `${money(bas.business_cpa_headroom, cur)} (${pct(bas.business_cpa_headroom_pct)})`)}
      ${card("Ad-spend utilization", pct(bas.ad_spend_utilization_pct))}
    </div>
  </section>

  <section class="section-shopify">
    <div class="divider-label">Shopify / Ecommerce Context</div>
    <h2>Shopify Contribution ${tip(TIPS.shopify_contribution)}</h2>
    <div class="badge-row" style="margin-bottom:12px">
      <span class="badge">DATE-ALIGNED · NOT ATTRIBUTED</span>
      <span class="badge">Shared opex not allocated</span>
      <span class="pill tone-${contribTone}">${escapeHtml(prettyStatus(sc.contribution_status || "—"))}</span>
    </div>
    <div class="grid">
      ${card("Shopify orders", num(sc.recognized_orders, 0))}
      ${card("Shopify gross revenue", money(sc.revenue_ex_tax, cur))}
      ${card("Shopify refunds", money(sc.refunds ?? 0, cur))}
      ${card("Shopify net revenue", money(sc.net_revenue_ex_tax, cur), "", "neutral", TIPS.shopify_net_revenue)}
      ${card("Shopify COGS", money(sc.cogs, cur))}
      ${card("Shopify ad load / order", money(sc.ad_load_per_recognized_order ?? sc.shopify_ad_load_per_recognized_order, cur), "", "neutral", TIPS.shopify_ad_load)}
      ${card("Contribution after Meta", money(sc.contribution_after_meta, cur), escapeHtml(sc.contribution_status_reason || ""), contribTone)}
    </div>
    <p class="note">${escapeHtml(sc.note || "Meta spend is compared with Shopify channel economics for the same date range. This does not mean every Shopify order came from Meta, and no shared operating expenses are allocated here.")}</p>
  </section>

  <section>
    <div class="divider-label">Meta · Attributed Performance</div>
    <h2>Meta Attributed Efficiency</h2>
    <p class="note">Meta-attributed metrics use Meta's own attribution and are not the same as total business CAC.</p>
    <div class="grid">
      ${card("Meta spend", money(me.meta_spend ?? totals.spend, cur))}
      ${card("Meta purchases", num(me.meta_attributed_purchases ?? totals.purchases, 0))}
      ${card("Meta CPA", money(me.meta_attributed_cpa, cur), "", "neutral", TIPS.meta_cpa)}
      ${card("Meta ROAS", roas(me.meta_attributed_roas), "", "neutral", TIPS.meta_roas)}
      ${card("Impressions", num(totals.impressions, 0))}
      ${card("CTR", pct(totals.ctr ?? fb.ctr))}
    </div>
  </section>

  <section>
    <h2>Sales Mix</h2>
    <p class="note">Recognized orders and net revenue split by source, with whole-business totals for context.</p>
    <table class="mix-table">
      <thead><tr><th>Channel</th><th>Orders</th><th>Order Share</th><th>Net Revenue</th><th>Net Share</th></tr></thead>
      <tbody>
        ${salesRows || `<tr><td colspan="5" class="empty">No channel data.</td></tr>`}
        <tr><td><strong>Total</strong></td><td><strong>${num(books.recognized_orders, 0)}</strong></td><td>100%</td><td><strong>${money(books.net_revenue_ex_tax ?? ctx.report.sales_mix?.totals?.net_revenue_ex_tax, cur)}</strong></td><td>100%</td></tr>
      </tbody>
    </table>
  </section>

  ${concBlock}

  ${renderTrendsSection(ctx.operational, cur)}
  ${renderDailyAlertsSection(ctx.operational)}

  <section>
    <h2>Top Actions</h2>
    <p class="note">Prioritized advisory actions generated from the current reporting evidence.</p>
    <div class="grid-2">
      <div><h3>High</h3>${renderRecList([...(recBuckets.critical || []), ...(recBuckets.high || [])])}</div>
      <div><h3>Medium</h3>${renderRecList(recBuckets.medium || [])}</div>
      <div><h3>Low</h3>${renderRecList(recBuckets.low || [])}</div>
    </div>
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

  return `<div id="view-profitability" class="view">
  ${partialNote}
  <section>
    <div class="divider-label">Whole Business · Accounting</div>
    <h2>P&amp;L — Books Recognized Actuals</h2>
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
  <section>
    <div class="divider-label">Whole Business · Channel View</div>
    <h2>Sales by Channel</h2>
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
  <section>
    <h2>Product Portfolio</h2>
    <p class="note">Ledger product economics only — no Meta allocation or product-level ROAS.</p>
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
  <section>
    <div class="divider-label">Meta · Account Level</div>
    <h2>Account Summary</h2>
    <p class="note">Meta-attributed delivery and conversion efficiency for the selected reporting period.</p>
    <div class="grid">
      ${card("Spend", money(totals.spend, cur))}
      ${card("Purchases", num(totals.purchases, 0))}
      ${card("Meta CPA", money(totals.cpa, cur), "", "neutral", TIPS.meta_cpa)}
      ${card("Meta ROAS", roas(totals.roas), "", "neutral", TIPS.meta_roas)}
      ${card("CTR", pct(totals.ctr ?? fb.ctr))}
      ${card("CPM", money(totals.cpm, cur))}
    </div>
  </section>

  <section>
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
  <section>
    <div class="divider-label">INVENTORY &amp; DEMAND INTELLIGENCE</div>
    <h2>Inventory Overview</h2>
    <p class="note">Shopify sellable stock × Variant Master cost; demand from recognized Ledger sales (gift/PR excluded). Headline units are SKU-addressable trusted only. Advisory only — no inventory mutations or POs.</p>
    <div class="grid">
      ${card("SKU-addressable units", num(s.total_units, 0), escapeHtml(s.total_units_scope || "Trusted SKUs only"))}
      ${card("Unkeyed units", num(s.unkeyed_inventory_units, 0), `bundle/set≈${num(s.unkeyed_likely_bundle_set_units, 0)}`)}
      ${card("Safe Shopify total", num(s.total_shopify_inventory_units_if_safe, 0), "addressable + unkeyed; excl duplicate SKUs")}
      ${card("Inventory value", money(s.total_inventory_value), `excl missing-cost + duplicate SKUs`)}
      ${card("No-recent-demand value", money(s.no_recent_demand_value), "30d soft — not in capital at risk")}
      ${card("Dead inventory (90d)", money(s.dead_inventory_value))}
      ${card("Overstock value", money(s.overstock_value))}
      ${card("Capital at risk", s.capital_at_risk_pct == null ? "—" : pct(s.capital_at_risk_pct), money(s.capital_at_risk_value))}
      ${card("Critical", num(s.critical_sku_count, 0), "", "bad")}
      ${card("Low stock", num(s.low_sku_count, 0), "", "warn")}
      ${card("Overstock SKUs", num(s.overstock_sku_count, 0))}
      ${card("No demand 90d", num(s.no_demand_sku_count, 0))}
      ${card("No recent 30d", num(s.no_recent_demand_sku_count, 0))}
      ${card("Missing-SKU variants", num(s.missing_sku_variant_count, 0))}
      ${card("Duplicate SKU variants", num(s.duplicate_sku_variant_count, 0), `excl ${num(s.duplicate_sku_units_excluded, 0)} units`)}
    </div>
  </section>
  <section>
    <h2>Restock Priorities</h2>
    <table>${th}<tbody>${invSkuRows((inv.restock_priorities || []).slice(0, 20))}</tbody></table>
  </section>
  <section>
    <h2>Stockout Risks</h2>
    <table>${th}<tbody>${invSkuRows((inv.stockout_risks || []).slice(0, 20))}</tbody></table>
  </section>
  <section>
    <h2>Overstock / Dead Stock</h2>
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
  <section>
    <div class="divider-label">CUSTOMER &amp; COHORT ECONOMICS</div>
    <h2>Customer Overview</h2>
    <p class="note">Recognized Shopify + Ledger economics. Identity via Shopify customer ID (email hashed only if needed). Confidence: <strong>${escapeHtml(cust.confidence || "—")}</strong>.</p>
    <div class="grid">
      ${card("Identified customers", num(s.recognized_customers_identified, 0))}
      ${card("New", num(s.new_customers, 0))}
      ${card("Returning", num(s.returning_customers, 0))}
      ${card("Guest/unknown", num(s.guest_unknown_customers, 0))}
      ${card("Orders", num(s.recognized_orders, 0))}
      ${card("Revenue", money(s.revenue))}
      ${card("GP", money(s.gross_profit))}
      ${card("Rev/customer", money(s.revenue_per_identified_customer))}
      ${card("GP/customer", money(s.gp_per_identified_customer))}
      ${card("Repeat customer rate", s.repeat_customer_rate_pct == null ? "—" : pct(s.repeat_customer_rate_pct))}
      ${card("Repeat order share", s.repeat_order_share_pct == null ? "—" : pct(s.repeat_order_share_pct))}
      ${card("Guest order share", s.guest_order_share_pct == null ? "—" : pct(s.guest_order_share_pct))}
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
    <h2>Observed CAC</h2>
    <p class="note">${escapeHtml(cac.label || "FIRST-PARTY OBSERVED NEW-CUSTOMER CAC")} · ${escapeHtml(cac.observed_gp_cac_label || "OBSERVED GP:CAC")} (not LTV:CAC). Confidence: <strong>${escapeHtml(cac.confidence || "—")}</strong>.</p>
    <div class="grid">
      ${card("Meta spend", money(cac.meta_spend))}
      ${card("Meta new customers", num(cac.meta_new_customers, 0))}
      ${card("FP observed CAC", money(cac.first_party_observed_new_customer_cac))}
      ${card("Obs. GP/customer", money(cac.observed_gp_per_customer))}
      ${card("Observed GP:CAC", num(cac.observed_gp_cac_ratio, 2))}
      ${card("Observed Rev:CAC", num(cac.observed_revenue_cac_ratio, 2))}
    </div>
  </section>
  <section>
    <h2>Data Quality</h2>
    <ul class="warn-list">${warnList || `<li class="empty">No customer warnings.</li>`}</ul>
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
    ["profitability", "Profitability"],
    ["sales", "Sales"],
    ["products", "Products"],
    ["inventory", "Inventory"],
    ["customers", "Customers"],
    ["advertising", "Advertising"],
    ["decisions", "Decisions"],
    ["data-quality", "Data Quality"],
    ["attribution", "Attribution"],
    ["attr-economics", "Attr. Economics"],
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
      <h1>Reporting &amp; Decision Intelligence</h1>
      <div class="period">${escapeHtml(dr.since)} → ${escapeHtml(dr.until)}</div>
      <div class="badge-row">
        <span class="badge">${escapeHtml(dr.timezone || "Asia/Karachi")}</span>
        <span class="badge">Generated ${escapeHtml(report.generated_at || "")}</span>
        <span class="badge">${isFull ? "Full calendar month" : "Partial period"}</span>
        <span class="badge">READ ONLY</span>
        <button type="button" class="btn-print" id="print-btn">Print / Save PDF</button>
      </div>
    </header>

    ${renderOverview(ctx)}
    ${renderProfitability(ctx)}
    ${renderSales(ctx)}
    ${renderProducts(ctx)}
    ${renderInventory(ctx)}
    ${renderCustomers(ctx)}
    ${renderAdvertising(ctx)}
    ${renderDecisions(ctx)}
    ${renderDataQuality(ctx)}
    ${renderAttribution(ctx)}
    ${renderAttributionEconomics(ctx)}

    <footer>
      Wear Active Reporting &amp; Decision Intelligence · Advisory only · No Meta mutations · No Sheet writes
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
