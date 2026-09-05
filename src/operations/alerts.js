/**
 * Phase 4 deterministic alert evaluation.
 * Consumes Phase 3 statuses and snapshot history — does not alter classifiers.
 */
const { round2 } = require("../books/tax");
const {
  getPreviousSnapshot,
  sortHistory,
} = require("./history");

const ACCOUNTING_MEDIUM = new Set([
  "ledger_ads_missing",
  "recurring_ads_not_posted",
  "full_month_variance",
]);

const AD_STATUS_ALERTS = {
  high_priority_spend_no_purchase: { severity: "high", title: "High-priority spend, no purchase" },
  spend_no_purchase: { severity: "medium", title: "Spend with no purchase" },
  high_cpa: { severity: "high", title: "High CPA vs account" },
  relatively_weak_cpa: { severity: "medium", title: "Relatively weak CPA" },
};

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function indexPreviousAlerts(previousAlerts) {
  const map = new Map();
  for (const row of previousAlerts || []) {
    if (row?.id) map.set(row.id, row);
  }
  return map;
}

function baseAlert(partial, reportingDate) {
  return {
    entity_type: "account",
    entity_id: null,
    entity_name: null,
    first_seen: reportingDate,
    current_value: null,
    comparison_value: null,
    status: "active",
    lifecycle: "new",
    ...partial,
  };
}

function consecutiveNegativeShopifyRuns(history, snapshot) {
  const periodDays = Number(snapshot.period?.days);
  const key = snapshot.snapshot_key;
  // Include the current snapshot even when history has not been upserted yet.
  const rows = sortHistory([
    ...(history || []).filter(
      (s) =>
        Number(s.period?.days) === periodDays &&
        String(s.reporting_date) <= String(snapshot.reporting_date) &&
        s.snapshot_key !== key
    ),
    snapshot,
  ]);
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].shopify?.contribution_status === "negative_contribution") {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function buildAttentionSummary(activeAlerts) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const a of activeAlerts) {
    if (counts[a.severity] != null) counts[a.severity] += 1;
  }

  let headline = "No urgent items need attention";
  if (counts.critical > 0) {
    headline = `${counts.critical} critical item${
      counts.critical === 1 ? "" : "s"
    } need${counts.critical === 1 ? "s" : ""} immediate attention`;
  } else if (counts.high > 0) {
    headline = `${counts.high} high-priority item${
      counts.high === 1 ? "" : "s"
    } need${counts.high === 1 ? "s" : ""} attention`;
  } else if (counts.medium > 0) {
    headline = `${counts.medium} medium-priority item${
      counts.medium === 1 ? "" : "s"
    } to review`;
  }

  return { ...counts, headline };
}

function applyLifecycle(currentAlerts, previousAlerts, reportingDate) {
  const prevActive = (previousAlerts || []).filter(
    (a) => a.status === "active" || (!a.status && a.lifecycle !== "resolved")
  );
  const prevMap = indexPreviousAlerts(prevActive);
  const currentIds = new Set(currentAlerts.map((a) => a.id));

  const active = currentAlerts.map((a) => {
    const prev = prevMap.get(a.id);
    return {
      ...a,
      first_seen: prev?.first_seen || a.first_seen || reportingDate,
      lifecycle: prev ? "ongoing" : "new",
      status: "active",
    };
  });

  const resolved = prevActive
    .filter((p) => !currentIds.has(p.id))
    .map((p) => ({
      ...p,
      lifecycle: "resolved",
      status: "resolved",
    }));

  return [...active, ...resolved];
}

