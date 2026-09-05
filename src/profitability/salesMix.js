/**
 * Pure sales-mix + ad-load helpers (Phase 3.5).
 * Channel labels reuse Books saleChannel() — do not invent alternate rules.
 */
const { round2 } = require("../books/tax");
const { safeDiv } = require("../meta/metrics");
const { saleChannel, orderKeyFromRef } = require("../books/reports");

const SALES_CHANNELS = ["Shopify", "Manual", "Other Sales"];

function emptyChannelTotals() {
  return Object.fromEntries(
    SALES_CHANNELS.map((name) => [
      name,
      { orders: 0, units: 0, revenue_ex_tax: 0 },
    ])
  );
}

function emptyChannelAccumulators() {
  return Object.fromEntries(
    SALES_CHANNELS.map((name) => [
      name,
      { orderKeys: new Set(), units: 0, revenue_ex_tax: 0 },
    ])
  );
}

function resolveSaleOrderKey(ref, ymd, sku, credit) {
  const orderKey = orderKeyFromRef(ref);
  if (orderKey) return orderKey;
  if (ref) return String(ref);
  return `ROW:${ymd}:${sku}:${credit}`;
}

/**
 * Record one paid Sale line into channel accumulators (mutates acc).
 */
function addSaleToChannelAcc(acc, { source, ref, ymd, sku, credit, qty }) {
  const channel = saleChannel(source, ref);
  const bucket = acc[channel] || acc.Manual;
  bucket.units += Number(qty) || 0;
  bucket.revenue_ex_tax += Number(credit) || 0;
  bucket.orderKeys.add(resolveSaleOrderKey(ref, ymd, sku, credit));
  return channel;
}

function finalizeChannelAcc(acc) {
  const sales_by_channel = emptyChannelTotals();
  for (const name of SALES_CHANNELS) {
    const b = acc[name] || { orderKeys: new Set(), units: 0, revenue_ex_tax: 0 };
    sales_by_channel[name] = {
      orders: b.orderKeys.size,
      units: round2(b.units),
      revenue_ex_tax: round2(b.revenue_ex_tax),
    };
  }
  return sales_by_channel;
}

function buildSalesMixSummary(sales_by_channel, {
  recognized_orders,
  recognized_units,
  revenue_ex_tax,
} = {}) {
  const channels = SALES_CHANNELS.map((name) => {
    const row = sales_by_channel?.[name] || {
      orders: 0,
      units: 0,
      revenue_ex_tax: 0,
    };
    return { channel: name, ...row };
  });

  const total_orders =
    recognized_orders != null
      ? Number(recognized_orders)
      : channels.reduce((s, c) => s + c.orders, 0);
  const total_units =
    recognized_units != null
      ? Number(recognized_units)
      : channels.reduce((s, c) => s + c.units, 0);
  const total_revenue =
    revenue_ex_tax != null
      ? Number(revenue_ex_tax)
      : channels.reduce((s, c) => s + c.revenue_ex_tax, 0);

  const withShares = channels.map((c) => ({
    ...c,
    order_share_pct:
      total_orders > 0 ? round2((c.orders / total_orders) * 100) : 0,
    revenue_share_pct:
      total_revenue > 0
        ? round2((c.revenue_ex_tax / total_revenue) * 100)
        : 0,
    unit_share_pct:
      total_units > 0 ? round2((c.units / total_units) * 100) : 0,
  }));

  return {
    sales_by_channel,
    channels: withShares,
    totals: {
      orders: total_orders,
      units: round2(total_units),
      revenue_ex_tax: round2(total_revenue),
    },
    shopify_recognized_orders: sales_by_channel?.Shopify?.orders || 0,
    manual_recognized_orders: sales_by_channel?.Manual?.orders || 0,
    other_sales_recognized_orders:
      sales_by_channel?.["Other Sales"]?.orders || 0,
    shopify_revenue_ex_tax: sales_by_channel?.Shopify?.revenue_ex_tax || 0,
    manual_revenue_ex_tax: sales_by_channel?.Manual?.revenue_ex_tax || 0,
    other_sales_revenue_ex_tax:
      sales_by_channel?.["Other Sales"]?.revenue_ex_tax || 0,
  };
}

/**
 * Ad-load metrics. Shopify load is context only — never drives business safety.
 */
function computeAdLoadMetrics({
  meta_spend,
  recognized_orders,
  shopify_recognized_orders,
} = {}) {
  const spend = Number(meta_spend || 0);
  const allOrders = Number(recognized_orders || 0);
  const shopifyOrders = Number(shopify_recognized_orders || 0);

  const business_wide_ad_load_per_recognized_order =
    allOrders > 0 ? round2(spend / allOrders) : null;
  const shopify_ad_load_per_recognized_order =
    shopifyOrders > 0 ? round2(spend / shopifyOrders) : null;

  return {
    business_wide_ad_load_per_recognized_order,
    shopify_ad_load_per_recognized_order,
    // Backward-compatible alias used by Phase 3 safety
    blended_ad_cost_per_recognized_order:
      business_wide_ad_load_per_recognized_order,
    labels: {
      business_wide_ad_load_per_recognized_order:
        "Business-wide ad load / recognized order",
      shopify_ad_load_per_recognized_order:
        "Shopify ad load / recognized order",
    },
    notes: {
      business_wide:
        "Actual Meta spend divided by all recognized business orders (Shopify + Manual + Other Sales).",
      shopify:
        "Meta spend divided by all recognized Shopify orders in the same period; this does not imply those orders were caused by Meta. Not Meta CAC / Shopify CAC / attributed CPA.",
      not_compared_to_break_even:
        "Shopify ad load is supporting context only and is not compared to business-wide break-even CPA.",
    },
  };
}

module.exports = {
  SALES_CHANNELS,
  saleChannel,
  orderKeyFromRef,
  emptyChannelTotals,
  emptyChannelAccumulators,
  resolveSaleOrderKey,
  addSaleToChannelAcc,
  finalizeChannelAcc,
  buildSalesMixSummary,
  computeAdLoadMetrics,
  safeDiv,
};
