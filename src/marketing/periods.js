/**
 * Multi-period (7/14/30) performance consistency for Meta entities.
 */
const { MARKETING } = require("./thresholds");

function statusStrength(status) {
  if (MARKETING.STRONG_STATUSES.has(status)) return 2;
  if (status === "healthy" || status === "watch") return 1;
  if (status === "insufficient_data") return 0;
  if (MARKETING.WEAK_STATUSES.has(status)) return -2;
  return 0;
}

/**
 * @param {object} byPeriod - { "7": status, "14": status, "30": status }
 */
function derivePerformanceDirection(byPeriod = {}) {
  const entries = ["7", "14", "30"]
    .map((d) => ({ days: d, status: byPeriod[d] }))
    .filter((e) => e.status && e.status !== "insufficient_data");

  if (entries.length < 2) {
    return {
      performance_direction: "INSUFFICIENT",
      weak_period_count: entries.filter((e) =>
        MARKETING.WEAK_STATUSES.has(e.status)
      ).length,
      strong_period_count: entries.filter((e) =>
        MARKETING.STRONG_STATUSES.has(e.status)
      ).length,
      periods_compared: entries.length,
      by_period: byPeriod,
    };
  }

  const weak_period_count = entries.filter((e) =>
    MARKETING.WEAK_STATUSES.has(e.status)
  ).length;
  const strong_period_count = entries.filter((e) =>
    MARKETING.STRONG_STATUSES.has(e.status)
  ).length;

  // Compare shortest window (most recent-ish trailing) vs longest
  const short = entries[0];
  const long = entries[entries.length - 1];
  const delta = statusStrength(short.status) - statusStrength(long.status);

  let performance_direction = "STABLE";
  if (delta >= 2) performance_direction = "IMPROVING";
  else if (delta <= -2) performance_direction = "WORSENING";
  else if (weak_period_count >= 2) performance_direction = "WORSENING";
  else if (strong_period_count >= 2) performance_direction = "STABLE";

  return {
    performance_direction,
    weak_period_count,
    strong_period_count,
    periods_compared: entries.length,
    by_period: byPeriod,
  };
}

/**
 * Index classified entities by id for a period label.
 */
function indexEntitiesById(entities = []) {
  const map = new Map();
  for (const e of entities) {
    if (e?.entity_id) map.set(String(e.entity_id), e);
  }
  return map;
}

/**
 * Build period status maps for a list of primary-period entities.
 * @param {object[]} primaryEntities
 * @param {{ "7"?: Map, "14"?: Map, "30"?: Map }} periodIndexes
 */
function attachPeriodConsistency(primaryEntities, periodIndexes = {}) {
  return (primaryEntities || []).map((e) => {
    const byPeriod = {};
    for (const days of ["7", "14", "30"]) {
      const idx = periodIndexes[days];
      if (!idx) continue;
      const other = idx.get(String(e.entity_id));
      if (other?.status) byPeriod[days] = other.status;
    }
    // Always include primary if labeled
    if (e._period_days && e.status) {
      byPeriod[String(e._period_days)] = e.status;
    }
    const consistency = derivePerformanceDirection(byPeriod);
    return { ...e, period_consistency: consistency };
  });
}

module.exports = {
  derivePerformanceDirection,
  statusStrength,
  indexEntitiesById,
  attachPeriodConsistency,
};
