"""
Tests for the highlighter-pen stroke → text extraction path in
highlight_extractor.py (v6 .rm files).

These complement test_highlight_extractor.py (GlyphRange) and
test_highlight_merger.py (post-extraction merge). The behaviors pinned down
here are the things the agz_unformatted_nature debugging surfaced:

  - Strokes with pen_type 5 OR 18 are treated as highlighter ink.
  - Strokes with other pen types (e.g. 1=pencil, 17=fineliner) are ignored
    even when drawn over text — they're regular pen marks, not highlights.
  - Tiny strokes (< 5 rm units in both x and y) are dropped as accidental
    taps.
  - Bounds are stored in RM coords so the merger sorts strokes and
    GlyphRanges consistently within a page.
  - rm-to-PDF coordinate conversion uses the 300/226 logical-DPI scale,
    verified against page 26 of the AlphaGo Zero paper.
"""

import unittest
from dataclasses import dataclass
from unittest.mock import MagicMock

from highlight_extractor import (
    _extract_highlighter_strokes_from_rm_file,
    _v6_rm_rect_to_pdf_rect,
    _process_highlighter_strokes,
    ExtractedHighlight,
)


@dataclass
class _Pt:
    x: float
    y: float


def _fake_line(pen_id, points, color_id=3):
    """Build a fake rmscene Line with a tool and color."""
    line = MagicMock()
    line.tool = MagicMock()
    line.tool.value = pen_id
    line.points = [_Pt(x, y) for x, y in points]
    line.color = MagicMock()
    line.color.value = color_id
    return line


def _fake_block(value):
    """Mimic a rmscene block: block.item.value -> the actual scene item."""
    block = MagicMock()
    block.item = MagicMock()
    block.item.value = value
    # block.value also exists for older rmscene shapes
    block.value = value
    return block


class CoordinateConversionTest(unittest.TestCase):
    """rm-space → PDF-point mapping for v6 stroke/glyph rectangles."""

    def test_origin_centered_x(self):
        # rm x=0 sits at the horizontal centre of the page.
        pdf = _v6_rm_rect_to_pdf_rect(0, 0, 0, 0, pdf_w=612, pdf_h=792)
        self.assertAlmostEqual(pdf["x"], 306, places=0)
        self.assertAlmostEqual(pdf["y"], 0, places=1)

    def test_agz_p26_ground_truth(self):
        # Calibration point from the AlphaGo Zero paper, page 26: GlyphRange
        # "action is selected according to the statistics" has rm y=437,
        # which corresponds to PDF y ≈ 139.9 (where that text actually is).
        # If this drifts, the stroke-text overlap will start matching wrong
        # PDF lines on real documents.
        pdf = _v6_rm_rect_to_pdf_rect(-243, 437, 100, 35, pdf_w=612, pdf_h=792)
        self.assertAlmostEqual(pdf["y"], 139.3, delta=2.0)


class FilteringTest(unittest.TestCase):
    """Which Line blocks count as highlighter ink."""

    def _run(self, lines):
        with unittest.mock.patch(
            "highlight_extractor.read_blocks",
            return_value=[_fake_block(line) for line in lines],
        ), unittest.mock.patch("highlight_extractor.Line", new=MagicMock):
            # Have to patch isinstance check by using a class our mocks pass
            # We side-step by patching the whole function to use the mocks.
            pass
        # Cleaner: just call with a real read_blocks substitute
        import highlight_extractor as he
        original_read = he.read_blocks
        original_line_cls = he.Line

        class _FakeLine: pass
        for line in lines:
            line.__class__ = _FakeLine

        he.read_blocks = lambda f: [_fake_block(line) for line in lines]
        he.Line = _FakeLine
        try:
            with unittest.mock.patch("builtins.open", unittest.mock.mock_open(read_data=b"")):
                return he._extract_highlighter_strokes_from_rm_file("fake.rm")
        finally:
            he.read_blocks = original_read
            he.Line = original_line_cls

    def test_pen_18_highlighter_included(self):
        line = _fake_line(pen_id=18, points=[(100, 200), (300, 205)])
        strokes = self._run([line])
        self.assertEqual(len(strokes), 1)
        self.assertEqual(strokes[0]["pen_type"], 18)

    def test_pen_5_highlighter_included(self):
        line = _fake_line(pen_id=5, points=[(100, 200), (300, 205)])
        strokes = self._run([line])
        self.assertEqual(len(strokes), 1)
        self.assertEqual(strokes[0]["pen_type"], 5)

    def test_pencil_pen_1_excluded(self):
        # Pen 1 is regular pencil. Underlining text with a pencil is NOT
        # a highlight; it's a regular pen mark. Don't extract its text.
        line = _fake_line(pen_id=1, points=[(100, 200), (300, 205)])
        self.assertEqual(self._run([line]), [])

    def test_fineliner_pen_17_excluded(self):
        line = _fake_line(pen_id=17, points=[(100, 200), (300, 205)])
        self.assertEqual(self._run([line]), [])

    def test_tiny_accidental_tap_dropped(self):
        # ~1 rm unit dot at one position. Likely a stylus bounce, not a real
        # highlight. Even if it happens to be a highlighter pen.
        line = _fake_line(pen_id=18, points=[(100, 200), (101, 201)])
        self.assertEqual(self._run([line]), [])

    def test_long_underline_kept(self):
        line = _fake_line(pen_id=18, points=[(100, 200), (500, 205)])
        strokes = self._run([line])
        self.assertEqual(len(strokes), 1)
        # bbox spans the full underline length
        x, y, w, h = strokes[0]["rm_bbox"]
        self.assertEqual((x, y, w, h), (100, 200, 400, 5))


