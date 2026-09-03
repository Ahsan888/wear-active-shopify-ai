# Setup checklist

First-time setup for this monorepo on a new machine or after cloning from GitHub.

## 1. Clone and Node deps

```bash
git clone <YOUR_GITHUB_REPO_URL> wear-active-shopify-ai
cd wear-active-shopify-ai
cp .env.example .env
npm ci
```

## 2. Shopify Admin API

Create (or reuse) a custom Shopify app on the store with Admin API scopes for
products, inventory, and orders as needed by the scripts you run.

In `.env`:

```bash
SHOPIFY_SHOP=your-store          # subdomain only, e.g. ubhxvn-xh
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
SHOPIFY_API_VERSION=2026-07
```

Verify:

```bash
npm run shopify:ping
```

## 3. Google Sheets (service account)

1. In Google Cloud, create a service account and download a JSON key.
2. Save it locally as `./google-service-account.json` (or another path).
3. Share the **WA Athleisure Stock** spreadsheet with the service account email
   as **Editor**.
4. In `.env`:

```bash
GOOGLE_SERVICE_ACCOUNT_FILE=./google-service-account.json
GOOGLE_SHEETS_SPREADSHEET_ID=your-spreadsheet-id
```

Verify:

```bash
npm run sheets:info
```

**Never commit the JSON key.** It is gitignored.

## 4. Books sync (optional weekly)

```bash
npm run books:sync          # preview
npm run books:sync:apply    # write LIVE enrichment, Ledger, reports
```

Read [BOOKS-SOP.md](BOOKS-SOP.md) before the first apply.

## 5. Order webhook (optional but recommended)

Deploy `apps-script/shopify-webhook.js` as an Apps Script web app and attach
Shopify webhooks as described in the root [README.md](../README.md).

Until webhooks are live, `books:sync:apply` can still pull order state from
Shopify Admin.

## 6. Meta Ads (optional)

Only needed for Meta reporting scripts:

```bash
META_ACCESS_TOKEN=...
META_AD_ACCOUNT_ID=...
META_API_VERSION=v21.0
```

## 7. Photo editor (optional)

```bash
cd wear-active-editor
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # OPENAI_API_KEY=...
```

Create local working folders if missing:

```bash
mkdir -p input photos gpt_output webp_output output references
```

See [../wear-active-editor/README.md](../wear-active-editor/README.md).

## Sanity checklist before first production use

- [ ] `npm run shopify:ping` succeeds
- [ ] `npm run sheets:info` sees the spreadsheet
- [ ] `.env` and service-account JSON are **not** staged in git (`git status`)
- [ ] Webhook deployed (or you accept weekly Admin pull only)
- [ ] You have read tax / recognition rules in BOOKS-SOP
