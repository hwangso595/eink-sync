#!/usr/bin/env python3
"""
CLI entry point for rendering reMarkable strokes onto a PDF.

Called by the TypeScript Obsidian plugin via child_process.spawn().
Communicates results as JSON on stdout; logs/errors go to stderr.

Usage:
    # Annotate a PDF with all page strokes
    python annotate_pdf.py --xochitl-path /path --doc-uuid UUID --output /path/to/output.pdf

    # Notebook mode (no source PDF -- creates a new PDF with strokes)
    python annotate_pdf.py --xochitl-path /path --doc-uuid UUID --output /path/to/output.pdf

Output format (JSON on stdout):
    {
        "success": true,
        "output_path": "/path/to/output.pdf",
        "pages_annotated": 5,
        "total_strokes": 42,
        "doc_type": "pdf",
        "visible_name": "My Document",
        "pages_with_strokes": [1, 3, 5]
    }
"""

import argparse
import json
import os
import sys

# PyMuPDF's C library writes "MuPDF error:" messages directly to C-level
# stdout (fd 1), not Python's sys.stdout or sys.stderr.  These messages
# corrupt the JSON output that the TypeScript caller parses from stdout.
# Fix: save a copy of real stdout fd, redirect fd 1 to stderr for the
# duration of processing, and only restore it for the final JSON print.
_original_stdout_fd = os.dup(1)   # save a copy of real stdout
os.dup2(2, 1)                     # fd 1 now points to stderr

from stroke_renderer import extract_strokes, Stroke
from metadata_parser import parse_metadata_file, parse_content_file
from pdf_annotator import annotate_pdf, create_notebook_pdf


def _print_json(data: dict) -> None:
    """Print JSON result to the real stdout (not the redirected fd 1)."""
    os.dup2(_original_stdout_fd, 1)   # restore real stdout
    print(json.dumps(data, ensure_ascii=False), flush=True)
    os.dup2(2, 1)                     # re-redirect to keep things safe


