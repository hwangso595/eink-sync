"""
Extract PDF text highlights from .rm files and correlate with PDF text content
using PyMuPDF.

Supports two extraction paths:

1. **v6 format (firmware 3.0+):** Uses rmscene to parse GlyphRange blocks.
   - Firmware >= 3.26: GlyphRange includes .text directly (preferred).
   - Firmware < 3.26: GlyphRange has only rectangles + offsets.
     Character offset fallback is UNRELIABLE (12-17 char deltas observed).
     Instead, uses rectangle-based text extraction via PyMuPDF word bounding
     boxes overlapping the highlight rectangles.

2. **Legacy v3/v5 format (firmware < 3.0):** Uses legacy_rm_parser to extract
   highlighter stroke bounding boxes, then rectangle-based text extraction.

Accuracy target: >= 95% for standard text highlights on non-scanned PDFs.
"""

import os
import sys
from dataclasses import dataclass
from typing import Optional

from constants import RM_SCREEN_WIDTH, RM_SCREEN_HEIGHT

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None  # type: ignore[assignment]

try:
    from rmscene import read_blocks
    from rmscene.scene_items import GlyphRange, Line, ParagraphStyle
    from rmscene import scene_items as si
except ImportError:
    read_blocks = None  # type: ignore[assignment]
    Line = None  # type: ignore[assignment]

try:
    from legacy_rm_parser import parse_legacy_rm_file, LegacyHighlightRegion
except ImportError:
    parse_legacy_rm_file = None  # type: ignore[assignment]
    LegacyHighlightRegion = None  # type: ignore[assignment]

from highlight_merger import merge_fragmented_highlights
from stroke_renderer import HIGHLIGHTER_PEN_TYPES


@dataclass
class ExtractedHighlight:
    """A single highlight extracted from a PDF annotation layer."""

    text: str
    page_number: int  # 1-indexed
    color: Optional[str]
    bounds: Optional[dict]  # {x, y, width, height} in PDF coordinates
    created_at: Optional[int]  # Epoch milliseconds, if available


def _color_id_to_name(color_id: int) -> str:
    """
    Map rmscene color IDs to human-readable color names.

    The color IDs used in GlyphRange correspond to the reMarkable highlighter
    colors. These mappings are based on observed values in v6 .rm files.
    """
    color_map = {
        0: "black",
        1: "gray",
        2: "white",
        3: "yellow",
        4: "green",
        5: "pink",
        6: "blue",
        7: "red",
        8: "gray_overlap",
        9: "yellow",  # PenColor.HIGHLIGHT — default highlighter color
    }
    return color_map.get(color_id, f"unknown_{color_id}")


def _extract_highlights_from_rm_file(rm_path: str) -> list[dict]:
    """
    Parse a single .rm file and extract GlyphRange highlight blocks.

    Returns a list of dicts with keys: start, length, color, rects.
    Each dict represents one highlighted span from the .rm scene data.
    """
    if read_blocks is None:
        raise ImportError(
            "rmscene is required for v6 .rm parsing. "
            "Install with: pip install rmscene"
        )

    highlights: list[dict] = []

    try:
        with open(rm_path, "rb") as f:
            blocks = list(read_blocks(f))
    except Exception as e:
        # rmscene gracefully handles unknown blocks as UnreadableBlock,
        # but truly malformed files will raise exceptions
        raise ValueError(f"Failed to parse .rm file: {rm_path}: {e}") from e

    for block in blocks:
        # In rmscene, text highlights are stored as GlyphRange items
        # within SceneLineItemBlock or as part of text block structures.
        # We need to walk the block tree to find highlight data.
        _collect_glyph_ranges(block, highlights)

    return highlights


