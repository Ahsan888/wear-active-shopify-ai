/**
 * Pure sales-mix + ad-load + Shopify contribution helpers (Phase 3.5).
 * Channel labels reuse Books saleChannel() — do not invent alternate rules.
 *
 * Channel GP uses net recognized revenue (gross − Ledger refunds).
 * Refunds do NOT automatically reverse COGS; only explicit Ledger COGS rows apply.
 */
const { round2 } = require("../books/tax");
const { safeDiv } = require("../meta/metrics");
const { saleChannel, orderKeyFromRef } = require("../books/reports");

const SALES_CHANNELS = ["Shopify", "Manual", "Other Sales"];
const REVENUE_CONCENTRATION_THRESHOLD_PCT = 60;
const SHOPIFY_NEAR_ZERO_MARGIN_ABS_PCT = 5;

function emptyChannelTotals() {
  return Object.fromEntries(
    SALES_CHANNELS.map((name) => [
      name,
      {
        orders: 0,
        units: 0,
        revenue_ex_tax: 0,
        refunds: 0,
        net_revenue_ex_tax: 0,
        cogs: 0,
        gross_profit: 0,
        gross_margin_pct: null,
      },
    ])
  );
}

function emptyChannelAccumulators() {
  return Object.fromEntries(
    SALES_CHANNELS.map((name) => [
      name,
      {
        orderKeys: new Set(),
        units: 0,
        revenue_ex_tax: 0,
        refunds: 0,
        cogs: 0,
      },
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

/**
 * Record paid (non-gift) COGS into the same channel as Books saleChannel().
 */
function addPaidCogsToChannelAcc(acc, { source, ref, debit }) {
  const channel = saleChannel(source, ref);
  const bucket = acc[channel] || acc.Manual;
  bucket.cogs += Number(debit) || 0;
  return channel;
}

/**
 * Record a Ledger refund into channel accumulators (mutates acc).
 * Amount should match global Books: debit || credit.
 */
function addRefundToChannelAcc(acc, { source, ref, amount }) {
  const channel = saleChannel(source, ref);
  const bucket = acc[channel] || acc.Manual;
  bucket.refunds += Number(amount) || 0;
  return channel;
}

function finalizeChannelAcc(acc) {
  const sales_by_channel = emptyChannelTotals();
  for (const name of SALES_CHANNELS) {
    const b = acc[name] || {
      orderKeys: new Set(),
      units: 0,
      revenue_ex_tax: 0,
      refunds: 0,
      cogs: 0,
    };
    const revenue = round2(b.revenue_ex_tax);
    const refunds = round2(b.refunds);
    const net = round2(revenue - refunds);
    const cogs = round2(b.cogs);
    const gp = round2(net - cogs);
    sales_by_channel[name] = {
      orders: b.orderKeys.size,
      units: round2(b.units),
      revenue_ex_tax: revenue,
      refunds,
      net_revenue_ex_tax: net,
      cogs,
      gross_profit: gp,
      gross_margin_pct: net > 0 ? round2((gp / net) * 100) : null,
    };
  }
  return sales_by_channel;
}

function buildSalesMixSummary(
  sales_by_channel,
  {
    recognized_orders,
    recognized_units,
    revenue_ex_tax,
    net_revenue_ex_tax,
    refunds,
    paid_cogs,
  } = {}
) {
  const channels = SALES_CHANNELS.map((name) => {
    const row = sales_by_channel?.[name] || emptyChannelTotals()[name];
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
  const total_gross =
    revenue_ex_tax != null
      ? Number(revenue_ex_tax)
      : channels.reduce((s, c) => s + Number(c.revenue_ex_tax || 0), 0);
  const total_refunds =
    refunds != null
      ? Number(refunds)
      : channels.reduce((s, c) => s + Number(c.refunds || 0), 0);
  const total_net =
    net_revenue_ex_tax != null
      ? Number(net_revenue_ex_tax)
      : round2(total_gross - total_refunds);
  const channel_cogs_sum = round2(
    channels.reduce((s, c) => s + Number(c.cogs || 0), 0)
  );
  // Paid-channel aggregate (excludes gift/PR COGS by construction of channel COGS)
  const paid_channel_cogs = channel_cogs_sum;
  const paid_channel_gross_profit = round2(total_net - paid_channel_cogs);
  const paid_channel_gross_margin_pct =
    total_net > 0
      ? round2((paid_channel_gross_profit / total_net) * 100)
      : null;

  const withShares = channels.map((c) => {
    const gross_rev = Number(c.revenue_ex_tax || 0);
    const net_rev = Number(
      c.net_revenue_ex_tax != null
        ? c.net_revenue_ex_tax
        : gross_rev - Number(c.refunds || 0)
    );
    const gross_revenue_share_pct =
      total_gross > 0 ? round2((gross_rev / total_gross) * 100) : 0;
    const net_revenue_share_pct =
      total_net > 0 ? round2((net_rev / total_net) * 100) : 0;
    return {
      ...c,
      net_revenue_ex_tax: round2(net_rev),
      order_share_pct:
        total_orders > 0 ? round2((c.orders / total_orders) * 100) : 0,
      // Backward-compatible alias: historically gross share
      revenue_share_pct: gross_revenue_share_pct,
      gross_revenue_share_pct,
      net_revenue_share_pct,
      unit_share_pct:
        total_units > 0 ? round2((c.units / total_units) * 100) : 0,
    };
  });

  return {
    sales_by_channel,
    channels: withShares,
    totals: {
      orders: total_orders,
      units: round2(total_units),
      revenue_ex_tax: round2(total_gross),
      refunds: round2(total_refunds),
      net_revenue_ex_tax: round2(total_net),
      // Backward-compatible: sum of paid channel COGS (excludes gift/PR)
      cogs: channel_cogs_sum,
      paid_channel_cogs,
      paid_channel_gross_profit,
      paid_channel_gross_margin_pct,
    },
    channel_cogs_sum,
    paid_cogs: paid_cogs == null ? null : round2(Number(paid_cogs)),
    shopify_recognized_orders: sales_by_channel?.Shopify?.orders || 0,
    manual_recognized_orders: sales_by_channel?.Manual?.orders || 0,
    other_sales_recognized_orders:
      sales_by_channel?.["Other Sales"]?.orders || 0,
    shopify_revenue_ex_tax: sales_by_channel?.Shopify?.revenue_ex_tax || 0,
    manual_revenue_ex_tax: sales_by_channel?.Manual?.revenue_ex_tax || 0,
    other_sales_revenue_ex_tax:
      sales_by_channel?.["Other Sales"]?.revenue_ex_tax || 0,
    shopify_net_revenue_ex_tax:
      sales_by_channel?.Shopify?.net_revenue_ex_tax || 0,
    manual_net_revenue_ex_tax:
      sales_by_channel?.Manual?.net_revenue_ex_tax || 0,
    other_sales_net_revenue_ex_tax:
      sales_by_channel?.["Other Sales"]?.net_revenue_ex_tax || 0,
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

/**
 * Descriptive Shopify contribution status — display only; never drives Phase 3 gates.
 * Uses net Shopify revenue as the economic base.
 */
function classifyShopifyContributionStatus({
  net_revenue_ex_tax,
  revenue_ex_tax,
  contribution_after_meta,
  contribution_margin_after_meta_pct,
} = {}) {
  const net =
    net_revenue_ex_tax != null
      ? Number(net_revenue_ex_tax)
      : Number(revenue_ex_tax || 0);
  if (!(net > 0)) {
    return {
      status: "insufficient_data",
      reason: "No positive Shopify net recognized revenue in period",
    };
  }
  const contrib = Number(contribution_after_meta || 0);
  const margin =
    contribution_margin_after_meta_pct == null
      ? null
      : Number(contribution_margin_after_meta_pct);

  if (
    margin != null &&
    Number.isFinite(margin) &&
    Math.abs(margin) <= SHOPIFY_NEAR_ZERO_MARGIN_ABS_PCT
  ) {
    return {
      status: "near_zero",
      reason: `Shopify contribution margin after Meta is near zero (${margin}%)`,
    };
  }
  if (contrib < 0) {
    return {
      status: "negative_contribution",
      reason: "Shopify gross profit before ads is less than Meta spend",
    };
  }
  return {
    status: "positive_contribution",
    reason: "Shopify gross profit before ads exceeds Meta spend",
  };
}

/**
 * Date-aligned Shopify channel contribution vs Meta spend (not attributed, no opex).
 * Uses net recognized Shopify revenue (gross − Ledger refunds).
 */
function buildShopifyContributionContext({
  sales_by_channel,
  meta_spend,
  shopify_ad_load_per_recognized_order,
} = {}) {
  const shopify = sales_by_channel?.Shopify || emptyChannelTotals().Shopify;
  const spend = round2(Number(meta_spend || 0));
  const revenue = round2(Number(shopify.revenue_ex_tax || 0));
  const refunds = round2(Number(shopify.refunds || 0));
  const net =
    shopify.net_revenue_ex_tax != null
      ? round2(Number(shopify.net_revenue_ex_tax))
      : round2(revenue - refunds);
  const cogs = round2(Number(shopify.cogs || 0));
  const gp = round2(net - cogs);
  const contribution = round2(gp - spend);
  const contribution_margin =
    net > 0 && Number.isFinite(contribution / net)
      ? round2((contribution / net) * 100)
      : null;
  const statusInfo = classifyShopifyContributionStatus({
    net_revenue_ex_tax: net,
    contribution_after_meta: contribution,
    contribution_margin_after_meta_pct: contribution_margin,
  });

  return {
    recognized_orders: shopify.orders || 0,
    recognized_units: shopify.units || 0,
    revenue_ex_tax: revenue,
    refunds,
    net_revenue_ex_tax: net,
    cogs,
    gross_profit_before_ads: gp,
    gross_margin_before_ads_pct:
      shopify.gross_margin_pct != null
        ? shopify.gross_margin_pct
        : net > 0
          ? round2((gp / net) * 100)
          : null,
    meta_spend: spend,
    ad_load_per_recognized_order:
      shopify_ad_load_per_recognized_order == null
        ? null
        : Number(shopify_ad_load_per_recognized_order),
    shopify_ad_load_per_recognized_order:
      shopify_ad_load_per_recognized_order == null
        ? null
        : Number(shopify_ad_load_per_recognized_order),
    contribution_after_meta: contribution,
    contribution_margin_after_meta_pct: contribution_margin,
    contribution_status: statusInfo.status,
    contribution_status_reason: statusInfo.reason,
    attribution_available: false,
    opex_allocated: false,
    note:
      "Date-aligned Shopify contribution context using net recognized Shopify revenue after Ledger refunds. Meta spend is not order-attributed. Shared opex is not allocated. Refunds do not automatically reverse COGS unless corresponding Ledger COGS entries exist.",
  };
}

/**
 * Revenue concentration diagnostic (business_context — not a data-quality error).
 * Uses net channel revenue shares when available.
 */
function buildRevenueConcentration(sales_mix) {
  const channels = sales_mix?.channels || [];
  if (!channels.length) {
    return {
      dominant_channel: null,
      dominant_channel_revenue_share_pct: null,
      dominant_channel_orders: null,
      is_materially_concentrated: false,
      non_shopify_distortion_risk: false,
      warning: null,
      category: "business_context",
      basis: "net_revenue",
    };
  }
  const sorted = [...channels].sort((a, b) => {
    const sa = Number(
      a.net_revenue_share_pct != null
        ? a.net_revenue_share_pct
        : a.revenue_share_pct || 0
    );
    const sb = Number(
      b.net_revenue_share_pct != null
        ? b.net_revenue_share_pct
        : b.revenue_share_pct || 0
    );
    return sb - sa;
  });
  const top = sorted[0];
  const share = Number(
    top.net_revenue_share_pct != null
      ? top.net_revenue_share_pct
      : top.revenue_share_pct || 0
  );
  const is_materially_concentrated =
    share >= REVENUE_CONCENTRATION_THRESHOLD_PCT;
  const non_shopify_distortion_risk =
    is_materially_concentrated && top.channel !== "Shopify";

  let warning = null;
  if (non_shopify_distortion_risk) {
    warning =
      `${share}% of recognized net revenue in this period came from ${top.channel}. ` +
      `Whole-business profitability and ad-spend affordability are therefore not representative of ecommerce performance alone.`;
  }

  return {
    dominant_channel: top.channel,
    dominant_channel_revenue_share_pct: share,
    dominant_channel_orders: top.orders,
    is_materially_concentrated,
    non_shopify_distortion_risk,
    warning,
    category: "business_context",
    basis: "net_revenue",
  };
}

module.exports = {
  SALES_CHANNELS,
  REVENUE_CONCENTRATION_THRESHOLD_PCT,
  saleChannel,
  orderKeyFromRef,
  emptyChannelTotals,
  emptyChannelAccumulators,
  resolveSaleOrderKey,
  addSaleToChannelAcc,
  addPaidCogsToChannelAcc,
  addRefundToChannelAcc,
  finalizeChannelAcc,
  buildSalesMixSummary,
  computeAdLoadMetrics,
  classifyShopifyContributionStatus,
  buildShopifyContributionContext,
  buildRevenueConcentration,
  safeDiv,
};