function evaluateBusinessAlerts(bundle, snapshot, previous, config) {
  const out = [];
  const reportingDate = snapshot.reporting_date;
  const health = snapshot.business?.health_status;
  const bh = bundle.business_health || {};

  if (health === "unprofitable") {
    const hasCriticalRec = (bundle.recommendations || []).some(
      (r) =>
        r.priority === "critical" && r.reason_code === "unprofitable_period"
    );
    out.push(
      baseAlert(
        {
          id: "business:unprofitable",
          category: "business_health",
          severity: hasCriticalRec ? "critical" : "high",
          title: "Business period unprofitable",
          message:
            bh.reason ||
            "Meta-adjusted profit is negative for the selected period.",
          evidence: bh.evidence || {
            meta_adjusted_profit: snapshot.business?.meta_adjusted_profit,
            meta_adjusted_margin_pct: snapshot.business?.meta_adjusted_margin_pct,
          },
          entity_type: "account",
          entity_name: "Business",
          current_value: snapshot.business?.meta_adjusted_profit,
        },
        reportingDate
      )
    );
  }

  const curMargin = num(snapshot.business?.meta_adjusted_margin_pct);
  const prevMargin = previous
    ? num(previous.business?.meta_adjusted_margin_pct)
    : null;
  if (
    previous &&
    curMargin != null &&
    prevMargin != null &&
    curMargin < prevMargin - config.alerts.margin_drop_pp
  ) {
    const dropPp = round2(prevMargin - curMargin);
    const severity =
      dropPp >= config.alerts.margin_drop_pp * 2 ? "high" : "medium";
    out.push(
      baseAlert(
        {
          id: "business:margin_drop",
          category: "business_health",
          severity,
          title: "Meta-adjusted margin declined",
          message: `Meta-adjusted margin fell ${dropPp} pp vs previous comparable snapshot (${prevMargin}% → ${curMargin}%).`,
          evidence: {
            current_margin_pct: curMargin,
            previous_margin_pct: prevMargin,
            drop_pp: dropPp,
            threshold_pp: config.alerts.margin_drop_pp,
            previous_reporting_date: previous.reporting_date,
          },
          entity_type: "account",
          entity_name: "Business",
          current_value: curMargin,
          comparison_value: prevMargin,
        },
        reportingDate
      )
    );
  }

  return out;
}

function evaluateShopifyAlerts(snapshot, history, config) {
  const out = [];
  const reportingDate = snapshot.reporting_date;
  const status = snapshot.shopify?.contribution_status;

  if (status !== "negative_contribution") return out;

  const runs = consecutiveNegativeShopifyRuns(history, snapshot);
  const persistent =
    runs >= Number(config.alerts.negative_shopify_persistence_runs);
  const contribution = num(snapshot.shopify?.contribution_after_meta);

  out.push(
    baseAlert(
      {
        id: "shopify:negative_contribution",
        category: "shopify",
        severity: persistent ? "high" : "medium",
        title: persistent
          ? "Shopify contribution persistently negative"
          : "Shopify contribution negative",
        message: persistent
          ? `Shopify contribution after date-aligned Meta spend is negative for ${runs} comparable snapshots in a row.`
          : "Shopify contribution after date-aligned Meta spend is negative.",
        evidence: {
          contribution_after_meta: contribution,
          contribution_status: status,
          consecutive_negative_runs: runs,
          persistence_threshold: config.alerts.negative_shopify_persistence_runs,
        },
        entity_type: "channel",
        entity_id: "shopify",
        entity_name: "Shopify",
        current_value: contribution,
      },
      reportingDate
    )
  );

  return out;
}