def _glyph_range_to_dict(gr: "GlyphRange") -> dict:
    """Convert a GlyphRange object to a plain dict for downstream processing."""
    # Handle color: can be an enum (PenColor) with .value, or a raw int
    color_val = gr.color.value if hasattr(gr.color, "value") else gr.color
    highlight_data: dict = {
        "start": gr.start,
        "length": gr.length,
        "color": _color_id_to_name(color_val),
        "rects": [],
    }
    # GlyphRange also stores the matched text directly
    if hasattr(gr, "text") and gr.text:
        highlight_data["text"] = gr.text

    if hasattr(gr, "rectangles") and gr.rectangles:
        for rect in gr.rectangles:
            highlight_data["rects"].append(
                {
                    "x": float(rect.x) if hasattr(rect, "x") else 0.0,
                    "y": float(rect.y) if hasattr(rect, "y") else 0.0,
                    "width": float(rect.w) if hasattr(rect, "w") else 0.0,
                    "height": float(rect.h) if hasattr(rect, "h") else 0.0,
                }
            )
    return highlight_data


def _collect_glyph_ranges(block: object, highlights: list[dict]) -> None:
    """
    Recursively walk rmscene block structures to find GlyphRange data.

    GlyphRange objects appear in SceneGlyphItemBlock (block.item.value)
    or directly as block.value in other block types. We check both paths.
    """
    # Path 1: SceneGlyphItemBlock has .item (CrdtSequenceItem) with .value = GlyphRange
    if hasattr(block, "item") and hasattr(block.item, "value"):
        if isinstance(block.item.value, GlyphRange):
            highlights.append(_glyph_range_to_dict(block.item.value))
            return

    # Path 2: Direct block.value as GlyphRange (other block types)
    if hasattr(block, "value") and isinstance(block.value, GlyphRange):
        highlights.append(_glyph_range_to_dict(block.value))
        return

    # Walk container blocks that may hold GlyphRange children
    if hasattr(block, "children"):
        for child in block.children:
            _collect_glyph_ranges(child, highlights)

    if hasattr(block, "items"):
        for item in block.items:
            _collect_glyph_ranges(item, highlights)

    if hasattr(block, "value") and hasattr(block.value, "items"):
        for item in block.value.items:
            _collect_glyph_ranges(item, highlights)

    if hasattr(block, "text") and hasattr(block, "formatting"):
        if hasattr(block.formatting, "items"):
            for item in block.formatting.items:
                _collect_glyph_ranges(item, highlights)


def _extract_text_from_pdf_page(
    pdf_doc: "fitz.Document", page_index: int, start: int, length: int
) -> str:
    """
    Extract text from a specific page of a PDF using character offsets.

    PyMuPDF's get_text("text") returns all text on a page as a single string.
    The GlyphRange start/length offsets index into this text.

    Args:
        pdf_doc: An open PyMuPDF document.
        page_index: 0-indexed page number.
        length: Number of characters to extract.

    Returns:
        The extracted text string, stripped of leading/trailing whitespace.
    """
    if page_index < 0 or page_index >= len(pdf_doc):
        return ""

    page = pdf_doc[page_index]
    page_text = page.get_text("text")

    if start < 0 or start >= len(page_text):
        return ""

    end = min(start + length, len(page_text))
    extracted = page_text[start:end].strip()
    return extracted


