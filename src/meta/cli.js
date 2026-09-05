/**
 * Shared CLI date-range + insights field helpers for Meta report scripts.
 */

const KNOWN_FLAGS = new Set([
  "--json",
  "--days",
  "--since",
  "--until",
  "--level",
  "--meta",
  "--shopify",
  "--out",
]);

function flagName(arg) {
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}

function isFlag(arg) {
  return typeof arg === "string" && arg.startsWith("--");
}

function requireValue(flag, value) {
  if (value == null || value === "" || isFlag(value)) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

/** Require a positive integer (rejects 0, negatives, NaN, negatives). */
function parsePositiveInt(raw, flag) {
  const text = String(raw);
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `Invalid ${flag}=${raw}; expected a positive integer (e.g. 7)`
    );
  }
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `Invalid ${flag}=${raw}; expected a positive integer (e.g. 7)`
    );
  }
  return n;
}

function parseArgs(argv) {
  const out = {
    days: null,
    since: null,
    until: null,
    level: "campaign",
    json: false,
    meta: null,
    shopify: null,
    out: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!isFlag(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const name = flagName(arg);
    if (!KNOWN_FLAGS.has(name)) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (arg === "--json") {
      out.json = true;
      continue;
    }

    let value;
    if (arg.includes("=")) {
      value = arg.slice(arg.indexOf("=") + 1);
      requireValue(name, value === "" ? null : value);
    } else {
      value = requireValue(name, argv[i + 1]);
      i += 1;
    }

    if (name === "--days") out.days = parsePositiveInt(value, "--days");
    else if (name === "--since") out.since = value;
    else if (name === "--until") out.until = value;
    else if (name === "--level") out.level = value;
    else if (name === "--meta") out.meta = value;
    else if (name === "--shopify") out.shopify = value;
    else if (name === "--out") out.out = value;
  }

  return out;
}

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Parse YYYY-MM-DD and reject non-existent calendar dates (e.g. 2026-02-31).
 */
function parseYmd(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(`Invalid date "${value}" (expected YYYY-MM-DD)`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new Error(`Invalid calendar date "${value}"`);
  }
  return { y, mo, d };
}

/**
 * Resolve since/until. Default: last N calendar days inclusive ending today.
 * Prefer account timezone date "today" when timezone_name is provided.
 */
function resolveDateRange(args, timezoneName) {
  let until = args.until || null;
  let since = args.since || null;
  const days = args.days;

  if ((since && !until) || (!since && until)) {
    throw new Error("Provide both --since and --until, or use --days=N");
  }

  if (!since && !until) {
    // days already validated as positive int when provided; default 7
    const n = days != null ? days : 7;
    const end = todayInTimezone(timezoneName);
    const start = new Date(end);
    start.setDate(start.getDate() - (n - 1));
    since = ymd(start);
    until = ymd(end);
  }

  parseYmd(since);
  parseYmd(until);
  if (since > until) {
    throw new Error(`--since (${since}) must be <= --until (${until})`);
  }

  return { since, until };
}

function todayInTimezone(timezoneName) {
  if (!timezoneName) return new Date();
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezoneName,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    // en-CA yields YYYY-MM-DD
    const parts = fmt.formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return new Date(
      Number(get("year")),
      Number(get("month")) - 1,
      Number(get("day"))
    );
  } catch {
    return new Date();
  }
}

const LEVELS = new Set(["campaign", "adset", "ad", "account"]);

function normalizeLevel(level) {
  const value = String(level || "campaign").toLowerCase();
  if (!LEVELS.has(value)) {
    throw new Error(
      `Invalid --level=${level}. Use campaign|adset|ad (or account).`
    );
  }
  return value;
}

function insightFieldsForLevel(level) {
  const base = [
    "spend",
    "impressions",
    "reach",
    "frequency",
    "cpm",
    "ctr",
    "clicks",
    "inline_link_clicks",
    "cpc",
    "actions",
    "action_values",
    "cost_per_action_type",
  ];

  if (level === "account") return base.join(",");
  if (level === "campaign") {
    return ["campaign_id", "campaign_name", ...base].join(",");
  }
  if (level === "adset") {
    return [
      "campaign_id",
      "campaign_name",
      "adset_id",
      "adset_name",
      ...base,
    ].join(",");
  }
  return [
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    ...base,
  ].join(",");
}

function hintForMetaError(err) {
  const code = err?.meta?.code;
  if (code === 200) {
    return (
      "Hint: Meta #200 usually means the token/system user does not have " +
      "ads_read on this ad account. Confirm META_AD_ACCOUNT_ID is WA's Ad " +
      "Account (4074524202691358) and that wearactive-reports is assigned in Business Manager."
    );
  }
  if (code === 190) {
    return "Hint: Meta #190 — access token is invalid or expired. Generate a new long-lived token.";
  }
  if (code === 100) {
    return "Hint: Meta #100 — bad request (unsupported field/param for this API version, or invalid date).";
  }
  return null;
}

module.exports = {
  parseArgs,
  parsePositiveInt,
  parseYmd,
  resolveDateRange,
  normalizeLevel,
  insightFieldsForLevel,
  hintForMetaError,
  todayInTimezone,
  ymd,
};
