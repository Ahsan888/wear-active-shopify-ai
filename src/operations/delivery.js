/**
 * Delivery adapters for daily operational reports.
 * Default: disabled. Never log webhook secrets.
 */
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { atomicWriteFile, reportsRoot, readTextIfExists } = require("./files");
const { formatMoney, formatPct, formatRoas, formatNumber } = require("../meta/metrics");
const { formatDisplayDate } = require("./dates");

function deliveryKey(reportingDate, days) {
  return `daily-report:${reportingDate}:${Number(days)}`;
}

function deliveryAuditPath(reportingDate, cwd = process.cwd()) {
  return path.join(reportsRoot(cwd), "delivery", `${reportingDate}.json`);
}

function deliveryLatestPath(cwd = process.cwd()) {
  return path.join(reportsRoot(cwd), "delivery", "latest.json");
}

function redactUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "[redacted-url]";
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDeliveryPayload({
  reporting_date,
  brief,
  alertsResult,
  snapshot,
  dashboard_path,
  days,
}) {
  const cur = "PKR";
  const active = (alertsResult?.alerts || []).filter((a) => a.status === "active");
  const high = active.filter((a) => a.severity === "critical" || a.severity === "high");
  const medium = active
    .filter((a) => a.severity === "medium")
    .slice(0, 5);
  const lowCount = active.filter((a) => a.severity === "low" || a.severity === "info").length;

  const subject = `Wear Active Daily — ${formatDisplayDate(reporting_date)}`;
  const lines = [
    subject,
    `Health: ${snapshot.business?.health_status || "—"}`,
    `Adjusted profit: ${formatMoney(snapshot.business?.meta_adjusted_profit, cur)}`,
    `Shopify contribution: ${formatMoney(snapshot.shopify?.contribution_after_meta, cur)}`,
    `Meta: ${formatMoney(snapshot.meta?.spend, cur)} spend · CPA ${formatMoney(snapshot.meta?.cpa, cur)} · ROAS ${formatRoas(snapshot.meta?.roas)}`,
    `${high.length} HIGH`,
    ...high.map((a) => `• ${a.title}`),
    `${medium.length} MEDIUM`,
    ...medium.map((a) => `• ${a.title}`),
    lowCount ? `${lowCount} low/info (see dashboard)` : null,
    `Dashboard: ${dashboard_path || "reports/dashboard/index.html"}`,
  ].filter(Boolean);

  const text = lines.join("\n");
  const html_summary = `<pre>${escapeHtml(text)}</pre>`;

  return {
    event: "wear_active.daily_report",
    reporting_date,
    delivery_key: deliveryKey(reporting_date, days),
    brief: brief?.json || null,
    brief_text: brief?.text || null,
    alerts: active,
    attention_summary: alertsResult?.attention_summary || null,
    dashboard: { local_path: dashboard_path || null },
    subject,
    text,
    html_summary,
    alert_count: active.length,
    snapshot_key: snapshot.snapshot_key,
  };
}

function wasAlreadyDelivered(reportingDate, days, cwd = process.cwd()) {
  const key = deliveryKey(reportingDate, days);
  const latest = readTextIfExists(deliveryLatestPath(cwd));
  if (!latest) return false;
  try {
    const j = JSON.parse(latest);
    return Boolean(j.success && j.delivery_key === key);
  } catch {
    return false;
  }
}

function writeDeliveryAudit(audit, cwd = process.cwd()) {
  const dated = deliveryAuditPath(audit.reporting_date, cwd);
  const body = JSON.stringify(audit, null, 2) + "\n";
  atomicWriteFile(dated, body);
  atomicWriteFile(deliveryLatestPath(cwd), body);
  return dated;
}

async function deliverConsole(payload) {
  console.log("\n—— Delivery (console) ——");
  console.log(payload.text);
  console.log("—— End delivery ——\n");
  return { success: true, channel: "console" };
}

async function deliverFile(payload, cwd = process.cwd()) {
  const out = path.join(
    reportsRoot(cwd),
    "delivery",
    `${payload.reporting_date}.payload.txt`
  );
  atomicWriteFile(out, payload.text + "\n");
  return { success: true, channel: "file", path: out };
}

