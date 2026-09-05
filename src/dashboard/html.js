/**
 * Render a self-contained decision dashboard HTML document from a decision bundle.
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
} = require("./format");
const {
  groupProductsByName,
  groupRecommendationsByPriority,
} = require("./groups");

function card(label, value, sub = "", tone = "neutral") {
  return `<div class="card tone-${tone}">
    <div class="card-label">${escapeHtml(label)}</div>
    <div class="card-value">${value}</div>
    ${sub ? `<div class="card-sub">${sub}</div>` : ""}
  </div>`;
}

function renderDecisionDashboard(report) {
  const cur = report.meta?.account?.currency || "PKR";
  const bh = report.business_health || {};
  const bas = report.business_advertising_safety || {};
  const me = report.meta_efficiency || {};
  const books = report.books || {};
  const p = report.profitability || {};
  const sc = report.shopify_context || {};
  const mix = report.sales_mix?.channels || [];
  const conf = report.confidence || {};
  const fb = report.meta?.funnel_baselines || {};
  const totals = report.meta?.totals || {};
  const recon = report.data_quality?.ad_reconciliation || {};
  const conc = report.revenue_concentration || {};
  const contribTone = statusClass(sc.contribution_status);

  const attention = (report.ads || []).filter((a) =>
    [
      "high_priority_spend_no_purchase",
      "spend_no_purchase",
      "high_cpa",
      "weak_funnel",
      "watch",
      "relatively_weak_cpa",
    ].includes(a.status)
  );
  const scales = [...(report.ads || []), ...(report.campaigns || [])].filter(
    (e) => e.status === "scale_candidate"
  );
  const productGroups = groupProductsByName(report.products || []);
  const recBuckets = groupRecommendationsByPriority(
    (report.recommendations || []).filter((r) => r.priority !== "info")
  );

  const jsonBlob = escapeHtml(JSON.stringify(report));

  const salesRows = mix
    .map(
      (c) => `<tr>
      <td>${escapeHtml(c.channel)}</td>
      <td>${num(c.orders, 0)}</td>
      <td>${money(c.revenue_ex_tax, cur)}</td>
      <td>${pct(c.order_share_pct)}</td>
      <td>${pct(c.revenue_share_pct)}</td>
    </tr>`
    )
    .join("");

  const attentionRows = attention.length
    ? attention
        .slice(0, 20)
        .map(
          (a) => `<tr>
      <td>${escapeHtml((a.entity_name || "—").slice(0, 64))}</td>
      <td><span class="pill tone-${statusClass(a.status)}">${escapeHtml(prettyStatus(a.status))}</span></td>
      <td>${money(a.spend, cur)}</td>
      <td>${num(a.purchases, 0)}</td>
      <td>${money(a.meta_attributed_cpa, cur)}</td>
      <td>${a.entity_cpa_vs_account_ratio != null ? `${a.entity_cpa_vs_account_ratio}×` : a.spend_vs_account_cpa != null ? `${a.spend_vs_account_cpa}× spend` : "—"}</td>
      <td>${a.has_funnel_warning ? (a.primary_weak_funnel ? "Primary weak" : "Warning") : "—"}</td>
    </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty">No ads currently flagged for attention.</td></tr>`;

  const scaleBlock = scales.length
    ? scales
        .map((e) => {
          const accCpa = totals.cpa;
          const improve =
            accCpa > 0 && e.meta_attributed_cpa != null
              ? Math.round((1 - e.meta_attributed_cpa / accCpa) * 1000) / 10
              : null;
          return `<div class="scale-card">
          <div class="scale-title">Controlled review candidate</div>
          <h3>${escapeHtml(e.entity_name || e.entity_id || "—")}</h3>
          <div class="grid-3">
            <div><span class="muted">Spend</span><strong>${money(e.spend, cur)}</strong></div>
            <div><span class="muted">Purchases</span><strong>${num(e.purchases, 0)}</strong></div>
            <div><span class="muted">CPA</span><strong>${money(e.meta_attributed_cpa, cur)}</strong></div>
            <div><span class="muted">Account CPA</span><strong>${money(accCpa, cur)}</strong></div>
            <div><span class="muted">CPA improvement</span><strong>${improve == null ? "—" : `${improve}%`}</strong></div>
            <div><span class="muted">ROAS</span><strong>${roas(e.meta_attributed_roas)} vs ${roas(totals.roas)}</strong></div>
          </div>
          <p class="note">Funnel warning: ${e.has_funnel_warning ? "yes" : "no"} · Advisory only — do not auto-scale.</p>
        </div>`;
        })
        .join("")
    : `<p class="empty">No ads currently have enough evidence for controlled scaling.</p>`;

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

  const productCards = productGroups.length
    ? productGroups
        .slice(0, 25)
        .map((g) => {
          const skuLines = g.skus
            .slice(0, 8)
            .map((s) => {
              const ev = s.evidence || {};
              const extra =
                s.reason_code === "missing_ledger_cogs"
                  ? ` · expected VM COGS ${money(ev.expected_vm_cogs || s.expected_vm_cogs, cur)}`
                  : "";
              return `<li><code>${escapeHtml(s.sku || "(no sku)")}</code> · ${escapeHtml(s.reason_code || s.status)}${extra}</li>`;
            })
            .join("");
          return `<div class="product-card tone-${statusClass(g.status)}">
          <div class="product-head">
            <h3>${escapeHtml(g.product)}</h3>
            <span class="pill tone-${statusClass(g.status)}">${escapeHtml(prettyStatus(g.status))}</span>
          </div>
          <div class="muted">${g.sku_count} SKU${g.sku_count === 1 ? "" : "s"} · rev ${money(g.revenue_ex_tax, cur)} · GP ${money(g.gross_profit, cur)} · GM ${pct(g.gross_margin_pct)}</div>
          <p>${escapeHtml(g.reason || "")}</p>
          <ul class="sku-list">${skuLines}</ul>
        </div>`;
        })
        .join("")
    : `<p class="empty">No product rows in range.</p>`;

  const warnings = (report.data_quality?.warnings || [])
    .map(
      (w) =>
        `<li class="tone-${statusClass(w.severity || w.code)}"><strong>${escapeHtml(w.code)}</strong> — ${escapeHtml(w.message)}</li>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Wear Active — Decision Intelligence</title>
<style>
:root {
  --bg: #f6f3ee;
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
    radial-gradient(900px 400px at 100% 0%, #fde68a55 0%, transparent 50%),
    var(--bg);
  line-height: 1.45;
}
.wrap { max-width: 1120px; margin: 0 auto; padding: 28px 20px 64px; }
header.hero {
  display: grid;
  gap: 8px;
  margin-bottom: 28px;
}
.brand { font-size: 13px; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); font-weight: 700; }
h1 { margin: 0; font-size: clamp(28px, 4vw, 40px); letter-spacing: -0.03em; }
.period { font-size: 18px; color: var(--muted); }
.badge-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 10px; border-radius: 999px; background: #fff; border: 1px solid var(--line);
  font-size: 12px; color: var(--muted);
}
section {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 20px 22px;
  margin-bottom: 18px;
}
section h2 {
  margin: 0 0 14px;
  font-size: 15px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--muted);
}
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
.grid-2 { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.grid-3 { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.card {
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 14px;
  background: #fafaf9;
}
.card-label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.card-value { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
.card-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
.tone-ok .card-value, .pill.tone-ok { color: var(--ok); }
.tone-warn .card-value, .pill.tone-warn { color: var(--warn); }
.tone-bad .card-value, .pill.tone-bad { color: var(--bad); }
.pill {
  display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .04em;
  padding: 4px 8px; border-radius: 999px; background: #f5f5f4;
}
.tone-ok.pill, .product-card.tone-ok { background: var(--ok-bg); }
.tone-warn.pill, .product-card.tone-warn { background: var(--warn-bg); }
.tone-bad.pill, .product-card.tone-bad { background: var(--bad-bg); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; }
.muted { color: var(--muted); font-size: 13px; }
.note { font-size: 13px; color: var(--muted); margin: 10px 0 0; }
.empty { color: var(--muted); font-style: italic; }
.tip { cursor: help; color: var(--accent); font-size: 12px; margin-left: 4px; }
.rec-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.rec-list li { border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: #fafaf9; }
.rec-head { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 4px; flex-wrap: wrap; }
.product-card { border-radius: 14px; padding: 14px; margin-bottom: 10px; border: 1px solid var(--line); }
.product-head { display: flex; justify-content: space-between; gap: 10px; align-items: start; }
.product-card h3 { margin: 0 0 4px; font-size: 16px; }
.sku-list { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
.scale-card { border: 1px solid var(--line); border-radius: 14px; padding: 14px; background: #f0fdfa; margin-bottom: 10px; }
.scale-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); font-weight: 700; }
.conf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.conf-item { border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
.section-shopify {
  border-color: #99f6e4;
  background: linear-gradient(180deg, #f0fdfa 0%, #ffffff 40%);
}
.section-context {
  border-color: #fcd34d;
  background: #fffbeb;
}
.divider-label {
  font-size: 11px;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 700;
  margin: 4px 0 12px;
}
footer { margin-top: 24px; color: var(--muted); font-size: 12px; text-align: center; }
@media (max-width: 640px) {
  .wrap { padding: 18px 14px 48px; }
  th:nth-child(n+4), td:nth-child(n+4) { display: none; }
}
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <div class="brand">Wear Active</div>
    <h1>Decision Intelligence</h1>
    <div class="period">${escapeHtml(report.date_range?.since)} → ${escapeHtml(report.date_range?.until)}</div>
    <div class="badge-row">
      <span class="badge">${report.date_range?.is_full_calendar_month ? "Full calendar month" : "Partial period"}</span>
      <span class="badge">${escapeHtml(report.date_range?.timezone || "Asia/Karachi")}</span>
      <span class="badge">Generated ${escapeHtml(report.generated_at || "")}</span>
      <span class="badge">Advisory / read-only</span>
    </div>
  </header>

  <section>
    <h2>Business Health</h2>
    <div class="grid">
      ${card("Health status", `<span class="pill tone-${statusClass(bh.status)}">${escapeHtml(prettyStatus(bh.status))}</span>`, escapeHtml(bh.reason || ""), statusClass(bh.status))}
      ${card(`Meta-adjusted profit ${tip(TIPS.meta_adjusted_profit)}`, money(p.meta_adjusted_profit, cur), "Profit after actual Meta spend", statusClass(bh.status))}
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
      ${card(`Business-wide ad load / order ${tip(TIPS.business_wide_ad_load)}`, money(bas.business_wide_ad_load_per_recognized_order ?? bas.blended_ad_cost_per_recognized_order, cur))}
      ${card(`Business break-even CPA ${tip(TIPS.break_even_cpa)}`, money(bas.break_even_cpa, cur))}
      ${card("Headroom", `${money(bas.business_cpa_headroom, cur)} (${pct(bas.business_cpa_headroom_pct)})`)}
      ${card("Ad-spend utilization", pct(bas.ad_spend_utilization_pct))}
    </div>
  </section>

  <section>
    <h2>Sales Mix</h2>
    <table>
      <thead><tr><th>Channel</th><th>Orders</th><th>Revenue</th><th>Order Share</th><th>Revenue Share</th></tr></thead>
      <tbody>
        ${salesRows}
        <tr><td><strong>Total</strong></td><td><strong>${num(books.recognized_orders, 0)}</strong></td><td><strong>${money(books.revenue_ex_tax ?? report.sales_mix?.totals?.revenue_ex_tax, cur)}</strong></td><td>100%</td><td>100%</td></tr>
      </tbody>
    </table>
    <p class="note">Channels reuse Books saleChannel() (Shopify / Manual / Other Sales). Global profit totals are unchanged.</p>
  </section>

  ${
    conc.non_shopify_distortion_risk
      ? `<section class="section-context">
    <h2>Business Mix Context</h2>
    <p><strong>${escapeHtml(conc.dominant_channel)}</strong> contributed <strong>${pct(conc.dominant_channel_revenue_share_pct)}</strong> of recognized revenue in this period.</p>
    <p class="note">${escapeHtml(conc.warning || "")}</p>
  </section>`
      : ""
  }

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
      ${card("Shopify units", num(sc.recognized_units, 0))}
      ${card("Shopify revenue ex-tax", money(sc.revenue_ex_tax, cur))}
      ${card("Shopify COGS", money(sc.cogs, cur))}
      ${card("Gross profit before ads", money(sc.gross_profit_before_ads, cur))}
      ${card("Gross margin before ads", pct(sc.gross_margin_before_ads_pct))}
      ${card("Meta spend", money(sc.meta_spend, cur))}
      ${card(`Shopify ad load / order ${tip(TIPS.shopify_ad_load)}`, money(sc.ad_load_per_recognized_order ?? sc.shopify_ad_load_per_recognized_order, cur))}
      ${card("Contribution after Meta", money(sc.contribution_after_meta, cur), escapeHtml(sc.contribution_status_reason || ""), contribTone)}
      ${card("Contribution margin after Meta", pct(sc.contribution_margin_after_meta_pct), "", contribTone)}
    </div>
    <p class="note">${escapeHtml(sc.note || "Meta spend is compared with Shopify channel economics for the same date range. This does not mean every Shopify order came from Meta, and no shared operating expenses are allocated here.")}</p>
  </section>

  <section>
    <h2>Meta Attributed Efficiency</h2>
    <p class="note">Meta-attributed metrics use Meta's own attribution and are not the same as total business CAC.</p>
    <div class="grid">
      ${card("Meta spend", money(me.meta_spend ?? totals.spend, cur))}
      ${card("Meta purchases", num(me.meta_attributed_purchases ?? totals.purchases, 0))}
      ${card(`Meta CPA ${tip(TIPS.meta_cpa)}`, money(me.meta_attributed_cpa, cur))}
      ${card(`Meta ROAS ${tip(TIPS.meta_roas)}`, roas(me.meta_attributed_roas))}
      ${card("Impressions", num(totals.impressions, 0))}
      ${card("CTR", pct(totals.ctr ?? fb.ctr))}
      ${card("LPV→ATC", pct(fb.lpv_to_atc_pct))}
      ${card("ATC→checkout", pct(fb.atc_to_checkout_pct))}
      ${card("Checkout→purchase", pct(fb.checkout_to_purchase_pct))}
    </div>
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
      <thead><tr><th>Ad</th><th>Status</th><th>Spend</th><th>Purch</th><th>CPA</th><th>vs Account</th><th>Funnel</th></tr></thead>
      <tbody>${attentionRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Scale Candidates</h2>
    ${scaleBlock}
  </section>

  <section>
    <h2>Product Opportunities / Risks</h2>
    <p class="note">Grouped by product name for readability. SKU-level detail remains in embedded JSON.</p>
    ${productCards}
  </section>

  <section>
    <h2>Accounting / Data Quality</h2>
    <div class="grid">
      ${card("Meta spend", money(recon.meta_spend, cur))}
      ${card("Ledger Ads", money(recon.ledger_ads_expense, cur))}
      ${card("Recurring Ads", money(recon.recurring_ads_expense, cur))}
      ${card("Meta − Ledger", money(recon.meta_vs_ledger_variance, cur), escapeHtml(recon.ad_spend_reconciliation_status || ""), statusClass(recon.ad_spend_reconciliation_status))}
    </div>
    <ul>${warnings || "<li class='empty'>No warnings</li>"}</ul>
    <p class="note">No Meta→Shopify order-level attribution is available.</p>
  </section>

  <section>
    <h2>Confidence</h2>
    <div class="conf-grid">
      <div class="conf-item"><div class="muted">Business</div><strong class="tone-${statusClass(conf.business)}">${escapeHtml(prettyStatus(conf.business))}</strong></div>
      <div class="conf-item"><div class="muted">Advertising</div><strong class="tone-${statusClass(conf.advertising)}">${escapeHtml(prettyStatus(conf.advertising))}</strong></div>
      <div class="conf-item"><div class="muted">Entities</div><strong class="tone-${statusClass(conf.entities)}">${escapeHtml(prettyStatus(conf.entities))}</strong></div>
      <div class="conf-item"><div class="muted">Products</div><strong class="tone-${statusClass(conf.products)}">${escapeHtml(prettyStatus(conf.products))}</strong></div>
      <div class="conf-item"><div class="muted">Attribution</div><strong class="tone-bad">${escapeHtml(prettyStatus(conf.attribution || "unavailable"))}</strong></div>
    </div>
    <p class="note">${escapeHtml(conf.notes?.attribution || "Attribution claims requiring Meta→Shopify joins are unavailable.")}</p>
  </section>

  <footer>
    Wear Active Decision Intelligence · Advisory only · No Meta mutations · No Sheet writes
  </footer>
</div>
<script type="application/json" id="decision-data">${jsonBlob}</script>
</body>
</html>`;
}

module.exports = {
  renderDecisionDashboard,
};
