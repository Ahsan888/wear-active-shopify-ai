/**
 * Beginner-friendly HTML report for Meta ads deep audit.
 */
const {
  formatMoney,
  formatNumber,
  formatPct,
  formatRoas,
} = require("../meta/metrics");

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n, currency) {
  return formatMoney(n, currency || "PKR");
}

function num(n, d = 2) {
  return formatNumber(n, d);
}

function pct(n) {
  return formatPct(n, 2);
}

function roas(n) {
  return formatRoas(n);
}

function diagClass(d) {
  if (!d) return "";
  if (d === "HEALTHY" || d === "STRONG_CREATIVE") return "ok";
  if (d === "INSUFFICIENT_DATA") return "muted";
  return "warn";
}

function listBrief(title, items, currency) {
  if (!items?.length) {
    return `<section class="block"><h3>${esc(title)}</h3><p class="empty">None in this window.</p></section>`;
  }
  const rows = items
    .map(
      (a) => `<li>
      <strong>${esc(a.ad_name || a.ad_id)}</strong>
      <span class="id">ID ${esc(a.ad_id)}</span>
      <span>Spend ${esc(money(a.spend, currency))}</span>
      <span>Purchases ${esc(num(a.purchases, 0))}</span>
      <span>CPA ${esc(money(a.cpa, currency))}</span>
      <span>ROAS ${esc(roas(a.roas))}</span>
      <span class="tag ${diagClass(a.diagnosis)}">${esc(a.diagnosis || "—")}</span>
    </li>`
    )
    .join("\n");
  return `<section class="block"><h3>${esc(title)}</h3><ul class="brief">${rows}</ul></section>`;
}

function funnelHtml(funnelEntry, currency) {
  const f = funnelEntry.funnel || {};
  const s = f.stages || {};
  const r = f.rates || {};
  const steps = [
    ["Impressions", s.impressions, null],
    ["Link Clicks", s.link_clicks, r.impression_to_link_click_pct],
    ["Landing Page Views", s.landing_page_views, r.link_click_to_lpv_pct],
    ["Add to Cart", s.add_to_carts, r.lpv_to_atc_pct],
    ["Checkout", s.checkouts, r.atc_to_checkout_pct],
    ["Purchase", s.purchases, r.checkout_to_purchase_pct],
  ];
  const body = steps
    .map((step, i) => {
      const [label, value, conv] = step;
      const arrow =
        i === 0
          ? ""
          : `<div class="arrow">↓ <span class="conv">${esc(
              conv == null ? "n/a" : pct(conv)
            )} convert</span></div>`;
      return `${arrow}<div class="stage"><span class="label">${esc(
        label
      )}</span><span class="val">${esc(num(value, 0))}</span></div>`;
    })
    .join("\n");
  const explain = funnelEntry.plain_english
    ? `<p class="explain">${esc(funnelEntry.plain_english)}</p>`
    : `<p class="explain muted">No plain-English funnel note — not enough stage volume to support a claim.</p>`;
  return `<article class="funnel">
    <header>
      <h4>${esc(funnelEntry.ad_name || funnelEntry.ad_id)}</h4>
      <span class="id">ID ${esc(funnelEntry.ad_id)}</span>
      <span class="tag ${diagClass(funnelEntry.diagnosis)}">${esc(
        funnelEntry.diagnosis || "—"
      )}</span>
      <span class="spend">Spend ${esc(money(funnelEntry.spend, currency))}</span>
    </header>
    <div class="stages">${body}</div>
    ${explain}
  </article>`;
}

