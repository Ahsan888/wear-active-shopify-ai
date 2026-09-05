/**
 * Owner-facing email curation (presentation only).
 * Does not alter Phase 3 classifiers or dashboard alert JSON.
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

const STATUS_ESCALATION = {
  watch: 1,
  spend_no_purchase: 2,
  high_priority_spend_no_purchase: 3,
  relatively_weak_cpa: 1,
  high_cpa: 2,
};

const DEFAULT_OWNER_POLICY = {
  high_reminder_every: 3,
  medium_reminder_every: 7,
  max_medium: 3,
  max_actions: 3,
  money_worsen_pct: 20,
  margin_worsen_pp: 3,
};

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function prettyLabel(value) {
  if (value == null || value === "") return "—";
  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function indexById(alerts) {
  const map = new Map();
  for (const a of alerts || []) {
    if (a?.id) map.set(a.id, a);
  }
  return map;
}

function consecutiveActiveRuns(alertId, historySnapshots, currentSnapshot, loadAlertsFn) {
  // Count comparable prior snapshots (same period.days) where alert id was active,
  // ending at current. Used for reminder cadence.
  const days = Number(currentSnapshot.period?.days);
  const priors = (historySnapshots || [])
    .filter(
      (s) =>
        Number(s.period?.days) === days &&
        s.reporting_date < currentSnapshot.reporting_date
    )
    .sort((a, b) => a.reporting_date.localeCompare(b.reporting_date));

  let runs = 1; // current is active
  for (let i = priors.length - 1; i >= 0; i -= 1) {
    const alerts = loadAlertsFn
      ? loadAlertsFn(priors[i].reporting_date, days)
      : [];
    const hit = (alerts || []).some(
      (a) => a.id === alertId && a.status === "active"
    );
    if (hit) runs += 1;
    else break;
  }
  return runs;
}

function isMateriallyWorse(alert, previousAlert, policy) {
  if (!previousAlert) return false;

  const cur = num(alert.current_value);
  const prev = num(previousAlert.current_value);
  const id = String(alert.id || "");

  // Margin-style (pct points) — ids that are margins
  if (
    id.includes("margin") &&
    cur != null &&
    prev != null &&
    cur < prev - policy.margin_worsen_pp
  ) {
    return true;
  }

  // Contribution / profit monetary worsening (more negative or lower)
  if (
    (id.includes("negative_contribution") ||
      id.includes("unprofitable") ||
      id.includes("margin_drop")) &&
    cur != null &&
    prev != null
  ) {
    // Worse if current is lower (more loss / less profit)
    if (cur < prev) {
      const base = Math.abs(prev) || Math.abs(cur) || 1;
      const dropPct = ((prev - cur) / base) * 100;
      if (dropPct >= policy.money_worsen_pct) return true;
    }
  }

  // Spend spike / CPA — higher is worse
  if (
    (id.includes("spend_spike") || id.includes("cpa_deterioration")) &&
    cur != null &&
    prev != null &&
    prev > 0 &&
    cur > prev * (1 + policy.money_worsen_pct / 100)
  ) {
    return true;
  }

  // Severity escalation
  const sevRank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
  if (
    (sevRank[alert.severity] || 0) > (sevRank[previousAlert.severity] || 0)
  ) {
    return true;
  }

  // Entity status escalation from evidence
  const curStatus = alert.evidence?.status;
  const prevStatus = previousAlert.evidence?.status;
  if (
    curStatus &&
    prevStatus &&
    (STATUS_ESCALATION[curStatus] || 0) > (STATUS_ESCALATION[prevStatus] || 0)
  ) {
    return true;
  }

  return false;
}

function ownerMessage(alert, notificationState) {
  if (alert.id === "shopify:negative_contribution") {
    if (notificationState === "reminder") {
      return "Shopify contribution remains negative across recent comparable daily snapshots.";
    }
    if (notificationState === "worsened") {
      return "Shopify contribution after date-aligned Meta spend worsened vs the previous comparable snapshot.";
    }
    return "Shopify contribution after date-aligned Meta spend is negative.";
  }
  if (alert.id?.includes("high_cpa")) {
    return "One ad has materially high CPA.";
  }
  if (alert.id?.includes("high_priority_spend_no_purchase")) {
    return "One ad has high spend with no Meta-attributed purchase.";
  }
  if (alert.category === "product") {
    return alert.message;
  }
  if (alert.id === "sales:non_shopify_concentration") {
    return alert.message;
  }
  return alert.message || alert.title;
}

/**
 * Classify owner notification state for a single active alert.
 */
