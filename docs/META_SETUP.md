# Meta Ads setup (Wear Active)

Read-only Marketing API reporting for **WA's Ad Account**.

This does **not** create, pause, or edit ads. Scripts only call Graph API GET
endpoints.

## Required environment variables

In `.env` (never commit this file):

```bash
META_ACCESS_TOKEN=your-meta-access-token
META_AD_ACCOUNT_ID=4074524202691358
META_API_VERSION=v21.0
```

| Variable | Notes |
|---|---|
| `META_ACCESS_TOKEN` | Long-lived system-user token with at least `ads_read` |
| `META_AD_ACCOUNT_ID` | Digits only **or** `act_<id>` — the client normalizes to `act_…` |
| `META_API_VERSION` | Optional; defaults to `v21.0` if unset |

### Current Wear Active ad account

```text
META_AD_ACCOUNT_ID=4074524202691358
→ act_4074524202691358
→ name: WA's Ad Account
```

The system user **`wearactive-reports`** has successfully read this account when
assigned with ads access in Business Manager.

**Wrong ID example:** `61594050537588` is not accessible with the current token
and returns Meta error **#200**.

## One-time Business Manager checklist

1. Meta Business Suite → Business settings → **Users → System users**.
2. Select `wearactive-reports` (or your reporting system user).
3. Assign **WA's Ad Account** (`4074524202691358`) with at least **View performance**
   / ads read access.
4. Generate a token that includes `ads_read` (and optionally `ads_management` —
   this repo still uses the token **read-only**).
5. Put the token in local `.env` only.

## Commands

```bash
# Credential + insights smoke test
npm run meta:check

# Human campaign report (default: last 7 calendar days in account timezone)
npm run meta:report
npm run meta:report -- --days=30
npm run meta:report -- --since=2026-08-01 --until=2026-09-05
npm run meta:report -- --level=adset
npm run meta:report -- --level=ad
npm run meta:report -- --json

# Full export (campaign + adset + ad + light creative metadata)
npm run meta:report:full -- --days=30
npm run meta:report:full -- --since=2026-08-01 --until=2026-09-05

# Conservative merge stub (Meta-only is fine; no attribution invented)
npm run reports:merge -- --meta=reports/meta/YYYY-MM-DD_to_YYYY-MM-DD/summary.json
```

Generated files land under `reports/meta/` and `reports/merged/` (gitignored).

## KPI notes

- Purchases / purchase value prefer Meta action types in this order:
  `purchase` → `omni_purchase` → `offsite_conversion.fb_pixel_purchase`
  (first match only — **not** summed, to avoid double-counting).
  The same first-match rule applies to ATC / checkout aliases.
- `purchase_action_type` / `purchase_value_action_type` record which variant
  was selected from `actions` vs `action_values`.
- **ROAS** = purchase value ÷ spend (Meta-attributed).
- **CPA** = spend ÷ purchases.
- **`purchase_per_impression_pct`** = purchases ÷ impressions × 100.
  This is **not** ecommerce site “purchase CVR”.
- Funnel ratios (null when the denominator is missing/zero):
  - `lpv_to_atc_pct` = ATC ÷ LPV × 100
  - `lpv_to_checkout_pct` = checkouts ÷ LPV × 100
  - `lpv_to_purchase_pct` = purchases ÷ LPV × 100
  - `atc_to_checkout_pct` = checkouts ÷ ATC × 100
  - `checkout_to_purchase_pct` = purchases ÷ checkouts × 100
- Campaign/adset **reach** summed across rows is an upper-bound proxy;
  `meta:report:full` `summary.json` → `totals` uses authoritative
  **account-level** Insights (unique reach).

### Full export ad counts

`meta:report:full` joins date-range Insights with the full account ads catalog:

| Count | Meaning |
|---|---|
| `ads_with_insights` | Ads returned by Insights for the selected range |
| `ads_metadata` | Ads fetched from the account ads catalog |
| `ads_total_exported` | Final joined/exported row count (may include 0-spend ads) |

A large `ads_total_exported` does **not** mean that many ads delivered in-range.

## Attribution caveat (Meta vs Shopify vs Books)

Meta purchase counts are **not** Shopify order counts and **not** Books recognized
revenue. Different windows, filters, and recognition rules apply. Use
`reports:merge` only as a container until a deliberate join design exists.

## Pure-function tests

```bash
npm run meta:test
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Meta **#200** | Token/system user lacks ads access on the configured account, or wrong `META_AD_ACCOUNT_ID` | Use `4074524202691358`; assign `wearactive-reports` in Business Manager |
| Meta **#190** | Invalid/expired token | Issue a new long-lived system-user token |
| Meta **#100** | Unsupported field/param for API version, or bad date | Check `META_API_VERSION`; simplify fields; verify real `YYYY-MM-DD` dates |
| Invalid `--days` / unknown flag | CLI validation | Use `--days=7` (positive integer); known flags only |
| Pagination exceeded maxPages | Safety guard against silent truncation | Rare for WA; raise `maxPages` only intentionally |
| Empty insights | No delivery in range (or future dates) | Widen `--days` / `--since`–`--until` |
| `meta:check` OK but report empty | Access works; no spend in window | Pick a range that had delivery |

## Architecture (repo)

```text
src/meta/client.js     Graph GET + pagination (read-only)
src/meta/metrics.js    Action extraction + KPI helpers
src/meta/cli.js        Shared CLI date/level helpers
src/scripts/meta-*.js  npm entrypoints
docs/META_SETUP.md     this file
```
