/**
 * Observed customer value + repurchase + cohort builders.
 */
const { round2 } = require("../books/tax");
const { isIdentifiedCustomer } = require("./identity");
const {
  daysBetweenYmd,
  monthKey,
  median,
  average,
  cohortCheckpointMature,
} = require("./dates");

function emptyBucket() {
  return {
    orders: 0,
    revenue: 0,
    cogs: 0,
    gross_profit: 0,
    units: 0,
  };
}

function finalizeBucket(b) {
  const orders = b.orders;
  const revenue = round2(b.revenue);
  const cogs = round2(b.cogs);
  const gp = round2(b.gross_profit);
  return {
    orders,
    revenue,
    cogs,
    gross_profit: gp,
    gross_margin_pct: revenue > 0 ? round2((gp / revenue) * 100) : null,
    units: round2(b.units),
    aov: orders > 0 ? round2(revenue / orders) : null,
    gp_per_order: orders > 0 ? round2(gp / orders) : null,
    units_per_order: orders > 0 ? round2(b.units / orders) : null,
  };
}

function addToBucket(b, row) {
  b.orders += 1;
  b.revenue += Number(row.net_revenue_ex_tax) || 0;
  b.cogs += Number(row.cogs) || 0;
  b.gross_profit += Number(row.gross_profit) || 0;
  b.units += Number(row.units) || 0;
}

/**
 * Build per-customer observed value from full history rows.
 */
function buildCustomerValues(allRows = [], asOfUntil) {
  const byKey = new Map();
  for (const row of allRows) {
    if (!byKey.has(row.customer_key)) {
      byKey.set(row.customer_key, {
        customer_key: row.customer_key,
        identity_type: row.identity_type,
        orders: [],
      });
    }
    byKey.get(row.customer_key).orders.push(row);
  }

  const customers = [];
  for (const c of byKey.values()) {
    c.orders.sort((a, b) =>
      a.order_date === b.order_date
        ? String(a.order_id).localeCompare(String(b.order_id))
        : a.order_date.localeCompare(b.order_date)
    );
    const first = c.orders[0];
    const last = c.orders[c.orders.length - 1];
    const revenue = c.orders.reduce(
      (s, o) => s + (Number(o.net_revenue_ex_tax) || 0),
      0
    );
    const cogs = c.orders.reduce((s, o) => s + (Number(o.cogs) || 0), 0);
    const gp = c.orders.reduce((s, o) => s + (Number(o.gross_profit) || 0), 0);
    const units = c.orders.reduce((s, o) => s + (Number(o.units) || 0), 0);
    const n = c.orders.length;
    const identified = isIdentifiedCustomer(c.identity_type);

    let daysToSecond = null;
    const gaps = [];
    for (let i = 1; i < c.orders.length; i += 1) {
      const d = daysBetweenYmd(c.orders[i - 1].order_date, c.orders[i].order_date);
      gaps.push(d);
      if (i === 1) daysToSecond = d;
    }

    customers.push({
      customer_key: c.customer_key,
      identity_type: c.identity_type,
      identified,
      first_order_date: first.order_date,
      latest_order_date: last.order_date,
      first_order_acquisition: first.acquisition,
      first_order_meta_campaign_id: first.meta_campaign_id,
      first_order_meta_ad_id: first.meta_ad_id,
      recognized_orders: n,
      lifetime_recognized_revenue: round2(revenue),
      lifetime_cogs: round2(cogs),
      lifetime_gp: round2(gp),
      lifetime_units: round2(units),
      average_order_value: n > 0 ? round2(revenue / n) : null,
      average_gp_per_order: n > 0 ? round2(gp / n) : null,
      days_since_first_order: daysBetweenYmd(first.order_date, asOfUntil),
      days_since_latest_order: daysBetweenYmd(last.order_date, asOfUntil),
      repeat_customer: identified && n >= 2,
      days_to_second_order: daysToSecond,
      days_between_orders: gaps,
      cohort_month: monthKey(first.order_date),
    });
  }

  return customers.sort((a, b) =>
    b.lifetime_recognized_revenue - a.lifetime_recognized_revenue
  );
}

function buildRepurchaseStats(customers = [], asOfUntil) {
  const identified = customers.filter((c) => c.identified);
  const withSecond = identified.filter(
    (c) => c.days_to_second_order != null
  );
  const days = withSecond.map((c) => c.days_to_second_order);

  function rateWithin(daysLimit) {
    const eligible = identified.filter(
      (c) => c.days_since_first_order >= daysLimit
    );
    if (!eligible.length) return { eligible: 0, repeated: 0, rate_pct: null };
    const repeated = eligible.filter(
      (c) =>
        c.days_to_second_order != null && c.days_to_second_order <= daysLimit
    ).length;
    return {
      eligible: eligible.length,
      repeated,
      rate_pct: round2((repeated / eligible.length) * 100),
    };
  }

  return {
    customers_with_2plus_orders: withSecond.length,
    median_days_to_second_order: median(days) == null ? null : round2(median(days)),
    average_days_to_second_order:
      average(days) == null ? null : round2(average(days)),
    repeat_within_30d: rateWithin(30),
    repeat_within_60d: rateWithin(60),
    repeat_within_90d: rateWithin(90),
    as_of: asOfUntil,
  };
}

