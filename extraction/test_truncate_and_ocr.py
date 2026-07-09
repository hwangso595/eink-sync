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


def test_ocr_page_image_missing_file_returns_empty_string():
    # Best-effort helper must never raise, even for a bogus path.
    assert ocr_engine.ocr_page_image("/no/such/file.png") == ""
