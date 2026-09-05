# Profitability reporting (Phase 2)

Read-only blended report combining **Ledger (Books)**, **Recurring Expenses**,
**Variant Master**, **Shopify LIVE pipeline**, and **Meta Marketing API**.

## Commands

```bash
npm run profitability:report -- --days=7
npm run profitability:report -- --since=2026-08-01 --until=2026-08-31
npm run profitability:report -- --days=7 --json
npm run profitability:test
```

Timezone for default `--days` windows: **Asia/Karachi** (inclusive dates).

## Hard rule — no double-counting Meta ads

Ledger already books advertising as:

`Entry Type = Expense`, `Category = Ads`

Books net profit **already subtracts** that Ads expense (plus Delivery and other opex).

Therefore Meta API spend must **never** be deducted again from Books net profit.

| View | Formula |
|---|---|
| Books net profit | Ledger truth (Sale − refunds − COGS − Delivery − **Ads** − other opex) |
| Profit before ads | `books_net_profit + ads_expense_booked` |
| Meta-adjusted profit | `profit_before_ads − meta_spend` |

`meta_spend_treatment` is always:

`analytical_replacement_only_not_additional_expense`

Meta-adjusted profit is **pro-forma / analytical**, not official Books profit.

## MER vs Meta ROAS

| Metric | Definition |
|---|---|
| Meta ROAS | Meta attributed purchase value ÷ Meta spend |
| Blended MER | Books net revenue ex-tax ÷ Meta spend |

Do not confuse them. There is **no Meta→Shopify order attribution** in this repo.

## Recurring vs Ledger Ads

Recurring Expenses has **no** Processed/Posted/Ref Key.

Posting into Ledger is **outside** `books:sync` (manual / external).

The report:

- reads Recurring Ads and Ledger Ads independently
- heuristically matches same date + amount (conservative)
- never assumes Recurring = booked

Partial-month Meta ranges are marked:

`partial_period_not_comparable`

Full calendar months enable clearer variance status.

## Duplicate Ledger Ads

If identical Ledger expense signatures appear twice (e.g. May 2026 Ads 75,308 ×2),
the report **warns** but **does not** change `ads_expense_booked`.

Official Books totals always reflect raw Ledger rows.

## Product economics

SKU revenue/COGS come from Ledger. Variant Master supplies labels / cost validation only.

Meta spend is **not** allocated to products. No product ROAS.

## Safety

- Sheets: **read-only** (`getValues` only)
- Meta: **read-only** Graph GET
- Never runs `books:sync:apply`
- Never prints tokens or customer PII

## Architecture

```text
src/profitability/books.js           Ledger / Recurring / LIVE / VM loaders
src/profitability/metrics.js         Meta-adjusted + break-even + MER
src/profitability/reconciliation.js  Ads reconcile + duplicate warnings
src/scripts/profitability-report.js  CLI
```
