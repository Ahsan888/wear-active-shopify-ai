/**
 * Phase 4 deterministic daily brief (no LLM).
 */
const { round2 } = require("../books/tax");
const {
  formatMoney,
  formatPct,
  formatRoas,
  formatNumber,
} = require("../meta/metrics");
const { formatDisplayDate } = require("./dates");
const { PRIORITY_RANK } = require("../decisions/thresholds");

const CURRENCY = "PKR";

function prettyLabel(value) {
  if (value == null || value === "") return "—";
  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function line(label, value) {
  return { label, value };
}

function sectionLines(entries) {
  return entries.filter((e) => e.value != null && e.value !== "—");
}

function buildHeadline(snapshot) {
  return {
    business_health: snapshot.business?.health_status || null,
    adjusted_profit: snapshot.business?.meta_adjusted_profit,
    adjusted_margin: snapshot.business?.meta_adjusted_margin_pct,
    shopify_contribution: snapshot.shopify?.contribution_after_meta,
    meta_spend: snapshot.meta?.spend,
    meta_cpa: snapshot.meta?.cpa,
    meta_roas: snapshot.meta?.roas,
  };
}

function formatTrendDelta(metric, key) {
  if (!metric?.comparable) return null;
  const { delta, delta_pct, current, previous } = metric;

  if (key === "meta_spend" || key === "meta_cpa") {
    if (delta_pct == null) return null;
    const sign = delta_pct > 0 ? "+" : "";
    return `${sign}${formatPct(delta_pct, 1)}`;
  }

  if (
    key === "shopify_contribution_after_meta" ||
    key === "meta_adjusted_profit"
  ) {
    if (delta == null) return null;
    const verb = delta >= 0 ? "improved by" : "worsened by";
    return `${verb} ${formatMoney(Math.abs(delta), CURRENCY)}`;
  }

  if (key === "meta_roas") {
    if (delta == null) return null;
    const sign = delta > 0 ? "+" : "";
    return `${sign}${round2(delta)}x vs ${formatRoas(previous)}`;
  }

  if (key === "shopify_net_revenue" || key === "recognized_orders") {
    if (delta_pct == null && delta == null) return null;
    if (delta_pct != null) {
      const sign = delta_pct > 0 ? "+" : "";
      return `${sign}${formatPct(delta_pct, 1)}`;
    }
    const sign = delta > 0 ? "+" : "";
    return `${sign}${formatNumber(delta, 0)}`;
  }

  if (key === "meta_adjusted_margin_pct") {
    if (delta == null) return null;
    const sign = delta > 0 ? "+" : "";
    return `${sign}${round2(delta)} pp`;
  }

  if (delta_pct != null) {
    const sign = delta_pct > 0 ? "+" : "";
    return `${sign}${formatPct(delta_pct, 1)}`;
  }
  return delta != null ? String(delta) : null;
}

const TREND_LABELS = {
  meta_spend: "Meta spend",
  meta_cpa: "Meta CPA",
  meta_roas: "Meta ROAS",
  shopify_net_revenue: "Shopify net revenue",
  shopify_contribution_after_meta: "Shopify contribution",
  meta_adjusted_profit: "Adjusted profit",
  recognized_orders: "Recognized orders",
  meta_adjusted_margin_pct: "Adjusted margin",
};

function buildTrendSection(trends) {
  if (!trends?.metrics) {
    return [
      line(
        "Trend",
        trends?.note || "No comparable prior snapshot available."
      ),
    ];
  }

  const rows = [];
  for (const [key, metric] of Object.entries(trends.metrics)) {
    if (!metric.comparable) continue;
    const formatted = formatTrendDelta(metric, key);
    if (formatted == null) continue;
    rows.push(line(TREND_LABELS[key] || key, formatted));
  }

  if (!rows.length) {
    return [
      line(
        "Trend",
        trends.note || "No comparable prior snapshot available."
      ),
    ];
  }
  return rows;
}

function buildAttentionSection(alertsResult, config) {
  const active = (alertsResult?.alerts || []).filter(
    (a) => a.status === "active"
  );
  const bySeverity = {
    critical: active.filter((a) => a.severity === "critical"),
    high: active.filter((a) => a.severity === "high"),
    medium: active.filter((a) => a.severity === "medium"),
    low: active.filter((a) => a.severity === "low"),
    info: active.filter((a) => a.severity === "info"),
  };

  const maxMedium =
    config?.alerts?.max_medium_delivery_alerts != null
      ? config.alerts.max_medium_delivery_alerts
      : 5;

  const lines = [];
  for (const a of [...bySeverity.critical, ...bySeverity.high]) {
    lines.push(line(a.severity.toUpperCase(), `• ${a.message}`));
  }
  for (const a of bySeverity.medium.slice(0, maxMedium)) {
    lines.push(line("MEDIUM", `• ${a.message}`));
  }
  const extraMedium = Math.max(0, bySeverity.medium.length - maxMedium);
  if (extraMedium > 0) {
    lines.push(
      line(
        "MEDIUM",
        `• +${extraMedium} more medium-priority item${extraMedium === 1 ? "" : "s"} (see dashboard).`
      )
    );
  }
  if (bySeverity.low.length) {
    lines.push(
      line(
        "LOW",
        `• ${bySeverity.low.length} low-priority item${
          bySeverity.low.length === 1 ? "" : "s"
        } noted.`
      )
    );
  }
  if (!lines.length) {
    lines.push(line("Attention", "No active alerts."));
  }
  return lines;
}

function buildActionsSection(bundle) {
  // Prefer Phase 9 marketing queue (max 3) when present
  const mkt = bundle?.marketing_decisions;
  if (mkt && !mkt.error && Array.isArray(mkt.owner_action_queue)) {
    const {
      formatMarketingBriefActions,
    } = require("../marketing/build");
    const lines = formatMarketingBriefActions(mkt, 3);
    if (lines.length) {
      return lines.map((l) => line(String(l.rank), l.text));
    }
  }

  const recs = (bundle.recommendations || [])
    .filter((r) => ["critical", "high", "medium", "low"].includes(r.priority))
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99))
    .slice(0, 5);

  return recs.map((r, i) =>
    line(
      String(i + 1),
      r.entity_name
        ? `${r.reason} (${r.entity_name})`
        : r.reason || r.action || "Review"
    )
  );
}

