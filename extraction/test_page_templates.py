"""
Tests for reMarkable page-template rendering:
  - the .content parser extracting per-page template names,
  - render_pages' template-name -> PNG resolver,
  - png_renderer compositing the template behind notebook strokes.
"""

import json
import os
import tempfile

import fitz  # PyMuPDF

from metadata_parser import parse_content_file
from render_pages import _load_template_map, _resolve_template_png
from png_renderer import render_strokes_to_png
from stroke_renderer import Stroke, StrokePoint


# --------------------------------------------------------------------------
# Parser: per-page template names
# --------------------------------------------------------------------------

def test_content_parser_extracts_per_page_templates():
    content = {
        "fileType": "",
        "cPages": {"pages": [
            {"id": "p1", "template": {"timestamp": "1:1", "value": "P Lines medium"}},
            {"id": "p2", "deleted": True, "template": {"value": "Grid"}},  # dropped
            {"id": "p3", "template": {"value": "Blank"}},
            {"id": "p4"},  # no template -> ""
        ]},
    }
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "doc.content")
        json.dump(content, open(p, "w"))
        c = parse_content_file(p)
    # Deleted page is skipped; templates stay aligned with kept page_uuids.
    assert c.page_uuids == ["p1", "p3", "p4"]
    assert c.page_templates == ["P Lines medium", "Blank", ""]


# --------------------------------------------------------------------------
# Resolver: template name -> PNG path
# --------------------------------------------------------------------------

def test_resolver_maps_name_to_png_and_skips_blank():
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, "P Lines medium.png"), "wb").close()
        json.dump({"templates": [{"name": "P Lines medium", "filename": "P Lines medium"}]},
                  open(os.path.join(d, "templates.json"), "w"))
        name_map = _load_template_map(d)
        assert name_map.get("P Lines medium") == "P Lines medium"
        # Known template resolves to its PNG.
        assert _resolve_template_png(d, "P Lines medium", name_map) == os.path.join(d, "P Lines medium.png")
        # "Blank" and empty never resolve.
        assert _resolve_template_png(d, "Blank", name_map) is None
        assert _resolve_template_png(d, "", name_map) is None
        # A template we don't have art for resolves to None.
        assert _resolve_template_png(d, "Dots large", name_map) is None
        # No templates dir -> None.
        assert _resolve_template_png(None, "P Lines medium", name_map) is None


# --------------------------------------------------------------------------
# Compositing: template drawn behind strokes
# --------------------------------------------------------------------------

def _one_stroke():
    pts = [StrokePoint(x=-50.0, y=200.0, width=2.0, pressure=0.6),
           StrokePoint(x=50.0, y=260.0, width=2.0, pressure=0.6)]
    return [Stroke(pen_type=2, color="black", stroke_width=2.0, points=pts)]


def _corner_pixel(path):
    pix = fitz.Pixmap(path)
    # near top-left, away from the centered stroke
    return tuple(pix.pixel(20, 20))


def test_template_composited_behind_strokes():
    with tempfile.TemporaryDirectory() as d:
        # A solid light-gray "template" so any background pixel is unambiguous.
        tmpl = os.path.join(d, "tmpl.png")
        gray = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 1404, 1872), False)
        gray.set_rect(gray.irect, (200, 200, 200))
        gray.save(tmpl)

        with_bg = os.path.join(d, "with.png")
        without_bg = os.path.join(d, "without.png")
        render_strokes_to_png(_one_stroke(), without_bg, pdf_path=None, coord_scale=1.0)
        render_strokes_to_png(_one_stroke(), with_bg, pdf_path=None, coord_scale=1.0,
                              background_png=tmpl)

        # Background corner: white without a template, gray with one.
        assert _corner_pixel(without_bg) == (255, 255, 255)
        assert _corner_pixel(with_bg) == (200, 200, 200)


def test_missing_template_falls_back_to_white():
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "out.png")
        render_strokes_to_png(_one_stroke(), out, pdf_path=None, coord_scale=1.0,
                              background_png=os.path.join(d, "does-not-exist.png"))
        assert _corner_pixel(out) == (255, 255, 255)
