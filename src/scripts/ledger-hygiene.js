require("dotenv").config();
const {
  getSheetsClient,
  requireSpreadsheetId,
} = require("../sheets/client");

const EXPENSE_CAT_MAP = {
  "57": "Other",
  Misc: "Other",
  Miscellaneous: "Other",
  Shipping: "Delivery",
  Courier: "Delivery",
  Orio: "Delivery",
  Marketing: "Ads",
  Facebook: "Ads",
  Meta: "Ads",
  Shopify: "Platform",
  Fee: "Platform",
};

const ALLOWED_EXPENSE = new Set([
  "Ads",
  "Delivery",
  "Platform",
  "Ops",
  "Rent",
  "Salaries",
  "Packaging",
  "Other",
]);

/**
 * Fix YYYY-DD-MM mistaken as YYYY-MM-DD when month>12.
 * Also D/M/YYYY and D/M/YY.
 */
function fixDateString(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, fixed: s, reason: "empty" };

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    let y = +iso[1];
    let mo = +iso[2];
    let da = +iso[3];
    if (mo > 12 && da <= 12) {
      // swapped: was written as YYYY-DD-MM
      const t = mo;
      mo = da;
      da = t;
    }
    const dt = new Date(y, mo - 1, da);
    if (
      dt.getFullYear() !== y ||
      dt.getMonth() !== mo - 1 ||
      dt.getDate() !== da
    ) {
      return { ok: false, fixed: s, reason: "invalid-calendar" };
    }
    const out = `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
    return { ok: true, fixed: out, changed: out !== s };
  }

  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    let da = +slash[1];
    let mo = +slash[2];
    let y = +slash[3];
    if (y < 100) y += 2000;
    // Prefer D/M/Y (PK convention) when day>12 or both <=12
    if (da > 12 && mo <= 12) {
      // already D/M
    } else if (mo > 12 && da <= 12) {
      const t = da;
      da = mo;
      mo = t;
    }
    const dt = new Date(y, mo - 1, da);
    if (
      dt.getFullYear() !== y ||
      dt.getMonth() !== mo - 1 ||
      dt.getDate() !== da
    ) {
      return { ok: false, fixed: s, reason: "invalid-slash" };
    }
    const out = `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
    return { ok: true, fixed: out, changed: true };
  }

  const d = new Date(s);
  if (!isNaN(d)) {
    const y = d.getFullYear();
    const mo = d.getMonth() + 1;
    const da = d.getDate();
    const out = `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
    return { ok: true, fixed: out, changed: out !== s };
  }

  return { ok: false, fixed: s, reason: "unparsed" };
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);

  const sheets = await getSheetsClient();
  const spreadsheetId = requireSpreadsheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Ledger'!A1:N",
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rows = res.data.values || [];
  const dateFixes = [];
  const catFixes = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const row = i + 1;
    const rawDate = r[0];
    const entryType = String(r[1] || "");
    const cat = String(r[3] || "").trim();

    const df = fixDateString(rawDate);
    if (df.ok && df.changed) {
      dateFixes.push({ row, from: String(rawDate), to: df.fixed });
    } else if (!df.ok && String(rawDate || "").trim()) {
      dateFixes.push({
        row,
        from: String(rawDate),
        to: null,
        reason: df.reason,
      });
    }

    if (entryType === "Expense") {
      let next = EXPENSE_CAT_MAP[cat] || cat;
      if (!ALLOWED_EXPENSE.has(next)) next = "Other";
      if (next !== cat) {
        catFixes.push({ row, from: cat, to: next });
      }
    } else if (cat === "57") {
      catFixes.push({ row, from: cat, to: "Other" });
    }
  }

  const unfixed = dateFixes.filter((d) => !d.to);
  const fixed = dateFixes.filter((d) => d.to);
  console.log(`Date fixes: ${fixed.length} (unfixed ${unfixed.length})`);
  console.log(fixed.slice(0, 8));
  if (unfixed.length) console.log("Unfixed:", unfixed);
  console.log(`Category fixes: ${catFixes.length}`, catFixes);

  if (!apply) {
    console.log("Re-run with --apply to write.");
    return;
  }

  const data = [];
  for (const f of fixed) {
    data.push({ range: `'Ledger'!A${f.row}`, values: [[f.to]] });
  }
  for (const f of catFixes) {
    data.push({ range: `'Ledger'!D${f.row}`, values: [[f.to]] });
  }

  for (let i = 0; i < data.length; i += 100) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: data.slice(i, i + 100),
      },
    });
  }
  console.log(`Wrote ${data.length} cells.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
