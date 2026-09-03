require("dotenv").config();
const fs = require("fs");
const {
  getSheetsClient,
  requireSpreadsheetId,
} = require("../sheets/client");

async function main() {
  const apply = process.argv.includes("--apply");
  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();
  const newRows = JSON.parse(fs.readFileSync("/tmp/vm-new-rows.json", "utf8"));

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Variant Master'!A:A",
  });
  const startRow = (existing.data.values || []).length + 1;

  const values = newRows.map((r, i) => {
    const row = startRow + i;
    return [
      r.product,
      r.category,
      r.size,
      r.sizeCode,
      "", // Qty Total Produced — fill later when you set opening stock
      "", // Qty Current intentionally blank
      "", // CostPerItem unknown for now
      r.price,
      r.productCode,
      r.colorCode,
      r.sku,
      "",
      "",
      "",
      `=IFERROR(SUMIFS('Shopify Orders'!$G:$G, 'Shopify Orders'!$C:$C, $K${row}, 'Shopify Orders'!$T:$T, "Shopify"), 0)`,
      `=IFERROR(SUMIFS('Manual Tracker'!$E:$E, 'Manual Tracker'!$J:$J, $K${row}, 'Manual Tracker'!$F:$F, "Manual"), 0)`,
      `=IFERROR(SUMIFS('Manual Tracker'!$E:$E, 'Manual Tracker'!$J:$J, $K${row}, 'Manual Tracker'!$F:$F, "Gift"), 0) + IFERROR(SUMIFS('Manual Tracker'!$E:$E, 'Manual Tracker'!$J:$J, $K${row}, 'Manual Tracker'!$F:$F, "Gift/Model"), 0)`,
      `=E${row} + U${row} - O${row} - P${row} - Q${row}`,
      "",
      "",
      `=IFERROR(SUMIFS(Restocks!$F:$F, Restocks!$C:$C, $K${row}), 0)`,
    ];
  });

  console.log(`Would append ${values.length} rows at Variant Master!A${startRow}`);
  console.log("First:", values[0].slice(0, 11).join(" | "));
  console.log("Last:", values[values.length - 1].slice(0, 11).join(" | "));

  if (!apply) {
    console.log("Dry-run only. Re-run with --apply to write.");
    return;
  }

  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'Variant Master'!A${startRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  console.log(
    `Wrote ${res.data.updatedRows} rows / ${res.data.updatedCells} cells at ${res.data.updatedRange}`
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
