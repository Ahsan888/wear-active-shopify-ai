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
  };
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
  <section>
    <h2>Business Health</h2>
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
    <table>
      <thead><tr><th>Channel</th><th>Orders</th><th>Order Share</th><th>Net Revenue</th><th>Net Share</th></tr></thead>
      <tbody>
        ${salesRows || `<tr><td colspan="5" class="empty">No channel data.</td></tr>`}
        <tr><td><strong>Total</strong></td><td><strong>${num(books.recognized_orders, 0)}</strong></td><td>100%</td><td><strong>${money(books.net_revenue_ex_tax ?? ctx.report.sales_mix?.totals?.net_revenue_ex_tax, cur)}</strong></td><td>100%</td></tr>
      </tbody>
    </table>
  </section>

  ${concBlock}

  <section>
    <h2>Top Actions</h2>
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
    <h2>P&amp;L — Books Recognized Actuals</h2>
    <table class="pl-table">
      <tbody>${plRows}</tbody>
    </table>
  </section>

  <section>
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
    <div class="grid">
      ${card("Meta spend", money(recon.meta_spend, cur))}
      ${card("Ledger Ads", money(recon.ledger_ads_expense, cur))}
      ${card("Recurring Ads", money(recon.recurring_ads_expense, cur))}
      ${card("Meta − Ledger", money(recon.meta_vs_ledger_variance, cur), escapeHtml(recon.ad_spend_reconciliation_status || ""), statusClass(recon.ad_spend_reconciliation_status))}
    </div>
  </section>

  <section>
    <h2>Expense by Category</h2>
    <table>
      <thead><tr><th>Category</th><th>Amount</th></tr></thead>
      <tbody>${expenseRows}</tbody>
    </table>
  </section>
</div>`;
}

function renderSales(ctx) {
  const { cur, report, sc, conc } = ctx;
  const sbc = report.sales_by_channel || {};
  const channels = CHANNEL_ORDER.filter((n) => sbc[n]).concat(
    Object.keys(sbc).filter((k) => !CHANNEL_ORDER.includes(k))
  );

  let totOrders = 0;
  let totUnits = 0;
  let totGross = 0;
  let totRefunds = 0;
  let totNet = 0;
  let totCogs = 0;
  let totGp = 0;

  const channelRows = channels
    .map((name) => {
      const c = sbc[name];
      totOrders += Number(c.orders || 0);
      totUnits += Number(c.units || 0);
      totGross += Number(c.revenue_ex_tax || 0);
      totRefunds += Number(c.refunds || 0);
      totNet += Number(c.net_revenue_ex_tax ?? c.revenue_ex_tax ?? 0);
      totCogs += Number(c.cogs || 0);
      totGp += Number(c.gross_profit ?? 0);
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

  const mixTotals = report.sales_mix?.totals || {};
  const totalGm = pct(mixTotals.gross_margin_pct);

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
    <h2>Sales by Channel</h2>
    <table>
      <thead><tr>
        <th>Channel</th><th>Orders</th><th>Units</th><th>Gross</th><th>Refunds</th>
        <th>Net</th><th>COGS</th><th>GP</th><th>GM</th>
      </tr></thead>
      <tbody>
        ${channelRows || `<tr><td colspan="9" class="empty">No channel data.</td></tr>`}
        <tr class="total-row">
          <td><strong>Total</strong></td>
          <td><strong>${num(totOrders, 0)}</strong></td>
          <td><strong>${num(totUnits, 0)}</strong></td>
          <td><strong>${money(totGross, cur)}</strong></td>
          <td><strong>${money(totRefunds, cur)}</strong></td>
          <td><strong>${money(totNet, cur)}</strong></td>
          <td><strong>${money(totCogs, cur)}</strong></td>
          <td><strong>${money(totGp, cur)}</strong></td>
          <td><strong>${totalGm}</strong></td>
        </tr>
      </tbody>
    </table>
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
    <h2>Account Summary</h2>
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
    <div class="funnel">${funnelHtml}</div>
    <div class="grid" style="margin-top:12px">
      ${card("LPV→ATC", pct(fb.lpv_to_atc_pct ?? totals.lpv_to_atc_pct))}
      ${card("ATC→checkout", pct(fb.atc_to_checkout_pct ?? totals.atc_to_checkout_pct))}
      ${card("Checkout→purchase", pct(fb.checkout_to_purchase_pct ?? totals.checkout_to_purchase_pct))}
    </div>
  </section>

  <section>
    <h2>Campaigns</h2>
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
    <table>
      <thead><tr><th>Ad</th><th>Status</th><th>Spend</th><th>Purch</th><th>CPA</th><th>Evidence</th><th>Funnel</th></tr></thead>
      <tbody>${attentionRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Scale Candidates</h2>
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
    <h2>Accounting Warnings</h2>
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

const STYLES = `
:root {
  --bg: #f7f5f1;
  --ink: #1c1917;
  --muted: #78716c;
  --card: #ffffff;
  --line: #e7e5e4;
  --ok: #166534;
  --ok-bg: #dcfce7;
  --warn: #92400e;
  --warn-bg: #fef3c7;
  --bad: #991b1b;
  --bad-bg: #fee2e2;
  --neutral: #44403c;
  --accent: #0f766e;
  --shadow: 0 10px 30px rgba(28,25,23,.06);
  --radius: 16px;
  --font: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--font);
  color: var(--ink);
  background:
    radial-gradient(1200px 500px at 10% -10%, #d9f3ef 0%, transparent 55%),
    var(--bg);
  line-height: 1.45;
}
.layout { display: flex; min-height: 100vh; }
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--card);
  border-right: 1px solid var(--line);
  padding: 20px 12px;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}
