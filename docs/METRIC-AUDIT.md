# Metric & presentation audit (Phases 10–11)

Audit of displayed dashboard metrics. **No silent accounting-formula changes** were made in this build.

## Registry

Machine-readable definitions: `src/dashboard/metrics.js` (`METRICS`).

## Provenance badges

Where confusion is likely, cards show: `META` · `SHOPIFY` · `BOOKS` · `FIRST-PARTY` · `CALCULATED` · `FORECAST`.

## Boundaries preserved (unchanged formulas)

| Metric | Source | Formula / notes |
|--------|--------|-----------------|
| Meta CPA | META | spend ÷ Meta purchases — platform only |
| Break-even CPA | CALCULATED | profit_before_ads ÷ Books recognized_orders |
| Business ad load | CALCULATED | Meta spend ÷ Books recognized_orders |
| Meta-adjusted profit | CALCULATED | Books net + booked Ads − Meta spend |
| Shopify contribution | CALCULATED | Shopify net − COGS − date-aligned Meta (not attributed) |
| Phase 8 discount floor | CALCULATED | Accounting **ex-tax** margin |
| FP attributed economics | FIRST-PARTY | Post-capture observational only |

## Presentation / label changes in this build

These are **wording / UX** only unless noted:

| Display change | Why |
|----------------|-----|
| “Meta cost per purchase (CPA)” | Beginner clarity; same Meta CPA |
| “Break-even ad cost per sale” | Clarify ≠ Meta CPA |
| “Profit after actual Meta spend” | Plain name for meta_adjusted_profit |
| “Ad spend per recognized sale” | Distinct from Meta CPA |
| Overview → Owner Brief | Phase 11 OS layout |
| Forecast tab + FORECAST badge | Separate projections from actuals |
| Source badges on key cards | Reduce Meta/Books conflation |

## Suspected data issues (report only — not silently “fixed”)

- First-party attribution may still be **immature** — Meta numbers are not independently verified.
- Inventory↔ad mapping may be empty (`config/marketing-entity-product-map.json`) — inventory cannot constrain Meta ads until mapped.
- Calendar MTD forecast requires a separate month-start load when the selected period does not start on day 1; otherwise a period proxy is used and labelled.

## Metrics suppressed when unsafe

- Month-end scenario emphasis when confidence = `INSUFFICIENT`
- Inventory days-of-cover / depletion when 30d demand evidence is zero
- Causal revenue from Meta spend what-ifs (explicitly **unknown**)

## Remaining limitations

- Deterministic pace forecasts only — not ML
- No automatic Meta/Shopify/Books writes
- 7/14/30 overlapping Meta windows remain contextual for marketing; independent periods drive repeated evidence
