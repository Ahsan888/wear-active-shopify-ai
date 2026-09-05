/**
 * Backfill daily snapshots for a date range (no delivery by default).
 */
const { loadOperationsConfig } = require("./config");
const {
  assertYmd,
  eachYmdInclusive,
  trailingWindow,
  addDaysYmd,
} = require("./dates");
const { runDailyReport } = require("./daily");
const { loadHistory } = require("./history");

function parseBackfillArgs(argv) {
  const out = {
    since: null,
    until: null,
    days: null,
    force: false,
    briefs: true,
    deliver: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") {
      out.force = true;
      continue;
    }
    if (arg === "--briefs") {
      out.briefs = true;
      continue;
    }
    if (arg === "--no-briefs") {
      out.briefs = false;
      continue;
    }
    if (arg === "--deliver") {
      out.deliver = true;
      continue;
    }
    if (arg.startsWith("--since=")) {
      out.since = assertYmd(arg.slice(8), "since");
      continue;
    }
    if (arg === "--since") {
      out.since = assertYmd(argv[++i], "since");
      continue;
    }
    if (arg.startsWith("--until=")) {
      out.until = assertYmd(arg.slice(8), "until");
      continue;
    }
    if (arg === "--until") {
      out.until = assertYmd(argv[++i], "until");
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
  if (!out.since || !out.until) {
    throw new Error("Backfill requires --since and --until");
  }
  return out;
}

async function runBackfill(options = {}) {
  const config = loadOperationsConfig(options.configOverrides || {});
  const since = assertYmd(options.since, "since");
  const until = assertYmd(options.until, "until");
  const days = Number(options.days || config.daily_days || 7);
  const dates = eachYmdInclusive(since, until);
  const max = Number(config.max_backfill_days || 90);
  if (dates.length > max && !options.force) {
    throw new Error(
      `Backfill span ${dates.length} days exceeds max ${max}. Pass --force to override.`
    );
  }

  const results = {
    since,
    until,
    days,
    created: 0,
    replaced: 0,
    failed: [],
    dates: [],
  };

  for (const reporting_date of dates) {
    try {
      const prior = loadHistory(options.cwd || process.cwd());
      const key = `${reporting_date}:${days}`;
      const existed = prior.some((s) => s.snapshot_key === key);
      // Always no external delivery unless --deliver
      await runDailyReport({
        date: reporting_date,
        days,
        noDelivery: !options.deliver,
        dryRun: false,
        cwd: options.cwd,
        configOverrides: {
          ...options.configOverrides,
          delivery_enabled: Boolean(options.deliver),
        },
      });
      if (existed) results.replaced += 1;
      else results.created += 1;
      results.dates.push(reporting_date);
    } catch (err) {
      results.failed.push({
        reporting_date,
        error: String(err.message || err),
      });
    }
  }

  return results;
}

module.exports = {
  parseBackfillArgs,
  runBackfill,
  eachYmdInclusive,
  trailingWindow,
  addDaysYmd,
};