def _extract_text_by_rectangle(
    pdf_doc: "fitz.Document",
    page_index: int,
    rects: list[dict],
) -> str:
    """
    Extract text from a PDF page by finding words that overlap with highlight rectangles.

    This is the reliable fallback for firmware < 3.26 where GlyphRange does not
    include .text and character offset mapping is inaccurate (12-17 char deltas
    observed on real devices).

    Algorithm:
    1. Get word-level bounding boxes from PyMuPDF's page.get_text("dict")
    2. For each highlight rectangle, find words whose bounding boxes overlap
    3. Collect overlapping words in reading order (top-to-bottom, left-to-right)
    4. Join with spaces, collapsing whitespace

    Args:
        pdf_doc: An open PyMuPDF document.
        page_index: 0-indexed page number.
        rects: List of highlight rectangles, each with {x, y, width, height}
               in PDF coordinate space.

    Returns:
        The extracted text from words overlapping the highlight rectangles.
    """
    if page_index < 0 or page_index >= len(pdf_doc):
        return ""

    if not rects:
        return ""

    page = pdf_doc[page_index]

    # Build fitz.Rect objects for the highlight regions
    highlight_rects = []
    for r in rects:
        x0 = r["x"]
        y0 = r["y"]
        x1 = x0 + r["width"]
        y1 = y0 + r["height"]
        highlight_rects.append(fitz.Rect(x0, y0, x1, y1))

    # Get word-level bounding boxes from the page
    # get_text("dict") returns blocks -> lines -> spans -> chars
    # get_text("words") returns (x0, y0, x1, y1, word, block_no, line_no, word_no)
    words = page.get_text("words")

    # Collect words that overlap with any highlight rectangle
    overlapping_words: list[tuple[float, float, float, str]] = []

    for word_data in words:
        wx0, wy0, wx1, wy1 = word_data[0], word_data[1], word_data[2], word_data[3]
        word_text = word_data[4]
        word_rect = fitz.Rect(wx0, wy0, wx1, wy1)

        for hr in highlight_rects:
            # Check if the word rectangle overlaps with the highlight rectangle
            # Using intersect: non-empty intersection means overlap
            intersection = word_rect & hr
            if not intersection.is_empty:
                # Use word's position for sorting (y first for line, then x)
                overlapping_words.append((wy0, wx0, wx1, word_text))
                break  # Don't add the same word twice

    if not overlapping_words:
        return ""

    # Sort by reading order: top to bottom, then left to right
    overlapping_words.sort(key=lambda w: (w[0], w[1]))

    # Join words with spaces
    text = " ".join(w[3] for w in overlapping_words)
    return text.strip()


def _get_bounds_from_rects(rects: list[dict]) -> Optional[dict]:
    """Compute a bounding box that encloses all rectangles."""
    if not rects:
        return None

    min_x = min(r["x"] for r in rects)
    min_y = min(r["y"] for r in rects)
    max_x = max(r["x"] + r["width"] for r in rects)
    max_y = max(r["y"] + r["height"] for r in rects)

    return {
        "x": min_x,
        "y": min_y,
        "width": max_x - min_x,
        "height": max_y - min_y,
    }


def _process_v6_page(
    rm_path: str,
    pdf_doc: "fitz.Document",
    page_index: int,
    highlights: list[ExtractedHighlight],
    warnings: list[str],
) -> None:
    """
    Process a single v6-format .rm page: parse GlyphRange blocks and extract
    highlighted text from the corresponding PDF page. Also pulls text from
    highlighter-pen strokes (pen types 5 and 18) drawn over the PDF — see
    _process_highlighter_strokes for the why.

    Results are appended in-place to the highlights and warnings lists.
    """
    try:
        glyph_ranges = _extract_highlights_from_rm_file(rm_path)
    except (ValueError, ImportError) as e:
        warnings.append(f"Page {page_index + 1}: {e}")
        return

    for gr in glyph_ranges:
        # Prefer text already stored in the GlyphRange (firmware 3.26+)
        text = gr.get("text", "")
        if not text and gr.get("rects"):
            # Reliable fallback: rectangle-based text extraction.
            # Character offset fallback is UNRELIABLE for firmware < 3.26
            # (12-17 char deltas observed on real devices).
            text = _extract_text_by_rectangle(
                pdf_doc, page_index, gr["rects"]
            )

        if not text:
            warnings.append(
                f"Page {page_index + 1}: Empty text for highlight at "
                f"offset {gr['start']}+{gr['length']}"
            )
            continue

        bounds = _get_bounds_from_rects(gr.get("rects", []))

        highlights.append(
            ExtractedHighlight(
                text=text,
                page_number=page_index + 1,  # 1-indexed
                color=gr.get("color", "yellow"),
                bounds=bounds,
                created_at=None,  # GlyphRange does not store timestamps
            )
        )

    # Highlighter-pen strokes: text the user marked by DRAWING with the
    # highlighter tool (pen 5/18) instead of tap-to-select-text. Stored as
    # Line blocks, not GlyphRange. Without this pass these annotations appear
    # in the rendered page PNG but never as text quotes in the markdown.
    _process_highlighter_strokes(rm_path, pdf_doc, page_index, highlights, warnings)


