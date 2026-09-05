/**
 * Wear Active — Shopify → Google Sheets webhook (Apps Script)
 *
 * Deploy as Web App (execute as me, anyone with link).
 * Subscribe in Shopify Admin → Settings → Notifications → Webhooks:
 *   - Order creation     → ?topic=orders_create
 *   - Order updated      → ?topic=orders_updated
 *   - Order cancellation → ?topic=orders_cancelled
 *   - Refund create      → ?topic=refunds_create  (optional)
 *
 * Tags (set on Admin Create order):
 *   delivery:courier  → tax 18% (default if untagged)
 *   delivery:self     → tax exempt
 *   delivery:walkin   → tax exempt
 *   wa:gift / wa:pr   → gift/PR — tax exempt, no revenue (COGS only)
 *   wa:recognized     → force books recognition
 *   wa:hold           → never post until cleared
 *
 * Does NOT write Ledger — run: npm run books:sync:apply
 */

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    if (!e?.postData?.contents) throw new Error("Missing POST body");
    const payload = JSON.parse(e.postData.contents);
    const topic = String(e?.parameter?.topic || "orders_create").toLowerCase();

    if (topic === "orders_cancelled" || topic === "orders/cancelled") {
      return handleShopifyOrderCancelled_(payload);
    }
    if (topic === "refunds_create" || topic === "refunds/create") {
      return handleShopifyRefund_(payload);
    }
    // create + updated share writer
    return handleShopifyOrderUpsert_(payload, topic);
  } catch (err) {
    logWebhook_("shopify-webhook-error", {
      message: err.message,
      stack: err.stack,
    });
    return ContentService.createTextOutput("ERROR");
  } finally {
    lock.releaseLock();
  }
}

