#!/usr/bin/env python3

"""
Wear Active Bulk Product Photo Editor - V5

PRODUCTION PIPELINE

1. Read original TARGET image.
2. Use exactly ONE REFERENCE image.
3. Resize REFERENCE locally to reduce API input cost.
4. Send TARGET + REFERENCE to GPT-Image-2.
5. Save exact RAW GPT PNG to:

       gpt_output/

6. Convert the stored GPT PNG LOCALLY to WebP quality 95.
7. Save WebP to:

       webp_output/


IMPORTANT BEHAVIOR

- GPT output is preserved exactly as returned.
- GPT PNG is NEVER resized.
- GPT PNG is NEVER recompressed after receiving it.
- WebP conversion does NOT call OpenAI.
- WebP conversion does NOT resize.
- WebP conversion does NOT sharpen.
- WebP quality = 95.
- If GPT PNG already exists, GPT is NOT called again.
- If WebP is missing but GPT PNG exists, only local conversion occurs.
- Existing folder structure under input/ is preserved.
- Temporary filenames are collision-safe.
- Temporary files are automatically cleaned.
- Deterministic client/input errors are not retried.
- Rate-limit/server/connection errors are retried.
"""

import argparse
import base64
import hashlib
import os
import shutil
import sys
import time

from contextlib import ExitStack
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from PIL import (
    Image,
    ImageOps,
    UnidentifiedImageError,
)


# ============================================================
# CONFIGURATION
# ============================================================

#
# Lock the model snapshot so your ecommerce catalog
# gets more consistent behavior over time.
#
MODEL = "gpt-image-2-2026-04-21"


#
# GPT quality
#
FINAL_QUALITY = "high"
TEST_QUALITY = "medium"


#
# Preserve GPT output as lossless PNG.
#
GPT_OUTPUT_FORMAT = "png"


#
# Only ONE reference image.
#
MAX_REFERENCE_IMAGES = 1


#
# Reference image is used only for:
#
# - lighting
# - exposure
# - background
# - shadows
# - white balance
# - color grading
#
# Therefore it does not need to be full camera resolution.
#
REFERENCE_LONG_EDGE = 1024


#
# Final Shopify/WebP export.
#
WEBP_QUALITY = 95
WEBP_METHOD = 6


#
# API retry settings.
#
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 5


#
# Supported input formats.
#
SUPPORTED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
}


# ============================================================
# PATHS
# ============================================================

BASE_DIR = Path(__file__).resolve().parent

INPUT_DIR = (
    BASE_DIR
    / "input"
)

REFERENCE_DIR = (
    BASE_DIR
    / "references"
)

GPT_OUTPUT_DIR = (
    BASE_DIR
    / "gpt_output"
)

WEBP_OUTPUT_DIR = (
    BASE_DIR
    / "webp_output"
)

TEMP_DIR = (
    BASE_DIR
    / ".temp_images"
)

PROMPT_FILE = (
    BASE_DIR
    / "prompt.txt"
)

FAILED_LOG = (
    BASE_DIR
    / "failed.txt"
)


# ============================================================
# ARGUMENTS
# ============================================================

def parse_args():

    parser = argparse.ArgumentParser(
        description=(
            "Wear Active bulk ecommerce "
            "photo editor using GPT-Image-2."
        )
    )

    parser.add_argument(
        "--test",
        action="store_true",
        help=(
            "Use medium GPT quality "
            "for cheaper prompt testing."
        ),
    )

    parser.add_argument(
        "--convert-only",
        action="store_true",
        help=(
            "Do NOT call OpenAI. "
            "Convert existing GPT PNG files "
            "to WebP only."
        ),
    )

    return parser.parse_args()


# ============================================================
# DIRECTORY SETUP
# ============================================================

def ensure_directories():

    directories = [
        INPUT_DIR,
        REFERENCE_DIR,
        GPT_OUTPUT_DIR,
        WEBP_OUTPUT_DIR,
        TEMP_DIR,
    ]

    for directory in directories:

        directory.mkdir(
            parents=True,
            exist_ok=True,
        )


# ============================================================
# PROMPT
# ============================================================

