require("dotenv").config();
const {
  getSheetsClient,
  requireSpreadsheetId,
} = require("../sheets/client");
const {
  fetchOrderMetaByIds,
  parseUid,
  enrichLiveRows,
} = require("../books/live-enrich");
const { parseMoney, splitInclusiveTax } = require("../books/tax");
const { isRecognized } = require("../books/recognition");
const {
  PNL_HEADERS,
  rollupLedger,
  buildDashboardValues,
  buildAnalyticsValues,
} = require("../books/reports");

async function batchWrite(sheets, spreadsheetId, data) {
  for (let i = 0; i < data.length; i += 80) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: data.slice(i, i + 80),
      },
    });
  }
}

async function loadVariantCatalog(sheets, spreadsheetId) {
  const vm = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Variant Master'!A:K",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = vm.data.values || [];
  const header = (rows[0] || []).map(String);
  const index = (name) => header.indexOf(name);
  const catalogBySku = {};
  const costMap = {};
  for (const row of rows.slice(1)) {
    const sku = String(row[index("SKU")] || "").trim();
    const cost = Number(row[index("CostPerItem")]) || 0;
    if (!sku) continue;
    catalogBySku[sku] = {
      product: String(row[index("Product")] || "").trim(),
      category: String(row[index("Category")] || "").trim(),
      cost,
    };
    if (cost > 0) costMap[sku] = cost;
  }
  return { costMap, catalogBySku };
}

function repeatFormat(sheetId, rowStart, rowEnd, colStart, colEnd, format) {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowStart,
        endRowIndex: rowEnd,
        startColumnIndex: colStart,
        endColumnIndex: colEnd,
      },
      cell: { userEnteredFormat: format },
      fields: "userEnteredFormat",
    },
  };
}

function numberFormat(sheetId, rowStart, rowEnd, colStart, colEnd, pattern, type = "NUMBER") {
  return repeatFormat(sheetId, rowStart, rowEnd, colStart, colEnd, {
    numberFormat: { type, pattern },
  });
}

function dimensionWidth(sheetId, start, end, pixelSize) {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex: start, endIndex: end },
      properties: { pixelSize },
      fields: "pixelSize",
    },
  };
}

function findRow(values, prefix) {
  return values.findIndex((row) => String(row[0] || "").startsWith(prefix));
}

function endOfSection(values, headerRow) {
  let end = headerRow + 1;
  while (end < values.length && values[end].some((cell) => cell !== "")) end++;
  return end;
}

