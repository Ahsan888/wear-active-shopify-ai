Wear Active Bulk Photo Editor V4
=================================

FOLDERS

input/
    Original camera/source images.

references/
    Put ONE preferred reference image here.

gpt_output/
    Exact PNG image returned by GPT.
    This is your AI master output.

webp_output/
    Locally converted WebP files for Shopify.


NORMAL FINAL RUN

    python3 bulk_photo_editor.py

Uses GPT high quality.


CHEAPER TEST RUN

    python3 bulk_photo_editor.py --test

Uses GPT medium quality.


LOCAL CONVERSION ONLY

    python3 bulk_photo_editor.py --convert-only

This NEVER calls OpenAI.
It converts existing gpt_output PNGs into WebP files.


IMPORTANT COST BEHAVIOR

If:
    gpt_output/HAM02244.png

already exists, the script will NOT call GPT again.

If:
    webp_output/HAM02244.webp

is missing, it will simply create it locally from the stored GPT PNG.


WEBP SETTINGS

Quality: 95
Compression method: 6

The WebP keeps the exact same dimensions as the GPT PNG.
There is no resizing or sharpening in the WebP conversion step.
