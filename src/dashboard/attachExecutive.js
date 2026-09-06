/**
 * Attach Phase 10 forecast + Phase 11 executive OS onto a reporting bundle.
 * Read-only — never writes forecast into Books / Ledger / Shopify / Meta.
 */
const { daysInclusive, calendarMonthBounds, buildMonthForecast, buildInventoryForecast } = require("../forecasting");
const { buildExecutiveOperatingSystem } = require("../executive");
const { todayYmd } = require("../operations/dates");

function mapBundleToForecastSlice(bundle) {
  const books = bundle.books || {};
  const p = bundle.profitability || {};
  const meta = bundle.meta?.totals || {};
  return {
    revenue: books.net_revenue_ex_tax ?? null,
    orders: books.recognized_orders ?? null,
    gross_profit: books.gross_profit ?? null,
    meta_adjusted_profit: p.meta_adjusted_profit ?? null,
    meta_spend: meta.spend ?? null,
    aov: books.aov_ex_tax ?? null,
    profit_before_ads: p.profit_before_ads ?? null,
  };
}

function cogsOk(bundle) {
  const products = bundle.products || [];
  const incomplete = products.some(
    (p) =>
      p.status === "data_issue" ||
      p.reason_code === "missing_ledger_cogs" ||
      (Array.isArray(p.flags) &&
        p.flags.some((f) => /missing_ledger_cogs|missing_cost/i.test(String(f))))
  );
  return !incomplete;
}

/**
 * @param {object} bundle - unified reporting bundle (post phases 7–9 preferred)
 * @param {object} [options]
 * @param {object} [options.mtdBundle] - separate calendar MTD bundle (preferred)
 * @param {string} [options.as_of]
 * @param {number} [options.target_profit]
 * @param {string} [options.attribution_capture_started]
 */
function attachForecastAndExecutive(bundle, options = {}) {
  if (!bundle || typeof bundle !== "object") return bundle;

  const asOf =
    options.as_of ||
    bundle.date_range?.until ||
    todayYmd();
  const bounds = calendarMonthBounds(asOf);
  const period = bundle.date_range || {};
  const paceDays =
    period.since && period.until
      ? daysInclusive(period.since, period.until)
      : 0;

  const paceSlice = mapBundleToForecastSlice(bundle);
  let mtdSlice = paceSlice;
  let mtdNote =
    "MTD uses selected report period (proxy) — reload calendar month for true MTD.";

  const mtdBundle = options.mtdBundle;
  if (mtdBundle) {
    mtdSlice = mapBundleToForecastSlice(mtdBundle);
    mtdNote = `Calendar MTD ${bounds.since} → ${asOf} (separate load).`;
  } else if (
    period.since === bounds.since &&
    period.until &&
    period.until <= bounds.until
  ) {
    mtdNote = `Selected period starts on month-1 (${bounds.since}) — treated as MTD through ${period.until}.`;
  }

  const forecast = buildMonthForecast({
    mtd: mtdSlice,
    pace_period: {
      ...paceSlice,
      days: paceDays,
    },
    as_of: asOf,
    flags: {
      cogs_ok: cogsOk(bundle),
      volatile: Boolean(options.volatile),
    },
    target_profit: options.target_profit,
  });
  forecast.mtd_source_note = mtdNote;
  forecast.forecast_not_actual = true;

  const inventory_forecast = buildInventoryForecast(bundle.inventory || {});

  const executive = buildExecutiveOperatingSystem({
    bundle,
    forecast,
    period: bundle.date_range,
    attribution_capture_started: options.attribution_capture_started || null,
  });

  bundle.forecast = forecast;
  bundle.inventory_forecast = inventory_forecast;
  bundle.executive = executive;
  bundle.metric_registry_version = "phase-10-11";

  // Safety: never mutate accounting facts with forecast
  if (bundle.books) {
    bundle.books.forecast_values_never_written = true;
  }

  return bundle;
}

module.exports = {
  attachForecastAndExecutive,
  mapBundleToForecastSlice,
  cogsOk,
};