# Empirically calibrated against the AlphaGo Zero paper (page 26): rmscene
# v6 stroke/glyph coordinates live in a logical space sized at
# canvas * 300/226 (i.e. PDF pages of 612x792 pt map onto an
# (1404*300/226) x (1872*300/226) ≈ 1863 x 2485 logical grid).
# Verified by comparing GR#1 rm_y=437 to PDF "action is selected" at y=139.9
# (ratio matches 226/300 * 792/1872 to within 0.5%).
_V6_LOGICAL_DPI = 300
_V6_PHYSICAL_DPI = 226


def _v6_rm_rect_to_pdf_rect(
    rm_x: float, rm_y: float, rm_w: float, rm_h: float,
    pdf_w: float, pdf_h: float,
) -> dict:
    """Convert a v6 rm-space rectangle (center-origin x, top-origin y) to PDF pt."""
    canvas_logical_w = RM_SCREEN_WIDTH * (_V6_LOGICAL_DPI / _V6_PHYSICAL_DPI)
    canvas_logical_h = RM_SCREEN_HEIGHT * (_V6_LOGICAL_DPI / _V6_PHYSICAL_DPI)
    sx = pdf_w / canvas_logical_w
    sy = pdf_h / canvas_logical_h
    return {
        "x": (rm_x + canvas_logical_w / 2) * sx,
        "y": rm_y * sy,
        "width": rm_w * sx,
        "height": rm_h * sy,
    }


def _extract_highlighter_strokes_from_rm_file(rm_path: str) -> list[dict]:
    """
    Parse a v6 .rm file and return every highlighter-pen stroke's bounding box.

    Returns a list of dicts with keys: pen_type, color, rm_bbox (x, y, w, h).
    Coordinates are in rm-space (will be converted per-page later because the
    conversion needs the PDF page dimensions).
    """
    if read_blocks is None or Line is None:
        return []

    strokes: list[dict] = []
    try:
        with open(rm_path, "rb") as f:
            blocks = list(read_blocks(f))
    except Exception:
        return []

    for block in blocks:
        item = getattr(block, "item", None)
        val = getattr(item, "value", None) if item else getattr(block, "value", None)
        if not isinstance(val, Line):
            continue
        tool = getattr(val, "tool", None)
        pen_type = getattr(tool, "value", tool)
        if pen_type not in HIGHLIGHTER_PEN_TYPES:
            continue
        pts = getattr(val, "points", None) or []
        if not pts:
            continue
        xs = [p.x for p in pts]
        ys = [p.y for p in pts]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        # Skip negligibly-small strokes (accidental taps). The highlighter is
        # ~10-15pt wide in PDF; a stroke smaller than ~5pt either dimension
        # in rm-space (i.e. roughly a single pixel) is not a real highlight.
        if (x1 - x0) < 5 and (y1 - y0) < 5:
            continue
        color = getattr(val, "color", None)
        color_val = getattr(color, "value", color) if color is not None else None
        strokes.append({
            "pen_type": pen_type,
            "color": _color_id_to_name(color_val) if color_val is not None else "yellow",
            "rm_bbox": (x0, y0, x1 - x0, y1 - y0),
        })

    return strokes


