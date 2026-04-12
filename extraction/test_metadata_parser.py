"""
Tests for metadata_parser.py -- UUID resolution and folder hierarchy reconstruction.

These tests use temporary directories with mock xochitl file structures
to verify parsing without needing a real reMarkable device.
"""

import json
import os
import tempfile
import unittest

from metadata_parser import (
    parse_metadata_file,
    parse_content_file,
    discover_documents,
)


class TestParseMetadataFile(unittest.TestCase):
    """Test parsing of .metadata JSON files."""

    def test_parses_valid_metadata(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".metadata", delete=False
        ) as f:
            json.dump(
                {
                    "visibleName": "Test Paper",
                    "parent": "folder-uuid-123",
                    "type": "DocumentType",
                    "lastModified": "1700000000000",
                    "deleted": False,
                    "pinned": False,
                    "version": 5,
                },
                f,
            )
            f.flush()
            result = parse_metadata_file(f.name)

        os.unlink(f.name)
        self.assertIsNotNone(result)
        self.assertEqual(result.visible_name, "Test Paper")
        self.assertEqual(result.parent_uuid, "folder-uuid-123")
        self.assertEqual(result.last_modified, 1700000000000)
        self.assertFalse(result.deleted)

    def test_handles_missing_fields_gracefully(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".metadata", delete=False
        ) as f:
            json.dump({}, f)
            f.flush()
            result = parse_metadata_file(f.name)

        os.unlink(f.name)
        self.assertIsNotNone(result)
        self.assertEqual(result.visible_name, "Untitled")
        self.assertEqual(result.parent_uuid, "")

    def test_returns_none_for_malformed_json(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".metadata", delete=False
        ) as f:
            f.write("not valid json{{{")
            f.flush()
            result = parse_metadata_file(f.name)

        os.unlink(f.name)
        self.assertIsNone(result)

    def test_returns_none_for_missing_file(self):
        result = parse_metadata_file("/nonexistent/path.metadata")
        self.assertIsNone(result)


class TestParseContentFile(unittest.TestCase):
    """Test parsing of .content JSON files."""

    def test_parses_legacy_pages_array(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".content", delete=False
        ) as f:
            json.dump(
                {
                    "fileType": "pdf",
                    "pageCount": 3,
                    "pages": ["page-1", "page-2", "page-3"],
                },
                f,
            )
            f.flush()
            result = parse_content_file(f.name)

        os.unlink(f.name)
        self.assertIsNotNone(result)
        self.assertEqual(result.file_type, "pdf")
        self.assertEqual(result.page_count, 3)
        self.assertEqual(result.page_uuids, ["page-1", "page-2", "page-3"])

    def test_parses_v6_cpages_structure(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".content", delete=False
        ) as f:
            json.dump(
                {
                    "fileType": "pdf",
                    "pageCount": 2,
                    "cPages": {
                        "pages": [
                            {"id": "v6-page-1"},
                            {"id": "v6-page-2"},
                        ]
                    },
                },
                f,
            )
            f.flush()
            result = parse_content_file(f.name)

        os.unlink(f.name)
        self.assertIsNotNone(result)
        self.assertEqual(result.page_uuids, ["v6-page-1", "v6-page-2"])
        self.assertIsNotNone(result.c_pages)

    def test_returns_none_for_missing_file(self):
        result = parse_content_file("/nonexistent/path.content")
        self.assertIsNone(result)


