"""
Optional OCR engine for handwritten note recognition.

Integrates with Tesseract OCR (via pytesseract) to extract text from
rendered SVG/PNG images of reMarkable notebook pages and handwritten
annotations.

This module is entirely optional. The extraction pipeline works without it.
If Tesseract or pytesseract is not installed, all functions raise
ImportError with clear installation instructions.

Privacy: All OCR processing is local. No cloud OCR services are used.
"""

import io
import os
import sys
from dataclasses import dataclass
from typing import Optional

# Optional dependency: pytesseract
try:
    import pytesseract
    PYTESSERACT_AVAILABLE = True
except ImportError:
    pytesseract = None  # type: ignore[assignment]
    PYTESSERACT_AVAILABLE = False

# Optional dependency: PIL/Pillow for image loading
try:
    from PIL import Image
    PILLOW_AVAILABLE = True
except ImportError:
    Image = None  # type: ignore[assignment]
    PILLOW_AVAILABLE = False


# Tesseract default language
DEFAULT_LANG = "eng"

# Confidence threshold below which OCR text is considered unreliable
# and a warning is emitted (0-100 scale from Tesseract)
MIN_CONFIDENCE_THRESHOLD = 30


@dataclass
class OcrResult:
    """Result of OCR processing on a single image."""

    text: str
    confidence: float  # Average confidence 0-100, -1 if unavailable
    language: str
    warnings: list[str]


def is_ocr_available() -> bool:
    """
    Check whether the OCR engine is available.

    Returns True only if both pytesseract and Pillow are installed,
    and the Tesseract binary is reachable.
    """
    if not PYTESSERACT_AVAILABLE or not PILLOW_AVAILABLE:
        return False

    try:
        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


def get_ocr_status() -> dict:
    """
    Return a diagnostic dict describing OCR availability.

    Useful for the TypeScript bridge to report OCR status in settings.
    """
    status: dict = {
        "available": False,
        "pytesseract_installed": PYTESSERACT_AVAILABLE,
        "pillow_installed": PILLOW_AVAILABLE,
        "tesseract_binary_found": False,
        "tesseract_version": None,
        "error": None,
    }

    if not PYTESSERACT_AVAILABLE:
        status["error"] = "pytesseract not installed. Install with: pip install pytesseract"
        return status

    if not PILLOW_AVAILABLE:
        status["error"] = "Pillow not installed. Install with: pip install Pillow"
        return status

    try:
        version = pytesseract.get_tesseract_version()
        status["tesseract_binary_found"] = True
        status["tesseract_version"] = str(version)
        status["available"] = True
    except Exception as e:
        status["error"] = (
            f"Tesseract binary not found: {e}. "
            "Install Tesseract from https://github.com/tesseract-ocr/tesseract"
        )

    return status


def _ensure_ocr_deps() -> None:
    """Raise ImportError if OCR dependencies are missing."""
    if not PYTESSERACT_AVAILABLE:
        raise ImportError(
            "pytesseract is required for OCR. Install with: pip install pytesseract"
        )
    if not PILLOW_AVAILABLE:
        raise ImportError(
            "Pillow is required for OCR image loading. Install with: pip install Pillow"
        )


def ocr_image_file(
    image_path: str,
    lang: str = DEFAULT_LANG,
) -> OcrResult:
    """
    Run OCR on an image file (PNG, JPEG, TIFF, BMP).

    Args:
        image_path: Absolute path to the image file.
        lang: Tesseract language code (default: "eng").

    Returns:
        OcrResult with extracted text and confidence.

    Raises:
        ImportError: If OCR dependencies are not available.
        FileNotFoundError: If the image file does not exist.
        ValueError: If the image cannot be loaded.
    """
    _ensure_ocr_deps()

    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Image file not found: {image_path}")

    warnings: list[str] = []

    try:
        img = Image.open(image_path)
    except Exception as e:
        raise ValueError(f"Failed to load image: {e}") from e

    return _run_ocr(img, lang, warnings)