async function formatReports(sheets, spreadsheetId, meta, dashValues, analyticsValues, pnlRowCount) {
  const byTitle = (title) => meta.data.sheets.find((s) => s.properties.title === title);
  const dashSheet = byTitle("Dashboard");
  const pnlSheet = byTitle("Monthly P&L");
  const analyticsSheet = byTitle("Analytics");
  const dashId = dashSheet?.properties.sheetId;
  const pnlId = pnlSheet?.properties.sheetId;
  const analyticsId = analyticsSheet?.properties.sheetId;
  const requests = [];
  const money = "#,##0.00;[Red]-#,##0.00";
  const percent = "0.0%;[Red]-0.0%";
  const count = "#,##0";
  const titleFormat = {
    backgroundColor: { red: 0.09, green: 0.2, blue: 0.31 },
    textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 14 },
    verticalAlignment: "MIDDLE",
  };
  const sectionFormat = {
    backgroundColor: { red: 0.85, green: 0.92, blue: 0.86 },
    textFormat: { bold: true, foregroundColor: { red: 0.09, green: 0.25, blue: 0.15 } },
  };
  const headerFormat = {
    backgroundColor: { red: 0.9, green: 0.94, blue: 0.97 },
    textFormat: { bold: true },
    wrapStrategy: "WRAP",
    verticalAlignment: "MIDDLE",
  };

  for (const sheet of [dashSheet, pnlSheet, analyticsSheet].filter(Boolean)) {
    const sheetId = sheet.properties.sheetId;
    requests.push(repeatFormat(sheetId, 0, 300, 0, 26, {}));
  }
  for (const chart of dashSheet?.charts || []) {
    requests.push({ deleteEmbeddedObject: { objectId: chart.chartId } });
  }

  if (dashId != null) {
    requests.push(
      { updateSheetProperties: { properties: { sheetId: dashId, gridProperties: { frozenRowCount: 4, frozenColumnCount: 1 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
      repeatFormat(dashId, 0, 1, 0, 6, titleFormat),
      repeatFormat(dashId, 3, 4, 0, 6, headerFormat),
      repeatFormat(dashId, 20, 21, 0, 6, sectionFormat),
      repeatFormat(dashId, 21, 22, 0, 3, headerFormat),
      repeatFormat(dashId, 26, 27, 0, 6, sectionFormat),
      repeatFormat(dashId, 10, 11, 0, 6, { textFormat: { bold: true } }),
      repeatFormat(dashId, 14, 15, 0, 6, { textFormat: { bold: true } }),
      repeatFormat(dashId, dashValues.length - 1, dashValues.length, 0, 6, { textFormat: { italic: true, foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } } }),
      dimensionWidth(dashId, 0, 1, 265),
      dimensionWidth(dashId, 1, 6, 125)
    );
    for (const row of [4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 18]) {
      requests.push(numberFormat(dashId, row, row + 1, 1, 4, money));
      requests.push(numberFormat(dashId, row, row + 1, 5, 6, money));
      requests.push(numberFormat(dashId, row, row + 1, 4, 5, percent, "PERCENT"));
    }
    for (const row of [11, 15]) {
      requests.push(numberFormat(dashId, row, row + 1, 1, 4, percent, "PERCENT"));
      requests.push(numberFormat(dashId, row, row + 1, 5, 6, percent, "PERCENT"));
    }
    for (const row of [16, 17]) {
      requests.push(numberFormat(dashId, row, row + 1, 1, 4, count));
      requests.push(numberFormat(dashId, row, row + 1, 5, 6, count));
      requests.push(numberFormat(dashId, row, row + 1, 4, 5, percent, "PERCENT"));
    }
    requests.push(
      numberFormat(dashId, 22, 23, 1, 2, count),
      numberFormat(dashId, 23, 24, 1, 2, money),
      numberFormat(dashId, 24, 25, 1, 2, count)
    );
  }

  if (pnlId != null) {
    requests.push(
      { updateSheetProperties: { properties: { sheetId: pnlId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
      repeatFormat(pnlId, 0, 1, 0, PNL_HEADERS.length, headerFormat),
      dimensionWidth(pnlId, 0, 1, 95),
      dimensionWidth(pnlId, 1, PNL_HEADERS.length, 128),
      numberFormat(pnlId, 1, pnlRowCount, 1, 8, money),
      numberFormat(pnlId, 1, pnlRowCount, 8, 9, percent, "PERCENT"),
      numberFormat(pnlId, 1, pnlRowCount, 9, 13, money),
      numberFormat(pnlId, 1, pnlRowCount, 13, 14, percent, "PERCENT"),
      numberFormat(pnlId, 1, pnlRowCount, 14, 16, count),
      numberFormat(pnlId, 1, pnlRowCount, 16, 18, money),
      numberFormat(pnlId, 1, pnlRowCount, 18, 19, percent, "PERCENT")
    );
  }

  if (analyticsId != null) {
    requests.push(
      { updateSheetProperties: { properties: { sheetId: analyticsId, gridProperties: { frozenRowCount: 2, frozenColumnCount: 1 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
      repeatFormat(analyticsId, 0, 1, 0, 9, titleFormat),
      dimensionWidth(analyticsId, 0, 1, 315),
      dimensionWidth(analyticsId, 1, 5, 140),
      dimensionWidth(analyticsId, 5, 6, 315),
      dimensionWidth(analyticsId, 6, 9, 125)
    );
    const sectionPrefixes = ["OPEN PIPELINE", "EXPENSE MIX", "TAX MIX", "DELIVERY", "PRODUCT FAMILY", "BESTSELLERS", "LOWEST-MARGIN", "12-MONTH"];
    for (const prefix of sectionPrefixes) {
      const row = findRow(analyticsValues, prefix);
      if (row >= 0) requests.push(repeatFormat(analyticsId, row, row + 1, 0, 9, sectionFormat));
    }
    const headerStarts = ["Metric", "Category", "Product family", "By revenue", "SKU", "Month"];
    for (let row = 0; row < analyticsValues.length; row++) {
      if (headerStarts.includes(String(analyticsValues[row][0] || ""))) {
        requests.push(repeatFormat(analyticsId, row, row + 1, 0, 9, headerFormat));
      }
    }
    const expenseHeader = findRow(analyticsValues, "Category");
    const familyHeader = findRow(analyticsValues, "Product family");
    const bestHeader = findRow(analyticsValues, "By revenue");
    const lowHeader = findRow(analyticsValues, "SKU");
    const trendHeader = findRow(analyticsValues, "Month");
    if (expenseHeader >= 0) {
      const end = endOfSection(analyticsValues, expenseHeader);
      requests.push(numberFormat(analyticsId, expenseHeader + 1, end, 1, 2, money));
      requests.push(numberFormat(analyticsId, expenseHeader + 1, end, 2, 3, percent, "PERCENT"));
    }
    if (familyHeader >= 0) {
      const end = endOfSection(analyticsValues, familyHeader);
      requests.push(numberFormat(analyticsId, familyHeader + 1, end, 1, 4, money));
      requests.push(numberFormat(analyticsId, familyHeader + 1, end, 4, 5, percent, "PERCENT"));
    }
    if (bestHeader >= 0) {
      const end = endOfSection(analyticsValues, bestHeader);
      requests.push(numberFormat(analyticsId, bestHeader + 1, end, 1, 2, money));
      requests.push(numberFormat(analyticsId, bestHeader + 1, end, 2, 3, count));
      requests.push(numberFormat(analyticsId, bestHeader + 1, end, 3, 4, percent, "PERCENT"));
      requests.push(numberFormat(analyticsId, bestHeader + 1, end, 6, 7, count));
      requests.push(numberFormat(analyticsId, bestHeader + 1, end, 7, 8, money));
      requests.push(numberFormat(analyticsId, bestHeader + 1, end, 8, 9, percent, "PERCENT"));
    }
    if (lowHeader >= 0) {
      const end = endOfSection(analyticsValues, lowHeader);
      requests.push(numberFormat(analyticsId, lowHeader + 1, end, 2, 4, money));
      requests.push(numberFormat(analyticsId, lowHeader + 1, end, 4, 5, percent, "PERCENT"));
    }
    if (trendHeader >= 0) {
      const end = endOfSection(analyticsValues, trendHeader);
      requests.push(numberFormat(analyticsId, trendHeader + 1, end, 1, 3, money));
      requests.push(numberFormat(analyticsId, trendHeader + 1, end, 3, 5, percent, "PERCENT"));
    }
    requests.push(
      numberFormat(analyticsId, 6, 7, 1, 2, money),
      numberFormat(analyticsId, 5, 6, 1, 2, count),
      numberFormat(analyticsId, 7, 8, 1, 2, count)
    );
    const taxMixRow = findRow(analyticsValues, "Taxable mix %");
    if (taxMixRow >= 0) requests.push(numberFormat(analyticsId, taxMixRow, taxMixRow + 1, 1, 2, percent, "PERCENT"));
    for (const label of [
      "Output tax accrued",
      "Taxable revenue ex-tax",
      "Exempt / legacy-untracked revenue",
      "Delivery expense",
      "Delivery cost / courier order",
    ]) {
      const row = findRow(analyticsValues, label);
      if (row >= 0) requests.push(numberFormat(analyticsId, row, row + 1, 1, 2, money));
    }
    const courierOrdersRow = findRow(analyticsValues, "Courier orders");
    if (courierOrdersRow >= 0) {
      requests.push(numberFormat(analyticsId, courierOrdersRow, courierOrdersRow + 1, 1, 2, count));
    }
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const skipShopify = process.argv.includes("--skip-shopify");
  console.log(
    `Mode: ${apply ? "APPLY" : "DRY-RUN"}${skipShopify ? " (skip Shopify)" : ""}`
  );

  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();

  const [liveRes, ledgerRes] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Shopify Orders (LIVE)'!A1:AF",
      valueRenderOption: "FORMATTED_VALUE",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Ledger'!A1:N",
      valueRenderOption: "FORMATTED_VALUE",
    }),
  ]);

  const live = liveRes.data.values || [];
  const header = (live[0] || []).map(String);
  const dataRows = live.slice(1);
  const col = (n) => header.indexOf(n);
  const iUid = col("line_uid");
  const iDate = col("Date");
  const iOrder = col("Order #");
  const iSku = col("SKU");
  const iProd = col("Product");
  const iQty = col("Qty");
  const iNet = col("Net Line");
  const iPay = col("Payment Status");
  const iFul = col("Fulfillment Status");
  const iPosted = col("Posted");
  const iRec = col("Recognized");
  const iMode = col("DeliveryMode");
  const iTaxY = col("TaxChargeable");
  const iTaxAmt = col("TaxAmount");
  const iRev = col("RevenueExTax");
  const iTags = col("Order Tags");

  const orderIds = [];
  for (const r of dataRows) {
    const p = parseUid(r[iUid]);
    if (p) orderIds.push(p.orderId);
  }

  let orderMeta = {};
  if (!skipShopify) {
    console.log(`Fetching Shopify meta for ${[...new Set(orderIds)].length} orders...`);
    orderMeta = await fetchOrderMetaByIds(orderIds);
  }

  const { writes: enrichWrites } = enrichLiveRows(
    header,
    dataRows,
    orderMeta
  );

  const ledger = ledgerRes.data.values || [];
  const lHead = ledger[0].map(String);
  const lRef = lHead.indexOf("Ref Key");
  const existing = new Set(
    ledger
      .slice(1)
      .map((r) => String(r[lRef] || "").trim())
      .filter(Boolean)
  );

  // Mark Posted on LIVE
  const postedWrites = [];
  for (let i = 0; i < dataRows.length; i++) {
    const uid = String(dataRows[i][iUid] || "").trim();
    const posted = uid && existing.has(`SALE:${uid}`) ? "Y" : "N";
    if (iPosted >= 0) {
      dataRows[i][iPosted] = posted;
      postedWrites.push({
        range: `'Shopify Orders (LIVE)'!${colLetter(iPosted + 1)}${i + 2}`,
        values: [[posted]],
      });
    }
  }

  const { costMap, catalogBySku } = await loadVariantCatalog(
    sheets,
    spreadsheetId
  );
  const out = [];
  const now = new Date().toISOString();
  const pipeline = { orders: new Set(), gross: 0, units: 0 };
  let openPipelineLines = 0;
  let skippedUnrec = 0;
  let skippedPosted = 0;
  let skippedNoNet = 0;

  for (const r of dataRows) {
    const uid = String(r[iUid] || "").trim();
    if (!uid) continue;
    const meta = r.__meta;
    const rec = meta?.rec || isRecognized({
      fulfillmentStatus: r[iFul],
      paymentStatus: r[iPay],
      tags: String(r[iTags] || "").split(","),
      deliveryMode: r[iMode],
    });

    const gross = parseMoney(r[iNet]);
    const qty = parseMoney(r[iQty]);
    const order = String(r[iOrder] || "").replace(/^#/, "");

    const saleRef = `SALE:${uid}`;
    if (!rec.recognized) {
      skippedUnrec++;
      if (rec.reason !== "cancelled_or_refunded" && !existing.has(saleRef)) {
        openPipelineLines++;
        pipeline.orders.add(order);
        pipeline.gross += gross;
        pipeline.units += qty;
      }
      continue;
    }

    if (!gross) {
      skippedNoNet++;
      continue;
    }

    const cogsRef = `COGS:${uid}`;
    const taxRef = `TAX:${uid}`;

    if (existing.has(saleRef)) {
      skippedPosted++;
      continue;
    }

    const taxChargeable =
      meta?.modeInfo?.taxChargeable ??
      String(r[iTaxY] || "").toUpperCase() === "Y";
    const split =
      meta?.taxSplit || splitInclusiveTax(gross, taxChargeable);
    const sku = String(r[iSku] || "").trim();
    const rowDate = String(r[iDate] || "").trim();
    const prod = r[iProd];

    // Sale = revenue ex-tax
    out.push([
      rowDate,
      "Sale",
      "Shopify",
      "Product",
      prod,
      sku,
      qty,
      0,
      split.revenueExTax,
      "Shared",
      "",
      saleRef,
      taxChargeable ? "taxable" : "exempt",
      now,
    ]);
    existing.add(saleRef);

    if (taxChargeable && split.taxAmount > 0) {
      out.push([
        rowDate,
        "Tax",
        "Shopify",
        "Output Tax",
        `Output tax ${prod || sku}`,
        sku,
        qty,
        0,
        split.taxAmount,
        "Shared",
        "",
        taxRef,
        "inclusive 18%",
        now,
      ]);
      existing.add(taxRef);
    }

    const unitCost = sku ? costMap[sku] || 0 : 0;
    const cogsAmt = unitCost * qty;
    if (cogsAmt > 0 && !existing.has(cogsRef)) {
      out.push([
        rowDate,
        "COGS",
        "Shopify",
        "COGS",
        `COGS ${prod || sku}`,
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
    }
  }

  const pipelineSummary = {
    orders: pipeline.orders.size,
    gross: pipeline.gross,
    units: pipeline.units,
  };

  console.log(
    `Post candidates: ${out.length} ledger rows | unrec ${skippedUnrec} | already ${skippedPosted} | noNet ${skippedNoNet}`
  );
  console.log("Pipeline:", pipelineSummary);

  // Rebuild reports from full ledger + new outs
  const previewLedger = apply
    ? [...ledger.slice(1), ...out]
    : [...ledger.slice(1), ...out];

  const rollup = rollupLedger(previewLedger, lHead, catalogBySku);
  const alerts = [];
  if (pipelineSummary.orders)
    alerts.push(
      `${pipelineSummary.orders} orders in open pipeline (not booked)`
    );
  if (openPipelineLines)
    alerts.push(`${openPipelineLines} open LIVE lines awaiting recognition`);

  const dashValues = buildDashboardValues(
    rollup,
    pipelineSummary,
    alerts
  );
  const analyticsValues = buildAnalyticsValues(rollup, pipelineSummary);

  if (!apply) {
    console.log("Sample posts:", out.slice(0, 6));
    console.log(`Monthly P&L rows: ${rollup.monthlyRows.length}`);
    console.log("Dry-run only. Re-run with --apply.");
    return;
  }

  // Write enrich + posted flags
  await batchWrite(sheets, spreadsheetId, [...enrichWrites, ...postedWrites]);
  console.log(
    `Updated LIVE enrich cells: ${enrichWrites.length + postedWrites.length}`
  );

  if (out.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "'Ledger'!A:N",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: out },
    });
    console.log(`Appended ${out.length} Ledger rows`);

    // refresh Posted flags for newly posted
    const morePosted = [];
    for (let i = 0; i < dataRows.length; i++) {
      const uid = String(dataRows[i][iUid] || "").trim();
      if (uid && existing.has(`SALE:${uid}`) && iPosted >= 0) {
        morePosted.push({
          range: `'Shopify Orders (LIVE)'!${colLetter(iPosted + 1)}${i + 2}`,
          values: [["Y"]],
        });
      }
    }
    await batchWrite(sheets, spreadsheetId, morePosted);
  }

  // Clear & write reports (RAW so large numbers aren't parsed as dates)
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: "'Monthly P&L'!A:Z",
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "'Monthly P&L'!A1",
    valueInputOption: "RAW",
    requestBody: { values: [PNL_HEADERS, ...rollup.monthlyRows] },
  });

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: "'Analytics'!A:Z",
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "'Analytics'!A1",
    valueInputOption: "RAW",
    requestBody: { values: analyticsValues },
  });

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: "'Dashboard'!A:Z",
  });
  // Clear leftover chart objects / percent formats by rewriting RAW
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "'Dashboard'!A1",
    valueInputOption: "RAW",
    requestBody: { values: dashValues },
  });

  // Clear stale formats, apply readable report formatting, and delete Dashboard charts.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties,charts)",
  });
  await formatReports(
    sheets,
    spreadsheetId,
    meta,
    dashValues,
    analyticsValues,
    rollup.monthlyRows.length + 1
  );

  console.log("Rebuilt Dashboard, Monthly P&L, Analytics.");
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

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
