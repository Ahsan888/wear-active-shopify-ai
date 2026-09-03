# Wear Active Bulk Photo Editor

Bulk ecommerce photo processing for Wear Active using OpenAI image generation and
local WebP conversion.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Add your OpenAI API key to the local `.env` file.

## Working folders

| Folder | Purpose |
|---|---|
| `input/` | Original images selected for the next run |
| `references/` | Preferred visual reference image |
| `gpt_output/` | PNG master images returned by the model |
| `webp_output/` | Locally converted Shopify-ready WebP files |
| `.temp_images/` | Temporary processing files |

These working folders are local-only except `references/`; they are excluded from
Git to keep credentials, source photography, and large generated assets out of the
repository.

## Commands

Production-quality editing:

```bash
python3 bulk_photo_editor.py
```

Lower-cost prompt testing:

```bash
python3 bulk_photo_editor.py --test
```

Convert existing GPT PNG files to WebP without calling OpenAI:

```bash
python3 bulk_photo_editor.py --convert-only
```

Existing PNG output is reused, so rerunning the editor does not call the image API
again for files that are already complete. Missing WebP versions can be generated
locally from those PNG masters.