function classifyOwnerNotification(alert, previousAlert, runsActive, policy) {
  const lifecycle = alert.lifecycle || "new";
  const severity = alert.severity || "low";

  if (severity === "low" || severity === "info") {
    return "suppressed";
  }

  if (lifecycle === "new" || !previousAlert) {
    return "new";
  }

  if (isMateriallyWorse(alert, previousAlert, policy)) {
    return "worsened";
  }

  if (severity === "critical") {
    return "reminder"; // always show while active
  }

  if (severity === "high") {
    const every = policy.high_reminder_every;
    if (runsActive > 1 && runsActive % every === 0) return "reminder";
    return "suppressed";
  }

  if (severity === "medium") {
    const every = policy.medium_reminder_every;
    if (lifecycle === "new") return "new";
    if (runsActive > 1 && runsActive % every === 0) return "reminder";
    // new already handled; worsened handled above
    return "suppressed";
  }

  return "suppressed";
}

function groupKey(alert) {
  if (alert.category === "ads" && String(alert.id || "").includes("funnel")) {
    return "funnel_warnings";
  }
  if (alert.category === "product") return "product_data";
  return null;
}

function groupLabel(key, count) {
  if (key === "funnel_warnings") {
    return `${count} ad${count === 1 ? "" : "s"} ${
      count === 1 ? "has" : "have"
    } lower-priority funnel warning${count === 1 ? "" : "s"}.`;
  }
  if (key === "product_data") {
    return `${count} product/SKU data issue${
      count === 1 ? "" : "s"
    } require${count === 1 ? "s" : ""} review.`;
  }
  return `${count} related items.`;
}

/**
 * Build curated owner delivery alerts from full dashboard alerts.
 */
