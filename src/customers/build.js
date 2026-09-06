/**
 * Assemble Phase 6 customer & cohort economics report.
 */
const { round2 } = require("../books/tax");
const { assertYmd } = require("../operations/dates");
const {
  buildRecognizedCustomerOrders,
  assignOrderSequences,
} = require("./orders");
const {
  buildCustomerValues,
  attachFirstOrderEconomics,
  buildRepurchaseStats,
  buildMonthlyCohorts,
  buildAcquisitionCohorts,
  buildNewVsReturning,
  buildPeriodSummary,
} = require("./metrics");
const { buildObservedCac } = require("./cac");

function detectCustomerIdCollisions(rows = []) {
  // Same shopify customer id under different keys should not happen;
  // flag if same order_id appears twice (already prevented) or key maps inconsistently.
  const byCustId = new Map();
  const collisions = [];
  for (const row of rows) {
    if (!row.shopify_customer_id) continue;
    const prev = byCustId.get(row.shopify_customer_id);
    if (prev && prev !== row.customer_key) {
      collisions.push({
        shopify_customer_id: row.shopify_customer_id,
        keys: [prev, row.customer_key],
      });
    }
    byCustId.set(row.shopify_customer_id, row.customer_key);
  }
  return collisions;
}

function reportConfidence({ summary, repurchase, cohorts, cac }) {
  const identified = summary.recognized_customers_identified || 0;
  const repeat = summary.repeat_customer_rate_pct;
  const matureCohorts = (cohorts || []).filter(
    (c) => c.repeat_by_90d?.matured
  ).length;
  const cacConf = cac?.confidence || "insufficient";

  if (identified < 5) return "insufficient";
  if (identified < 20 || cacConf === "insufficient") return "low";
  if (identified >= 50 && matureCohorts >= 1 && (repeat == null || repeat >= 0)) {
    if (cacConf === "high" || cacConf === "medium") return "medium";
  }
  if (identified >= 100 && matureCohorts >= 2 && cacConf === "high") return "high";
  return "low";
}

/**
 * @param {object} input
 * @param {object[]} input.orders - Shopify GraphQL orders (history window)
 * @param {Map} input.ledgerByOrderId - recognized economics for history window
 * @param {{ since: string, until: string }} input.period - analysis period
 * @param {number} [input.meta_spend_total]
 * @param {number} [input.attribution_coverage_pct]
 * @param {string} [input.capture_started_at]
 * @param {{ since: string, until: string }} [input.history] - fetch window
 */
