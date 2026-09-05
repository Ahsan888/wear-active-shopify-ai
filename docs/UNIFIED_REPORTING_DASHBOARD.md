# Unified Reporting & Decision Intelligence Dashboard

Human-readable HTML interface over Wear Active’s existing Phase 1–3.5 reporting engines.

## Purpose

One self-contained dashboard for:

* Books / profitability
* Meta advertising
* Sales / channel provenance
* Shopify ecommerce contribution
* Product economics
* Decision intelligence
* Accounting reconciliation
* Data quality

The **CLI/JSON reporting engines remain the calculation source of truth.**  
The HTML dashboard is presentation only — it does not recompute accounting or business classifiers.

## Commands

Preferred:

```bash
npm run reports:dashboard -- --days=7
npm run reports:dashboard -- --days=14
npm run reports:dashboard -- --days=30
npm run reports:dashboard -- --since=2026-08-01 --until=2026-08-31
npm run reports:dashboard -- --days=7 --open
```

Backward-compatible:

```bash
npm run decisions:dashboard -- --days=7
```

## Output paths

| Command | Latest file | Dated copy |
|---|---|---|
| `reports:dashboard` | `reports/dashboard/index.html` | `reports/dashboard/report-<since>-to-<until>.html` |
| `decisions:dashboard` | `reports/decisions/dashboard.html` | `reports/decisions/decision-<since>-to-<until>.html` |

Open by double-clicking the HTML file. No web server required.

## Views

1. **Overview** — executive landing (health, affordability, Shopify context, Meta efficiency, mix, top actions)
2. **Profitability** — Books P&L, Meta-adjusted economics, ads reconciliation, expenses
3. **Sales & Channels** — channel table, Shopify contribution waterfall, revenue concentration
4. **Products** — grouped product economics with SKU detail and filters
5. **Advertising** — Meta account/funnel + campaigns / ad sets / ads
6. **Decisions** — decision summary, recommendations, attention / scale candidates
7. **Data Quality** — reconciliation, product flags, attribution limits, pipeline, confidence

Navigation is in-page tabs inside **one** HTML file.

## Architecture

```text
Shopify / Ledger / Variant Master / Meta
                ↓
existing reporting engines (Phase 1–3.5)
                ↓
buildUnifiedReportingBundle()   src/dashboard/bundle.js
                ↓
renderUnifiedDashboard()        src/dashboard/html.js
                ↓
reports/dashboard/index.html
```

Key modules:

* `src/dashboard/bundle.js` — assemble decision + books + pipeline + annotated entities
* `src/dashboard/html.js` — HTML/CSS/JS presentation
* `src/dashboard/format.js` — money/pct/tips + CPA evidence display helpers
* `src/dashboard/groups.js` — product / recommendation grouping
* `src/scripts/reports-dashboard.js` — CLI

## Metric definitions (selected)

| Term | Meaning |
|---|---|
| Books Net Profit | Accounting result using booked Ledger expenses |
| Meta-Adjusted Profit | Books economics with booked Ads replaced by actual Meta spend (not deducted twice) |
| Business Ad-Spend Affordability | Whether whole-business economics can absorb Meta spend |
| Shopify Contribution After Meta | Net Shopify revenue − Shopify COGS − date-aligned Meta spend; shared opex not allocated |
| Meta CPA | Meta spend / Meta-attributed purchases |
| Shopify Ad Load / Order | Meta spend / recognized Shopify orders — **not CAC** |
| Business Break-Even CPA | Profit-before-ads / all recognized business orders |
| Meta ROAS | Meta-attributed purchase value / Meta spend |
| Blended MER | Recognized business revenue / Meta spend |
| Recognized Order | Order satisfying Books recognition rules |
| Open Pipeline | Shopify orders not yet recognized — **not revenue** |
| **Paid Sales Gross Margin** | Paid-channel net revenue ÷ paid-channel COGS economics (Shopify + Manual + Other Sales). **Excludes Gift/PR COGS.** |
| **Books Gross Margin** | Official Ledger net revenue and **all** official COGS, **including Gift/PR COGS.** |

### Paid Sales GM vs Books GM

These margins may differ. That is intentional.

* **Sales & Channels → Paid Sales Total** answers: how did paid recognized sales perform after product COGS?
* **Profitability → Books Gross Margin** answers: what does official accounting show after all Ledger COGS (including Gift/PR)?

Gift/PR stock-outs are kept in Books COGS but excluded from paid channel COGS so channel contribution is not distorted.

## CPA display semantics (Advertising / Decisions)

**Purchasing entity**

* CPA = entity Meta CPA
* **vs account CPA** = entity CPA ÷ account Meta CPA

**Zero-purchase entity**

* CPA = unavailable (—)
* **Spend evidence vs account CPA** = entity spend ÷ account Meta CPA  
  (must not be labelled as if an entity CPA exists)

## Accounting rules (non-negotiable)

1. Do not double-deduct Meta spend.
2. Business profitability includes all recognized channels.
3. Ad-spend affordability uses Meta spend ÷ **all** recognized orders vs business BE CPA.
4. Shopify ad load does not drive business safety.
5. Shopify contribution is channel contribution, not net profit.
6. Do not allocate shared opex to Shopify.
7. Do not claim Meta caused all Shopify orders.
8. Meta CPA remains Meta-attributed.
9. No product-level Meta attribution / ROAS.
10. Refunds reduce net revenue; they do not auto-reverse COGS.
11. Official Books totals remain Ledger-driven.
12. Dashboard presentation never modifies source data.

## Attribution limitations

`ORDER-LEVEL ATTRIBUTION: UNAVAILABLE`

Meta attributed purchases cannot currently be deterministically joined to individual Shopify orders.

## Print / Save PDF

Use **Print / Save PDF** in the header (`window.print()`). Browser “Save as PDF” is enough — no Puppeteer.

## CLI vs HTML

| Layer | Role |
|---|---|
| `npm run decisions:report` / `profitability:report` / `meta:report` | Calculation + terminal/JSON truth |
| `npm run reports:dashboard` | Human-readable multi-view interface |

## Tests

```bash
npm run dashboard:test
npm run decisions:test
npm run profitability:test
npm run meta:test
```

## Non-goals

No hosted server, React, database, auth, cron, email, Sheets writes, Meta mutations, auto-scale/pause, UTM/fbclid attribution, opex allocation models.
