const { graphql } = require("../shopify/client");
const {
  deliveryModeFromTags,
  splitInclusiveTax,
  parseMoney,
  hasTag,
} = require("./tax");
const { isRecognized } = require("./recognition");

/**
 * Fetch Shopify order statuses/tags for numeric order IDs found in line_uids.
 * @param {string[]} uids SHOPIFY|orderId|lineId
 */
async function fetchOrderMetaByIds(orderIds) {
  const unique = [...new Set(orderIds.filter(Boolean))];
  const map = {};
  // Batch via nodes query in chunks of 20
  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    const ids = chunk.map((id) => `gid://shopify/Order/${id}`);
    const data = await graphql(
      `query ($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            name
            tags
            displayFinancialStatus
            displayFulfillmentStatus
            cancelledAt
            customAttributes { key value }
            customerJourneySummary {
              ready
              firstVisit {
                landingPage
                referrerUrl
                source
                utmParameters { source medium campaign content term }
                occurredAt
              }
              lastVisit {
                landingPage
                referrerUrl
                source
                utmParameters { source medium campaign content term }
                occurredAt
              }
            }
          }
        }
      }`,
      { ids }
    );
    for (const node of data.nodes || []) {
      if (!node?.id) continue;
      const id = String(node.id).split("/").pop();
      map[id] = {
        tags: node.tags || [],
        paymentStatus: String(node.displayFinancialStatus || "").toLowerCase(),
        fulfillmentStatus: String(
          node.displayFulfillmentStatus || ""
        ).toLowerCase(),
        cancelled: !!node.cancelledAt,
        name: node.name,
        customAttributes: node.customAttributes || [],
        customerJourneySummary: node.customerJourneySummary || null,
      };
    }
  }
  return map;
}

function parseUid(uid) {
  const m = String(uid || "").match(/^SHOPIFY\|(\d+)\|(\d+)$/);
  if (!m) return null;
  return { orderId: m[1], lineId: m[2] };
}

/**
 * Enrich LIVE rows in memory; returns { rows, header, col, enrichWrites }
 * enrichWrites: batchUpdate ranges for new columns
 */
function enrichLiveRows(header, dataRows, orderMeta) {
  const { normalizeOrderAttribution } = require("../attribution/normalize");
  const { liveSheetAttributionColumns } = require("../attribution/coverage");
  const col = (name) => header.indexOf(name);
  const iUid = col("line_uid");
  const iPay = col("Payment Status");
  const iFul = col("Fulfillment Status");
  const iNet = col("Net Line");
  const iMode = col("DeliveryMode");
  const iTaxY = col("TaxChargeable");
  const iTaxAmt = col("TaxAmount");
  const iRev = col("RevenueExTax");
  const iRec = col("Recognized");
  const iPosted = col("Posted");
  const iTags = col("Order Tags");

  const writes = [];

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const rowNum = i + 2; // 1-header
    const uid = String(r[iUid] || "").trim();
    const parsed = parseUid(uid);
    const meta = parsed ? orderMeta[parsed.orderId] : null;

    let tags = meta?.tags || [];
    if (iTags >= 0 && r[iTags]) {
      tags = String(r[iTags])
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (meta?.tags?.length) tags = meta.tags;

    const pay =
      (meta && meta.paymentStatus) ||
      String(r[iPay] || "")
        .toLowerCase()
        .replace(/\s+/g, "_");
    const ful =
      (meta && meta.fulfillmentStatus) ||
      String(r[iFul] || "")
        .toLowerCase()
        .replace(/\s+/g, "_");

    // Map Shopify display enums: FULFILLED -> fulfilled, PAID -> paid
    const payN = String(pay).toLowerCase();
    const fulN = String(ful).toLowerCase();

    const modeInfo = deliveryModeFromTags(tags);
    const gross = parseMoney(r[iNet]);
    const taxSplit = splitInclusiveTax(gross, modeInfo.taxChargeable);
    const rec = isRecognized({
      fulfillmentStatus: fulN,
      paymentStatus: payN,
      tags,
      deliveryMode: modeInfo.mode,
    });

    // mutate row for downstream
    if (iMode >= 0) r[iMode] = modeInfo.mode;
    if (iTaxY >= 0) r[iTaxY] = modeInfo.taxChargeable ? "Y" : "N";
    if (iTaxAmt >= 0) r[iTaxAmt] = taxSplit.taxAmount;
    if (iRev >= 0) r[iRev] = taxSplit.revenueExTax;
    if (iRec >= 0) r[iRec] = rec.recognized ? "Y" : "N";
    if (iTags >= 0) r[iTags] = (tags || []).join(", ");
    if (iPay >= 0 && meta) r[iPay] = payN;
    if (iFul >= 0 && meta) r[iFul] = fulN;

    const rowWrites = [];
    if (iMode >= 0) rowWrites.push([iMode, modeInfo.mode]);
    if (iTaxY >= 0) rowWrites.push([iTaxY, modeInfo.taxChargeable ? "Y" : "N"]);
    if (iTaxAmt >= 0) rowWrites.push([iTaxAmt, taxSplit.taxAmount]);
    if (iRev >= 0) rowWrites.push([iRev, taxSplit.revenueExTax]);
    if (iRec >= 0) rowWrites.push([iRec, rec.recognized ? "Y" : "N"]);
    if (iTags >= 0) rowWrites.push([iTags, (tags || []).join(", ")]);
    if (iPay >= 0 && meta) rowWrites.push([iPay, payN]);
    if (iFul >= 0 && meta) rowWrites.push([iFul, fulN]);

    // Attribution metadata only — does not change recognition/tax/COGS
    if (meta) {
      const attr = normalizeOrderAttribution({
        name: meta.name,
        customAttributes: meta.customAttributes,
        customerJourneySummary: meta.customerJourneySummary,
      });
      const cols = liveSheetAttributionColumns(attr);
      for (const [name, val] of Object.entries(cols)) {
        const cIdx = col(name);
        if (cIdx >= 0) {
          r[cIdx] = val;
          rowWrites.push([cIdx, val]);
        }
      }
    }

    for (const [cIdx, val] of rowWrites) {
      writes.push({
        range: `'Shopify Orders (LIVE)'!${colLetter(cIdx + 1)}${rowNum}`,
        values: [[val]],
      });
    }

    r.__meta = { modeInfo, taxSplit, rec, payN, fulN, tags };
  }

  return { writes };
}

function colLetter(n) {
  let s = "";
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

module.exports = {
  fetchOrderMetaByIds,
  parseUid,
  enrichLiveRows,
  colLetter,
};
