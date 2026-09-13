/**
 * Monthly Meta Ads spend → Recurring Expenses + Ledger (idempotent upsert).
 *
 * One row per calendar month. Re-running mid-month updates the same row
 * (Ref Key EXP:META:YYYY-MM / Notes ref:META:YYYY-MM) — does not stack.
 */
const { graphGet, getAdAccountId } = require("../meta/client");
const { parseMoney, round2 } = require("./tax");

const RECURRING_SHEET = "Recurring Expenses";
const LEDGER_SHEET = "Ledger";
const META_REF_PREFIX = "EXP:META:";
const META_NOTE_PREFIX = "ref:META:";

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseYmd(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid date "${value}" (expected YYYY-MM-DD)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new Error(`Invalid calendar date "${value}"`);
  }
  return { y, mo, d };
}

function todayInTimezone(timezoneName) {
  if (!timezoneName) return ymd(new Date());
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezoneName,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(new Date());
  } catch {
    return ymd(new Date());
  }
}

function monthKeyFromYmd(value) {
  return String(value || "").slice(0, 7);
}

function monthBounds(monthKey, todayYmd) {
  const m = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`Invalid month "${monthKey}" (expected YYYY-MM)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const since = `${m[1]}-${m[2]}-01`;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const monthEnd = `${m[1]}-${m[2]}-${String(lastDay).padStart(2, "0")}`;
  const until = todayYmd < monthEnd ? todayYmd : monthEnd;
  if (until < since) {
    throw new Error(`Month ${monthKey} is in the future (today ${todayYmd})`);
  }
  return { month: monthKey, since, until, monthEnd };
}

/** Last N calendar months ending at the month of todayYmd (inclusive). */
function monthsToSync(todayYmd, count = 1) {
  parseYmd(todayYmd);
  const n = Math.max(1, Number(count) || 1);
  const [y0, m0] = todayYmd.split("-").map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const dt = new Date(Date.UTC(y0, m0 - 1 - i, 1));
    const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    out.push(monthBounds(key, todayYmd));
  }
  return out;
}

function metaLedgerRef(monthKey) {
  return `${META_REF_PREFIX}${monthKey}`;
}

function metaRecurringNote(monthKey, until) {
  return `${META_NOTE_PREFIX}${monthKey} | synced through ${until} | Meta Insights account spend`;
}

function metaExpenseName(monthKey) {
  return `Meta Ads ${monthKey}`;
}

function colIndex(header, name) {
  return header.findIndex(
    (h) => String(h || "").trim().toLowerCase() === name.toLowerCase()
  );
}

function findRecurringMetaRow(rows, header, monthKey) {
  const iNotes = colIndex(header, "Notes");
  const iName = colIndex(header, "Expense Name");
  const iCat = colIndex(header, "Category");
  const needle = `${META_NOTE_PREFIX}${monthKey}`;
  const name = metaExpenseName(monthKey);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const notes = String(row[iNotes] || "");
    const expenseName = String(row[iName] || "").trim();
    const category = String(row[iCat] || "").trim();
    if (notes.includes(needle)) return { index: i, row };
    if (
      expenseName === name &&
      /^ads$/i.test(category)
    ) {
      return { index: i, row };
    }
  }
  return null;
}

function findLedgerMetaRow(rows, header, monthKey) {
  const iRef = colIndex(header, "Ref Key");
  const ref = metaLedgerRef(monthKey);
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i][iRef] || "").trim() === ref) {
      return { index: i, row: rows[i] };
    }
  }
  return null;
}

/**
 * Fetch account-level spend for a date range (inclusive).
 */
async function fetchAccountSpend(since, until) {
  parseYmd(since);
  parseYmd(until);
  const actId = getAdAccountId();
  const res = await graphGet(`${actId}/insights`, {
    fields: "spend,account_currency,date_start,date_stop",
    level: "account",
    time_range: JSON.stringify({ since, until }),
  });
  const rows = Array.isArray(res.data?.data) ? res.data.data : [];
  if (!rows.length) {
    return { spend: 0, currency: null, date_start: since, date_stop: until };
  }
  const spend = rows.reduce(
    (sum, row) => sum + (Number.parseFloat(row.spend) || 0),
    0
  );
  return {
    spend: round2(spend),
    currency: rows[0].account_currency || null,
    date_start: rows[0].date_start || since,
    date_stop: rows[0].date_stop || until,
  };
}

function buildRecurringRow(month, spend, header) {
  const width = Math.max(header.length, 6);
  const row = Array(width).fill("");
  const set = (name, value) => {
    const i = colIndex(header, name);
    if (i >= 0) row[i] = value;
  };
  set("Date", month.since);
  set("Expense Name", metaExpenseName(month.month));
  set("Category", "Ads");
  set("Amount", round2(spend));
  set("Paid By", "Meta");
  set("Notes", metaRecurringNote(month.month, month.until));
  return row;
}

function buildLedgerExpenseRow(month, spend, nowIso) {
  return [
    month.since,
    "Expense",
    "Meta",
    "Ads",
    metaExpenseName(month.month),
    "",
    "",
    round2(spend),
    0,
    "Shared",
    "",
    metaLedgerRef(month.month),
    metaRecurringNote(month.month, month.until),
    nowIso,
  ];
}

/**
 * Plan upserts from already-loaded sheet values + spend by month.
 */
function planMetaExpenseUpserts({
  months,
  spendByMonth,
  recurringHeader,
  recurringRows,
  ledgerHeader,
  ledgerRows,
  nowIso = new Date().toISOString(),
}) {
  const iRecAmt = colIndex(recurringHeader, "Amount");
  const iRecNotes = colIndex(recurringHeader, "Notes");
  const iRecName = colIndex(recurringHeader, "Expense Name");
  const iRecCat = colIndex(recurringHeader, "Category");
  const iRecDate = colIndex(recurringHeader, "Date");
  const iRecPaid = colIndex(recurringHeader, "Paid By");
  const iLedDebit = colIndex(ledgerHeader, "Debit");
  const iLedNotes = colIndex(ledgerHeader, "Notes");
  const iLedDesc = colIndex(ledgerHeader, "Description");
  const iLedDate = colIndex(ledgerHeader, "Date");
  const iLedCat = colIndex(ledgerHeader, "Category");
  const iLedType = colIndex(ledgerHeader, "Entry Type");
  const iLedSource = colIndex(ledgerHeader, "Source");

  const recurringUpdates = [];
  const recurringAppends = [];
  const ledgerUpdates = [];
  const ledgerAppends = [];
  const summary = [];

  for (const month of months) {
    const spend = round2(Number(spendByMonth[month.month]?.spend) || 0);
    const existingRec = findRecurringMetaRow(
      recurringRows,
      recurringHeader,
      month.month
    );
    const existingLed = findLedgerMetaRow(
      ledgerRows,
      ledgerHeader,
      month.month
    );

    const action = {
      month: month.month,
      since: month.since,
      until: month.until,
      spend,
      recurring: "append",
      ledger: "append",
      previousRecurring: null,
      previousLedger: null,
    };

    if (existingRec) {
      const prev = parseMoney(existingRec.row[iRecAmt]);
      action.previousRecurring = prev;
      action.recurring = round2(prev) === spend ? "unchanged" : "update";
      if (action.recurring === "update") {
        const sheetRow = existingRec.index + 2; // 1-header
        const writes = [];
        if (iRecDate >= 0) {
          writes.push({
            range: `'${RECURRING_SHEET}'!${colLetter(iRecDate + 1)}${sheetRow}`,
            values: [[month.since]],
          });
        }
        if (iRecName >= 0) {
          writes.push({
            range: `'${RECURRING_SHEET}'!${colLetter(iRecName + 1)}${sheetRow}`,
            values: [[metaExpenseName(month.month)]],
          });
        }
        if (iRecCat >= 0) {
          writes.push({
            range: `'${RECURRING_SHEET}'!${colLetter(iRecCat + 1)}${sheetRow}`,
            values: [["Ads"]],
          });
        }
        if (iRecAmt >= 0) {
          writes.push({
            range: `'${RECURRING_SHEET}'!${colLetter(iRecAmt + 1)}${sheetRow}`,
            values: [[spend]],
          });
        }
        if (iRecPaid >= 0) {
          writes.push({
            range: `'${RECURRING_SHEET}'!${colLetter(iRecPaid + 1)}${sheetRow}`,
            values: [["Meta"]],
          });
        }
        if (iRecNotes >= 0) {
          writes.push({
            range: `'${RECURRING_SHEET}'!${colLetter(iRecNotes + 1)}${sheetRow}`,
            values: [[metaRecurringNote(month.month, month.until)]],
          });
        }
        recurringUpdates.push(...writes);
      }
    } else {
      recurringAppends.push(buildRecurringRow(month, spend, recurringHeader));
    }

    if (existingLed) {
      const prev = parseMoney(existingLed.row[iLedDebit]);
      action.previousLedger = prev;
      action.ledger = round2(prev) === spend ? "unchanged" : "update";
      if (action.ledger === "update") {
        const sheetRow = existingLed.index + 2;
        if (iLedDebit >= 0) {
          ledgerUpdates.push({
            range: `'${LEDGER_SHEET}'!${colLetter(iLedDebit + 1)}${sheetRow}`,
            values: [[spend]],
          });
        }
        if (iLedNotes >= 0) {
          ledgerUpdates.push({
            range: `'${LEDGER_SHEET}'!${colLetter(iLedNotes + 1)}${sheetRow}`,
            values: [[metaRecurringNote(month.month, month.until)]],
          });
        }
        if (iLedDesc >= 0) {
          ledgerUpdates.push({
            range: `'${LEDGER_SHEET}'!${colLetter(iLedDesc + 1)}${sheetRow}`,
            values: [[metaExpenseName(month.month)]],
          });
        }
        if (iLedDate >= 0) {
          ledgerUpdates.push({
            range: `'${LEDGER_SHEET}'!${colLetter(iLedDate + 1)}${sheetRow}`,
            values: [[month.since]],
          });
        }
        if (iLedCat >= 0) {
          ledgerUpdates.push({
            range: `'${LEDGER_SHEET}'!${colLetter(iLedCat + 1)}${sheetRow}`,
            values: [["Ads"]],
          });
        }
        if (iLedType >= 0) {
          ledgerUpdates.push({
            range: `'${LEDGER_SHEET}'!${colLetter(iLedType + 1)}${sheetRow}`,
            values: [["Expense"]],
          });
        }
        if (iLedSource >= 0) {
          ledgerUpdates.push({
            range: `'${LEDGER_SHEET}'!${colLetter(iLedSource + 1)}${sheetRow}`,
            values: [["Meta"]],
          });
        }
        // Keep preview in sync
        existingLed.row[iLedDebit] = spend;
        if (iLedNotes >= 0) {
          existingLed.row[iLedNotes] = metaRecurringNote(
            month.month,
            month.until
          );
        }
      }
    } else {
      ledgerAppends.push(buildLedgerExpenseRow(month, spend, nowIso));
    }

    summary.push(action);
  }

  return {
    recurringUpdates,
    recurringAppends,
    ledgerUpdates,
    ledgerAppends,
    summary,
  };
}

function applyPlanToPreviewLedger(previewRows, ledgerHeader, plan) {
  const iRef = colIndex(ledgerHeader, "Ref Key");
  const iDebit = colIndex(ledgerHeader, "Debit");
  const iNotes = colIndex(ledgerHeader, "Notes");
  const byRef = new Map();
  for (const row of previewRows) {
    const ref = String(row[iRef] || "").trim();
    if (ref) byRef.set(ref, row);
  }
  for (const action of plan.summary) {
    const ref = metaLedgerRef(action.month);
    const existing = byRef.get(ref);
    if (existing) {
      if (iDebit >= 0) existing[iDebit] = action.spend;
      if (iNotes >= 0) {
        existing[iNotes] = metaRecurringNote(action.month, action.until);
      }
    } else {
      const built = buildLedgerExpenseRow(
        {
          month: action.month,
          since: action.since,
          until: action.until,
        },
        action.spend,
        new Date().toISOString()
      );
      previewRows.push(built);
      byRef.set(ref, built);
    }
  }
  return previewRows;
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

function hasMetaCredentials() {
  return Boolean(
    String(process.env.META_ACCESS_TOKEN || "").trim() &&
      String(process.env.META_AD_ACCOUNT_ID || "").trim()
  );
}

module.exports = {
  RECURRING_SHEET,
  LEDGER_SHEET,
  META_REF_PREFIX,
  META_NOTE_PREFIX,
  todayInTimezone,
  monthsToSync,
  monthBounds,
  monthKeyFromYmd,
  metaLedgerRef,
  metaExpenseName,
  metaRecurringNote,
  fetchAccountSpend,
  planMetaExpenseUpserts,
  applyPlanToPreviewLedger,
  findRecurringMetaRow,
  findLedgerMetaRow,
  buildRecurringRow,
  buildLedgerExpenseRow,
  hasMetaCredentials,
  ymd,
  parseYmd,
};
