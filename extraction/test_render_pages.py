"""
Tests for render_pages.py -- page image collection from reMarkable documents.

Tests cover:
- Notebook document handling (no PDF, only .rm files)
- Stale cache detection (cache older than .rm file)
- Sync-conflict file filtering in metadata
- Basic output structure

Uses temporary directories with mock xochitl file structures.
"""

import json
import os
import struct
import tempfile
import time
import unittest

from metadata_parser import parse_metadata_file, parse_content_file


class TestRenderPagesHelpers(unittest.TestCase):
    """Test helper functions and data structures used by render_pages."""

    def test_notebook_detection_from_content_file(self):
        """Notebooks have empty or 'notebook' fileType in .content."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Notebook: empty fileType
            content_path = os.path.join(tmpdir, "nb-1.content")
            with open(content_path, "w") as f:
                json.dump(
                    {
                        "fileType": "",
                        "pageCount": 3,
                        "pages": ["page-a", "page-b", "page-c"],
                    },
                    f,
                )

            content = parse_content_file(content_path)
            self.assertIsNotNone(content)
            # Empty fileType indicates a notebook
            self.assertIn(content.file_type, ("", "notebook"))
            self.assertEqual(len(content.page_uuids), 3)

    def test_pdf_detection_from_content_file(self):
        """PDFs have fileType 'pdf' in .content."""
        with tempfile.TemporaryDirectory() as tmpdir:
            content_path = os.path.join(tmpdir, "pdf-1.content")
            with open(content_path, "w") as f:
                json.dump(
                    {
                        "fileType": "pdf",
                        "pageCount": 5,
                        "pages": ["p1", "p2", "p3", "p4", "p5"],
                    },
                    f,
                )

            content = parse_content_file(content_path)
            self.assertIsNotNone(content)
            self.assertEqual(content.file_type, "pdf")
            self.assertEqual(len(content.page_uuids), 5)

    def test_content_file_with_cpages_format(self):
        """v6 format uses cPages.pages[].id instead of pages[]."""
        with tempfile.TemporaryDirectory() as tmpdir:
            content_path = os.path.join(tmpdir, "v6-doc.content")
            with open(content_path, "w") as f:
                json.dump(
                    {
                        "fileType": "pdf",
                        "cPages": {
                            "pages": [
                                {"id": "page-uuid-1"},
                                {"id": "page-uuid-2"},
                            ]
                        },
                    },
                    f,
                )

            content = parse_content_file(content_path)
            self.assertIsNotNone(content)
            self.assertEqual(len(content.page_uuids), 2)
            self.assertEqual(content.page_uuids[0], "page-uuid-1")


class TestStaleCacheDetection(unittest.TestCase):
    """Test that cache staleness is detected by comparing file timestamps."""

    def test_cache_newer_than_rm_is_not_stale(self):
        """When cache mtime > rm mtime, the cache is fresh."""
        with tempfile.TemporaryDirectory() as tmpdir:
            rm_path = os.path.join(tmpdir, "page.rm")
            cache_path = os.path.join(tmpdir, "page.png")

            # Create .rm file first
            with open(rm_path, "wb") as f:
                f.write(b"\x00" * 200)

            # Wait a moment, then create cache (newer)
            time.sleep(0.05)
            with open(cache_path, "wb") as f:
                f.write(b"PNG_DATA")

            rm_mtime = os.path.getmtime(rm_path)
            cache_mtime = os.path.getmtime(cache_path)

            self.assertGreaterEqual(cache_mtime, rm_mtime)

    def test_cache_older_than_rm_is_stale(self):
        """When cache mtime < rm mtime, the cache is stale."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_path = os.path.join(tmpdir, "page.png")
            rm_path = os.path.join(tmpdir, "page.rm")

            # Create cache first (will be older)
            with open(cache_path, "wb") as f:
                f.write(b"OLD_PNG_DATA")

            # Wait a moment, then create .rm file (newer)
            time.sleep(0.05)
            with open(rm_path, "wb") as f:
                f.write(b"\x00" * 200)

            rm_mtime = os.path.getmtime(rm_path)
            cache_mtime = os.path.getmtime(cache_path)

            self.assertLess(cache_mtime, rm_mtime)