def collect_page_strokes(
    xochitl_path: str,
    doc_uuid: str,
    page_uuids: list[str],
    page_redir: dict[int, int] | None = None,
    is_pdf_doc: bool = False,
) -> tuple[dict[int, list[Stroke]], list[int]]:
    """
    Extract strokes from all pages of a document.

    For PDF documents, the redir mapping (from cPages) is used to map
    each page's array index to its actual PDF page index.  Pages without
    a redir entry are user-added handwritten pages that don't correspond
    to any PDF page -- their strokes are skipped for PDF overlay mode.

    For notebooks, no redir mapping is needed; the array index is used.

    Args:
        xochitl_path: Path to the synced xochitl directory.
        doc_uuid: Document UUID.
        page_uuids: Ordered list of page UUIDs from the .content file.
        page_redir: Optional mapping from array index to PDF page index.
        is_pdf_doc: Whether this is a PDF document (affects redir handling).

    Returns:
        A tuple of (page_strokes, pages_with_strokes) where:
        - page_strokes maps 0-based PDF page index to list of Stroke objects
        - pages_with_strokes is a sorted list of 1-based page numbers with strokes
    """
    rm_dir = os.path.join(xochitl_path, doc_uuid)
    page_strokes: dict[int, list[Stroke]] = {}
    pages_with_strokes: list[int] = []

    for page_idx, page_uuid in enumerate(page_uuids):
        rm_path = os.path.join(rm_dir, f"{page_uuid}.rm")

        if not os.path.exists(rm_path):
            continue

        stat = os.stat(rm_path)
        if stat.st_size < 100:
            continue

        # Determine the target PDF page index for this page.
        if is_pdf_doc and page_redir is not None:
            if page_idx not in page_redir:
                # This is a user-added page with no PDF counterpart.
                # Skip it for PDF overlay (strokes have nowhere to go).
                print(
                    f"Page {page_idx + 1} ({page_uuid[:8]}...): skipping added page (no PDF counterpart)",
                    file=sys.stderr,
                    flush=True,
                )
                continue
            target_idx = page_redir[page_idx]
        else:
            target_idx = page_idx

        try:
            strokes = extract_strokes(rm_path)
            if strokes:
                # If multiple cPages entries map to the same PDF page,
                # merge the strokes (unlikely but defensive).
                if target_idx in page_strokes:
                    page_strokes[target_idx].extend(strokes)
                else:
                    page_strokes[target_idx] = strokes
                pdf_page_num = target_idx + 1  # 1-based for reporting
                if pdf_page_num not in pages_with_strokes:
                    pages_with_strokes.append(pdf_page_num)
                print(
                    f"Page {page_idx + 1} -> PDF page {target_idx + 1}: {len(strokes)} strokes",
                    file=sys.stderr,
                    flush=True,
                )
        except Exception as e:
            print(
                f"Error extracting strokes from page {page_idx + 1} ({page_uuid}): {e}",
                file=sys.stderr,
                flush=True,
            )

    return page_strokes, sorted(pages_with_strokes)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render reMarkable strokes onto a PDF"
    )

    parser.add_argument(
        "--xochitl-path",
        required=True,
        help="Path to the synced xochitl directory",
    )
    parser.add_argument(
        "--doc-uuid",
        required=True,
        help="Document UUID to annotate",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output PDF file path",
    )

    args = parser.parse_args()

    output: dict = {
        "success": False,
        "output_path": args.output,
        "pages_annotated": 0,
        "total_strokes": 0,
        "doc_type": "unknown",
        "visible_name": "Unknown",
        "pages_with_strokes": [],
        "errors": [],
    }

    # Read metadata
    meta_path = os.path.join(args.xochitl_path, f"{args.doc_uuid}.metadata")
    meta = parse_metadata_file(meta_path)
    if meta:
        output["visible_name"] = meta.visible_name
    else:
        output["errors"].append(f"Metadata not found: {meta_path}")

    # Read content file for page UUIDs and doc type
    content_path = os.path.join(args.xochitl_path, f"{args.doc_uuid}.content")
    content = parse_content_file(content_path)

    if not content:
        output["errors"].append(f"Content file not found: {content_path}")
        _print_json(output)
        return

    page_uuids = content.page_uuids
    if not page_uuids:
        output["errors"].append("No page UUIDs found in .content file")
        _print_json(output)
        return

    # Determine doc type
    is_pdf = content.file_type == "pdf"
    is_epub = content.file_type == "epub"
    is_notebook = (
        not content.file_type
        or content.file_type == ""
        or content.file_type == "notebook"
    )

    if is_pdf:
        output["doc_type"] = "pdf"
    elif is_epub:
        output["doc_type"] = "epub"
    else:
        output["doc_type"] = "notebook"

    # Collect strokes from all pages
    print(
        f"Collecting strokes from {len(page_uuids)} pages...",
        file=sys.stderr,
        flush=True,
    )
    page_strokes, pages_with_strokes = collect_page_strokes(
        args.xochitl_path, args.doc_uuid, page_uuids,
        page_redir=content.page_redir,
        is_pdf_doc=is_pdf or is_epub,
    )
    output["pages_with_strokes"] = pages_with_strokes

    if not page_strokes:
        output["success"] = True
        output["errors"].append("No strokes found in any page")
        _print_json(output)
        return

    total_stroke_count = sum(len(s) for s in page_strokes.values())
    print(
        f"Found {total_stroke_count} strokes across {len(page_strokes)} pages",
        file=sys.stderr,
        flush=True,
    )

    # Annotate or create PDF
    if is_pdf or is_epub:
        # Look for source PDF
        source_pdf_path = os.path.join(args.xochitl_path, f"{args.doc_uuid}.pdf")
        if not os.path.exists(source_pdf_path):
            output["errors"].append(
                f"Source PDF not found: {source_pdf_path}. "
                "Falling back to notebook mode."
            )
            # Fall back to notebook mode
            result = create_notebook_pdf(
                page_strokes, args.output, page_count=len(page_uuids),
            )
        else:
            print(
                f"Annotating source PDF: {source_pdf_path}",
                file=sys.stderr,
                flush=True,
            )
            result = annotate_pdf(source_pdf_path, page_strokes, args.output)
    else:
        # Notebook: create a new PDF
        print(
            "Creating notebook PDF...",
            file=sys.stderr,
            flush=True,
        )
        result = create_notebook_pdf(
            page_strokes, args.output, page_count=len(page_uuids),
        )

    output["success"] = result.get("success", False)
    output["pages_annotated"] = result.get("pages_annotated", 0)
    output["total_strokes"] = result.get("total_strokes", 0)

    if "error" in result:
        output["errors"].append(result["error"])

    _print_json(output)


if __name__ == "__main__":
    main()
