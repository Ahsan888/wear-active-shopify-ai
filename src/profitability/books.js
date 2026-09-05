/**
 * Read-only Books loaders + period aggregations for profitability reporting.
 * Does NOT write to Sheets. Ledger is the accounting source of truth.
 */
const { getValues } = require("../sheets/client");
const { parseMoney, round2 } = require("../books/tax");
const { orderKeyFromRef } = require("../books/reports");
const { isRecognized } = require("../books/recognition");

/** Live primary Ads category (case-insensitive). */
const ADS_CATEGORY = "ads";
const DELIVERY_CATEGORY = "delivery";

function cleanProductName(value) {
  return String(value || "")
    .replace(/^COGS\s+/i, "")
    .replace(/\s+\(#?\d+\)\s*$/, "")
    .trim();
}

function colIndex(header, name) {
  return header.findIndex(
    (h) => String(h || "").trim().toLowerCase() === name.toLowerCase()
  );
}

function normalizeCategory(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isAdsCategory(value) {
  return normalizeCategory(value) === ADS_CATEGORY;
}

function isDeliveryCategory(value) {
  return normalizeCategory(value) === DELIVERY_CATEGORY;
}

/**
 * Normalize sheet date cells to YYYY-MM-DD (handles ISO strings and Sheets serials).
 */
function toYmd(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && value > 20000) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function inRange(ymd, since, until) {
  if (!ymd) return false;
  return ymd >= since && ymd <= until;
}

function headerMap(rows) {
  const header = (rows[0] || []).map((h) => String(h || "").trim());
  const data = rows.slice(1);
  return { header, data };
}

/** Explicit open-ended ranges (no silent 10k-row / Z-column truncation). */
const SHEET_RANGES = {
  ledger: "'Ledger'!A:N",
  recurring: "'Recurring Expenses'!A:F",
  // Variant Master currently uses A–U (Product … Qty Restocked)
  variantMaster: "'Variant Master'!A:U",
  live: "'Shopify Orders (LIVE)'!A:AF",
};

const LIVE_PIPELINE_HEADERS = [
  "Recognized",
  "Posted",
  "Order Tags",
  "DeliveryMode",
];

function assertLivePipelineHeaders(header) {
  const missing = LIVE_PIPELINE_HEADERS.filter(
    (name) => colIndex(header, name) < 0
  );
  if (missing.length) {
    throw new Error(
      `Shopify Orders (LIVE) missing required pipeline columns: ${missing.join(", ")}. ` +
        `Loaded ${header.length} headers (need A:AF).`
    );
  }
  return true;
}

async function loadLedger() {
  return headerMap(await getValues(SHEET_RANGES.ledger));
}

async function loadRecurringExpenses() {
  return headerMap(await getValues(SHEET_RANGES.recurring));
}

async function loadVariantMaster() {
  const { header, data } = headerMap(await getValues(SHEET_RANGES.variantMaster));
  const iSku = colIndex(header, "SKU");
  const iProduct = colIndex(header, "Product");
  const iCat = colIndex(header, "Category");
  const iCost = colIndex(header, "CostPerItem");
  const bySku = {};
  for (const row of data) {
    const sku = String(row[iSku] || "").trim();
    if (!sku) continue;
    bySku[sku] = {
      sku,
      product: String(row[iProduct] || "").trim(),
      category: String(row[iCat] || "").trim(),
      costPerItem: parseMoney(row[iCost]),
    };
  }
  return { header, bySku };
}

async function loadLiveOrders() {
  const loaded = headerMap(await getValues(SHEET_RANGES.live));
  assertLivePipelineHeaders(loaded.header);
  return loaded;
}

/** Extract shared uid from GIFT:/COGS:/SALE: ref keys. */
function ledgerUidFromRef(ref) {
  const s = String(ref || "").trim();
  const m = s.match(/^(?:GIFT|COGS|SALE):(.+)$/i);
  return m ? m[1] : "";
}

function ensureProductBucket(products, sku, description, catalogBySku) {
  const catalog = catalogBySku[sku] || {};
  const key = sku || cleanProductName(description) || "Unknown";
  if (!products[key]) {
    products[key] = {
      sku: sku || null,
      product: catalog.product || cleanProductName(description) || key,
      category: catalog.category || "",
      units: 0,
      revenue_ex_tax: 0,
      cogs: 0,
      vm_cost_per_item: catalog.costPerItem ?? null,
      in_variant_master: Boolean(sku && catalog.sku),
    };
  }
  return products[key];
}

/**
 * Aggregate Ledger for an inclusive [since, until] range with Ads isolated.
 * Gift/PR COGS stay in Books totals but are excluded from paid product economics.
 */
function aggregateLedgerPeriod(ledgerRows, header, since, until, catalogBySku = {}) {
  const iDate = colIndex(header, "Date");
  const iType = colIndex(header, "Entry Type");
  const iCat = colIndex(header, "Category");
  const iDesc = colIndex(header, "Description");
  const iSku = colIndex(header, "SKU");
  const iQty = colIndex(header, "Qty");
  const iDebit = colIndex(header, "Debit");
  const iCredit = colIndex(header, "Credit");
  const iRef = colIndex(header, "Ref Key");
  const iSource = colIndex(header, "Source");

  // Pass 1: gift UIDs in range (for linking COGS:uid → Gift/PR)
  const giftUids = new Set();
  for (const row of ledgerRows) {
    const ymd = toYmd(row[iDate]);
    if (!inRange(ymd, since, until)) continue;
    const type = String(row[iType] || "").trim().toLowerCase();
    const ref = String(row[iRef] || "").trim();
    if (type === "gift") {
      const uid = ledgerUidFromRef(ref);
      if (uid) giftUids.add(uid);
    }
  }

  let revenue_ex_tax = 0;
  let refunds = 0;
  let output_tax = 0;
  let gross_collected = 0;
  let cogs = 0;
  let gift_cogs = 0;
  let delivery_expense = 0;
  let ads_expense_booked = 0;
  let other_non_ad_opex = 0;
  // Paid recognized sales units (aligned with recognized_orders / AOV)
  let recognized_units = 0;
  let gift_units = 0;
  const orders = new Set();
  const products = {};
  const giftUnits = {};
  const giftProductCosts = {};
  const expenseRows = [];
  const adsRows = [];

  for (const row of ledgerRows) {
    const ymd = toYmd(row[iDate]);
    if (!inRange(ymd, since, until)) continue;

    const type = String(row[iType] || "").trim().toLowerCase();
    const category = String(row[iCat] || "").trim();
    const debit = parseMoney(row[iDebit]);
    const credit = parseMoney(row[iCredit]);
    const qty = parseMoney(row[iQty]);
    const sku = String(row[iSku] || "").trim();
    const description = String(row[iDesc] || "").trim();
    const ref = String(row[iRef] || "").trim();
    const source = String(row[iSource] || "").trim();

    if (type === "sale") {
      revenue_ex_tax += credit;
      gross_collected += credit;
      recognized_units += qty;
      const orderKey = orderKeyFromRef(ref);
      if (orderKey) orders.add(orderKey);
      else if (ref) orders.add(ref);
      else orders.add(`ROW:${ymd}:${sku}:${credit}`);

      const bucket = ensureProductBucket(products, sku, description, catalogBySku);
      bucket.units += qty;
      bucket.revenue_ex_tax += credit;
    } else if (type === "tax") {
      output_tax += credit;
      gross_collected += credit;
    } else if (type === "cogs") {
      // Always in official Books COGS
      cogs += debit;
      const uid = ledgerUidFromRef(ref);
      const isGiftCogs = uid && giftUids.has(uid);
      if (isGiftCogs) {
        gift_cogs += debit;
        const key = sku || cleanProductName(description) || "Gift";
        if (!giftProductCosts[key]) {
          giftProductCosts[key] = {
            sku: sku || null,
            product: cleanProductName(description) || key,
            cogs: 0,
            units: 0,
          };
        }
        giftProductCosts[key].cogs += debit;
        giftProductCosts[key].units += qty;
      } else {
        const bucket = ensureProductBucket(products, sku, description, catalogBySku);
        bucket.cogs += debit;
      }
    } else if (type === "gift") {
      gift_units += qty;
      const key = sku || cleanProductName(description) || "Gift";
      giftUnits[key] = (giftUnits[key] || 0) + qty;
    } else if (type === "expense") {
      const expenseRow = {
        date: ymd,
        category,
        description,
        debit,
        source,
        ref: ref.slice(0, 64),
      };
      expenseRows.push(expenseRow);
      if (isDeliveryCategory(category)) {
        delivery_expense += debit;
      } else if (isAdsCategory(category)) {
        ads_expense_booked += debit;
        adsRows.push(expenseRow);
      } else {
        other_non_ad_opex += debit;
      }
    } else if (type === "refund" || /refund/i.test(type)) {
      refunds += debit || credit;
    }
  }

  const net_revenue_ex_tax = revenue_ex_tax - refunds;
  const gross_profit = net_revenue_ex_tax - cogs;
  const total_opex = delivery_expense + ads_expense_booked + other_non_ad_opex;
  const books_net_profit = gross_profit - total_opex;
  const recognized_orders = orders.size;

  const productRows = Object.values(products)
    .map((p) => {
      const gp = p.revenue_ex_tax - p.cogs;
      return {
        ...p,
        revenue_ex_tax: round2(p.revenue_ex_tax),
        cogs: round2(p.cogs),
        units: round2(p.units),
        gross_profit: round2(gp),
        gross_margin_pct:
          p.revenue_ex_tax > 0 ? round2((gp / p.revenue_ex_tax) * 100) : null,
        flags: buildProductFlags(p, gp),
      };
    })
    .filter((p) => p.revenue_ex_tax > 0 || p.cogs > 0)
    .sort((a, b) => b.revenue_ex_tax - a.revenue_ex_tax);

  const gift_product_costs = Object.values(giftProductCosts).map((g) => ({
    ...g,
    cogs: round2(g.cogs),
    units: round2(g.units),
  }));

  return {
    books: {
      gross_collected: round2(gross_collected),
      output_tax: round2(output_tax),
      revenue_ex_tax: round2(revenue_ex_tax),
      refunds: round2(refunds),
      net_revenue_ex_tax: round2(net_revenue_ex_tax),
      cogs: round2(cogs),
      gift_cogs: round2(gift_cogs),
      paid_cogs: round2(cogs - gift_cogs),
      gross_profit: round2(gross_profit),
      gross_margin_pct:
        net_revenue_ex_tax > 0
          ? round2((gross_profit / net_revenue_ex_tax) * 100)
          : null,
      delivery_expense: round2(delivery_expense),
      ads_expense_booked: round2(ads_expense_booked),
      other_non_ad_opex: round2(other_non_ad_opex),
      total_opex: round2(total_opex),
      books_net_profit: round2(books_net_profit),
      books_net_margin_pct:
        net_revenue_ex_tax > 0
          ? round2((books_net_profit / net_revenue_ex_tax) * 100)
          : null,
      recognized_orders,
      // Paid recognized sales units only (aligned with orders / AOV)
      recognized_units: round2(recognized_units),
      gift_units: round2(gift_units),
      aov_ex_tax:
        recognized_orders > 0
          ? round2(net_revenue_ex_tax / recognized_orders)
          : null,
    },
    products: productRows,
    gift_units_by_key: giftUnits,
    gift_product_costs,
    expense_rows: expenseRows,
    ads_rows: adsRows,
  };
}

function buildProductFlags(p, gp) {
  const flags = [];
  if (p.sku && !p.in_variant_master) flags.push("sku_missing_from_variant_master");
  if (p.sku && p.in_variant_master && !(p.vm_cost_per_item > 0)) {
    flags.push("missing_cost_per_item");
  }
  if (p.revenue_ex_tax > 0 && gp < 0) flags.push("negative_margin");
  if (p.revenue_ex_tax > 0 && gp / p.revenue_ex_tax < 0.15 && gp >= 0) {
    flags.push("low_margin");
  }
  return flags;
}

function aggregateRecurringAds(rows, header, since, until) {
  const iDate = colIndex(header, "Date");
  const iCat = colIndex(header, "Category");
  const iAmt = colIndex(header, "Amount");
  const iName = colIndex(header, "Expense Name");

  const ads = [];
  let total = 0;
  for (const row of rows) {
    const ymd = toYmd(row[iDate]);
    if (!inRange(ymd, since, until)) continue;
    const category = String(row[iCat] || "").trim();
    if (!isAdsCategory(category)) continue;
    const amount = parseMoney(row[iAmt]);
    total += amount;
    ads.push({
      date: ymd,
      category,
      amount: round2(amount),
      expense_name: String(row[iName] || "").trim().slice(0, 80),
    });
  }
  return { recurring_ads_expense: round2(total), recurring_ads_rows: ads };
}

/**
 * Open pipeline from LIVE — not recognized revenue.
 */
function aggregateOpenPipeline(liveRows, header) {
  const iOrder = colIndex(header, "Order #");
  const iQty = colIndex(header, "Qty");
  const iNet = colIndex(header, "Net Line");
  const iPay = colIndex(header, "Payment Status");
  const iFulfill = colIndex(header, "Fulfillment Status");
  const iTags = colIndex(header, "Order Tags");
  const iMode = colIndex(header, "DeliveryMode");
  const iRec = colIndex(header, "Recognized");
  const iPosted = colIndex(header, "Posted");

  const orders = new Set();
  let gross = 0;
  let units = 0;
  let lines = 0;

  for (const row of liveRows) {
    const recognized = String(row[iRec] || "").trim().toUpperCase() === "Y";
    const posted = String(row[iPosted] || "").trim().toUpperCase() === "Y";
    if (recognized || posted) continue;

    const tags = String(row[iTags] || "");
    const pay = String(row[iPay] || "");
    const fulfill = String(row[iFulfill] || "");
    const mode = String(row[iMode] || "").trim().toLowerCase() || undefined;

    const rec = isRecognized({
      fulfillmentStatus: fulfill,
      paymentStatus: pay,
      tags,
      deliveryMode: mode || undefined,
    });
    // Skip cancelled/refunded / hold even if Recognized column lagging
    if (
      ["cancelled_or_refunded", "wa:hold"].includes(rec.reason) ||
      /cancel|refund/i.test(pay) ||
      /cancel/i.test(fulfill)
    ) {
      continue;
    }
    // Only count still-unrecognized demand
    if (rec.recognized) continue;

    const qty = parseMoney(row[iQty]);
    const net = parseMoney(row[iNet]);
    if (!(net > 0) && !(qty > 0)) continue;

    lines += 1;
    units += qty;
    gross += net;
    const order = String(row[iOrder] || "").trim() || `line-${lines}`;
    orders.add(order);
  }

  return {
    open_pipeline_orders: orders.size,
    open_pipeline_gross: round2(gross),
    open_pipeline_units: round2(units),
    open_pipeline_lines: lines,
    pipeline_not_revenue: true,
  };
}

module.exports = {
  ADS_CATEGORY,
  DELIVERY_CATEGORY,
  SHEET_RANGES,
  LIVE_PIPELINE_HEADERS,
  colIndex,
  normalizeCategory,
  isAdsCategory,
  isDeliveryCategory,
  toYmd,
  inRange,
  assertLivePipelineHeaders,
  ledgerUidFromRef,
  loadLedger,
  loadRecurringExpenses,
  loadVariantMaster,
  loadLiveOrders,
  aggregateLedgerPeriod,
  aggregateRecurringAds,
  aggregateOpenPipeline,
};
