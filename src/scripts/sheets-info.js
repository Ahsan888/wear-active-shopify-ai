const {
  SPREADSHEET_ID,
  DEFAULT_GID,
  loadServiceAccountMeta,
  getSpreadsheet,
  sheetByGid,
  a1SheetName,
  getValues,
  shareHint,
} = require("../sheets/client");

function previewRows(rows, limit = 8) {
  return rows.slice(0, limit).map((row) =>
    row.map((cell) => {
      const text = String(cell ?? "");
      return text.length > 48 ? `${text.slice(0, 45)}...` : text;
    })
  );
}

async function main() {
  const meta = loadServiceAccountMeta();
  if (!SPREADSHEET_ID) {
    console.log("GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env");
    process.exitCode = 1;
    return;
  }

  console.log(`Service account: ${meta.clientEmail}`);
  console.log(`Project: ${meta.projectId}`);
  console.log(`Spreadsheet ID: ${SPREADSHEET_ID}`);
  console.log("");

  let spreadsheet;
  try {
    spreadsheet = await getSpreadsheet();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
    return;
  }

  console.log(`Title: ${spreadsheet.properties?.title || "(untitled)"}`);
  const tabs = spreadsheet.sheets || [];
  console.log(`Tabs: ${tabs.length}`);
  console.log("");

  let active = sheetByGid(spreadsheet, DEFAULT_GID) || tabs[0];
  for (const sheet of tabs) {
    const props = sheet.properties || {};
    const grid = props.gridProperties || {};
    const gid = props.sheetId;
    const rows = grid.rowCount ?? "?";
    const cols = grid.columnCount ?? "?";
    const marker = String(gid) === String(DEFAULT_GID) ? " ← default gid" : "";
    console.log(
      `  - ${props.title} (gid=${gid}, ${rows} rows × ${cols} cols)${marker}`
    );
  }
  console.log("");

  if (!active) {
    console.log("No tabs found.");
    return;
  }

  const title = active.properties.title;
  const headerRange = `${a1SheetName(title)}!1:1`;
  const previewRange = `${a1SheetName(title)}!A1:Z12`;
  const colA = await getValues(`${a1SheetName(title)}!A:A`);
  const headerRow = await getValues(headerRange);
  const values = await getValues(previewRange);
  const headers = headerRow[0] || values[0] || [];
  const gridRows = active.properties?.gridProperties?.rowCount;
  const usedRows = colA.filter((row) =>
    row.some((cell) => String(cell ?? "").trim() !== "")
  ).length;

  console.log(`Preview tab: ${title} (gid=${active.properties.sheetId})`);
  console.log(`Headers (${headers.length}): ${headers.join(" | ") || "(none)"}`);
  console.log(`Non-empty rows in column A: ${usedRows} (grid rowCount=${gridRows})`);
  console.log("");

  const preview = previewRows(values, 8);
  for (const row of preview) {
    console.log(`  ${row.join(" | ")}`);
  }
  if (values.length > 8) {
    console.log("  …");
  }

  if (!meta.clientEmail) {
    console.log("");
    console.log(shareHint(null));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
