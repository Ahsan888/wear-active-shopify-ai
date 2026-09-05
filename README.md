# Wear Active Shopify AI

Private monorepo for Wear Active operations: Shopify Admin tooling, Google Sheets
bookkeeping sync, order webhooks, and an AI-assisted bulk product photo editor.

## Why one repo (not two)

`wear-active-editor/` lives **inside** this repo on purpose:

| Approach | Verdict |
|---|---|
| **Monorepo (current)** | One clone, one private GitHub repo, shared brand context. Node books tools and the Python photo pipeline stay separate packages but ship together. |
| Separate repos | Extra access control and version drift for little gain on a small internal team. |

Keep media, API keys, and generated assets **out of Git** (already ignored). Only
source code, prompts, docs, and a small visual reference stay in the repo.

## What's included

| Area | Path | Role |
|---|---|---|
| Shopify Admin client | `src/shopify/` | GraphQL auth + catalog/inventory helpers |
| Google Sheets client | `src/sheets/` | Service-account access to WA Athleisure Stock |
| Books engine | `src/books/` + `src/scripts/books-*.js` | LIVE → Ledger → Dashboard / P&L / Analytics |
| Inventory / SKU ops | `src/scripts/` | Align SKUs, set stock, Variant Master helpers |
| Order webhook | `apps-script/shopify-webhook.js` | Shopify → `Shopify Orders (LIVE)` |
| Photo editor | `wear-active-editor/` | OpenAI image edit + local WebP conversion |
| Operating docs | `docs/` | Setup + books SOP |

## Quick start (Shopify + books)

```bash
git clone <YOUR_GITHUB_REPO_URL>
cd wear-active-shopify-ai
cp .env.example .env
npm ci
```

1. Fill `.env` (see [docs/SETUP.md](docs/SETUP.md)).
2. Place the Google service-account JSON at the path in `.env` (default
   `./google-service-account.json`) and share the spreadsheet with that account
   as Editor.
3. Smoke-test:

```bash
npm run shopify:ping
npm run sheets:info
npm run books:sync          # dry-run
npm run books:sync:apply    # post + rebuild reports
```

Full accounting workflow: [docs/BOOKS-SOP.md](docs/BOOKS-SOP.md).

## Quick start (photo editor)

```bash
cd wear-active-editor
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # add OPENAI_API_KEY
python3 bulk_photo_editor.py --test
```

Details: [wear-active-editor/README.md](wear-active-editor/README.md).

## Repository layout

```text
.
├── LICENSE
├── README.md                 # this file
├── package.json              # Node scripts for Shopify + Sheets
├── .env.example              # Shopify / Sheets / Meta placeholders
├── apps-script/
│   └── shopify-webhook.js    # deploy as Apps Script web app
├── docs/
│   ├── SETUP.md              # credentials & first-run checklist
│   └── BOOKS-SOP.md          # tax, recognition, weekly sync
├── src/
│   ├── books/                # recognition, tax, reports
│   ├── scripts/              # CLI entrypoints (npm run …)
│   ├── sheets/               # Google Sheets client
│   └── shopify/              # Shopify Admin GraphQL client
└── wear-active-editor/       # Python bulk photo pipeline
    ├── bulk_photo_editor.py
    ├── prompt.txt
    ├── requirements.txt
    ├── references/           # small committed style reference(s)
    └── README.md
```

Local-only under the editor (gitignored): `input/`, `photos/`, `gpt_output/`,
`webp_output/`, `output/`, `shopify/`, `.venv/`, `.env`.

## Useful npm scripts

| Script | Purpose |
|---|---|
| `shopify:ping` | Verify Admin API credentials |
| `sheets:info` | Verify Sheets access |
| `shopify:align-skus` | Align Shopify SKUs to Variant Master (`--apply` to write) |
| `books:sync` | Dry-run LIVE → Ledger + reports |
| `books:sync:apply` | Apply posting + rebuild Dashboard / P&L / Analytics |
| `books:hygiene` | Ledger date / category cleanup helpers |
| `books:archive` | Archive noisy sheet tabs |
| `bundles:setup` | Audit mix-and-match eligibility and automatic discounts (`--apply` to write) |
| `complete-look:setup` | Audit product recommendations (`--apply` to write metafields) |
| `packs:setup` | Audit native outfit/family packs (`--apply` creates or updates drafts) |
| `stock:low` | Dry-run: list variants with 1 unit left |
| `stock:low:send` | Email that low-stock report |
| `meta:check` | Verify Meta Ads token + ad account insights |
| `meta:report` | Campaign/adset/ad performance report (`--json` supported) |
| `meta:report:full` | Export detailed Meta report files under `reports/meta/` |
| `meta:test` | Pure-function tests for Meta metrics/CLI validation |
| `reports:merge` | Conservative Meta (+ optional Shopify) merge stub |
| `profitability:report` | Blended Meta + Books profitability (read-only) |
| `decisions:report` | Decision intelligence advisory report (read-only) |
| `decisions:test` | Pure-function tests for decision classifiers |
| `profitability:test` | Pure-function tests for no-double-count / reconcile |

Low-stock setup: [docs/LOW-STOCK-ALERTS.md](docs/LOW-STOCK-ALERTS.md).  
Meta Ads setup: [docs/META_SETUP.md](docs/META_SETUP.md).  
Profitability: [docs/PROFITABILITY_REPORTING.md](docs/PROFITABILITY_REPORTING.md).

Some `package.json` script names refer to one-off catalog scripts that may not
exist in every checkout; the books and client scripts above are the supported
surface.

## Shopify webhook

1. Copy `apps-script/shopify-webhook.js` into the spreadsheet’s Apps Script project.
2. Deploy as a **Web app** (execute as you, access: anyone).
3. In Shopify → Settings → Notifications → Webhooks, point:

| Event | URL suffix |
|---|---|
| Order creation | `?topic=orders_create` |
| Order updated | `?topic=orders_updated` |
| Order cancellation | `?topic=orders_cancelled` |

The webhook only updates LIVE. Ledger posting stays on `npm run books:sync:apply`.

## Security

**Do not commit:**

- `.env` / `.env.local`
- `google-service-account.json` or any `*-service-account.json`
- Shopify / Meta / OpenAI tokens
- Customer exports, source photography, or generated catalog assets

If a secret is ever pushed, rotate it immediately and scrub history before the
repo is shared further.

## License

Proprietary — see [LICENSE](LICENSE). Internal Wear Active use only.