class TestDiscoverDocuments(unittest.TestCase):
    """Test full document discovery with folder hierarchy reconstruction."""

    def setUp(self):
        """Create a mock xochitl directory structure."""
        self.tmpdir = tempfile.mkdtemp()

        # Create a folder entry
        self._write_json(
            "folder-1.metadata",
            {
                "visibleName": "Research Papers",
                "parent": "",
                "type": "CollectionType",
                "lastModified": "1700000000000",
                "deleted": False,
                "pinned": False,
                "version": 1,
            },
        )

        # Create a subfolder
        self._write_json(
            "folder-2.metadata",
            {
                "visibleName": "Machine Learning",
                "parent": "folder-1",
                "type": "CollectionType",
                "lastModified": "1700000000000",
                "deleted": False,
                "pinned": False,
                "version": 1,
            },
        )

        # Create a PDF document in the subfolder
        self._write_json(
            "doc-1.metadata",
            {
                "visibleName": "Attention Is All You Need",
                "parent": "folder-2",
                "type": "DocumentType",
                "lastModified": "1700000001000",
                "deleted": False,
                "pinned": False,
                "version": 3,
            },
        )
        self._write_json(
            "doc-1.content",
            {
                "fileType": "pdf",
                "pageCount": 15,
                "pages": ["p1", "p2", "p3"],
            },
        )
        # Create the PDF file
        with open(os.path.join(self.tmpdir, "doc-1.pdf"), "wb") as f:
            f.write(b"%PDF-1.4 fake")

        # Create a deleted document (should be excluded)
        self._write_json(
            "doc-deleted.metadata",
            {
                "visibleName": "Deleted Paper",
                "parent": "",
                "type": "DocumentType",
                "lastModified": "1700000000000",
                "deleted": True,
                "pinned": False,
                "version": 1,
            },
        )

        # Create a notebook (should be excluded in PDF-only mode)
        self._write_json(
            "notebook-1.metadata",
            {
                "visibleName": "My Notes",
                "parent": "",
                "type": "DocumentType",
                "lastModified": "1700000000000",
                "deleted": False,
                "pinned": False,
                "version": 1,
            },
        )
        self._write_json(
            "notebook-1.content",
            {
                "fileType": "",
                "pageCount": 5,
                "pages": ["n1", "n2", "n3", "n4", "n5"],
            },
        )

    def _write_json(self, filename: str, data: dict) -> None:
        filepath = os.path.join(self.tmpdir, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f)

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmpdir)

    def test_discovers_pdf_documents(self):
        docs = discover_documents(self.tmpdir)
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0].visible_name, "Attention Is All You Need")
        self.assertEqual(docs[0].doc_type, "pdf")

    def test_reconstructs_folder_hierarchy(self):
        docs = discover_documents(self.tmpdir)
        self.assertEqual(len(docs), 1)
        self.assertEqual(
            docs[0].folder_path, "Research Papers/Machine Learning"
        )

    def test_excludes_deleted_documents(self):
        docs = discover_documents(self.tmpdir)
        names = [d.visible_name for d in docs]
        self.assertNotIn("Deleted Paper", names)

    def test_excludes_notebooks(self):
        docs = discover_documents(self.tmpdir)
        names = [d.visible_name for d in docs]
        self.assertNotIn("My Notes", names)

    def test_detects_pdf_file_presence(self):
        docs = discover_documents(self.tmpdir)
        self.assertTrue(docs[0].has_pdf)

    def test_returns_empty_for_nonexistent_path(self):
        docs = discover_documents("/nonexistent/path")
        self.assertEqual(docs, [])

    def test_returns_empty_for_empty_directory(self):
        empty_dir = tempfile.mkdtemp()
        docs = discover_documents(empty_dir)
        self.assertEqual(docs, [])
        os.rmdir(empty_dir)

    def test_root_level_document(self):
        """Document at root level should have empty folder_path."""
        self._write_json(
            "doc-root.metadata",
            {
                "visibleName": "Root Paper",
                "parent": "",
                "type": "DocumentType",
                "lastModified": "1700000002000",
                "deleted": False,
                "pinned": False,
                "version": 1,
            },
        )
        self._write_json(
            "doc-root.content",
            {"fileType": "pdf", "pageCount": 1, "pages": ["rp1"]},
        )
        with open(os.path.join(self.tmpdir, "doc-root.pdf"), "wb") as f:
            f.write(b"%PDF-1.4 fake")

        docs = discover_documents(self.tmpdir)
        root_doc = [d for d in docs if d.visible_name == "Root Paper"]
        self.assertEqual(len(root_doc), 1)
        self.assertEqual(root_doc[0].folder_path, "")


# ---------------------------------------------------------------------------
# Regression tests
# ---------------------------------------------------------------------------


