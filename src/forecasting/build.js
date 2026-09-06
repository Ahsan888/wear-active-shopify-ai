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
 * Reconciled: projected_profit_after_meta = projected_profit_before_ads − projected_meta_spend.
 * Pre-ad profit uses the sales scenario factor (pace estimate — not causal).
 * Meta spend uses the spend scenario factor. No causal revenue from spend.
 */
function reconcileScenarioProfit(projected_profit_before_ads, projected_meta_spend) {
  if (projected_profit_before_ads == null || projected_meta_spend == null) {
    return null;
  }
  return round2(
    Number(projected_profit_before_ads) - Number(projected_meta_spend)
  );
}

/**
 * Target planning — conservative.
 * Gross-profit revenue needs only observed GM.
 * Net / after-ads target revenue is suppressed (would invent opex + ad response).
 */
function buildTargetPlanning({
  target_profit,
  target_gross_profit,
  mtd = {},
  aov = null,
} = {}) {
  const gpMargin = safeDiv(mtd.gross_profit, mtd.revenue);
  const max_affordable_meta =
    mtd.profit_before_ads != null
      ? round2(Number(mtd.profit_before_ads))
      : null;

  const planning = {
    max_affordable_meta_spend_mtd_buffer: max_affordable_meta,
    revenue_required_for_target_profit: null,
    target_profit_revenue_suppressed: false,
    target_profit_suppression_reason: null,
    target_gross_profit: null,
    revenue_required_for_target_gross_profit: null,
    orders_required_at_current_aov: null,
    note: null,
  };

  const tgp =
    target_gross_profit != null && Number.isFinite(Number(target_gross_profit))
      ? Number(target_gross_profit)
      : null;

  if (tgp != null) {
    planning.target_gross_profit = tgp;
    if (gpMargin != null && gpMargin > 0) {
      const revenue_needed = round2(tgp / gpMargin);
      planning.revenue_required_for_target_gross_profit = revenue_needed;
      planning.orders_required_at_current_aov =
        aov != null && aov > 0 ? round2(revenue_needed / aov) : null;
      planning.note =
        "Revenue required for target gross profit uses observed gross margin only. Not net profit after ads/opex.";
    } else {
      planning.note =
        "Cannot estimate revenue for target gross profit — gross margin unavailable.";
    }
  }

  if (target_profit != null && Number.isFinite(Number(target_profit))) {
    planning.target_profit_after_meta = Number(target_profit);
    planning.revenue_required_for_target_profit = null;
    planning.target_profit_revenue_suppressed = true;
    planning.target_profit_suppression_reason =
      "Revenue required for net/after-ads target profit is suppressed — would invent fixed opex and causal Meta spend→revenue assumptions. Use target_gross_profit for a gross-profit revenue estimate, or compare scenario projected_profit_before_ads − projected_meta_spend.";
    if (!planning.note) {
      planning.note = planning.target_profit_suppression_reason;
    }
  }

  const hasAny =
    tgp != null ||
    (target_profit != null && Number.isFinite(Number(target_profit))) ||
    max_affordable_meta != null;
  return hasAny ? planning : null;
}

/**
 * Build month forecast from MTD actuals + observed pace.
 *
 * @param {object} input
 * @param {object} input.mtd - { revenue, orders, gross_profit, meta_adjusted_profit, meta_spend, aov, profit_before_ads }
 * @param {object} input.pace_period - trailing window for pace (include profit_before_ads)
 * @param {string} input.as_of - YYYY-MM-DD
 * @param {object} [input.flags]
 * @param {number} [input.target_profit] - net/after-ads; revenue path suppressed
 * @param {number} [input.target_gross_profit] - gross profit; revenue = target / GM
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
    profit_before_ads: pace(paceSrc.profit_before_ads, paceDays),
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
    // Pre-ad profit: sales-factor pace estimate (NOT causal from Meta spend)
    const pba = projectRemaining(
      mtd.profit_before_ads,
      daily.profit_before_ads,
      remaining,
      fac.sales
    );
    const profit_after = reconcileScenarioProfit(pba, spend);

    scenarios[key] = {
      key,
      assumption: fac.label,
      projected_revenue: rev,
      projected_orders: orders == null ? null : round2(orders),
      projected_gross_profit: gp,
      projected_profit_before_ads: pba,
      projected_meta_spend: spend,
      projected_profit_after_meta: profit_after,
      note:
        `${fac.label}. Deterministic pace projection — not a guarantee. ` +
        `Projected pre-ad profit is a sales-pace estimate, not a causal/statistical forecast. ` +
        `Profit after Meta = projected pre-ad profit − projected Meta spend.`,
    };
  }

  // Spend what-if: KNOWN spend change only; revenue UNKNOWN
  const baseSpend = scenarios.BASE.projected_meta_spend;
  const basePba = scenarios.BASE.projected_profit_before_ads;
  const spend_scenarios = [-0.2, -0.1, 0.1, 0.2].map((delta) => {
    const projected_meta_spend =
      baseSpend == null ? null : round2(baseSpend * (1 + delta));
    return {
      label: `${delta > 0 ? "+" : ""}${Math.round(delta * 100)}% Meta spend`,
      delta_pct: delta * 100,
      projected_meta_spend,
      // Hold base pre-ad profit — do NOT invent revenue from spend change
      projected_profit_before_ads: basePba,
      projected_profit_after_meta: reconcileScenarioProfit(basePba, projected_meta_spend),
      known: "additional or reduced Meta spend amount",
      unknown:
        "Incremental revenue/purchases are NOT projected — no causal ROAS assumed. Pre-ad profit held at base pace.",
    };
  });

  const planning = buildTargetPlanning({
    target_profit: input.target_profit,
    target_gross_profit: input.target_gross_profit,
    mtd,
    aov,
  });

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
      "Projected pre-ad profit is a deterministic sales-pace estimate — not causal or statistical.",
      "Projected profit after Meta = projected pre-ad profit − projected Meta spend (reconciled per scenario).",
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
  reconcileScenarioProfit,
  buildTargetPlanning,
  buildMonthForecast,
  buildInventoryForecast,
};
