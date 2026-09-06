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

`ATTRIBUTION_CAPTURE_STARTED_AT` must be the **actual** production storefront
tracking activation time (ISO timestamp preferred), e.g.:

```bash
ATTRIBUTION_CAPTURE_STARTED_AT=2026-09-08T14:37:00+05:00
```

Date-only values remain accepted. Do **not** set this until the Dawn theme
capture script is published. Coverage prefers **post_capture** Shopify orders.

Semantics:

- `order.createdAt < capture_started_at` → `pre_capture`
- `order.createdAt >= capture_started_at` → `post_capture`

Pre-capture orders must not produce `post_capture_order_missing_attribution`.

## Roles

| Layer | Responsibility |
|---|---|
| Dawn theme | Capture evidence only (UTMs, click IDs, cart attrs) |
| Reporting normalizer | Authoritative status, confidence, warnings |
| Webhook | Raw touch columns into LIVE (sheet-safe) |
| live-enrich | Authoritative Attribution Status / Confidence / Phase |

## Consent

Storefront consent is tri-state: `allowed` · `denied` · `unknown`.

Capture/sync only when `allowed`. Unknown or denied → skip silently.
Cart and checkout always continue to work.

## Cart sync

Idempotent: fingerprint stored in `wa_attribution_cart_sync_v1` only after
HTTP 2xx from `/cart/update.js`. Unchanged state does not re-POST.

## Payload

`_wa_attr` is always valid compact JSON ≤ 1800 chars (never mid-JSON sliced).
`landing_page` / `referrer` store origin+pathname only (no arbitrary query).

## Accelerated checkout limitation

Buy Now / Shop Pay / dynamic checkout buttons may bypass cart attributes on
Shopify Basic. Documented coverage gap — do not disable accelerated checkout
solely for attribution without explicit approval.

## Phase 5B — attributed economics

```bash
npm run attribution:economics -- --days=7
npm run attribution:economics -- --since=2026-08-01 --until=2026-09-06 --json
```

Connects first-party Meta IDs on **recognized Ledger Shopify orders** to entity spend.

Keeps separate:

1. Meta-reported platform metrics  
2. First-party observed Shopify attribution (this report)  
3. Unattributed recognized Shopify orders (not allocated)

Dashboard: **Attr. Economics** — labeled **FIRST-PARTY ATTRIBUTED ECONOMICS — EXPERIMENTAL**.

Does **not** change decision classifiers, Books posting, or Meta mutations.

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

Apply Meta URL template **after** storefront capture is proven.

## Theme repo

Branch: `feat/first-party-attribution`  
Asset: `assets/wa-attribution.js` included from `layout/theme.liquid`.  
Theme tests: `node scripts/wa-attribution-self-test.js`

## Phase 5B activation criteria (recommended)

- Post-capture coverage ≥ ~70% for 14+ consecutive days  
- Majority of Meta-attributed orders carry stable campaign/ad IDs  
- Click ID presence improving after URL template rollout  
- No increase in checkout errors attributable to cart sync  
- Explicit approval before any attributed contribution / ad profit views

## Non-goals (5A)

No decision classifier changes · no Meta writes · no accounting mutations · no attributed P&L · no PII capture
