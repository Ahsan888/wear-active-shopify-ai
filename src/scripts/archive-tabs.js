require("dotenv").config();
const {
  getSheetsClient,
  requireSpreadsheetId,
} = require("../sheets/client");

const KEEP_VISIBLE = new Set([
  "Dashboard",
  "Monthly P&L",
  "Analytics",
  "Ledger",
  "Shopify Orders (LIVE)",
  "Variant Master",
  "Restocks",
  "Recurring Expenses",
  "Factory Payments",
  "Other Sales",
  "Partner Balances",
  "Partner Adjustments",
  "Config",
]);

const KEEP_HIDDEN = new Set([
  "Partners",
  "Ownership Rules",
  "Settings",
  "ColorMap",
]);

const ARCHIVE_NAMES = new Set([
  "Shopify Orders",
  "SAVED ORDERS SHOPIFY",
  "Shopify Import Latest",
  "Shopify Backfill Preview",
  "Shopify Orders (ARCHIVE)",
  "Shopify Import",
  "Webhook Log",
  "Revenue (Legacy)",
  "Executive Summary (Legacy)",
  "Revenue Summary (Legacy)",
  "Order History",
  "3 months forecast",
  "Revenue (Ledger)",
  "Executive Summary (Ledger)",
  "Executive Summary (Monthly)",
  "Revenue Analytics (Monthly)",
  "Revenue & Expenses (Ledger)",
  "Monthly Analysis (Ledger)",
  "Ledger Monthly Summary",
  "Manual Pricing",
  "Online Pricing",
  "Manual Tracker",
  "Quick Manual Sale",
  "Shirt Costing",
  "Trouser Costing",
  "Hoodie Costing (OLD)",
  "Zipper Costing",
  "Stock Costing",
  "Fixed Cost Allocation Monthly",
  "_Master_Archive",
  "Expenses",
]);

function archiveTitle(title) {
  if (title.startsWith("_ARCHIVE_")) return title;
  return `_ARCHIVE_${title}`;
}

async function main() {
  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });

  const results = [];

  for (const sh of meta.data.sheets || []) {
    const p = sh.properties;
    const title = p.title;
    const id = p.sheetId;

    try {
      if (KEEP_VISIBLE.has(title)) {
        if (p.hidden) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [
                {
                  updateSheetProperties: {
                    properties: { sheetId: id, hidden: false },
                    fields: "hidden",
                  },
                },
              ],
            },
          });
          results.push({ title, ok: "unhide" });
        }
        continue;
      }

      if (KEEP_HIDDEN.has(title)) {
        if (!p.hidden) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [
                {
                  updateSheetProperties: {
                    properties: { sheetId: id, hidden: true },
                    fields: "hidden",
                  },
                },
              ],
            },
          });
          results.push({ title, ok: "hide" });
        }
        continue;
      }

      const shouldArchive =
        ARCHIVE_NAMES.has(title) || title.startsWith("_ARCHIVE_");
      if (!shouldArchive && p.hidden) continue;

      const newTitle = shouldArchive ? archiveTitle(title) : title;

      if (shouldArchive && newTitle !== title) {
        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [
                {
                  updateSheetProperties: {
                    properties: {
                      sheetId: id,
                      title: newTitle,
                      hidden: true,
                    },
                    fields: "title,hidden",
                  },
                },
              ],
            },
          });
          results.push({ title, ok: `renamed ${newTitle}` });
          continue;
        } catch (e) {
          // fall through to hide-only
          results.push({
            title,
            warn: `rename failed: ${e.message?.slice(0, 80)}`,
          });
        }
      }

      if (!p.hidden || shouldArchive) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId: id, hidden: true },
                  fields: "hidden",
                },
              },
            ],
          },
        });
        results.push({ title, ok: "hidden" });
      }
    } catch (e) {
      results.push({ title, error: e.message?.slice(0, 120) });
    }
  }

  console.log(JSON.stringify(results, null, 2));

  const meta2 = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });
  console.log(
    "VISIBLE:",
    meta2.data.sheets
      .filter((s) => !s.properties.hidden)
      .map((s) => s.properties.title)
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