def _process_highlighter_strokes(
    rm_path: str,
    pdf_doc: "fitz.Document",
    page_index: int,
    highlights: list[ExtractedHighlight],
    warnings: list[str],
) -> None:
    """
    Extract text from highlighter-pen strokes on a v6 page.

    The reMarkable user can highlight text in two ways:
      1. Tap a word, choose a color  → stored as GlyphRange (handled by
         _process_v6_page above).
      2. Select the highlighter tool, drag across text → stored as a Line
         block with pen_type 5 or 18. The .rm file has no record of what
         text the user crossed; we have to reconstruct it by overlapping the
         stroke's bounding box against PDF text positions.

    This function performs path 2.
    """
    if page_index < 0 or page_index >= len(pdf_doc):
        return
    strokes = _extract_highlighter_strokes_from_rm_file(rm_path)
    if not strokes:
        return

    page = pdf_doc[page_index]
    pdf_w, pdf_h = page.rect.width, page.rect.height

    # Add a small vertical pad so a stroke drawn slightly above or below the
    # text x-height (a normal human-aim error) still picks up the right line.
    Y_PAD_PT = 3.0

    for s in strokes:
        x, y, w, h = s["rm_bbox"]
        # PDF rect is only used to query text — convert from rm to PDF coords.
        pdf_rect = _v6_rm_rect_to_pdf_rect(x, y, w, h, pdf_w, pdf_h)
        pdf_rect["y"] -= Y_PAD_PT
        pdf_rect["height"] += 2 * Y_PAD_PT
        pdf_rect["x"] = max(0.0, pdf_rect["x"])
        pdf_rect["y"] = max(0.0, pdf_rect["y"])
        if pdf_rect["x"] + pdf_rect["width"] > pdf_w:
            pdf_rect["width"] = pdf_w - pdf_rect["x"]
        if pdf_rect["y"] + pdf_rect["height"] > pdf_h:
            pdf_rect["height"] = pdf_h - pdf_rect["y"]

        text = _extract_text_by_rectangle(pdf_doc, page_index, [pdf_rect])
        if not text:
            warnings.append(
                f"Page {page_index + 1}: highlighter stroke at "
                f"PDF y={pdf_rect['y']:.1f} matched no text"
            )
            continue

        # Bounds are stored in RM coords to match GlyphRange-derived bounds,
        # so the merger's per-page sort and gap heuristics treat both kinds
        # of highlights consistently.
        highlights.append(
            ExtractedHighlight(
                text=text,
                page_number=page_index + 1,
                color=s["color"],
                bounds={"x": x, "y": y, "width": w, "height": h},
                created_at=None,
            )
        )


def extract_highlights_for_document(
    doc_uuid: str,
    page_uuids: list[str],
    xochitl_path: str,
) -> tuple[list[ExtractedHighlight], list[str]]:
    """
    Extract all text highlights from a PDF document's .rm annotation files.

    This is the main entry point for v6-only highlight extraction. For each page
    that has an .rm file, it:
    1. Parses the .rm file via rmscene to find GlyphRange blocks
    2. Opens the source PDF via PyMuPDF
    3. Uses GlyphRange offsets to extract the highlighted text
    4. Returns structured highlights with page numbers and colors

    Args:
        doc_uuid: The document's UUID in the xochitl filesystem.
        page_uuids: Ordered list of page UUIDs from the .content file.
        xochitl_path: Path to the synced xochitl directory.

    Returns:
        Tuple of (highlights, warnings) where highlights is a list of
        ExtractedHighlight objects and warnings is a list of non-fatal messages.
    """
    if fitz is None:
        raise ImportError(
            "PyMuPDF is required for PDF text extraction. "
            "Install with: pip install PyMuPDF"
        )

    highlights: list[ExtractedHighlight] = []
    warnings: list[str] = []

    # Locate the source PDF
    pdf_path = os.path.join(xochitl_path, f"{doc_uuid}.pdf")
    if not os.path.exists(pdf_path):
        warnings.append(f"Source PDF not found: {pdf_path}")
        return highlights, warnings

    # Open PDF once for all pages
    try:
        pdf_doc = fitz.open(pdf_path)
    except Exception as e:
        warnings.append(f"Failed to open PDF: {e}")
        return highlights, warnings

    try:
        # The .rm directory contains per-page annotation files
        rm_dir = os.path.join(xochitl_path, doc_uuid)
        if not os.path.isdir(rm_dir):
            warnings.append(f"No annotation directory found: {rm_dir}")
            return highlights, warnings

        for page_index, page_uuid in enumerate(page_uuids):
            rm_path = os.path.join(rm_dir, f"{page_uuid}.rm")
            if not os.path.exists(rm_path):
                continue  # No annotations on this page

            _process_v6_page(rm_path, pdf_doc, page_index, highlights, warnings)
    finally:
        pdf_doc.close()

    return merge_fragmented_highlights(highlights), warnings


def _detect_rm_format(rm_path: str) -> str:
    """
    Detect the .rm file format from header bytes.

    Returns 'v6', 'v5', 'v3', or 'unknown'.
    """
    try:
        with open(rm_path, "rb") as f:
            header = f.read(64)
    except OSError:
        return "unknown"

    header_str = header[:48].decode("ascii", errors="replace")
    if "version=6" in header_str:
        return "v6"
    if "version=5" in header_str:
        return "v5"
    if "version=3" in header_str:
        return "v3"
    return "unknown"