function buildDataQualitySection(snapshot, bundle) {
  const conf = snapshot.confidence || bundle.confidence || {};
  return sectionLines([
    line("Attribution", prettyLabel(conf.attribution || "unavailable")),
    line(
      "Product data issues",
      snapshot.decisions?.product_data_issue_count ?? 0
    ),
    line(
      "Accounting reconciliation",
      prettyLabel(snapshot.accounting?.reconciliation_status || "—")
    ),
    line("Business confidence", prettyLabel(conf.business || "—")),
    line("Advertising confidence", prettyLabel(conf.advertising || "—")),
  ]);
}

function buildBusinessSection(snapshot) {
  const b = snapshot.business || {};
  return sectionLines([
    line("Health", prettyLabel(b.health_status)),
    line("Recognized net revenue", formatMoney(b.net_revenue_ex_tax, CURRENCY)),
    line("Meta-adjusted profit", formatMoney(b.meta_adjusted_profit, CURRENCY)),
    line("Adjusted margin", formatPct(b.meta_adjusted_margin_pct, 1)),
    line("Orders", formatNumber(b.recognized_orders, 0)),
  ]);
}

function buildShopifySection(snapshot) {
  const s = snapshot.shopify || {};
  return sectionLines([
    line("Orders", formatNumber(s.orders, 0)),
    line("Net revenue", formatMoney(s.net_revenue, CURRENCY)),
    line("GP before Meta", formatMoney(s.gross_profit_before_ads, CURRENCY)),
    line(
      "Contribution after Meta",
      formatMoney(s.contribution_after_meta, CURRENCY)
    ),
    line("Status", prettyLabel(s.contribution_status)),
  ]);
}

