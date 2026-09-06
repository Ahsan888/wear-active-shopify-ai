/**
 * Join Shopify GraphQL order IDs to recognized Ledger Sale/COGS economics.
 * Reuses Books Ledger rows — does not invent COGS.
 */
const { parseMoney, round2 } = require("../books/tax");
const { colIndex, toYmd, inRange, ledgerUidFromRef } = require("../profitability/books");

function shopifyOrderIdFromGid(id) {
  const s = String(id || "");
  const m = s.match(/\/Order\/(\d+)/i) || s.match(/^(\d+)$/);
  return m ? m[1] : null;
}

function normalizeShopifyOrderKey(value) {
  if (value == null || value === "") return null;
  let s = String(value).trim();
  if (!s) return null;
  s = s.replace(/^#/, "");
  const gid = shopifyOrderIdFromGid(s);
  if (gid) return gid;
  // name like 1358 or remaining token
  if (/^\d+$/.test(s)) return s;
  return s;
}

/** Extract Shopify order id token from SALE:/COGS: uid body. */
function shopifyOrderIdFromLedgerUid(uid) {
  const s = String(uid || "").trim();
  let m = s.match(/^SHOPIFY\|([^|]+)\|/i);
  if (m) return normalizeShopifyOrderKey(m[1]);
  m = s.match(/^SHOPIFY\|([^|:]+)/i);
  if (m) return normalizeShopifyOrderKey(m[1]);
  m = s.match(/^SHOPIFY:(#?[^:]+)/i);
  if (m) return normalizeShopifyOrderKey(m[1]);
  return null;
}

function emptyOrderEcon() {
  return {
    order_id: null,
    revenue_ex_tax: 0,
    refunds: 0,
    net_revenue_ex_tax: 0,
    cogs: 0,
    gross_profit: 0,
    units: 0,
    sale_lines: 0,
    has_sale: false,
  };
}

/**
 * Index recognized Shopify order economics from Ledger for [since, until].
 * Only Sale/COGS/Refund rows with SHOPIFY refs. Gift COGS excluded from paid GP.
 *
 * @returns {Map<string, object>} keyed by normalized Shopify order id
 */
function indexRecognizedShopifyOrderEconomics(
  ledgerRows,
  header,
  since,
  until
) {
  const iDate = colIndex(header, "Date");
  const iType = colIndex(header, "Entry Type");
  const iQty = colIndex(header, "Qty");
  const iDebit = colIndex(header, "Debit");
  const iCredit = colIndex(header, "Credit");
  const iRef = colIndex(header, "Ref Key");

  const giftUids = new Set();
  for (const row of ledgerRows || []) {
    const ymd = toYmd(row[iDate]);
    if (!inRange(ymd, since, until)) continue;
    const type = String(row[iType] || "").trim().toLowerCase();
    if (type !== "gift") continue;
    const uid = ledgerUidFromRef(row[iRef]);
    if (uid) giftUids.add(uid);
  }

  const byOrder = new Map();

  function bucket(orderId) {
    if (!orderId) return null;
    if (!byOrder.has(orderId)) {
      const b = emptyOrderEcon();
      b.order_id = orderId;
      byOrder.set(orderId, b);
    }
    return byOrder.get(orderId);
  }

  for (const row of ledgerRows || []) {
    const ymd = toYmd(row[iDate]);
    if (!inRange(ymd, since, until)) continue;
    const type = String(row[iType] || "").trim().toLowerCase();
    const ref = String(row[iRef] || "").trim();
    const uid = ledgerUidFromRef(ref);
    const orderId = shopifyOrderIdFromLedgerUid(uid);
    if (!orderId) continue;

    const debit = parseMoney(row[iDebit]);
    const credit = parseMoney(row[iCredit]);
    const qty = parseMoney(row[iQty]);
    const b = bucket(orderId);
    if (!b) continue;

    if (type === "sale") {
      b.revenue_ex_tax += credit;
      b.units += qty;
      b.sale_lines += 1;
      b.has_sale = true;
    } else if (type === "cogs") {
      if (uid && giftUids.has(uid)) continue;
      b.cogs += debit;
    } else if (type === "refund" || /refund/i.test(type)) {
      b.refunds += debit || credit;
    }
  }

  for (const b of byOrder.values()) {
    b.net_revenue_ex_tax = round2(b.revenue_ex_tax - b.refunds);
    b.revenue_ex_tax = round2(b.revenue_ex_tax);
    b.refunds = round2(b.refunds);
    b.cogs = round2(b.cogs);
    b.gross_profit = round2(b.net_revenue_ex_tax - b.cogs);
    b.units = round2(b.units);
  }

  // Only orders with at least one recognized Sale row count as recognized
  for (const [id, b] of [...byOrder.entries()]) {
    if (!b.has_sale) byOrder.delete(id);
  }

  return byOrder;
}

function lookupOrderEconomics(byOrder, graphqlOrder) {
  if (!byOrder) return null;
  const fromGid = normalizeShopifyOrderKey(
    shopifyOrderIdFromGid(graphqlOrder?.id) || graphqlOrder?.id
  );
  if (fromGid && byOrder.has(fromGid)) return byOrder.get(fromGid);
  const fromName = normalizeShopifyOrderKey(graphqlOrder?.name);
  if (fromName && byOrder.has(fromName)) return byOrder.get(fromName);
  return null;
}

module.exports = {
  shopifyOrderIdFromGid,
  normalizeShopifyOrderKey,
  shopifyOrderIdFromLedgerUid,
  indexRecognizedShopifyOrderEconomics,
  lookupOrderEconomics,
  emptyOrderEcon,
};
