# Phase 3.5 — Sales provenance & decision dashboard

Read-only management interface on top of Phase 2 profitability + Phase 3 decisions.

## Purpose

1. Make reporting **sales-provenance aware** so Manual / Other Sales are visible and are not silently treated as marketing Shopify demand.
2. Provide a **local HTML dashboard** that is easier to read than long terminal reports.

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

## Three different “ad cost” ideas

| Metric | Formula | Meaning |
|---|---|---|
| **Business-wide ad load / recognized order** | Meta spend ÷ **all** recognized Books orders | Business advertising load; used vs break-even CPA for safety |
| **Shopify ad load / recognized order** | Meta spend ÷ **Shopify** recognized orders | Supporting context only |
| **Meta CPA** | Meta spend ÷ Meta attributed purchases | Platform efficiency |

### Why Shopify ad load is not CAC

It divides Meta spend by Shopify orders in the same calendar window. It does **not** claim Meta caused those orders. There is still no Meta→Shopify attribution.

### Why Shopify ad load is not compared to break-even CPA

Break-even CPA uses **all-business** pre-ad profit ÷ **all** recognized orders. Comparing a Shopify-only denominator to that threshold would be another provenance mismatch. Business safety status stays on business-wide ad load vs business-wide BE CPA.

## Attribution limitations

`no_order_level_attribution: true` remains. No product Meta ROAS. No campaign accounting profit.

## Read-only guarantee

* Sheets: `getValues` only
* Meta: Graph GET only
* No campaign/budget/creative mutations
* Dashboard writes only local HTML under `reports/decisions/` (gitignored data)

## Architecture

```text
src/profitability/salesMix.js     Channel aggregation + ad-load helpers
src/decisions/loadInputs.js       Shared read-only loaders
src/dashboard/{format,groups,html}.js
src/scripts/decision-dashboard.js
```
