"""
EPUB annotation support for the reMarkable extraction pipeline.

The reMarkable tablet converts EPUB files to PDF internally for rendering.
Annotations are stored in .rm files just like PDF annotations, but the
.content file has fileType="epub" and the rendered PDF is stored alongside.

This module:
1. Detects EPUB-originated documents from .content metadata
2. Locates the internally-generated PDF for text correlation
3. Delegates to the standard highlight extraction pipeline

The converted PDF path follows the same UUID naming convention:
    {uuid}.pdf   -- the internally rendered PDF from the EPUB
    {uuid}/      -- per-page .rm annotation files (same as PDFs)
"""

import os
from typing import Optional

from metadata_parser import (
    ReMarkableDocument,
    parse_content_file,
    parse_metadata_file,
)


def is_epub_document(content_file_path: str) -> bool:
    """
    Check if a document is an EPUB by examining its .content file.

    Args:
        content_file_path: Path to the .content file.

    Returns:
        True if the document's fileType is "epub".
    """
    content = parse_content_file(content_file_path)
    if content is None:
        return False
    return content.file_type == "epub"


def has_converted_pdf(doc_uuid: str, xochitl_path: str) -> bool:
    """
    Check if the EPUB's internally-converted PDF exists.

    The reMarkable stores the rendered PDF at {uuid}.pdf even for EPUBs.
    If this file exists, we can extract highlights from it.

    Args:
        doc_uuid: The document's UUID.
        xochitl_path: Path to the synced xochitl directory.

    Returns:
        True if the converted PDF file exists.
    """
    pdf_path = os.path.join(xochitl_path, f"{doc_uuid}.pdf")
    return os.path.isfile(pdf_path)


def get_epub_metadata(
    doc_uuid: str,
    xochitl_path: str,
) -> Optional[dict]:
    """
    Get EPUB-specific metadata for a document.

    Returns a dict with EPUB detection info that can be included
    in the extraction result for downstream use (e.g., template rendering).

    Args:
        doc_uuid: The document's UUID.
        xochitl_path: Path to the synced xochitl directory.

    Returns:
        Dict with EPUB metadata, or None if not an EPUB.
    """
    content_path = os.path.join(xochitl_path, f"{doc_uuid}.content")
    if not os.path.exists(content_path):
        return None

    if not is_epub_document(content_path):
        return None

    has_pdf = has_converted_pdf(doc_uuid, xochitl_path)

    return {
        "is_epub": True,
        "has_converted_pdf": has_pdf,
        "original_format": "epub",
        "note": (
            "This document was originally an EPUB file. "
            "Highlights were extracted from the reMarkable's internal PDF conversion."
        ),
    }


def discover_epub_documents(xochitl_path: str) -> list[ReMarkableDocument]:
    """
    Scan the xochitl directory and return all non-deleted EPUB documents.

    EPUB documents are identified by fileType="epub" in .content.
    They follow the same extraction pipeline as PDFs since the reMarkable
    converts them to PDF internally.

    Args:
        xochitl_path: Absolute path to the synced xochitl directory.

    Returns:
        List of ReMarkableDocument objects for EPUB documents.
    """
    if not os.path.isdir(xochitl_path):
        return []

    # Use the existing discovery with EPUB filter
    from metadata_parser import discover_all_documents
    all_docs = discover_all_documents(
        xochitl_path,
        include_notebooks=False,
        include_pdfs=False,
    )
    # discover_all_documents already handles EPUBs; filter to be sure
    return [d for d in all_docs if d.doc_type == "epub"]