function buildCustomerEconomics(input = {}) {
  const periodSince = assertYmd(input.period?.since, "period.since");
  const periodUntil = assertYmd(input.period?.until, "period.until");

  const built = buildRecognizedCustomerOrders({
    orders: input.orders || [],
    ledgerByOrderId: input.ledgerByOrderId,
    capture_started_at: input.capture_started_at,
  });

  const allRows = assignOrderSequences(built.rows);
  const periodRows = allRows.filter(
    (r) => r.order_date >= periodSince && r.order_date <= periodUntil
  );

  let customers = buildCustomerValues(allRows, periodUntil);
  customers = attachFirstOrderEconomics(customers, allRows);

  const customersTouchingPeriod = customers.filter((c) =>
    periodRows.some((r) => r.customer_key === c.customer_key)
  );

  const summary = buildPeriodSummary(
    periodRows,
    customersTouchingPeriod,
    customers
  );
  const newVsReturning = buildNewVsReturning(periodRows);
  const repurchase = buildRepurchaseStats(
    customers.filter((c) => c.identified),
    periodUntil
  );
  const cohorts = buildMonthlyCohorts(
    customers.filter((c) => c.identified),
    periodUntil
  );
  const acquisitionCohorts = buildAcquisitionCohorts(
    customers.filter((c) => c.identified)
  );

  const cac = buildObservedCac({
    customers: customers.filter((c) => c.identified),
    periodSince,
    periodUntil,
    metaSpendTotal: input.meta_spend_total || 0,
    attributionCoveragePct: input.attribution_coverage_pct,
  });

  const collisions = detectCustomerIdCollisions(allRows);
  const immature = cohorts
    .filter((c) => !c.repeat_by_90d?.matured)
    .map((c) => c.cohort);

  // Observed customer value summary (identified, touching period)
  const identifiedTouching = customersTouchingPeriod.filter((c) => c.identified);
  const observedValue = {
    label: "OBSERVED CUSTOMER VALUE",
    note: "Not a predictive LTV. Based on recognized Shopify purchase history only.",
    customers: identifiedTouching.length,
    average_orders:
      identifiedTouching.length > 0
        ? round2(
            identifiedTouching.reduce((s, c) => s + c.recognized_orders, 0) /
              identifiedTouching.length
          )
        : null,
    average_revenue:
      identifiedTouching.length > 0
        ? round2(
            identifiedTouching.reduce(
              (s, c) => s + c.lifetime_recognized_revenue,
              0
            ) / identifiedTouching.length
          )
        : null,
    average_gp:
      identifiedTouching.length > 0
        ? round2(
            identifiedTouching.reduce((s, c) => s + c.lifetime_gp, 0) /
              identifiedTouching.length
          )
        : null,
    top_customers: identifiedTouching.slice(0, 25).map((c) => ({
      customer_key: c.customer_key,
      identity_type: c.identity_type,
      recognized_orders: c.recognized_orders,
      lifetime_recognized_revenue: c.lifetime_recognized_revenue,
      lifetime_gp: c.lifetime_gp,
      first_order_date: c.first_order_date,
      latest_order_date: c.latest_order_date,
      repeat_customer: c.repeat_customer,
      cohort_month: c.cohort_month,
      first_order_acquisition: c.first_order_acquisition,
    })),
  };

  const strongestMature = [...cohorts]
    .filter((c) => c.repeat_by_60d?.matured)
    .sort(
      (a, b) =>
        (b.gp_per_customer || 0) - (a.gp_per_customer || 0) ||
        (b.repeat_rate_pct || 0) - (a.repeat_rate_pct || 0)
    )[0] || null;

  const confidence = reportConfidence({
    summary,
    repurchase,
    cohorts,
    cac,
  });

  const warnings = [];
  if (built.data_quality.guest_order_count) {
    warnings.push(
      `guest_orders:${built.data_quality.guest_order_count} (not merged across checkouts)`
    );
  }
  if (built.data_quality.recognized_orders_missing_shopify_match.length) {
    warnings.push(
      `recognized_ledger_orders_missing_shopify_fetch:${built.data_quality.recognized_orders_missing_shopify_match.length}`
    );
  }
  if (built.data_quality.missing_cogs_order_ids.length) {
    warnings.push(
      `missing_cogs_orders:${built.data_quality.missing_cogs_order_ids.length}`
    );
  }
  if (collisions.length) {
    warnings.push(`customer_id_collisions:${collisions.length}`);
  }
  if (immature.length) {
    warnings.push(`immature_cohorts_90d:${immature.join(",")}`);
  }

  return {
    generated_at: new Date().toISOString(),
    advisory_only: true,
    period: { since: periodSince, until: periodUntil },
    history: input.history || null,
    confidence,
    definitions: {
      recognized_order:
        "Shopify order with ≥1 recognized Ledger Sale in the history window (gift/PR excluded).",
      new_order: "order_sequence === 1 in customer's recognized history.",
      returning_order: "order_sequence >= 2.",
      repeat_customer: "identified customer with ≥2 recognized orders.",
      repeat_customer_rate:
        "identified customers in period who are repeat customers / identified customers in period.",
      observed_customer_value:
        "Sum of recognized economics to date — not predictive LTV.",
      first_party_observed_new_customer_cac:
        "Period Meta spend / Meta-acquired new customers (first order in period).",
    },
    summary,
    new_vs_returning: newVsReturning,
    observed_customer_value: observedValue,
    repurchase,
    cohorts,
    strongest_mature_cohort: strongestMature,
    acquisition_cohorts: acquisitionCohorts,
    observed_cac: cac,
    // Keep full customer list available for JSON but strip if huge — include identified only
    customers: customers.filter((c) => c.identified),
    period_orders: periodRows.map((r) => ({
      order_id: r.order_id,
      order_date: r.order_date,
      customer_key: r.customer_key,
      identity_type: r.identity_type,
      new_or_returning: r.new_or_returning,
      order_sequence: r.order_sequence,
      net_revenue_ex_tax: r.net_revenue_ex_tax,
      cogs: r.cogs,
      gross_profit: r.gross_profit,
      units: r.units,
      acquisition: r.acquisition,
    })),
    data_quality: {
      ...built.data_quality,
      customer_id_collisions: collisions,
      immature_cohorts: immature,
      warnings,
    },
    sources: {
      orders: "Shopify GraphQL orders (customer.id + hashed email fallback)",
      economics: "Books Ledger recognized Sale/COGS via ledgerJoin",
      attribution: "normalizeOrderAttribution first-party status on first order",
      meta_spend: "Decision/Meta period spend (read-only)",
    },
  };
}

module.exports = {
  buildCustomerEconomics,
  detectCustomerIdCollisions,
  reportConfidence,
};