function evaluateMetaEntityAlerts(ads = []) {
  const out = [];
  const seen = new Set();

  for (const ad of ads) {
    const entityId = ad.entity_id || ad.ad_id || ad.id;
    if (!entityId) continue;
    const entityName = ad.entity_name || ad.name || String(entityId);

    for (const [statusKey, meta] of Object.entries(AD_STATUS_ALERTS)) {
      if (ad.status !== statusKey) continue;
      const id = `meta-ad:${entityId}:${statusKey}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(
        baseAlert(
          {
            id,
            category: "ads",
            severity: meta.severity,
            title: meta.title,
            message: ad.reason || `${entityName}: ${meta.title}.`,
            evidence: {
              status: ad.status,
              reason_code: ad.reason_code,
              spend: ad.spend,
              purchases: ad.purchases,
              meta_attributed_cpa: ad.meta_attributed_cpa,
              spend_vs_account_cpa: ad.spend_vs_account_cpa,
            },
            entity_type: "ad",
            entity_id: String(entityId),
            entity_name: entityName,
            current_value: ad.spend ?? ad.meta_attributed_cpa ?? null,
          },
          null
        )
      );
    }

    if (ad.primary_weak_funnel || ad.status === "weak_funnel") {
      const id = `meta-ad:${entityId}:weak_funnel`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(
          baseAlert(
            {
              id,
              category: "ads",
              severity: "medium",
              title: "Primary weak funnel",
              message:
                ad.reason ||
                `${entityName} shows a primary weak funnel vs account baselines.`,
              evidence: {
                status: ad.status,
                primary_weak_funnel: ad.primary_weak_funnel,
                funnel_diagnostics: ad.funnel_diagnostics,
              },
              entity_type: "ad",
              entity_id: String(entityId),
              entity_name: entityName,
            },
            null
          )
        );
      }
    } else if (ad.has_funnel_warning && ad.status !== "weak_funnel") {
      const id = `meta-ad:${entityId}:funnel_warning`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(
          baseAlert(
            {
              id,
              category: "ads",
              severity: "low",
              title: "Funnel warning",
              message: `${entityName} has a borderline funnel warning on at least one stage (status remains CPA-based).`,
              evidence: {
                has_funnel_warning: ad.has_funnel_warning,
                status: ad.status,
                funnel_diagnostics: ad.funnel_diagnostics,
              },
              entity_type: "ad",
              entity_id: String(entityId),
              entity_name: entityName,
            },
            null
          )
        );
      }
    }
  }

  return out;
}

function evaluateAccountingAlerts(snapshot) {
  const out = [];
  const reportingDate = snapshot.reporting_date;
  const status = snapshot.accounting?.reconciliation_status;
  if (!status) return out;

  if (status === "partial_period_not_comparable") {
    out.push(
      baseAlert(
        {
          id: `accounting:${status}`,
          category: "accounting",
          severity: "info",
          title: "Partial-period accounting not comparable",
          message:
            "Partial-period Meta spend is not directly comparable to monthly Ledger/Recurring Ads lumps.",
          evidence: {
            reconciliation_status: status,
            is_full_calendar_month: snapshot.accounting?.is_full_calendar_month,
          },
          entity_type: "accounting",
          entity_name: "Accounting",
        },
        reportingDate
      )
    );
    return out;
  }

  if (!ACCOUNTING_MEDIUM.has(status)) return out;

  const titles = {
    ledger_ads_missing: "Ledger Ads missing",
    recurring_ads_not_posted: "Recurring Ads not posted to Ledger",
    full_month_variance: "Meta vs Ledger variance (full month)",
  };
  const messages = {
    ledger_ads_missing:
      "Meta spend exists but no matching Ledger Ads expense for this full month.",
    recurring_ads_not_posted:
      "Some Recurring Ads rows have no same-date/same-amount Ledger Ads match.",
    full_month_variance:
      "Meta spend differs materially from booked Ledger Ads for this full month.",
  };

  out.push(
    baseAlert(
      {
        id: `accounting:${status}`,
        category: "accounting",
        severity: "medium",
        title: titles[status] || "Accounting reconciliation issue",
        message: messages[status] || `Accounting reconciliation status: ${status}.`,
        evidence: {
          reconciliation_status: status,
          meta_vs_ledger_variance: snapshot.accounting?.meta_vs_ledger_variance,
          ledger_ads_expense: snapshot.accounting?.ledger_ads_expense,
          recurring_ads_expense: snapshot.accounting?.recurring_ads_expense,
        },
        entity_type: "accounting",
        entity_name: "Accounting",
        current_value: snapshot.accounting?.meta_vs_ledger_variance,
      },
      reportingDate
    )
  );

  return out;
}

function evaluateProductDataAlerts(products = [], reportingDate) {
  const issues = (products || []).filter((p) => p.status === "data_issue");
  if (!issues.length) return [];

  const ranked = [...issues].sort(
    (a, b) => Number(b.revenue_share_pct || 0) - Number(a.revenue_share_pct || 0)
  );
  const examples = ranked
    .slice(0, 5)
    .map((p) => p.product || p.entity_name || p.sku || "Unknown");

  return [
    baseAlert(
      {
        id: "products:data_issues",
        category: "product",
        severity: issues.length >= 5 ? "medium" : "medium",
        title: "Product data issues",
        message: `${issues.length} product/SKU data issue${
          issues.length === 1 ? "" : "s"
        } require review. Top examples: ${examples.join(", ")}.`,
        evidence: {
          count: issues.length,
          examples,
          reason_codes: [...new Set(issues.map((p) => p.reason_code).filter(Boolean))],
        },
        entity_type: "catalog",
        entity_name: "Products",
        current_value: issues.length,
      },
      reportingDate
    ),
  ];
}

function evaluateRevenueConcentrationAlert(snapshot) {
  const reportingDate = snapshot.reporting_date;
  if (!snapshot.sales_mix?.non_shopify_distortion_risk) return [];

  const share = num(snapshot.sales_mix?.dominant_channel_share_pct);
  const channel = snapshot.sales_mix?.dominant_channel || "Non-Shopify";
  const severity = share != null && share >= 70 ? "medium" : "low";

  return [
    baseAlert(
      {
        id: "sales:non_shopify_concentration",
        category: "business_context",
        severity,
        title: "Non-Shopify revenue concentration",
        message:
          share != null
            ? `${channel} is ${round2(share)}% of recognized revenue — whole-business metrics may not reflect ecommerce alone.`
            : "Non-Shopify revenue concentration may distort whole-business interpretation.",
        evidence: {
          dominant_channel: channel,
          dominant_channel_share_pct: share,
          shopify_net_revenue: snapshot.sales_mix?.shopify_net_revenue,
          manual_net_revenue: snapshot.sales_mix?.manual_net_revenue,
          other_sales_net_revenue: snapshot.sales_mix?.other_sales_net_revenue,
        },
        entity_type: "sales_mix",
        entity_name: "Sales mix",
        current_value: share,
      },
      reportingDate
    ),
  ];
}

function evaluateMetaTrendAlerts(snapshot, previous, config) {
  const out = [];
  const reportingDate = snapshot.reporting_date;
  if (!previous) return out;

  const curSpend = num(snapshot.meta?.spend);
  const prevSpend = num(previous.meta?.spend);
  const accountCpa = num(snapshot.meta?.cpa);

  if (
    curSpend != null &&
    prevSpend != null &&
    prevSpend > 0 &&
    accountCpa != null &&
    accountCpa > 0
  ) {
    const absIncrease = round2(curSpend - prevSpend);
    const pctIncrease = round2(((curSpend - prevSpend) / prevSpend) * 100);
    const minAbs =
      config.alerts.meta_spend_spike_min_account_cpa_multiple * accountCpa;
    if (
      curSpend > prevSpend &&
      pctIncrease >= config.alerts.meta_spend_spike_pct &&
      absIncrease >= minAbs
    ) {
      out.push(
        baseAlert(
          {
            id: "meta:spend_spike",
            category: "meta",
            severity: "medium",
            title: "Meta spend spike",
            message: `Meta spend increased ${pctIncrease}% vs previous comparable snapshot (+${round2(
              absIncrease
            )} absolute).`,
            evidence: {
              current_spend: curSpend,
              previous_spend: prevSpend,
              pct_increase: pctIncrease,
              absolute_increase: absIncrease,
              account_cpa: accountCpa,
              min_absolute_threshold: round2(minAbs),
              previous_reporting_date: previous.reporting_date,
            },
            entity_type: "account",
            entity_name: "Meta account",
            current_value: curSpend,
            comparison_value: prevSpend,
          },
          reportingDate
        )
      );
    }
  }

  const curCpa = num(snapshot.meta?.cpa);
  const prevCpa = num(previous.meta?.cpa);
  const purchases = num(snapshot.meta?.purchases) || 0;

  if (
    curCpa != null &&
    prevCpa != null &&
    prevCpa > 0 &&
    purchases >= config.alerts.meta_cpa_min_purchases
  ) {
    const threshold =
      prevCpa * (1 + config.alerts.meta_cpa_deterioration_pct / 100);
    if (curCpa >= threshold) {
      const pctIncrease = round2(((curCpa - prevCpa) / prevCpa) * 100);
      out.push(
        baseAlert(
          {
            id: "meta:cpa_deterioration",
            category: "meta",
            severity: "medium",
            title: "Meta CPA deterioration",
            message: `Account Meta CPA rose ${pctIncrease}% vs previous comparable snapshot (${round2(
              prevCpa
            )} → ${round2(curCpa)}).`,
            evidence: {
              current_cpa: curCpa,
              previous_cpa: prevCpa,
              pct_increase: pctIncrease,
              purchases,
              min_purchases: config.alerts.meta_cpa_min_purchases,
              deterioration_threshold_pct: config.alerts.meta_cpa_deterioration_pct,
              previous_reporting_date: previous.reporting_date,
            },
            entity_type: "account",
            entity_name: "Meta account",
            current_value: curCpa,
            comparison_value: prevCpa,
          },
          reportingDate
        )
      );
    }
  }

  // Supplemental only — not Meta profitability truth vs Books break-even ROAS.
  const curRoas = num(snapshot.meta?.roas);
  const prevRoas = num(previous.meta?.roas);
  if (
    curRoas != null &&
    prevRoas != null &&
    prevRoas > 0 &&
    purchases >= config.alerts.meta_cpa_min_purchases &&
    curRoas <= prevRoas * 0.75
  ) {
    const pctDrop = round2(((prevRoas - curRoas) / prevRoas) * 100);
    out.push(
      baseAlert(
        {
          id: "meta:roas_deterioration",
          category: "meta",
          severity: "low",
          title: "Meta ROAS declined (supplemental)",
          message: `Account Meta ROAS fell ${pctDrop}% vs previous comparable snapshot (${round2(
            prevRoas
          )} → ${round2(curRoas)}). Supplemental signal only — not Books break-even ROAS.`,
          evidence: {
            current_roas: curRoas,
            previous_roas: prevRoas,
            pct_drop: pctDrop,
            purchases,
            previous_reporting_date: previous.reporting_date,
            note: "supplemental_not_books_breakeven",
          },
          entity_type: "account",
          entity_name: "Meta account",
          current_value: curRoas,
          comparison_value: prevRoas,
        },
        reportingDate
      )
    );
  }

  return out;
}

/**
 * Evaluate deterministic operational alerts.
 * @param {object} input
 * @param {object} input.bundle Unified reporting bundle
 * @param {object} input.snapshot Daily KPI snapshot
 * @param {object[]} [input.history]
 * @param {object[]} [input.previousAlerts]
 * @param {object} input.config From loadOperationsConfig()
 */
function evaluateAlerts({
  bundle,
  snapshot,
  history = [],
  previousAlerts = [],
  config,
} = {}) {
  if (!bundle || !snapshot) {
    throw new Error("evaluateAlerts requires bundle and snapshot");
  }
  if (!config?.alerts) {
    throw new Error("evaluateAlerts requires config.alerts");
  }

  const reportingDate = snapshot.reporting_date;
  const generated_at = snapshot.generated_at || new Date().toISOString();
  const previous = getPreviousSnapshot(history, snapshot);
  const ads = bundle.ads || [];

  const current = [
    ...evaluateBusinessAlerts(bundle, snapshot, previous, config),
    ...evaluateShopifyAlerts(snapshot, history, config),
    ...evaluateMetaEntityAlerts(ads),
    ...evaluateAccountingAlerts(snapshot),
    ...evaluateProductDataAlerts(bundle.products || [], reportingDate),
    ...evaluateRevenueConcentrationAlert(snapshot),
    ...evaluateMetaTrendAlerts(snapshot, previous, config),
  ].map((a) => ({
    ...a,
    first_seen: a.first_seen || reportingDate,
  }));

  const alerts = applyLifecycle(current, previousAlerts, reportingDate);
  const activeAlerts = alerts.filter((a) => a.status === "active");
  const attention_summary = buildAttentionSummary(activeAlerts);

  return {
    alerts,
    attention_summary,
    generated_at,
  };
}

module.exports = {
  evaluateAlerts,
  consecutiveNegativeShopifyRuns,
  buildAttentionSummary,
};