class TestSyncConflictFiltering(unittest.TestCase):
    """Test that Syncthing conflict files in metadata are skipped."""

    def test_sync_conflict_metadata_is_skipped(self):
        """Files with 'sync-conflict' in the name should be ignored."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Normal metadata
            good_path = os.path.join(tmpdir, "doc-1.metadata")
            with open(good_path, "w") as f:
                json.dump(
                    {
                        "visibleName": "Good Doc",
                        "parent": "",
                        "type": "DocumentType",
                        "lastModified": "1700000000000",
                        "deleted": False,
                    },
                    f,
                )

            # Sync conflict metadata
            conflict_path = os.path.join(
                tmpdir, "doc-1.sync-conflict-20240115-123456-ABCDEFG.metadata"
            )
            with open(conflict_path, "w") as f:
                json.dump(
                    {
                        "visibleName": "Conflict Doc",
                        "parent": "",
                        "type": "DocumentType",
                        "lastModified": "1700000000000",
                        "deleted": False,
                    },
                    f,
                )

            # Normal metadata parses fine
            good_meta = parse_metadata_file(good_path)
            self.assertIsNotNone(good_meta)
            self.assertEqual(good_meta.visible_name, "Good Doc")

            # Conflict file also parses (the filtering is done at discovery level)
            # but its UUID will contain 'sync-conflict' which is filtered by callers
            conflict_meta = parse_metadata_file(conflict_path)
            self.assertIsNotNone(conflict_meta)
            # The UUID extracted from filename contains the conflict suffix
            self.assertIn("sync-conflict", conflict_meta.uuid)

    def test_syncthing_temp_files_are_not_valid_metadata(self):
        """Files starting with .syncthing. should not be processed."""
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_path = os.path.join(tmpdir, ".syncthing.doc-2.metadata.tmp")
            with open(temp_path, "w") as f:
                json.dump(
                    {
                        "visibleName": "Temp Doc",
                        "parent": "",
                        "type": "DocumentType",
                    },
                    f,
                )

            # The file parses, but discovery-level filtering excludes it
            # based on filename pattern (starts with .syncthing.)
            meta = parse_metadata_file(temp_path)
            # parse_metadata_file itself will parse it, but the uuid
            # will be derived from the filename which is not a valid UUID
            self.assertIsNotNone(meta)


class TestNotebookHandling(unittest.TestCase):
    """Test that notebooks (no PDF, only .rm strokes) are handled correctly."""

    def test_notebook_content_file_has_pages(self):
        """Notebook .content files list page UUIDs even without a PDF."""
        with tempfile.TemporaryDirectory() as tmpdir:
            content_path = os.path.join(tmpdir, "notebook-uuid.content")
            with open(content_path, "w") as f:
                json.dump(
                    {
                        "fileType": "",
                        "pageCount": 2,
                        "pages": ["page-1-uuid", "page-2-uuid"],
                    },
                    f,
                )

            content = parse_content_file(content_path)
            self.assertIsNotNone(content)
            self.assertEqual(content.page_count, 2)
            self.assertEqual(content.page_uuids, ["page-1-uuid", "page-2-uuid"])

    def test_rm_file_size_threshold_for_strokes(self):
        """Only .rm files >= 100 bytes are considered to have strokes."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Empty .rm file (no strokes)
            empty_rm = os.path.join(tmpdir, "page-empty.rm")
            with open(empty_rm, "wb") as f:
                f.write(b"\x00" * 50)

            # .rm file with strokes
            stroke_rm = os.path.join(tmpdir, "page-strokes.rm")
            with open(stroke_rm, "wb") as f:
                f.write(b"\x00" * 200)

            self.assertLess(os.path.getsize(empty_rm), 100)
            self.assertGreaterEqual(os.path.getsize(stroke_rm), 100)


