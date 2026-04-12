"""
Tests for legacy_rm_parser.py -- v3/v5 .rm binary format parsing.

Tests use synthetic binary data to verify the parser without needing
real .rm files from a reMarkable device.
"""

import os
import struct
import tempfile
import unittest

from legacy_rm_parser import (
    HIGHLIGHTER_PEN_TYPES,
    LEGACY_COLOR_MAP,
    LegacyHighlightRegion,
    LegacyHighlightStroke,
    parse_legacy_rm_file,
    _compute_bounds,
    _detect_version,
    _merge_nearby_strokes,
)


def _make_v5_header() -> bytes:
    """Build a valid v5 header (48 bytes)."""
    header_str = "reMarkable .lines file, version=5"
    return header_str.encode("ascii").ljust(48, b"\x00")


def _make_v3_header() -> bytes:
    """Build a valid v3 header (48 bytes)."""
    header_str = "reMarkable .lines file, version=3"
    return header_str.encode("ascii").ljust(48, b"\x00")


def _make_stroke_v5(
    pen_type: int,
    color: int,
    width: float,
    points: list[tuple[float, float]],
) -> bytes:
    """Build a v5 stroke binary blob."""
    data = struct.pack("<iii", pen_type, color, 0)  # pen, color, unknown1
    data += struct.pack("<f", width)
    data += struct.pack("<i", 0)  # unknown2 (v5 only)
    data += struct.pack("<i", len(points))
    for x, y in points:
        # x, y, speed, direction, width, pressure
        data += struct.pack("<ffffff", x, y, 0.0, 0.0, 0.0, 0.0)
    return data


def _make_stroke_v3(
    pen_type: int,
    color: int,
    width: float,
    points: list[tuple[float, float]],
) -> bytes:
    """Build a v3 stroke binary blob (no unknown2 field)."""
    data = struct.pack("<iii", pen_type, color, 0)  # pen, color, unknown1
    data += struct.pack("<f", width)
    # No unknown2 in v3
    data += struct.pack("<i", len(points))
    for x, y in points:
        data += struct.pack("<ffffff", x, y, 0.0, 0.0, 0.0, 0.0)
    return data


def _build_rm_file_v5(layers: list[list[bytes]]) -> bytes:
    """Build a complete v5 .rm file from layer/stroke data."""
    data = _make_v5_header()
    data += struct.pack("<i", len(layers))
    for strokes in layers:
        data += struct.pack("<i", len(strokes))
        for stroke_data in strokes:
            data += stroke_data
    return data


def _build_rm_file_v3(layers: list[list[bytes]]) -> bytes:
    """Build a complete v3 .rm file from layer/stroke data."""
    data = _make_v3_header()
    data += struct.pack("<i", len(layers))
    for strokes in layers:
        data += struct.pack("<i", len(strokes))
        for stroke_data in strokes:
            data += stroke_data
    return data


class TestDetectVersion(unittest.TestCase):
    """Test header version detection."""

    def test_detects_v5(self):
        self.assertEqual(_detect_version(_make_v5_header()), 5)

    def test_detects_v3(self):
        self.assertEqual(_detect_version(_make_v3_header()), 3)

    def test_returns_none_for_unknown(self):
        self.assertIsNone(_detect_version(b"\x00" * 48))

    def test_returns_none_for_v6_header(self):
        header = "reMarkable .lines file, version=6".encode("ascii").ljust(48, b"\x00")
        self.assertIsNone(_detect_version(header))


class TestComputeBounds(unittest.TestCase):
    """Test bounding box computation from points."""

    def test_single_point(self):
        bounds = _compute_bounds([(100.0, 200.0)], 10.0)
        self.assertAlmostEqual(bounds["x"], 95.0)
        self.assertAlmostEqual(bounds["y"], 195.0)
        self.assertAlmostEqual(bounds["width"], 10.0)
        self.assertAlmostEqual(bounds["height"], 10.0)

    def test_multiple_points(self):
        points = [(100.0, 100.0), (200.0, 100.0), (200.0, 200.0)]
        bounds = _compute_bounds(points, 0.0)
        self.assertAlmostEqual(bounds["x"], 100.0)
        self.assertAlmostEqual(bounds["y"], 100.0)
        self.assertAlmostEqual(bounds["width"], 100.0)
        self.assertAlmostEqual(bounds["height"], 100.0)

    def test_empty_points(self):
        bounds = _compute_bounds([], 10.0)
        self.assertAlmostEqual(bounds["width"], 0.0)

    def test_bounds_clamped_to_zero(self):
        bounds = _compute_bounds([(1.0, 1.0)], 50.0)
        self.assertGreaterEqual(bounds["x"], 0.0)
        self.assertGreaterEqual(bounds["y"], 0.0)


