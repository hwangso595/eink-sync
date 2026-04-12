"""
Tests for EPUB annotation support.

Verifies:
1. EPUB document detection from .content files
2. Converted PDF detection
3. EPUB metadata generation
4. EPUB discovery filtering
"""

import json
import os
import tempfile
import pytest

from epub_support import (
    is_epub_document,
    has_converted_pdf,
    get_epub_metadata,
    discover_epub_documents,
)


@pytest.fixture
def xochitl_dir():
    """Create a temporary xochitl directory with test data."""
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create an EPUB document
        epub_uuid = "epub-1234-5678"
        _create_metadata(tmpdir, epub_uuid, "My EPUB Book", "DocumentType")
        _create_content(tmpdir, epub_uuid, "epub", ["page-1", "page-2"])
        # Create the converted PDF
        with open(os.path.join(tmpdir, f"{epub_uuid}.pdf"), "wb") as f:
            f.write(b"%PDF-1.4 fake")

        # Create a PDF document (not EPUB)
        pdf_uuid = "pdf-1234-5678"
        _create_metadata(tmpdir, pdf_uuid, "My PDF Paper", "DocumentType")
        _create_content(tmpdir, pdf_uuid, "pdf", ["page-a", "page-b"])
        with open(os.path.join(tmpdir, f"{pdf_uuid}.pdf"), "wb") as f:
            f.write(b"%PDF-1.4 fake")

        # Create an EPUB without converted PDF
        epub_no_pdf_uuid = "epub-no-pdf-9999"
        _create_metadata(tmpdir, epub_no_pdf_uuid, "EPUB No PDF", "DocumentType")
        _create_content(tmpdir, epub_no_pdf_uuid, "epub", ["page-x"])

        yield tmpdir


def _create_metadata(tmpdir, uuid, name, doc_type):
    meta = {
        "visibleName": name,
        "parent": "",
        "type": doc_type,
        "lastModified": "1700000000000",
        "deleted": False,
    }
    with open(os.path.join(tmpdir, f"{uuid}.metadata"), "w") as f:
        json.dump(meta, f)


def _create_content(tmpdir, uuid, file_type, page_uuids):
    content = {
        "fileType": file_type,
        "pageCount": len(page_uuids),
        "pages": page_uuids,
    }
    with open(os.path.join(tmpdir, f"{uuid}.content"), "w") as f:
        json.dump(content, f)


class TestIsEpubDocument:
    def test_epub_document(self, xochitl_dir):
        path = os.path.join(xochitl_dir, "epub-1234-5678.content")
        assert is_epub_document(path) is True

    def test_pdf_document(self, xochitl_dir):
        path = os.path.join(xochitl_dir, "pdf-1234-5678.content")
        assert is_epub_document(path) is False

    def test_nonexistent_file(self):
        assert is_epub_document("/nonexistent/file.content") is False


class TestHasConvertedPdf:
    def test_epub_with_pdf(self, xochitl_dir):
        assert has_converted_pdf("epub-1234-5678", xochitl_dir) is True

    def test_epub_without_pdf(self, xochitl_dir):
        assert has_converted_pdf("epub-no-pdf-9999", xochitl_dir) is False

    def test_nonexistent_uuid(self, xochitl_dir):
        assert has_converted_pdf("nonexistent-uuid", xochitl_dir) is False


class TestGetEpubMetadata:
    def test_epub_document(self, xochitl_dir):
        meta = get_epub_metadata("epub-1234-5678", xochitl_dir)
        assert meta is not None
        assert meta["is_epub"] is True
        assert meta["has_converted_pdf"] is True
        assert meta["original_format"] == "epub"

    def test_epub_without_pdf(self, xochitl_dir):
        meta = get_epub_metadata("epub-no-pdf-9999", xochitl_dir)
        assert meta is not None
        assert meta["has_converted_pdf"] is False

    def test_pdf_document_returns_none(self, xochitl_dir):
        meta = get_epub_metadata("pdf-1234-5678", xochitl_dir)
        assert meta is None

    def test_nonexistent_uuid_returns_none(self, xochitl_dir):
        meta = get_epub_metadata("nonexistent", xochitl_dir)
        assert meta is None


class TestDiscoverEpubDocuments:
    def test_finds_epub_documents(self, xochitl_dir):
        docs = discover_epub_documents(xochitl_dir)
        epub_names = [d.visible_name for d in docs]
        assert "My EPUB Book" in epub_names
        assert "EPUB No PDF" in epub_names

    def test_excludes_pdf_documents(self, xochitl_dir):
        docs = discover_epub_documents(xochitl_dir)
        names = [d.visible_name for d in docs]
        assert "My PDF Paper" not in names

    def test_nonexistent_directory(self):
        docs = discover_epub_documents("/nonexistent/path")
        assert docs == []
