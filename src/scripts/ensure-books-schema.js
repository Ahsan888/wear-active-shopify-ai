require("dotenv").config();
const {
  getSheetsClient,
  requireSpreadsheetId,
} = require("../sheets/client");

/**
 * Ensure operating sheets + LIVE/Other Sales schema extensions exist.
 */
async function ensureSheet(sheets, spreadsheetId, title, index) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  const existing = (meta.data.sheets || []).find(
    (s) => s.properties.title === title
  );
  if (existing) return existing.properties.sheetId;

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title,
              index: index ?? undefined,
              gridProperties: { frozenRowCount: 1 },
            },
          },
        },
      ],
    },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

async function main() {
  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();

  await ensureSheet(sheets, spreadsheetId, "Monthly P&L", 2);
  await ensureSheet(sheets, spreadsheetId, "Analytics", 3);

  // Seed headers if empty
  for (const [title, headers] of [
    [
      "Monthly P&L",
      [
        "Month",
        "Gross sales",
        "Output tax",
        "Revenue ex-tax",
        "Refunds",
        "COGS",
        "Gross profit",
        "Gross margin %",
        "Delivery expense",
        "Other expenses",
        "Net profit",
        "Net margin %",
        "Taxable sales",
        "Exempt sales",
        "Orders",
        "Units",
      ],
    ],
    [
      "Analytics",
      ["Section", "Key", "Value", "Month", "Notes"],
    ],
  ]) {
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${title}'!A1:A1`,
    });
    if (!cur.data.values?.[0]?.[0]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${title}'!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [headers] },
      });
    }
  }

  // Other Sales: Tax Chargeable column
  const other = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Other Sales'!1:1",
  });
  const oh = (other.data.values?.[0] || []).map(String);
  let taxChargeableCol = oh.indexOf("Tax Chargeable") + 1;
  if (!oh.includes("Tax Chargeable")) {
    const col = oh.length + 1;
    taxChargeableCol = col;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'Other Sales'!${colToA1(col)}1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Tax Chargeable"]] },
    });
    console.log("Added Other Sales Tax Chargeable");
  } else {
    console.log("Other Sales Tax Chargeable already present");
  }

  const sheetMeta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)",
  });
  const otherSheetId = sheetMeta.data.sheets.find(
    (sheet) => sheet.properties.title === "Other Sales"
  )?.properties.sheetId;
  if (otherSheetId != null && taxChargeableCol > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            setDataValidation: {
              range: {
                sheetId: otherSheetId,
                startRowIndex: 1,
                startColumnIndex: taxChargeableCol - 1,
                endColumnIndex: taxChargeableCol,
              },
              rule: {
                condition: {
                  type: "BOOLEAN",
                  values: [
                    { userEnteredValue: "Y" },
                    { userEnteredValue: "N" },
                  ],
                },
                strict: true,
                showCustomUi: true,
              },
            },
          },
          {
            updateDimensionProperties: {
              range: {
                sheetId: otherSheetId,
                dimension: "COLUMNS",
                startIndex: taxChargeableCol - 1,
                endIndex: taxChargeableCol,
              },
              properties: { pixelSize: 125 },
              fields: "pixelSize",
            },
          },
        ],
      },
    });
    console.log("Other Sales Tax Chargeable checkboxes ensured (Y/N)");
  }

  // LIVE: extend schema — write new headers after last unique col, remove dup line_uid conceptually by not using col Y
  const live = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Shopify Orders (LIVE)'!1:1",
  });
  const lh = (live.data.values?.[0] || []).map(String);
  const needed = [
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
  const toAdd = needed.filter((h) => !lh.includes(h));
  if (toAdd.length) {
    // Append only missing headers after the current header row (never rewrite existing)
    const start = lh.length + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'Shopify Orders (LIVE)'!${colToA1(start)}1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [toAdd] },
    });
    // Blank out duplicate line_uid at Y if it's the second one
    if (lh[24] === "line_uid" || lh[23] === "notes") {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'Shopify Orders (LIVE)'!X1:Y1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["", ""]] },
      });
    }
    console.log("Added LIVE columns:", toAdd.join(", "));
  } else {
    console.log("LIVE tax/recognition/attribution columns already present");
  }

  // Config sheet seed
  await ensureSheet(sheets, spreadsheetId, "Config", 20);
  const cfg = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Config'!A1:B5",
  });
  if (!cfg.data.values?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Config'!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          ["Key", "Value"],
          ["tax_rate", "0.18"],
          ["default_delivery_mode", "courier"],
          ["books_sync_skip_unrecognized", "TRUE"],
        ],
      },
    });
    console.log("Seeded Config");
  }

  console.log("Schema ensure complete.");
}

function colToA1(n) {
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