function postJson(url, body, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error("invalid_webhook_url"));
      return;
    }
    const lib = parsed.protocol === "http:" ? http : https;
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
        path: `${parsed.pathname}${parsed.search || ""}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: raw });
          } else {
            reject(
              new Error(`webhook_http_${res.statusCode || "unknown"}`)
            );
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("webhook_timeout"));
    });
    req.on("error", (err) => reject(err));
    req.write(data);
    req.end();
  });
}

async function deliverWebhook(payload, webhookUrl) {
  if (!webhookUrl) throw new Error("webhook_url_missing");
  const body = {
    event: payload.event,
    reporting_date: payload.reporting_date,
    brief: payload.brief,
    alerts: payload.alerts,
    dashboard: payload.dashboard,
    subject: payload.subject,
    text: payload.text,
  };
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await postJson(webhookUrl, body, { timeoutMs: 8000 });
      return { success: true, channel: "webhook", attempts: attempt };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("webhook_failed");
}

/**
 * Deliver daily report according to config.
 * Returns audit object. Does not throw for disabled delivery.
 * Throws only if enabled and delivery fails (caller may catch).
 */
async function deliverDailyReport(
  {
    reporting_date,
    brief,
    alertsResult,
    snapshot,
    dashboard_path,
    days,
  },
  config,
  {
    force = false,
    cwd = process.cwd(),
  } = {}
) {
  const enabled = Boolean(config.delivery_enabled);
  const channel = String(config.delivery_channel || "console").toLowerCase();
  const key = deliveryKey(reporting_date, days);
  const payload = buildDeliveryPayload({
    reporting_date,
    brief,
    alertsResult,
    snapshot,
    dashboard_path,
    days,
  });

  const baseAudit = {
    reporting_date,
    enabled,
    channel,
    delivery_key: key,
    attempted: false,
    success: false,
    attempted_at: null,
    error_code: null,
    error_message_redacted: null,
  };

  if (!enabled) {
    const audit = { ...baseAudit, attempted: false, success: false };
    writeDeliveryAudit(audit, cwd);
    return { audit, payload, skipped: "disabled" };
  }

  if (!force && wasAlreadyDelivered(reporting_date, days, cwd)) {
    const audit = {
      ...baseAudit,
      attempted: false,
      success: true,
      error_code: "already_delivered",
      error_message_redacted: "Same delivery_key already succeeded",
    };
    writeDeliveryAudit(audit, cwd);
    return { audit, payload, skipped: "already_delivered" };
  }

  const attempted_at = new Date().toISOString();
  try {
    let result;
    if (channel === "console") result = await deliverConsole(payload);
    else if (channel === "file") result = await deliverFile(payload, cwd);
    else if (channel === "webhook") {
      result = await deliverWebhook(payload, config.delivery_webhook_url);
    } else {
      throw new Error(`unknown_delivery_channel:${channel}`);
    }
    const audit = {
      ...baseAudit,
      attempted: true,
      success: true,
      attempted_at,
      channel: result.channel || channel,
    };
    writeDeliveryAudit(audit, cwd);
    return { audit, payload, result };
  } catch (err) {
    const audit = {
      ...baseAudit,
      attempted: true,
      success: false,
      attempted_at,
      error_code: String(err.message || "delivery_failed").slice(0, 80),
      error_message_redacted: String(err.message || "delivery_failed").slice(
        0,
        200
      ),
      webhook_host: config.delivery_webhook_url
        ? redactUrl(config.delivery_webhook_url)
        : null,
    };
    writeDeliveryAudit(audit, cwd);
    const e = new Error(audit.error_code);
    e.audit = audit;
    throw e;
  }
}

module.exports = {
  deliveryKey,
  buildDeliveryPayload,
  wasAlreadyDelivered,
  writeDeliveryAudit,
  deliverDailyReport,
  redactUrl,
  deliverConsole,
  deliverFile,
  deliverWebhook,
  postJson,
};
