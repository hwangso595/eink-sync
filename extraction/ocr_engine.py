"""
Optional OCR engine for handwritten note recognition.

Runs Tesseract locally (via pytesseract) over the page PNGs the renderer
produces, so handwritten notebook pages become searchable text under each
page image in Obsidian.

This module is entirely optional. The extraction/render pipeline works
without it. If Tesseract, pytesseract, or Pillow is missing, every function
degrades gracefully -- OCR text is simply omitted, never a crash.

Privacy: all OCR runs on this machine. No cloud OCR service is ever called,
consistent with the plugin's local-only design.
"""

import os
import sys
from dataclasses import dataclass, field
from typing import Optional

# Optional dependency: pytesseract (thin wrapper around the tesseract binary).
try:
    import pytesseract
    PYTESSERACT_AVAILABLE = True
except ImportError:
    pytesseract = None  # type: ignore[assignment]
    PYTESSERACT_AVAILABLE = False

# Optional dependency: Pillow, for loading the PNG the renderer wrote.
try:
    from PIL import Image
    PILLOW_AVAILABLE = True
except ImportError:
    Image = None  # type: ignore[assignment]
    PILLOW_AVAILABLE = False


# Default Tesseract language pack.
DEFAULT_LANG = "eng"

# Below this average word confidence (Tesseract's 0-100 scale) the text is
# flagged as low quality so callers can warn rather than trust it blindly.
MIN_CONFIDENCE_THRESHOLD = 30

# Standard locations the tesseract binary lands in per platform. pytesseract
# only searches PATH by default, and on Windows the UB-Mannheim installer does
# NOT add itself to PATH -- so a fresh install would look "missing" without this.
_WINDOWS_BINARY_CANDIDATES = (
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
)
_UNIX_BINARY_CANDIDATES = (
    "/usr/bin/tesseract",
    "/usr/local/bin/tesseract",
    "/opt/homebrew/bin/tesseract",
)


@dataclass
class OcrResult:
    """Outcome of OCR on a single image."""

    text: str
    confidence: float  # Average word confidence 0-100, -1 when unavailable.
    language: str
    warnings: list = field(default_factory=list)


def _resolve_tesseract_cmd() -> Optional[str]:
    """
    Point pytesseract at a tesseract binary it can actually run.

    Order: an explicit TESSERACT_CMD override, then the platform's standard
    install locations. Returns the resolved path, or None to let pytesseract
    fall back to its own PATH lookup.
    """
    override = os.environ.get("TESSERACT_CMD")
    if override and os.path.exists(override):
        return override

    candidates = _WINDOWS_BINARY_CANDIDATES if os.name == "nt" else _UNIX_BINARY_CANDIDATES
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return None


def _apply_tesseract_cmd() -> None:
    """Set pytesseract's binary path if we can find one outside PATH."""
    if not PYTESSERACT_AVAILABLE:
        return
    resolved = _resolve_tesseract_cmd()
    if resolved:
        pytesseract.pytesseract.tesseract_cmd = resolved


def is_ocr_available() -> bool:
    """
    True only when pytesseract, Pillow, and a runnable tesseract binary are
    all present. Cheap enough to call before every batch.
    """
    if not PYTESSERACT_AVAILABLE or not PILLOW_AVAILABLE:
        return False
    _apply_tesseract_cmd()
    try:
        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