def load_prompt() -> str:

    if not PROMPT_FILE.exists():

        raise FileNotFoundError(
            "Missing prompt.txt. "
            "Put prompt.txt next to "
            "bulk_photo_editor.py."
        )

    prompt = PROMPT_FILE.read_text(
        encoding="utf-8"
    ).strip()

    if not prompt:

        raise ValueError(
            "prompt.txt is empty."
        )

    return prompt


# ============================================================
# IMAGE DISCOVERY
# ============================================================

def get_images(folder: Path):

    if not folder.exists():

        return []

    images = []

    for path in folder.rglob("*"):

        if not path.is_file():

            continue

        if (
            path.suffix.lower()
            not in SUPPORTED_EXTENSIONS
        ):

            continue

        images.append(path)

    return sorted(
        images,
        key=lambda p: str(p).lower(),
    )


# ============================================================
# OUTPUT PATHS
# ============================================================

def gpt_output_path_for(
    source: Path,
) -> Path:

    relative = (
        source.relative_to(
            INPUT_DIR
        )
    )

    destination = (
        GPT_OUTPUT_DIR
        / relative
    )

    return destination.with_suffix(
        ".png"
    )


def webp_output_path_for(
    source: Path,
) -> Path:

    relative = (
        source.relative_to(
            INPUT_DIR
        )
    )

    destination = (
        WEBP_OUTPUT_DIR
        / relative
    )

    return destination.with_suffix(
        ".webp"
    )


def webp_output_path_for_gpt_png(
    gpt_png: Path,
) -> Path:

    relative = (
        gpt_png.relative_to(
            GPT_OUTPUT_DIR
        )
    )

    destination = (
        WEBP_OUTPUT_DIR
        / relative
    )

    return destination.with_suffix(
        ".webp"
    )


# ============================================================
# IMAGE VALIDATION
# ============================================================

def validate_image(
    path: Path,
):

    """
    Ensure Pillow can actually decode the file.

    This prevents corrupt files from reaching
    the OpenAI request.
    """

    try:

        with Image.open(path) as img:

            img.verify()

    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
    ) as exc:

        raise ValueError(
            f"Invalid/corrupt image: "
            f"{path.name}: {exc}"
        ) from exc


# ============================================================
# TEMP FILE NAMES
# ============================================================

def stable_temp_path(
    source: Path,
    prefix: str,
    suffix: str = ".png",
) -> Path:

    """

    Example:

    input/mens/HAM001.JPG
    input/womens/HAM001.JPG

    will receive different temporary
    filenames even though their base
    filename is identical.

    """

    full_path = str(
        source.resolve()
    )

    digest = hashlib.sha1(
        full_path.encode(
            "utf-8"
        )
    ).hexdigest()[:12]

    safe_stem = (
        source.stem
        .replace(" ", "_")
    )

    filename = (
        f"{prefix}_"
        f"{safe_stem}_"
        f"{digest}"
        f"{suffix}"
    )

    return (
        TEMP_DIR
        / filename
    )


# ============================================================
# TEMP CLEANUP
# ============================================================

def safe_unlink(
    path,
):

    if path is None:

        return

    try:

        Path(path).unlink(
            missing_ok=True
        )

    except OSError:

        pass


def clean_temp_directory():

    if not TEMP_DIR.exists():

        return

    for item in TEMP_DIR.iterdir():

        try:

            if item.is_file():

                item.unlink()

            elif item.is_dir():

                shutil.rmtree(
                    item
                )

        except OSError:

            pass


# ============================================================
# GPT OUTPUT SIZE
# ============================================================

def gpt_size_for_image(
    source: Path,
) -> str:

    """

    Request the largest normal GPT output
    for the source orientation.

    """

    with Image.open(
        source
    ) as img:

        img = (
            ImageOps.exif_transpose(
                img
            )
        )

        width, height = img.size

    ratio = (
        width
        / height
    )

    #
    # Square / near-square
    #
    if (
        0.90
        <= ratio
        <= 1.10
    ):

        return "1024x1024"

    #
    # Landscape
    #
    if width > height:

        return "1536x1024"

    #
    # Portrait
    #
    return "1024x1536"


# ============================================================
# IMAGE COLOR MODE NORMALIZATION
# ============================================================

