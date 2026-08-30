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
pages whose content, background, template, and render settings are unchanged.

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
import glob
import hashlib
import json
import os
import sys

# Redirect fd 1 to stderr to prevent PyMuPDF C-level stdout pollution.
_original_stdout_fd = os.dup(1)
os.dup2(2, 1)

from metadata_parser import parse_metadata_file, parse_content_file
from png_renderer import (
    PNG_RENDERER_VERSION,
    extract_highlight_texts,
    render_rm_file_to_png,
)
from stroke_renderer import extract_strokes, extract_glyph_highlights
from template_renderer import TEMPLATE_RENDERER_VERSION
from page_geometry import read_page_geometry


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
    tj = _contained_template_file(templates_dir, "templates.json")
    if not tj:
        return {}
    try:
        with open(tj, "r", encoding="utf-8") as f:
            data = json.load(f)
        mapping = {}
        entries = data.get("templates", []) if isinstance(data, dict) else []
        for t in entries if isinstance(entries, list) else []:
            if not isinstance(t, dict):
                continue
            name = t.get("name")
            filename = t.get("filename", name)
            if isinstance(name, str) and name and isinstance(filename, str):
                mapping[name] = filename
        return mapping
    except Exception:
        return {}


def _contained_template_file(templates_dir: str, candidate: object):
    """Return a regular template file contained in ``templates_dir``.

    Template names originate on the tablet. Reject traversal, Windows-special
    names, control characters, and symlinks before opening any candidate on the
    host filesystem.
    """
    if not templates_dir or not isinstance(candidate, str) or not candidate:
        return None
    if (
        candidate in (".", "..")
        or any(ord(ch) < 32 or ord(ch) == 127 for ch in candidate)
        or any(ch in '<>:"/\\|?*' for ch in candidate)
        or candidate.endswith((".", " "))
        or os.path.isabs(candidate)
        or os.path.splitdrive(candidate)[0]
    ):
        return None

    root = os.path.realpath(templates_dir)
    joined = os.path.join(root, candidate)
    if os.path.islink(joined):
        return None
    target = os.path.realpath(joined)
    try:
        contained = os.path.normcase(os.path.commonpath((root, target))) == os.path.normcase(root)
    except ValueError:
        return None
    return target if contained and os.path.isfile(target) else None


def _resolve_template_png(templates_dir: str, name: str, name_map: dict):
    """Resolve a page's template name to PNG art shipped by older firmware.

    "Blank"/empty names have no background (matched case-insensitively and
    trimmed, so "blank"/"Blank " count too). Tries the templates.json filename
    first, then the display name. Firmware 3.x ships no PNGs at all -- see
    _resolve_template_source for the vector format.
    """
    if not templates_dir or not name:
        return None
    normalized = name.strip()
    if not normalized or normalized.lower() == "blank":
        return None
    stem = name_map.get(name) or name_map.get(normalized) or normalized

    for candidate in (f"{stem}.png", f"{normalized}.png"):
        resolved = _contained_template_file(templates_dir, candidate)
        if resolved:
            return resolved

    return None


def _resolve_template_source(templates_dir: str, name: str, name_map: dict):
    """Resolve a page's template to (png_art, template_definition).

    Older firmware ships PNG art, which is drawn as-is. Firmware 3.x ships
    `.template` vector definitions, while some firmware/device combinations
    ship legacy SVG art. Vector sources are rasterized once the canvas size is
    known; `.template` definitions can also extend over scrolled pages.
    """
    png = _resolve_template_png(templates_dir, name, name_map)
    if png:
        return png, None
    if not templates_dir or not name:
        return None, None
    normalized = name.strip()
    if not normalized or normalized.lower() == "blank":
        return None, None
    stem = name_map.get(name) or name_map.get(normalized) or normalized
    for extension in (".template", ".svg"):
        for candidate in (f"{stem}{extension}", f"{normalized}{extension}"):
            resolved = _contained_template_file(templates_dir, candidate)
            if resolved:
                return None, resolved
    return None, None


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


