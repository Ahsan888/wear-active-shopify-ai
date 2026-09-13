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
const { parseMoney, splitInclusiveTax, isTaxChargeableFlag, dateKey } = require("../books/tax");
const { isRecognized } = require("../books/recognition");
const {
  PNL_HEADERS,
  MONTH_DETAIL_HEADERS,
  rollupLedger,
  buildDashboardValues,
  buildAnalyticsValues,
  buildChannelAnalyticsValues,
  buildMonthDetailValues,
} = require("../books/reports");

const CHANNEL_REPORTS = [
  { title: "Shopify Analytics", channel: "Shopify" },
  { title: "Manual Analytics", channel: "Manual" },
  { title: "Other Sales Analytics", channel: "Other Sales" },
];
const MONTH_DETAIL_TITLE = "Month Detail";

/**
 * Post / tax-backfill Other Sales using Tax Chargeable.
 * Legacy Apps Script posted full Revenue as Sale and ignored the tax column.
 */
async function collectOtherSalesLedgerUpdates(
  sheets,
  spreadsheetId,
  existingRefs,
  ledgerRows,
  ledgerHeader
) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Other Sales'!A1:Z",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = res.data.values || [];
  if (rows.length < 2) {
    return { append: [], saleCreditFixes: [], processedWrites: [], summary: { newRows: 0, taxBackfill: 0, saleFixes: 0 } };
  }

  const head = rows[0].map((h) => String(h || "").trim());
  const idx = (name) =>
    head.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iDate = idx("Date");
  const iItem = idx("Item");
  const iCat = idx("Category");
  const iQty = idx("Qty");
  const iRev = idx("Revenue");
  const iCost = idx("Cost");
  const iOwn = idx("Owner");
  const iNote = idx("Notes");
  const iProc = idx("Processed");
  const iTax = idx("Tax Chargeable");

  if (iDate < 0 || iProc < 0) {
    throw new Error("Other Sales missing Date or Processed column");
  }
  if (iTax < 0) {
    console.log("Other Sales: no Tax Chargeable column — skipping tax-aware posting");
    return { append: [], saleCreditFixes: [], processedWrites: [], summary: { newRows: 0, taxBackfill: 0, saleFixes: 0 } };
  }

  const iRef = ledgerHeader.indexOf("Ref Key");
  const iCredit = ledgerHeader.indexOf("Credit");
  const iNotes = ledgerHeader.indexOf("Notes");
  const saleRowByRef = new Map();
  for (let i = 1; i < ledgerRows.length; i++) {
    const ref = String(ledgerRows[i][iRef] || "").trim();
    if (ref) saleRowByRef.set(ref, i); // 0-based in values incl header → sheet row = i+1
  }

  const append = [];
  const saleCreditFixes = [];
  const processedWrites = [];
  const now = new Date().toISOString();
  let taxBackfill = 0;
  let saleFixes = 0;
  let newRows = 0;
  const refs = new Set(existingRefs);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.some((v) => String(v ?? "").trim() !== "")) continue;

    const dk = dateKey(row[iDate]);
    if (!dk) continue;

    const revenue = parseMoney(row[iRev]);
    const cost = parseMoney(row[iCost]);
    const qty = parseMoney(row[iQty]) || 1;
    const desc = String(row[iItem] || "").trim() || "Other Sale";
    const category = String(row[iCat] || "Other").trim() || "Other";
    const owner = String(row[iOwn] || "Shared").trim() || "Shared";
    const notes = String(row[iNote] || "").trim();
    const taxChargeable = isTaxChargeableFlag(row[iTax]);
    const isProcessed =
      row[iProc] === true ||
      String(row[iProc] ?? "").toUpperCase() === "TRUE" ||
      String(row[iProc] ?? "").toUpperCase() === "Y" ||
      String(row[iProc] ?? "") === "1";

    const baseUid = `OTHER:${dk}:${r}`;
    const saleKey = `${baseUid}:SALE`;
    const cogsKey = `${baseUid}:COGS`;
    const taxKey = `TAX:${baseUid}`;
    const split = splitInclusiveTax(revenue, taxChargeable);

    // --- Already posted: backfill tax split if needed ---
    if (isProcessed || refs.has(saleKey)) {
      if (taxChargeable && revenue > 0 && !refs.has(taxKey)) {
        append.push([
          dk,
          "Tax",
          "Other Sales",
          "Output Tax",
          `Output tax ${desc}`,
          "",
          qty,
          0,
          split.taxAmount,
          owner,
          "",
          taxKey,
          `other-sales; inclusive 18%; backfill`,
          now,
        ]);
        refs.add(taxKey);
        taxBackfill++;
        newRows++;

        const ledgerIdx = saleRowByRef.get(saleKey);
        if (ledgerIdx != null && iCredit >= 0) {
          const currentCredit = parseMoney(ledgerRows[ledgerIdx][iCredit]);
          // Only shrink if Sale still holds the full inclusive revenue
          if (Math.abs(currentCredit - revenue) < 0.02 && split.taxAmount > 0) {
            saleCreditFixes.push({
              range: `'Ledger'!${colLetter(iCredit + 1)}${ledgerIdx + 1}`,
              values: [[split.revenueExTax]],
            });
            if (iNotes >= 0) {
              const prevNotes = String(ledgerRows[ledgerIdx][iNotes] || "").trim();
              const tag = "taxable; inclusive 18% split";
              saleCreditFixes.push({
                range: `'Ledger'!${colLetter(iNotes + 1)}${ledgerIdx + 1}`,
                values: [[prevNotes ? `${prevNotes}; ${tag}` : tag]],
              });
            }
            ledgerRows[ledgerIdx][iCredit] = split.revenueExTax;
            saleFixes++;
          }
        }
      }
      continue;
    }

    // --- New unprocessed row ---
    if (!revenue && !cost) continue;

    let wrote = false;
    if (revenue > 0 && !refs.has(saleKey)) {
      append.push([
        dk,
        "Sale",
        "Other Sales",
        category,
        desc,
        "",
        qty,
        0,
        taxChargeable ? split.revenueExTax : revenue,
        owner,
        "",
        saleKey,
        taxChargeable
          ? `${notes}${notes ? "; " : ""}taxable; inclusive 18%`
          : `${notes}${notes ? "; " : ""}exempt`,
        now,
      ]);
      refs.add(saleKey);
      wrote = true;
      newRows++;
    }

    if (taxChargeable && split.taxAmount > 0 && !refs.has(taxKey)) {
      append.push([
        dk,
        "Tax",
        "Other Sales",
        "Output Tax",
        `Output tax ${desc}`,
        "",
        qty,
        0,
        split.taxAmount,
        owner,
        "",
        taxKey,
        "other-sales; inclusive 18%",
        now,
      ]);
      refs.add(taxKey);
      wrote = true;
      newRows++;
    }

    if (cost > 0 && !refs.has(cogsKey)) {
      append.push([
        dk,
        "COGS",
        "Other Sales",
        "COGS",
        `COGS ${desc}`,
        "",
        qty,
        cost,
        0,
        owner,
        "",
        cogsKey,
        notes,
        now,
      ]);
      refs.add(cogsKey);
      wrote = true;
      newRows++;
    }

    if (wrote || refs.has(saleKey) || refs.has(cogsKey)) {
      processedWrites.push({
        range: `'Other Sales'!${colLetter(iProc + 1)}${r + 1}`,
        values: [["TRUE"]],
      });
    }
  }

  return {
    append,
    saleCreditFixes,
    processedWrites,
    summary: { newRows, taxBackfill, saleFixes },
  };
}

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

