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
from page_geometry import LEGACY_PAGE_GEOMETRY, PageGeometry, read_page_geometry

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


# A page is treated as two-column only when both sides contain substantial
# text and relatively little text crosses the centre. Using the PDF's text
# blocks makes this opt-in for real columns/spreads and avoids splitting normal
# single-column pages merely because two short highlights are far apart.
MIN_COLUMN_TEXT_CHARS = 50
MAX_CROSS_GUTTER_RATIO = 0.30


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
        10: "green",  # PenColor.GREEN_2
        11: "cyan",
        12: "magenta",
        13: "yellow",  # PenColor.YELLOW_2
    }
    return color_map.get(color_id, f"unknown_{color_id}")


def _rgba_to_color(color_rgba: object) -> Optional[str]:
    """Return an exact #RRGGBB color for a valid rmscene RGBA tuple."""
    if not isinstance(color_rgba, (tuple, list)) or len(color_rgba) < 3:
        return None
    try:
        channels = tuple(int(channel) for channel in color_rgba[:3])
    except (TypeError, ValueError):
        return None
    if any(channel < 0 or channel > 255 for channel in channels):
        return None
    return "#%02X%02X%02X" % channels


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
    color = getattr(gr, "color", 9)
    color_val = color.value if hasattr(color, "value") else color
    highlight_data: dict = {
        "start": gr.start,
        "length": gr.length,
        "color": _rgba_to_color(getattr(gr, "color_rgba", None)) or _color_id_to_name(color_val),
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
    overlapping_words: list[tuple[float, float, float, float, str]] = []

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
                overlapping_words.append((wx0, wy0, wx1, wy1, word_text))
                break  # Don't add the same word twice

    if not overlapping_words:
        return ""

    gutter_x = _detect_page_gutter(page)
    if gutter_x is None:
        # Normal page: top to bottom, then left to right.
        overlapping_words.sort(key=lambda w: (w[1], w[0]))
    else:
        # Two columns or a two-page spread: finish the left side first.
        overlapping_words.sort(
            key=lambda w: (
                0 if (w[0] + w[2]) / 2.0 < gutter_x else 1,
                w[1],
                w[0],
            )
        )

    # Join words with spaces
    text = " ".join(w[4] for w in overlapping_words)
    return text.strip()


def _detect_page_gutter(page: object) -> Optional[float]:
    """Detect a two-column layout using text blocks around the page centre.

    PyMuPDF groups lines from the same paragraph into blocks. On a normal page,
    most body blocks cross the midpoint. On a two-column page or scanned spread,
    substantial blocks stay wholly on both sides of the midpoint. Full-width
    titles and footers are tolerated up to ``MAX_CROSS_GUTTER_RATIO``.
    """
    try:
        page_width = float(page.rect.width)
        blocks = page.get_text("blocks")
    except (AttributeError, TypeError, ValueError):
        return None

    if page_width <= 0:
        return None

    gutter_x = page_width / 2.0
    left_chars = 0
    right_chars = 0
    crossing_chars = 0

    for block in blocks:
        if len(block) < 5:
            continue
        try:
            x0, x1 = float(block[0]), float(block[2])
        except (TypeError, ValueError):
            continue
        text = str(block[4]).strip()
        weight = len(text)
        if not weight:
            continue
        if x1 <= gutter_x:
            left_chars += weight
        elif x0 >= gutter_x:
            right_chars += weight
        else:
            crossing_chars += weight

    total_chars = left_chars + right_chars + crossing_chars
    if total_chars == 0:
        return None
    if left_chars < MIN_COLUMN_TEXT_CHARS or right_chars < MIN_COLUMN_TEXT_CHARS:
        return None
    if crossing_chars / total_chars > MAX_CROSS_GUTTER_RATIO:
        return None
    return gutter_x


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


def _backing_pdf_page_index(
    logical_page_index: int,
    page_redir: Optional[dict[int, int]],
) -> Optional[int]:
    """Resolve a logical notebook page to its backing PDF page, if any."""
    if page_redir is None:
        return logical_page_index
    return page_redir.get(logical_page_index)


def _process_v6_page(
    rm_path: str,
    pdf_doc: "fitz.Document",
    page_index: int,
    highlights: list[ExtractedHighlight],
    warnings: list[str],
    geometry: Optional[PageGeometry] = None,
    logical_page_index: Optional[int] = None,
) -> None:
    """
    Process a single v6-format .rm page: parse GlyphRange blocks and extract
    highlighted text from the corresponding PDF page. Also pulls text from
    highlighter-pen strokes (pen types 5 and 18) drawn over the PDF — see
    _process_highlighter_strokes for the why.

    Results are appended in-place to the highlights and warnings lists.
    """
    geometry = geometry or read_page_geometry(rm_path)
    display_page_index = (
        page_index if logical_page_index is None else logical_page_index
    )

    try:
        glyph_ranges = _extract_highlights_from_rm_file(rm_path)
    except (ValueError, ImportError) as e:
        warnings.append(f"Page {display_page_index + 1}: {e}")
        return

    if page_index < 0:
        warnings.append(
            f"Page {display_page_index + 1}: page index out of range in PDF"
        )
        return

    try:
        page = pdf_doc[page_index]
    except (IndexError, TypeError):
        warnings.append(
            f"Page {display_page_index + 1}: page index out of range in PDF"
        )
        return
    pdf_w, pdf_h = page.rect.width, page.rect.height

    for gr in glyph_ranges:
        # rmscene rectangles use centre-origin logical reMarkable coordinates.
        # Normalize them to PDF coordinates before text matching, ordering, and
        # merging so detected PDF gutters use the same coordinate space.
        pdf_rects = [
            _v6_rm_rect_to_pdf_rect(
                r["x"], r["y"], r["width"], r["height"], pdf_w, pdf_h,
                geometry=geometry,
            )
            for r in gr.get("rects", [])
        ]

        # Prefer text already stored in the GlyphRange (firmware 3.26+)
        text = gr.get("text", "")
        if not text and pdf_rects:
            # Reliable fallback: rectangle-based text extraction.
            # Character offset fallback is UNRELIABLE for firmware < 3.26
            # (12-17 char deltas observed on real devices).
            text = _extract_text_by_rectangle(
                pdf_doc, page_index, pdf_rects
            )

        if not text:
            warnings.append(
                f"Page {display_page_index + 1}: Empty text for highlight at "
                f"offset {gr['start']}+{gr['length']}"
            )
            continue

        bounds = _get_bounds_from_rects(pdf_rects)

        highlights.append(
            ExtractedHighlight(
                text=text,
                page_number=display_page_index + 1,  # 1-indexed logical page
                color=gr.get("color", "yellow"),
                bounds=bounds,
                created_at=None,  # GlyphRange does not store timestamps
            )
        )

    # Highlighter-pen strokes: text the user marked by DRAWING with the
    # highlighter tool (pen 5/18) instead of tap-to-select-text. Stored as
    # Line blocks, not GlyphRange. Without this pass these annotations appear
    # in the rendered page PNG but never as text quotes in the markdown.
    _process_highlighter_strokes(
        rm_path,
        pdf_doc,
        page_index,
        highlights,
        warnings,
        geometry=geometry,
        logical_page_index=display_page_index,
    )


def _v6_rm_rect_to_pdf_rect(
    rm_x: float, rm_y: float, rm_w: float, rm_h: float,
    pdf_w: float, pdf_h: float,
    geometry: PageGeometry = LEGACY_PAGE_GEOMETRY,
) -> dict:
    """Convert a v6 rm-space rectangle to PDF points.

    This is the exact inverse of ``png_renderer``'s PDF path: annotations are
    scaled uniformly into the device canvas, while the PDF background is fit
    to the canvas width.  Using independent physical-DPI x/y scales happened
    to be close on the 4:3 legacy display, but diverges on Paper Pro Move.
    """
    canvas_to_pdf = pdf_w / geometry.width
    annotation_scale = geometry.pdf_coord_scale * canvas_to_pdf
    return {
        "x": (rm_x * geometry.pdf_coord_scale + geometry.width / 2) * canvas_to_pdf,
        "y": rm_y * annotation_scale,
        "width": rm_w * annotation_scale,
        "height": rm_h * annotation_scale,
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
            "color": (
                _rgba_to_color(getattr(val, "color_rgba", None))
                or (_color_id_to_name(color_val) if color_val is not None else "yellow")
            ),
            "rm_bbox": (x0, y0, x1 - x0, y1 - y0),
        })

    return strokes


