/**
 * Multi-period evidence for Meta entities.
 *
 * Trailing 7/14/30 windows OVERLAP — contextual trend only.
 * Independent buckets (recent_7d / previous_7d / prior_16d) do NOT overlap —
 * only these may support REPEATED_* reason codes and persistence escalation.
 */
const { MARKETING } = require("./thresholds");
const { trailingWindow, addDaysYmd } = require("../operations/dates");

const TRAILING_NOTE =
  "Trailing windows overlap and are contextual, not independent observations.";

const INDEPENDENT_KEYS = ["recent_7d", "previous_7d", "prior_16d"];

function statusStrength(status) {
  if (MARKETING.STRONG_STATUSES.has(status)) return 2;
  if (status === "healthy" || status === "watch") return 1;
  if (status === "insufficient_data") return 0;
  if (MARKETING.WEAK_STATUSES.has(status)) return -2;
  return 0;
}

/**
 * Non-overlapping windows covering a 30d span ending on `until`:
 * recent_7d | previous_7d | prior_16d  (7+7+16=30)
 */
function buildIndependentWindowRanges(until) {
  const u = String(until);
  const recent_7d = trailingWindow(u, 7);
  const previous_7d = trailingWindow(addDaysYmd(u, -7), 7);
  const prior_16d = trailingWindow(addDaysYmd(u, -14), 16);
  return {
    recent_7d: { ...recent_7d, key: "recent_7d" },
    previous_7d: { ...previous_7d, key: "previous_7d" },
    prior_16d: { ...prior_16d, key: "prior_16d" },
  };
}

/**
 * Trailing overlapping 7/14/30 consistency (contextual only).
 * @param {object} byWindow - { "7": status, "14": status, "30": status }
 */
function deriveTrailingWindowConsistency(byWindow = {}) {
  const entries = ["7", "14", "30"]
    .map((d) => ({ days: d, status: byWindow[d] }))
    .filter((e) => e.status && e.status !== "insufficient_data");

  const strong_trailing_window_count = entries.filter((e) =>
    MARKETING.STRONG_STATUSES.has(e.status)
  ).length;
  const weak_trailing_window_count = entries.filter((e) =>
    MARKETING.WEAK_STATUSES.has(e.status)
  ).length;

  if (entries.length < 2) {
    return {
      trailing_direction: "INSUFFICIENT",
      strong_trailing_window_count,
      weak_trailing_window_count,
      windows_compared: entries.length,
      by_window: byWindow,
      note: TRAILING_NOTE,
    };
  }

  const short = entries[0];
  const long = entries[entries.length - 1];
  const delta = statusStrength(short.status) - statusStrength(long.status);

  let trailing_direction = "STABLE";
  if (delta >= 2) trailing_direction = "IMPROVING";
  else if (delta <= -2) trailing_direction = "WORSENING";
  else if (weak_trailing_window_count >= 2) trailing_direction = "WORSENING";
  else if (strong_trailing_window_count >= 2) trailing_direction = "STABLE";

  return {
    trailing_direction,
    strong_trailing_window_count,
    weak_trailing_window_count,
    windows_compared: entries.length,
    by_window: byWindow,
    note: TRAILING_NOTE,
  };
}

/**
 * Independent non-overlapping period evidence.
 * @param {object} byPeriod - { recent_7d, previous_7d, prior_16d } statuses
 * @param {{ available?: boolean }} opts
 */
function deriveIndependentPeriodEvidence(byPeriod = {}, opts = {}) {
  const available = opts.available !== false && Object.keys(byPeriod).length > 0;

  if (!available) {
    return {
      available: false,
      independent_periods_compared: null,
      independent_strong_period_count: null,
      independent_weak_period_count: null,
      by_period: {},
      note:
        "Independent non-overlapping periods not loaded — repeated evidence unavailable.",
    };
  }

  const entries = INDEPENDENT_KEYS.map((k) => ({
    key: k,
    status: byPeriod[k],
  })).filter((e) => e.status && e.status !== "insufficient_data");

  const independent_strong_period_count = entries.filter((e) =>
    MARKETING.STRONG_STATUSES.has(e.status)
  ).length;
  const independent_weak_period_count = entries.filter((e) =>
    MARKETING.WEAK_STATUSES.has(e.status)
  ).length;

  return {
    available: true,
    independent_periods_compared: entries.length,
    independent_strong_period_count,
    independent_weak_period_count,
    by_period: byPeriod,
    note:
      "Non-overlapping Meta windows (recent_7d / previous_7d / prior_16d). Only these support REPEATED_* codes.",
  };
}

