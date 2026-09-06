/**
 * Build recognized customer-order rows from Shopify + Ledger join.
 */
const { round2 } = require("../books/tax");
const { toYmd } = require("../profitability/books");
const {
  lookupOrderEconomics,
  shopifyOrderIdFromGid,
  normalizeShopifyOrderKey,
} = require("../attribution/ledgerJoin");
const { normalizeOrderAttribution } = require("../attribution/normalize");
const { isFirstPartyMeta } = require("../attribution/entityEconomics");
const {
  resolveCustomerIdentity,
  isIdentifiedCustomer,
} = require("./identity");

function orderDateYmd(order) {
  const raw = order.createdAt || order.created_at || "";
  const ymd = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : toYmd(raw);
}

function acquisitionBucket(attr) {
  if (!attr) return "unknown";
  if (isFirstPartyMeta(attr) || attr.status === "meta_first_party") return "Meta";
  if (attr.status === "paid_non_meta") return "paid_non_meta";
  if (attr.status === "organic") return "organic";
  if (attr.status === "direct") return "direct";
  return "unknown";
}

/**
 * Join GraphQL orders to recognized Ledger economics.
 * Dedupes by Shopify order id. Gift/PR never appear (no Sale in ledger index).
 *
 * @returns {{ rows: object[], data_quality: object }}
 */
function buildRecognizedCustomerOrders({
  orders = [],
  ledgerByOrderId,
  capture_started_at,
} = {}) {
  const byOrderId = new Map();
  const missingShopifyMatch = [];
  const ordersWithoutCustomerId = [];
  const missingCogs = [];
  const attributedMissingStableIds = [];
  let guestCount = 0;
  let identifiedCount = 0;

  for (const order of orders || []) {
    const econ = lookupOrderEconomics(ledgerByOrderId, order);
    if (!econ || !econ.has_sale) continue;

    // Canonical key = Ledger order id so join coverage reconciles
    const orderId =
      econ.order_id ||
      shopifyOrderIdFromGid(order.id) ||
      normalizeShopifyOrderKey(order.name);
    if (!orderId) continue;
    if (byOrderId.has(orderId)) continue; // duplicate prevention

    const identity = resolveCustomerIdentity(order);
    const attr = normalizeOrderAttribution(order, {
      capture_started_at,
    });
    const ymd = orderDateYmd(order);
    const gm =
      econ.net_revenue_ex_tax > 0
        ? round2((econ.gross_profit / econ.net_revenue_ex_tax) * 100)
        : null;

    if (!isIdentifiedCustomer(identity.identity_type)) {
      guestCount += 1;
      ordersWithoutCustomerId.push(orderId);
    } else {
      identifiedCount += 1;
    }

    if (
      Number(econ.units) > 0 &&
      Number(econ.cogs) === 0 &&
      Number(econ.net_revenue_ex_tax) > 0
    ) {
      missingCogs.push(orderId);
    }

    const acq = acquisitionBucket(attr);
    if (
      acq === "Meta" &&
      !(
        attr.meta_evidence?.campaign_id ||
        attr.meta_evidence?.ad_id ||
        attr.meta_evidence?.adset_id
      )
    ) {
      attributedMissingStableIds.push(orderId);
    }

    byOrderId.set(orderId, {
      order_id: orderId,
      order_name: order.name || null,
      order_date: ymd,
      customer_key: identity.customer_key,
      identity_type: identity.identity_type,
      shopify_customer_id: identity.shopify_customer_id,
      net_revenue_ex_tax: round2(econ.net_revenue_ex_tax),
      cogs: round2(econ.cogs),
      gross_profit: round2(econ.gross_profit),
      gross_margin_pct: gm,
      units: round2(econ.units),
      sales_channel: "Shopify",
      attribution_status: attr.status || "unknown",
      attribution_phase: attr.phase || null,
      attribution_usable: Boolean(attr.usable),
      acquisition: acq,
      meta_campaign_id: attr.meta_evidence?.campaign_id || null,
      meta_adset_id: attr.meta_evidence?.adset_id || null,
      meta_ad_id: attr.meta_evidence?.ad_id || null,
      // filled after sequencing
      order_sequence: null,
      new_or_returning: null,
    });
  }

  // Also surface ledger-recognized Shopify orders with no GraphQL match in fetch
  for (const [orderId, econ] of ledgerByOrderId || []) {
    if (!econ?.has_sale) continue;
    if (byOrderId.has(orderId)) continue;
    missingShopifyMatch.push(orderId);
  }

  const rows = [...byOrderId.values()].sort((a, b) =>
    a.order_date === b.order_date
      ? String(a.order_id).localeCompare(String(b.order_id))
      : a.order_date.localeCompare(b.order_date)
  );

  return {
    rows,
    data_quality: {
      orders_without_customer_id: ordersWithoutCustomerId,
      guest_order_count: guestCount,
      identified_order_count: identifiedCount,
      recognized_orders_missing_shopify_match: missingShopifyMatch,
      missing_cogs_order_ids: missingCogs,
      attributed_first_orders_missing_stable_ids: attributedMissingStableIds,
    },
  };
}

/**
 * Assign order_sequence and new/returning within loaded observed history.
 * Guest keys never merge across orders (each guest:{id} is unique).
 * Labels are history-scoped — not proven lifetime-first.
 */
function assignOrderSequences(rows = []) {
  const byCustomer = new Map();
  for (const row of rows) {
    if (!byCustomer.has(row.customer_key)) byCustomer.set(row.customer_key, []);
    byCustomer.get(row.customer_key).push(row);
  }
  for (const list of byCustomer.values()) {
    list.sort((a, b) =>
      a.order_date === b.order_date
        ? String(a.order_id).localeCompare(String(b.order_id))
        : a.order_date.localeCompare(b.order_date)
    );
    list.forEach((row, idx) => {
      row.order_sequence = idx + 1;
      row.new_or_returning =
        idx === 0 ? "new_in_observed_history" : "returning_in_observed_history";
    });
  }
  return rows;
}

module.exports = {
  orderDateYmd,
  acquisitionBucket,
  buildRecognizedCustomerOrders,
  assignOrderSequences,
};
