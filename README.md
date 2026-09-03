# Wear Active Shopify AI

Internal operations toolkit for Wear Active. This repository connects Shopify,
Google Sheets, Apps Script, and an AI-assisted product photo workflow.

## What is included

- Shopify Admin GraphQL client and catalog/inventory utilities
- Google Sheets client and bookkeeping sync
- Ledger-driven Dashboard, Monthly P&L, and Analytics reports
- Shopify order webhook for the `Shopify Orders (LIVE)` sheet
- Bulk product photo editor powered by OpenAI image generation

## Repository layout

```text
.
├── apps-script/              # Shopify → Google Sheets webhook
├── docs/                     # Operating procedures
├── src/
│   ├── books/                # Recognition, tax, and reporting logic
│   ├── scripts/              # Operational command-line scripts
│   ├── sheets/               # Google Sheets client
│   └── shopify/              # Shopify Admin API client
└── wear-active-editor/       # Bulk product photo editor
```

The editor's source photos, generated images, virtual environment, API keys,
Node dependencies, and Google credentials remain local and are intentionally
excluded from Git.

## Requirements

- Node.js 18 or newer
- npm
- Python 3.10 or newer for the photo editor
- A Shopify app with Admin API access
- A Google Cloud service account with access to the accounting spreadsheet
- An OpenAI API key for AI photo editing

## Shopify and books setup

```bash
cp .env.example .env
npm ci
```

Fill `.env` with Shopify, Google Sheets, and optional Meta credentials. Place the
Google service-account file at the configured local path and share the target
spreadsheet with that service account as an Editor.

Useful commands:

```bash
npm run shopify:ping
npm run sheets:info
npm run books:sync
npm run books:sync:apply
```

`books:sync` is a dry run. `books:sync:apply` can update LIVE enrichment fields,
post newly recognized sales to the Ledger, and rebuild the reporting tabs.

See [docs/BOOKS-SOP.md](docs/BOOKS-SOP.md) for the accounting workflow, tax rules,
recognition rules, and report definitions.

## Shopify webhook

Deploy `apps-script/shopify-webhook.js` as a Google Apps Script web app, then add
the deployed URL to the relevant Shopify order webhooks. The webhook updates the
LIVE order pipeline; the Node books sync remains the source of truth for Ledger
posting and report rebuilding.

## Bulk photo editor

```bash
cd wear-active-editor
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python3 bulk_photo_editor.py --test
```

See [wear-active-editor/README.md](wear-active-editor/README.md) for folder usage,
production runs, and local-only WebP conversion.

## Security

Never commit `.env` files, Shopify credentials, OpenAI keys, Google service-account
JSON, customer data, source photography, or generated production assets. Rotate a
credential immediately if it is ever committed or shared outside the authorized
team.

## License

Private internal software. The package metadata currently declares ISC; confirm
licensing terms before distributing any part of this repository.