function selectOwnerDeliveryAlerts({
  alerts = [],
  previousAlerts = [],
  snapshot,
  history = [],
  loadAlertsFn = null,
  policy = DEFAULT_OWNER_POLICY,
} = {}) {
  const prevMap = indexById(previousAlerts);
  const active = (alerts || []).filter((a) => a.status === "active");
  const resolved = (alerts || []).filter((a) => a.lifecycle === "resolved");

  const annotated = [];
  for (const a of active) {
    const prev = prevMap.get(a.id);
    const runs = consecutiveActiveRuns(
      a.id,
      history,
      snapshot,
      loadAlertsFn
    );
    const notification_state = classifyOwnerNotification(
      a,
      prev,
      runs,
      policy
    );
    annotated.push({
      ...a,
      notification_state,
      owner_message: ownerMessage(a, notification_state),
      consecutive_active_runs: runs,
    });
  }

  // Group low funnel / product for count messaging (always dashboard-complete)
  const funnelLow = annotated.filter(
    (a) => groupKey(a) === "funnel_warnings"
  );
  const productIssues = annotated.filter((a) => groupKey(a) === "product_data");

  const showable = annotated.filter((a) => {
    if (a.severity === "low" || a.severity === "info") return false;
    if (groupKey(a) === "funnel_warnings") return false; // always grouped
    if (a.notification_state === "suppressed") return false;
    return true;
  });

  // Prefer new/worsened/reminder; cap medium
  const criticalHigh = showable.filter(
    (a) => a.severity === "critical" || a.severity === "high"
  );
  let medium = showable
    .filter((a) => a.severity === "medium")
    .sort((a, b) => {
      const rank = { new: 0, worsened: 1, reminder: 2 };
      return (
        (rank[a.notification_state] ?? 9) - (rank[b.notification_state] ?? 9)
      );
    })
    .slice(0, policy.max_medium);

  // Product data: if showable includes individual product alert, keep one
  // If product was suppressed as ongoing, still allow one grouped line when new/worsened/reminder
  const productShow = annotated.find(
    (a) =>
      groupKey(a) === "product_data" &&
      a.notification_state !== "suppressed"
  );
  const grouped_alerts = [];
  if (productShow) {
    grouped_alerts.push({
      id: "group:product_data",
      severity: "medium",
      notification_state: productShow.notification_state,
      title: "Product data issues",
      message: groupLabel("product_data", productIssues.length || 1),
    });
    // Remove individual product from medium if present
    medium = medium.filter((a) => groupKey(a) !== "product_data");
  }

  // Funnel warnings never individual — count only in lower-priority bucket
  const owner_alerts = [
    ...criticalHigh.map((a) => ({
      id: a.id,
      severity: a.severity,
      notification_state: a.notification_state,
      title: a.title,
      message: a.owner_message,
      lifecycle: a.lifecycle,
    })),
    ...medium
      .filter((a) => groupKey(a) !== "product_data")
      .map((a) => ({
        id: a.id,
        severity: a.severity,
        notification_state: a.notification_state,
        title: a.title,
        message: a.owner_message,
        lifecycle: a.lifecycle,
      })),
    ...grouped_alerts,
  ];

  const listedIds = new Set(owner_alerts.map((a) => a.id));
  const suppressed = annotated.filter((a) => {
    if (a.severity === "low" || a.severity === "info") return true;
    if (groupKey(a) === "funnel_warnings") return true;
    if (listedIds.has(a.id)) return false;
    if (groupKey(a) === "product_data" && listedIds.has("group:product_data"))
      return true;
    return a.notification_state === "suppressed" || !listedIds.has(a.id);
  });

  const lowerPriorityCount =
    annotated.filter((a) => a.severity === "low" || a.severity === "info")
      .length +
    (funnelLow.length ? funnelLow.length : 0);

  // Avoid double-counting funnel if already in low
  const uniqueLower = new Set(
    annotated
      .filter(
        (a) =>
          a.severity === "low" ||
          a.severity === "info" ||
          groupKey(a) === "funnel_warnings"
      )
      .map((a) => a.id)
  );

  return {
    owner_alerts,
    suppressed_alert_count: suppressed.length,
    lower_priority_count: uniqueLower.size,
    grouped_alerts,
    resolved_count: resolved.length,
    annotated,
  };
}