def get_ocr_status() -> dict:
    """
    Diagnostic snapshot of OCR availability, for the settings/status UI to
    explain exactly what (if anything) is missing.
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

    _apply_tesseract_cmd()
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


def ocr_image_file(
    image_path: str,
    lang: str = DEFAULT_LANG,
    timeout_seconds: float = 0,
) -> OcrResult:
    """
    OCR a single image file (PNG, JPEG, TIFF, BMP).

    Raises ImportError if OCR deps are missing and FileNotFoundError if the
    image is absent; a tesseract failure is captured as a warning instead.
    timeout_seconds caps the tesseract run for this image (0 = no limit).
    """
    if not PYTESSERACT_AVAILABLE:
        raise ImportError(
            "pytesseract is required for OCR. Install with: pip install pytesseract"
        )
    if not PILLOW_AVAILABLE:
        raise ImportError(
            "Pillow is required for OCR image loading. Install with: pip install Pillow"
        )
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Image file not found: {image_path}")

    _apply_tesseract_cmd()
    try:
        img = Image.open(image_path)
    except Exception as e:
        raise ValueError(f"Failed to load image: {e}") from e

    return _run_ocr(img, lang, [], timeout_seconds)


def _run_ocr(
    img: "Image.Image",
    lang: str,
    warnings: list,
    timeout_seconds: float = 0,
) -> OcrResult:
    """Core OCR pass: word-level data, confidence filtering, text assembly.

    timeout_seconds bounds the tesseract run (0 = unlimited). On timeout,
    pytesseract raises, which is caught here and yields empty text — a slow
    page loses its OCR text but never blocks the surrounding render.
    """
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    # Only pass a timeout when one is actually requested. Treating 0 (or a
    # negative) as "no limit" here keeps the documented semantics independent of
    # how pytesseract happens to interpret timeout=0.
    ocr_kwargs = {"lang": lang, "output_type": pytesseract.Output.DICT}
    if timeout_seconds and timeout_seconds > 0:
        ocr_kwargs["timeout"] = timeout_seconds
    try:
        data = pytesseract.image_to_data(img, **ocr_kwargs)
    except Exception as e:
        return OcrResult(text="", confidence=-1, language=lang,
                         warnings=[f"Tesseract OCR failed: {e}"])

    # Rebuild text line by line so multi-line handwriting keeps its line breaks
    # (image_to_data groups words by block/paragraph/line number).
    lines: dict = {}
    confidences: list = []
    for i, raw_word in enumerate(data["text"]):
        word = raw_word.strip()
        if not word:
            continue
        conf = float(data["conf"][i])
        if conf < 0:  # tesseract marks non-text regions as -1
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, []).append(word)
        confidences.append(conf)

    text = "\n".join(" ".join(words) for _, words in sorted(lines.items()))
    avg_conf = sum(confidences) / len(confidences) if confidences else 0.0

    warnings = list(warnings)
    if text and avg_conf < MIN_CONFIDENCE_THRESHOLD:
        warnings.append(
            f"Low OCR confidence ({avg_conf:.1f}%); handwriting text may be inaccurate"
        )

    return OcrResult(text=text, confidence=avg_conf, language=lang, warnings=warnings)


def ocr_page_image(
    image_path: str,
    lang: str = DEFAULT_LANG,
    timeout_seconds: float = 0,
):
    """
    Best-effort OCR for the render pipeline. Never raises, so a missing
    binary, a slow page (see timeout_seconds), or an odd image can't take
    down an extraction run — the page's drawing still renders.

    Returns the recognized text ("" when OCR ran but found none), or None
    when OCR *failed* (Tesseract error or per-page timeout) — callers cache
    "" as a final answer but retry None on a later run.
    """
    try:
        result = ocr_image_file(image_path, lang, timeout_seconds)
        if result.confidence < 0:  # Tesseract error, incl. timeout
            print(f"OCR failed for {os.path.basename(image_path)}: "
                  f"{'; '.join(result.warnings)}",
                  file=sys.stderr, flush=True)
            return None
        return result.text
    except Exception as e:
        print(f"OCR skipped for {os.path.basename(image_path)}: {e}",
              file=sys.stderr, flush=True)
        return None


if __name__ == "__main__":
    # `python ocr_engine.py --status` lets the TS bridge probe availability.
    if "--status" in sys.argv:
        import json
        print(json.dumps(get_ocr_status()))
    elif len(sys.argv) > 1:
        print(ocr_page_image(sys.argv[1]))
