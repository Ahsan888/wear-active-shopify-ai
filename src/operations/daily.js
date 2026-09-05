/**
 * Daily operational reporting orchestrator.
 *
 * load → bundle → snapshot → history/trends → alerts → brief → dashboard → persist → deliver
 */
const path = require("path");
const { loadDecisionInputs } = require("../decisions/loadInputs");
const {
  buildUnifiedReportingBundle,
  sanitizeBundleForEmbed,
} = require("../dashboard/bundle");
const { renderUnifiedDashboard } = require("../dashboard/html");
const { loadOperationsConfig } = require("./config");
const { trailingWindow, todayYmd, assertYmd, formatDisplayDate } = require("./dates");
const { buildSnapshotFromBundle } = require("./snapshot");
const {
  loadHistory,
  upsertSnapshot,
  writeHistory,
  writeDatedSnapshot,
  historyPath,
} = require("./history");
const { buildTrends } = require("./trends");
const { evaluateAlerts } = require("./alerts");
const { buildDailyBrief } = require("./brief");
const { deliverDailyReport } = require("./delivery");
const {
  atomicWriteFile,
  reportsRoot,
  readTextIfExists,
  ensureDir,
} = require("./files");
const { formatMoney, formatPct, formatRoas, formatNumber } = require("../meta/metrics");

