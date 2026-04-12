#!/usr/bin/env python3
"""
CLI entry point for rendering reMarkable .rm strokes to SVG.

Called by the TypeScript Obsidian plugin via child_process.spawn().
Communicates results as JSON on stdout; logs/errors go to stderr.

Usage:
    # Render a single .rm page to SVG
    python render_strokes.py --rm-path /path/to/page.rm --output /path/to/output.svg

    # Render all pages of a notebook to SVG files in a directory
    python render_strokes.py --xochitl-path /path/to/xochitl --doc-uuid UUID --output-dir /path/to/dir

    # Render PDF annotation strokes as transparent overlay SVGs
    python render_strokes.py --xochitl-path /path/to/xochitl --doc-uuid UUID --output-dir /path/to/dir --pdf-overlay

Output format (JSON on stdout):
    {
        "success": true,
        "pages": [
            {
                "page_index": 0,
                "page_uuid": "abc-123",
                "svg_path": "/path/to/output/page-1.svg",
                "has_strokes": true,
                "stroke_count": 42
            }
        ],
        "doc_type": "notebook",
        "visible_name": "My Notebook",
        "errors": []
    }
"""

import argparse
import json
import os
import sys

from stroke_renderer import (
    extract_strokes,
    render_strokes_to_svg,
    detect_rm_format,
)
from metadata_parser import parse_metadata_file, parse_content_file


def render_single_page(rm_path: str, output_path: str, pdf_overlay: bool) -> dict:
    """Render a single .rm file to SVG and write to disk."""
    result: dict = {
        "page_index": 0,
        "page_uuid": "",
        "svg_path": output_path,
        "has_strokes": False,
        "stroke_count": 0,
    }

    try:
        strokes = extract_strokes(rm_path)
        result["stroke_count"] = len(strokes)
        result["has_strokes"] = len(strokes) > 0

        if strokes:
            svg = render_strokes_to_svg(strokes, transparent_bg=pdf_overlay)
            os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(svg)
    except Exception as e:
        result["error"] = str(e)
        print(f"Error rendering {rm_path}: {e}", file=sys.stderr, flush=True)

    return result


def render_document_pages(
    xochitl_path: str,
    doc_uuid: str,
    output_dir: str,
    pdf_overlay: bool,
) -> dict:
    """Render all pages of a document to SVG files."""
    output: dict = {
        "success": True,
        "pages": [],
        "doc_type": "unknown",
        "visible_name": "Unknown",
        "errors": [],
    }

    # Read metadata
    meta_path = os.path.join(xochitl_path, f"{doc_uuid}.metadata")
    meta = parse_metadata_file(meta_path)
    if meta:
        output["visible_name"] = meta.visible_name
    else:
        output["errors"].append(f"Metadata not found: {meta_path}")

    # Read content file once for both doc type detection and page UUIDs
    content_path = os.path.join(xochitl_path, f"{doc_uuid}.content")
    content = parse_content_file(content_path)

    if meta:
        if meta.doc_type == "DocumentType":
            if content:
                output["doc_type"] = content.file_type or "notebook"
            else:
                output["doc_type"] = "notebook"
        else:
            output["doc_type"] = meta.doc_type

    if not content:
        output["success"] = False
        output["errors"].append(f"Content file not found: {content_path}")
        return output

    page_uuids = content.page_uuids
    if not page_uuids:
        output["errors"].append("No page UUIDs found in .content file")
        return output

    # Create output directory
    os.makedirs(output_dir, exist_ok=True)

    rm_dir = os.path.join(xochitl_path, doc_uuid)

    for page_index, page_uuid in enumerate(page_uuids):
        rm_path = os.path.join(rm_dir, f"{page_uuid}.rm")

        page_result: dict = {
            "page_index": page_index,
            "page_uuid": page_uuid,
            "svg_path": None,
            "has_strokes": False,
            "stroke_count": 0,
        }

        if not os.path.exists(rm_path):
            # No annotation file for this page -- that is normal for
            # blank or unannotated pages
            output["pages"].append(page_result)
            continue

        # Output filename: page-{1-indexed}.svg
        svg_filename = f"page-{page_index + 1}.svg"
        svg_path = os.path.join(output_dir, svg_filename)

        print(
            f"Rendering page {page_index + 1}/{len(page_uuids)} ({page_uuid})",
            file=sys.stderr,
            flush=True,
        )

        try:
            strokes = extract_strokes(rm_path)
            page_result["stroke_count"] = len(strokes)
            page_result["has_strokes"] = len(strokes) > 0

            if strokes:
                svg = render_strokes_to_svg(strokes, transparent_bg=pdf_overlay)
                with open(svg_path, "w", encoding="utf-8") as f:
                    f.write(svg)
                page_result["svg_path"] = svg_path
        except Exception as e:
            page_result["error"] = str(e)
            output["errors"].append(
                f"Page {page_index + 1} ({page_uuid}): {e}"
            )
            print(f"Error on page {page_index + 1}: {e}", file=sys.stderr, flush=True)

        output["pages"].append(page_result)

    return output


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render reMarkable .rm strokes to SVG"
    )

    # Single-page mode
    parser.add_argument(
        "--rm-path",
        default=None,
        help="Path to a single .rm file to render",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output SVG file path (single-page mode)",
    )

    # Document mode
    parser.add_argument(
        "--xochitl-path",
        default=None,
        help="Path to the synced xochitl directory",
    )
    parser.add_argument(
        "--doc-uuid",
        default=None,
        help="Document UUID to render all pages from",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory to write SVG files into (document mode)",
    )

    # Options
    parser.add_argument(
        "--pdf-overlay",
        action="store_true",
        default=False,
        help="Render with transparent background for PDF overlay",
    )

    args = parser.parse_args()

    result: dict

    if args.rm_path and args.output:
        # Single-page mode
        page = render_single_page(args.rm_path, args.output, args.pdf_overlay)
        result = {
            "success": "error" not in page,
            "pages": [page],
            "doc_type": "unknown",
            "visible_name": "Single Page",
            "errors": [],
        }
        if "error" in page:
            result["errors"].append(page["error"])

    elif args.xochitl_path and args.doc_uuid and args.output_dir:
        # Document mode
        result = render_document_pages(
            args.xochitl_path,
            args.doc_uuid,
            args.output_dir,
            args.pdf_overlay,
        )

    else:
        result = {
            "success": False,
            "pages": [],
            "doc_type": "unknown",
            "visible_name": "",
            "errors": [
                "Usage: provide --rm-path + --output for single page, "
                "or --xochitl-path + --doc-uuid + --output-dir for full document"
            ],
        }

    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
