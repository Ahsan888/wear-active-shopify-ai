# Phase 4 — Operational Daily Reporting

## Purpose

Turn existing reporting engines into an **owner-ready daily package**:

unified dashboard · KPI snapshot · daily brief · history · alerts · delivery hooks

Phase 4 **consumes** Phase 2/3 outputs. It does **not** re-derive profitability,
accounting, Meta metrics, attribution, or decision classifiers.

```text
Existing reporting engines
        ↓
Unified reporting bundle
        ↓
Operational reporting layer
        ↓
Dashboard + snapshot + brief + alerts + delivery
```

## Daily pipeline

```bash
npm run reports:daily
npm run reports:daily -- --date=2026-09-06
npm run reports:daily -- --days=7
npm run reports:daily -- --no-delivery
npm run reports:daily -- --dry-run
npm run reports:daily -- --json
npm run reports:daily -- --force-delivery
```

Defaults:

| Setting | Default |
|---|---|
| Reporting date | Current `Asia/Karachi` calendar day |
| Window | Trailing `REPORT_DAILY_DAYS` (default 7) |
| Delivery | **Disabled** (`REPORT_DELIVERY_ENABLED=false`) |

Orchestrator: `src/operations/daily.js`

1. Load inputs for trailing window  
2. Build unified reporting bundle  
3. Build compact KPI snapshot  
4. Load history → trends  
5. Evaluate alerts (+ lifecycle vs prior day)  
6. Build deterministic brief  
7. Render dashboard with operational trends/alerts  
8. Persist dated outputs + upsert history (unless `--dry-run`)  
9. Optional delivery  

`--dry-run`: compute + print preview; **no** history write, **no** latest overwrite, **no** delivery.

## Snapshot schema

Module: `src/operations/snapshot.js`  
`schema_version: 1`

Compact KPI only — not the full dashboard JSON. Key fields:

- `reporting_date`, `timezone`, `period.{since,until,days,current_day_incomplete}`
- `snapshot_key = \`${reporting_date}:${period.days}\``
- `business`, `advertising_affordability`, `shopify`, `meta`, `sales_mix`, `accounting`, `decisions`, `confidence`

Validation rejects malformed rows before history write.

## History

File: `reports/snapshots/history.jsonl` (append/upsert, atomic rewrite)

- One record per `snapshot_key` (`date:days`)
- Same key replaces (idempotent)
- Chronological sort
- Empty file / trailing newline OK
- Malformed JSON → **loud failure** (never silently discarded)

Helpers: `loadHistory`, `upsertSnapshot`, `writeHistory`, `getPreviousSnapshot`, `getRecentSnapshots`

### Recovery if history is malformed

1. Copy `reports/snapshots/history.jsonl` aside  
2. Identify the bad line number from the error  
3. Fix or remove that line  
4. Optionally rebuild from dated `reports/snapshots/YYYY-MM-DD.json` files  
5. Re-run `npm run reports:daily -- --no-delivery`

## Trends

Module: `src/operations/trends.js`

- Day-over-day only when a **comparable** prior snapshot exists  
- Comparable ⇒ same `period.days`  
- 7d vs 30d → `not_comparable` (no fake deltas)  
- Wording: “vs previous comparable snapshot” — not definitive causal claims  
- Does **not** alter Phase 3 classifiers  

## Daily brief

Module: `src/operations/brief.js` — deterministic templates (no LLM).

Outputs:

- `reports/briefs/YYYY-MM-DD.txt` / `.json`
- `reports/briefs/latest.txt` / `.json`

JSON is structured for future Slack/email/WhatsApp adapters (`headline`, `sections`, `alerts`, `dashboard_path`).

## Alerts

Module: `src/operations/alerts.js`

Deterministic, evidence-based. Prefer existing statuses/recommendations over invented thresholds.

| Type | Trigger (summary) | Severity notes |
|---|---|---|
| Business unprofitable | `business_health = unprofitable` | high / critical |
| Margin drop | comparable margin ↓ ≥ `margin_drop_pp` (default 5 pp) | medium / high |
| Shopify negative contribution | `contribution_status = negative_contribution` | medium; **high** if ≥ 3 comparable runs |
| Zero-purchase ads | existing `high_priority_spend_no_purchase` / `spend_no_purchase` | high / medium |
| High CPA | existing `high_cpa` / `relatively_weak_cpa` | high / medium |
| Funnel | `primary_weak_funnel` / borderline warnings | medium / low |
| Accounting | ledger missing / recurring not posted / full_month_variance | medium; partial-period → **info only** |
| Product data | aggregated SKU/cost issues | one alert, not per SKU |
| Revenue concentration | `non_shopify_distortion_risk` | low / medium (context) |
| Meta spend spike | ≥30% and abs ≥ 0.25× account CPA | medium |
| CPA deterioration | ≥25% with ≥2 purchases | medium |
| ROAS decline | supplemental only | low |