.sidebar .brand {
  font-size: 11px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 700;
  padding: 0 8px 16px;
}
.nav-btn {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 14px;
  color: var(--muted);
  cursor: pointer;
  margin-bottom: 2px;
}
.nav-btn:hover { background: #f5f5f4; color: var(--ink); }
.nav-btn.active { background: #ecfdf5; color: var(--accent); font-weight: 600; }
.main { flex: 1; min-width: 0; padding: 24px 28px 64px; max-width: 1100px; }
header.hero { margin-bottom: 24px; }
header.hero h1 { margin: 4px 0; font-size: clamp(24px, 3vw, 34px); letter-spacing: -0.03em; }
.subtitle { color: var(--muted); font-size: 15px; }
.period { font-size: 17px; color: var(--muted); margin-top: 6px; }
.badge-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }
.badge {
  display: inline-flex; align-items: center;
  padding: 5px 10px; border-radius: 999px;
  background: #fff; border: 1px solid var(--line);
  font-size: 12px; color: var(--muted);
}
.btn-print {
  margin-left: auto;
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  font-weight: 600;
}
.btn-print:hover { background: #0d9488; }
.view { display: none; }
.view.active { display: block; }
section {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 18px 20px;
  margin-bottom: 16px;
}
section h2 {
  margin: 0 0 12px;
  font-size: 14px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--muted);
}
section h3 { margin: 0 0 8px; font-size: 15px; }
.grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.grid-2 { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.grid-3 { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
.card {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px;
  background: #fafaf9;
}
.card-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.card-value { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
.card-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
.tone-ok .card-value, .pill.tone-ok, .tone-ok { color: var(--ok); }
.tone-warn .card-value, .pill.tone-warn, .tone-warn { color: var(--warn); }
.tone-bad .card-value, .pill.tone-bad, .tone-bad { color: var(--bad); }
.pill {
  display: inline-block; font-size: 11px; font-weight: 700;
  padding: 3px 8px; border-radius: 999px; background: #f5f5f4;
}
.tone-ok.pill, .product-card.tone-ok { background: var(--ok-bg); }
.tone-warn.pill, .product-card.tone-warn { background: var(--warn-bg); }
.tone-bad.pill, .product-card.tone-bad { background: var(--bad-bg); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 11px; color: var(--muted); font-weight: 600; }
.pl-table td:last-child { text-align: right; }
.total-row { background: #fafaf9; }
.muted { color: var(--muted); font-size: 13px; }
.note { font-size: 13px; color: var(--muted); margin: 8px 0 0; }
.empty { color: var(--muted); font-style: italic; }
.tip { cursor: help; color: var(--accent); font-size: 12px; margin-left: 4px; }
.waterfall { font-size: 14px; line-height: 1.6; }
.summary-line { font-size: 15px; margin: 12px 0 0; }
.rec-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.rec-list li { border: 1px solid var(--line); border-radius: 10px; padding: 10px; background: #fafaf9; }
.rec-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
.product-card { border-radius: 12px; padding: 12px; margin-bottom: 10px; border: 1px solid var(--line); }
.product-card.data-issue-card { border-color: #fbbf24; box-shadow: 0 0 0 2px #fef3c733; }
.data-issue-line { color: var(--warn); font-weight: 600; }
.product-head { display: flex; justify-content: space-between; gap: 10px; align-items: start; }
.product-card h3 { margin: 0 0 4px; font-size: 15px; }
.sku-list { margin: 8px 0 0; padding-left: 18px; font-size: 12px; }
details summary { cursor: pointer; font-size: 13px; color: var(--accent); margin-top: 8px; }
.scale-card { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: #f0fdfa; margin-bottom: 10px; }
.scale-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); font-weight: 700; }
.conf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
.conf-item { border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
.section-shopify { border-color: #99f6e4; background: linear-gradient(180deg, #f0fdfa 0%, #fff 40%); }
.section-context { border-color: #fcd34d; background: #fffbeb; }
.divider-label { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); font-weight: 700; margin: 0 0 10px; }
.filter-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.filter-btn {
  padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line);
  background: #fff; font-size: 12px; cursor: pointer; color: var(--muted);
}
.filter-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.funnel { display: grid; gap: 8px; }
.funnel-step { display: flex; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line); }
.funnel-num {
  width: 28px; height: 28px; border-radius: 50%; background: #ecfdf5;
  color: var(--accent); font-weight: 700; font-size: 13px;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.warn-list { padding-left: 18px; }
footer { margin-top: 20px; color: var(--muted); font-size: 12px; text-align: center; }
@media (max-width: 768px) {
  .layout { flex-direction: column; }
  .sidebar { width: 100%; height: auto; position: static; display: flex; flex-wrap: wrap; gap: 4px; padding: 12px; }
  .nav-btn { width: auto; flex: 1 1 auto; min-width: 100px; text-align: center; font-size: 12px; padding: 8px; }
  .main { padding: 16px 14px 48px; }
  .ad-table th:nth-child(n+4), .ad-table td:nth-child(n+4) { display: none; }
}
@media print {
  .sidebar, .filter-bar, .btn-print, .nav-btn { display: none !important; }
  .layout { display: block; }
  .main { max-width: none; padding: 0; }
  .view { display: block !important; page-break-inside: avoid; }
  section { box-shadow: none; break-inside: avoid; }
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
    ["advertising", "Advertising"],
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
    ${renderAdvertising(ctx)}
    ${renderDecisions(ctx)}
    ${renderDataQuality(ctx)}

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
