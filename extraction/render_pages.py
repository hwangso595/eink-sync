#!/usr/bin/env python3
import sys
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')
"""
CLI entry point for collecting reMarkable page images.

Uses the tablet's own pre-rendered cache PNGs when available (full resolution,
pixel-perfect rendering with all pen textures). Falls back to our own PNG
renderer when cache images don't exist.

Usage:
    python render_pages.py --xochitl-path /path --doc-uuid UUID --output-dir /path/to/dir

Output format (JSON on stdout):
    {
        "success": true,
        "pages": [
            {"page_number": 1, "filename": "My Document_p1.png", "has_strokes": true}
        ],
        "doc_type": "pdf",
        "visible_name": "My Document",
        "errors": []
    }
"""

import argparse
import json
import os
import shutil
import sys

# Redirect fd 1 to stderr to prevent PyMuPDF C-level stdout pollution.
_original_stdout_fd = os.dup(1)
os.dup2(2, 1)

from metadata_parser import parse_metadata_file, parse_content_file


def _print_json(data: dict) -> None:
    """Print JSON result to the real stdout."""
    os.dup2(_original_stdout_fd, 1)
    print(json.dumps(data, ensure_ascii=False), flush=True)
    os.dup2(2, 1)


def _safe_filename(name: str) -> str:
    """Sanitize a document name for use in filenames."""
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, '')
    name = ' '.join(name.split())
    for ext in ('.pdf', '.epub', '.PDF', '.EPUB'):
        if name.endswith(ext):
            name = name[:-len(ext)]
    return name.strip() or "Untitled"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect reMarkable page images (cache or rendered)"
    )
    parser.add_argument("--xochitl-path", required=True)
    parser.add_argument("--doc-uuid", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output: dict = {
        "success": False,
        "pages": [],
        "doc_type": "unknown",
        "visible_name": "Unknown",
        "errors": [],
    }

    # Read metadata
    meta_path = os.path.join(args.xochitl_path, f"{args.doc_uuid}.metadata")
    meta = parse_metadata_file(meta_path)
    if meta:
        output["visible_name"] = meta.visible_name

    # Read content file for page UUIDs
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
    is_notebook = (
        not content.file_type
        or content.file_type == ""
        or content.file_type == "notebook"
    )
    output["doc_type"] = "notebook" if is_notebook else content.file_type

    doc_name = _safe_filename(output["visible_name"])
    os.makedirs(args.output_dir, exist_ok=True)

    rm_dir = os.path.join(args.xochitl_path, args.doc_uuid)
    cache_dir = os.path.join(args.xochitl_path, f"{args.doc_uuid}.cache")
    thumb_dir = os.path.join(args.xochitl_path, f"{args.doc_uuid}.thumbnails")

    # Find source PDF for rendering strokes on top of page content
    source_pdf = None
    if not is_notebook:
        pdf_candidate = os.path.join(args.xochitl_path, f"{args.doc_uuid}.pdf")
        if os.path.exists(pdf_candidate):
            source_pdf = pdf_candidate
    has_cache = os.path.isdir(cache_dir)
    has_thumbs = os.path.isdir(thumb_dir)

    pages_collected = 0

    for page_idx, page_uuid in enumerate(page_uuids):
        page_number = page_idx + 1

        # Check if this page has any strokes (.rm file > 100 bytes)
        rm_path = os.path.join(rm_dir, f"{page_uuid}.rm")
        has_strokes = (
            os.path.exists(rm_path) and os.path.getsize(rm_path) >= 100
        )

        if not has_strokes:
            continue

        # Check if this page has actual pen drawings (not just highlights)
        from stroke_renderer import extract_strokes as _extract, HIGHLIGHTER_PEN_TYPES as _HL, ERASER_PEN_TYPES as _ER
        _page_strokes = _extract(rm_path)
        _has_pen = any(
            s.pen_type not in _HL and s.pen_type not in _ER
            for s in _page_strokes
        )
        if not _has_pen:
            print(
                f"Page {page_number}: only highlights, skipping annotation image",
                file=sys.stderr, flush=True,
            )
            continue

        # Get .rm file modification time for staleness comparison
        rm_mtime = os.path.getmtime(rm_path)

        # Include mtime hash in filename so Obsidian's image cache picks up changes.
        # Combine .rm mtime with cache/thumbnail mtime so the hash changes
        # when the tablet re-renders the page (e.g., after closing the document).
        source_mtime = int(rm_mtime)
        cache_png_path = os.path.join(cache_dir, f"{page_uuid}.png") if has_cache else ""
        thumb_png_path = os.path.join(thumb_dir, f"{page_uuid}.png") if has_thumbs else ""
        if cache_png_path and os.path.exists(cache_png_path):
            source_mtime = max(source_mtime, int(os.path.getmtime(cache_png_path)))
        elif thumb_png_path and os.path.exists(thumb_png_path):
            source_mtime = max(source_mtime, int(os.path.getmtime(thumb_png_path)))
        mtime_hash = format(source_mtime & 0xFFFF, '04x')
        filename = f"{doc_name}_p{page_number}_{mtime_hash}.png"
        out_path = os.path.join(args.output_dir, filename)

        # Clean up old versions of this page image (different hash)
        import glob
        old_pattern = os.path.join(args.output_dir, f"{doc_name}_p{page_number}_*.png")
        for old_file in glob.glob(old_pattern):
            if old_file != out_path:
                try:
                    os.remove(old_file)
                except OSError:
                    pass

        # Try 1: Tablet's own cache PNG (1404x1872, pixel-perfect)
        cache_png = os.path.join(cache_dir, f"{page_uuid}.png")
        if has_cache and os.path.exists(cache_png):
            cache_size = os.path.getsize(cache_png)
            cache_mtime = os.path.getmtime(cache_png)
            if cache_size > 1000 and cache_mtime >= rm_mtime - 2.0:
                shutil.copy2(cache_png, out_path)
                print(
                    f"Page {page_number}: tablet cache ({cache_size} bytes)",
                    file=sys.stderr, flush=True,
                )
                output["pages"].append({
                    "page_number": page_number,
                    "filename": filename,
                    "has_strokes": True,
                })
                pages_collected += 1
                continue
            else:
                print(
                    f"Page {page_number}: cache is stale ({int(rm_mtime - cache_mtime)}s behind .rm), using renderer",
                    file=sys.stderr, flush=True,
                )

        # Try 2: Tablet's thumbnail PNG (384x512, lower res but tablet-rendered)
        thumb_png = os.path.join(thumb_dir, f"{page_uuid}.png")
        if has_thumbs and os.path.exists(thumb_png):
            thumb_mtime = os.path.getmtime(thumb_png)
            if thumb_mtime >= rm_mtime - 2.0:
                shutil.copy2(thumb_png, out_path)
                print(
                    f"Page {page_number}: tablet thumbnail ({os.path.getsize(thumb_png)} bytes)",
                    file=sys.stderr, flush=True,
                )
                output["pages"].append({
                    "page_number": page_number,
                    "filename": filename,
                    "has_strokes": True,
                })
                pages_collected += 1
                continue
            else:
                print(
                    f"Page {page_number}: thumbnail is stale ({int(rm_mtime - thumb_mtime)}s behind), using renderer",
                    file=sys.stderr, flush=True,
                )

        # Try 3: Fall back to our own renderer
        try:
            from png_renderer import render_rm_file_to_png
            from stroke_renderer import extract_strokes, HIGHLIGHTER_PEN_TYPES, ERASER_PEN_TYPES

            strokes = extract_strokes(rm_path)
            # Skip pages with only highlighter/eraser strokes (no actual pen drawings)
            has_pen_strokes = any(
                s.pen_type not in HIGHLIGHTER_PEN_TYPES and s.pen_type not in ERASER_PEN_TYPES
                for s in strokes
            )
            if not has_pen_strokes:
                print(
                    f"Page {page_number}: only highlights, no pen drawings — skipping",
                    file=sys.stderr, flush=True,
                )
                continue

            if strokes:
                # Use page redirect map for correct PDF page index
                # If redir is missing for this page, it's an inserted notebook page
                # (no PDF backing) — render on white background
                page_pdf = None
                pdf_page_idx = 0
                if source_pdf and content.page_redir and page_idx in content.page_redir:
                    page_pdf = source_pdf
                    pdf_page_idx = content.page_redir[page_idx]
                drawn = render_rm_file_to_png(rm_path, out_path,
                                              pdf_path=page_pdf,
                                              page_index=pdf_page_idx)
                if drawn > 0:
                    print(
                        f"Page {page_number}: rendered {drawn} strokes",
                        file=sys.stderr, flush=True,
                    )
                    output["pages"].append({
                        "page_number": page_number,
                        "filename": filename,
                        "has_strokes": True,
                    })
                    pages_collected += 1
        except Exception as e:
            output["errors"].append(f"Page {page_number}: {e}")
            print(f"Page {page_number} error: {e}", file=sys.stderr, flush=True)

    output["success"] = True
    print(
        f"Collected {pages_collected} page(s) with strokes",
        file=sys.stderr, flush=True,
    )
    _print_json(output)


if __name__ == "__main__":
    main()