async function ensureReportSheets(sheets, spreadsheetId, titles) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  const existing = new Set(
    (meta.data.sheets || []).map((sheet) => sheet.properties.title)
  );
  const missing = titles.filter((title) => !existing.has(title));
  if (!missing.length) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: missing.map((title) => ({
        addSheet: {
          properties: {
            title,
            gridProperties: {
              rowCount: 1000,
              columnCount: 26,
              frozenRowCount: 1,
            },
          },
        },
      })),
    },
  });
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

function overlayFormat(sheetId, rowStart, rowEnd, colStart, colEnd, format) {
  const fields = Object.keys(format)
    .map((key) => `userEnteredFormat.${key}`)
    .join(",");
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
      fields,
    },
  };
}

function overlayNumberFormat(
  sheetId,
  rowStart,
  rowEnd,
  colStart,
  colEnd,
  pattern,
  type = "NUMBER"
) {
  return overlayFormat(sheetId, rowStart, rowEnd, colStart, colEnd, {
    numberFormat: { type, pattern },
  });
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

async function formatReports(
  sheets,
  spreadsheetId,
  meta,
  dashValues,
  analyticsValues,
  pnlRowCount,
  channelReportValues,
  monthDetailValues
) {
  const byTitle = (title) => meta.data.sheets.find((s) => s.properties.title === title);
  const dashSheet = byTitle("Dashboard");
  const pnlSheet = byTitle("Monthly P&L");
  const analyticsSheet = byTitle("Analytics");
  const monthDetailSheet = byTitle(MONTH_DETAIL_TITLE);
  const dashId = dashSheet?.properties.sheetId;
  const pnlId = pnlSheet?.properties.sheetId;
  const analyticsId = analyticsSheet?.properties.sheetId;
  const monthDetailId = monthDetailSheet?.properties.sheetId;
  const channelSheets = CHANNEL_REPORTS.map(({ title, channel }) => ({
    title,
    channel,
    sheet: byTitle(title),
    values: channelReportValues[channel],
  }));
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

  for (const sheet of [
    dashSheet,
    pnlSheet,
    analyticsSheet,
    monthDetailSheet,
    ...channelSheets.map((report) => report.sheet),
  ].filter(Boolean)) {
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
      numberFormat(pnlId, 1, pnlRowCount, 1, 2, "0"),
      numberFormat(pnlId, 1, pnlRowCount, 2, 9, money),
      numberFormat(pnlId, 1, pnlRowCount, 9, 10, percent, "PERCENT"),
      numberFormat(pnlId, 1, pnlRowCount, 10, 14, money),
      numberFormat(pnlId, 1, pnlRowCount, 14, 15, percent, "PERCENT"),
      numberFormat(pnlId, 1, pnlRowCount, 15, 17, count),
      numberFormat(pnlId, 1, pnlRowCount, 17, 19, money),
      numberFormat(pnlId, 1, pnlRowCount, 19, 20, percent, "PERCENT"),
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId: pnlId,
              startRowIndex: 0,
              endRowIndex: pnlRowCount,
              startColumnIndex: 0,
              endColumnIndex: PNL_HEADERS.length,
            },
          },
        },
      }
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
    const sectionPrefixes = [
      "OPEN PIPELINE", "YEAR-OVER-YEAR SUMMARY", "SALES CHANNEL MIX", "SHOPIFY DELIVERY ROUTE",
      "TOP SHOPIFY SALES", "TOP MANUAL SALES", "TOP OTHER SALES",
      "EXPENSE MIX", "TAX MIX", "DELIVERY", "PRODUCT FAMILY",
      "BESTSELLERS", "LOWEST-MARGIN", "12-MONTH",
    ];
    for (const prefix of sectionPrefixes) {
      const row = findRow(analyticsValues, prefix);
      if (row >= 0) requests.push(repeatFormat(analyticsId, row, row + 1, 0, 9, sectionFormat));
    }
    const headerStarts = [
      "Metric", "Year", "Channel", "Route", "Item", "Category", "Product family",
      "By revenue", "SKU", "Month",
    ];
    for (let row = 0; row < analyticsValues.length; row++) {
      if (headerStarts.includes(String(analyticsValues[row][0] || ""))) {
        requests.push(repeatFormat(analyticsId, row, row + 1, 0, 9, headerFormat));
      }
    }
    const expenseHeader = findRow(analyticsValues, "Category");
    const annualHeader = findRow(analyticsValues, "Year");
    const channelHeader = findRow(analyticsValues, "Channel");
    const routeHeader = findRow(analyticsValues, "Route");
    const familyHeader = findRow(analyticsValues, "Product family");
    const bestHeader = findRow(analyticsValues, "By revenue");
    const lowHeader = findRow(analyticsValues, "SKU");
    const trendHeader = findRow(analyticsValues, "Month");
    if (annualHeader >= 0) {
      const end = endOfSection(analyticsValues, annualHeader);
      requests.push(numberFormat(analyticsId, annualHeader + 1, end, 0, 1, "0"));
      requests.push(numberFormat(analyticsId, annualHeader + 1, end, 1, 4, money));
      requests.push(numberFormat(analyticsId, annualHeader + 1, end, 4, 5, percent, "PERCENT"));
      requests.push(numberFormat(analyticsId, annualHeader + 1, end, 5, 6, money));
      requests.push(numberFormat(analyticsId, annualHeader + 1, end, 6, 7, percent, "PERCENT"));
      requests.push(numberFormat(analyticsId, annualHeader + 1, end, 7, 8, count));
      requests.push(numberFormat(analyticsId, annualHeader + 1, end, 8, 9, money));
      requests.push({
        setBasicFilter: {
          filter: {
            range: {
              sheetId: analyticsId,
              startRowIndex: annualHeader,
              endRowIndex: end,
              startColumnIndex: 0,
              endColumnIndex: 9,
            },
          },
        },
      });
    }
    if (channelHeader >= 0) {
      const end = endOfSection(analyticsValues, channelHeader);
      requests.push(numberFormat(analyticsId, channelHeader + 1, end, 1, 2, money));
      requests.push(numberFormat(analyticsId, channelHeader + 1, end, 2, 3, count));
      requests.push(numberFormat(analyticsId, channelHeader + 1, end, 3, 4, money));
      requests.push(numberFormat(analyticsId, channelHeader + 1, end, 4, 5, count));
      requests.push(numberFormat(analyticsId, channelHeader + 1, end, 5, 6, percent, "PERCENT"));
    }
    if (routeHeader >= 0) {
      const end = endOfSection(analyticsValues, routeHeader);
      requests.push(numberFormat(analyticsId, routeHeader + 1, end, 1, 2, money));
      requests.push(numberFormat(analyticsId, routeHeader + 1, end, 2, 3, count));
      requests.push(numberFormat(analyticsId, routeHeader + 1, end, 3, 4, money));
      requests.push(numberFormat(analyticsId, routeHeader + 1, end, 4, 5, count));
    }
    for (let row = 0; row < analyticsValues.length; row++) {
      if (analyticsValues[row][0] !== "Item") continue;
      const end = endOfSection(analyticsValues, row);
      requests.push(numberFormat(analyticsId, row + 1, end, 1, 4, money));
      requests.push(numberFormat(analyticsId, row + 1, end, 4, 5, percent, "PERCENT"));
      requests.push(numberFormat(analyticsId, row + 1, end, 5, 6, count));
    }
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
    if (taxMixRow >= 0) requests.push(numberFormat(analyticsId, taxMixRow, taxMixRow + 1, 1, 3, percent, "PERCENT"));
    for (const label of [
      "Output tax accrued",
      "Taxable revenue ex-tax",
      "Exempt / legacy-untracked revenue",
      "Delivery expense",
      "Delivery cost / courier order",
    ]) {
      const row = findRow(analyticsValues, label);
      if (row >= 0) requests.push(numberFormat(analyticsId, row, row + 1, 1, 3, money));
    }
    const courierOrdersRow = findRow(analyticsValues, "Courier orders");
    if (courierOrdersRow >= 0) {
      requests.push(numberFormat(analyticsId, courierOrdersRow, courierOrdersRow + 1, 1, 2, count));
    }
  }

  for (const report of channelSheets) {
    const sheetId = report.sheet?.properties.sheetId;
    const values = report.values || [];
    if (sheetId == null || !values.length) continue;
    requests.push(
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
      repeatFormat(sheetId, 0, 1, 0, 10, titleFormat),
      dimensionWidth(sheetId, 0, 1, 85),
      dimensionWidth(sheetId, 1, 2, 170),
      dimensionWidth(sheetId, 2, 3, 320),
      dimensionWidth(sheetId, 3, 10, 125)
    );
    for (const prefix of [
      "YEAR-OVER-YEAR PERFORMANCE",
      "DELIVERY ROUTE BY YEAR",
      "TOP ITEMS BY YEAR",
    ]) {
      const row = findRow(values, prefix);
      if (row >= 0) {
        requests.push(repeatFormat(sheetId, row, row + 1, 0, 10, sectionFormat));
      }
    }
    for (let row = 0; row < values.length; row++) {
      if (values[row][0] === "Year") {
        requests.push(repeatFormat(sheetId, row, row + 1, 0, 10, headerFormat));
      }
    }
    const annualHeader = values.findIndex(
      (row) => row[0] === "Year" && row[1] === "Gross collected"
    );
    const routeHeader = values.findIndex(
      (row) => row[0] === "Year" && row[1] === "Route"
    );
    const topHeader = values.findIndex(
      (row) => row[0] === "Year" && row[1] === "Rank"
    );
    if (annualHeader >= 0) {
      const end = endOfSection(values, annualHeader);
      requests.push(numberFormat(sheetId, annualHeader + 1, end, 0, 1, "0"));
      requests.push(numberFormat(sheetId, annualHeader + 1, end, 1, 6, money));
      requests.push(numberFormat(sheetId, annualHeader + 1, end, 6, 7, percent, "PERCENT"));
      requests.push(numberFormat(sheetId, annualHeader + 1, end, 7, 9, count));
      requests.push(numberFormat(sheetId, annualHeader + 1, end, 9, 10, money));
    }
    if (routeHeader >= 0) {
      const end = endOfSection(values, routeHeader);
      requests.push(numberFormat(sheetId, routeHeader + 1, end, 0, 1, "0"));
      requests.push(numberFormat(sheetId, routeHeader + 1, end, 2, 3, money));
      requests.push(numberFormat(sheetId, routeHeader + 1, end, 3, 5, count));
      requests.push(numberFormat(sheetId, routeHeader + 1, end, 5, 6, percent, "PERCENT"));
    }
    if (topHeader >= 0) {
      const end = endOfSection(values, topHeader);
      requests.push(numberFormat(sheetId, topHeader + 1, end, 0, 2, "0"));
      requests.push(numberFormat(sheetId, topHeader + 1, end, 3, 6, money));
      requests.push(numberFormat(sheetId, topHeader + 1, end, 6, 7, percent, "PERCENT"));
      requests.push(numberFormat(sheetId, topHeader + 1, end, 7, 8, count));
      requests.push({
        setBasicFilter: {
          filter: {
            range: {
              sheetId,
              startRowIndex: topHeader,
              endRowIndex: end,
              startColumnIndex: 0,
              endColumnIndex: 8,
            },
          },
        },
      });
    }
  }

  if (monthDetailId != null && Array.isArray(monthDetailValues) && monthDetailValues.length) {
    const headerRow = monthDetailValues.findIndex(
      (row) => row[0] === "Month" && row[1] === "Step"
    );
    const colCount = MONTH_DETAIL_HEADERS.length;
    const dataStart = headerRow >= 0 ? headerRow + 1 : 4;
    const dataEnd = monthDetailValues.length;
    const firstDataSheetRow = dataStart + 1;
    const latestMonth = monthDetailValues
      .slice(dataStart)
      .map((row) => String(row[0] || ""))
      .filter(Boolean)
      .sort()
      .at(-1);
    const monthMoney = "#,##0;[Red](#,##0);–";
    const monthPercent = "0.0%;[Red](0.0%);–";
    const divider = { red: 0.78, green: 0.82, blue: 0.84 };
    const bodyFormat = {
      backgroundColor: { red: 1, green: 1, blue: 1 },
      textFormat: {
        fontSize: 10,
        foregroundColor: { red: 0.16, green: 0.2, blue: 0.22 },
      },
      verticalAlignment: "MIDDLE",
      wrapStrategy: "CLIP",
      borders: {
        bottom: { style: "SOLID", color: { red: 0.91, green: 0.92, blue: 0.93 } },
      },
    };
    const subtitleFormat = {
      backgroundColor: { red: 0.95, green: 0.97, blue: 0.96 },
      textFormat: {
        fontSize: 10,
        foregroundColor: { red: 0.28, green: 0.35, blue: 0.33 },
      },
      wrapStrategy: "WRAP",
      verticalAlignment: "MIDDLE",
    };
    const blockColors = {
      "01 · Snapshot": { red: 0.8, green: 0.88, blue: 0.94 },
      "02 · Profit story": { red: 0.93, green: 0.87, blue: 0.73 },
      "03 · Revenue sources": { red: 0.78, green: 0.9, blue: 0.86 },
      "04 · Shopify operations": { red: 0.84, green: 0.9, blue: 0.94 },
      "05 · Tax & expenses": { red: 0.88, green: 0.84, blue: 0.93 },
      "06 · Gift & PR": { red: 0.94, green: 0.82, blue: 0.84 },
      "07 · Best products": { red: 0.84, green: 0.91, blue: 0.82 },
      "08 · Decision cues": { red: 0.83, green: 0.88, blue: 0.76 },
    };
    const pnlRowFormat = {
      backgroundColor: { red: 0.16, green: 0.28, blue: 0.38 },
      textFormat: {
        bold: true,
        foregroundColor: { red: 1, green: 1, blue: 1 },
      },
    };

    const existingRules = monthDetailSheet?.conditionalFormats || [];
    for (let i = existingRules.length - 1; i >= 0; i--) {
      requests.push({
        deleteConditionalFormatRule: { sheetId: monthDetailId, index: i },
      });
    }
    requests.push({
      unmergeCells: {
        range: {
          sheetId: monthDetailId,
          startRowIndex: 0,
          endRowIndex: Math.max(dataEnd, 5),
          startColumnIndex: 0,
          endColumnIndex: 26,
        },
      },
    });
    requests.push(
      repeatFormat(
        monthDetailId,
        0,
        Math.max(dataEnd, 300),
        0,
        colCount,
        {}
      )
    );

    requests.push(
      {
        updateSheetProperties: {
          properties: {
            sheetId: monthDetailId,
            tabColorStyle: {
              rgbColor: { red: 0.12, green: 0.33, blue: 0.42 },
            },
            gridProperties: {
              frozenRowCount: 0,
              frozenColumnCount: 0,
              hideGridlines: true,
            },
          },
          fields:
            "tabColorStyle,gridProperties.frozenRowCount,gridProperties.frozenColumnCount,gridProperties.hideGridlines",
        },
      },
      {
        mergeCells: {
          range: {
            sheetId: monthDetailId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 3,
          },
          mergeType: "MERGE_ALL",
        },
      },
      {
        mergeCells: {
          range: {
            sheetId: monthDetailId,
            startRowIndex: 1,
            endRowIndex: 2,
            startColumnIndex: 0,
            endColumnIndex: 3,
          },
          mergeType: "MERGE_ALL",
        },
      },
      {
        mergeCells: {
          range: {
            sheetId: monthDetailId,
            startRowIndex: 2,
            endRowIndex: 3,
            startColumnIndex: 0,
            endColumnIndex: 3,
          },
          mergeType: "MERGE_ALL",
        },
      },
      repeatFormat(monthDetailId, 0, 1, 0, colCount, {
        ...titleFormat,
        horizontalAlignment: "LEFT",
      }),
      repeatFormat(monthDetailId, 1, 3, 0, colCount, subtitleFormat),
      {
        updateSheetProperties: {
          properties: {
            sheetId: monthDetailId,
            gridProperties: {
              frozenRowCount: headerRow >= 0 ? headerRow + 1 : 5,
              frozenColumnCount: 3,
            },
          },
          fields:
            "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        },
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId: monthDetailId,
            dimension: "ROWS",
            startIndex: 0,
            endIndex: 1,
          },
          properties: { pixelSize: 42 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId: monthDetailId,
            dimension: "ROWS",
            startIndex: dataStart,
            endIndex: dataEnd,
          },
          properties: { pixelSize: 36 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId: monthDetailId,
            dimension: "ROWS",
            startIndex: 1,
            endIndex: 3,
          },
          properties: { pixelSize: 34 },
          fields: "pixelSize",
        },
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId: monthDetailId,
            dimension: "COLUMNS",
            startIndex: 0,
            endIndex: colCount,
          },
          properties: { hiddenByUser: false },
          fields: "hiddenByUser",
        },
      },
      dimensionWidth(monthDetailId, 0, 1, 92),
      dimensionWidth(monthDetailId, 1, 2, 160),
      dimensionWidth(monthDetailId, 2, 3, 240),
      dimensionWidth(monthDetailId, 3, 4, 120),
      dimensionWidth(monthDetailId, 4, 5, 100),
      dimensionWidth(monthDetailId, 5, 6, 170),
      dimensionWidth(monthDetailId, 6, 7, 260),
      dimensionWidth(monthDetailId, 7, 8, 330)
    );

    if (headerRow >= 0) {
      requests.push(
        repeatFormat(monthDetailId, headerRow, headerRow + 1, 0, colCount, {
          ...headerFormat,
          backgroundColor: { red: 0.12, green: 0.33, blue: 0.42 },
          textFormat: {
            bold: true,
            foregroundColor: { red: 1, green: 1, blue: 1 },
            fontSize: 10,
          },
          horizontalAlignment: "CENTER",
        }),
        {
          updateDimensionProperties: {
            range: {
              sheetId: monthDetailId,
              dimension: "ROWS",
              startIndex: headerRow,
              endIndex: headerRow + 1,
            },
            properties: { pixelSize: 44 },
            fields: "pixelSize",
          },
        },
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId: monthDetailId,
                startRowIndex: headerRow,
                endRowIndex: dataEnd,
                startColumnIndex: 0,
                endColumnIndex: colCount,
              },
              ...(latestMonth
                ? {
                    criteria: {
                      0: {
                        condition: {
                          type: "TEXT_EQ",
                          values: [{ userEnteredValue: latestMonth }],
                        },
                      },
                    },
                  }
                : {}),
            },
          },
        }
      );
    }

    if (dataEnd > dataStart) {
      requests.push(
        repeatFormat(monthDetailId, dataStart, dataEnd, 0, colCount, bodyFormat),
        overlayFormat(monthDetailId, dataStart, dataEnd, 0, 1, {
          textFormat: {
            bold: true,
            fontSize: 10,
            foregroundColor: { red: 0.12, green: 0.31, blue: 0.27 },
          },
        }),
        overlayFormat(monthDetailId, dataStart, dataEnd, 2, 3, {
          textFormat: {
            bold: true,
            fontSize: 10,
            foregroundColor: { red: 0.14, green: 0.18, blue: 0.2 },
          },
          wrapStrategy: "WRAP",
        }),
        overlayFormat(monthDetailId, dataStart, dataEnd, 3, 5, {
          horizontalAlignment: "RIGHT",
        }),
        overlayNumberFormat(monthDetailId, dataStart, dataEnd, 3, 4, monthMoney),
        overlayNumberFormat(
          monthDetailId,
          dataStart,
          dataEnd,
          4,
          5,
          monthPercent,
          "PERCENT"
        ),
        overlayFormat(monthDetailId, dataStart, dataEnd, 5, 8, {
          textFormat: {
            fontSize: 9,
            foregroundColor: { red: 0.35, green: 0.38, blue: 0.42 },
          },
          wrapStrategy: "WRAP",
        }),
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [
                {
                  sheetId: monthDetailId,
                  startRowIndex: dataStart,
                  endRowIndex: dataEnd,
                  startColumnIndex: 3,
                  endColumnIndex: 5,
                },
              ],
              booleanRule: {
                condition: {
                  type: "CUSTOM_FORMULA",
                  values: [
                    {
                      userEnteredValue: `=AND($C${firstDataSheetRow}="Net profit",D${firstDataSheetRow}<0)`,
                    },
                  ],
                },
                format: {
                  backgroundColor: { red: 0.96, green: 0.8, blue: 0.8 },
                  textFormat: {
                    foregroundColor: { red: 0.55, green: 0.05, blue: 0.05 },
                    bold: true,
                  },
                },
              },
            },
            index: 0,
          },
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [
                {
                  sheetId: monthDetailId,
                  startRowIndex: dataStart,
                  endRowIndex: dataEnd,
                  startColumnIndex: 3,
                  endColumnIndex: 5,
                },
              ],
              booleanRule: {
                condition: {
                  type: "CUSTOM_FORMULA",
                  values: [
                    {
                      userEnteredValue: `=AND($C${firstDataSheetRow}="Net profit",D${firstDataSheetRow}>0)`,
                    },
                  ],
                },
                format: {
                  backgroundColor: { red: 0.82, green: 0.93, blue: 0.84 },
                  textFormat: {
                    foregroundColor: { red: 0.08, green: 0.35, blue: 0.18 },
                    bold: true,
                  },
                },
              },
            },
            index: 1,
          },
        }
      );

      let bandStart = dataStart;
      while (bandStart < dataEnd) {
        const block = String(monthDetailValues[bandStart]?.[1] || "");
        let bandEnd = bandStart + 1;
        while (
          bandEnd < dataEnd &&
          String(monthDetailValues[bandEnd]?.[1] || "") === block
        ) {
          bandEnd++;
        }
        const color = blockColors[block];
        if (color) {
          requests.push(
            overlayFormat(monthDetailId, bandStart, bandEnd, 1, 2, {
              backgroundColor: color,
              textFormat: {
                bold: true,
                fontSize: 9,
                foregroundColor: { red: 0.1, green: 0.2, blue: 0.18 },
              },
              verticalAlignment: "MIDDLE",
            }),
            overlayFormat(monthDetailId, bandStart, bandStart + 1, 0, colCount, {
              borders: {
                top: { style: "SOLID_MEDIUM", color: divider },
                bottom: {
                  style: "SOLID",
                  color: { red: 0.91, green: 0.92, blue: 0.93 },
                },
              },
            })
          );
        }
        bandStart = bandEnd;
      }

      for (let row = dataStart; row < dataEnd; row++) {
        const block = String(monthDetailValues[row]?.[1] || "");
        const line = String(monthDetailValues[row]?.[2] || "");
        if (block === "02 · Profit story" && line === "Net profit") {
          requests.push(
            overlayFormat(monthDetailId, row, row + 1, 0, colCount, pnlRowFormat)
          );
        }
      }
    }
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }
}

