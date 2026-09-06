/**
 * Assemble Phase 6 customer & cohort economics report.
 */
const { round2 } = require("../books/tax");
const { assertYmd } = require("../operations/dates");
const { daysBetweenYmd } = require("./dates");
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

const HISTORY_JOIN_COMPLETE_PCT = 95;

function detectCustomerIdCollisions(rows = []) {
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

function computeHistoryJoinCoverage(joinedRows, ledgerByOrderId, missingIds) {
  let ledgerRecognized = 0;
  for (const econ of ledgerByOrderId?.values?.() || []) {
    if (econ?.has_sale) ledgerRecognized += 1;
  }
  const joinedLedgerIds = new Set(
    (joinedRows || []).map((r) => String(r.order_id))
  );
  let matched = 0;
  const missing = [];
  for (const [orderId, econ] of ledgerByOrderId || []) {
    if (!econ?.has_sale) continue;
    if (joinedLedgerIds.has(String(orderId))) matched += 1;
    else missing.push(orderId);
  }
  // Prefer recomputed missing; fall back to provided list length for tests
  const missingList = missing.length ? missing : missingIds || [];
  const coveragePct =
    ledgerRecognized > 0 ? round2((matched / ledgerRecognized) * 100) : null;
  const incomplete =
    coveragePct == null
      ? false
      : coveragePct < HISTORY_JOIN_COMPLETE_PCT || missingList.length > 0;
  return {
    ledger_recognized_shopify_orders: ledgerRecognized,
    joined_recognized_shopify_orders: matched,
    recognized_orders_missing_shopify_match_count: missingList.length,
    history_join_coverage_pct: coveragePct,
    history_incomplete: incomplete,
  };
}

function reportConfidence({
  summary,
  cohorts,
  cac,
  historyJoin,
}) {
  const identified = summary.recognized_customers_identified || 0;
  const matureCohorts = (cohorts || []).filter(
    (c) => c.repeat_by_90d?.matured
  ).length;
  const cacConf = cac?.confidence || "insufficient";

  let conf = "low";
  if (identified < 5) conf = "insufficient";
  else if (identified < 20 || cacConf === "insufficient") conf = "low";
  else if (
    identified >= 50 &&
    matureCohorts >= 1 &&
    (cacConf === "high" || cacConf === "medium")
  ) {
    conf = "medium";
  } else if (identified >= 100 && matureCohorts >= 2 && cacConf === "high") {
    conf = "high";
  }

  if (historyJoin?.history_incomplete) {
    if (conf === "high") conf = "medium";
    else if (conf === "medium") conf = "low";
    // already low/insufficient stays
  }
  return conf;
}

/**
 * @param {object} input
 */
function buildCustomerEconomics(input = {}) {
  const periodSince = assertYmd(input.period?.since, "period.since");
  const periodUntil = assertYmd(input.period?.until, "period.until");

  let historySince = input.history?.since || null;
  let historyUntil = input.history?.until || periodUntil;
  if (historySince) assertYmd(historySince, "history.since");
  if (historyUntil) assertYmd(historyUntil, "history.until");
  const historyDays =
    historySince && historyUntil
      ? daysBetweenYmd(historySince, historyUntil) + 1
      : null;

  const built = buildRecognizedCustomerOrders({
    orders: input.orders || [],
    ledgerByOrderId: input.ledgerByOrderId,
    capture_started_at: input.capture_started_at,
  });

  const allRows = assignOrderSequences(built.rows);
  const periodRows = allRows.filter(
    (r) => r.order_date >= periodSince && r.order_date <= periodUntil
  );

  const historyJoin = computeHistoryJoinCoverage(
    allRows,
    input.ledgerByOrderId,
    built.data_quality.recognized_orders_missing_shopify_match
  );
  // Keep missing ID list in sync with recomputed coverage
  if (
    historyJoin.recognized_orders_missing_shopify_match_count !==
    built.data_quality.recognized_orders_missing_shopify_match.length
  ) {
    // Recompute missing list from ledger for data_quality accuracy
    const joinedIds = new Set(allRows.map((r) => String(r.order_id)));
    const missing = [];
    for (const [orderId, econ] of input.ledgerByOrderId || []) {
      if (!econ?.has_sale) continue;
      if (!joinedIds.has(String(orderId))) missing.push(orderId);
    }
    built.data_quality.recognized_orders_missing_shopify_match = missing;
  }

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

  // Always pass coverage through (may be null when zero post_capture recognized)
  const attributionCoveragePct =
    input.attribution_coverage_pct === undefined
      ? null
      : input.attribution_coverage_pct;

  const cac = buildObservedCac({
    customers: customers.filter((c) => c.identified),
    periodSince,
    periodUntil,
    metaSpendTotal: input.meta_spend_total || 0,
    attributionCoveragePct,
  });

  const collisions = detectCustomerIdCollisions(allRows);
  const immature = cohorts
    .filter((c) => !c.repeat_by_90d?.matured)
    .map((c) => c.cohort);

  const identifiedTouching = customersTouchingPeriod.filter((c) => c.identified);
  const observedValue = {
    label: "OBSERVED CUSTOMER VALUE",
    note:
      "Not a predictive LTV. Based on recognized Shopify purchase history within the loaded history window only.",
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
      first_order_attribution_phase: c.first_order_attribution_phase,
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
    cohorts,
    cac,
    historyJoin,
  });

  const warnings = [];
  if (built.data_quality.guest_order_count) {
    warnings.push(
      `guest_orders:${built.data_quality.guest_order_count} (not merged across checkouts)`
    );
  }
  if (historyJoin.recognized_orders_missing_shopify_match_count) {
    warnings.push(
      `recognized_orders_missing_shopify_match:${historyJoin.recognized_orders_missing_shopify_match_count}`
    );
  }
  if (historyJoin.history_incomplete) {
    warnings.push(
      `history_incomplete:join_coverage=${historyJoin.history_join_coverage_pct}% — do not claim true first-order certainty`
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
    history: {
      history_since: historySince,
      history_until: historyUntil,
      history_days: historyDays,
    },
    confidence,
    definitions: {
      recognized_order:
        "Shopify order with ≥1 recognized Ledger Sale in the history window (gift/PR excluded).",
      new_in_observed_history:
        "First recognized Shopify order observed within the loaded customer history window — not proven lifetime-first.",
      returning_in_observed_history:
        "Subsequent recognized order for the same customer key within loaded history.",
      repeat_customer:
        "Identified customer with ≥2 recognized orders in observed history.",
      repeat_customer_rate:
        "Identified customers in period who are repeat customers / identified customers in period.",
      observed_customer_value:
        "Sum of recognized economics in observed history — not predictive LTV.",
      first_party_observed_new_customer_cac:
        "Period Meta spend / identified customers whose first order in period is post_capture Meta first-party. Pre-capture Meta excluded.",
    },
    summary: {
      ...summary,
      ...historyJoin,
    },
    new_vs_returning: newVsReturning,
    observed_customer_value: observedValue,
    repurchase,
    cohorts,
    strongest_mature_cohort: strongestMature,
    acquisition_cohorts: acquisitionCohorts,
    observed_cac: cac,
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
      attribution_phase: r.attribution_phase,
    })),
    data_quality: {
      ...built.data_quality,
      ...historyJoin,
      recognized_orders_missing_shopify_match:
        built.data_quality.recognized_orders_missing_shopify_match,
      customer_id_collisions: collisions,
      immature_cohorts: immature,
      warnings,
    },
    sources: {
      orders: "Shopify GraphQL orders (customer.id + hashed email fallback)",
      economics: "Books Ledger recognized Sale/COGS via ledgerJoin",
      attribution:
        "normalizeOrderAttribution; CAC uses post_capture Meta first-party only",
      meta_spend: "Decision/Meta period spend (read-only)",
      attribution_coverage:
        "Phase 5B post_capture attributed / post_capture recognized",
    },
  };
}

module.exports = {
  buildCustomerEconomics,
  detectCustomerIdCollisions,
  reportConfidence,
  computeHistoryJoinCoverage,
  HISTORY_JOIN_COMPLETE_PCT,
};
