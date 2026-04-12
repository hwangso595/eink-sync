"""
Tests for highlight_extractor.py -- GlyphRange parsing, PDF text correlation,
bounding box computation, rectangle-based fallback, and edge cases.

These tests use mock objects to avoid requiring rmscene and PyMuPDF to be
installed in the test environment. Integration tests with real .rm files
and PDFs should be run separately.

Tests cover both extraction paths:
1. Direct text from GlyphRange.text (firmware >= 3.26)
2. Rectangle-based text extraction fallback (firmware < 3.26)
"""

import os
import tempfile
import unittest
from dataclasses import dataclass
from typing import Optional
from unittest.mock import MagicMock, patch, mock_open

from highlight_extractor import (
    ExtractedHighlight,
    _color_id_to_name,
    _extract_text_from_pdf_page,
    _extract_text_by_rectangle,
    _get_bounds_from_rects,
    _collect_glyph_ranges,
    _extract_highlights_from_rm_file,
    _detect_rm_format,
    _rm_to_pdf_coords,
    extract_highlights_for_document,
    extract_highlights_for_document_auto,
)


class TestColorIdToName(unittest.TestCase):
    """Test color ID to human-readable name mapping."""

    def test_known_color_ids(self):
        self.assertEqual(_color_id_to_name(0), "black")
        self.assertEqual(_color_id_to_name(1), "gray")
        self.assertEqual(_color_id_to_name(2), "white")
        self.assertEqual(_color_id_to_name(3), "yellow")
        self.assertEqual(_color_id_to_name(4), "green")
        self.assertEqual(_color_id_to_name(5), "pink")
        self.assertEqual(_color_id_to_name(6), "blue")
        self.assertEqual(_color_id_to_name(7), "red")
        self.assertEqual(_color_id_to_name(8), "gray_overlap")

    def test_unknown_color_id_returns_labeled_string(self):
        self.assertEqual(_color_id_to_name(99), "unknown_99")
        self.assertEqual(_color_id_to_name(-1), "unknown_-1")

    def test_all_known_ids_are_mapped(self):
        """Ensure no gaps in the 0-8 range."""
        for i in range(9):
            result = _color_id_to_name(i)
            self.assertFalse(result.startswith("unknown_"), f"ID {i} is not mapped")


class TestGetBoundsFromRects(unittest.TestCase):
    """Test bounding box computation from rectangle lists."""

    def test_single_rect(self):
        rects = [{"x": 10.0, "y": 20.0, "width": 100.0, "height": 14.0}]
        bounds = _get_bounds_from_rects(rects)
        self.assertIsNotNone(bounds)
        self.assertAlmostEqual(bounds["x"], 10.0)
        self.assertAlmostEqual(bounds["y"], 20.0)
        self.assertAlmostEqual(bounds["width"], 100.0)
        self.assertAlmostEqual(bounds["height"], 14.0)

    def test_multiple_rects_computes_enclosing_box(self):
        rects = [
            {"x": 10.0, "y": 100.0, "width": 200.0, "height": 14.0},
            {"x": 10.0, "y": 120.0, "width": 180.0, "height": 14.0},
            {"x": 10.0, "y": 140.0, "width": 150.0, "height": 14.0},
        ]
        bounds = _get_bounds_from_rects(rects)
        self.assertAlmostEqual(bounds["x"], 10.0)
        self.assertAlmostEqual(bounds["y"], 100.0)
        # max_x = max(10+200, 10+180, 10+150) = 210; width = 210 - 10 = 200
        self.assertAlmostEqual(bounds["width"], 200.0)
        # max_y = max(100+14, 120+14, 140+14) = 154; height = 154 - 100 = 54
        self.assertAlmostEqual(bounds["height"], 54.0)

    def test_empty_rects_returns_none(self):
        self.assertIsNone(_get_bounds_from_rects([]))

    def test_zero_size_rects(self):
        rects = [{"x": 50.0, "y": 50.0, "width": 0.0, "height": 0.0}]
        bounds = _get_bounds_from_rects(rects)
        self.assertIsNotNone(bounds)
        self.assertAlmostEqual(bounds["width"], 0.0)
        self.assertAlmostEqual(bounds["height"], 0.0)

    def test_overlapping_rects(self):
        """Overlapping rectangles should produce a bounding box that covers both."""
        rects = [
            {"x": 10.0, "y": 10.0, "width": 100.0, "height": 50.0},
            {"x": 50.0, "y": 30.0, "width": 100.0, "height": 50.0},
        ]
        bounds = _get_bounds_from_rects(rects)
        self.assertAlmostEqual(bounds["x"], 10.0)
        self.assertAlmostEqual(bounds["y"], 10.0)
        # max_x = max(110, 150) = 150; width = 150 - 10 = 140
        self.assertAlmostEqual(bounds["width"], 140.0)
        # max_y = max(60, 80) = 80; height = 80 - 10 = 70
        self.assertAlmostEqual(bounds["height"], 70.0)