class TestMergeNearbyStrokes(unittest.TestCase):
    """Test stroke merging into highlight regions."""

    def _make_stroke(
        self, y_center: float, width: float = 200.0, height: float = 20.0, color: str = "yellow"
    ) -> LegacyHighlightStroke:
        return LegacyHighlightStroke(
            pen_type=5,
            color=color,
            width=10.0,
            points=[(50.0, y_center)],
            bounds={"x": 50.0, "y": y_center - height / 2, "width": width, "height": height},
        )

    def test_merges_adjacent_strokes(self):
        s1 = self._make_stroke(100.0)
        s2 = self._make_stroke(120.0)
        regions = _merge_nearby_strokes([s1, s2])
        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0].stroke_count, 2)

    def test_keeps_distant_strokes_separate(self):
        s1 = self._make_stroke(100.0)
        s2 = self._make_stroke(300.0)
        regions = _merge_nearby_strokes([s1, s2])
        self.assertEqual(len(regions), 2)

    def test_different_colors_not_merged(self):
        s1 = self._make_stroke(100.0, color="yellow")
        s2 = self._make_stroke(120.0, color="green")
        regions = _merge_nearby_strokes([s1, s2])
        self.assertEqual(len(regions), 2)

    def test_empty_input(self):
        self.assertEqual(_merge_nearby_strokes([]), [])


class TestParseLegacyRmFileV5(unittest.TestCase):
    """Test full v5 .rm file parsing."""

    def test_extracts_highlighter_strokes(self):
        # One layer with one highlighter stroke
        stroke = _make_stroke_v5(
            pen_type=5, color=3, width=30.0,
            points=[(100.0, 200.0), (300.0, 200.0)],
        )
        data = _build_rm_file_v5([[stroke]])

        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(data)
            f.flush()
            regions = parse_legacy_rm_file(f.name)
        os.unlink(f.name)

        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0].color, "yellow")  # color 3 = yellow

    def test_ignores_non_highlighter_strokes(self):
        # Pen type 0 = ballpoint, should be ignored
        stroke = _make_stroke_v5(
            pen_type=0, color=0, width=2.0,
            points=[(100.0, 200.0), (300.0, 200.0)],
        )
        data = _build_rm_file_v5([[stroke]])

        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(data)
            f.flush()
            regions = parse_legacy_rm_file(f.name)
        os.unlink(f.name)

        self.assertEqual(len(regions), 0)

    def test_multiple_layers_and_strokes(self):
        s1 = _make_stroke_v5(pen_type=5, color=3, width=30.0, points=[(100.0, 100.0), (300.0, 100.0)])
        s2 = _make_stroke_v5(pen_type=5, color=4, width=30.0, points=[(100.0, 500.0), (300.0, 500.0)])
        s3 = _make_stroke_v5(pen_type=0, color=0, width=2.0, points=[(50.0, 50.0)])

        data = _build_rm_file_v5([[s1, s3], [s2]])

        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(data)
            f.flush()
            regions = parse_legacy_rm_file(f.name)
        os.unlink(f.name)

        # Two highlight regions (s1 and s2 are far apart, different colors)
        self.assertEqual(len(regions), 2)

    def test_empty_file_raises(self):
        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(b"\x00" * 10)
            f.flush()
            with self.assertRaises(ValueError):
                parse_legacy_rm_file(f.name)
        os.unlink(f.name)

    def test_wrong_header_raises(self):
        data = b"NOT A REMARKABLE FILE" + b"\x00" * 40
        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(data)
            f.flush()
            with self.assertRaises(ValueError):
                parse_legacy_rm_file(f.name)
        os.unlink(f.name)

    def test_pen_type_18_is_highlighter(self):
        stroke = _make_stroke_v5(
            pen_type=18, color=5, width=30.0,
            points=[(100.0, 200.0), (300.0, 200.0)],
        )
        data = _build_rm_file_v5([[stroke]])

        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(data)
            f.flush()
            regions = parse_legacy_rm_file(f.name)
        os.unlink(f.name)

        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0].color, "pink")


class TestParseLegacyRmFileV3(unittest.TestCase):
    """Test v3 .rm file parsing."""

    def test_extracts_highlighter_strokes_v3(self):
        stroke = _make_stroke_v3(
            pen_type=5, color=3, width=30.0,
            points=[(100.0, 200.0), (300.0, 200.0)],
        )
        data = _build_rm_file_v3([[stroke]])

        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(data)
            f.flush()
            regions = parse_legacy_rm_file(f.name)
        os.unlink(f.name)

        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0].color, "yellow")


if __name__ == "__main__":
    unittest.main()