function handleShopifyOrderUpsert_(order, topic) {
  if (!Array.isArray(order.line_items) || !order.line_items.length) {
    logWebhook_("shopify-webhook-skip", {
      reason: "No line_items",
      orderId: order.id || null,
      topic,
    });
    return ContentService.createTextOutput("IGNORED");
  }

  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName("Shopify Orders (LIVE)");
  if (!sh) sh = ss.insertSheet("Shopify Orders (LIVE)");
  ensureLiveHeaders_(sh);

  const tz = Session.getScriptTimeZone();
  const orderId = String(order.id);
  const orderNumber = String(order.order_number || order.name || order.id);
  const createdAt = order.created_at || order.processed_at || new Date();
  const orderDate = Utilities.formatDate(new Date(createdAt), tz, "yyyy-MM-dd");

  const tags = Array.isArray(order.tags)
    ? order.tags
    : String(order.tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
  const tagStr = tags.join(", ");
  const mode = deliveryModeFromTags_(tags);
  const pay = String(order.financial_status || "").toLowerCase();
  const ful = String(order.fulfillment_status || "unfulfilled").toLowerCase();
  const shippingCollected = sumShipping_(order);
  const gatewayNote = getGatewayNote_(order);

  const data = sh.getDataRange().getValues();
  const headers = data[0].map(String);
  const uidCol = headers.indexOf("line_uid");
  if (uidCol === -1) throw new Error("line_uid column missing");

  const col = (n) => headers.indexOf(n);
  const existing = new Map();
  for (let i = 1; i < data.length; i++) {
    const uid = data[i][uidCol];
    if (uid) existing.set(String(uid), i + 1);
  }

  const rowsToAppend = [];

  for (const li of order.line_items) {
    if (!li.id || !li.quantity) continue;
    const lineUid = `SHOPIFY|${orderId}|${li.id}`;
    const unitPrice = Number(li.price || 0);
    const qty = Number(li.quantity);
    const lineDiscount = Number(li.total_discount || 0);
    const lineGross = unitPrice * qty;
    const netLine = lineGross - lineDiscount;
    const taxSplit = splitInclusiveTax_(netLine, mode.taxChargeable);
    const recognized = isRecognized_(ful, pay, tags, mode.mode);

    const row = new Array(headers.length).fill("");
    const set = (name, val) => {
      const i = col(name);
      if (i >= 0) row[i] = val;
    };

    set("Date", orderDate);
    set("Order #", orderNumber);
    set("SKU", li.sku || "");
    set("Product", li.title || "");
    set("Variant", "");
    set(
      "Size",
      (li.variant_title || "").split("/").pop()?.trim().toUpperCase() || ""
    );
    set("Qty", qty);
    set("Unit Price", unitPrice);
    set(
      "Unit Discount",
      qty ? lineDiscount / qty : 0
    );
    set("Line Gross", lineGross);
    set("Line Discount", lineDiscount);
    set("Shipping", shippingCollected);
    set("Net Line", netLine);
    set("Payment Status", pay);
    set("Fulfillment Status", ful || "unfulfilled");
    set("Channel", "Shopify");
    set("Source", "Shopify");
    set("Notes", gatewayNote || "");
    set("line_uid", lineUid);
    set("DeliveryMode", mode.mode);
    set("TaxChargeable", mode.taxChargeable ? "Y" : "N");
    set("TaxAmount", taxSplit.taxAmount);
    set("RevenueExTax", taxSplit.revenueExTax);
    set("Recognized", recognized ? "Y" : "N");
    set("Posted", "N");
    set("Order Tags", tagStr);

    // Phase 5A — attribution metadata only (does not affect recognition/tax)
    const attr = extractAttributionFromOrder_(order);
    set("Attribution Status", attr.attribution_status);
    set("First Touch Source", attr.first_source);
    set("First Touch Campaign", attr.first_campaign);
    set("First Touch Content", attr.first_content);
    set("Last Touch Source", attr.last_source);
    set("Last Touch Campaign", attr.last_campaign);
    set("Last Touch Content", attr.last_content);
    set("Meta Click ID Present", attr.meta_click);
    set("Attribution Version", attr.attribution_version);

    const existingRow = existing.get(lineUid);
    if (existingRow) {
      // preserve Posted if already Y
      const postedCol = col("Posted");
      if (postedCol >= 0) {
        const prev = sh.getRange(existingRow, postedCol + 1).getValue();
        if (String(prev).toUpperCase() === "Y") row[postedCol] = "Y";
      }
      sh.getRange(existingRow, 1, 1, row.length).setValues([row]);
    } else {
      rowsToAppend.push(row);
    }
  }

  if (rowsToAppend.length) {
    sh
      .getRange(sh.getLastRow() + 1, 1, rowsToAppend.length, headers.length)
      .setValues(rowsToAppend);
  }

  logWebhook_("shopify-webhook-ok", {
    topic,
    orderId,
    orderNumber,
    lines: order.line_items.length,
    mode: mode.mode,
  });
  return ContentService.createTextOutput("OK");
}

function handleShopifyOrderCancelled_(order) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName("Shopify Orders (LIVE)");
  if (!sh) return ContentService.createTextOutput("NO_SHEET");

  const orderId = String(order.id);
  const data = sh.getDataRange().getValues();
  const headers = data[0].map(String);
  const uidCol = headers.indexOf("line_uid");
  const fulCol = headers.indexOf("Fulfillment Status");
  const payCol = headers.indexOf("Payment Status");
  const recCol = headers.indexOf("Recognized");

  for (let i = 1; i < data.length; i++) {
    const uid = String(data[i][uidCol] || "");
    if (!uid.startsWith(`SHOPIFY|${orderId}|`)) continue;
    if (fulCol >= 0) sh.getRange(i + 1, fulCol + 1).setValue("cancelled");
    if (payCol >= 0) sh.getRange(i + 1, payCol + 1).setValue("voided");
    if (recCol >= 0) sh.getRange(i + 1, recCol + 1).setValue("N");
  }

  logWebhook_("shopify-order-cancelled", { orderId });
  return ContentService.createTextOutput("CANCELLED");
}

function handleShopifyRefund_(refund) {
  logWebhook_("shopify-refund", {
    orderId: refund.order_id || null,
    refundId: refund.id || null,
  });
  // Status refresh on next orders/updated or books:sync
  return ContentService.createTextOutput("REFUND_LOGGED");
}

/* ---------- helpers ---------- */

function deliveryModeFromTags_(tags) {
  const list = (tags || []).map((t) => String(t).toLowerCase().trim());
  if (
    list.indexOf("wa:gift") >= 0 ||
    list.indexOf("wa:pr") >= 0 ||
    list.indexOf("delivery:gift") >= 0
  )
    return { mode: "gift", taxChargeable: false };
  if (list.indexOf("delivery:walkin") >= 0 || list.indexOf("delivery:walk-in") >= 0)
    return { mode: "walkin", taxChargeable: false };
  if (list.indexOf("delivery:self") >= 0)
    return { mode: "self", taxChargeable: false };
  if (list.indexOf("delivery:courier") >= 0)
    return { mode: "courier", taxChargeable: true };
  return { mode: "courier", taxChargeable: true };
}

function isRecognized_(fulfillment, payment, tags, mode) {
  const list = (tags || []).map((t) => String(t).toLowerCase().trim());
  if (list.indexOf("wa:hold") >= 0) return false;
  if (list.indexOf("wa:recognized") >= 0) return true;
  const pay = String(payment || "").toLowerCase();
  const ful = String(fulfillment || "").toLowerCase();
  if (["cancelled", "canceled", "voided", "refunded"].indexOf(pay) >= 0)
    return false;
  const paid = pay === "paid" || pay === "partially_paid";
  const fulfilled = ful === "fulfilled" || ful === "delivered";
  if (mode === "gift" && (paid || fulfilled)) return true;
  if ((mode === "walkin" || mode === "self") && paid) return true;
  if (fulfilled && paid) return true;
  return false;
}