function renderAdsAuditHtml(audit) {
  const currency = audit.account?.currency || "PKR";
  const s = audit.summary || {};
  const h = audit.highlights || {};
  const since = audit.date_range?.since;
  const until = audit.date_range?.until;

  const kpi = [
    ["Spend", money(s.spend, currency)],
    ["Meta purchases", num(s.purchases, 0)],
    ["Meta revenue", money(s.purchase_value, currency)],
    ["Meta ROAS", roas(s.roas)],
    ["Meta cost per purchase", money(s.cpa, currency)],
    ["CTR", pct(s.ctr)],
    ["CPC", money(s.cpc, currency)],
    ["Landing page views", num(s.landing_page_views, 0)],
  ]
    .map(
      ([label, value]) =>
        `<div class="kpi"><div class="k">${esc(label)}</div><div class="v">${esc(
          value
        )}</div></div>`
    )
    .join("\n");

  const adRows = (audit.ad_table || [])
    .map(
      (a) => `<tr>
      <td><div class="adname">${esc(a.ad_name || "—")}</div><div class="id">ID ${esc(
        a.ad_id
      )}</div></td>
      <td>${esc(a.campaign_name || a.campaign_id || "—")}</td>
      <td>${esc(a.adset_name || a.adset_id || "—")}</td>
      <td>${esc(a.status || "—")}</td>
      <td class="num">${esc(money(a.spend, currency))}</td>
      <td class="num">${esc(num(a.impressions, 0))}</td>
      <td class="num">${esc(pct(a.ctr))}</td>
      <td class="num">${esc(money(a.cpc, currency))}</td>
      <td class="num">${esc(num(a.lpv, 0))}</td>
      <td class="num">${esc(num(a.atc, 0))}</td>
      <td class="num">${esc(num(a.checkout, 0))}</td>
      <td class="num">${esc(num(a.purchases, 0))}</td>
      <td class="num">${esc(money(a.cpa, currency))}</td>
      <td class="num">${esc(roas(a.roas))}</td>
      <td><span class="tag ${diagClass(a.diagnosis)}">${esc(
        a.diagnosis || "—"
      )}</span></td>
      <td>${esc(a.confidence || "—")}</td>
    </tr>`
    )
    .join("\n");

  const funnels = (audit.funnels || [])
    .slice(0, 20)
    .map((f) => funnelHtml(f, currency))
    .join("\n");

  const creatives = (audit.creative_groups || [])
    .map((g) => {
      const thumb = g.thumbnail_url
        ? `<img src="${esc(g.thumbnail_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : `<div class="no-thumb">No preview URL</div>`;
      const ads = (g.ads || [])
        .map(
          (a) =>
            `<li>${esc(a.ad_name || a.ad_id)} <span class="id">${esc(
              a.ad_id
            )}</span></li>`
        )
        .join("");
      return `<article class="creative">
        <div class="thumb">${thumb}</div>
        <div class="meta">
          <div class="id">Creative ${esc(g.creative_id || "unknown")}</div>
          <div><strong>Format:</strong> ${esc(g.format || "—")}</div>
          <div><strong>Primary text:</strong> ${esc(g.primary_text || "—")}</div>
          <div><strong>Headline:</strong> ${esc(g.headline || "—")}</div>
          <div><strong>CTA:</strong> ${esc(g.cta || "—")}</div>
          <div><strong>Destination:</strong> ${esc(g.destination || "—")}</div>
          <div><strong>Spend:</strong> ${esc(money(g.spend, currency))} ·
            <strong>Purchases:</strong> ${esc(num(g.purchases, 0))} ·
            <strong>CPA:</strong> ${esc(money(g.cpa, currency))} ·
            <strong>ROAS:</strong> ${esc(roas(g.roas))}</div>
          <div><strong>Video plays / thruplays:</strong> ${esc(
            num(g.video_plays, 0)
          )} / ${esc(num(g.thruplays, 0))}</div>
          <div><strong>Ads using it:</strong><ul>${ads}</ul></div>
        </div>
      </article>`;
    })
    .join("\n");

  const audiences = (audit.audiences || [])
    .map((a) => {
      const p = a.performance || {};
      return `<tr>
        <td><div>${esc(a.name || "—")}</div><div class="id">ID ${esc(
          a.adset_id
        )}</div></td>
        <td>${esc(a.status || "—")}</td>
        <td>${esc(a.beginner_summary || "—")}</td>
        <td class="num">${esc(money(p.spend, currency))}</td>
        <td class="num">${esc(num(p.purchases, 0))}</td>
        <td class="num">${esc(money(p.cpa, currency))}</td>
        <td class="num">${esc(roas(p.roas))}</td>
        <td class="num">${esc(pct(p.ctr))}</td>
      </tr>`;
    })
    .join("\n");

  const p = audit.periods || {};
  const trailingRows = ["7", "14", "30"]
    .map((d) => {
      const w = p.trailing?.[d];
      const t = w?.totals || {};
      return `<tr>
        <td>Last ${esc(d)} days (overlapping)</td>
        <td>${esc(w?.since)} → ${esc(w?.until)}</td>
        <td class="num">${esc(money(t.spend, currency))}</td>
        <td class="num">${esc(num(t.purchases, 0))}</td>
        <td class="num">${esc(money(t.cpa, currency))}</td>
        <td class="num">${esc(roas(t.roas))}</td>
        <td class="num">${esc(pct(t.ctr))}</td>
      </tr>`;
    })
    .join("\n");

  const indepRows = ["recent_7d", "previous_7d", "prior_16d"]
    .map((key) => {
      const w = p.independent?.[key];
      const t = w?.totals || {};
      return `<tr>
        <td>${esc(key)} (independent)</td>
        <td>${esc(w?.since)} → ${esc(w?.until)}</td>
        <td class="num">${esc(money(t.spend, currency))}</td>
        <td class="num">${esc(num(t.purchases, 0))}</td>
        <td class="num">${esc(money(t.cpa, currency))}</td>
        <td class="num">${esc(roas(t.roas))}</td>
        <td class="num">${esc(pct(t.ctr))}</td>
      </tr>`;
    })
    .join("\n");

  const dq = audit.data_quality || {};
  const dqItems = [];
  if (dq.unavailable_insight_fields?.length) {
    dqItems.push(
      `<li>Unavailable / fallback insight fields: ${esc(
        JSON.stringify(dq.unavailable_insight_fields).slice(0, 500)
      )}</li>`
    );
  }
  if (dq.missing_destination_urls?.length) {
    dqItems.push(
      `<li>Missing destination URLs: ${esc(
        String(dq.missing_destination_urls.length)
      )} ads</li>`
    );
  }
  if (dq.duplicate_ad_names?.length) {
    dqItems.push(
      `<li>Duplicate ad names: ${esc(
        dq.duplicate_ad_names
          .map((d) => `${d.name} (${d.count})`)
          .join("; ")
      )}</li>`
    );
  }
  if (dq.pagination?.some((x) => x.truncated)) {
    dqItems.push(`<li>Pagination truncated on at least one request</li>`);
  }
  if (dq.errors?.length) {
    dqItems.push(
      `<li>API errors: ${esc(
        dq.errors.map((e) => e.message).join(" | ").slice(0, 800)
      )}</li>`
    );
  }
  if (dq.permission_limitations?.length) {
    dqItems.push(
      `<li>Permission limitations: ${esc(
        JSON.stringify(dq.permission_limitations)
      )}</li>`
    );
  }
  if (!dqItems.length) {
    dqItems.push(`<li>No major data-quality blockers recorded.</li>`);
  }
  dqItems.push(
    `<li>Mutations: ${dq.mutations ? "YES (unexpected)" : "none — read-only audit"}</li>`
  );

  const counts = audit.structure?.counts || {};

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WEAR ACTIVE — META ADS AUDIT</title>
<style>
  :root {
    --ink: #1a1c1a;
    --muted: #5c635c;
    --line: #d7dcd7;
    --bg: #f3f6f2;
    --panel: #ffffff;
    --ok: #1f6b3a;
    --ok-bg: #e6f4ea;
    --warn: #8a4b00;
    --warn-bg: #fff1de;
    --accent: #0e4d45;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "IBM Plex Sans", "Source Sans 3", "Segoe UI", sans-serif;
    color: var(--ink);
    background:
      radial-gradient(1200px 500px at 10% -10%, #dceee8 0%, transparent 55%),
      radial-gradient(900px 400px at 100% 0%, #e8ecdf 0%, transparent 50%),
      var(--bg);
    line-height: 1.45;
  }
  header.hero {
    padding: 2rem 1.5rem 1.25rem;
    border-bottom: 1px solid var(--line);
  }
  header.hero h1 {
    margin: 0 0 0.35rem;
    font-family: "Fraunces", "Iowan Old Style", Georgia, serif;
    font-weight: 600;
    font-size: clamp(1.6rem, 3vw, 2.2rem);
    letter-spacing: -0.02em;
    color: var(--accent);
  }
  header.hero .sub { color: var(--muted); max-width: 52rem; }
  main { padding: 1.25rem 1.5rem 3rem; max-width: 1400px; margin: 0 auto; }
  .kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.75rem;
    margin: 1rem 0 1.5rem;
  }
  .kpi {
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 0.85rem 0.9rem;
  }
  .kpi .k { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .kpi .v { font-size: 1.15rem; font-weight: 600; margin-top: 0.2rem; }
  h2 {
    font-family: "Fraunces", Georgia, serif;
    font-size: 1.35rem;
    margin: 2rem 0 0.75rem;
    color: var(--accent);
  }
  h3 { margin: 0 0 0.5rem; font-size: 1rem; }
  .note {
    background: #eef5f3;
    border-left: 3px solid var(--accent);
    padding: 0.75rem 1rem;
    margin: 0.75rem 0 1.25rem;
    color: var(--muted);
    font-size: 0.92rem;
  }
  .grid-3 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 1rem;
  }
  .block {
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 1rem;
  }
  .brief { list-style: none; padding: 0; margin: 0; }
  .brief li {
    padding: 0.55rem 0;
    border-bottom: 1px solid var(--line);
    display: grid;
    gap: 0.15rem;
    font-size: 0.9rem;
  }
  .brief li:last-child { border-bottom: 0; }
  .id { color: var(--muted); font-size: 0.78rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tag {
    display: inline-block;
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 0.15rem 0.4rem;
    border: 1px solid var(--line);
  }
  .tag.ok { background: var(--ok-bg); color: var(--ok); border-color: #b7dfc4; }
  .tag.warn { background: var(--warn-bg); color: var(--warn); border-color: #f0d2a6; }
  .tag.muted { background: #f0f0f0; color: var(--muted); }
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); background: var(--panel); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 0.55rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; }
  th { background: #eef2ee; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); position: sticky; top: 0; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .adname { font-weight: 600; }
  .funnels { display: grid; gap: 1rem; }
  .funnel { background: var(--panel); border: 1px solid var(--line); padding: 1rem; }
  .funnel header { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: baseline; margin-bottom: 0.75rem; }
  .funnel h4 { margin: 0; }
  .stages { max-width: 28rem; }
  .stage { display: flex; justify-content: space-between; padding: 0.35rem 0.5rem; background: #f7faf7; border: 1px solid var(--line); }
  .arrow { color: var(--muted); font-size: 0.8rem; padding: 0.2rem 0.5rem; }
  .conv { font-variant-numeric: tabular-nums; }
  .explain { margin: 0.75rem 0 0; font-size: 0.95rem; }
  .explain.muted, .muted, .empty { color: var(--muted); }
  .creatives { display: grid; gap: 1rem; }
  .creative { display: grid; grid-template-columns: 140px 1fr; gap: 1rem; background: var(--panel); border: 1px solid var(--line); padding: 1rem; }
  .thumb img { width: 140px; height: 140px; object-fit: cover; background: #ddd; }
  .no-thumb { width: 140px; height: 140px; display: grid; place-items: center; background: #ecefec; color: var(--muted); font-size: 0.8rem; text-align: center; padding: 0.5rem; }
  .creative ul { margin: 0.25rem 0 0; padding-left: 1.1rem; }
  @media (max-width: 700px) {
    .creative { grid-template-columns: 1fr; }
  }
</style>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=IBM+Plex+Sans:wght@400;600&display=swap" rel="stylesheet" />
</head>
<body>
  <header class="hero">
    <h1>WEAR ACTIVE — META ADS AUDIT</h1>
    <p class="sub">
      Read-only evidence layer for ${esc(audit.account?.name || "Wear Active")}
      (${esc(audit.account?.id || "")}).
      Window ${esc(since)} → ${esc(until)}.
      Generated ${esc(audit.generated_at)}.
    </p>
  </header>
  <main>
    <div class="note">
      Meta purchases / ROAS / CPA below are <strong>Meta-reported attribution</strong>.
      They are not Books profit and must not be compared directly to Books break-even CPA for affordability.
      No ads were created, edited, paused, or budget-changed by this audit.
    </div>

    <div class="kpis">${kpi}</div>

    <p class="muted">
      Structure: ${esc(String(counts.active_campaigns || 0))} active campaigns ·
      ${esc(String(counts.active_adsets || 0))} active ad sets ·
      ${esc(String(counts.active_ads || 0))} active ads
      (of ${esc(String(counts.campaigns || 0))} / ${esc(String(counts.adsets || 0))} / ${esc(String(counts.ads || 0))} total).
    </p>

    <h2>At a glance</h2>
    <div class="grid-3">
      ${listBrief("What is working", h.what_is_working, currency)}
      ${listBrief("What needs attention", h.what_needs_attention, currency)}
      ${listBrief("What does not have enough data", h.what_does_not_have_enough_data, currency)}
    </div>

    <h2>Exact ad table</h2>
    <p class="muted">Duplicate names stay separate — use Ad ID. All figures are Meta-reported for this window.</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ad</th><th>Campaign</th><th>Ad Set</th><th>Status</th>
            <th>Spend</th><th>Impressions</th><th>CTR</th><th>CPC</th>
            <th>LPV</th><th>ATC</th><th>Checkout</th><th>Purchases</th>
            <th>CPA</th><th>ROAS</th><th>Diagnosis</th><th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          ${adRows || `<tr><td colspan="16">No ads found.</td></tr>`}
        </tbody>
      </table>
    </div>

    <h2>Funnel view</h2>
    <p class="muted">Conversion % between stages. Plain-English notes only when volume supports them.</p>
    <div class="funnels">${funnels || `<p class="empty">No funnel rows.</p>`}</div>

    <h2>Creative analysis</h2>
    <p class="muted">Grouped by creative ID where available. Thumbnails only when Meta returns a usable URL. No AI interpretation yet.</p>
    <div class="creatives">${creatives || `<p class="empty">No creative groups.</p>`}</div>

    <h2>Audience / targeting setups</h2>
    <p class="muted">Answers “which audience setups are currently being tested?” — not causal proof.</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Ad set</th><th>Status</th><th>Targeting (readable)</th>
            <th>Spend</th><th>Purchases</th><th>CPA</th><th>ROAS</th><th>CTR</th>
          </tr>
        </thead>
        <tbody>${audiences || `<tr><td colspan="8">No ad sets.</td></tr>`}</tbody>
      </table>
    </div>

    <h2>Time comparison</h2>
    <p class="note">${esc(p.trailing_note || "Trailing 7/14/30 overlap — contextual only.")}
    Improving / stable / declining flags use independent non-overlapping windows only.</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Window</th><th>Dates</th><th>Spend</th><th>Purchases</th><th>CPA</th><th>ROAS</th><th>CTR</th>
          </tr>
        </thead>
        <tbody>
          ${trailingRows}
          ${indepRows}
        </tbody>
      </table>
    </div>

    <h2>Data quality</h2>
    <ul>${dqItems.join("\n")}</ul>

    <h2>Formats & placements observed</h2>
    <p><strong>Creative formats:</strong> ${esc((audit.creative_formats_running || []).join(", ") || "—")}</p>
    <p><strong>Placements:</strong> ${esc((audit.placements_observed || []).join(" | ") || "—")}</p>
  </main>
</body>
</html>`;
}

module.exports = {
  renderAdsAuditHtml,
  esc,
};