class TestExtractTextFromPdfPage(unittest.TestCase):
    """Test PDF text extraction using character offsets."""

    def _make_mock_pdf(self, pages_text: list[str]) -> MagicMock:
        """Create a mock fitz.Document with given page texts."""
        mock_doc = MagicMock()
        mock_doc.__len__ = MagicMock(return_value=len(pages_text))

        mock_pages = []
        for text in pages_text:
            page = MagicMock()
            page.get_text.return_value = text
            mock_pages.append(page)

        mock_doc.__getitem__ = MagicMock(side_effect=lambda i: mock_pages[i])
        return mock_doc

    def test_extracts_text_at_offset(self):
        pdf = self._make_mock_pdf(["Hello World, this is a test document."])
        result = _extract_text_from_pdf_page(pdf, 0, 0, 11)
        self.assertEqual(result, "Hello World")

    def test_extracts_middle_of_page(self):
        pdf = self._make_mock_pdf(["ABCDEFGHIJ"])
        result = _extract_text_from_pdf_page(pdf, 0, 3, 4)
        self.assertEqual(result, "DEFG")

    def test_strips_whitespace(self):
        pdf = self._make_mock_pdf(["  Hello World  "])
        result = _extract_text_from_pdf_page(pdf, 0, 0, 15)
        self.assertEqual(result, "Hello World")

    def test_returns_empty_for_invalid_page_index(self):
        pdf = self._make_mock_pdf(["Page 1 text"])
        # Page index out of range
        self.assertEqual(_extract_text_from_pdf_page(pdf, -1, 0, 5), "")
        self.assertEqual(_extract_text_from_pdf_page(pdf, 1, 0, 5), "")

    def test_returns_empty_for_invalid_start_offset(self):
        pdf = self._make_mock_pdf(["Short"])
        self.assertEqual(_extract_text_from_pdf_page(pdf, 0, -1, 5), "")
        self.assertEqual(_extract_text_from_pdf_page(pdf, 0, 100, 5), "")

    def test_clamps_length_to_page_end(self):
        pdf = self._make_mock_pdf(["Short"])
        # Requesting more chars than available should not crash
        result = _extract_text_from_pdf_page(pdf, 0, 0, 1000)
        self.assertEqual(result, "Short")

    def test_multipage_extracts_correct_page(self):
        pdf = self._make_mock_pdf(["Page one text", "Page two text", "Page three text"])
        result = _extract_text_from_pdf_page(pdf, 1, 0, 8)
        self.assertEqual(result, "Page two")

    def test_empty_page_text(self):
        """Scanned PDF with no text layer returns empty string."""
        pdf = self._make_mock_pdf([""])
        result = _extract_text_from_pdf_page(pdf, 0, 0, 10)
        self.assertEqual(result, "")


class TestCollectGlyphRanges(unittest.TestCase):
    """Test recursive GlyphRange collection from rmscene block structures.

    Since rmscene may not be installed in the test environment, we inject
    a mock GlyphRange class into highlight_extractor at module level before
    each test, then restore the original value afterward.
    """

    def setUp(self):
        """Inject a mock GlyphRange class into the module."""
        import highlight_extractor as he

        self._original_gr = getattr(he, "GlyphRange", None)
        # Create a class that isinstance checks will match against
        self._MockGlyphRange = type("GlyphRange", (), {})
        he.GlyphRange = self._MockGlyphRange

    def tearDown(self):
        import highlight_extractor as he
        if self._original_gr is not None:
            he.GlyphRange = self._original_gr
        elif hasattr(he, "GlyphRange"):
            delattr(he, "GlyphRange")

    def _make_glyph_range(self, start=0, length=10, color=3):
        """Create a mock GlyphRange instance that passes isinstance checks."""
        gr = self._MockGlyphRange()
        gr.start = start
        gr.length = length
        gr.color = color
        gr.rectangles = []
        return gr

    def test_collects_glyph_range_from_block_value(self):
        """Block with a GlyphRange value should be collected."""
        gr = self._make_glyph_range(start=5, length=20, color=3)

        block = MagicMock(spec=["value"])
        block.value = gr

        highlights: list[dict] = []
        _collect_glyph_ranges(block, highlights)

        self.assertEqual(len(highlights), 1)
        self.assertEqual(highlights[0]["start"], 5)
        self.assertEqual(highlights[0]["length"], 20)
        self.assertEqual(highlights[0]["color"], "yellow")  # color 3 = yellow

    def test_collects_from_children_recursively(self):
        """Blocks with children containers should be walked recursively."""
        gr = self._make_glyph_range(start=0, length=5, color=5)

        leaf = MagicMock(spec=["value"])
        leaf.value = gr

        parent = MagicMock(spec=["children"])
        parent.children = [leaf]

        highlights: list[dict] = []
        _collect_glyph_ranges(parent, highlights)

        self.assertEqual(len(highlights), 1)
        self.assertEqual(highlights[0]["color"], "pink")  # color 5 = pink

    def test_empty_block_produces_no_highlights(self):
        """A block with no GlyphRange data should produce nothing."""
        block = MagicMock(spec=[])  # no children, no items, no value
        highlights: list[dict] = []
        _collect_glyph_ranges(block, highlights)

        self.assertEqual(len(highlights), 0)

    def test_collects_rectangles_from_glyph_range(self):
        """GlyphRange with rectangles should collect bounding rect data."""
        rect = MagicMock()
        rect.x = 72.0
        rect.y = 100.0
        rect.w = 400.0
        rect.h = 14.0

        gr = self._make_glyph_range()
        gr.rectangles = [rect]

        block = MagicMock(spec=["value"])
        block.value = gr

        highlights: list[dict] = []
        _collect_glyph_ranges(block, highlights)

        self.assertEqual(len(highlights), 1)
        self.assertEqual(len(highlights[0]["rects"]), 1)
        self.assertAlmostEqual(highlights[0]["rects"][0]["x"], 72.0)
        self.assertAlmostEqual(highlights[0]["rects"][0]["width"], 400.0)