function splitInclusiveTax_(gross, taxChargeable) {
  const g = Number(gross) || 0;
  if (!taxChargeable || !(g > 0))
    return { taxAmount: 0, revenueExTax: Math.round(g * 100) / 100 };
  const taxAmount = Math.round(g * (0.18 / 1.18) * 100) / 100;
  return {
    taxAmount,
    revenueExTax: Math.round((g - taxAmount) * 100) / 100,
  };
}

function sumShipping_(order) {
  let s = 0;
  const lines = order.shipping_lines || [];
  for (let i = 0; i < lines.length; i++) s += Number(lines[i].price || 0);
  return s;
}

function getGatewayNote_(order) {
  const g = order.payment_gateway_names || [];
  return g.length ? g.join(", ") : "";
}

/** Phase 5A — parse cart/order note attributes into LIVE attribution columns.
 *  Raw touch columns only. Authoritative Status/Confidence/Phase come from
 *  books live-enrich / attribution normalizer (not storefront classifiers).
 */
function sheetSafeAttribution_(value) {
  if (value == null || value === "") return "";
  const s = String(value);
  if (/^[=+\-@]/.test(s)) return "'" + s;
  return s;
}

function extractAttributionFromOrder_(order) {
  const notes = {};
  const list = order.note_attributes || [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a && a.name) notes[String(a.name)] = a.value;
  }
  let payload = null;
  if (notes._wa_attr) {
    try {
      payload = JSON.parse(String(notes._wa_attr));
    } catch (e) {
      payload = null;
    }
  }
  const first = (payload && payload.first_touch) || {};
  const last = (payload && payload.last_touch) || {};
  const hasClick = !!(
    first.fbclid ||
    first.fbc ||
    last.fbclid ||
    last.fbc ||
    notes.wa_ft_fbclid
  );
  return {
    attribution_status: "",
    first_source: sheetSafeAttribution_(first.source || notes.wa_ft_source || ""),
    first_campaign: sheetSafeAttribution_(
      first.campaign || first.campaign_id || notes.wa_ft_campaign || ""
    ),
    first_content: sheetSafeAttribution_(
      first.content || first.ad_id || notes.wa_ft_content || ""
    ),
    last_source: sheetSafeAttribution_(last.source || notes.wa_lt_source || ""),
    last_campaign: sheetSafeAttribution_(
      last.campaign || last.campaign_id || notes.wa_lt_campaign || ""
    ),
    last_content: sheetSafeAttribution_(
      last.content || last.ad_id || notes.wa_lt_content || ""
    ),
    meta_click: hasClick ? "Y" : "N",
    attribution_version: sheetSafeAttribution_(
      (payload && payload.version) || notes.wa_attr_version || ""
    ),
  };
}

function ensureLiveHeaders_(sh) {
  const needed = [
    "Date",
    "Order #",
    "SKU",
    "Product",
    "Variant",
    "Size",
    "Qty",
    "Unit Price",
    "Unit Discount",
    "Net Unit",
    "Line Gross",
    "Line Discount",
    "Shipping",
    "Tax",
    "Refunded",
    "Net Line",
    "Payment Status",
    "Fulfillment Status",
    "Channel",
    "Source",
    "Notes",
    "Reserved",
    "line_uid",
    "DeliveryMode",
    "TaxChargeable",
    "TaxAmount",
    "RevenueExTax",
    "Recognized",
    "Posted",
    "Order Tags",
    "Attribution Status",
    "First Touch Source",
    "First Touch Campaign",
    "First Touch Content",
    "Last Touch Source",
    "Last Touch Campaign",
    "Last Touch Content",
    "Meta Click ID Present",
    "Attribution Version",
  ];
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, needed.length).setValues([needed]);
    return;
  }
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  for (let i = 0; i < needed.length; i++) {
    if (headers.indexOf(needed[i]) === -1) {
      const c = sh.getLastColumn() + 1;
      sh.getRange(1, c).setValue(needed[i]);
      headers.push(needed[i]);
    }
  }
}

function logWebhook_(type, payload) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sh =
      ss.getSheetByName("_ARCHIVE_Webhook Log") ||
      ss.getSheetByName("Webhook Log");
    if (!sh) return;
    sh.appendRow([new Date(), type, JSON.stringify(payload).slice(0, 50000)]);
  } catch (_) {}
}
