/**
 * Deterministic forecasting (Phase 10).
 * FORECAST values are never written to Books / Shopify / Meta.
 */
const { round2 } = require("../books/tax");
const { safeDiv } = require("../meta/metrics");
const {
  addDaysYmd,
  assertYmd,
  todayYmd,
} = require("../operations/dates");

const SCENARIO_FACTORS = {
  CONSERVATIVE: { sales: 0.85, spend: 0.9, label: "Weaker sales pace" },
  BASE: { sales: 1.0, spend: 1.0, label: "Recent pace continues" },
  UPSIDE: { sales: 1.15, spend: 1.05, label: "Stronger sales; limited ad scale-up" },
};

function daysInclusive(since, until) {
  const a = assertYmd(since);
  const b = assertYmd(until);
  let n = 0;
  let cur = a;
  while (cur <= b) {
    n += 1;
    cur = addDaysYmd(cur, 1);
  }
  return n;
}

function calendarMonthBounds(ymd, timezone) {
  const d = assertYmd(ymd);
  const [y, m] = d.split("-").map(Number);
  const since = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextMonth =
    m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const monthEnd = addDaysYmd(nextMonth, -1);
  return { since, until: monthEnd, year: y, month: m };
}

function pace(total, days) {
  if (!(days > 0) || total == null || Number.isNaN(Number(total))) return null;
  return round2(Number(total) / days);
}

function projectRemaining(mtd, dailyPace, remainingDays, factor) {
  if (mtd == null && dailyPace == null) return null;
  const base = Number(mtd) || 0;
  if (dailyPace == null || !(remainingDays > 0)) return round2(base);
  return round2(base + dailyPace * remainingDays * factor);
}

function assessForecastConfidence({
  observed_days,
  history_days,
  books_orders,
  cogs_ok,
  volatile,
}) {
  const days = Number(observed_days) || 0;
  const orders = Number(books_orders) || 0;
  if (days < 3 || orders < 3) return "INSUFFICIENT";
  if (days < 7 || orders < 8 || !cogs_ok) return "LOW";
  if (volatile || days < 14) return "MEDIUM";
  if (days >= 14 && orders >= 15 && cogs_ok) return "HIGH";
  return "MEDIUM";
}

/**
 * Build month forecast from MTD actuals + observed pace.
 *
 * @param {object} input
 * @param {object} input.mtd - { revenue, orders, gross_profit, meta_adjusted_profit, meta_spend, aov }
 * @param {object} input.pace_period - trailing window used for pace { revenue, orders, gross_profit, meta_spend, days }
 * @param {string} input.as_of - YYYY-MM-DD
 * @param {object} [input.flags]
 */
