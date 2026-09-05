# Decision intelligence reporting (Phase 3)

Read-only advisory report on top of Phase 1 Meta + Phase 2 profitability.

**Never mutates Meta. Never writes Sheets. Never alters Ledger/Shopify.**

## Commands

```bash
npm run decisions:report -- --days=7
npm run decisions:report -- --days=14
npm run decisions:report -- --days=30
npm run decisions:report -- --since=2026-08-01 --until=2026-08-31
npm run decisions:report -- --days=7 --json
npm run decisions:test
```

Timezone for `--days`: **Asia/Karachi**.

## Two CPA concepts (do not mix)

| Metric | Formula | Meaning |
|---|---|---|
| **Business blended ad cost / recognized order** | `meta_spend / books_recognized_orders` | Period advertising load per Books order |
| **Business break-even CPA** | `profit_before_ads / books_recognized_orders` | Max blended ad cost before Meta-adjusted profit hits zero |
| **Meta attributed CPA** | `meta_spend / meta_purchases` | Platform efficiency only |

Business advertising safety compares the first two (same Books denominator).

Meta entity classifiers compare Meta CPA/ROAS to **account Meta** baselines.

## Attribution

`no_order_level_attribution: true` always.

There is no Meta→Shopify order join, no product Meta ROAS, no campaign accounting profit.

## Architecture

```text
src/decisions/thresholds.js       Named tunable constants
src/decisions/business.js         Business health
src/decisions/advertising.js      Business ads safety + Meta efficiency + ROAS diagnostic
src/decisions/entities.js         Campaign/ad classifiers + funnel
src/decisions/products.js         Books product classes
src/decisions/confidence.js       Confidence + accounting gates
src/decisions/recommendations.js  Deterministic recs
src/decisions/report.js           JSON + human formatter
src/scripts/decision-report.js    CLI (reuses Phase 1/2 loaders)
```

## Scale recommendations

Wording: **candidate_for_controlled_budget_increase**.

Requires Meta efficiency gates **and** profitable business health **and** business ads safety not near/above break-even **and** no accounting suppress gate.

Never auto-scale. Never mutate Meta.