class TestExtractHighlightsFromRmFile(unittest.TestCase):
    """Test .rm file parsing for GlyphRange extraction."""

    @patch("highlight_extractor.read_blocks", None)
    def test_raises_import_error_when_rmscene_missing(self):
        with self.assertRaises(ImportError) as ctx:
            _extract_highlights_from_rm_file("/fake/path.rm")
        self.assertIn("rmscene", str(ctx.exception))

    @patch("highlight_extractor.read_blocks")
    def test_raises_value_error_for_malformed_file(self, mock_read_blocks):
        mock_read_blocks.side_effect = Exception("corrupt data")

        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(b"\x00\x00\x00")
            f.flush()
            with self.assertRaises(ValueError) as ctx:
                _extract_highlights_from_rm_file(f.name)

        os.unlink(f.name)
        self.assertIn("Failed to parse", str(ctx.exception))


class TestExtractHighlightsForDocument(unittest.TestCase):
    """Test the main extraction entry point for a document."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.doc_uuid = "test-doc-uuid"
        self.page_uuids = ["page-1", "page-2"]

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    @patch("highlight_extractor.fitz", None)
    def test_raises_import_error_when_pymupdf_missing(self):
        with self.assertRaises(ImportError) as ctx:
            extract_highlights_for_document(
                self.doc_uuid, self.page_uuids, self.tmpdir
            )
        self.assertIn("PyMuPDF", str(ctx.exception))

    @patch("highlight_extractor.fitz")
    def test_returns_warning_when_pdf_not_found(self, mock_fitz):
        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )
        self.assertEqual(len(highlights), 0)
        self.assertTrue(any("not found" in w for w in warnings))

    @patch("highlight_extractor.fitz")
    def test_returns_warning_when_pdf_fails_to_open(self, mock_fitz):
        # Create the PDF file so path check passes
        pdf_path = os.path.join(self.tmpdir, f"{self.doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        mock_fitz.open.side_effect = Exception("corrupt PDF")

        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )
        self.assertEqual(len(highlights), 0)
        self.assertTrue(any("Failed to open PDF" in w for w in warnings))

    @patch("highlight_extractor.fitz")
    def test_returns_warning_when_no_annotation_directory(self, mock_fitz):
        # Create PDF but no annotation directory
        pdf_path = os.path.join(self.tmpdir, f"{self.doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        mock_fitz.open.return_value = MagicMock()

        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )
        self.assertEqual(len(highlights), 0)
        self.assertTrue(any("No annotation directory" in w for w in warnings))

    @patch("highlight_extractor._extract_highlights_from_rm_file")
    @patch("highlight_extractor.fitz")
    def test_skips_pages_without_rm_files(self, mock_fitz, mock_extract_rm):
        """Pages without .rm files should be silently skipped."""
        pdf_path = os.path.join(self.tmpdir, f"{self.doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        # Create annotation directory but no .rm files inside
        rm_dir = os.path.join(self.tmpdir, self.doc_uuid)
        os.makedirs(rm_dir)

        mock_pdf_doc = MagicMock()
        mock_fitz.open.return_value = mock_pdf_doc

        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )
        self.assertEqual(len(highlights), 0)
        mock_extract_rm.assert_not_called()

    @patch("highlight_extractor._extract_highlights_from_rm_file")
    @patch("highlight_extractor._extract_text_from_pdf_page")
    @patch("highlight_extractor.fitz")
    def test_empty_glyph_ranges_produce_no_highlights(
        self, mock_fitz, mock_extract_text, mock_extract_rm
    ):
        """Pages with .rm files but no GlyphRange blocks should produce nothing."""
        pdf_path = os.path.join(self.tmpdir, f"{self.doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        rm_dir = os.path.join(self.tmpdir, self.doc_uuid)
        os.makedirs(rm_dir)
        # Create an .rm file for page-1
        with open(os.path.join(rm_dir, "page-1.rm"), "wb") as f:
            f.write(b"\x00")

        mock_pdf_doc = MagicMock()
        mock_fitz.open.return_value = mock_pdf_doc

        # No glyph ranges found in the .rm file
        mock_extract_rm.return_value = []

        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )
        self.assertEqual(len(highlights), 0)

    @patch("highlight_extractor._extract_highlights_from_rm_file")
    @patch("highlight_extractor._extract_text_by_rectangle")
    @patch("highlight_extractor.fitz")
    def test_successful_highlight_extraction(
        self, mock_fitz, mock_rect_extract, mock_extract_rm
    ):
        """Full successful path: .rm file has GlyphRange, PDF has text."""
        pdf_path = os.path.join(self.tmpdir, f"{self.doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        rm_dir = os.path.join(self.tmpdir, self.doc_uuid)
        os.makedirs(rm_dir)
        with open(os.path.join(rm_dir, "page-1.rm"), "wb") as f:
            f.write(b"\x00")

        mock_pdf_doc = MagicMock()
        mock_fitz.open.return_value = mock_pdf_doc

        mock_extract_rm.return_value = [
            {
                "start": 0,
                "length": 25,
                "color": "yellow",
                "rects": [{"x": 72.0, "y": 100.0, "width": 400.0, "height": 14.0}],
            }
        ]
        mock_rect_extract.return_value = "Attention is all you need"

        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )

        self.assertEqual(len(highlights), 1)
        self.assertEqual(highlights[0].text, "Attention is all you need")
        self.assertEqual(highlights[0].page_number, 1)  # page-1 is index 0 -> page 1
        self.assertEqual(highlights[0].color, "yellow")
        self.assertIsNotNone(highlights[0].bounds)

    @patch("highlight_extractor._extract_highlights_from_rm_file")
    @patch("highlight_extractor._extract_text_from_pdf_page")
    @patch("highlight_extractor.fitz")
    def test_empty_text_produces_warning(
        self, mock_fitz, mock_extract_text, mock_extract_rm
    ):
        """Scanned PDF: GlyphRange exists but no text extracted -> warning."""
        pdf_path = os.path.join(self.tmpdir, f"{self.doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        rm_dir = os.path.join(self.tmpdir, self.doc_uuid)
        os.makedirs(rm_dir)
        with open(os.path.join(rm_dir, "page-1.rm"), "wb") as f:
            f.write(b"\x00")

        mock_pdf_doc = MagicMock()
        mock_fitz.open.return_value = mock_pdf_doc

        mock_extract_rm.return_value = [
            {"start": 0, "length": 10, "color": "yellow", "rects": []},
        ]
        # Simulate scanned PDF: no text layer
        mock_extract_text.return_value = ""

        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )

        self.assertEqual(len(highlights), 0)
        self.assertTrue(any("Empty text" in w for w in warnings))

    @patch("highlight_extractor._extract_highlights_from_rm_file")
    @patch("highlight_extractor._extract_text_by_rectangle")
    @patch("highlight_extractor.fitz")
    def test_multiple_highlights_on_same_page(
        self, mock_fitz, mock_rect_extract, mock_extract_rm
    ):
        """Multiple GlyphRanges on one page should produce multiple highlights."""
        pdf_path = os.path.join(self.tmpdir, f"{self.doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        rm_dir = os.path.join(self.tmpdir, self.doc_uuid)
        os.makedirs(rm_dir)
        with open(os.path.join(rm_dir, "page-1.rm"), "wb") as f:
            f.write(b"\x00")

        mock_pdf_doc = MagicMock()
        mock_fitz.open.return_value = mock_pdf_doc

        # Each GlyphRange has rects so rect-based extraction is used;
        # include direct text to test the direct-text path
        mock_extract_rm.return_value = [
            {"start": 0, "length": 10, "color": "yellow", "rects": [], "text": "First text"},
            {"start": 50, "length": 15, "color": "green", "rects": [], "text": "Second text"},
            {"start": 100, "length": 20, "color": "pink", "rects": [], "text": "Third text here"},
        ]

        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )

        self.assertEqual(len(highlights), 3)
        self.assertEqual(highlights[0].text, "First text")
        self.assertEqual(highlights[1].text, "Second text")
        self.assertEqual(highlights[2].text, "Third text here")
        # All on page 1
        for h in highlights:
            self.assertEqual(h.page_number, 1)

    @patch("highlight_extractor._extract_highlights_from_rm_file")
    @patch("highlight_extractor.fitz")
    def test_highlights_across_multiple_pages(
        self, mock_fitz, mock_extract_rm
    ):
        """Highlights on different pages should have correct page numbers."""
        pdf_path = os.path.join(self.tmpdir, f"{self.doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        rm_dir = os.path.join(self.tmpdir, self.doc_uuid)
        os.makedirs(rm_dir)
        # Create .rm files for both pages
        with open(os.path.join(rm_dir, "page-1.rm"), "wb") as f:
            f.write(b"\x00")
        with open(os.path.join(rm_dir, "page-2.rm"), "wb") as f:
            f.write(b"\x00")

        mock_pdf_doc = MagicMock()
        mock_fitz.open.return_value = mock_pdf_doc

        # Use direct text (firmware >= 3.26 path) to test page numbering
        mock_extract_rm.side_effect = [
            [{"start": 0, "length": 5, "color": "yellow", "rects": [], "text": "Hello"}],
            [{"start": 0, "length": 8, "color": "green", "rects": [], "text": "Greeting"}],
        ]

        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )

        self.assertEqual(len(highlights), 2)
        self.assertEqual(highlights[0].page_number, 1)
        self.assertEqual(highlights[0].text, "Hello")
        self.assertEqual(highlights[1].page_number, 2)
        self.assertEqual(highlights[1].text, "Greeting")

    @patch("highlight_extractor._extract_highlights_from_rm_file")
    @patch("highlight_extractor.fitz")
    def test_rm_parse_error_produces_warning_not_crash(
        self, mock_fitz, mock_extract_rm
    ):
        """ValueError from .rm parsing should produce a warning, not crash."""
        pdf_path = os.path.join(self.tmpdir, f"{self.doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        rm_dir = os.path.join(self.tmpdir, self.doc_uuid)
        os.makedirs(rm_dir)
        with open(os.path.join(rm_dir, "page-1.rm"), "wb") as f:
            f.write(b"\x00")

        mock_pdf_doc = MagicMock()
        mock_fitz.open.return_value = mock_pdf_doc

        mock_extract_rm.side_effect = ValueError("corrupt .rm data")

        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )

        self.assertEqual(len(highlights), 0)
        self.assertTrue(any("corrupt" in w for w in warnings))


class TestExtractedHighlightDataclass(unittest.TestCase):
    """Test the ExtractedHighlight dataclass itself."""

    def test_creates_with_all_fields(self):
        h = ExtractedHighlight(
            text="Test highlight",
            page_number=3,
            color="yellow",
            bounds={"x": 10, "y": 20, "width": 100, "height": 14},
            created_at=1700000000000,
        )
        self.assertEqual(h.text, "Test highlight")
        self.assertEqual(h.page_number, 3)
        self.assertEqual(h.color, "yellow")
        self.assertIsNotNone(h.bounds)
        self.assertEqual(h.created_at, 1700000000000)

    def test_creates_with_optional_fields_none(self):
        h = ExtractedHighlight(
            text="Minimal",
            page_number=1,
            color=None,
            bounds=None,
            created_at=None,
        )
        self.assertIsNone(h.color)
        self.assertIsNone(h.bounds)
        self.assertIsNone(h.created_at)


class TestExtractTextByRectangle(unittest.TestCase):
    """Test rectangle-based text extraction fallback.

    This covers the reliable fallback for firmware < 3.26 where character
    offsets are unreliable (12-17 char deltas observed on real devices).
    """

    def _make_mock_rect(self, x0, y0, x1, y1):
        """Create a mock fitz.Rect that supports intersection."""
        rect = MagicMock()
        rect.x0, rect.y0, rect.x1, rect.y1 = x0, y0, x1, y1
        rect.is_empty = False
        rect.width = x1 - x0
        rect.height = y1 - y0
        return rect

    @patch("highlight_extractor.fitz")
    def test_extracts_overlapping_words(self, mock_fitz):
        """Words overlapping with highlight rectangles should be extracted."""
        # Set up fitz.Rect to behave like a real Rect
        def make_rect(x0, y0, x1, y1):
            r = MagicMock()
            r.is_empty = False
            r.x0, r.y0, r.x1, r.y1 = x0, y0, x1, y1
            # Simulate intersection: non-empty if ranges overlap
            # __and__ receives (self, other) when called as r & hr
            def intersect(self_rect, other):
                ix0 = max(x0, other.x0)
                iy0 = max(y0, other.y0)
                ix1 = min(x1, other.x1)
                iy1 = min(y1, other.y1)
                result = MagicMock()
                result.is_empty = (ix0 >= ix1) or (iy0 >= iy1)
                return result
            r.__and__ = intersect
            return r

        mock_fitz.Rect = make_rect

        mock_page = MagicMock()
        # Words: (x0, y0, x1, y1, word, block, line, word_no)
        mock_page.get_text.return_value = [
            (72.0, 100.0, 120.0, 114.0, "Attention", 0, 0, 0),
            (122.0, 100.0, 140.0, 114.0, "is", 0, 0, 1),
            (142.0, 100.0, 160.0, 114.0, "all", 0, 0, 2),
            (162.0, 100.0, 190.0, 114.0, "you", 0, 0, 3),
            (192.0, 100.0, 230.0, 114.0, "need", 0, 0, 4),
            (72.0, 200.0, 150.0, 214.0, "Other", 0, 1, 0),  # Different line
        ]

        mock_doc = MagicMock()
        mock_doc.__len__ = MagicMock(return_value=1)
        mock_doc.__getitem__ = MagicMock(return_value=mock_page)

        # Highlight rectangle covering "Attention is all you need"
        rects = [{"x": 70.0, "y": 98.0, "width": 162.0, "height": 18.0}]

        result = _extract_text_by_rectangle(mock_doc, 0, rects)
        self.assertIn("Attention", result)
        self.assertIn("need", result)
        self.assertNotIn("Other", result)

    @patch("highlight_extractor.fitz")
    def test_empty_rects_returns_empty(self, mock_fitz):
        mock_doc = MagicMock()
        mock_doc.__len__ = MagicMock(return_value=1)
        result = _extract_text_by_rectangle(mock_doc, 0, [])
        self.assertEqual(result, "")

    @patch("highlight_extractor.fitz")
    def test_invalid_page_returns_empty(self, mock_fitz):
        mock_doc = MagicMock()
        mock_doc.__len__ = MagicMock(return_value=1)
        result = _extract_text_by_rectangle(mock_doc, -1, [{"x": 0, "y": 0, "width": 10, "height": 10}])
        self.assertEqual(result, "")
        result = _extract_text_by_rectangle(mock_doc, 5, [{"x": 0, "y": 0, "width": 10, "height": 10}])
        self.assertEqual(result, "")

    @patch("highlight_extractor.fitz")
    def test_no_overlapping_words_returns_empty(self, mock_fitz):
        def make_rect(x0, y0, x1, y1):
            r = MagicMock()
            r.is_empty = False
            r.x0, r.y0, r.x1, r.y1 = x0, y0, x1, y1
            def intersect(self_rect, other):
                result = MagicMock()
                result.is_empty = True  # No intersection
                return result
            r.__and__ = intersect
            return r

        mock_fitz.Rect = make_rect

        mock_page = MagicMock()
        mock_page.get_text.return_value = [
            (500.0, 500.0, 550.0, 514.0, "Far", 0, 0, 0),
        ]
        mock_doc = MagicMock()
        mock_doc.__len__ = MagicMock(return_value=1)
        mock_doc.__getitem__ = MagicMock(return_value=mock_page)

        rects = [{"x": 10.0, "y": 10.0, "width": 50.0, "height": 14.0}]
        result = _extract_text_by_rectangle(mock_doc, 0, rects)
        self.assertEqual(result, "")


class TestRectBasedFallbackInExtraction(unittest.TestCase):
    """Test that the main extraction uses rect-based fallback when text is missing."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.doc_uuid = "test-rect-fallback"
        self.page_uuids = ["page-1"]

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    @patch("highlight_extractor._extract_text_by_rectangle")
    @patch("highlight_extractor._extract_highlights_from_rm_file")
    @patch("highlight_extractor.fitz")
    def test_uses_rect_fallback_when_no_text_in_glyphrange(
        self, mock_fitz, mock_extract_rm, mock_rect_extract
    ):
        """When GlyphRange has rects but no text, rect-based extraction is used."""
        pdf_path = os.path.join(self.tmpdir, f"{self.doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        rm_dir = os.path.join(self.tmpdir, self.doc_uuid)
        os.makedirs(rm_dir)
        with open(os.path.join(rm_dir, "page-1.rm"), "wb") as f:
            f.write(b"\x00")

        mock_pdf_doc = MagicMock()
        mock_fitz.open.return_value = mock_pdf_doc

        # GlyphRange with rectangles but NO text (firmware < 3.26)
        mock_extract_rm.return_value = [
            {
                "start": 42,
                "length": 25,
                "color": "yellow",
                "rects": [{"x": 72.0, "y": 100.0, "width": 400.0, "height": 14.0}],
                # Note: no "text" key
            }
        ]
        mock_rect_extract.return_value = "Extracted via rectangle matching"

        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )

        self.assertEqual(len(highlights), 1)
        self.assertEqual(highlights[0].text, "Extracted via rectangle matching")
        mock_rect_extract.assert_called_once()

    @patch("highlight_extractor._extract_text_by_rectangle")
    @patch("highlight_extractor._extract_highlights_from_rm_file")
    @patch("highlight_extractor.fitz")
    def test_uses_direct_text_when_available(
        self, mock_fitz, mock_extract_rm, mock_rect_extract
    ):
        """When GlyphRange has text (firmware >= 3.26), it is used directly."""
        pdf_path = os.path.join(self.tmpdir, f"{self.doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        rm_dir = os.path.join(self.tmpdir, self.doc_uuid)
        os.makedirs(rm_dir)
        with open(os.path.join(rm_dir, "page-1.rm"), "wb") as f:
            f.write(b"\x00")

        mock_pdf_doc = MagicMock()
        mock_fitz.open.return_value = mock_pdf_doc

        # GlyphRange WITH text (firmware >= 3.26)
        mock_extract_rm.return_value = [
            {
                "start": 0,
                "length": 25,
                "color": "yellow",
                "rects": [{"x": 72.0, "y": 100.0, "width": 400.0, "height": 14.0}],
                "text": "Attention is all you need",
            }
        ]

        highlights, warnings = extract_highlights_for_document(
            self.doc_uuid, self.page_uuids, self.tmpdir
        )

        self.assertEqual(len(highlights), 1)
        self.assertEqual(highlights[0].text, "Attention is all you need")
        # Rectangle fallback should NOT be called when text is present
        mock_rect_extract.assert_not_called()


class TestDetectRmFormat(unittest.TestCase):
    """Test per-file format detection."""

    def test_detects_v6(self):
        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(b"reMarkable .lines file, version=6" + b"\x00" * 40)
            f.flush()
            self.assertEqual(_detect_rm_format(f.name), "v6")
        os.unlink(f.name)

    def test_detects_v5(self):
        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(b"reMarkable .lines file, version=5" + b"\x00" * 40)
            f.flush()
            self.assertEqual(_detect_rm_format(f.name), "v5")
        os.unlink(f.name)

    def test_detects_v3(self):
        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(b"reMarkable .lines file, version=3" + b"\x00" * 40)
            f.flush()
            self.assertEqual(_detect_rm_format(f.name), "v3")
        os.unlink(f.name)

    def test_unknown_for_bad_header(self):
        with tempfile.NamedTemporaryFile(suffix=".rm", delete=False) as f:
            f.write(b"random binary data" + b"\x00" * 40)
            f.flush()
            self.assertEqual(_detect_rm_format(f.name), "unknown")
        os.unlink(f.name)

    def test_unknown_for_missing_file(self):
        self.assertEqual(_detect_rm_format("/nonexistent/file.rm"), "unknown")


class TestRmToPdfCoords(unittest.TestCase):
    """Test reMarkable to PDF coordinate conversion."""

    def test_identity_at_rm_resolution(self):
        rect = {"x": 0.0, "y": 0.0, "width": 1404.0, "height": 1872.0}
        result = _rm_to_pdf_coords(rect, 1404.0, 1872.0)
        self.assertAlmostEqual(result["x"], 0.0)
        self.assertAlmostEqual(result["y"], 0.0)
        self.assertAlmostEqual(result["width"], 1404.0)
        self.assertAlmostEqual(result["height"], 1872.0)

    def test_scales_to_letter_size(self):
        # US Letter in points: 612 x 792
        rect = {"x": 702.0, "y": 936.0, "width": 702.0, "height": 936.0}
        result = _rm_to_pdf_coords(rect, 612.0, 792.0)
        self.assertAlmostEqual(result["x"], 306.0, places=0)
        self.assertAlmostEqual(result["y"], 396.0, places=0)


# ---------------------------------------------------------------------------
# Regression tests
# ---------------------------------------------------------------------------


class TestUnicodeInHighlights(unittest.TestCase):
    """Regression: Unicode characters (theta, etc.) in highlight text crashed
    cp1252 stdout on Windows. The fix was to force UTF-8 encoding in extract.py.
    These tests verify that non-ASCII text survives the extraction pipeline.
    """

    @patch("highlight_extractor._extract_highlights_from_rm_file")
    @patch("highlight_extractor.fitz")
    def test_unicode_theta_in_highlight_text(self, mock_fitz, mock_extract_rm):
        """Regression: Unicode theta (θ) in highlights crashed cp1252 stdout."""
        tmpdir = tempfile.mkdtemp()
        doc_uuid = "unicode-doc"
        page_uuids = ["page-1"]

        pdf_path = os.path.join(tmpdir, f"{doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        rm_dir = os.path.join(tmpdir, doc_uuid)
        os.makedirs(rm_dir)
        with open(os.path.join(rm_dir, "page-1.rm"), "wb") as f:
            f.write(b"\x00")

        mock_pdf_doc = MagicMock()
        mock_fitz.open.return_value = mock_pdf_doc

        # GlyphRange with Unicode text containing theta
        mock_extract_rm.return_value = [
            {
                "start": 0,
                "length": 30,
                "color": "yellow",
                "rects": [],
                "text": "The angle θ is measured in radians",
            }
        ]

        highlights, warnings = extract_highlights_for_document(
            doc_uuid, page_uuids, tmpdir
        )

        import shutil
        shutil.rmtree(tmpdir)

        self.assertEqual(len(highlights), 1)
        self.assertIn("θ", highlights[0].text)
        self.assertEqual(highlights[0].text, "The angle θ is measured in radians")

    @patch("highlight_extractor._extract_highlights_from_rm_file")
    @patch("highlight_extractor.fitz")
    def test_unicode_mixed_scripts_in_highlight(self, mock_fitz, mock_extract_rm):
        """Regression: Mixed scripts (CJK, Greek, accented Latin) in highlights."""
        tmpdir = tempfile.mkdtemp()
        doc_uuid = "unicode-mixed"
        page_uuids = ["page-1"]

        pdf_path = os.path.join(tmpdir, f"{doc_uuid}.pdf")
        with open(pdf_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

        rm_dir = os.path.join(tmpdir, doc_uuid)
        os.makedirs(rm_dir)
        with open(os.path.join(rm_dir, "page-1.rm"), "wb") as f:
            f.write(b"\x00")

        mock_pdf_doc = MagicMock()
        mock_fitz.open.return_value = mock_pdf_doc

        mock_extract_rm.return_value = [
            {
                "start": 0,
                "length": 50,
                "color": "yellow",
                "rects": [],
                "text": "Naive Bayes: P(A|B) = P(B|A)P(A)/P(B), see Muller",
            },
            {
                "start": 0,
                "length": 20,
                "color": "green",
                "rects": [],
                "text": "alpha=\u03b1, beta=\u03b2, gamma=\u03b3",
            },
        ]

        highlights, warnings = extract_highlights_for_document(
            doc_uuid, page_uuids, tmpdir
        )

        import shutil
        shutil.rmtree(tmpdir)

        self.assertEqual(len(highlights), 2)
        self.assertIn("\u03b1", highlights[1].text)  # alpha
        self.assertIn("\u03b2", highlights[1].text)  # beta
        self.assertIn("\u03b3", highlights[1].text)  # gamma


class TestGlyphRangeItemValuePath(unittest.TestCase):
    """Regression: SceneGlyphItemBlock stores GlyphRange at block.item.value,
    not block.value. The text field is preferred over character offset fallback.
    """

    def setUp(self):
        """Inject a mock GlyphRange class into the module."""
        import highlight_extractor as he

        self._original_gr = getattr(he, "GlyphRange", None)
        self._MockGlyphRange = type("GlyphRange", (), {})
        he.GlyphRange = self._MockGlyphRange

    def tearDown(self):
        import highlight_extractor as he
        if self._original_gr is not None:
            he.GlyphRange = self._original_gr
        elif hasattr(he, "GlyphRange"):
            delattr(he, "GlyphRange")

    def _make_glyph_range(self, text=None, start=0, length=10, color=3):
        """Create a mock GlyphRange instance."""
        gr = self._MockGlyphRange()
        gr.start = start
        gr.length = length
        gr.color = color
        gr.rectangles = []
        if text is not None:
            gr.text = text
        return gr

    def test_collects_glyph_range_from_item_value_not_block_value(self):
        """Regression: GlyphRange at block.item.value must be collected
        (SceneGlyphItemBlock path), not just block.value."""
        gr = self._make_glyph_range(text="Important finding")

        # Simulate SceneGlyphItemBlock: block.item.value = GlyphRange
        item = MagicMock(spec=["value"])
        item.value = gr
        block = MagicMock(spec=["item"])
        block.item = item

        highlights: list[dict] = []
        _collect_glyph_ranges(block, highlights)

        self.assertEqual(len(highlights), 1)
        self.assertEqual(highlights[0]["text"], "Important finding")

    def test_prefers_text_field_over_offset_fallback(self):
        """Regression: When GlyphRange has .text, it should be used directly
        instead of falling back to character offset extraction."""
        gr = self._make_glyph_range(text="Direct text from GlyphRange")

        block = MagicMock(spec=["value"])
        block.value = gr

        highlights: list[dict] = []
        _collect_glyph_ranges(block, highlights)

        self.assertEqual(len(highlights), 1)
        self.assertEqual(highlights[0]["text"], "Direct text from GlyphRange")

    def test_glyph_range_without_text_falls_back_to_rects(self):
        """When GlyphRange has no .text attribute, rects should be used."""
        gr = self._make_glyph_range()
        # No text attribute set — only start/length/rects

        block = MagicMock(spec=["value"])
        block.value = gr

        highlights: list[dict] = []
        _collect_glyph_ranges(block, highlights)

        self.assertEqual(len(highlights), 1)
        self.assertNotIn("text", highlights[0])


if __name__ == "__main__":
    unittest.main()