function buildMonthlyCohorts(customers = [], asOfUntil) {
  const byMonth = new Map();
  for (const c of customers) {
    if (!c.identified) continue;
    const m = c.cohort_month;
    if (!m) continue;
    if (!byMonth.has(m)) {
      byMonth.set(m, {
        cohort: m,
        customers: [],
      });
    }
    byMonth.get(m).customers.push(c);
  }

  const cohorts = [];
  for (const [month, bucket] of [...byMonth.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const list = bucket.customers;
    const n = list.length;
    const firstRev = round2(
      list.reduce((s, c) => {
        // approximate first-order revenue from lifetime / not stored — use avg *1 from first only
        // We need first-order revenue: store on customer or recompute. Use lifetime if 1 order else we don't have first-only here.
        return s;
      }, 0)
    );
    // Prefer fields if present; else 0 and note — we'll set first_order_revenue from customer helper
    let firstOrderRevenue = 0;
    let totalRev = 0;
    let totalGp = 0;
    let totalOrders = 0;
    let repeatCustomers = 0;
    for (const c of list) {
      firstOrderRevenue += Number(c.first_order_revenue) || 0;
      totalRev += Number(c.lifetime_recognized_revenue) || 0;
      totalGp += Number(c.lifetime_gp) || 0;
      totalOrders += Number(c.recognized_orders) || 0;
      if (c.repeat_customer) repeatCustomers += 1;
    }

    function checkpoint(days) {
      if (!cohortCheckpointMature(month, asOfUntil, days)) {
        return { matured: false, rate_pct: null, eligible: null, repeated: null };
      }
      const eligible = list.filter((c) => c.days_since_first_order >= days);
      const repeated = eligible.filter(
        (c) =>
          c.days_to_second_order != null && c.days_to_second_order <= days
      ).length;
      return {
        matured: true,
        eligible: eligible.length,
        repeated,
        rate_pct:
          eligible.length > 0
            ? round2((repeated / eligible.length) * 100)
            : null,
      };
    }

    cohorts.push({
      cohort: month,
      customers: n,
      first_order_revenue: round2(firstOrderRevenue),
      total_observed_revenue: round2(totalRev),
      total_gp: round2(totalGp),
      repeat_customers: repeatCustomers,
      repeat_rate_pct: n > 0 ? round2((repeatCustomers / n) * 100) : null,
      orders_per_customer: n > 0 ? round2(totalOrders / n) : null,
      revenue_per_customer: n > 0 ? round2(totalRev / n) : null,
      gp_per_customer: n > 0 ? round2(totalGp / n) : null,
      repeat_by_30d: checkpoint(30),
      repeat_by_60d: checkpoint(60),
      repeat_by_90d: checkpoint(90),
    });
  }

  return cohorts;
}

function attachFirstOrderEconomics(customers, allRows) {
  const firstByCustomer = new Map();
  for (const row of allRows) {
    if (row.order_sequence !== 1) continue;
    firstByCustomer.set(row.customer_key, row);
  }
  for (const c of customers) {
    const first = firstByCustomer.get(c.customer_key);
    c.first_order_revenue = first ? Number(first.net_revenue_ex_tax) || 0 : 0;
    c.first_order_gp = first ? Number(first.gross_profit) || 0 : 0;
    c.first_order_cogs = first ? Number(first.cogs) || 0 : 0;
  }
  return customers;
}

function buildAcquisitionCohorts(customers = []) {
  const byAcq = new Map();
  for (const c of customers) {
    if (!c.identified) continue;
    const key = c.first_order_acquisition || "unknown";
    if (!byAcq.has(key)) {
      byAcq.set(key, {
        acquisition: key,
        customers: 0,
        revenue: 0,
        gp: 0,
        orders: 0,
        repeat_customers: 0,
      });
    }
    const b = byAcq.get(key);
    b.customers += 1;
    b.revenue += Number(c.lifetime_recognized_revenue) || 0;
    b.gp += Number(c.lifetime_gp) || 0;
    b.orders += Number(c.recognized_orders) || 0;
    if (c.repeat_customer) b.repeat_customers += 1;
  }

  return [...byAcq.values()]
    .map((b) => ({
      acquisition: b.acquisition,
      customers: b.customers,
      total_observed_revenue: round2(b.revenue),
      total_gp: round2(b.gp),
      orders_per_customer:
        b.customers > 0 ? round2(b.orders / b.customers) : null,
      revenue_per_customer:
        b.customers > 0 ? round2(b.revenue / b.customers) : null,
      gp_per_customer: b.customers > 0 ? round2(b.gp / b.customers) : null,
      repeat_rate_pct:
        b.customers > 0
          ? round2((b.repeat_customers / b.customers) * 100)
          : null,
    }))
    .sort((a, b) => b.customers - a.customers);
}

function buildNewVsReturning(periodRows = []) {
  const neu = emptyBucket();
  const ret = emptyBucket();
  for (const row of periodRows) {
    if (row.new_or_returning === "new") addToBucket(neu, row);
    else if (row.new_or_returning === "returning") addToBucket(ret, row);
  }
  return {
    new_customer_orders: finalizeBucket(neu),
    returning_customer_orders: finalizeBucket(ret),
  };
}

function buildPeriodSummary(periodRows, customersTouchingPeriod, allCustomers) {
  const identifiedKeys = new Set(
    customersTouchingPeriod.filter((c) => c.identified).map((c) => c.customer_key)
  );
  const guestKeys = new Set(
    periodRows
      .filter((r) => !isIdentifiedCustomer(r.identity_type))
      .map((r) => r.customer_key)
  );

  let newCustomers = 0;
  let returningCustomers = 0;
  for (const key of identifiedKeys) {
    const c = allCustomers.find((x) => x.customer_key === key);
    if (!c) continue;
    // In-period: new if any period order is sequence 1; returning if any is returning
    const periodOrders = periodRows.filter((r) => r.customer_key === key);
    const hasNew = periodOrders.some((r) => r.new_or_returning === "new");
    const hasRet = periodOrders.some((r) => r.new_or_returning === "returning");
    if (hasNew) newCustomers += 1;
    if (hasRet) returningCustomers += 1;
  }

  const firstOrders = periodRows.filter((r) => r.order_sequence === 1).length;
  const repeatOrders = periodRows.filter((r) => r.order_sequence > 1).length;

  const revenue = periodRows.reduce(
    (s, r) => s + (Number(r.net_revenue_ex_tax) || 0),
    0
  );
  const cogs = periodRows.reduce((s, r) => s + (Number(r.cogs) || 0), 0);
  const gp = periodRows.reduce((s, r) => s + (Number(r.gross_profit) || 0), 0);

  const identifiedCustomerCount = identifiedKeys.size;
  const repeatCustomerCount = [...identifiedKeys].filter((key) => {
    const c = allCustomers.find((x) => x.customer_key === key);
    return c && c.repeat_customer;
  }).length;

  return {
    recognized_orders: periodRows.length,
    recognized_customers_identified: identifiedCustomerCount,
    new_customers: newCustomers,
    returning_customers: returningCustomers,
    guest_unknown_customers: guestKeys.size,
    first_orders: firstOrders,
    repeat_orders: repeatOrders,
    revenue: round2(revenue),
    cogs: round2(cogs),
    gross_profit: round2(gp),
    gross_margin_pct: revenue > 0 ? round2((gp / revenue) * 100) : null,
    aov: periodRows.length ? round2(revenue / periodRows.length) : null,
    gp_per_order: periodRows.length ? round2(gp / periodRows.length) : null,
    revenue_per_identified_customer:
      identifiedCustomerCount > 0
        ? round2(revenue / identifiedCustomerCount)
        : null,
    gp_per_identified_customer:
      identifiedCustomerCount > 0
        ? round2(gp / identifiedCustomerCount)
        : null,
    // Repeat customer rate = identified customers with ≥2 lifetime orders / identified customers in period
    repeat_customer_rate_pct:
      identifiedCustomerCount > 0
        ? round2((repeatCustomerCount / identifiedCustomerCount) * 100)
        : null,
    repeat_order_share_pct:
      periodRows.length > 0
        ? round2((repeatOrders / periodRows.length) * 100)
        : null,
    guest_order_share_pct:
      periodRows.length > 0
        ? round2(
            (periodRows.filter((r) => !isIdentifiedCustomer(r.identity_type))
              .length /
              periodRows.length) *
              100
          )
        : null,
  };
}

module.exports = {
  buildCustomerValues,
  attachFirstOrderEconomics,
  buildRepurchaseStats,
  buildMonthlyCohorts,
  buildAcquisitionCohorts,
  buildNewVsReturning,
  buildPeriodSummary,
  emptyBucket,
  finalizeBucket,
  addToBucket,
};