def flatten_to_rgb(
    img: Image.Image,
) -> Image.Image:

    """

    Normalize visible image into RGB.

    Handles:

    - RGB
    - RGBA
    - LA
    - CMYK
    - grayscale
    - palette images

    """

    img = (
        ImageOps.exif_transpose(
            img
        )
    )

    if img.mode in (
        "RGBA",
        "LA",
    ):

        rgba = img.convert(
            "RGBA"
        )

        background = Image.new(
            "RGBA",
            rgba.size,
            (
                255,
                255,
                255,
                255,
            ),
        )

        background.alpha_composite(
            rgba
        )

        return background.convert(
            "RGB"
        )

    if img.mode != "RGB":

        return img.convert(
            "RGB"
        )

    return img


# ============================================================
# DETERMINE WHETHER ORIGINAL TARGET IS SAFE
# ============================================================

def can_send_original_target(
    source: Path,
) -> bool:

    """

    Avoid unnecessary target conversion.

    If the camera/source file is already a
    normal RGB JPEG, PNG or WebP, send the
    original file directly to OpenAI.

    Problematic files such as CMYK JPEGs
    are normalized first.

    """

    try:

        with Image.open(
            source
        ) as img:

            file_format = (
                img.format
                or ""
            ).upper()

            mode = img.mode

        safe_format = (
            file_format
            in {
                "JPEG",
                "PNG",
                "WEBP",
            }
        )

        safe_mode = (
            mode
            in {
                "RGB",
                "RGBA",
            }
        )

        return (
            safe_format
            and safe_mode
        )

    except Exception:

        return False


# ============================================================
# TARGET PREPARATION
# ============================================================

def prepare_target_for_api(
    source: Path,
):

    """

    Preferred behavior:

        ORIGINAL CAMERA IMAGE
                ↓
        OpenAI directly

    Conversion is only performed when the
    image format/mode requires normalization.

    Returns:

        (
            upload_path,
            is_temporary
        )

    """

    validate_image(
        source
    )

    if can_send_original_target(
        source
    ):

        return (
            source,
            False,
        )

    destination = (
        stable_temp_path(
            source,
            "target",
        )
    )

    with Image.open(
        source
    ) as img:

        img = flatten_to_rgb(
            img
        )

        img.save(
            destination,
            format="PNG",
            optimize=False,
        )

    return (
        destination,
        True,
    )


# ============================================================
# REFERENCE PREPARATION
# ============================================================

def prepare_reference_for_api(
    source: Path,
) -> Path:

    """

    Reference image is always prepared once
    locally because we intentionally reduce
    its resolution.

    It is NOT the product source.

    """

    validate_image(
        source
    )

    destination = (
        stable_temp_path(
            source,
            "reference",
        )
    )

    with Image.open(
        source
    ) as img:

        img = flatten_to_rgb(
            img
        )

        width, height = img.size

        long_edge = max(
            width,
            height,
        )

        if (
            long_edge
            > REFERENCE_LONG_EDGE
        ):

            scale = (
                REFERENCE_LONG_EDGE
                / long_edge
            )

            new_width = max(
                1,
                round(
                    width
                    * scale
                ),
            )

            new_height = max(
                1,
                round(
                    height
                    * scale
                ),
            )

            img = img.resize(
                (
                    new_width,
                    new_height,
                ),
                Image.Resampling.LANCZOS,
            )

        img.save(
            destination,
            format="PNG",
            optimize=False,
        )

    return destination


# ============================================================
# LOCAL WEBP CONVERSION
# ============================================================

def convert_png_to_webp(
    gpt_png: Path,
    destination: Path,
):

    """

    LOCAL ONLY.

    GPT PNG
       ↓
    WebP quality 95

    No resizing.
    No sharpening.
    No AI.
    No JPEG.
    No additional processing.

    """

    validate_image(
        gpt_png
    )

    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with Image.open(
        gpt_png
    ) as img:

        img = flatten_to_rgb(
            img
        )

        dimensions = img.size

        img.save(
            destination,
            format="WEBP",
            quality=WEBP_QUALITY,
            method=WEBP_METHOD,
        )

    return dimensions


# ============================================================
# API ERROR STATUS
# ============================================================

def status_code_from_exception(
    exc: Exception,
):

    status_code = getattr(
        exc,
        "status_code",
        None,
    )

    if status_code is not None:

        return status_code

    response = getattr(
        exc,
        "response",
        None,
    )

    if response is not None:

        return getattr(
            response,
            "status_code",
            None,
        )

    return None