def _rm_to_pdf_coords(
    rm_rect: dict, page_width: float, page_height: float
) -> dict:
    """
    Convert reMarkable screen coordinates to PDF page coordinates.

    reMarkable screen: 1404 x 1872 pixels
    PDF page: varies, but we scale proportionally.
    """
    scale_x = page_width / RM_SCREEN_WIDTH
    scale_y = page_height / RM_SCREEN_HEIGHT

    return {
        "x": rm_rect["x"] * scale_x,
        "y": rm_rect["y"] * scale_y,
        "width": rm_rect["width"] * scale_x,
        "height": rm_rect["height"] * scale_y,
    }


def extract_highlights_for_document_auto(
    doc_uuid: str,
    page_uuids: list[str],
    xochitl_path: str,
) -> tuple[list[ExtractedHighlight], list[str]]:
    """
    Extract highlights with automatic format detection per .rm file.

    For each page, detects the .rm format and routes to the appropriate parser:
    - v6: rmscene GlyphRange parser (existing path)
    - v3/v5: legacy binary parser with rectangle-based text extraction

    This enables mixed-format libraries where some pages/documents were
    annotated on older firmware and others on newer firmware.
    """
    if fitz is None:
        raise ImportError(
            "PyMuPDF is required for PDF text extraction. "
            "Install with: pip install PyMuPDF"
        )

    highlights: list[ExtractedHighlight] = []
    warnings: list[str] = []

    pdf_path = os.path.join(xochitl_path, f"{doc_uuid}.pdf")
    if not os.path.exists(pdf_path):
        warnings.append(f"Source PDF not found: {pdf_path}")
        return highlights, warnings

    try:
        pdf_doc = fitz.open(pdf_path)
    except Exception as e:
        warnings.append(f"Failed to open PDF: {e}")
        return highlights, warnings

    try:
        rm_dir = os.path.join(xochitl_path, doc_uuid)
        if not os.path.isdir(rm_dir):
            warnings.append(f"No annotation directory found: {rm_dir}")
            return highlights, warnings

        for page_index, page_uuid in enumerate(page_uuids):
            rm_path = os.path.join(rm_dir, f"{page_uuid}.rm")
            if not os.path.exists(rm_path):
                continue

            fmt = _detect_rm_format(rm_path)

            if fmt == "v6":
                # Delegate to the shared v6 extraction helper
                _process_v6_page(rm_path, pdf_doc, page_index, highlights, warnings)

            elif fmt in ("v3", "v5"):
                # Legacy path: parse highlighter strokes, extract text by rect
                if parse_legacy_rm_file is None:
                    warnings.append(
                        f"Page {page_index + 1}: legacy_rm_parser not available for {fmt} file"
                    )
                    continue

                try:
                    regions = parse_legacy_rm_file(rm_path)
                except (ValueError, OSError) as e:
                    warnings.append(f"Page {page_index + 1} ({fmt}): {e}")
                    continue

                if not regions:
                    continue

                # Convert reMarkable coordinates to PDF coordinates
                if page_index < len(pdf_doc):
                    page = pdf_doc[page_index]
                    page_rect = page.rect
                    page_w = page_rect.width
                    page_h = page_rect.height
                else:
                    warnings.append(
                        f"Page {page_index + 1}: page index out of range in PDF"
                    )
                    continue

                for region in regions:
                    pdf_rect = _rm_to_pdf_coords(
                        region.bounds, page_w, page_h
                    )
                    text = _extract_text_by_rectangle(
                        pdf_doc, page_index, [pdf_rect]
                    )
                    if not text:
                        warnings.append(
                            f"Page {page_index + 1}: Empty text for legacy highlight"
                        )
                        continue

                    highlights.append(
                        ExtractedHighlight(
                            text=text,
                            page_number=page_index + 1,
                            color=region.color,
                            bounds=pdf_rect,
                            created_at=None,
                        )
                    )

            else:
                warnings.append(
                    f"Page {page_index + 1}: unknown .rm format '{fmt}', skipping"
                )

    finally:
        pdf_doc.close()

    return merge_fragmented_highlights(highlights), warnings
