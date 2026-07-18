"""
Tests for two features:
  1. Truncated height — short notebook pages crop their trailing blank space.
  2. OCR engine — degrades gracefully whether or not Tesseract is installed.
"""

import os
import tempfile

import fitz  # PyMuPDF; already a hard dependency of the renderer.

from constants import RM_SCREEN_HEIGHT
from png_renderer import (
    render_strokes_to_png,
    MIN_TRUNCATED_HEIGHT,
    TRUNCATE_HEIGHT_THRESHOLD,
)
from stroke_renderer import Stroke, StrokePoint
import ocr_engine


def _stroke(y0: float, y1: float) -> Stroke:
    """A simple black ballpoint stroke spanning a vertical range near center-x."""
    pts = [
        StrokePoint(x=-100.0, y=y0, width=2.0, pressure=0.6),
        StrokePoint(x=0.0, y=(y0 + y1) / 2, width=2.0, pressure=0.6),
        StrokePoint(x=100.0, y=y1, width=2.0, pressure=0.6),
    ]
    return Stroke(pen_type=2, color="black", stroke_width=2.0, points=pts)


def _render_height(strokes, truncate_blank: bool) -> int:
    """Render as a notebook page (no PDF background) and return the PNG height."""
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "page.png")
        render_strokes_to_png(
            strokes, out, pdf_path=None, coord_scale=1.0,
            truncate_blank=truncate_blank,
        )
        pix = fitz.Pixmap(out)
        return pix.height


# --------------------------------------------------------------------------
# Truncated height
# --------------------------------------------------------------------------

def test_short_page_is_cropped_when_truncation_on():
    # Content only in the top ~300px of a 1872px page -> should crop.
    strokes = [_stroke(100, 300)]
    height = _render_height(strokes, truncate_blank=True)
    assert height < RM_SCREEN_HEIGHT * TRUNCATE_HEIGHT_THRESHOLD
    # Cropped to just below the content, not the full page.
    assert 300 <= height <= 340


def test_short_page_is_full_height_when_truncation_off():
    # Same content, truncation disabled -> byte-compatible full-height render.
    strokes = [_stroke(100, 300)]
    assert _render_height(strokes, truncate_blank=False) == int(RM_SCREEN_HEIGHT)


def test_tall_page_is_not_cropped_even_with_truncation_on():
    # Content fills most of the page -> above the 50% threshold -> no crop.
    strokes = [_stroke(100, 1700)]
    assert _render_height(strokes, truncate_blank=True) == int(RM_SCREEN_HEIGHT)


def test_tiny_content_clamps_to_minimum_height():
    # A couple of words at the very top should not produce a sliver image.
    strokes = [_stroke(20, 50)]
    assert _render_height(strokes, truncate_blank=True) == MIN_TRUNCATED_HEIGHT


# --------------------------------------------------------------------------
# OCR engine graceful behavior
# --------------------------------------------------------------------------

def test_is_ocr_available_returns_bool_and_never_raises():
    assert isinstance(ocr_engine.is_ocr_available(), bool)


def test_get_ocr_status_reports_all_diagnostic_fields():
    status = ocr_engine.get_ocr_status()
    for key in (
        "available", "pytesseract_installed", "pillow_installed",
        "tesseract_binary_found", "tesseract_version", "error",
    ):
        assert key in status


def test_ocr_page_image_missing_file_returns_none():
    # Best-effort helper must never raise, even for a bogus path. A failure
    # (vs "ran and found nothing") is reported as None so callers can retry
    # on a later run instead of caching an empty answer.
    assert ocr_engine.ocr_page_image("/no/such/file.png") is None


def test_ocr_page_image_accepts_timeout_and_never_raises():
    # A per-page timeout must be accepted and, even on a bogus path, degrade to
    # None (failure) rather than raising.
    assert ocr_engine.ocr_page_image("/no/such/file.png", "eng", timeout_seconds=5) is None


def test_timeout_zero_sends_no_timeout_and_positive_is_forwarded(monkeypatch):
    # Contract: 0 (or negative) = unlimited, so _run_ocr must NOT hand a timeout
    # to tesseract in that case — independent of how pytesseract treats 0. A
    # positive budget must be forwarded verbatim. Monkeypatched so it runs with
    # no Tesseract binary present.
    if not ocr_engine.PYTESSERACT_AVAILABLE or not ocr_engine.PILLOW_AVAILABLE:
        return
    from PIL import Image

    empty = {"text": [], "conf": [], "block_num": [], "par_num": [], "line_num": []}
    captured = {}

    def fake_image_to_data(_img, **kwargs):
        captured.clear()
        captured.update(kwargs)
        return empty

    monkeypatch.setattr(ocr_engine.pytesseract, "image_to_data", fake_image_to_data)
    img = Image.new("RGB", (10, 10), "white")

    ocr_engine._run_ocr(img, "eng", [], timeout_seconds=0)
    assert "timeout" not in captured, "0 must mean unlimited (no timeout passed)"

    ocr_engine._run_ocr(img, "eng", [], timeout_seconds=7)
    assert captured.get("timeout") == 7


def test_tiny_ocr_timeout_yields_none_not_an_exception():
    # A near-zero budget should make tesseract time out; the helper swallows
    # the resulting error and reports failure as None so the page still
    # renders and OCR is retried on a later run. When Tesseract is
    # unavailable the result is also None — either way, never an exception.
    import tempfile
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return  # Pillow not installed in this environment; nothing to exercise.

    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "text.png")
        img = Image.new("RGB", (600, 140), "white")
        ImageDraw.Draw(img).text((10, 50), "hello world timeout test", fill=(0, 0, 0))
        img.save(p)
        result = ocr_engine.ocr_page_image(p, "eng", timeout_seconds=0.001)
        assert result is None or isinstance(result, str)
        if ocr_engine.is_ocr_available():
            # 0.001s is far below tesseract's timeout granularity -> it aborts.
            assert result is None