function hasIndependentRepeatedWeakness(periodConsistency) {
  const ind = periodConsistency?.independent_period_evidence;
  if (!ind?.available) return false;
  return Number(ind.independent_weak_period_count) >= 2;
}

function hasIndependentRepeatedStrength(periodConsistency) {
  const ind = periodConsistency?.independent_period_evidence;
  if (!ind?.available) return false;
  return Number(ind.independent_strong_period_count) >= 2;
}

/**
 * @deprecated Prefer deriveTrailingWindowConsistency — kept for tests transitioning.
 */
function derivePerformanceDirection(byPeriod = {}) {
  const t = deriveTrailingWindowConsistency(byPeriod);
  return {
    performance_direction: t.trailing_direction,
    weak_period_count: t.weak_trailing_window_count,
    strong_period_count: t.strong_trailing_window_count,
    periods_compared: t.windows_compared,
    by_period: byPeriod,
    note: TRAILING_NOTE,
  };
}

function indexEntitiesById(entities = []) {
  const map = new Map();
  for (const e of entities) {
    if (e?.entity_id) map.set(String(e.entity_id), e);
  }
  return map;
}

/**
 * Attach trailing + independent period evidence to primary-period entities.
 *
 * @param {object[]} primaryEntities
 * @param {object} opts
 * @param {object} [opts.trailingIndexes] - { "7"|"14"|"30": Map }
 * @param {object} [opts.independentIndexes] - { recent_7d|previous_7d|prior_16d: Map }
 * @param {boolean} [opts.independentAvailable]
 */
function attachPeriodConsistency(primaryEntities, opts = {}) {
  // Back-compat: old signature attachPeriodConsistency(entities, periodIndexes)
  let trailingIndexes = opts.trailingIndexes;
  let independentIndexes = opts.independentIndexes || {};
  let independentAvailable = Boolean(opts.independentAvailable);

  if (
    trailingIndexes == null &&
    opts &&
    (opts["7"] || opts["14"] || opts["30"] || opts instanceof Map === false)
  ) {
    // Called as (entities, { "7": Map, ... }) — legacy
    if (!opts.trailingIndexes && !opts.independentIndexes) {
      trailingIndexes = opts;
      independentIndexes = {};
      independentAvailable = false;
    }
  }
  trailingIndexes = trailingIndexes || {};

  return (primaryEntities || []).map((e) => {
    const byWindow = {};
    for (const days of ["7", "14", "30"]) {
      const idx = trailingIndexes[days];
      if (!idx) continue;
      const other = idx.get(String(e.entity_id));
      if (other?.status) byWindow[days] = other.status;
    }
    if (e._period_days && e.status) {
      byWindow[String(e._period_days)] = e.status;
    }

    const byIndependent = {};
    if (independentAvailable) {
      for (const key of INDEPENDENT_KEYS) {
        const idx = independentIndexes[key];
        if (!idx) continue;
        const other = idx.get(String(e.entity_id));
        if (other?.status) byIndependent[key] = other.status;
      }
    }

    const trailing_window_consistency =
      deriveTrailingWindowConsistency(byWindow);

    let independent_period_evidence;
    if (!independentAvailable) {
      independent_period_evidence = deriveIndependentPeriodEvidence(
        {},
        { available: false }
      );
    } else {
      independent_period_evidence = deriveIndependentPeriodEvidence(
        byIndependent,
        { available: true }
      );
      // Ensure available stays true when windows were loaded even if entity sparse
      independent_period_evidence.available = true;
      if (Object.keys(byIndependent).length === 0) {
        independent_period_evidence.independent_periods_compared = 0;
        independent_period_evidence.independent_strong_period_count = 0;
        independent_period_evidence.independent_weak_period_count = 0;
        independent_period_evidence.note =
          "Independent windows loaded; entity absent or insufficient in non-overlapping buckets.";
      }
    }

    const period_consistency = {
      trailing_window_consistency,
      independent_period_evidence,
      performance_direction: trailing_window_consistency.trailing_direction,
      trailing_direction: trailing_window_consistency.trailing_direction,
      strong_trailing_window_count:
        trailing_window_consistency.strong_trailing_window_count,
      weak_trailing_window_count:
        trailing_window_consistency.weak_trailing_window_count,
      note: TRAILING_NOTE,
    };

    return { ...e, period_consistency };
  });
}

module.exports = {
  TRAILING_NOTE,
  INDEPENDENT_KEYS,
  statusStrength,
  buildIndependentWindowRanges,
  deriveTrailingWindowConsistency,
  deriveIndependentPeriodEvidence,
  derivePerformanceDirection,
  hasIndependentRepeatedWeakness,
  hasIndependentRepeatedStrength,
  indexEntitiesById,
  attachPeriodConsistency,
};