class IntegrationWithFakePdfTest(unittest.TestCase):
    """End-to-end: _process_highlighter_strokes emits ExtractedHighlights."""

    def _make_pdf_doc(self, words_by_rect):
        """words_by_rect: list of (x0, y0, x1, y1, text) tuples returned by get_text('words')."""
        page = MagicMock()
        page.rect.width = 612
        page.rect.height = 792
        page.get_text.return_value = words_by_rect
        doc = MagicMock()
        doc.__getitem__.return_value = page
        doc.__len__.return_value = 1
        return doc

    def test_stroke_extracts_text_under_it(self):
        # A highlighter stroke at rm y=517 maps to PDF y ≈ 164. Simulate a
        # PDF word at that PDF y so it overlaps the stroke.
        doc = self._make_pdf_doc([
            (100.0, 162.0, 200.0, 174.0, "argmax", 0, 0, 0),
            (210.0, 162.0, 280.0, 174.0, "PUCT", 0, 0, 1),
            # A word far above — should NOT match
            (100.0, 50.0, 200.0, 60.0, "ignored", 0, 0, 2),
        ])

        import highlight_extractor as he
        line = _fake_line(pen_id=18, points=[(-734, 517), (354, 534)])

        class _FakeLine: pass
        line.__class__ = _FakeLine
        original_read, original_line_cls = he.read_blocks, he.Line
        he.read_blocks = lambda f: [_fake_block(line)]
        he.Line = _FakeLine
        try:
            with unittest.mock.patch("builtins.open", unittest.mock.mock_open(read_data=b"")):
                highlights: list[ExtractedHighlight] = []
                warnings: list[str] = []
                he._process_highlighter_strokes("fake.rm", doc, 0, highlights, warnings)
        finally:
            he.read_blocks, he.Line = original_read, original_line_cls

        self.assertEqual(len(highlights), 1)
        self.assertIn("argmax", highlights[0].text)
        self.assertIn("PUCT", highlights[0].text)
        self.assertNotIn("ignored", highlights[0].text)
        # Bounds stored in RM coords (matches GlyphRange-derived bounds)
        self.assertEqual(highlights[0].bounds["x"], -734)
        self.assertEqual(highlights[0].bounds["y"], 517)

    def test_stroke_with_no_overlapping_text_warns(self):
        # Stroke in blank space → no text, warning generated, no highlight added
        doc = self._make_pdf_doc([])  # no words on page

        import highlight_extractor as he
        line = _fake_line(pen_id=18, points=[(0, 100), (300, 110)])
        class _FakeLine: pass
        line.__class__ = _FakeLine
        original_read, original_line_cls = he.read_blocks, he.Line
        he.read_blocks = lambda f: [_fake_block(line)]
        he.Line = _FakeLine
        try:
            with unittest.mock.patch("builtins.open", unittest.mock.mock_open(read_data=b"")):
                highlights = []
                warnings = []
                he._process_highlighter_strokes("fake.rm", doc, 0, highlights, warnings)
        finally:
            he.read_blocks, he.Line = original_read, original_line_cls

        self.assertEqual(len(highlights), 0)
        self.assertEqual(len(warnings), 1)
        self.assertIn("matched no text", warnings[0])


if __name__ == "__main__":
    unittest.main()