### Alert thresholds (Phase 4 only)

Configured in `src/operations/config.js` / env (`REPORT_ALERT_*`).  
**Must not** change Phase 3 classifiers.

### Lifecycle

Compare to prior day’s alert IDs:

- `new` · `ongoing` · `resolved`

Resolved appear in JSON/dashboard (collapsed); usually omitted from delivered brief.

### Attention summary

Descriptive counts only — never a fake 0–100 score.

## Delivery

Module: `src/operations/delivery.js`

| Env | Default |
|---|---|
| `REPORT_DELIVERY_ENABLED` | `false` |
| `REPORT_DELIVERY_CHANNEL` | `console` |
| `REPORT_DELIVERY_WEBHOOK_URL` | empty |

Adapters: `console`, `file`, `webhook` (optional email/Slack later via payload shape).

Safety:

- `--no-delivery` overrides env  
- Delivery key `daily-report:YYYY-MM-DD:days` — no re-send unless `--force-delivery`  
- Backfill never delivers unless `--deliver`  
- Webhook: short timeout, max 2 attempts, redacted URL in logs/audit  
- Generation success + required delivery failure → **nonzero exit**; artifacts kept  
- Delivery disabled → success  

Audit: `reports/delivery/YYYY-MM-DD.json` (+ `latest.json`) — no secrets.

Delivered brief prioritizes critical/high + max 5 medium; low count only.

## Dashboard extensions

Overview adds:

- **Trends** table (current / previous / change)  
- **Daily Alerts** by severity + NEW/ONGOING lifecycle  

No chart libraries. Empty history shows a short placeholder.

## Output files

```text
reports/
  dashboard/index.html
  dashboard/report-YYYY-MM-DD-to-YYYY-MM-DD.html
  snapshots/YYYY-MM-DD.json
  snapshots/history.jsonl
  briefs/YYYY-MM-DD.txt|.json + latest.*
  alerts/YYYY-MM-DD.json + latest.json
  delivery/YYYY-MM-DD.json + latest.json
```

Generated outputs are **gitignored** (`.gitkeep` only).

## Current-day caveat

When `period.until === reporting_date`, `period.current_day_incomplete = true`.

Brief/dashboard note: *Today's Meta and order activity may still be incomplete.*

## Backfill

```bash
npm run reports:backfill -- --since=2026-08-15 --until=2026-09-05 --days=7
```

- Same trailing window per date  
- No external delivery by default  
- Max 90 days unless `--force`  
- Idempotent on `snapshot_key`  

## Scheduling

Do **not** run a custom daemon. Prefer host cron:

```cron
0 9 * * * cd /path/to/wear-active-shopify-ai && /usr/bin/env npm run reports:daily >> reports/daily.log 2>&1
```

Helper: `scripts/run-daily-report.sh`  
Recommended local time: **09:00 Asia/Karachi** (host TZ dependent).  
Logic is not hard-coded to 09:00.

### GitHub Actions (optional, not required)

Not shipped as a merge blocker. To add later:

- Store Meta / Google / Shopify credentials as repository secrets  
- `workflow_dispatch` + cron `0 4 * * *` (09:00 PKT ≈ 04:00 UTC while PKT = UTC+5)  
- Upload `reports/**` as artifacts  
- **Do not** commit generated reports back to `main`  

## CLI

Daily: `--date` `--days` `--dry-run` `--no-delivery` `--force-delivery` `--json`  
Backfill: `--since` `--until` `--days` `--force` `--briefs` / `--no-briefs` `--deliver`  

Unknown args and invalid dates fail loudly.

## Tests

```bash
npm run operations:test
npm run dashboard:test
npm run decisions:test
npm run profitability:test
npm run meta:test
```

## Attribution / read-only guarantees

- No order-level attribution claims  
- Shopify contribution remains **date-aligned**, not attributed  
- Business affordability remains **whole-business**  
- Meta spend never double-deducted  
- No Meta / Shopify / Sheets writes from the daily pipeline  
- No automatic ad pause/scale, product decisions, or accounting corrections  
- No LLM-generated recommendations  
- Secrets never written into report artifacts  

## Related docs

- [UNIFIED_REPORTING_DASHBOARD.md](./UNIFIED_REPORTING_DASHBOARD.md)  
- [PHASE_3_5_REPORTING.md](./PHASE_3_5_REPORTING.md)  
- [PROFITABILITY_REPORTING.md](./PROFITABILITY_REPORTING.md)  