def _process_highlighter_strokes(
    rm_path: str,
    pdf_doc: "fitz.Document",
    page_index: int,
    highlights: list[ExtractedHighlight],
    warnings: list[str],
    geometry: PageGeometry = LEGACY_PAGE_GEOMETRY,
    logical_page_index: Optional[int] = None,
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
    display_page_index = (
        page_index if logical_page_index is None else logical_page_index
    )
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
        pdf_rect = _v6_rm_rect_to_pdf_rect(
            x, y, w, h, pdf_w, pdf_h, geometry=geometry,
        )
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
                f"Page {display_page_index + 1}: highlighter stroke at "
                f"PDF y={pdf_rect['y']:.1f} matched no text"
            )
            continue

        # Keep all extracted bounds in PDF coordinates so gutter detection and
        # the merger operate in one consistent coordinate space.
        highlights.append(
            ExtractedHighlight(
                text=text,
                page_number=display_page_index + 1,
                color=s["color"],
                bounds=dict(pdf_rect),
                created_at=None,
            )
        )


def extract_highlights_for_document(
    doc_uuid: str,
    page_uuids: list[str],
    xochitl_path: str,
    page_redir: Optional[dict[int, int]] = None,
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
        page_redir: Optional logical-page to backing-PDF-page mapping.

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
    page_gutters: dict[int, float] = {}

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

            pdf_page_index = _backing_pdf_page_index(page_index, page_redir)
            if pdf_page_index is None:
                warnings.append(
                    f"Page {page_index + 1}: inserted page has no backing PDF; "
                    "skipping PDF highlight extraction"
                )
                continue

            if 0 <= pdf_page_index < len(pdf_doc):
                gutter_x = _detect_page_gutter(pdf_doc[pdf_page_index])
                if gutter_x is not None:
                    page_gutters[page_index + 1] = gutter_x

            _process_v6_page(
                rm_path,
                pdf_doc,
                pdf_page_index,
                highlights,
                warnings,
                logical_page_index=page_index,
            )
    finally:
        pdf_doc.close()

    return merge_fragmented_highlights(highlights, page_gutters), warnings


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
    page_redir: Optional[dict[int, int]] = None,
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
    page_gutters: dict[int, float] = {}

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

            pdf_page_index = _backing_pdf_page_index(page_index, page_redir)
            if pdf_page_index is None:
                warnings.append(
                    f"Page {page_index + 1}: inserted page has no backing PDF; "
                    "skipping PDF highlight extraction"
                )
                continue

            fmt = _detect_rm_format(rm_path)

            if 0 <= pdf_page_index < len(pdf_doc):
                gutter_x = _detect_page_gutter(pdf_doc[pdf_page_index])
                if gutter_x is not None:
                    page_gutters[page_index + 1] = gutter_x

            if fmt == "v6":
                # Delegate to the shared v6 extraction helper
                _process_v6_page(
                    rm_path,
                    pdf_doc,
                    pdf_page_index,
                    highlights,
                    warnings,
                    logical_page_index=page_index,
                )

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
                if 0 <= pdf_page_index < len(pdf_doc):
                    page = pdf_doc[pdf_page_index]
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
                        pdf_doc, pdf_page_index, [pdf_rect]
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

    return merge_fragmented_highlights(highlights, page_gutters), warnings
