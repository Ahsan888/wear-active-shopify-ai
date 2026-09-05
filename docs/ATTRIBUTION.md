# Phase 5A — First-Party Attribution Foundation

## Purpose

Capture and normalize first-party acquisition evidence so future Shopify orders
can be analyzed against Meta entities — **without** replacing existing
date-aligned Shopify contribution or Meta platform metrics.

```text
Meta
 │
 ▼
Landing URL
 │
 ▼
WA Attribution Capture (Dawn theme)
 │
 ├── First Touch
 └── Last Attributable Touch
 │
 ▼
Shopify Cart attributes (_wa_attr)
 │
 ▼
Shopify Order (note_attributes / customAttributes)
 │
 ▼
Order Attribution Normalizer
 + Shopify customerJourneySummary (Admin GraphQL)
 │
 ▼
Reporting
 │
 ├── Meta First-Party
 ├── Organic
 ├── Direct
 ├── Paid non-Meta
 └── Unattributed
```

## Discovery summary (live)

| Surface | Finding |
|---|---|
| Theme | Lives in `Ahsan888/wear-active-dawn-theme` — not this repo |
| LIVE webhook | Books columns only historically; Phase 5A adds attribution columns |
| GraphQL Order | `landingSite`/`referringSite` **not** on API 2026-07 Order type |
| Journey | `customerJourneySummary` **is** available and already holds UTMs for many storefront orders |
| Cart attrs | Historically empty — theme capture required for click IDs |
| Meta creatives | `url_tags` empty on inspected ads; some journeys already show numeric IDs in UTM fields (likely from Meta URL params not exposed on creative.url_tags) |

## Architecture choices

### Order persistence: cart / note attributes

**Selected:** Shopify cart attributes (underscore-prefixed) → order `note_attributes` / `customAttributes`.

**Why:**

- Works on Shopify Basic (no Plus-only checkout extensibility)
- Survives into the order for webhook + Admin GraphQL
- Underscore keys stay off the customer-facing cart UI
- Complements (does not replace) Shopify `customerJourneySummary`

Also normalize Shopify journey data for historical / pre-theme orders.

### Storefront storage

- Key: `wa_attribution_v1` in `localStorage`
- Retention: 30 days (`ATTRIBUTION_RETENTION_DAYS`)
- Sync: `POST /cart/update.js` with `_wa_attr` JSON + compact `wa_ft_*` / `wa_lt_*` helpers

### Consent

Uses Shopify Customer Privacy APIs when present (`marketingAllowed` / `analyticsProcessingAllowed`).
If APIs are unavailable, capture attempts fail soft — cart and checkout still work.

## Semantics

### First touch

First attributable acquisition within the retention window. Not overwritten by later direct visits.

### Last attributable touch

Most recent attributable visit. Internal navigation does not rewrite it. Direct returns do not erase paid context.

### Direct returns

Day 1 Meta → Day 2 direct purchase keeps Meta as first + last attributable.

## Statuses

`meta_first_party` · `paid_non_meta` · `organic` · `direct` · `unknown` · `unattributed`

## Confidence

| Level | Rule (summary) |
|---|---|
| high | Meta click ID and/or stable Meta IDs |
| medium | Clear Meta UTM without click ID |
| low | Weak marketing/referrer evidence |
| none | No usable evidence |

## Capture start

`ATTRIBUTION_CAPTURE_STARTED_AT` (default `2026-09-06`).

Coverage prefers **post_capture** Shopify orders so historical empties do not tank the KPI.

## CLI

```bash
npm run attribution:report -- --days=7
npm run attribution:report -- --since=2026-08-01 --until=2026-09-06 --json
npm run attribution:test
```

## Dashboard

**Attribution** tab — labeled **FIRST-PARTY ATTRIBUTION — EXPERIMENTAL**.
No attributed profit.

## Daily email

At most one line:

`Attribution coverage: N% of Shopify orders`  
or `Attribution coverage still building: N%`

## Recommended Meta URL parameter template (do not apply without approval)

```text
utm_source=facebook
utm_medium=paid_social
utm_campaign={{campaign.id}}
utm_content={{ad.id}}
utm_term={{adset.id}}
```

Optional explicit aliases:

```text
campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}
```

**Operational caution:** Editing live ad URLs / URL parameters can trigger Meta review or learning resets depending on how changes are applied. Treat as a separate approved change — Phase 5A is read-only on Meta.

## Theme repo

Branch: `feat/first-party-attribution`  
Asset: `assets/wa-attribution.js` included from `layout/theme.liquid`.

## Phase 5B activation criteria (recommended)

- Post-capture coverage ≥ ~70% for 14+ consecutive days  
- Majority of Meta-attributed orders carry stable campaign/ad IDs  
- Click ID presence improving after URL template rollout  
- No increase in checkout errors attributable to cart sync  
- Explicit approval before any attributed contribution / ad profit views

## Non-goals (5A)

No decision classifier changes · no Meta writes · no accounting mutations · no attributed P&L · no PII capture