function buildMonthForecast(input = {}) {
  const asOf = assertYmd(input.as_of || todayYmd());
  const bounds = calendarMonthBounds(asOf);
  const elapsed = daysInclusive(bounds.since, asOf <= bounds.until ? asOf : bounds.until);
  const remaining = Math.max(0, daysInclusive(bounds.since, bounds.until) - elapsed);

  const mtd = input.mtd || {};
  const paceSrc = input.pace_period || {};
  const paceDays = Number(paceSrc.days) || 0;

  const daily = {
    revenue: pace(paceSrc.revenue, paceDays),
    orders: pace(paceSrc.orders, paceDays),
    gross_profit: pace(paceSrc.gross_profit, paceDays),
    meta_spend: pace(paceSrc.meta_spend, paceDays),
    meta_adjusted_profit: pace(paceSrc.meta_adjusted_profit, paceDays),
  };

  const aov =
    mtd.aov != null
      ? Number(mtd.aov)
      : safeDiv(mtd.revenue, mtd.orders) != null
        ? round2(safeDiv(mtd.revenue, mtd.orders))
        : daily.revenue != null && daily.orders != null && daily.orders > 0
          ? round2(daily.revenue / daily.orders)
          : null;

  const confidence = assessForecastConfidence({
    observed_days: elapsed,
    history_days: paceDays,
    books_orders: mtd.orders || paceSrc.orders,
    cogs_ok: input.flags?.cogs_ok !== false,
    volatile: Boolean(input.flags?.volatile),
  });

  const scenarios = {};
  for (const [key, fac] of Object.entries(SCENARIO_FACTORS)) {
    const rev = projectRemaining(
      mtd.revenue,
      daily.revenue,
      remaining,
      fac.sales
    );
    const orders = projectRemaining(
      mtd.orders,
      daily.orders,
      remaining,
      fac.sales
    );
    const gp = projectRemaining(
      mtd.gross_profit,
      daily.gross_profit,
      remaining,
      fac.sales
    );
    const spend = projectRemaining(
      mtd.meta_spend,
      daily.meta_spend,
      remaining,
      fac.spend
    );
    const profit = projectRemaining(
      mtd.meta_adjusted_profit,
      daily.meta_adjusted_profit,
      remaining,
      fac.sales
    );

    scenarios[key] = {
      key,
      assumption: fac.label,
      projected_revenue: rev,
      projected_orders: orders == null ? null : round2(orders),
      projected_gross_profit: gp,
      projected_meta_spend: spend,
      projected_profit_after_meta: profit,
      note: `${fac.label}. Deterministic pace projection — not a guarantee.`,
    };
  }

  // Spend what-if: KNOWN spend change only; revenue UNKNOWN
  const baseSpend = scenarios.BASE.projected_meta_spend;
  const spend_scenarios = [-0.2, -0.1, 0.1, 0.2].map((delta) => ({
    label: `${delta > 0 ? "+" : ""}${Math.round(delta * 100)}% Meta spend`,
    delta_pct: delta * 100,
    projected_meta_spend:
      baseSpend == null ? null : round2(baseSpend * (1 + delta)),
    known: "additional or reduced Meta spend amount",
    unknown:
      "Incremental revenue/purchases are NOT projected — no causal ROAS assumed.",
  }));

  const target_profit = input.target_profit;
  let planning = null;
  if (target_profit != null && Number.isFinite(Number(target_profit))) {
    const gpMargin = safeDiv(mtd.gross_profit, mtd.revenue);
    const revenue_needed =
      gpMargin != null && gpMargin > 0
        ? round2(Number(target_profit) / gpMargin)
        : null;
    const orders_needed =
      revenue_needed != null && aov != null && aov > 0
        ? round2(revenue_needed / aov)
        : null;
    const max_affordable_meta =
      mtd.profit_before_ads != null
        ? round2(Number(mtd.profit_before_ads))
        : null;
    planning = {
      target_profit: Number(target_profit),
      revenue_required_rough: revenue_needed,
      orders_required_at_current_aov: orders_needed,
      max_affordable_meta_spend_mtd_buffer: max_affordable_meta,
      note:
        "Rough planning only. Revenue-for-profit uses current gross-margin pace; not a guarantee.",
    };
  }

  return {
    generated_at: new Date().toISOString(),
    advisory_only: true,
    forecast_not_actual: true,
    no_writes: true,
    as_of: asOf,
    calendar_month: {
      since: bounds.since,
      until: bounds.until,
      days_elapsed: elapsed,
      days_remaining: remaining,
      days_in_month: elapsed + remaining,
    },
    confidence,
    confidence_note:
      confidence === "INSUFFICIENT"
        ? "Too little history to project month-end reliably."
        : "Deterministic pace forecast — not statistical certainty.",
    month_to_date: {
      label: "ACTUAL (month-to-date)",
      revenue: mtd.revenue ?? null,
      orders: mtd.orders ?? null,
      gross_profit: mtd.gross_profit ?? null,
      meta_spend: mtd.meta_spend ?? null,
      profit_after_meta: mtd.meta_adjusted_profit ?? null,
      aov,
      profit_before_ads: mtd.profit_before_ads ?? null,
    },
    daily_pace: daily,
    pace_source: {
      days: paceDays,
      note: "Pace from trailing observation window — not independent of MTD when windows overlap.",
    },
    scenarios,
    spend_scenarios,
    planning,
    assumptions: [
      "Sales and spend pace from recent observations broadly continue unless scenario factor adjusts them.",
      "No causal claim that higher Meta spend produces proportional revenue.",
      "FORECAST values are not Books/Ledger/Shopify/Meta facts.",
    ],
  };
}

/**
 * Inventory planning signals from Phase 7 (no fake depletion from zero demand).
 */
function buildInventoryForecast(inventoryReport = {}) {
  const skus = inventoryReport.skus || [];
  const stockout_risks = (inventoryReport.stockout_risks || skus.filter(
    (s) =>
      ["OUT_OF_STOCK", "CRITICAL", "LOW"].includes(s.stock_class) &&
      (Number(s.units_sold_30d) || 0) > 0
  )).slice(0, 20);

  const slow = (inventoryReport.dead_slow_stock || skus.filter((s) =>
    ["NO_DEMAND", "NO_RECENT_DEMAND", "OVERSTOCK"].includes(s.stock_class)
  )).slice(0, 20);

  const cover_samples = skus
    .filter(
      (s) =>
        s.days_of_cover != null &&
        Number.isFinite(Number(s.days_of_cover)) &&
        (Number(s.units_sold_30d) || 0) > 0 &&
        s.stock_trusted !== false
    )
    .slice(0, 30)
    .map((s) => ({
      sku: s.sku,
      product: s.product,
      days_of_cover: s.days_of_cover,
      stock_class: s.stock_class,
      current_stock: s.current_stock,
    }));

  return {
    forecast_not_actual: true,
    capital_at_risk: inventoryReport.summary?.capital_at_risk_value ?? null,
    capital_at_risk_pct: inventoryReport.summary?.capital_at_risk_pct ?? null,
    stockout_risks: stockout_risks.map((s) => ({
      sku: s.sku,
      product: s.product,
      stock_class: s.stock_class,
      days_of_cover: s.days_of_cover,
      units_sold_30d: s.units_sold_30d,
      note:
        (Number(s.units_sold_30d) || 0) <= 0
          ? "Suppressed depletion forecast — insufficient demand evidence."
          : "Demand evidence present — review restock/cover.",
    })),
    slow_dead_stock: slow.map((s) => ({
      sku: s.sku,
      product: s.product,
      stock_class: s.stock_class,
      inventory_value: s.inventory_value,
    })),
    cover_where_evidence: cover_samples,
    note:
      "Stock depletion is not forecast from zero/insufficient demand. Capital figures are observed inventory cost.",
  };
}

module.exports = {
  SCENARIO_FACTORS,
  daysInclusive,
  calendarMonthBounds,
  pace,
  projectRemaining,
  assessForecastConfidence,
  buildMonthForecast,
  buildInventoryForecast,
};