# ============================================================
# RETRY DECISION
# ============================================================

def is_retryable_api_error(
    exc: Exception,
) -> bool:

    """

    RETRY:

    429
    500
    502
    503
    504
    timeout
    connection error

    DO NOT RETRY:

    invalid image
    unsupported image
    bad request
    normal 4xx failures

    """

    status_code = (
        status_code_from_exception(
            exc
        )
    )

    if status_code == 429:

        return True

    if (
        status_code is not None
        and 500
        <= status_code
        <= 599
    ):

        return True

    error_text = (
        str(exc)
        .lower()
    )

    transient_terms = [
        "timeout",
        "timed out",
        "connection error",
        "connection reset",
        "temporarily unavailable",
        "rate limit",
        "server error",
    ]

    return any(
        term in error_text
        for term
        in transient_terms
    )


# ============================================================
# REQUEST PROMPT
# ============================================================

def build_request_prompt(
    prompt: str,
) -> str:

    """

    prompt.txt contains the full detailed
    ecommerce rules.

    This wrapper reinforces image roles
    and fidelity.

    """

    return f"""
IMAGE ROLE INSTRUCTIONS

Image 1 is the TARGET photograph.

Image 2 is the REFERENCE photograph.

Edit the TARGET photograph.

The TARGET photograph is the SOURCE OF TRUTH for:

- product
- garment
- model
- pose
- body
- composition
- camera angle
- garment color
- garment construction
- logos
- text
- graphics
- stitching
- seams
- piping
- fabric texture
- pockets
- waistband
- hems
- cuffs
- all other product details

The REFERENCE photograph is ONLY a visual guide for:

- background
- studio lighting
- lighting softness
- exposure
- brightness
- shadows
- white balance
- contrast
- color grading
- overall studio appearance

Do NOT copy or substitute the model,
garment, pose, product, body,
composition, graphics, logos,
or product details from the
REFERENCE photograph.


MAXIMUM FIDELITY

This is a preservation-focused
professional ecommerce retouch.

It is NOT a creative image
reinterpretation.

Preserve as much authentic photographic
information from the TARGET photograph
as possible.

Do NOT unnecessarily regenerate,
redraw, repaint, reconstruct,
smooth or reinterpret areas that
do not require modification.

Preserve fine detail including:

- fabric texture
- fabric weave
- stitching
- seams
- piping
- logos
- text
- graphics
- waistband
- pockets
- hems
- cuffs
- garment edges
- skin texture
- hair detail
- shoes

Where an area does NOT require editing,
preserve it as faithfully as possible.


FULL EDITING INSTRUCTIONS

{prompt}
""".strip()


# ============================================================
# GPT EDIT REQUEST
# ============================================================

def edit_one_image(
    client,
    source: Path,
    reference_file: Path,
    prompt: str,
    quality: str,
):

    target_file = None

    target_is_temporary = False

    try:

        (
            target_file,
            target_is_temporary,
        ) = prepare_target_for_api(
            source
        )

        requested_size = (
            gpt_size_for_image(
                source
            )
        )

        request_prompt = (
            build_request_prompt(
                prompt
            )
        )

        with ExitStack() as stack:

            target_handle = (
                stack.enter_context(
                    open(
                        target_file,
                        "rb",
                    )
                )
            )

            reference_handle = (
                stack.enter_context(
                    open(
                        reference_file,
                        "rb",
                    )
                )
            )

            result = (
                client.images.edit(
                    model=MODEL,

                    image=[
                        target_handle,
                        reference_handle,
                    ],

                    prompt=(
                        request_prompt
                    ),

                    quality=quality,

                    size=(
                        requested_size
                    ),

                    output_format=(
                        GPT_OUTPUT_FORMAT
                    ),
                )
            )

        if (
            not result.data
            or
            not result.data[0].b64_json
        ):

            raise RuntimeError(
                "OpenAI returned "
                "no image data."
            )

        image_bytes = (
            base64.b64decode(
                result.data[
                    0
                ].b64_json
            )
        )

        return (
            image_bytes,
            requested_size,
        )

    finally:

        if target_is_temporary:

            safe_unlink(
                target_file
            )


# ============================================================
# ATOMIC SAVE
# ============================================================

