# Low-stock email alerts

Weekly (or on-demand) email listing **active** Shopify variants with only
**1 unit left** of a specific size/colour (last piece).

## Local dry-run

```bash
npm run stock:low
```

## Send once

1. Add to `.env` (see `.env.example`):

```bash
LOW_STOCK_THRESHOLD=1
LOW_STOCK_EMAIL_TO=you@wearactive.com,ops@wearactive.com
LOW_STOCK_EMAIL_FROM=Wear Active Alerts <alerts@yourdomain.com>
RESEND_API_KEY=re_...
```

2. Verify your domain in [Resend](https://resend.com) (or use SMTP — see below).

3. Send:

```bash
npm run stock:low:send
```

## Weekly schedule (GitHub Actions)

After the repo is on GitHub, add these **repository secrets**:

| Secret | Required | Notes |
|---|---|---|
| `SHOPIFY_SHOP` | yes | Store subdomain |
| `SHOPIFY_CLIENT_ID` | yes | |
| `SHOPIFY_CLIENT_SECRET` | yes | |
| `LOW_STOCK_EMAIL_TO` | yes | Comma-separated recipients |
| `LOW_STOCK_EMAIL_FROM` | yes* | Verified from-address (*Resend) |
| `RESEND_API_KEY` | yes* | Prefer Resend |
| `SMTP_*` | alt | If not using Resend |

Optional repo **variables**: `SHOPIFY_API_VERSION`, `LOW_STOCK_THRESHOLD`.

Workflow: `.github/workflows/low-stock-alert.yml`

- Runs every **Monday 04:00 UTC** (~09:00 PKT)
- Also runnable manually: Actions → “Weekly low-stock alert” → Run workflow

## SMTP alternative

```bash
npm install nodemailer
```

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=Wear Active Alerts <alerts@yourdomain.com>
```

Resend is tried first; SMTP is the fallback when `RESEND_API_KEY` is unset.

## Rule

Alerts fire when `0 < inventoryQuantity <= LOW_STOCK_THRESHOLD` (default **1**).
Out-of-stock (`0`) is excluded — this is a “last piece” restock warning, not an
empty-SKU list.