class TestSyncConflictFilteringInMetadataParser(unittest.TestCase):
    """Regression: Syncthing sync-conflict files in metadata directory
    were being parsed as real documents, causing duplicate/corrupt entries.
    The fix filters them out at the directory scan level in _scan_xochitl_directory.
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def _write_json(self, filename: str, data: dict) -> None:
        filepath = os.path.join(self.tmpdir, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f)

    def test_sync_conflict_metadata_excluded_from_discovery(self):
        """Regression: sync-conflict files in metadata should be filtered out."""
        # Normal document
        self._write_json("doc-1.metadata", {
            "visibleName": "Real Paper",
            "parent": "",
            "type": "DocumentType",
            "lastModified": "1700000000000",
            "deleted": False,
        })
        self._write_json("doc-1.content", {
            "fileType": "pdf",
            "pageCount": 1,
            "pages": ["p1"],
        })
        with open(os.path.join(self.tmpdir, "doc-1.pdf"), "wb") as f:
            f.write(b"%PDF-1.4 fake")

        # Sync conflict file -- must be filtered out
        self._write_json(
            "doc-1.sync-conflict-20240115-123456-ABCDEFG.metadata",
            {
                "visibleName": "Conflict Paper",
                "parent": "",
                "type": "DocumentType",
                "lastModified": "1700000000000",
                "deleted": False,
            },
        )
        self._write_json(
            "doc-1.sync-conflict-20240115-123456-ABCDEFG.content",
            {"fileType": "pdf", "pageCount": 1, "pages": ["p1"]},
        )

        docs = discover_documents(self.tmpdir)
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0].visible_name, "Real Paper")

    def test_syncthing_temp_file_excluded_from_discovery(self):
        """Regression: .syncthing. temp files should be filtered out."""
        self._write_json("doc-ok.metadata", {
            "visibleName": "OK Paper",
            "parent": "",
            "type": "DocumentType",
            "lastModified": "1700000000000",
            "deleted": False,
        })
        self._write_json("doc-ok.content", {
            "fileType": "pdf",
            "pageCount": 1,
            "pages": ["p1"],
        })
        with open(os.path.join(self.tmpdir, "doc-ok.pdf"), "wb") as f:
            f.write(b"%PDF-1.4 fake")

        # Syncthing temp file
        self._write_json(".syncthing.doc-ok.metadata.tmp", {
            "visibleName": "Temp Paper",
            "parent": "",
            "type": "DocumentType",
            "lastModified": "1700000000000",
            "deleted": False,
        })

        docs = discover_documents(self.tmpdir)
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0].visible_name, "OK Paper")


class TestNotebookDiscovery(unittest.TestCase):
    """Regression: Notebooks (fileType: 'notebook' or '') were not discovered
    by the document discovery pipeline, causing them to be invisible.
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def _write_json(self, filename: str, data: dict) -> None:
        filepath = os.path.join(self.tmpdir, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f)

    def test_discover_all_documents_includes_notebooks_empty_filetype(self):
        """Regression: Notebooks with empty fileType should be discovered."""
        from metadata_parser import discover_all_documents

        self._write_json("nb-1.metadata", {
            "visibleName": "My Notebook",
            "parent": "",
            "type": "DocumentType",
            "lastModified": "1700000000000",
            "deleted": False,
        })
        self._write_json("nb-1.content", {
            "fileType": "",
            "pageCount": 3,
            "pages": ["n1", "n2", "n3"],
        })

        docs = discover_all_documents(self.tmpdir, include_notebooks=True)
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0].visible_name, "My Notebook")
        self.assertEqual(docs[0].doc_type, "notebook")

    def test_discover_all_documents_includes_notebooks_explicit_filetype(self):
        """Regression: Notebooks with fileType='notebook' should be discovered."""
        from metadata_parser import discover_all_documents

        self._write_json("nb-2.metadata", {
            "visibleName": "Explicit Notebook",
            "parent": "",
            "type": "DocumentType",
            "lastModified": "1700000000000",
            "deleted": False,
        })
        self._write_json("nb-2.content", {
            "fileType": "notebook",
            "pageCount": 2,
            "pages": ["n1", "n2"],
        })

        docs = discover_all_documents(self.tmpdir, include_notebooks=True)
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0].doc_type, "notebook")

    def test_discover_documents_pdf_only_excludes_notebooks(self):
        """discover_documents (PDF-only) should not return notebooks."""
        self._write_json("nb-3.metadata", {
            "visibleName": "Notebook Only",
            "parent": "",
            "type": "DocumentType",
            "lastModified": "1700000000000",
            "deleted": False,
        })
        self._write_json("nb-3.content", {
            "fileType": "",
            "pageCount": 5,
            "pages": ["n1", "n2", "n3", "n4", "n5"],
        })

        docs = discover_documents(self.tmpdir)
        self.assertEqual(len(docs), 0)


if __name__ == "__main__":
    unittest.main()
