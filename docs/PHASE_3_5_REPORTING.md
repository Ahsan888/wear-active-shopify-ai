# Phase 3.5 — Sales provenance & decision dashboard

Read-only management interface on top of Phase 2 profitability + Phase 3 decisions.

## Purpose

1. Make reporting **sales-provenance aware** so Manual / Other Sales are visible and are not silently treated as marketing Shopify demand.
2. Separate **whole-business ad-spend affordability** from **Shopify channel contribution** so a strong business safety result is not misread as ecommerce/Meta acquisition efficiency.
3. Provide a **local HTML dashboard** that is easier to read than long terminal reports.

## Commands

```bash
npm run decisions:dashboard -- --days=7
npm run decisions:dashboard -- --days=14
npm run decisions:dashboard -- --days=30
npm run decisions:dashboard -- --since=2026-08-01 --until=2026-08-31
npm run decisions:dashboard -- --days=7 --open
npm run dashboard:test
```

Outputs:

* `reports/decisions/dashboard.html` (latest)
* `reports/decisions/decision-<since>-to-<until>.html`

Open the HTML file by double-clicking — no server required.

## Channel classification

Reuses Books `saleChannel(source, ref)` from `src/books/reports.js`:

| Channel | Rule (existing) |
|---|---|
| Shopify | Source contains `shopify` **or** Ref starts with `SALE:SHOPIFY\|` / `SALE:SHOPIFY:` |
| Other Sales | Source equals `other sales` (case-insensitive) |
| Manual | Everything else |

Global Ledger totals (`recognized_orders`, revenue, profit) are **unchanged**. Channel breakdown is additive context.

Paid **COGS** are split with the same `saleChannel()` rules. Gift/PR COGS stay in official Books COGS but are excluded from paid channel COGS (and therefore from Shopify contribution). If paid Books COGS and summed channel COGS diverge materially, a soft coverage warning may appear; Books totals are never mutated to “fix” gaps.

## Whole-business profitability

Includes **all** recognized channels (Shopify + Manual + Other Sales).

Business health uses Meta-adjusted profit / margin and Books gross margin for the period. Manual and Other Sales participate fully. This answers: *can the company absorb current Meta spend while remaining profitable?*

## Business ad-spend affordability

Human-facing name for the existing `business_advertising_safety` classifier (thresholds and calculation unchanged).

| Metric | Formula | Role |
|---|---|---|
| **Business-wide ad load / recognized order** | Meta spend ÷ **all** recognized Books orders | Compared to business break-even CPA |
| **Business break-even CPA** | Profit before ads ÷ all recognized orders | Whole-business safety threshold |

Statuses remain: `large_safety_margin`, `healthy`, `moderate`, `near_break_even`, `above_break_even` (plus insufficient-data paths).

This is **not** ecommerce acquisition efficiency. Shopify metrics do not drive this status.

## Shopify contribution (date-aligned — not attributed)

Separate economic view for the Shopify channel only:

```text
shopify_gross_profit_before_ads = shopify_revenue_ex_tax − shopify_cogs
shopify_contribution_after_meta = shopify_gross_profit_before_ads − meta_spend
shopify_contribution_margin_after_meta =
  shopify_revenue_ex_tax > 0
    ? shopify_contribution_after_meta / shopify_revenue_ex_tax
    : null
```

Displayed as **Shopify contribution after Meta**.

### Why it is not Shopify profit

Shared operating expenses (salaries, subscriptions, unallocated delivery, etc.) are **not** allocated to Shopify. This is channel contribution analysis only (`opex_allocated: false`).

### Why it is not Meta-attributed profitability

Meta spend is date-aligned with the Shopify window. It does **not** mean every Shopify order came from Meta. There is still no Meta→Shopify order join (`attribution_available: false`).

A display-only `contribution_status` (`positive_contribution` / `near_zero` / `negative_contribution` / `insufficient_data`) never changes business health, ad-spend affordability, or scale-candidate gating.

| Metric | Formula | Meaning |
|---|---|---|
| **Shopify ad load / recognized order** | Meta spend ÷ Shopify recognized orders | Supporting context only |
| **Meta CPA** | Meta spend ÷ Meta attributed purchases | Platform efficiency |

### Why Shopify ad load is not compared to break-even CPA

Break-even CPA uses **all-business** pre-ad profit ÷ **all** recognized orders. Comparing a Shopify-only denominator to that threshold would be another provenance mismatch.

## Revenue concentration

When one channel’s revenue share is ≥ 60%, `revenue_concentration` flags material concentration (`category: business_context`).

If the dominant channel is **not** Shopify, a non-alarmist **Business mix context** warning explains that whole-business profitability and ad-spend affordability are heavily influenced by non-Shopify sales — and are therefore not representative of ecommerce alone.

This does **not** invalidate revenue, suppress profitability calculations, or change classifiers.

## Attribution limitations

`no_order_level_attribution: true` remains. No product Meta ROAS. No campaign accounting profit. No opex allocation models. No automated pause/scale.

## Read-only guarantee

* Sheets: `getValues` only
* Meta: Graph GET only
* No campaign/budget/creative mutations
* Dashboard writes only local HTML under `reports/decisions/` (gitignored data)

## Architecture

```text
src/profitability/salesMix.js     Channel + COGS + contribution + concentration
src/decisions/loadInputs.js       Shared read-only loaders
src/decisions/report.js           Decision JSON + terminal presentation
src/dashboard/{format,groups,html}.js
src/scripts/decision-dashboard.js
```
