#!/usr/bin/env node
/**
 * Sync Meta Ads spend into Recurring Expenses + Ledger (monthly upsert).
 *
 * Usage:
 *   npm run meta:expenses:sync              # dry-run current month MTD
 *   npm run meta:expenses:sync:apply        # write sheets
 *   npm run meta:expenses:sync -- --months=3
 *   npm run meta:expenses:sync:apply -- --month=2026-08
 */
require("dotenv").config();
const {
  getSheetsClient,
  requireSpreadsheetId,
} = require("../sheets/client");
const {
  RECURRING_SHEET,
  LEDGER_SHEET,
  todayInTimezone,
  monthsToSync,
  monthBounds,
  fetchAccountSpend,
  planMetaExpenseUpserts,
  hasMetaCredentials,
  parseYmd,
} = require("../books/meta-expenses");
const { graphGet, getAdAccountId } = require("../meta/client");
const { hintForMetaError } = require("../meta/cli");
const { round2 } = require("../books/tax");

function parseCli(argv) {
  const out = {
    apply: argv.includes("--apply"),
    months: 1,
    month: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") continue;
    if (arg.startsWith("--months=")) {
      out.months = Math.max(1, Number(arg.slice("--months=".length)) || 1);
      continue;
    }
    if (arg === "--months") {
      out.months = Math.max(1, Number(argv[++i]) || 1);
      continue;
    }
    if (arg.startsWith("--month=")) {
      out.month = arg.slice("--month=".length);
      continue;
    }
    if (arg === "--month") {
      out.month = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (out.month && !/^\d{4}-\d{2}$/.test(out.month)) {
    throw new Error(`Invalid --month=${out.month} (expected YYYY-MM)`);
  }
  return out;
}

async function batchWrite(sheets, spreadsheetId, updates) {
  if (!updates.length) return;
  const CHUNK = 200;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: chunk,
      },
    });
  }
}

async function loadSheet(sheets, spreadsheetId, title, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'!${range}`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const values = res.data.values || [];
  return {
    header: (values[0] || []).map(String),
    rows: values.slice(1),
  };
}

async function runMetaExpensesSync({
  sheets,
  spreadsheetId,
  apply = false,
  months = 1,
  month = null,
  timezoneName = null,
} = {}) {
  if (!hasMetaCredentials()) {
    return {
      skipped: true,
      reason: "missing_meta_credentials",
      summary: [],
    };
  }

  let tz = timezoneName;
  if (!tz) {
    try {
      const act = await graphGet(getAdAccountId(), {
        fields: "timezone_name,currency,name",
      });
      tz = act.data?.timezone_name || null;
    } catch {
      tz = null;
    }
  }

  const today = todayInTimezone(tz);
  parseYmd(today);
  const monthList = month
    ? [monthBounds(month, today)]
    : monthsToSync(today, months);

  const spendByMonth = {};
  for (const m of monthList) {
    spendByMonth[m.month] = await fetchAccountSpend(m.since, m.until);
  }

  const [recurring, ledger] = await Promise.all([
    loadSheet(sheets, spreadsheetId, RECURRING_SHEET, "A1:F"),
    loadSheet(sheets, spreadsheetId, LEDGER_SHEET, "A1:N"),
  ]);

  if (colMissing(recurring.header, "Amount") || colMissing(recurring.header, "Category")) {
    throw new Error(
      `${RECURRING_SHEET} missing required headers (need Date, Expense Name, Category, Amount, Notes)`
    );
  }
  if (colMissing(ledger.header, "Ref Key") || colMissing(ledger.header, "Debit")) {
    throw new Error(`${LEDGER_SHEET} missing Ref Key or Debit column`);
  }

  const plan = planMetaExpenseUpserts({
    months: monthList,
    spendByMonth,
    recurringHeader: recurring.header,
    recurringRows: recurring.rows,
    ledgerHeader: ledger.header,
    ledgerRows: ledger.rows,
  });

  if (!apply) {
    return { skipped: false, apply: false, timezone: tz, today, plan, spendByMonth };
  }

  await batchWrite(sheets, spreadsheetId, [
    ...plan.recurringUpdates,
    ...plan.ledgerUpdates,
  ]);

  if (plan.recurringAppends.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${RECURRING_SHEET}'!A:F`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: plan.recurringAppends },
    });
  }
  if (plan.ledgerAppends.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${LEDGER_SHEET}'!A:N`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: plan.ledgerAppends },
    });
  }

  return { skipped: false, apply: true, timezone: tz, today, plan, spendByMonth };
}

function colMissing(header, name) {
  return !header.some(
    (h) => String(h || "").trim().toLowerCase() === name.toLowerCase()
  );
}

function printPlan(result) {
  if (result.skipped) {
    console.log(`Meta expenses skipped: ${result.reason}`);
    return;
  }
  console.log(
    `Meta expenses ${result.apply ? "APPLY" : "DRY-RUN"} | today ${result.today}${result.timezone ? ` (${result.timezone})` : ""}`
  );
  for (const action of result.plan.summary) {
    const spend = result.spendByMonth[action.month];
    console.log(
      `  ${action.month}  ${action.since}→${action.until}  spend=${round2(action.spend)}${spend?.currency ? ` ${spend.currency}` : ""}  recurring=${action.recurring}${action.previousRecurring != null ? ` (was ${action.previousRecurring})` : ""}  ledger=${action.ledger}${action.previousLedger != null ? ` (was ${action.previousLedger})` : ""}`
    );
  }
  console.log(
    `  Writes: recurring updates ${result.plan.recurringUpdates.length}, appends ${result.plan.recurringAppends.length}; ledger updates ${result.plan.ledgerUpdates.length}, appends ${result.plan.ledgerAppends.length}`
  );
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  if (!hasMetaCredentials()) {
    throw new Error(
      "Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID in .env — see docs/META_SETUP.md"
    );
  }

  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();
  const result = await runMetaExpensesSync({
    sheets,
    spreadsheetId,
    apply: args.apply,
    months: args.months,
    month: args.month,
  });
  printPlan(result);
  if (!args.apply) {
    console.log("Dry-run only. Re-run with --apply (or npm run meta:expenses:sync:apply).");
  } else {
    console.log(
      "Updated Recurring Expenses + Ledger Ads. Re-run books:sync / books:reports:apply to refresh Month Detail."
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    if (err.meta) console.error(hintForMetaError(err) || "");
    process.exit(1);
  });
}

module.exports = {
  runMetaExpensesSync,
  printPlan,
  parseCli,
};