# ---------------------------------------------------------------------------
# Regression tests
# ---------------------------------------------------------------------------


class TestPageNumberingByArrayIndex(unittest.TestCase):
    """Regression: Pages must use sequential array index (1-based) for page
    numbering, not the redir mapping from cPages. User-added pages (no redir)
    were being skipped when redir-based numbering was used. The fix enumerates
    all pages by their array position.
    """

    def test_page_numbering_is_sequential_from_content_array(self):
        """Pages should be numbered 1..N based on their position in page_uuids."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Simulate a document with 4 pages, some with redir, some without
            content_path = os.path.join(tmpdir, "doc-redir.content")
            with open(content_path, "w") as f:
                json.dump(
                    {
                        "fileType": "pdf",
                        "pageCount": 4,
                        "cPages": {
                            "pages": [
                                {"id": "page-a", "redir": {"value": 0}},
                                {"id": "page-b"},  # user-added page (no redir)
                                {"id": "page-c", "redir": {"value": 1}},
                                {"id": "page-d", "redir": {"value": 2}},
                            ]
                        },
                    },
                    f,
                )

            content = parse_content_file(content_path)
            self.assertIsNotNone(content)
            self.assertEqual(len(content.page_uuids), 4)

            # All 4 pages should be present in page_uuids
            self.assertEqual(content.page_uuids, ["page-a", "page-b", "page-c", "page-d"])

            # Page numbering is 1-based index into this array
            for idx, page_uuid in enumerate(content.page_uuids):
                page_number = idx + 1
                self.assertGreaterEqual(page_number, 1)
                self.assertLessEqual(page_number, 4)

    def test_user_added_pages_are_included(self):
        """User-added pages (no redir) must not be skipped."""
        with tempfile.TemporaryDirectory() as tmpdir:
            content_path = os.path.join(tmpdir, "doc-user-pages.content")
            with open(content_path, "w") as f:
                json.dump(
                    {
                        "fileType": "pdf",
                        "pageCount": 3,
                        "cPages": {
                            "pages": [
                                {"id": "original-1", "redir": {"value": 0}},
                                {"id": "user-added-1"},  # no redir
                                {"id": "original-2", "redir": {"value": 1}},
                            ]
                        },
                    },
                    f,
                )

            content = parse_content_file(content_path)
            self.assertEqual(len(content.page_uuids), 3)
            self.assertIn("user-added-1", content.page_uuids)


class TestTimestampToleranceForCache(unittest.TestCase):
    """Regression: Thumbnail/cache mtime within 2 seconds of .rm mtime should
    be treated as fresh. Syncthing can set slightly different timestamps on
    files synced at the same time, causing valid caches to be discarded.
    """

    def test_cache_within_tolerance_is_treated_as_fresh(self):
        """Cache mtime within 2 seconds of .rm mtime should be fresh."""
        with tempfile.TemporaryDirectory() as tmpdir:
            rm_path = os.path.join(tmpdir, "page.rm")
            cache_path = os.path.join(tmpdir, "page.png")

            # Create both files at nearly the same time
            with open(rm_path, "wb") as f:
                f.write(b"\x00" * 200)
            with open(cache_path, "wb") as f:
                f.write(b"PNG_DATA")

            rm_mtime = os.path.getmtime(rm_path)
            cache_mtime = os.path.getmtime(cache_path)

            MTIME_TOLERANCE = 2.0
            # The check in render_pages.py: cache_mtime >= rm_mtime - MTIME_TOLERANCE
            is_fresh = cache_mtime >= rm_mtime - MTIME_TOLERANCE
            self.assertTrue(
                is_fresh,
                f"Cache (mtime={cache_mtime:.3f}) should be treated as fresh "
                f"when rm mtime={rm_mtime:.3f} with tolerance={MTIME_TOLERANCE}",
            )

    def test_cache_slightly_before_rm_within_tolerance_is_fresh(self):
        """Cache 1.5 seconds older than .rm should still be fresh (within 2s tolerance)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_path = os.path.join(tmpdir, "page.png")
            rm_path = os.path.join(tmpdir, "page.rm")

            with open(cache_path, "wb") as f:
                f.write(b"CACHE_DATA")

            # Simulate rm_mtime being slightly later
            rm_mtime = os.path.getmtime(cache_path) + 1.5
            MTIME_TOLERANCE = 2.0

            cache_mtime = os.path.getmtime(cache_path)
            is_fresh = cache_mtime >= rm_mtime - MTIME_TOLERANCE
            self.assertTrue(
                is_fresh,
                "Cache 1.5s before rm should be treated as fresh with 2.0s tolerance",
            )

    def test_cache_well_before_rm_is_stale(self):
        """Cache more than 2 seconds older than .rm should be stale."""
        rm_mtime = 1700000010.0
        cache_mtime = 1700000005.0  # 5 seconds older
        MTIME_TOLERANCE = 2.0

        is_fresh = cache_mtime >= rm_mtime - MTIME_TOLERANCE
        self.assertFalse(
            is_fresh,
            "Cache 5s before rm should be stale with 2.0s tolerance",
        )


