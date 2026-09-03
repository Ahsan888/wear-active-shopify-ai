require("dotenv").config();
const fs = require("fs");
const { graphql } = require("../shopify/client");
const {
  getSheetsClient,
  requireSpreadsheetId,
} = require("../sheets/client");

const EXCLUDE_ORDERS = new Set(["1346", "1353", "1355", "1356", "1357"]);

function parseMoney(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function parseDate(raw) {
  if (raw instanceof Date && !isNaN(raw)) return raw;
  const s = String(raw || "").trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    let y = +m[1],
      mo = +m[2],
      da = +m[3];
    let d = new Date(y, mo - 1, da);
    if (d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === da)
      return d;
    if (mo > 12 && da <= 12) {
      d = new Date(y, da - 1, mo);
      if (!isNaN(d)) return d;
    }
  }
  const d2 = new Date(s);
  return isNaN(d2) ? s : d2;
}

function sheetDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return d;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function skuFromLineUid(uid) {
  const m = String(uid).match(/^SHOPIFY\|(\d+)\|(\d+)$/);
  if (!m) return null;
  const orderGid = `gid://shopify/Order/${m[1]}`;
  const lineId = m[2];
  const data = await graphql(
    `query ($id: ID!) {
      order(id: $id) {
        name
        lineItems(first: 50) {
          nodes {
            id
            sku
            name
            variant { sku title }
          }
        }
      }
    }`,
    { id: orderGid }
  );
  const nodes = data.order?.lineItems?.nodes || [];
  for (const li of nodes) {
    const id = String(li.id).split("/").pop();
    if (id === lineId) {
      return String(li.sku || li.variant?.sku || "").trim() || null;
    }
  }
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);

  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();

  const [liveRes, ledgerRes, vmRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Shopify Orders (LIVE)'!A1:Y",
      valueRenderOption: "FORMATTED_VALUE",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Ledger'!A:L",
      valueRenderOption: "FORMATTED_VALUE",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Variant Master'!G:K",
      valueRenderOption: "UNFORMATTED_VALUE",
    }),
  ]);

  const live = liveRes.data.values || [];
  const ledger = ledgerRes.data.values || [];
  const vmRows = (vmRes.data.values || []).slice(1);

  const costMap = {};
  for (const r of vmRows) {
    const sku = String(r[4] || "").trim();
    const cost = Number(r[0]) || 0;
    if (sku) costMap[sku] = cost;
  }

  const h = live[0].map(String);
  const col = (name) => h.indexOf(name);
  const iDate = col("Date");
  const iOrder = col("Order #");
  const iSku = col("SKU");
  const iProd = col("Product");
  const iQty = col("Qty");
  const iNet = col("Net Line");
  const iUid = col("line_uid"); // first occurrence

  const lHead = ledger[0].map(String);
  const lRef = lHead.indexOf("Ref Key");
  const existing = new Set(
    ledger
      .slice(1)
      .map((r) => String(r[lRef] || "").trim())
      .filter(Boolean)
  );

  // --- Fix missing SKUs ---
  const skuFixes = [];
  for (let i = 1; i < live.length; i++) {
    const r = live[i] || [];
    const sku = String(r[iSku] || "").trim();
    const uid = String(r[iUid] || "").trim();
    if (sku || !uid) continue;
    const found = await skuFromLineUid(uid);
    skuFixes.push({
      row: i + 1,
      order: String(r[iOrder] || "").replace(/^#/, ""),
      product: r[iProd],
      uid,
      sku: found,
    });
    if (found) r[iSku] = found;
  }

  console.log(`Missing SKU rows: ${skuFixes.length}`);
  for (const f of skuFixes) {
    console.log(
      `  row ${f.row} order ${f.order} ${f.product} -> ${f.sku || "(still missing)"}`
    );
  }

  if (apply && skuFixes.some((f) => f.sku)) {
    const data = skuFixes
      .filter((f) => f.sku)
      .map((f) => ({
        range: `'Shopify Orders (LIVE)'!C${f.row}`,
        values: [[f.sku]],
      }));
    if (data.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data },
      });
      console.log(`Wrote ${data.length} SKUs to LIVE`);
    }
  }

  // --- Build ledger posts ---
  const out = [];
  const skipped = {
    excluded: 0,
    noUid: 0,
    noNet: 0,
    alreadySale: 0,
    alreadyCogs: 0,
    noCost: 0,
  };
  const byOrder = {};

  for (let i = 1; i < live.length; i++) {
    const r = live[i] || [];
    const order = String(r[iOrder] || "")
      .replace(/^#/, "")
      .trim();
    const uid = String(r[iUid] || "").trim();
    if (!uid) {
      skipped.noUid++;
      continue;
    }
    if (EXCLUDE_ORDERS.has(order)) {
      skipped.excluded++;
      continue;
    }

    const qty = parseMoney(r[iQty]);
    const netLine = parseMoney(r[iNet]);
    if (!netLine) {
      skipped.noNet++;
      continue;
    }

    const sku = String(r[iSku] || "").trim();
    const saleRef = `SALE:${uid}`;
    const cogsRef = `COGS:${uid}`;
    const rowDate = sheetDate(parseDate(r[iDate]));
    const now = new Date().toISOString();

    byOrder[order] = byOrder[order] || { sale: 0, cogs: 0 };

    if (!existing.has(saleRef)) {
      out.push([
        rowDate,
        "Sale",
        "Shopify",
        "Product",
        r[iProd],
        sku,
        qty,
        0,
        netLine,
        "Shared",
        "",
        saleRef,
        "",
        now,
      ]);
      existing.add(saleRef);
      byOrder[order].sale++;
    } else {
      skipped.alreadySale++;
    }

    const unitCost = sku ? costMap[sku] || 0 : 0;
    const cogsAmt = unitCost * qty;
    if (cogsAmt > 0) {
      if (!existing.has(cogsRef)) {
        out.push([
          rowDate,
          "COGS",
          "Shopify",
          "COGS",
          `COGS ${r[iProd] || sku}`,
          sku,
          qty,
          cogsAmt,
          0,
          "Shared",
          "",
          cogsRef,
          "",
          now,
        ]);
        existing.add(cogsRef);
        byOrder[order].cogs++;
      } else {
        skipped.alreadyCogs++;
      }
    } else if (sku) {
      skipped.noCost++;
    }
  }

  const newOrders = Object.entries(byOrder).filter(
    ([, v]) => v.sale > 0 || v.cogs > 0
  );
  const saleRows = out.filter((r) => r[1] === "Sale").length;
  const cogsRows = out.filter((r) => r[1] === "COGS").length;
  const revenue = out
    .filter((r) => r[1] === "Sale")
    .reduce((s, r) => s + Number(r[8] || 0), 0);

  console.log("");
  console.log(`Ledger rows to append: ${out.length} (Sale ${saleRows}, COGS ${cogsRows})`);
  console.log(`Orders with new posts: ${newOrders.length}`);
  console.log(`Revenue (new sales): ${revenue.toFixed(2)}`);
  console.log("Skipped:", skipped);
  console.log(
    "Sample new sale refs:",
    out
      .filter((r) => r[1] === "Sale")
      .slice(0, 8)
      .map((r) => r[11])
  );

  fs.writeFileSync(
    "/tmp/shopify-ledger-post-plan.json",
    JSON.stringify({ out, skipped, skuFixes, newOrders }, null, 2)
  );

  if (!apply) {
    console.log("Dry-run only. Re-run with --apply to write SKUs + Ledger.");
    return;
  }

  if (!out.length) {
    console.log("Nothing to post.");
    return;
  }

  // Ensure ledger has enough columns (14)
  const append = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "'Ledger'!A:N",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: out },
  });
  console.log(
    `Appended to Ledger: ${append.data.updates?.updatedRange} (${append.data.updates?.updatedRows} rows)`
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