function parseExcludeOrders(argv) {
  const flag = argv.find((a) => a.startsWith("--exclude-orders="));
  if (!flag) return new Set();
  return new Set(
    flag
      .slice("--exclude-orders=".length)
      .split(",")
      .map((s) => String(s || "").trim().replace(/^#/, ""))
      .filter(Boolean)
  );
}

function normalizeOrderNumber(value) {
  return String(value || "")
    .trim()
    .replace(/^#/, "");
}

async function main() {
  const reportsOnly = process.argv.includes("--reports-only");
  const apply = process.argv.includes("--apply") && !reportsOnly;
  const skipShopify = process.argv.includes("--skip-shopify");
  const excludeOrders = parseExcludeOrders(process.argv);
  console.log(
    `Mode: ${reportsOnly ? "REPORTS-ONLY" : apply ? "APPLY" : "DRY-RUN"}${skipShopify ? " (skip Shopify)" : ""}`
  );
  if (excludeOrders.size) {
    console.log(
      `Excluding orders from Ledger post: ${[...excludeOrders].join(", ")}`
    );
  }

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

  const { writes: enrichWritesBase } = enrichLiveRows(
    header,
    dataRows,
    orderMeta
  );
  const enrichWrites = [...enrichWritesBase];

  // Force excluded orders to stay unposted (sheet + ledger)
  if (excludeOrders.size && iRec >= 0) {
    for (let i = 0; i < dataRows.length; i++) {
      const order = normalizeOrderNumber(dataRows[i][iOrder]);
      if (!order || !excludeOrders.has(order)) continue;
      dataRows[i][iRec] = "N";
      dataRows[i].__meta = {
        ...(dataRows[i].__meta || {}),
        rec: { recognized: false, reason: "exclude_orders" },
      };
      enrichWrites.push({
        range: `'Shopify Orders (LIVE)'!${colLetter(iRec + 1)}${i + 2}`,
        values: [["N"]],
      });
    }
  }

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
    const posted =
      uid && (existing.has(`SALE:${uid}`) || existing.has(`GIFT:${uid}`))
        ? "Y"
        : "N";
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
  let skippedExcluded = 0;

  for (const r of dataRows) {
    const uid = String(r[iUid] || "").trim();
    if (!uid) continue;
    const meta = r.__meta;
    const order = normalizeOrderNumber(r[iOrder]);
    if (excludeOrders.has(order)) {
      skippedExcluded++;
      if (!existing.has(`SALE:${uid}`) && !existing.has(`GIFT:${uid}`)) {
        openPipelineLines++;
        pipeline.orders.add(order);
        pipeline.gross += parseMoney(r[iNet]);
        pipeline.units += parseMoney(r[iQty]);
      }
      continue;
    }
    const rec = meta?.rec || isRecognized({
      fulfillmentStatus: r[iFul],
      paymentStatus: r[iPay],
      tags: String(r[iTags] || "").split(","),
      deliveryMode: r[iMode],
    });

    const gross = parseMoney(r[iNet]);
    const qty = parseMoney(r[iQty]);

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

    if (!gross && deliveryModeFromRow(meta, r, iMode) !== "gift") {
      skippedNoNet++;
      continue;
    }

    const cogsRef = `COGS:${uid}`;
    const taxRef = `TAX:${uid}`;
    const giftRef = `GIFT:${uid}`;

    if (existing.has(saleRef) || existing.has(giftRef)) {
      skippedPosted++;
      continue;
    }

    const taxChargeable =
      meta?.modeInfo?.taxChargeable ??
      String(r[iTaxY] || "").toUpperCase() === "Y";
    const deliveryMode = String(
      meta?.modeInfo?.mode || r[iMode] || "courier"
    ).toLowerCase();
    const isGift = deliveryMode === "gift";
    const split =
      meta?.taxSplit ||
      splitInclusiveTax(isGift ? 0 : gross, isGift ? false : taxChargeable);
    const sku = String(r[iSku] || "").trim();
    const rowDate = String(r[iDate] || "").trim();
    const prod = r[iProd];

    if (isGift) {
      // Gift / PR: no revenue, no tax — inventory cost still books as COGS
      out.push([
        rowDate,
        "Gift",
        "Shopify",
        "Gift/PR",
        prod,
        sku,
        qty,
        0,
        0,
        "Shared",
        "",
        giftRef,
        `delivery:gift; exempt; no customer value`,
        now,
      ]);
      existing.add(giftRef);
    } else {
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
        `delivery:${deliveryMode}; ${taxChargeable ? "taxable" : "exempt"}`,
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
          `delivery:${deliveryMode}; inclusive 18%`,
          now,
        ]);
        existing.add(taxRef);
      }
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
        isGift ? "gift/PR" : "",
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
    `Post candidates: ${out.length} ledger rows | unrec ${skippedUnrec} | already ${skippedPosted} | noNet ${skippedNoNet} | excluded ${skippedExcluded}`
  );
  console.log("Pipeline:", pipelineSummary);

  const otherSales = await collectOtherSalesLedgerUpdates(
    sheets,
    spreadsheetId,
    existing,
    ledger,
    lHead
  );
  out.push(...otherSales.append);
  for (const row of otherSales.append) {
    const ref = String(row[11] || "").trim();
    if (ref) existing.add(ref);
  }
  console.log(
    `Other Sales: +${otherSales.summary.newRows} ledger rows (tax backfill ${otherSales.summary.taxBackfill}, sale credit fixes ${otherSales.summary.saleFixes})`
  );

  // Meta Ads → Recurring Expenses + Ledger (monthly upsert; soft-skip if no credentials)
  let metaExpenses = null;
  const {
    runMetaExpensesSync,
    printPlan,
  } = require("./meta-expenses-sync");
  const { applyPlanToPreviewLedger } = require("../books/meta-expenses");
  try {
    metaExpenses = await runMetaExpensesSync({
      sheets,
      spreadsheetId,
      apply: false, // plan only here; write during apply below
      months: 1,
    });
    if (!metaExpenses.skipped) {
      printPlan(metaExpenses);
    } else {
      console.log(`Meta expenses skipped: ${metaExpenses.reason}`);
    }
  } catch (err) {
    console.log(`Meta expenses skipped (error): ${err.message || err}`);
    metaExpenses = { skipped: true, reason: "error", plan: null };
  }

  // Rebuild reports from full ledger + new outs (apply in-memory sale credit fixes first)
  const previewLedger = ledger.slice(1).map((row) => [...row]);
  const iCreditCol = lHead.indexOf("Credit");
  const iNotesCol = lHead.indexOf("Notes");
  if (!reportsOnly) {
    for (const fix of otherSales.saleCreditFixes) {
      const m = String(fix.range).match(/!([A-Z]+)(\d+)$/);
      if (!m) continue;
      const col = m[1];
      const previewIdx = Number(m[2]) - 2;
      if (previewIdx < 0 || previewIdx >= previewLedger.length) continue;
      if (iCreditCol >= 0 && col === colLetter(iCreditCol + 1)) {
        previewLedger[previewIdx][iCreditCol] = fix.values[0][0];
      }
      if (iNotesCol >= 0 && col === colLetter(iNotesCol + 1)) {
        previewLedger[previewIdx][iNotesCol] = fix.values[0][0];
      }
    }
    previewLedger.push(...out);
    if (metaExpenses?.plan) {
      applyPlanToPreviewLedger(previewLedger, lHead, metaExpenses.plan);
    }
  }

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
  const monthDetailValues = buildMonthDetailValues(rollup);
  const channelReportValues = Object.fromEntries(
    CHANNEL_REPORTS.map(({ channel }) => [
      channel,
      buildChannelAnalyticsValues(rollup, channel),
    ])
  );

  if (!apply && !reportsOnly) {
    console.log("Sample posts:", out.slice(0, 6));
    console.log(`Monthly P&L rows: ${rollup.monthlyRows.length}`);
    console.log(`Month Detail rows: ${monthDetailValues.length}`);
    console.log(
      "Channel report rows:",
      Object.fromEntries(
        Object.entries(channelReportValues).map(([channel, values]) => [
          channel,
          values.length,
        ])
      )
    );
    console.log("Dry-run only. Re-run with --apply.");
    return;
  }

  if (apply) {
    // Write enrich + posted flags only during a full accounting sync.
    await batchWrite(sheets, spreadsheetId, [
      ...enrichWrites,
      ...postedWrites,
      ...otherSales.saleCreditFixes,
      ...otherSales.processedWrites,
    ]);
    console.log(
      `Updated LIVE enrich cells: ${enrichWrites.length + postedWrites.length}; Other Sales fixes/processed: ${otherSales.saleCreditFixes.length + otherSales.processedWrites.length}`
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
        if (
          uid &&
          (existing.has(`SALE:${uid}`) || existing.has(`GIFT:${uid}`)) &&
          iPosted >= 0
        ) {
          morePosted.push({
            range: `'Shopify Orders (LIVE)'!${colLetter(iPosted + 1)}${i + 2}`,
            values: [["Y"]],
          });
        }
      }
      await batchWrite(sheets, spreadsheetId, morePosted);
    }

    if (metaExpenses?.plan && !metaExpenses.skipped) {
      const written = await runMetaExpensesSync({
        sheets,
        spreadsheetId,
        apply: true,
        months: 1,
      });
      printPlan(written);
      console.log("Synced Meta Ads into Recurring Expenses + Ledger.");
    }
  }

  await ensureReportSheets(
    sheets,
    spreadsheetId,
    [MONTH_DETAIL_TITLE, ...CHANNEL_REPORTS.map((report) => report.title)]
  );

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
    range: `'${MONTH_DETAIL_TITLE}'!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${MONTH_DETAIL_TITLE}'!A1`,
    valueInputOption: "RAW",
    requestBody: { values: monthDetailValues },
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

  for (const { title, channel } of CHANNEL_REPORTS) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${title}'!A:Z`,
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${title}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: channelReportValues[channel] },
    });
  }

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
    fields: "sheets(properties,charts,conditionalFormats)",
  });
  await formatReports(
    sheets,
    spreadsheetId,
    meta,
    dashValues,
    analyticsValues,
    rollup.monthlyRows.length + 1,
    channelReportValues,
    monthDetailValues
  );

  console.log(
    "Rebuilt Dashboard, Month Detail, Monthly P&L, Analytics, and channel analytics."
  );
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

function deliveryModeFromRow(meta, row, iMode) {
  const fromMeta = String(meta?.modeInfo?.mode || "").toLowerCase();
  if (fromMeta) return fromMeta;
  return String(row[iMode] || "courier").toLowerCase();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
