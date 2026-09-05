/**
 * Shared CLI date-range + insights field helpers for Meta report scripts.
 */
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
    if (arg === "--json") out.json = true;
    else if (arg.startsWith("--days=")) out.days = Number(arg.slice(7));
    else if (arg === "--days") out.days = Number(argv[++i]);
    else if (arg.startsWith("--since=")) out.since = arg.slice(8);
    else if (arg === "--since") out.since = argv[++i];
    else if (arg.startsWith("--until=")) out.until = arg.slice(8);
    else if (arg === "--until") out.until = argv[++i];
    else if (arg.startsWith("--level=")) out.level = arg.slice(8);
    else if (arg === "--level") out.level = argv[++i];
    else if (arg.startsWith("--meta=")) out.meta = arg.slice(7);
    else if (arg === "--meta") out.meta = argv[++i];
    else if (arg.startsWith("--shopify=")) out.shopify = arg.slice(10);
    else if (arg === "--shopify") out.shopify = argv[++i];
    else if (arg.startsWith("--out=")) out.out = arg.slice(6);
    else if (arg === "--out") out.out = argv[++i];
  }

  return out;
}

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseYmd(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(`Invalid date "${value}" (expected YYYY-MM-DD)`);
  }
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

/**
 * Resolve since/until. Default: last N calendar days inclusive ending today (local).
 * Prefer account timezone date "today" when timezone_name is provided.
 */
function resolveDateRange(args, timezoneName) {
  let until = args.until || null;
  let since = args.since || null;
  const days = args.days != null && Number.isFinite(args.days) ? args.days : null;

  if ((since && !until) || (!since && until)) {
    throw new Error("Provide both --since and --until, or use --days=N");
  }

  if (!since && !until) {
    const n = days != null ? Math.max(1, Math.floor(days)) : 7;
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
  resolveDateRange,
  normalizeLevel,
  insightFieldsForLevel,
  hintForMetaError,
  ymd,
};
