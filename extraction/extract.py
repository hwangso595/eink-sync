#!/usr/bin/env python3
"""
Main entry point for the reMarkable highlight extraction pipeline.
"""
import sys
import os

# Force UTF-8 stdout on Windows to handle Unicode characters (θ, etc.)
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

"""

Called by the TypeScript Obsidian plugin via child_process.spawn().
Communicates results as JSON on stdout; logs/errors go to stderr.

Usage:
    python extract.py --xochitl-path /path/to/xochitl [--doc-uuid UUID] [--since TIMESTAMP]

Modes:
    1. Full scan: Discover all PDF documents and extract highlights from each.
       python extract.py --xochitl-path /path/to/xochitl

    2. Single document: Extract highlights from one specific document.
       python extract.py --xochitl-path /path/to/xochitl --doc-uuid abc-123

    3. Incremental: Only process documents modified after a timestamp.
       python extract.py --xochitl-path /path/to/xochitl --since 1700000000000

Output format (JSON on stdout):
    {
        "success": true,
        "documents": [
            {
                "uuid": "abc-123",
                "visible_name": "My Paper",
                "folder_path": "Papers/ML",
                "doc_type": "pdf",
                "last_modified": 1700000000000,
                "page_count": 42,
                "has_pdf": true,
                "highlights": [
                    {
                        "text": "The highlighted text",
                        "page_number": 5,
                        "color": "yellow",
                        "bounds": {"x": 72, "y": 100, "width": 400, "height": 14},
                        "created_at": null
                    }
                ],
                "warnings": [],
                "error": null
            }
        ],
        "errors": []
    }
"""

import argparse
import json
import sys
import traceback
from dataclasses import asdict

from metadata_parser import discover_documents, discover_all_documents
from highlight_extractor import extract_highlights_for_document, extract_highlights_for_document_auto
from epub_support import get_epub_metadata


def extract_single_document(
    doc: object, xochitl_path: str
) -> dict:
    """
    Extract highlights from a single document and return a result dict.

    Non-fatal errors are captured in the warnings list rather than raising.
    Fatal errors for this document are captured in the error field.
    """
    result: dict = {
        "uuid": doc.uuid,
        "visible_name": doc.visible_name,
        "folder_path": doc.folder_path,
        "doc_type": doc.doc_type,
        "last_modified": doc.last_modified,
        "page_count": doc.page_count,
        "has_pdf": doc.has_pdf,
        "highlights": [],
        "warnings": [],
        "error": None,
        "tags": doc.tags,
        "page_tags": doc.page_tags,
    }

    # Annotate EPUB-originated documents with extra metadata
    epub_meta = get_epub_metadata(doc.uuid, xochitl_path)
    if epub_meta:
        result["epub_metadata"] = epub_meta

    if not doc.has_pdf:
        result["error"] = "Source PDF not found in synced directory"
        return result

    if not doc.page_uuids:
        result["warnings"].append("No page UUIDs found in .content file")
        return result

    try:
        # Use format-aware extraction that auto-detects v6 vs v3/v5 per page
        highlights, warnings = extract_highlights_for_document_auto(
            doc.uuid, doc.page_uuids, xochitl_path
        )
        result["highlights"] = [asdict(h) for h in highlights]
        result["warnings"] = warnings
    except ImportError as e:
        # Graceful degradation: fall back to v6-only extraction if legacy
        # parser is unavailable
        try:
            highlights, warnings = extract_highlights_for_document(
                doc.uuid, doc.page_uuids, xochitl_path
            )
            result["highlights"] = [asdict(h) for h in highlights]
            result["warnings"] = warnings
            result["warnings"].append(
                f"Legacy parser unavailable ({e}); used v6-only extraction"
            )
        except ImportError as e2:
            result["error"] = str(e2)
    except Exception as e:
        result["error"] = f"Extraction failed: {e}"
        result["warnings"].append(traceback.format_exc())

    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract PDF highlights from reMarkable xochitl files"
    )
    parser.add_argument(
        "--xochitl-path",
        required=True,
        help="Path to the synced xochitl directory",
    )
    parser.add_argument(
        "--doc-uuid",
        action="append",
        dest="doc_uuids",
        default=None,
        help="Restrict extraction to this document UUID. May be repeated to "
             "select multiple documents. When omitted, all documents are processed.",
    )
    parser.add_argument(
        "--since",
        type=int,
        default=None,
        help="Only process documents modified after this epoch-ms timestamp",
    )
    parser.add_argument(
        "--include-epub",
        action="store_true",
        default=False,
        help="Include EPUB documents (extracted from internal PDF conversion)",
    )
    args = parser.parse_args()

    output: dict = {
        "success": True,
        "documents": [],
        "errors": [],
    }

    try:
        # Discover documents (PDFs, and optionally EPUBs)
        if args.include_epub:
            documents = discover_all_documents(
                args.xochitl_path,
                include_notebooks=False,
                include_pdfs=True,
            )
        else:
            documents = discover_documents(args.xochitl_path)

        if not documents:
            print(json.dumps(output), flush=True)
            return

        # Filter by UUID(s) if specified. A full run passes every discovered
        # UUID; a targeted "extract selected" run passes just the chosen ones.
        # Miss-detection for an explicit selection is handled by the TypeScript
        # pipeline, which alone knows whether the caller requested specific docs.
        if args.doc_uuids:
            wanted = set(args.doc_uuids)
            documents = [d for d in documents if d.uuid in wanted]
            if not documents:
                print(json.dumps(output, ensure_ascii=False), flush=True)
                return

        # Filter by timestamp if specified
        if args.since is not None:
            documents = [d for d in documents if d.last_modified > args.since]

        # Extract highlights from each document
        for doc in documents:
            print(
                f"Processing: {doc.visible_name} ({doc.uuid})",
                file=sys.stderr,
                flush=True,
            )
            doc_result = extract_single_document(doc, args.xochitl_path)
            output["documents"].append(doc_result)

    except Exception as e:
        output["success"] = False
        output["errors"].append(f"Pipeline error: {e}")
        print(traceback.format_exc(), file=sys.stderr, flush=True)

    # JSON output on stdout for TypeScript to parse
    print(json.dumps(output, ensure_ascii=False), flush=True)

    # A logical pipeline failure exits non-zero as a second failure signal, in
    # addition to success:false in the JSON, so the bridge cannot miss it even
    # if stdout parsing changes.
    if not output["success"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
