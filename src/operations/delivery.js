/**
 * Delivery adapters for daily operational reports.
 * Default: disabled. Never log webhook/Resend secrets.
 */
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { atomicWriteFile, reportsRoot, readTextIfExists } = require("./files");
const { deliveryAuditPath } = require("./paths");
const {
  loadDeliveryHistory,
  upsertDeliveryRecord,
  writeDeliveryHistory,
  wasAlreadyDelivered,
} = require("./deliveryHistory");
const { buildOwnerEmailContent, DEFAULT_OWNER_POLICY } = require("./ownerEmail");
const { sendViaResend, redactRecipients } = require("../email/resend");

function deliveryKey(reportingDate, days) {
  return `daily-report:${reportingDate}:${Number(days)}`;
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

function buildDeliveryPayload({
  reporting_date,
  brief,
  alertsResult,
  snapshot,
  dashboard_path,
  days,
  previousAlerts,
  history,
  loadAlertsFn,
  bundle,
  config,
  attribution,
}) {
  const policy = {
    ...DEFAULT_OWNER_POLICY,
    max_medium:
      config?.alerts?.max_medium_delivery_alerts ??
      DEFAULT_OWNER_POLICY.max_medium,
    high_reminder_every:
      config?.owner_email?.high_reminder_every ??
      DEFAULT_OWNER_POLICY.high_reminder_every,
    medium_reminder_every:
      config?.owner_email?.medium_reminder_every ??
      DEFAULT_OWNER_POLICY.medium_reminder_every,
  };

  const owner = buildOwnerEmailContent({
    snapshot,
    brief,
    alertsResult,
    previousAlerts: previousAlerts || [],
    history: history || [],
    loadAlertsFn,
    bundle,
    dashboard_path,
    days,
    policy,
    attribution,
  });

  return {
    event: "wear_active.daily_report",
    reporting_date,
    days: Number(days),
    delivery_key: deliveryKey(reporting_date, days),
    subject: owner.subject,
    text: owner.text,
    html: owner.html,
    html_summary: owner.html_summary,
    owner_alerts: owner.owner_alerts,
    suppressed_alert_count: owner.suppressed_alert_count,
    lower_priority_count: owner.lower_priority_count,
    grouped_alerts: owner.grouped_alerts,
    top_actions: owner.top_actions,
    dashboard_path: owner.dashboard_path,
    dashboard: { local_path: dashboard_path || null },
    brief: brief?.json || null,
    alerts: (alertsResult?.alerts || []).filter((a) => a.status === "active"),
    snapshot_key: snapshot?.snapshot_key || null,
  };
}

function writeDeliveryAudit(audit, cwd = process.cwd()) {
  const days = audit.days;
  const dated = deliveryAuditPath(audit.reporting_date, days, cwd);
  const body = JSON.stringify(audit, null, 2) + "\n";
  atomicWriteFile(dated, body);
  atomicWriteFile(deliveryLatestPath(cwd), body);

  // Upsert delivery history (source of truth for dedupe)
  const history = loadDeliveryHistory(cwd);
  const record = {
    delivery_key: audit.delivery_key,
    reporting_date: audit.reporting_date,
    days: Number(audit.days),
    channel: audit.channel,
    attempted: Boolean(audit.attempted),
    success: Boolean(audit.success),
    attempted_at: audit.attempted_at || null,
    error_code: audit.error_code || null,
    error_message_redacted: audit.error_message_redacted || null,
  };
  // Only upsert when we have a meaningful attempt or success/skip already_delivered
  if (audit.attempted || audit.error_code === "already_delivered" || audit.success) {
    writeDeliveryHistory(upsertDeliveryRecord(history, record), cwd);
  } else if (!audit.enabled) {
    // Disabled: still write dated audit, but do not mark history as delivered
  }
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
    `${payload.reporting_date}-${Number(payload.days)}d.payload.txt`
  );
  atomicWriteFile(out, payload.text + "\n");
  if (payload.html) {
    atomicWriteFile(out.replace(/\.txt$/, ".html"), payload.html + "\n");
  }
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
            reject(new Error(`webhook_http_${res.statusCode || "unknown"}`));
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
    days: payload.days,
    delivery_key: payload.delivery_key,
    subject: payload.subject,
    text: payload.text,
    owner_alerts: payload.owner_alerts,
    dashboard: payload.dashboard,
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

async function deliverResend(payload, config, { fetchImpl } = {}) {
  const to =
    config.email_to ??
    process.env.REPORT_EMAIL_TO ??
    process.env.LOW_STOCK_EMAIL_TO ??
    "";
  const from =
    config.email_from ??
    process.env.REPORT_EMAIL_FROM ??
    process.env.LOW_STOCK_EMAIL_FROM ??
    "";
  const apiKey =
    config.resend_api_key ?? process.env.RESEND_API_KEY ?? "";

  const result = await sendViaResend({
    to,
    from,
    subject: payload.subject,
    text: payload.text,
    html: payload.html || payload.html_summary,
    apiKey,
    fetchImpl,
  });

  return {
    success: true,
    channel: "resend",
    resend_message_id: result.id,
    recipient_redacted: redactRecipients(to),
  };
}

/**
 * Deliver daily report according to config.
 */
async function deliverDailyReport(
  {
    reporting_date,
    brief,
    alertsResult,
    snapshot,
    dashboard_path,
    days,
    previousAlerts,
    history,
    loadAlertsFn,
    bundle,
    attribution,
  },
  config,
  { force = false, cwd = process.cwd(), fetchImpl } = {}
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
    previousAlerts,
    history,
    loadAlertsFn,
    bundle,
    config,
    attribution,
  });

  const baseAudit = {
    reporting_date,
    days: Number(days),
    enabled,
    channel,
    delivery_key: key,
    attempted: false,
    success: false,
    attempted_at: null,
    error_code: null,
    error_message_redacted: null,
    recipient_redacted: null,
    resend_message_id: null,
  };

  if (!enabled) {
    const audit = { ...baseAudit, attempted: false, success: false };
    const dated = deliveryAuditPath(reporting_date, days, cwd);
    atomicWriteFile(dated, JSON.stringify(audit, null, 2) + "\n");
    atomicWriteFile(deliveryLatestPath(cwd), JSON.stringify(audit, null, 2) + "\n");
    return { audit, payload, skipped: "disabled" };
  }

  if (!force && wasAlreadyDelivered(key, cwd)) {
    const audit = {
      ...baseAudit,
      attempted: false,
      success: true,
      error_code: "already_delivered",
      error_message_redacted: "Same delivery_key already succeeded",
    };
    // Dated + latest only — do not overwrite successful history row
    const dated = deliveryAuditPath(reporting_date, days, cwd);
    const body = JSON.stringify(audit, null, 2) + "\n";
    atomicWriteFile(dated, body);
    atomicWriteFile(deliveryLatestPath(cwd), body);
    return { audit, payload, skipped: "already_delivered" };
  }

  const attempted_at = new Date().toISOString();
  try {
    let result;
    if (channel === "console") result = await deliverConsole(payload);
    else if (channel === "file") result = await deliverFile(payload, cwd);
    else if (channel === "webhook") {
      result = await deliverWebhook(payload, config.delivery_webhook_url);
    } else if (channel === "resend") {
      result = await deliverResend(payload, config, { fetchImpl });
    } else {
      throw new Error(`unknown_delivery_channel:${channel}`);
    }
    const audit = {
      ...baseAudit,
      attempted: true,
      success: true,
      attempted_at,
      channel: result.channel || channel,
      recipient_redacted: result.recipient_redacted || null,
      resend_message_id: result.resend_message_id || null,
    };
    writeDeliveryAudit(audit, cwd);
    return { audit, payload, result };
  } catch (err) {
    const audit = {
      ...baseAudit,
      attempted: true,
      success: false,
      attempted_at,
      error_code: String(err.code || err.message || "delivery_failed").slice(
        0,
        80
      ),
      error_message_redacted: String(
        err.messageRedacted || err.message || "delivery_failed"
      ).slice(0, 200),
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
  deliverResend,
  postJson,
};