def atomic_write_bytes(
    destination: Path,
    data: bytes,
):

    """

    Prevent incomplete PNG files
    if Python is interrupted while
    writing the result.

    """

    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    temporary = (
        destination.with_suffix(
            destination.suffix
            + ".part"
        )
    )

    temporary.write_bytes(
        data
    )

    temporary.replace(
        destination
    )


# ============================================================
# CONVERT ONLY
# ============================================================

def run_convert_only():

    gpt_images = (
        get_images(
            GPT_OUTPUT_DIR
        )
    )

    if not gpt_images:

        print(
            "\nNo GPT images found "
            "in gpt_output/."
        )

        return

    print(
        f"\nFound "
        f"{len(gpt_images)} "
        f"GPT image(s)."
    )

    converted = 0
    skipped = 0
    failed = 0

    for index, gpt_png in enumerate(
        gpt_images,
        start=1,
    ):

        destination = (
            webp_output_path_for_gpt_png(
                gpt_png
            )
        )

        print(
            f"\n[{index}/"
            f"{len(gpt_images)}] "
            f"{gpt_png.relative_to(GPT_OUTPUT_DIR)}"
        )

        if destination.exists():

            print(
                "  SKIP: "
                "WebP already exists."
            )

            skipped += 1

            continue

        try:

            dimensions = (
                convert_png_to_webp(
                    gpt_png,
                    destination,
                )
            )

            file_size_mb = (
                destination
                .stat()
                .st_size
                / (
                    1024
                    * 1024
                )
            )

            print(
                f"  Dimensions: "
                f"{dimensions[0]}x"
                f"{dimensions[1]}"
            )

            print(
                f"  WebP size: "
                f"{file_size_mb:.2f} MB"
            )

            print(
                f"  SAVED: "
                f"{destination.relative_to(BASE_DIR)}"
            )

            converted += 1

        except Exception as exc:

            print(
                f"  ERROR: "
                f"{exc}"
            )

            failed += 1

    print(
        "\n"
        + "=" * 64
    )

    print(
        "LOCAL WEBP CONVERSION COMPLETE"
    )

    print(
        f"Converted: {converted}"
    )

    print(
        f"Skipped:   {skipped}"
    )

    print(
        f"Failed:    {failed}"
    )


# ============================================================
# MAIN
# ============================================================

