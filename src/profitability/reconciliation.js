/**
 * Ads reconciliation + duplicate detection (read-only diagnostics).
 */
const { round2 } = require("../books/tax");
const { safeDiv } = require("../meta/metrics");
const { isAdsCategory } = require("./books");

function isFullCalendarMonth(since, until) {
  const m = String(since || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const u = String(until || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !u) return false;
  if (m[1] !== u[1] || m[2] !== u[2]) return false;
  if (m[3] !== "01") return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return Number(u[3]) === last;
}

function expenseSignature(row) {
  return [
    row.date || "",
    "expense",
    String(row.category || "").trim().toLowerCase(),
    String(row.description || "").trim().toLowerCase(),
    Number(row.debit || 0).toFixed(2),
    String(row.source || "").trim().toLowerCase(),
  ].join("|");
}

/**
 * Detect likely duplicate Ledger expense rows. Does NOT alter booked totals.
 */
function findDuplicateExpenseCandidates(expenseRows) {
  const groups = new Map();
  for (const row of expenseRows) {
    const key = expenseSignature(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const duplicates = [];
  for (const [signature, rows] of groups) {
    if (rows.length < 2) continue;
    duplicates.push({
      signature,
      count: rows.length,
      date: rows[0].date,
      category: rows[0].category,
      amount: round2(rows[0].debit),
      source: rows[0].source || null,
    });
  }
  return duplicates;
}

/**
 * Conservative Recurring↔Ledger Ads matching: same date + category + amount.
 */
function matchRecurringToLedger(recurringAdsRows, ledgerAdsRows) {
  const ledgerPool = ledgerAdsRows.map((r) => ({
    ...r,
    _used: false,
    key: `${r.date}|${Number(r.debit || 0).toFixed(2)}`,
  }));

  let matched = 0;
  const unmatchedRecurring = [];
  for (const rec of recurringAdsRows) {
    const amount = Number(rec.amount || 0).toFixed(2);
    const key = `${rec.date}|${amount}`;
    const hit = ledgerPool.find((l) => !l._used && l.key === key);
    if (hit) {
      hit._used = true;
      matched += 1;
    } else {
      unmatchedRecurring.push({
        date: rec.date,
        amount: rec.amount,
        category: rec.category,
      });
    }
  }

  const unmatchedLedger = ledgerPool
    .filter((l) => !l._used)
    .map((l) => ({
      date: l.date,
      amount: round2(l.debit),
      category: l.category,
    }));

  return {
    recurring_ads_rows: recurringAdsRows.length,
    ledger_ads_rows: ledgerAdsRows.length,
    likely_matched_recurring_ads_rows: matched,
    unmatched_recurring_ads_rows: unmatchedRecurring,
    unmatched_ledger_ads_rows: unmatchedLedger,
  };
}

function buildWarning(code, severity, message, details = {}) {
  return { code, severity, message, details };
}

/**
 * Build ad reconciliation block + warnings.
 * Official ledger_ads_expense is never reduced for duplicates.
 */
function reconcileAds({
  since,
  until,
  meta_spend,
  ledger_ads_expense,
  recurring_ads_expense,
  ledgerAdsRows,
  recurringAdsRows,
  expenseRows,
}) {
  const fullMonth = isFullCalendarMonth(since, until);
  const meta = Number(meta_spend || 0);
  const ledger = Number(ledger_ads_expense || 0);
  const recurring = Number(recurring_ads_expense || 0);

  const meta_vs_ledger_variance = round2(meta - ledger);
  const meta_vs_ledger_variance_pct =
    ledger !== 0 ? round2((meta_vs_ledger_variance / ledger) * 100) : null;
  const ledger_vs_recurring_variance = round2(ledger - recurring);

  const duplicates = findDuplicateExpenseCandidates(
    (expenseRows || []).filter((r) => isAdsCategory(r.category))
  );
  const matching = matchRecurringToLedger(
    recurringAdsRows || [],
    ledgerAdsRows || []
  );

  const warnings = [];
  let status = "full_month_variance";

  if (meta <= 0 && ledger <= 0 && recurring <= 0) {
    status = "no_meta_spend";
  } else if (meta <= 0 && ledger > 0) {
    status = "no_meta_spend";
    warnings.push(
      buildWarning(
        "no_meta_spend",
        "info",
        "No Meta spend in range while Ledger Ads expense exists",
        { ledger_ads_expense: ledger }
      )
    );
  } else if (!fullMonth) {
    status = "partial_period_not_comparable";
    warnings.push(
      buildWarning(
        "partial_period_not_comparable",
        "info",
        "Partial-period Meta query is not directly comparable to monthly Recurring Ads lumps",
        { since, until }
      )
    );
  } else if (ledger <= 0 && meta > 0) {
    status = "ledger_ads_missing";
    warnings.push(
      buildWarning(
        "ledger_ads_missing",
        "warning",
        "Meta spend exists but no Ledger Ads expense in this full month",
        { meta_spend: meta }
      )
    );
  } else if (recurring <= 0 && ledger > 0 && fullMonth) {
    status = "recurring_ads_missing";
    warnings.push(
      buildWarning(
        "recurring_ads_missing",
        "info",
        "Ledger Ads present but no Recurring Expenses Ads rows in this full month",
        { ledger_ads_expense: ledger }
      )
    );
  } else if (
    recurring > 0 &&
    matching.unmatched_recurring_ads_rows.length > 0 &&
    fullMonth
  ) {
    status = "recurring_ads_not_posted";
    warnings.push(
      buildWarning(
        "recurring_ads_not_posted",
        "warning",
        "Some Recurring Ads rows have no same-date/same-amount Ledger Ads match",
        {
          unmatched: matching.unmatched_recurring_ads_rows.length,
        }
      )
    );
  } else if (fullMonth && Math.abs(meta_vs_ledger_variance) < 0.5) {
    status = "matched_full_month";
  } else if (fullMonth) {
    status = "full_month_variance";
    warnings.push(
      buildWarning(
        "meta_vs_ledger_variance",
        "warning",
        "Meta spend differs from Ledger Ads for this full month",
        {
          meta_spend: meta,
          ledger_ads_expense: ledger,
          variance: meta_vs_ledger_variance,
        }
      )
    );
  }

  if (duplicates.length) {
    status =
      status === "matched_full_month"
        ? "possible_duplicate_ledger_ads"
        : status;
    for (const dup of duplicates) {
      warnings.push(
        buildWarning(
          "possible_duplicate_ledger_expense",
          "warning",
          `Possible duplicate Ledger ${dup.category} expense on ${dup.date} ×${dup.count} @ ${dup.amount}`,
          {
            date: dup.date,
            category: dup.category,
            amount: dup.amount,
            count: dup.count,
          }
        )
      );
    }
  }

  if (Math.abs(ledger_vs_recurring_variance) > 0.5 && (ledger > 0 || recurring > 0)) {
    warnings.push(
      buildWarning(
        "ledger_vs_recurring_ads_variance",
        "info",
        "Ledger Ads total differs from Recurring Expenses Ads total for the selected range",
        {
          ledger_ads_expense: ledger,
          recurring_ads_expense: recurring,
          variance: ledger_vs_recurring_variance,
        }
      )
    );
  }

  warnings.push(
    buildWarning(
      "no_meta_shopify_order_attribution",
      "info",
      "No Meta→Shopify order attribution applied (blended / date-aligned only)",
      {}
    )
  );

  return {
    ad_reconciliation: {
      meta_spend: round2(meta),
      ledger_ads_expense: round2(ledger),
      recurring_ads_expense: round2(recurring),
      meta_vs_ledger_variance,
      meta_vs_ledger_variance_pct,
      ledger_vs_recurring_variance,
      ad_spend_reconciliation_status: status,
      is_full_calendar_month: fullMonth,
      meta_spend_treatment:
        "analytical_replacement_only_not_additional_expense",
      matching,
      possible_duplicate_ledger_ads: duplicates,
    },
    warnings,
  };
}

module.exports = {
  isFullCalendarMonth,
  expenseSignature,
  findDuplicateExpenseCandidates,
  matchRecurringToLedger,
  reconcileAds,
  buildWarning,
};