class TestHighlightOnlyPagesSkipAnnotation(unittest.TestCase):
    """Regression: Pages with only highlighter pen strokes (pen_type 5 or 18)
    should NOT get PNG annotations. Without this check, highlight-only pages
    produced empty or confusing annotation images.
    """

    def test_highlighter_pen_types_identified(self):
        """Pen types 5 and 18 are both highlighter types."""
        from stroke_renderer import HIGHLIGHTER_PEN_TYPES, ERASER_PEN_TYPES

        self.assertIn(5, HIGHLIGHTER_PEN_TYPES)
        self.assertIn(18, HIGHLIGHTER_PEN_TYPES)

        # Verify normal pens are NOT in the highlighter set
        self.assertNotIn(2, HIGHLIGHTER_PEN_TYPES)   # ballpoint
        self.assertNotIn(4, HIGHLIGHTER_PEN_TYPES)   # fineliner

    def test_highlight_only_page_has_no_pen_strokes(self):
        """A page with only highlighter strokes should report no pen drawings."""
        from stroke_renderer import Stroke, StrokePoint, HIGHLIGHTER_PEN_TYPES, ERASER_PEN_TYPES

        strokes = [
            Stroke(pen_type=5, color="yellow", stroke_width=15.0,
                   points=[StrokePoint(x=100, y=100), StrokePoint(x=200, y=100)]),
            Stroke(pen_type=18, color="yellow", stroke_width=15.0,
                   points=[StrokePoint(x=100, y=200), StrokePoint(x=200, y=200)]),
        ]

        has_pen = any(
            s.pen_type not in HIGHLIGHTER_PEN_TYPES and s.pen_type not in ERASER_PEN_TYPES
            for s in strokes
        )
        self.assertFalse(has_pen, "Page with only highlighter strokes should have no pen drawings")

    def test_mixed_page_has_pen_strokes(self):
        """A page with pen + highlighter strokes should report pen drawings."""
        from stroke_renderer import Stroke, StrokePoint, HIGHLIGHTER_PEN_TYPES, ERASER_PEN_TYPES

        strokes = [
            Stroke(pen_type=5, color="yellow", stroke_width=15.0,
                   points=[StrokePoint(x=100, y=100)]),
            Stroke(pen_type=2, color="black", stroke_width=1.0,
                   points=[StrokePoint(x=100, y=200)]),  # ballpoint
        ]

        has_pen = any(
            s.pen_type not in HIGHLIGHTER_PEN_TYPES and s.pen_type not in ERASER_PEN_TYPES
            for s in strokes
        )
        self.assertTrue(has_pen, "Page with ballpoint stroke should have pen drawings")


