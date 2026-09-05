/**
 * Descriptive trend deltas across comparable snapshots only.
 * Does not alter Phase 3 classifiers.
 */
const { round2 } = require("../books/tax");
const { getPreviousSnapshot, getRecentSnapshots } = require("./history");

function safeDeltaPct(current, previous) {
  if (current == null || previous == null) return null;
  if (!(Number(previous) > 0) && !(Number(previous) < 0)) {
    if (Number(previous) === 0 && Number(current) === 0) return 0;
    return null;
  }
  return round2(((Number(current) - Number(previous)) / Math.abs(Number(previous))) * 100);
}

function metricTrend(currentSnap, previousSnap, pathFn, label) {
  const current = currentSnap ? pathFn(currentSnap) : null;
  if (!previousSnap) {
    return {
      label,
      comparable: false,
      reason: "no_prior_comparable_snapshot",
      current,
      previous: null,
      delta: null,
      delta_pct: null,
    };
  }
  if (Number(currentSnap.period?.days) !== Number(previousSnap.period?.days)) {
    return {
      label,
      comparable: false,
      reason: "not_comparable",
      current,
      previous: pathFn(previousSnap),
      delta: null,
      delta_pct: null,
    };
  }
  const previous = pathFn(previousSnap);
  const delta =
    current == null || previous == null
      ? null
      : round2(Number(current) - Number(previous));
  return {
    label,
    comparable: true,
    reason: "vs_previous_comparable_snapshot",
    current,
    previous,
    delta,
    delta_pct: safeDeltaPct(current, previous),
  };
}

function avg(values) {
  const nums = values.filter((v) => v != null && Number.isFinite(Number(v)));
  if (!nums.length) return null;
  return round2(nums.reduce((s, v) => s + Number(v), 0) / nums.length);
}

function buildTrends(currentSnapshot, history = []) {
  const previous = getPreviousSnapshot(history, currentSnapshot);
  const recent = getRecentSnapshots(history, {
    days: currentSnapshot.period?.days,
    limit: 7,
  });

  const paths = {
    meta_spend: (s) => s.meta?.spend,
    meta_cpa: (s) => s.meta?.cpa,
    meta_roas: (s) => s.meta?.roas,
    shopify_net_revenue: (s) => s.shopify?.net_revenue,
    shopify_contribution_after_meta: (s) => s.shopify?.contribution_after_meta,
    meta_adjusted_profit: (s) => s.business?.meta_adjusted_profit,
    recognized_orders: (s) => s.business?.recognized_orders,
    meta_adjusted_margin_pct: (s) => s.business?.meta_adjusted_margin_pct,
  };

  const metrics = {};
  for (const [key, fn] of Object.entries(paths)) {
    metrics[key] = metricTrend(currentSnapshot, previous, fn, key);
    const series = recent.map(fn);
    metrics[key].avg_7 = avg(series);
    const finite = series.filter((v) => v != null && Number.isFinite(Number(v)));
    metrics[key].min_7 = finite.length
      ? round2(Math.min(...finite.map(Number)))
      : null;
    metrics[key].max_7 = finite.length
      ? round2(Math.max(...finite.map(Number)))
      : null;
  }

  return {
    comparable: Boolean(previous),
    previous_reporting_date: previous?.reporting_date || null,
    period_days: currentSnapshot.period?.days || null,
    note: previous
      ? "vs previous comparable snapshot (same period.days)"
      : "No comparable prior snapshot available",
    metrics,
  };
}

module.exports = {
  safeDeltaPct,
  metricTrend,
  buildTrends,
};
