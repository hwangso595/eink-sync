#!/usr/bin/env python3
import sys
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')
"""
CLI entry point for collecting reMarkable page images.

Renders each page's strokes to PNG with our own renderer (tablet
.cache/.thumbnails PNGs are ignored: lower fidelity, and their mtimes churn
on every page view). A per-doc render cache next to the output images skips
pages whose .rm file hasn't changed since the last run.

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
import sys

# Redirect fd 1 to stderr to prevent PyMuPDF C-level stdout pollution.
_original_stdout_fd = os.dup(1)
os.dup2(2, 1)

from metadata_parser import parse_metadata_file, parse_content_file
from png_renderer import render_rm_file_to_png, extract_highlight_texts, extract_glyph_highlight_texts
from stroke_renderer import extract_strokes, extract_glyph_highlights, HIGHLIGHTER_PEN_TYPES, ERASER_PEN_TYPES


def _print_json(data: dict) -> None:
    """Print JSON result to the real stdout."""
    os.dup2(_original_stdout_fd, 1)
    print(json.dumps(data, ensure_ascii=False), flush=True)
    os.dup2(2, 1)


def _load_template_map(templates_dir: str) -> dict:
    """Map reMarkable template display-name -> file stem, from templates.json.

    Falls back to an empty map (callers then assume the file stem equals the
    display name) when templates.json is absent or unreadable.
    """
    if not templates_dir:
        return {}
    tj = os.path.join(templates_dir, "templates.json")
    if not os.path.exists(tj):
        return {}
    try:
        with open(tj, "r", encoding="utf-8") as f:
            data = json.load(f)
        mapping = {}
        for t in data.get("templates", []):
            name = t.get("name")
            if name:
                mapping[name] = t.get("filename", name)
        return mapping
    except Exception:
        return {}


def _resolve_template_png(templates_dir: str, name: str, name_map: dict):
    """Resolve a page's template name to a PNG path, or None.

    "Blank"/empty names have no background (matched case-insensitively and
    trimmed, so "blank"/"Blank " count too). Tries the templates.json filename
    first, then the display name, each with a .png extension.
    """
    if not templates_dir or not name:
        return None
    normalized = name.strip()
    if not normalized or normalized.lower() == "blank":
        return None
    stem = name_map.get(name) or name_map.get(normalized) or normalized
    for candidate in (f"{stem}.png", f"{normalized}.png"):
        path = os.path.join(templates_dir, candidate)
        if os.path.exists(path):
            return path
    return None


def _safe_filename(name: str) -> str:
    """Sanitize a document name for use in filenames."""
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, '')
    name = ' '.join(name.split())
    for ext in ('.pdf', '.epub', '.PDF', '.EPUB'):
        if name.endswith(ext):
            name = name[:-len(ext)]
    return name.strip() or "Untitled"


def _load_render_cache(cache_path: str, settings: dict) -> dict:
    """Load the per-doc render cache; discard it when render settings changed."""
    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("settings") == settings and isinstance(data.get("pages"), dict):
            return data["pages"]
    except (OSError, ValueError):
        pass
    return {}


def _cache_entry_fresh(cached, filename: str, rm_mtime: int, template, out_path: str) -> bool:
    """True when a cached page entry still matches the current render inputs.

    The filename encodes doc name, page position, and .rm mtime; the template
    name is checked separately because a template switch rewrites .content
    without touching the page's .rm.
    """
    return bool(
        cached
        and cached.get("filename") == filename
        and cached.get("rm_mtime") == rm_mtime
        and cached.get("template") == template
        and os.path.exists(out_path)
    )


def _save_render_cache(cache_path: str, settings: dict, pages: dict) -> None:
    """Atomically persist the per-doc render cache (best-effort)."""
    try:
        tmp_path = f"{cache_path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump({"settings": settings, "pages": pages}, f, ensure_ascii=False)
        os.replace(tmp_path, cache_path)
    except OSError:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render reMarkable page images to PNG"
    )
    parser.add_argument("--xochitl-path", required=True)
    parser.add_argument("--doc-uuid", required=True)
    parser.add_argument("--output-dir", required=True)
    # Collision-resolved output base name supplied by the caller. When two
    # documents share a visible name the caller disambiguates them (e.g.
    # "Quick sheets (f6d11d23)") so their page images don't overwrite each
    # other. Falls back to the sanitized visible name when omitted.
    parser.add_argument("--doc-name", default=None)
    # Crop trailing blank space on short notebook/quick-sheet pages.
    parser.add_argument("--truncate-blank", action="store_true")
    # Run local OCR on notebook page images so handwriting becomes searchable.
    parser.add_argument("--ocr", action="store_true")
    parser.add_argument("--ocr-lang", default="eng")
    # Per-page OCR time budget (seconds). A page that exceeds it loses its OCR
    # text but still renders; 0 disables the limit.
    parser.add_argument("--ocr-page-timeout", type=float, default=12.0)
    # Directory of reMarkable page-template PNGs (+ templates.json). When given,
    # a notebook page's template is drawn behind its strokes.
    parser.add_argument("--templates-dir", default=None)
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

    # Prefer the caller-supplied, collision-resolved base name verbatim so the
    # page images line up with the note filename; fall back to sanitizing the
    # visible name when the caller didn't provide one.
    doc_name = args.doc_name if args.doc_name else _safe_filename(output["visible_name"])
    os.makedirs(args.output_dir, exist_ok=True)

    rm_dir = os.path.join(args.xochitl_path, args.doc_uuid)

    # Find source PDF for rendering strokes on top of page content
    source_pdf = None
    if not is_notebook:
        pdf_candidate = os.path.join(args.xochitl_path, f"{args.doc_uuid}.pdf")
        if os.path.exists(pdf_candidate):
            source_pdf = pdf_candidate

    # Truncation only makes sense for notebook pages (PDF pages have fixed
    # geometry tied to their background).
    truncate_blank = args.truncate_blank and is_notebook

    # Resolve page-template art for notebook pages (drawn behind strokes).
    templates_dir = args.templates_dir if (args.templates_dir and os.path.isdir(args.templates_dir)) else None
    template_map = _load_template_map(templates_dir)

    # Set up local OCR for notebook pages when requested and available. A missing
    # Tesseract binary is not an error -- OCR text is just omitted.
    ocr_page_image = None
    if args.ocr and is_notebook:
        try:
            from ocr_engine import is_ocr_available, ocr_page_image as _ocr
            if is_ocr_available():
                ocr_page_image = _ocr
            else:
                print("OCR requested but Tesseract is unavailable; skipping handwriting text.",
                      file=sys.stderr, flush=True)
        except Exception as e:
            print(f"OCR setup failed: {e}", file=sys.stderr, flush=True)

    # Per-doc render cache: skip re-rendering pages whose .rm is unchanged.
    # Keyed by page UUID and invalidated wholesale when pixel-affecting
    # settings change. Lives next to the page images as a dotfile so Obsidian
    # ignores it (and Syncthing shares it between machines).
    cache_settings = {
        "truncate_blank": truncate_blank,
        "templates": bool(templates_dir),
    }
    render_cache_path = os.path.join(
        args.output_dir, f".render-cache-{args.doc_uuid}.json"
    )
    render_cache = _load_render_cache(render_cache_path, cache_settings)
    new_cache: dict = {}

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

        # Get .rm file modification time for staleness comparison
        rm_mtime = os.path.getmtime(rm_path)

        # Include an .rm-mtime hash in the filename so Obsidian's image cache
        # picks up changes; an unchanged page keeps a stable name. (Tablet
        # .cache/.thumbnails PNGs are deliberately ignored: our renderer
        # produces higher-resolution output including glyph highlights, and
        # their mtimes churn on every page view.)
        mtime_hash = format(int(rm_mtime) & 0xFFFF, '04x')
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

        page_template = (
            content.page_templates[page_idx]
            if page_idx < len(content.page_templates) else None
        )

        # Reuse the previous render when the page is unchanged. OCR may still
        # run on the existing image when it never succeeded (ocr_text None:
        # OCR just enabled, Tesseract newly installed, or a previous attempt
        # failed/timed out).
        cached = render_cache.get(page_uuid)
        if _cache_entry_fresh(cached, filename, int(rm_mtime), page_template, out_path):
            ocr_text = cached.get("ocr_text")
            if ocr_text is None and ocr_page_image is not None:
                ocr_text = ocr_page_image(
                    out_path, args.ocr_lang, timeout_seconds=args.ocr_page_timeout,
                )
                cached["ocr_text"] = ocr_text
                if ocr_text:
                    print(
                        f"Page {page_number}: OCR recognized {len(ocr_text)} char(s) (cached image)",
                        file=sys.stderr, flush=True,
                    )
            output["pages"].append({
                "page_number": page_number,
                "filename": filename,
                "has_strokes": True,
                "highlight_texts": cached.get("highlight_texts", []),
                "ocr_text": ocr_text or "",
            })
            new_cache[page_uuid] = cached
            pages_collected += 1
            continue

        try:
            # PDF documents use 300-DPI logical coordinates; notebooks use 1:1 pixels.
            doc_coord_scale = 0.73 if not is_notebook else 1.0

            strokes = extract_strokes(rm_path)
            glyph_hls = extract_glyph_highlights(rm_path)

            if strokes or glyph_hls:
                # Use page redirect map for correct PDF page index
                # If redir is missing for this page, it's an inserted notebook page
                # (no PDF backing) — render on white background
                page_pdf = None
                pdf_page_idx = 0
                if source_pdf:
                    if content.page_redir is not None:
                        if page_idx in content.page_redir:
                            page_pdf = source_pdf
                            pdf_page_idx = content.page_redir[page_idx]
                    else:
                        page_pdf = source_pdf
                        pdf_page_idx = page_idx
                # Notebook pages (no PDF backing) get their reMarkable template
                # drawn behind the strokes when template art is available.
                background_png = None
                if page_pdf is None and templates_dir and page_template:
                    background_png = _resolve_template_png(
                        templates_dir, page_template, template_map,
                    )

                drawn = render_rm_file_to_png(rm_path, out_path,
                                              pdf_path=page_pdf,
                                              page_index=pdf_page_idx,
                                              coord_scale=doc_coord_scale,
                                              truncate_blank=truncate_blank,
                                              background_png=background_png)
                if drawn > 0 or glyph_hls:
                    print(
                        f"Page {page_number}: rendered {drawn} strokes, {len(glyph_hls)} glyph highlight(s)",
                        file=sys.stderr, flush=True,
                    )
                    # Glyph highlight text is already extracted by highlight_extractor.py
                    # via the Python bridge — skip it here to avoid duplicates.
                    # Only extract text under stroke-based highlights (PDF pages only),
                    # which highlight_extractor.py does NOT handle.
                    highlight_texts = []
                    if page_pdf and strokes:
                        stroke_hl_texts = extract_highlight_texts(
                            strokes, page_pdf, pdf_page_idx,
                            coord_scale=doc_coord_scale,
                        )
                        highlight_texts.extend(stroke_hl_texts)
                    if highlight_texts:
                        print(
                            f"Page {page_number}: {len(highlight_texts)} highlighted text(s)",
                            file=sys.stderr, flush=True,
                        )

                    # Local OCR of the rendered handwriting (notebook pages
                    # only). None = not attempted or failed — retried next run.
                    ocr_text_raw = None
                    if ocr_page_image is not None:
                        ocr_text_raw = ocr_page_image(
                            out_path, args.ocr_lang,
                            timeout_seconds=args.ocr_page_timeout,
                        )
                        if ocr_text_raw:
                            print(
                                f"Page {page_number}: OCR recognized {len(ocr_text_raw)} char(s)",
                                file=sys.stderr, flush=True,
                            )

                    output["pages"].append({
                        "page_number": page_number,
                        "filename": filename,
                        "has_strokes": True,
                        "highlight_texts": highlight_texts,
                        "ocr_text": ocr_text_raw or "",
                    })
                    new_cache[page_uuid] = {
                        "filename": filename,
                        "rm_mtime": int(rm_mtime),
                        "template": page_template,
                        "highlight_texts": highlight_texts,
                        "ocr_text": ocr_text_raw,
                    }
                    pages_collected += 1
        except Exception as e:
            output["errors"].append(f"Page {page_number}: {e}")
            print(f"Page {page_number} error: {e}", file=sys.stderr, flush=True)

    output["success"] = True
    _save_render_cache(render_cache_path, cache_settings, new_cache)
    print(
        f"Collected {pages_collected} page(s) with strokes",
        file=sys.stderr, flush=True,
    )
    _print_json(output)


if __name__ == "__main__":
    main()