def _file_digest(path: str, digest_cache: dict | None = None) -> str:
    """Hash a render input, memoized by stable file metadata for this run."""
    resolved = os.path.realpath(path)
    stat = os.stat(resolved)
    cache_key = (resolved, stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
    if digest_cache is not None and cache_key in digest_cache:
        return digest_cache[cache_key]

    digest = hashlib.sha256()
    with open(resolved, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    value = digest.hexdigest()
    if digest_cache is not None:
        digest_cache[cache_key] = value
    return value


def _page_render_fingerprint(
    rm_path: str,
    page_pdf: str | None,
    pdf_page_idx: int,
    page_template: str | None,
    template_asset: str | None,
    settings: dict,
    digest_cache: dict | None = None,
) -> str:
    """Return a content key for every input that can affect page pixels/text."""
    template = {
        "name": page_template or "",
        "asset": os.path.basename(template_asset) if template_asset else None,
        "digest": _file_digest(template_asset, digest_cache) if template_asset else None,
    }
    payload = {
        "rm": _file_digest(rm_path, digest_cache),
        "pdf": _file_digest(page_pdf, digest_cache) if page_pdf else None,
        "pdf_page": int(pdf_page_idx) if page_pdf else None,
        "template": template,
        "settings": settings,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _page_image_filename(doc_name: str, page_number: int, input_fingerprint: str) -> str:
    """Build an Obsidian-cache-busting filename from the full render key."""
    return f"{doc_name}_p{page_number}_{input_fingerprint[:16]}.png"


def _cache_entry_fresh(cached, filename: str, input_fingerprint: str, out_path: str) -> bool:
    """True when a cached page entry matches all current render inputs."""
    return bool(
        cached
        and cached.get("filename") == filename
        and cached.get("input_fingerprint") == input_fingerprint
        and os.path.exists(out_path)
    )


def _cleanup_old_page_images(output_dir: str, doc_name: str, page_number: int, keep: str) -> None:
    """Remove superseded cache-busted images only after a usable image exists."""
    pattern = os.path.join(
        output_dir, f"{glob.escape(doc_name)}_p{page_number}_*.png",
    )
    for old_file in glob.glob(pattern):
        if old_file != keep:
            try:
                os.remove(old_file)
            except OSError:
                pass


def _cleanup_page_images_after_success(
    rendered_pages: list[tuple[str, str, int, str]], errors: list[str],
) -> None:
    """Defer destructive cleanup until every page in the document succeeded."""
    if errors:
        return
    for output_dir, doc_name, page_number, keep in rendered_pages:
        _cleanup_old_page_images(output_dir, doc_name, page_number, keep)


def _save_render_cache(cache_path: str, settings: dict, pages: dict) -> None:
    """Atomically persist the per-doc render cache (best-effort)."""
    try:
        tmp_path = f"{cache_path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump({"settings": settings, "pages": pages}, f, ensure_ascii=False)
        os.replace(tmp_path, cache_path)
    except OSError:
        pass


def _render_cache_settings(truncate_blank: bool, templates_enabled: bool) -> dict:
    """Return every setting/version that can change rendered page pixels."""
    return {
        "truncate_blank": truncate_blank,
        "templates": templates_enabled,
        "template_renderer": TEMPLATE_RENDERER_VERSION,
        "png_renderer": PNG_RENDERER_VERSION,
    }


def _ocr_cache_key(language: str) -> str:
    """Identify OCR output without changing the rendered-pixel cache key."""
    return f"ocr-v1:{language}"


def _resolve_cached_ocr(
    cached: dict,
    out_path: str,
    ocr_page_image,
    language: str,
    timeout_seconds: float,
):
    """Reuse OCR only for the requested language; retry failures and misses."""
    if ocr_page_image is None:
        return None

    ocr_key = _ocr_cache_key(language)
    ocr_text = (
        cached.get("ocr_text")
        if cached.get("ocr_key") == ocr_key
        else None
    )
    if ocr_text is None:
        ocr_text = ocr_page_image(
            out_path, language, timeout_seconds=timeout_seconds,
        )
        cached["ocr_key"] = ocr_key
        cached["ocr_text"] = ocr_text
    return ocr_text


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
    # Directory of reMarkable PNG/SVG/.template assets (+ templates.json).
    # When given, a notebook page's template is drawn behind its strokes.
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
    cache_settings = _render_cache_settings(truncate_blank, bool(templates_dir))
    render_cache_path = os.path.join(
        args.output_dir, f".render-cache-{args.doc_uuid}.json"
    )
    render_cache = _load_render_cache(render_cache_path, cache_settings)
    new_cache: dict = {}

    pages_collected = 0
    digest_cache: dict = {}
    rendered_page_images: list[tuple[str, str, int, str]] = []

    for page_idx, page_uuid in enumerate(page_uuids):
        page_number = page_idx + 1

        # Check if this page has any strokes (.rm file > 100 bytes)
        rm_path = os.path.join(rm_dir, f"{page_uuid}.rm")
        has_strokes = (
            os.path.exists(rm_path) and os.path.getsize(rm_path) >= 100
        )

        if not has_strokes:
            continue

        try:
            page_template = (
                content.page_templates[page_idx]
                if page_idx < len(content.page_templates) else None
            )

            # Resolve PDF redirects before checking the cache: both the backing
            # file and redirected page index affect pixels and extracted text.
            # A page with no redirect is an inserted notebook page.
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

            background_png = None
            background_template = None
            if page_pdf is None and templates_dir and page_template:
                background_png, background_template = _resolve_template_source(
                    templates_dir, page_template, template_map,
                )

            input_fingerprint = _page_render_fingerprint(
                rm_path,
                page_pdf,
                pdf_page_idx,
                page_template if page_pdf is None else None,
                background_png or background_template,
                cache_settings,
                digest_cache,
            )
            filename = _page_image_filename(doc_name, page_number, input_fingerprint)
            out_path = os.path.join(args.output_dir, filename)

            # Reuse the previous render when every byte/setting that can affect
            # it is unchanged. OCR may still run when it never succeeded.
            cached = render_cache.get(page_uuid)
            if _cache_entry_fresh(cached, filename, input_fingerprint, out_path):
                # Cached OCR text is only reported while OCR is switched on.
                ocr_text = _resolve_cached_ocr(
                    cached,
                    out_path,
                    ocr_page_image,
                    args.ocr_lang,
                    args.ocr_page_timeout,
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
                rendered_page_images.append(
                    (args.output_dir, doc_name, page_number, out_path),
                )
                continue

            geometry = read_page_geometry(rm_path)
            # PDF annotations use a shared logical grid; SceneInfo determines
            # how that grid maps onto each device's canvas. Notebook and
            # inserted pages are already stored in page pixels.
            doc_coord_scale = geometry.pdf_coord_scale if page_pdf else 1.0

            strokes = extract_strokes(rm_path)
            glyph_hls = extract_glyph_highlights(rm_path)

            if strokes or glyph_hls:
                drawn = render_rm_file_to_png(rm_path, out_path,
                                              pdf_path=page_pdf,
                                              page_index=pdf_page_idx,
                                              coord_scale=doc_coord_scale,
                                              truncate_blank=truncate_blank,
                                              background_png=background_png,
                                              background_template=background_template,
                                              canvas_width=geometry.width,
                                              canvas_height=geometry.height)
                if drawn > 0 or glyph_hls:
                    print(
                        f"Page {page_number}: rendered {drawn} strokes, {len(glyph_hls)} glyph highlight(s)",
                        file=sys.stderr, flush=True,
                    )
                    # Keep the redirect-aware stroke-highlight fallback. The
                    # main extractor owns glyph selections and most strokes;
                    # TypeScript removes any duplicate `(page, text)` while
                    # favoring its richer RGBA/bounds result.
                    highlight_texts = []
                    if page_pdf and strokes:
                        highlight_texts.extend(extract_highlight_texts(
                            strokes, page_pdf, pdf_page_idx,
                            canvas_w=geometry.width,
                            canvas_h=geometry.height,
                            coord_scale=doc_coord_scale,
                        ))

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
                        "input_fingerprint": input_fingerprint,
                        "highlight_texts": highlight_texts,
                        "ocr_key": (
                            _ocr_cache_key(args.ocr_lang)
                            if ocr_page_image is not None else None
                        ),
                        "ocr_text": ocr_text_raw,
                    }
                    pages_collected += 1
                    rendered_page_images.append(
                        (args.output_dir, doc_name, page_number, out_path),
                    )
        except Exception as e:
            output["errors"].append(f"Page {page_number}: {e}")
            print(f"Page {page_number} error: {e}", file=sys.stderr, flush=True)

    output["success"] = not output["errors"]
    _cleanup_page_images_after_success(rendered_page_images, output["errors"])
    _save_render_cache(render_cache_path, cache_settings, new_cache)
    print(
        f"Collected {pages_collected} page(s) with strokes",
        file=sys.stderr, flush=True,
    )
    _print_json(output)


if __name__ == "__main__":
    main()
