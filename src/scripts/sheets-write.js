const {
  DEFAULT_GID,
  getSpreadsheet,
  sheetByGid,
  a1SheetName,
  updateValues,
  appendValues,
} = require("../sheets/client");

function parseArgs(argv) {
  const args = {
    tab: null,
    gid: DEFAULT_GID,
    range: "A1",
    values: null,
    append: false,
    apply: false,
    dryRun: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tab") args.tab = String(argv[++i]);
    else if (arg === "--gid") args.gid = String(argv[++i]);
    else if (arg === "--range") args.range = String(argv[++i]);
    else if (arg === "--values") args.values = String(argv[++i]);
    else if (arg === "--append") args.append = true;
    else if (arg === "--apply") {
      args.apply = true;
      args.dryRun = false;
    } else if (arg === "--dry-run") args.dryRun = true;
  }

  return args;
}

function parseValues(raw) {
  if (!raw) {
    throw new Error(
      'Missing --values. Pass JSON rows, e.g. --values \'[["SKU","Black","M"]]\''
    );
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((row) => !Array.isArray(row))) {
    throw new Error("--values must be a JSON array of rows (array of arrays).");
  }
  return parsed;
}

function qualifyRange(tabTitle, range) {
  if (range.includes("!")) return range;
  return `${a1SheetName(tabTitle)}!${range}`;
}

function printGrid(label, rows) {
  console.log(label);
  if (!rows || rows.length === 0) {
    console.log("  (empty)");
    return;
  }
  for (const row of rows) {
    console.log(`  ${row.join(" | ")}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const values = parseValues(args.values);
  const spreadsheet = await getSpreadsheet();
  const tabs = spreadsheet.sheets || [];
  const sheet = args.tab
    ? tabs.find((item) => item.properties?.title === args.tab)
    : sheetByGid(spreadsheet, args.gid) || tabs[0];

  if (!sheet) {
    throw new Error(
      args.tab
        ? `Tab not found: ${args.tab}`
        : `No tab for gid=${args.gid}`
    );
  }

  const title = sheet.properties.title;
  const range = qualifyRange(title, args.range);
  const apply = args.apply && !args.dryRun;

  console.log(`Spreadsheet: ${spreadsheet.properties?.title}`);
  console.log(`Tab: ${title} (gid=${sheet.properties.sheetId})`);
  console.log(`Range: ${range}`);
  console.log(`Mode: ${args.append ? "append" : "update"}`);
  console.log(apply ? "APPLY: writing to the sheet" : "DRY-RUN: no write");
  console.log("");

  const result = args.append
    ? await appendValues(range, values, { apply })
    : await updateValues(range, values, { apply });

  if (!args.append) {
    printGrid("Current:", result.current);
  }
  printGrid("Proposed:", result.proposed);

  if (apply) {
    const updatedRange = result.updated?.updatedRange || result.updated?.updates?.updatedRange;
    console.log("");
    console.log(`Wrote ${result.updated?.updatedCells || result.updated?.updates?.updatedCells || "?"} cells at ${updatedRange || range}`);
  } else {
    console.log("");
    console.log("Re-run with --apply after confirmation to write.");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