function buildMetaSection(snapshot) {
  const m = snapshot.meta || {};
  return sectionLines([
    line("Spend", formatMoney(m.spend, CURRENCY)),
    line("Attributed purchases", formatNumber(m.purchases, 0)),
    line("CPA", formatMoney(m.cpa, CURRENCY)),
    line("ROAS", formatRoas(m.roas)),
    line("CTR", formatPct(m.ctr, 1)),
  ]);
}

function appendSection(lines, title, rows) {
  lines.push(title);
  for (const row of rows) {
    if (/^\d+$/.test(row.label)) {
      lines.push(`${row.label}. ${row.value}`);
    } else {
      lines.push(`${row.label}: ${row.value}`);
    }
  }
  lines.push("");
}

/**
 * Build deterministic daily brief text + JSON.
 * @param {object} input
 */
function buildDailyBrief({
  bundle,
  snapshot,
  trends,
  alertsResult,
  dashboard_path,
  reporting_date,
  config = {},
} = {}) {
  if (!snapshot) throw new Error("buildDailyBrief requires snapshot");
  const rd = reporting_date || snapshot.reporting_date;
  const headline = buildHeadline(snapshot);

  const sections = {
    business: buildBusinessSection(snapshot),
    shopify: buildShopifySection(snapshot),
    meta: buildMetaSection(snapshot),
    trends: buildTrendSection(trends),
    attention: buildAttentionSection(alertsResult, config),
    actions: buildActionsSection(bundle || {}),
    data_quality: buildDataQualitySection(snapshot, bundle || {}),
  };

  const activeAlerts = (alertsResult?.alerts || []).filter(
    (a) => a.status === "active"
  );

  const json = {
    title: "WEAR ACTIVE — DAILY BRIEF",
    reporting_date: rd,
    period: snapshot.period,
    headline,
    sections,
    alerts: activeAlerts,
    dashboard_path: dashboard_path || null,
    attention_summary: alertsResult?.attention_summary || {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
      headline: "No urgent items need attention",
    },
  };

  const textLines = [];
  textLines.push(json.title);
  textLines.push(formatDisplayDate(rd));
  textLines.push(
    `Trailing ${snapshot.period?.days || "—"} days · ${snapshot.timezone || "Asia/Karachi"}`
  );
  if (snapshot.period?.current_day_incomplete) {
    textLines.push(
      "Note: Today's Meta and order activity may still be incomplete."
    );
  }
  textLines.push("");

  appendSection(textLines, "BUSINESS", sections.business);
  appendSection(textLines, "SHOPIFY", sections.shopify);
  appendSection(textLines, "META", sections.meta);

  textLines.push("WHAT NEEDS ATTENTION");
  let lastTier = null;
  for (const row of sections.attention) {
    if (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(row.label)) {
      if (row.label !== lastTier) {
        textLines.push(row.label);
        lastTier = row.label;
      }
      textLines.push(row.value);
    } else {
      textLines.push(`${row.label}: ${row.value}`);
      lastTier = null;
    }
  }
  textLines.push("");

  textLines.push("TOP ACTIONS");
  if (!sections.actions.length) {
    textLines.push("No prioritized actions.");
  } else {
    for (const row of sections.actions) {
      textLines.push(`${row.label}. ${row.value}`);
    }
  }
  textLines.push("");

  textLines.push("TREND VS PRIOR SNAPSHOT");
  if (!sections.trends.length) {
    textLines.push(trends?.note || "No comparable prior snapshot available.");
  } else {
    for (const row of sections.trends) {
      if (row.label === "Trend") {
        textLines.push(row.value);
      } else {
        textLines.push(`${row.label}: ${row.value}`);
      }
    }
  }
  textLines.push("");

  appendSection(textLines, "DATA QUALITY", sections.data_quality);

  return {
    text: textLines.join("\n").replace(/\n+$/, "\n"),
    json,
  };
}

module.exports = {
  buildDailyBrief,
  prettyLabel,
  buildHeadline,
  buildTrendSection,
  buildAttentionSection,
};