def main():

    args = parse_args()

    ensure_directories()

    #
    # Remove old temporary files
    # from interrupted executions.
    #
    clean_temp_directory()


    # --------------------------------------------------------
    # LOCAL CONVERSION ONLY
    # --------------------------------------------------------

    if args.convert_only:

        run_convert_only()

        return


    # --------------------------------------------------------
    # QUALITY MODE
    # --------------------------------------------------------

    quality = (
        TEST_QUALITY
        if args.test
        else FINAL_QUALITY
    )


    # --------------------------------------------------------
    # API KEY
    # --------------------------------------------------------

    load_dotenv()

    api_key = os.getenv(
        "OPENAI_API_KEY"
    )

    if not api_key:

        print(
            "\nERROR: "
            "OPENAI_API_KEY "
            "was not found."
        )

        print(
            "\nCreate a .env file "
            "next to the script:"
        )

        print(
            '\nOPENAI_API_KEY='
            '"your-key-here"'
        )

        sys.exit(1)


    # --------------------------------------------------------
    # PROMPT
    # --------------------------------------------------------

    prompt = load_prompt()


    # --------------------------------------------------------
    # INPUTS
    # --------------------------------------------------------

    inputs = get_images(
        INPUT_DIR
    )

    references = get_images(
        REFERENCE_DIR
    )


    if not inputs:

        print(
            "\nNo images found "
            "in input/."
        )

        sys.exit(0)


    if not references:

        print(
            "\nERROR: "
            "No reference image "
            "found in references/."
        )

        sys.exit(1)


    # --------------------------------------------------------
    # EXACTLY ONE REFERENCE
    # --------------------------------------------------------

    if len(references) > 1:

        print(
            "\nWARNING: "
            "More than one reference "
            "image was found."
        )

        print(
            "Only the first one "
            "will be used."
        )


    reference = (
        references[0]
    )


    try:

        reference_file = (
            prepare_reference_for_api(
                reference
            )
        )

    except Exception as exc:

        print(
            f"\nERROR preparing "
            f"reference image: "
            f"{exc}"
        )

        sys.exit(1)


    # --------------------------------------------------------
    # STARTUP SUMMARY
    # --------------------------------------------------------

    print(
        "\nUsing reference:"
    )

    print(
        f"  {reference.name}"
    )


    with Image.open(
        reference_file
    ) as ref_img:

        print(
            f"  API reference: "
            f"{ref_img.size[0]}x"
            f"{ref_img.size[1]}"
        )


    print(
        f"\nFound "
        f"{len(inputs)} "
        f"target image(s)."
    )

    print(
        f"Model: "
        f"{MODEL}"
    )

    print(
        f"Mode: "
        f"{'TEST' if args.test else 'FINAL'}"
    )

    print(
        f"GPT quality: "
        f"{quality}"
    )

    print(
        "GPT output: PNG"
    )

    print(
        f"WebP quality: "
        f"{WEBP_QUALITY}"
    )

    print(
        f"Reference max edge: "
        f"{REFERENCE_LONG_EDGE}px"
    )

    print(
        "-" * 64
    )


    # --------------------------------------------------------
    # CLIENT
    # --------------------------------------------------------

    client = OpenAI(
        api_key=api_key
    )


    api_generated = 0
    api_skipped = 0

    webp_created = 0
    webp_skipped = 0

    failures = []


    try:

        # ====================================================
        # PROCESS TARGETS
        # ====================================================

        for index, source in enumerate(
            inputs,
            start=1,
        ):

            gpt_destination = (
                gpt_output_path_for(
                    source
                )
            )

            webp_destination = (
                webp_output_path_for(
                    source
                )
            )


            print(
                f"\n[{index}/"
                f"{len(inputs)}] "
                f"{source.relative_to(INPUT_DIR)}"
            )


            # ------------------------------------------------
            # VALIDATE SOURCE
            # ------------------------------------------------

            try:

                validate_image(
                    source
                )

                with Image.open(
                    source
                ) as source_img:

                    corrected = (
                        ImageOps.exif_transpose(
                            source_img
                        )
                    )

                    print(
                        f"  Source: "
                        f"{corrected.size[0]}x"
                        f"{corrected.size[1]} "
                        f"mode={source_img.mode}"
                    )

            except Exception as exc:

                print(
                    f"  SOURCE ERROR: "
                    f"{exc}"
                )

                failures.append(
                    f"{source}"
                    f"\t"
                    f"SOURCE INVALID"
                )

                continue


            # =================================================
            # STEP 1
            #
            # RAW GPT PNG
            # =================================================

            if gpt_destination.exists():

                try:

                    validate_image(
                        gpt_destination
                    )

                    print(
                        "  GPT SKIP: "
                        "valid PNG "
                        "already exists."
                    )

                    api_skipped += 1

                except Exception:

                    print(
                        "  Existing GPT PNG "
                        "is invalid."
                    )

                    print(
                        "  Removing invalid "
                        "file."
                    )

                    safe_unlink(
                        gpt_destination
                    )


            # ------------------------------------------------
            # CALL GPT IF NEEDED
            # ------------------------------------------------

            if not gpt_destination.exists():

                success = False


                for attempt in range(
                    1,
                    MAX_RETRIES + 1,
                ):

                    try:

                        if attempt > 1:

                            wait_seconds = (
                                RETRY_DELAY_SECONDS
                                * attempt
                            )

                            print(
                                f"  Retry "
                                f"{attempt}/"
                                f"{MAX_RETRIES} "
                                f"after "
                                f"{wait_seconds}s..."
                            )

                            time.sleep(
                                wait_seconds
                            )


                        (
                            gpt_png_bytes,
                            requested_size,
                        ) = edit_one_image(
                            client=client,
                            source=source,
                            reference_file=(
                                reference_file
                            ),
                            prompt=prompt,
                            quality=quality,
                        )


                        # ------------------------------------
                        # SAVE EXACT RAW GPT BYTES
                        # ------------------------------------

                        atomic_write_bytes(
                            gpt_destination,
                            gpt_png_bytes,
                        )


                        # ------------------------------------
                        # VERIFY GPT OUTPUT
                        # ------------------------------------

                        validate_image(
                            gpt_destination
                        )


                        with Image.open(
                            gpt_destination
                        ) as gpt_img:

                            gpt_size = (
                                gpt_img.size
                            )


                        gpt_mb = (
                            gpt_destination
                            .stat()
                            .st_size
                            / (
                                1024
                                * 1024
                            )
                        )


                        print(
                            f"  GPT requested: "
                            f"{requested_size}"
                        )

                        print(
                            f"  GPT actual: "
                            f"{gpt_size[0]}x"
                            f"{gpt_size[1]}"
                        )

                        print(
                            f"  GPT PNG size: "
                            f"{gpt_mb:.2f} MB"
                        )

                        print(
                            f"  GPT SAVED: "
                            f"{gpt_destination.relative_to(BASE_DIR)}"
                        )


                        api_generated += 1

                        success = True

                        break


                    except Exception as exc:

                        status_code = (
                            status_code_from_exception(
                                exc
                            )
                        )

                        status_label = (
                            f" ({status_code})"
                            if status_code
                            else ""
                        )

                        print(
                            f"  GPT ERROR"
                            f"{status_label}: "
                            f"{exc}"
                        )


                        if not is_retryable_api_error(
                            exc
                        ):

                            print(
                                "  Not retrying: "
                                "error appears "
                                "deterministic."
                            )

                            break


                if not success:

                    failures.append(
                        f"{source}"
                        f"\t"
                        f"GPT FAILED"
                    )

                    print(
                        "  FAILED. "
                        "Moving to next image."
                    )

                    continue


            # =================================================
            # STEP 2
            #
            # LOCAL WEBP
            # =================================================

            if webp_destination.exists():

                try:

                    validate_image(
                        webp_destination
                    )

                    print(
                        "  WEBP SKIP: "
                        "valid WebP "
                        "already exists."
                    )

                    webp_skipped += 1

                    continue

                except Exception:

                    print(
                        "  Existing WebP "
                        "is invalid."
                    )

                    print(
                        "  Removing invalid "
                        "file."
                    )

                    safe_unlink(
                        webp_destination
                    )


            try:

                dimensions = (
                    convert_png_to_webp(
                        gpt_destination,
                        webp_destination,
                    )
                )


                webp_mb = (
                    webp_destination
                    .stat()
                    .st_size
                    / (
                        1024
                        * 1024
                    )
                )


                print(
                    f"  WEBP: "
                    f"{dimensions[0]}x"
                    f"{dimensions[1]}"
                )

                print(
                    f"  WEBP size: "
                    f"{webp_mb:.2f} MB"
                )

                print(
                    f"  WEBP SAVED: "
                    f"{webp_destination.relative_to(BASE_DIR)}"
                )


                webp_created += 1


            except Exception as exc:

                print(
                    f"  WEBP ERROR: "
                    f"{exc}"
                )

                failures.append(
                    f"{source}"
                    f"\t"
                    f"WEBP FAILED"
                )


    finally:

        #
        # Remove prepared reference copy.
        #
        safe_unlink(
            reference_file
        )

        #
        # Clean anything else.
        #
        clean_temp_directory()


    # ========================================================
    # FAILURE LOG
    # ========================================================

    if failures:

        FAILED_LOG.write_text(
            "\n".join(
                failures
            )
            + "\n",
            encoding="utf-8",
        )

    elif FAILED_LOG.exists():

        FAILED_LOG.unlink()


    # ========================================================
    # FINAL SUMMARY
    # ========================================================

    print(
        "\n"
        + "=" * 64
    )

    print(
        "DONE"
    )

    print(
        f"GPT generated: "
        f"{api_generated}"
    )

    print(
        f"GPT skipped:   "
        f"{api_skipped}"
    )

    print(
        f"WebP created:  "
        f"{webp_created}"
    )

    print(
        f"WebP skipped:  "
        f"{webp_skipped}"
    )

    print(
        f"Failed:        "
        f"{len(failures)}"
    )

    print(
        f"GPT masters:   "
        f"{GPT_OUTPUT_DIR}"
    )

    print(
        f"WebP files:    "
        f"{WEBP_OUTPUT_DIR}"
    )


    if failures:

        print(
            f"Failure log:   "
            f"{FAILED_LOG}"
        )


# ============================================================
# ENTRY
# ============================================================

if __name__ == "__main__":

    main()