def ocr_image_bytes(
    image_data: bytes,
    lang: str = DEFAULT_LANG,
) -> OcrResult:
    """
    Run OCR on raw image bytes.

    Args:
        image_data: Raw image bytes (PNG, JPEG, etc.).
        lang: Tesseract language code.

    Returns:
        OcrResult with extracted text and confidence.
    """
    _ensure_ocr_deps()

    warnings: list[str] = []

    try:
        img = Image.open(io.BytesIO(image_data))
    except Exception as e:
        raise ValueError(f"Failed to decode image bytes: {e}") from e

    return _run_ocr(img, lang, warnings)


def ocr_svg_content(
    svg_content: str,
    lang: str = DEFAULT_LANG,
    dpi: int = 150,
) -> OcrResult:
    """
    Run OCR on SVG content by first rasterizing to PNG.

    Requires cairosvg for SVG-to-PNG conversion. If cairosvg is not
    available, falls back to returning an empty result with a warning.

    Args:
        svg_content: The SVG markup string.
        lang: Tesseract language code.
        dpi: Resolution for SVG rasterization (default: 150).

    Returns:
        OcrResult with extracted text and confidence.
    """
    _ensure_ocr_deps()

    warnings: list[str] = []

    try:
        import cairosvg
    except ImportError:
        return OcrResult(
            text="",
            confidence=-1,
            language=lang,
            warnings=[
                "cairosvg not installed; cannot rasterize SVG for OCR. "
                "Install with: pip install cairosvg"
            ],
        )

    try:
        png_bytes = cairosvg.svg2png(
            bytestring=svg_content.encode("utf-8"),
            dpi=dpi,
        )
    except Exception as e:
        return OcrResult(
            text="",
            confidence=-1,
            language=lang,
            warnings=[f"SVG rasterization failed: {e}"],
        )

    try:
        img = Image.open(io.BytesIO(png_bytes))
    except Exception as e:
        raise ValueError(f"Failed to load rasterized SVG: {e}") from e

    return _run_ocr(img, lang, warnings)


def _run_ocr(
    img: "Image.Image",
    lang: str,
    warnings: list[str],
) -> OcrResult:
    """
    Core OCR execution on a PIL Image.

    Uses pytesseract.image_to_data for word-level confidence scores,
    then assembles the full text.
    """
    # Convert to RGB if necessary (Tesseract works best with RGB)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    # Get word-level data with confidence scores
    try:
        data = pytesseract.image_to_data(
            img, lang=lang, output_type=pytesseract.Output.DICT
        )
    except Exception as e:
        return OcrResult(
            text="",
            confidence=-1,
            language=lang,
            warnings=[f"Tesseract OCR failed: {e}"],
        )

    # Assemble text from words with confidence filtering
    words: list[str] = []
    confidences: list[float] = []

    for i, word in enumerate(data["text"]):
        word = word.strip()
        if not word:
            continue

        conf = float(data["conf"][i])
        if conf < 0:
            # Tesseract returns -1 for non-text regions
            continue

        words.append(word)
        confidences.append(conf)

    text = " ".join(words)
    avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

    if avg_confidence < MIN_CONFIDENCE_THRESHOLD and text:
        warnings.append(
            f"Low OCR confidence ({avg_confidence:.1f}%); "
            "text may be inaccurate"
        )

    return OcrResult(
        text=text,
        confidence=avg_confidence,
        language=lang,
        warnings=warnings,
    )


def batch_ocr_images(
    image_paths: list[str],
    lang: str = DEFAULT_LANG,
) -> list[OcrResult]:
    """
    Run OCR on multiple image files.

    Processes each image independently; failures are captured per-image
    rather than halting the batch.

    Args:
        image_paths: List of absolute paths to image files.
        lang: Tesseract language code.

    Returns:
        List of OcrResult objects, one per input path (in the same order).
    """
    _ensure_ocr_deps()

    results: list[OcrResult] = []
    for img_path in image_paths:
        try:
            result = ocr_image_file(img_path, lang)
            results.append(result)
        except Exception as e:
            results.append(
                OcrResult(
                    text="",
                    confidence=-1,
                    language=lang,
                    warnings=[f"OCR failed for {os.path.basename(img_path)}: {e}"],
                )
            )

    return results