function parseDailyArgs(argv) {
  const out = {
    date: null,
    days: null,
    dryRun: false,
    noDelivery: false,
    forceDelivery: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--no-delivery") {
      out.noDelivery = true;
      continue;
    }
    if (arg === "--force-delivery") {
      out.forceDelivery = true;
      continue;
    }
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg.startsWith("--date=")) {
      out.date = assertYmd(arg.slice(7), "date");
      continue;
    }
    if (arg === "--date") {
      out.date = assertYmd(argv[++i], "date");
      continue;
    }
    if (arg.startsWith("--days=")) {
      const n = Number(arg.slice(7));
      if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid ${arg}`);
      out.days = n;
      continue;
    }
    if (arg === "--days") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("Invalid --days");
      out.days = n;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function loadPreviousAlerts(reportingDate, cwd) {
  const dated = path.join(reportsRoot(cwd), "alerts", `${reportingDate}.json`);
  // Prefer prior day's file for lifecycle — caller may pass previous from history
  const latest = path.join(reportsRoot(cwd), "alerts", "latest.json");
  const text = readTextIfExists(dated) || readTextIfExists(latest);
  if (!text) return [];
  try {
    const j = JSON.parse(text);
    return j.alerts || [];
  } catch {
    return [];
  }
}

function loadAlertsForDate(reportingDate, cwd) {
  const p = path.join(reportsRoot(cwd), "alerts", `${reportingDate}.json`);
  const text = readTextIfExists(p);
  if (!text) return [];
  try {
    return JSON.parse(text).alerts || [];
  } catch {
    return [];
  }
}

function previousReportingDateFromHistory(history, snapshot) {
  const same = (history || [])
    .filter(
      (s) =>
        Number(s.period?.days) === Number(snapshot.period?.days) &&
        s.reporting_date < snapshot.reporting_date
    )
    .sort((a, b) => a.reporting_date.localeCompare(b.reporting_date));
  return same.length ? same[same.length - 1].reporting_date : null;
}

async function runDailyReport(options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = loadOperationsConfig(options.configOverrides || {});
  const reporting_date = assertYmd(
    options.date || todayYmd(config.timezone),
    "date"
  );
  const days = Number(options.days || config.daily_days || 7);
  const period = trailingWindow(reporting_date, days);
  const dryRun = Boolean(options.dryRun);
  const deliveryEnabled =
    Boolean(config.delivery_enabled) &&
    !options.noDelivery &&
    !dryRun;
  const forceDelivery = Boolean(options.forceDelivery);

  // Stage: load
  const inputs = await loadDecisionInputs(period.since, period.until);
  const baseBundle = buildUnifiedReportingBundle(inputs);

  // Stage: snapshot
  const snapshot = buildSnapshotFromBundle(baseBundle, {
    reporting_date,
    period,
    timezone: config.timezone,
  });

  // Stage: history / trends (read always; write unless dry-run)
  const history = loadHistory(cwd);
  const trends = buildTrends(snapshot, history);

  const prevDate = previousReportingDateFromHistory(history, snapshot);
  const previousAlerts = prevDate
    ? loadAlertsForDate(prevDate, cwd)
    : loadPreviousAlerts(reporting_date, cwd);

  // Stage: alerts
  const alertsResult = evaluateAlerts({
    bundle: baseBundle,
    snapshot,
    history,
    previousAlerts,
    config,
  });

  // Stage: operational bundle for dashboard
  const operationalBundle = sanitizeBundleForEmbed({
    ...baseBundle,
    operational: {
      snapshot,
      trends,
      alerts: alertsResult.alerts,
      attention_summary: alertsResult.attention_summary,
      reporting_date,
    },
  });

  const dashboard_path = path.join(
    reportsRoot(cwd),
    "dashboard",
    "index.html"
  );
  const datedDashboard = path.join(
    reportsRoot(cwd),
    "dashboard",
    `report-${period.since}-to-${period.until}.html`
  );

  // Stage: brief
  const brief = buildDailyBrief({
    bundle: baseBundle,
    snapshot,
    trends,
    alertsResult,
    dashboard_path: "reports/dashboard/index.html",
    reporting_date,
    config,
  });

  let delivery = null;
  let deliveryError = null;

  if (!dryRun) {
    // Persist artifacts
    writeDatedSnapshot(snapshot, cwd);
    const nextHistory = upsertSnapshot(history, snapshot);
    writeHistory(nextHistory, cwd);

    const html = renderUnifiedDashboard(operationalBundle);
    ensureDir(path.dirname(dashboard_path));
    atomicWriteFile(dashboard_path, html);
    atomicWriteFile(datedDashboard, html);

    const briefDir = path.join(reportsRoot(cwd), "briefs");
    atomicWriteFile(
      path.join(briefDir, `${reporting_date}.txt`),
      brief.text + "\n"
    );
    atomicWriteFile(
      path.join(briefDir, `${reporting_date}.json`),
      JSON.stringify(brief.json, null, 2) + "\n"
    );
    atomicWriteFile(path.join(briefDir, "latest.txt"), brief.text + "\n");
    atomicWriteFile(
      path.join(briefDir, "latest.json"),
      JSON.stringify(brief.json, null, 2) + "\n"
    );

    const alertDoc = {
      reporting_date,
      generated_at: alertsResult.generated_at,
      attention_summary: alertsResult.attention_summary,
      alerts: alertsResult.alerts,
    };
    const alertDir = path.join(reportsRoot(cwd), "alerts");
    atomicWriteFile(
      path.join(alertDir, `${reporting_date}.json`),
      JSON.stringify(alertDoc, null, 2) + "\n"
    );
    atomicWriteFile(
      path.join(alertDir, "latest.json"),
      JSON.stringify(alertDoc, null, 2) + "\n"
    );

    // Stage: delivery
    try {
      delivery = await deliverDailyReport(
        {
          reporting_date,
          brief,
          alertsResult,
          snapshot,
          dashboard_path: "reports/dashboard/index.html",
          days,
        },
        { ...config, delivery_enabled: deliveryEnabled },
        { force: forceDelivery, cwd }
      );
    } catch (err) {
      deliveryError = err;
      delivery = { audit: err.audit || null };
    }
  }

  const summary = {
    title: "Wear Active Daily Reporting",
    reporting_date,
    period,
    dry_run: dryRun,
    dashboard: dryRun ? "skipped (dry-run)" : "generated",
    snapshot: dryRun ? "skipped (dry-run)" : "saved",
    brief: dryRun ? "preview only" : "generated",
    alerts_active: (alertsResult.alerts || []).filter((a) => a.status === "active")
      .length,
    delivery: dryRun
      ? "disabled (dry-run)"
      : deliveryEnabled
        ? deliveryError
          ? "failed"
          : delivery?.skipped || (delivery?.audit?.success ? "sent" : "attempted")
        : "disabled",
    business_health: snapshot.business.health_status,
    adjusted_profit: snapshot.business.meta_adjusted_profit,
    shopify_contribution: snapshot.shopify.contribution_after_meta,
    meta_spend: snapshot.meta.spend,
    meta_cpa: snapshot.meta.cpa,
    history_path: historyPath(cwd),
  };

  return {
    summary,
    snapshot,
    trends,
    alertsResult,
    brief,
    delivery,
    deliveryError,
    operationalBundle,
    period,
    reporting_date,
    dryRun,
  };
}

function printDailySummary(result) {
  const s = result.summary;
  const cur = "PKR";
  console.log("Wear Active Daily Reporting");
  console.log(`Date: ${s.reporting_date}`);
  console.log(`Dashboard: ${s.dashboard}`);
  console.log(`Snapshot: ${s.snapshot}`);
  console.log(`Brief: ${s.brief}`);
  console.log(`Alerts: ${s.alerts_active} active`);
  console.log(`Delivery: ${s.delivery}`);
  console.log(`Business health: ${s.business_health}`);
  console.log(
    `Adjusted profit: ${formatMoney(s.adjusted_profit, cur)}`
  );
  console.log(
    `Shopify contribution: ${formatMoney(s.shopify_contribution, cur)}`
  );
  console.log(`Meta spend: ${formatMoney(s.meta_spend, cur)}`);
  console.log(`Meta CPA: ${formatMoney(s.meta_cpa, cur)}`);
  if (result.snapshot?.period?.current_day_incomplete) {
    console.log(
      "Note: Today's Meta and order activity may still be incomplete."
    );
  }
}

module.exports = {
  parseDailyArgs,
  runDailyReport,
  printDailySummary,
};
