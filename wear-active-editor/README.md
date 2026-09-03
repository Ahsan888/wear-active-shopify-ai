# Wear Active Bulk Photo Editor

Python pipeline for Wear Active ecommerce photos: OpenAI image generation plus
local WebP conversion. This folder is part of the **wear-active-shopify-ai**
monorepo (not a separate GitHub repository).

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Put your OpenAI API key in `.env`:

```bash
OPENAI_API_KEY=sk-...
```

Create working folders (gitignored except `references/`):

```bash
mkdir -p input photos gpt_output webp_output output .temp_images
```

## Working folders

| Folder | In Git? | Purpose |
|---|---|---|
| `input/` | No | Originals for the next run |
| `photos/` | No | Source library |
| `references/` | Yes (small) | Style reference image(s) |
| `gpt_output/` | No | Lossless PNG masters from the model |
| `webp_output/` | No | Shopify-ready WebP (local conversion) |
| `output/` / `output-done/` | No | Local staging |
| `shopify/` | No | Upload staging |
| `.venv/` | No | Python virtualenv |
| `.temp_images/` | No | Scratch files |

Large photography and generated assets stay on disk only so the GitHub repo
stays small and free of customer/product imagery.

## Commands

Production-quality editing:

```bash
python3 bulk_photo_editor.py
```

Lower-cost prompt testing:

```bash
python3 bulk_photo_editor.py --test
```

Convert existing GPT PNGs to WebP without calling OpenAI:

```bash
python3 bulk_photo_editor.py --convert-only
```

If a GPT PNG already exists for a file, the editor skips the API call and only
fills missing WebPs locally.

## Files committed here

- `bulk_photo_editor.py` — pipeline
- `prompt.txt` — model instructions
- `requirements.txt` — Python deps
- `references/` — small reference image(s)
- `.env.example` — key placeholder

## Security

Never commit `.env`, API keys, or production photo libraries. Rotate the OpenAI
key if it is ever exposed.
