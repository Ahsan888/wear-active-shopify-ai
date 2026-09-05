/**
 * Phase 4 operational reporting config.
 * Alert thresholds here must NOT alter Phase 3 classifiers.
 */
const DEFAULTS = {
  timezone: "Asia/Karachi",
  daily_days: 7,
  max_backfill_days: 90,
  delivery_enabled: false,
  delivery_channel: "console",
  delivery_webhook_url: "",
  email_to: "",
  email_from: "",
  alerts: {
    margin_drop_pp: 5,
    negative_shopify_persistence_runs: 3,
    meta_spend_spike_pct: 30,
    meta_spend_spike_min_account_cpa_multiple: 0.25,
    meta_cpa_deterioration_pct: 25,
    meta_cpa_min_purchases: 2,
    max_medium_delivery_alerts: 3,
  },
  owner_email: {
    high_reminder_every: 3,
    medium_reminder_every: 7,
  },
};

function envBool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function envNum(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function loadOperationsConfig(overrides = {}) {
  const alerts = {
    ...DEFAULTS.alerts,
    margin_drop_pp: envNum(
      "REPORT_ALERT_MARGIN_DROP_PP",
      DEFAULTS.alerts.margin_drop_pp
    ),
    negative_shopify_persistence_runs: envNum(
      "REPORT_ALERT_NEGATIVE_SHOPIFY_PERSISTENCE",
      DEFAULTS.alerts.negative_shopify_persistence_runs
    ),
    meta_spend_spike_pct: envNum(
      "REPORT_ALERT_META_SPEND_SPIKE_PCT",
      DEFAULTS.alerts.meta_spend_spike_pct
    ),
    meta_spend_spike_min_account_cpa_multiple: envNum(
      "REPORT_ALERT_META_SPEND_SPIKE_CPA_MULT",
      DEFAULTS.alerts.meta_spend_spike_min_account_cpa_multiple
    ),
    meta_cpa_deterioration_pct: envNum(
      "REPORT_ALERT_META_CPA_DETERIORATION_PCT",
      DEFAULTS.alerts.meta_cpa_deterioration_pct
    ),
    meta_cpa_min_purchases: envNum(
      "REPORT_ALERT_META_CPA_MIN_PURCHASES",
      DEFAULTS.alerts.meta_cpa_min_purchases
    ),
    max_medium_delivery_alerts: envNum(
      "REPORT_ALERT_MAX_MEDIUM_DELIVERY",
      DEFAULTS.alerts.max_medium_delivery_alerts
    ),
  };

  const owner_email = {
    ...DEFAULTS.owner_email,
    high_reminder_every: envNum(
      "REPORT_ALERT_HIGH_REMINDER_EVERY",
      DEFAULTS.owner_email.high_reminder_every
    ),
    medium_reminder_every: envNum(
      "REPORT_ALERT_MEDIUM_REMINDER_EVERY",
      DEFAULTS.owner_email.medium_reminder_every
    ),
  };

  return {
    timezone: process.env.REPORT_TIMEZONE || DEFAULTS.timezone,
    daily_days: envNum("REPORT_DAILY_DAYS", DEFAULTS.daily_days),
    max_backfill_days: envNum(
      "REPORT_MAX_BACKFILL_DAYS",
      DEFAULTS.max_backfill_days
    ),
    delivery_enabled: envBool(
      "REPORT_DELIVERY_ENABLED",
      DEFAULTS.delivery_enabled
    ),
    delivery_channel:
      process.env.REPORT_DELIVERY_CHANNEL || DEFAULTS.delivery_channel,
    delivery_webhook_url: process.env.REPORT_DELIVERY_WEBHOOK_URL || "",
    // Prefer REPORT_EMAIL_*; fall back to existing low-stock Resend recipients
    email_to:
      process.env.REPORT_EMAIL_TO ||
      process.env.LOW_STOCK_EMAIL_TO ||
      "",
    email_from:
      process.env.REPORT_EMAIL_FROM ||
      process.env.LOW_STOCK_EMAIL_FROM ||
      "",
    resend_api_key: process.env.RESEND_API_KEY || "",
    alerts,
    owner_email,
    ...overrides,
    alerts: { ...alerts, ...(overrides.alerts || {}) },
    owner_email: { ...owner_email, ...(overrides.owner_email || {}) },
  };
}

module.exports = {
  DEFAULTS,
  loadOperationsConfig,
};