function buildTopActions(bundle, ownerAlerts, max = 3) {
  const out = [];
  const seen = new Set();
  const pushUnique = (text) => {
    const key = String(text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    out.push(text);
    return true;
  };

  // Prefer actions tied to visible owner alerts first
  for (const a of ownerAlerts || []) {
    if (a.id?.includes("high_cpa") || a.id?.includes("spend_no_purchase")) {
      pushUnique("Review the high-CPA ad.");
    }
    if (a.id === "shopify:negative_contribution") {
      pushUnique("Investigate Shopify conversion economics.");
    }
    if (a.id === "products:data_issues" || a.id === "group:product_data") {
      pushUnique("Fix missing product cost/COGS data.");
    }
    if (a.id === "sales:non_shopify_concentration") {
      pushUnique("Interpret whole-business metrics with Other Sales concentration in mind.");
    }
    if (out.length >= max) return out.slice(0, max);
  }

  const recs = (bundle?.recommendations || [])
    .filter((r) => ["critical", "high", "medium", "low"].includes(r.priority))
    .sort(
      (a, b) =>
        (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99)
    );

  for (const r of recs) {
    let text = r.action || r.reason || "Review";
    if (
      String(r.reason_code || "").includes("high_cpa") ||
      /high_cpa/i.test(r.reason || "")
    ) {
      text = "Review the high-CPA ad.";
    } else if (
      /contribution|shopify/i.test(r.reason || "") ||
      /shopify/i.test(r.area || "")
    ) {
      text = "Investigate Shopify conversion economics.";
    } else if (
      /cogs|sku|cost|data_issue|missing/i.test(r.reason || "") ||
      r.reason_code?.includes("cogs")
    ) {
      text = "Fix missing product cost/COGS data.";
    } else if (/funnel/i.test(r.reason || "") || /funnel/i.test(r.reason_code || "")) {
      continue; // dashboard-only; keep email actions calm
    } else if (r.entity_name && r.reason) {
      text = `${r.reason}`.slice(0, 120);
    }
    pushUnique(text);
    if (out.length >= max) break;
  }

  return out.slice(0, max);
}

function buildOwnerEmailContent({
  snapshot,
  brief,
  alertsResult,
  previousAlerts,
  history,
  loadAlertsFn,
  bundle,
  dashboard_path,
  days,
  policy = DEFAULT_OWNER_POLICY,
  attribution = null,
}) {
  const reporting_date = snapshot.reporting_date;
  const curated = selectOwnerDeliveryAlerts({
    alerts: alertsResult?.alerts || [],
    previousAlerts,
    snapshot,
    history,
    loadAlertsFn,
    policy,
  });

  const top_actions = buildTopActions(
    bundle,
    curated.owner_alerts,
    policy.max_actions
  );

  const needAttention = curated.owner_alerts.filter(
    (a) => a.severity === "critical" || a.severity === "high"
  ).length;

  let subject = `Wear Active Daily — ${formatDisplayDate(reporting_date)}`;
  if (needAttention > 0) {
    subject += ` · ${needAttention} need attention`;
  }

  const high = curated.owner_alerts.filter(
    (a) => a.severity === "critical" || a.severity === "high"
  );
  const medium = curated.owner_alerts.filter((a) => a.severity === "medium");

  const textLines = [
    "WEAR ACTIVE DAILY",
    `${formatDisplayDate(reporting_date)} · trailing ${days} days`,
    "",
    "BUSINESS",
    prettyLabel(snapshot.business?.health_status),
    `Net revenue            ${formatMoney(snapshot.business?.net_revenue_ex_tax, CURRENCY)}`,
    `Adjusted profit         ${formatMoney(snapshot.business?.meta_adjusted_profit, CURRENCY)}`,
    `Adjusted margin              ${formatPct(snapshot.business?.meta_adjusted_margin_pct)}`,
    `Orders                        ${formatNumber(snapshot.business?.recognized_orders, 0)}`,
    "",
    "SHOPIFY",
    `Orders                         ${formatNumber(snapshot.shopify?.orders, 0)}`,
    `Net revenue             ${formatMoney(snapshot.shopify?.net_revenue, CURRENCY)}`,
    `GP before Meta          ${formatMoney(snapshot.shopify?.gross_profit_before_ads, CURRENCY)}`,
    `Contribution           ${formatMoney(snapshot.shopify?.contribution_after_meta, CURRENCY)}`,
    "",
    "META",
    `Spend                   ${formatMoney(snapshot.meta?.spend, CURRENCY)}`,
    `Purchases                      ${formatNumber(snapshot.meta?.purchases, 0)}`,
    `CPA                      ${formatMoney(snapshot.meta?.cpa, CURRENCY)}`,
    `ROAS                        ${formatRoas(snapshot.meta?.roas)}`,
    "",
    "NEEDS ATTENTION",
  ];

  if (high.length) {
    textLines.push("HIGH");
    for (const a of high) textLines.push(`• ${a.message}`);
  }
  if (medium.length) {
    textLines.push("MEDIUM");
    for (const a of medium) textLines.push(`• ${a.message}`);
  }
  if (!high.length && !medium.length) {
    textLines.push("No high-priority items today.");
  }
  if (curated.lower_priority_count > 0) {
    textLines.push("Lower priority");
    const n = curated.lower_priority_count;
    textLines.push(
      `${n} additional observation${n === 1 ? "" : "s"} ${
        n === 1 ? "is" : "are"
      } available in the dashboard.`
    );
  }
  if (curated.resolved_count > 0) {
    textLines.push(
      `${curated.resolved_count} issue${
        curated.resolved_count === 1 ? "" : "s"
      } resolved since the previous comparable report.`
    );
  }

  textLines.push("");
  textLines.push("TODAY'S ACTIONS");
  if (!top_actions.length) {
    textLines.push("No prioritized actions.");
  } else {
    top_actions.forEach((t, i) => textLines.push(`${i + 1}. ${t}`));
  }
  if (
    attribution &&
    attribution.attribution_coverage_pct != null &&
    !attribution.error
  ) {
    const cov = attribution.attribution_coverage_pct;
    textLines.push("");
    textLines.push(
      cov < 60
        ? `Attribution coverage still building: ${cov}%`
        : `Attribution coverage: ${cov}% of Shopify orders`
    );
  }
  textLines.push("");
  textLines.push(`Dashboard: ${dashboard_path || "reports/dashboard/index.html"}`);

  const text = textLines.join("\n");
  let attributionLine = null;
  if (
    attribution &&
    attribution.attribution_coverage_pct != null &&
    !attribution.error
  ) {
    const cov = attribution.attribution_coverage_pct;
    attributionLine =
      cov < 60
        ? `Attribution coverage still building: ${cov}%`
        : `Attribution coverage: ${cov}% of Shopify orders`;
  }

  const html = buildOwnerEmailHtml({
    reporting_date,
    days,
    snapshot,
    high,
    medium,
    lower_priority_count: curated.lower_priority_count,
    resolved_count: curated.resolved_count,
    top_actions,
    dashboard_path,
    attributionLine,
  });

  return {
    subject,
    text,
    html,
    html_summary: html,
    owner_alerts: curated.owner_alerts,
    suppressed_alert_count: curated.suppressed_alert_count,
    lower_priority_count: curated.lower_priority_count,
    grouped_alerts: curated.grouped_alerts,
    top_actions,
    dashboard_path: dashboard_path || null,
    reporting_date,
    days: Number(days),
  };
}

function metricRow(label, value) {
  return `<tr>
  <td style="padding:4px 12px 4px 0;color:#5c655e;font-size:13px;">${escapeHtml(label)}</td>
  <td style="padding:4px 0;text-align:right;font-size:13px;font-weight:600;color:#1a1f1c;">${value}</td>
</tr>`;
}

function buildOwnerEmailHtml({
  reporting_date,
  days,
  snapshot,
  high,
  medium,
  lower_priority_count,
  resolved_count,
  top_actions,
  dashboard_path,
  attributionLine = null,
}) {
  const health = prettyLabel(snapshot.business?.health_status);
  const alertBlock = (title, items) => {
    if (!items.length) return "";
    const lis = items
      .map(
        (a) =>
          `<li style="margin:0 0 6px;font-size:13px;line-height:1.4;color:#1a1f1c;">${escapeHtml(a.message)}</li>`
      )
      .join("");
    return `<p style="margin:14px 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#0f6b5c;font-weight:700;">${escapeHtml(title)}</p>
<ul style="margin:0;padding-left:18px;">${lis}</ul>`;
  };

  const actions = top_actions.length
    ? `<ol style="margin:0;padding-left:18px;">${top_actions
        .map(
          (t) =>
            `<li style="margin:0 0 6px;font-size:13px;color:#1a1f1c;">${escapeHtml(t)}</li>`
        )
        .join("")}</ol>`
    : `<p style="font-size:13px;color:#5c655e;">No prioritized actions.</p>`;

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f1ea;font-family:Georgia,'Times New Roman',serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1ea;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fffcf7;border:1px solid #e4ddd0;border-radius:8px;">
<tr><td style="padding:28px 28px 8px;">
  <p style="margin:0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#0f6b5c;font-weight:700;">Wear Active Daily</p>
  <p style="margin:8px 0 0;font-size:20px;color:#1a1f1c;">${escapeHtml(formatDisplayDate(reporting_date))}</p>
  <p style="margin:4px 0 0;font-size:13px;color:#5c655e;">Trailing ${escapeHtml(String(days))} days · Asia/Karachi</p>
</td></tr>
<tr><td style="padding:8px 28px;"><hr style="border:none;border-top:1px solid #e4ddd0;margin:0;" /></td></tr>
<tr><td style="padding:8px 28px 4px;">
  <p style="margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5c655e;">Business</p>
  <p style="margin:0 0 10px;font-size:16px;font-weight:700;color:#0f6b5c;">${escapeHtml(health)}</p>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
    ${metricRow("Net revenue", escapeHtml(formatMoney(snapshot.business?.net_revenue_ex_tax, CURRENCY)))}
    ${metricRow("Adjusted profit", escapeHtml(formatMoney(snapshot.business?.meta_adjusted_profit, CURRENCY)))}
    ${metricRow("Adjusted margin", escapeHtml(formatPct(snapshot.business?.meta_adjusted_margin_pct)))}
    ${metricRow("Orders", escapeHtml(formatNumber(snapshot.business?.recognized_orders, 0)))}
  </table>
</td></tr>
<tr><td style="padding:16px 28px 4px;">
  <p style="margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5c655e;">Shopify</p>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
    ${metricRow("Orders", escapeHtml(formatNumber(snapshot.shopify?.orders, 0)))}
    ${metricRow("Net revenue", escapeHtml(formatMoney(snapshot.shopify?.net_revenue, CURRENCY)))}
    ${metricRow("GP before Meta", escapeHtml(formatMoney(snapshot.shopify?.gross_profit_before_ads, CURRENCY)))}
    ${metricRow("Contribution", escapeHtml(formatMoney(snapshot.shopify?.contribution_after_meta, CURRENCY)))}
  </table>
</td></tr>
<tr><td style="padding:16px 28px 4px;">
  <p style="margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5c655e;">Meta</p>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
    ${metricRow("Spend", escapeHtml(formatMoney(snapshot.meta?.spend, CURRENCY)))}
    ${metricRow("Purchases", escapeHtml(formatNumber(snapshot.meta?.purchases, 0)))}
    ${metricRow("CPA", escapeHtml(formatMoney(snapshot.meta?.cpa, CURRENCY)))}
    ${metricRow("ROAS", escapeHtml(formatRoas(snapshot.meta?.roas)))}
  </table>
</td></tr>
<tr><td style="padding:16px 28px 4px;">
  <p style="margin:0 0 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5c655e;">Needs Attention</p>
  ${alertBlock("High", high)}
  ${alertBlock("Medium", medium)}
  ${
    !high.length && !medium.length
      ? `<p style="font-size:13px;color:#5c655e;">No high-priority items today.</p>`
      : ""
  }
  ${
    lower_priority_count > 0
      ? `<p style="margin:12px 0 0;font-size:12px;color:#5c655e;">Lower priority — ${lower_priority_count} additional observation${
          lower_priority_count === 1 ? "" : "s"
        } ${lower_priority_count === 1 ? "is" : "are"} available in the dashboard.</p>`
      : ""
  }
  ${
    resolved_count > 0
      ? `<p style="margin:8px 0 0;font-size:12px;color:#5c655e;">${resolved_count} issue${
          resolved_count === 1 ? "" : "s"
        } resolved since the previous comparable report.</p>`
      : ""
  }
</td></tr>
<tr><td style="padding:16px 28px 4px;">
  <p style="margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5c655e;">Today's Actions</p>
  ${actions}
</td></tr>
<tr><td style="padding:20px 28px 28px;">
  ${
    attributionLine
      ? `<p style="margin:0 0 10px;font-size:12px;color:#5c655e;">${escapeHtml(attributionLine)}</p>`
      : ""
  }
  <p style="margin:0;font-size:12px;color:#5c655e;">Dashboard / report: <span style="color:#0f6b5c;">${escapeHtml(
    dashboard_path || "reports/dashboard/index.html"
  )}</span></p>
  <p style="margin:8px 0 0;font-size:11px;color:#8a918c;">Wear Active · internal daily report · not attributed to Meta</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = {
  DEFAULT_OWNER_POLICY,
  selectOwnerDeliveryAlerts,
  classifyOwnerNotification,
  isMateriallyWorse,
  buildTopActions,
  buildOwnerEmailContent,
  buildOwnerEmailHtml,
  consecutiveActiveRuns,
  groupKey,
};
