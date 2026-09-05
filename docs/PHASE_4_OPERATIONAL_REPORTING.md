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
# Local generation only (no email)
npm run reports:daily -- --days=7 --no-delivery
npm run reports:daily -- --date=2026-09-06 --days=7 --no-delivery
npm run reports:daily -- --days=7 --dry-run
npm run reports:daily -- --json
```

Defaults:

| Setting | Default |
|---|---|
| Reporting date | Current `Asia/Karachi` calendar day |
| Window | Trailing `REPORT_DAILY_DAYS` (default 7) |
| Delivery | **Disabled** (`REPORT_DELIVERY_ENABLED=false`) |

Production owner email is sent by **GitHub Actions + Resend**, not by a normal local run.

## Period-specific artifacts

Canonical dated files include the period length:

```text
reports/snapshots/2026-09-06-7d.json
reports/briefs/2026-09-06-7d.txt
reports/briefs/2026-09-06-7d.json
reports/alerts/2026-09-06-7d.json
reports/delivery/2026-09-06-7d.json
```

30-day runs use `-30d`. `latest.txt` / `latest.json` remain convenience aliases for the most recent run.

History keys remain:

`snapshot_key = \`${reporting_date}:${period.days}\``

## Period-specific alert lifecycle

Lifecycle compares only against prior alerts for the **same** `period.days`:

`2026-09-05-7d.json` → previous source for `2026-09-06-7d.json`

A 30d run never drives 7d persistence/reminders.

## Delivery history & dedupe

Source of truth: `reports/delivery/history.jsonl`

`delivery_key = daily-report:${reporting_date}:${period.days}`

| Sequence | Result |
|---|---|
| 7d deliver | sent |
| 30d deliver | sent |
| 7d again | `already_delivered` |
| 7d + `--force-delivery` | sent again |

Failed attempts do **not** block retry. Upsert by `delivery_key`. Malformed history fails loudly.

Do **not** rely only on `latest.json` (that broke multi-period dedupe).

## Dashboard alerts vs owner email

| Concept | Role |
|---|---|
| `all_dashboard_alerts` | Full diagnostic set in JSON + dashboard |
| `owner_delivery_alerts` | Curated subset for email |

Email policy (presentation only — does not change Phase 3 classifiers):

- Show all **new** critical/high, **worsened** high, critical while active
- High unchanged ongoing → suppress; reminder every **3** comparable snapshots
- Medium: max **3**; new/worsened/reminder every **7** snapshots
- Low/info: never listed individually — count only
- Funnel warnings: grouped into lower-priority count
- Product data: one aggregated line
- Max **3** today’s actions
- Resolved: optional one-line count, not a list

Worsening (owner notification only): monetary ≥20% worse where direction matters; margin ≥3pp; entity status escalations (`watch`→`spend_no_purchase`→`high_priority_spend_no_purchase`, `relatively_weak_cpa`→`high_cpa`).

## Resend integration

**Reused existing flow** from weekly low-stock alerts:

| Item | Value |
|---|---|
| Implementation | `src/email/resend.js` (extracted from `src/scripts/low-stock-alert.js`) |
| Transport | `fetch` → `https://api.resend.com/emails` |
| npm package | **None** (no `resend` dependency; same as low-stock) |
| Secret | `RESEND_API_KEY` (existing) |
| Recipients | `REPORT_EMAIL_TO` with fallback to `LOW_STOCK_EMAIL_TO` |
| From | `REPORT_EMAIL_FROM` with fallback to `LOW_STOCK_EMAIL_FROM` |

Low-stock still supports optional SMTP; Phase 4 daily email uses **Resend only** (no Nodemailer).

Adapters: `console` · `file` · `webhook` · `resend`

Local preview without sending:

```bash
REPORT_DELIVERY_ENABLED=true REPORT_DELIVERY_CHANNEL=file npm run reports:daily -- --days=7
```

## GitHub Actions

Workflow: `.github/workflows/daily-report.yml`

| Concern | Behavior |
|---|---|
| Schedule | `cron: "0 4 * * *"` → **04:00 UTC = 09:00 Asia/Karachi** |
| Manual | `workflow_dispatch` with `days`, `date`, `send_email` |
| Scheduled email | **enabled** (`REPORT_DELIVERY_CHANNEL=resend`) |
| Manual email | **disabled** unless `send_email=true` |
| Concurrency | `wear-active-daily-report` / `cancel-in-progress: false` |
| Artifacts | upload reports + state, retention 30 days |
| No git commits | generated reports are never committed back |

### Operational state across ephemeral runners

GitHub runners start empty. State is restored/persisted via **Actions cache**:

- Restore `reports/state` (`actions/cache/restore` + `restore-keys: wa-ops-state-`)
- Unpack into `snapshots/history.jsonl`, `delivery/history.jsonl`, recent `alerts/*d.json`
- After the run, pack and `actions/cache/save` under `wa-ops-state-${{ github.run_id }}`

Also uploaded as artifacts for humans. **Do not** commit daily state to git.

Required secrets (reuse existing names): `RESEND_API_KEY`, `META_*`, `SHOPIFY_*`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEETS_SPREADSHEET_ID`, plus `REPORT_EMAIL_TO` / `REPORT_EMAIL_FROM` (or low-stock email secrets as fallback).

## Snapshot schema

Module: `src/operations/snapshot.js` — `schema_version: 1` compact KPI only.

## History

`reports/snapshots/history.jsonl` — upsert by `snapshot_key`, atomic rewrite, fail loud on malformed JSON.

## Trends

Comparable only when `period.days` matches.

## Backfill

```bash
npm run reports:backfill -- --since=2026-08-15 --until=2026-09-05 --days=7
```

Never emails unless explicitly `--deliver`.

## Tests

```bash
npm run operations:test
npm run dashboard:test
npm run decisions:test
npm run profitability:test
npm run meta:test
```

## Safety

- No Meta / Shopify / Sheets writes from the daily pipeline  
- Resend email is the only production external side effect when enabled  
- Secrets never written to report artifacts  
- Delivery failure does not delete generated reports; enabled delivery failure → nonzero exit  

## Related

- [LOW-STOCK-ALERTS.md](./LOW-STOCK-ALERTS.md) — original Resend pattern  
- [UNIFIED_REPORTING_DASHBOARD.md](./UNIFIED_REPORTING_DASHBOARD.md)  
- [PHASE_3_5_REPORTING.md](./PHASE_3_5_REPORTING.md)  
