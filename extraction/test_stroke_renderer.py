"""
Tests for stroke_renderer.py -- SVG rendering of reMarkable pen strokes.

Tests cover:
- Stroke-to-SVG-path conversion (line segments, Bezier curves, single points)
- Color and width preservation
- Highlighter opacity
- Eraser exclusion
- SVG structure (viewBox, background, namespaces)
- Legacy v3/v5 binary parsing for all-stroke extraction
- Format auto-detection routing
- PDF overlay mode (transparent background)
"""

import struct
import tempfile
import os
import xml.etree.ElementTree as ET

import pytest

from stroke_renderer import (
    StrokePoint,
    Stroke,
    render_strokes_to_svg,
    extract_strokes_legacy,
    detect_rm_format,
    extract_strokes,
    _stroke_to_svg_path,
    _average_width,
    COLOR_TO_HEX,
    RM_SCREEN_WIDTH,
    RM_SCREEN_HEIGHT,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_stroke(
    pen_type: int = 2,
    color: str = "black",
    width: float = 1.0,
    points: list[tuple[float, float]] | None = None,
) -> Stroke:
    """Create a test stroke with simple (x, y) points."""
    pts = points or [(100, 100), (200, 200), (300, 100)]
    return Stroke(
        pen_type=pen_type,
        color=color,
        stroke_width=width,
        points=[StrokePoint(x=x, y=y, width=1.0) for x, y in pts],
    )


def _build_legacy_v5_file(strokes_data: list[dict]) -> bytes:
    """
    Build a minimal v5 .rm binary file for testing.

    strokes_data is a list of dicts with keys:
      pen_type, color_id, stroke_width, points [(x, y, speed, dir, width, pressure), ...]
    """
    header = b"reMarkable .lines file, version=5" + b"\x00" * (48 - 33)
    body = b""

    # 1 layer
    body += struct.pack("<i", 1)
    # N strokes
    body += struct.pack("<i", len(strokes_data))

    for s in strokes_data:
        body += struct.pack("<iii", s["pen_type"], s.get("color_id", 0), 0)
        body += struct.pack("<f", s.get("stroke_width", 1.0))
        body += struct.pack("<i", 0)  # unknown_2 (v5)
        pts = s.get("points", [])
        body += struct.pack("<i", len(pts))
        for pt in pts:
            body += struct.pack("<ffffff", *pt)

    return header + body


def _write_temp_rm(data: bytes) -> str:
    """Write data to a temp .rm file and return its path. Caller must clean up."""
    fd, path = tempfile.mkstemp(suffix=".rm")
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    return path


# ---------------------------------------------------------------------------
# SVG path generation
# ---------------------------------------------------------------------------

class TestStrokeToSvgPath:
    def test_empty_stroke(self):
        stroke = Stroke(pen_type=2, color="black", stroke_width=1.0, points=[])
        assert _stroke_to_svg_path(stroke) == ""

    def test_single_point(self):
        stroke = _make_stroke(points=[(50, 75)])
        path = _stroke_to_svg_path(stroke)
        assert path.startswith("M 50.00 75.00")
        assert "l 0.01 0" in path

    def test_two_points_line(self):
        stroke = _make_stroke(points=[(10, 20), (30, 40)])
        path = _stroke_to_svg_path(stroke)
        assert "M 10.00 20.00" in path
        assert "L 30.00 40.00" in path

    def test_multiple_points_bezier(self):
        stroke = _make_stroke(points=[(0, 0), (50, 100), (100, 0), (150, 100)])
        path = _stroke_to_svg_path(stroke)
        assert "M 0.00 0.00" in path
        assert "Q" in path  # Bezier curves
        assert "L 150.00 100.00" in path  # Ends at last point


class TestAverageWidth:
    def test_with_points(self):
        stroke = _make_stroke(width=2.0)
        avg = _average_width(stroke)
        # Points have width=1.0, stroke_width=2.0
        # avg=1.0, scaled=1.0/20.0*2.0=0.1, clamped to min 0.5
        assert avg == pytest.approx(0.5, abs=0.1)

    def test_no_points(self):
        stroke = Stroke(pen_type=2, color="black", stroke_width=3.0, points=[])
        assert _average_width(stroke) == 3.0

    def test_minimum_width(self):
        """Width should not go below 0.5."""
        stroke = Stroke(
            pen_type=2, color="black", stroke_width=0.01,
            points=[StrokePoint(x=0, y=0, width=0.01)],
        )
        assert _average_width(stroke) >= 0.5


# ---------------------------------------------------------------------------
# SVG rendering
# ---------------------------------------------------------------------------

class TestRenderStrokesToSvg:
    def test_empty_strokes_with_background(self):
        svg = render_strokes_to_svg([], transparent_bg=False)
        root = ET.fromstring(svg)
        assert root.tag.endswith("svg")
        # viewBox uses float formatting: "0.0 0.0 1404.0 1872.0"
        vb = root.get("viewBox", "")
        parts = [float(x) for x in vb.split()]
        assert parts == pytest.approx([0.0, 0.0, RM_SCREEN_WIDTH, RM_SCREEN_HEIGHT])
        # Should have a background rect
        rects = root.findall(".//{http://www.w3.org/2000/svg}rect")
        assert len(rects) == 1

    def test_transparent_background(self):
        svg = render_strokes_to_svg([], transparent_bg=True)
        root = ET.fromstring(svg)
        rects = root.findall(".//{http://www.w3.org/2000/svg}rect")
        assert len(rects) == 0

    def test_stroke_color_preserved(self):
        stroke = _make_stroke(color="red")
        svg = render_strokes_to_svg([stroke])
        root = ET.fromstring(svg)
        paths = root.findall(".//{http://www.w3.org/2000/svg}path")
        assert len(paths) == 1
        assert paths[0].get("stroke") == COLOR_TO_HEX["red"]

    def test_highlighter_opacity(self):
        stroke = _make_stroke(pen_type=5, color="yellow")  # highlighter
        svg = render_strokes_to_svg([stroke])
        root = ET.fromstring(svg)
        paths = root.findall(".//{http://www.w3.org/2000/svg}path")
        assert len(paths) == 1
        assert paths[0].get("opacity") == "0.35"

    def test_eraser_excluded(self):
        eraser = _make_stroke(pen_type=6, color="white")
        normal = _make_stroke(pen_type=2, color="black")
        svg = render_strokes_to_svg([eraser, normal])
        root = ET.fromstring(svg)
        paths = root.findall(".//{http://www.w3.org/2000/svg}path")
        assert len(paths) == 1  # Only the normal stroke

    def test_multiple_strokes(self):
        s1 = _make_stroke(color="black", points=[(0, 0), (100, 100)])
        s2 = _make_stroke(color="blue", points=[(200, 200), (300, 300)])
        svg = render_strokes_to_svg([s1, s2])
        root = ET.fromstring(svg)
        paths = root.findall(".//{http://www.w3.org/2000/svg}path")
        assert len(paths) == 2

    def test_custom_dimensions(self):
        # width/height params are ignored (kept for API compat);
        # viewBox is auto-computed from stroke bounds, defaulting to RM screen.
        svg = render_strokes_to_svg([], width=800, height=600)
        root = ET.fromstring(svg)
        vb = root.get("viewBox", "")
        parts = [float(x) for x in vb.split()]
        assert parts == pytest.approx([0.0, 0.0, RM_SCREEN_WIDTH, RM_SCREEN_HEIGHT])


# ---------------------------------------------------------------------------
# Legacy v3/v5 extraction
# ---------------------------------------------------------------------------

class TestExtractStrokesLegacy:
    def test_single_stroke(self):
        data = _build_legacy_v5_file([{
            "pen_type": 2,
            "color_id": 0,
            "stroke_width": 1.5,
            "points": [
                (100.0, 200.0, 0.5, 0.0, 1.0, 0.5),
                (150.0, 250.0, 0.5, 0.0, 1.0, 0.5),
            ],
        }])
        path = _write_temp_rm(data)
        try:
            strokes = extract_strokes_legacy(path)
            assert len(strokes) == 1
            assert strokes[0].pen_type == 2
            assert strokes[0].color == "black"
            assert len(strokes[0].points) == 2
            assert strokes[0].points[0].x == pytest.approx(100.0)
        finally:
            os.unlink(path)

    def test_eraser_skipped(self):
        data = _build_legacy_v5_file([
            {
                "pen_type": 6,  # eraser
                "color_id": 0,
                "stroke_width": 5.0,
                "points": [(100.0, 200.0, 0.5, 0.0, 1.0, 0.5)],
            },
            {
                "pen_type": 2,  # ballpoint
                "color_id": 0,
                "stroke_width": 1.0,
                "points": [(100.0, 200.0, 0.5, 0.0, 1.0, 0.5)],
            },
        ])
        path = _write_temp_rm(data)
        try:
            strokes = extract_strokes_legacy(path)
            assert len(strokes) == 1
            assert strokes[0].pen_type == 2
        finally:
            os.unlink(path)

    def test_multiple_colors(self):
        data = _build_legacy_v5_file([
            {
                "pen_type": 2,
                "color_id": 0,  # black
                "stroke_width": 1.0,
                "points": [(10.0, 20.0, 0.0, 0.0, 1.0, 0.5)],
            },
            {
                "pen_type": 2,
                "color_id": 6,  # blue
                "stroke_width": 1.0,
                "points": [(30.0, 40.0, 0.0, 0.0, 1.0, 0.5)],
            },
        ])
        path = _write_temp_rm(data)
        try:
            strokes = extract_strokes_legacy(path)
            assert len(strokes) == 2
            assert strokes[0].color == "black"
            assert strokes[1].color == "blue"
        finally:
            os.unlink(path)

    def test_invalid_file_raises(self):
        path = _write_temp_rm(b"not a valid rm file at all")
        try:
            with pytest.raises(ValueError):
                extract_strokes_legacy(path)
        finally:
            os.unlink(path)

    def test_highlighter_included(self):
        """Highlighter strokes should be included (unlike highlight-only parser)."""
        data = _build_legacy_v5_file([{
            "pen_type": 5,  # highlighter
            "color_id": 3,  # yellow
            "stroke_width": 15.0,
            "points": [(100.0, 200.0, 0.5, 0.0, 1.0, 0.5)],
        }])
        path = _write_temp_rm(data)
        try:
            strokes = extract_strokes_legacy(path)
            assert len(strokes) == 1
            assert strokes[0].is_highlighter
            assert strokes[0].color == "yellow"
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# Format auto-detection
# ---------------------------------------------------------------------------

class TestDetectRmFormat:
    def test_v6(self):
        path = _write_temp_rm(b"reMarkable .lines file, version=6" + b"\x00" * 30)
        try:
            assert detect_rm_format(path) == "v6"
        finally:
            os.unlink(path)

    def test_v5(self):
        path = _write_temp_rm(b"reMarkable .lines file, version=5" + b"\x00" * 30)
        try:
            assert detect_rm_format(path) == "v5"
        finally:
            os.unlink(path)

    def test_v3(self):
        path = _write_temp_rm(b"reMarkable .lines file, version=3" + b"\x00" * 30)
        try:
            assert detect_rm_format(path) == "v3"
        finally:
            os.unlink(path)

    def test_unknown(self):
        path = _write_temp_rm(b"something else entirely")
        try:
            assert detect_rm_format(path) == "unknown"
        finally:
            os.unlink(path)

    def test_missing_file(self):
        assert detect_rm_format("/nonexistent/path.rm") == "unknown"


# ---------------------------------------------------------------------------
# Auto-detection routing (extract_strokes)
# ---------------------------------------------------------------------------

class TestExtractStrokes:
    def test_routes_to_legacy(self):
        data = _build_legacy_v5_file([{
            "pen_type": 2,
            "color_id": 0,
            "stroke_width": 1.0,
            "points": [(10.0, 20.0, 0.0, 0.0, 1.0, 0.5)],
        }])
        path = _write_temp_rm(data)
        try:
            strokes = extract_strokes(path)
            assert len(strokes) == 1
        finally:
            os.unlink(path)

    def test_unknown_format_raises(self):
        path = _write_temp_rm(b"garbage data here")
        try:
            with pytest.raises(ValueError, match="Unsupported .rm format"):
                extract_strokes(path)
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# End-to-end: legacy file -> SVG
# ---------------------------------------------------------------------------

class TestEndToEndLegacyToSvg:
    def test_renders_valid_svg(self):
        data = _build_legacy_v5_file([
            {
                "pen_type": 2,
                "color_id": 0,
                "stroke_width": 1.5,
                "points": [
                    (100.0, 200.0, 0.5, 0.0, 1.0, 0.5),
                    (200.0, 300.0, 0.5, 0.0, 1.2, 0.6),
                    (300.0, 200.0, 0.5, 0.0, 0.8, 0.4),
                ],
            },
            {
                "pen_type": 5,
                "color_id": 3,
                "stroke_width": 15.0,
                "points": [
                    (400.0, 500.0, 0.0, 0.0, 15.0, 0.5),
                    (600.0, 500.0, 0.0, 0.0, 15.0, 0.5),
                ],
            },
        ])
        path = _write_temp_rm(data)
        try:
            strokes = extract_strokes(path)
            svg = render_strokes_to_svg(strokes)

            # Validate SVG structure
            root = ET.fromstring(svg)
            paths = root.findall(".//{http://www.w3.org/2000/svg}path")
            assert len(paths) == 2

            # First path: black ballpoint
            assert paths[0].get("stroke") == COLOR_TO_HEX["black"]
            assert paths[0].get("opacity") is None

            # Second path: yellow highlighter with opacity
            assert paths[1].get("stroke") == COLOR_TO_HEX["yellow"]
            assert paths[1].get("opacity") == "0.35"
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# Regression tests
# ---------------------------------------------------------------------------


class TestEraserHandlingRegression:
    """Regression: Eraser strokes (pen_type 6 and 8) must be excluded from
    renderings. Previously, eraser strokes were rendered as visible white
    paths which obscured actual content.
    """

    def test_eraser_type_6_excluded_from_svg(self):
        """Regression: Eraser type 6 strokes should not appear in SVG output."""
        eraser = _make_stroke(pen_type=6, color="white")
        svg = render_strokes_to_svg([eraser])
        root = ET.fromstring(svg)
        paths = root.findall(".//{http://www.w3.org/2000/svg}path")
        assert len(paths) == 0, "Eraser type 6 should produce no SVG paths"

    def test_eraser_type_8_excluded_from_svg(self):
        """Regression: Eraser-area type 8 strokes should not appear in SVG output."""
        eraser = _make_stroke(pen_type=8, color="white")
        svg = render_strokes_to_svg([eraser])
        root = ET.fromstring(svg)
        paths = root.findall(".//{http://www.w3.org/2000/svg}path")
        assert len(paths) == 0, "Eraser type 8 should produce no SVG paths"

    def test_eraser_excluded_from_legacy_extraction(self):
        """Regression: Erasers should be excluded from legacy v5 extraction."""
        data = _build_legacy_v5_file([
            {
                "pen_type": 6,  # eraser
                "color_id": 2,  # white
                "stroke_width": 10.0,
                "points": [
                    (100.0, 100.0, 0.0, 0.0, 5.0, 0.5),
                    (200.0, 200.0, 0.0, 0.0, 5.0, 0.5),
                ],
            },
            {
                "pen_type": 8,  # erase area
                "color_id": 2,
                "stroke_width": 20.0,
                "points": [
                    (300.0, 300.0, 0.0, 0.0, 10.0, 0.5),
                    (400.0, 400.0, 0.0, 0.0, 10.0, 0.5),
                ],
            },
        ])
        path = _write_temp_rm(data)
        try:
            strokes = extract_strokes_legacy(path)
            assert len(strokes) == 0, "Both eraser types should be excluded from extraction"
        finally:
            os.unlink(path)

    def test_eraser_is_eraser_property(self):
        """Regression: Stroke.is_eraser should be True for pen_type 6 and 8."""
        eraser_6 = Stroke(pen_type=6, color="white", stroke_width=5.0)
        eraser_8 = Stroke(pen_type=8, color="white", stroke_width=5.0)
        normal = Stroke(pen_type=2, color="black", stroke_width=1.0)

        assert eraser_6.is_eraser is True
        assert eraser_8.is_eraser is True
        assert normal.is_eraser is False

    def test_eraser_mixed_with_normal_strokes_only_normal_rendered(self):
        """Regression: When eraser strokes are mixed with normal strokes, only
        normal strokes should appear in the rendered SVG."""
        strokes = [
            _make_stroke(pen_type=6, color="white", points=[(0, 0), (50, 50)]),
            _make_stroke(pen_type=2, color="black", points=[(100, 100), (200, 200)]),
            _make_stroke(pen_type=8, color="white", points=[(300, 300), (400, 400)]),
            _make_stroke(pen_type=4, color="blue", points=[(500, 500), (600, 600)]),
        ]
        svg = render_strokes_to_svg(strokes)
        root = ET.fromstring(svg)
        paths = root.findall(".//{http://www.w3.org/2000/svg}path")
        assert len(paths) == 2, "Only 2 normal strokes should be rendered, erasers excluded"