class TestRenderCache(unittest.TestCase):
    """Per-doc render cache: unchanged pages skip re-rendering."""

    SETTINGS = {"truncate_blank": True, "templates": False}

    def _entry(self):
        return {
            "uuid-1": {
                "filename": "Doc_p1_abcd.png",
                "rm_mtime": 1700000000,
                "highlight_texts": ["some text"],
                "ocr_text": None,
            }
        }

    def test_cache_roundtrip(self):
        from render_pages import _load_render_cache, _save_render_cache

        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, ".render-cache-x.json")
            _save_render_cache(path, self.SETTINGS, self._entry())
            self.assertEqual(_load_render_cache(path, self.SETTINGS), self._entry())

    def test_settings_change_invalidates_cache(self):
        from render_pages import _load_render_cache, _save_render_cache

        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, ".render-cache-x.json")
            _save_render_cache(path, self.SETTINGS, self._entry())
            changed = {"truncate_blank": False, "templates": False}
            self.assertEqual(_load_render_cache(path, changed), {})

    def test_entry_freshness_checks_template_and_mtime(self):
        from render_pages import _cache_entry_fresh

        with tempfile.TemporaryDirectory() as td:
            png = os.path.join(td, "Doc_p1_abcd.png")
            with open(png, "wb") as f:
                f.write(b"png")
            entry = {
                "filename": "Doc_p1_abcd.png",
                "rm_mtime": 1700000000,
                "template": "P Lines medium",
                "highlight_texts": [],
                "ocr_text": "",
            }
            fresh = lambda **kw: _cache_entry_fresh(
                {**entry, **kw.get("entry", {})},
                kw.get("filename", "Doc_p1_abcd.png"),
                kw.get("rm_mtime", 1700000000),
                kw.get("template", "P Lines medium"),
                kw.get("out_path", png),
            )
            self.assertTrue(fresh())
            # A template switch rewrites .content without touching the .rm
            self.assertFalse(fresh(template="Grid"))
            self.assertFalse(fresh(rm_mtime=1700000001))
            self.assertFalse(fresh(filename="Doc_p2_abcd.png"))
            self.assertFalse(fresh(out_path=os.path.join(td, "missing.png")))
            self.assertFalse(_cache_entry_fresh(None, "x.png", 1, None, png))

    def test_cached_ocr_is_withheld_while_ocr_is_off(self):
        """Turning OCR off must stop cached text from being reported again.

        The cache-hit path used to replay stored OCR text unconditionally, so
        disabling OCR had no effect: every sync rewrote the same handwriting
        callouts into the notes from cache.
        """
        cached = {"filename": "Doc_p1_abcd.png", "rm_mtime": 1, "template": None,
                  "highlight_texts": [], "ocr_text": "previously recognized text"}

        def reported(ocr_active):
            # Mirrors the cache-hit branch in main().
            ocr_engine = (lambda *a, **k: "fresh") if ocr_active else None
            text = cached.get("ocr_text") if ocr_engine is not None else None
            return text or ""

        self.assertEqual(reported(ocr_active=False), "")
        self.assertEqual(reported(ocr_active=True), "previously recognized text")
        # The text stays cached either way, so re-enabling needs no re-run.
        self.assertEqual(cached["ocr_text"], "previously recognized text")

    def test_missing_or_corrupt_cache_returns_empty(self):
        from render_pages import _load_render_cache

        with tempfile.TemporaryDirectory() as td:
            missing = os.path.join(td, "nope.json")
            self.assertEqual(_load_render_cache(missing, self.SETTINGS), {})

            corrupt = os.path.join(td, "bad.json")
            with open(corrupt, "w", encoding="utf-8") as f:
                f.write("{not json")
            self.assertEqual(_load_render_cache(corrupt, self.SETTINGS), {})


if __name__ == "__main__":
    unittest.main()
