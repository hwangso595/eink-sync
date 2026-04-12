"""
Render reMarkable .rm stroke data onto a PDF using PyMuPDF (fitz).

Two modes:
1. **PDF overlay**: Opens an existing source PDF and draws strokes on top
   of each page as vector paths.
2. **Notebook mode**: Creates a new blank PDF with strokes drawn on white pages
   (for reMarkable notebooks that have no source PDF).

Coordinate mapping:
    reMarkable canvas is 1404x1872 (device pixels).
    PDF pages vary in size (typically 612x792 pt for US Letter).
    We compute scale factors (sx, sy) to map reMarkable coords to PDF coords.

Stroke rendering:
    - Each stroke segment between consecutive points is drawn with a width
      derived from that point's pressure and the pen-type base width.
    - Highlighter strokes use semi-transparent yellow overlay.
    - Eraser strokes are skipped (already filtered by stroke_renderer).
    - Pen color is taken from the stroke data's COLOR_TO_HEX mapping.
"""

import os
from typing import Optional

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None  # type: ignore[assignment]

from constants import RM_SCREEN_WIDTH, RM_SCREEN_HEIGHT
from stroke_renderer import (
    Stroke,
    StrokePoint,
    HIGHLIGHTER_PEN_TYPES,
    HIGHLIGHTER_OPACITY,
    COLOR_TO_HEX,
    PEN_WIDTH_FACTOR,
    PRESSURE_WIDTH_SCALE,
)


def _require_fitz() -> None:
    """Raise a clear error if PyMuPDF is not installed."""
    if fitz is None:
        raise ImportError(
            "PyMuPDF (fitz) is required for PDF annotation. "
            "Install with: pip install PyMuPDF"
        )


def _hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    """Convert a hex color string like '#FF0000' to (r, g, b) floats 0..1."""
    hex_color = hex_color.lstrip("#")
    r = int(hex_color[0:2], 16) / 255.0
    g = int(hex_color[2:4], 16) / 255.0
    b = int(hex_color[4:6], 16) / 255.0
    return (r, g, b)


def _segment_width(point: StrokePoint, stroke: Stroke) -> float:
    """
    Compute the line width for a segment at a given point.

    Uses the point's width (pressure-derived from the device) scaled
    by the pen type factor and a global pressure scale.

    Raw point.width from reMarkable is in device units (~30-70 for normal
    writing). We scale it down to PDF points.
    """
    raw_width = point.width if point.width > 0 else 1.0
    # Scale from device units to something reasonable in PDF points
    # Device width / 20 gives a good base, then multiply by pen factor
    base = raw_width / 20.0
    pen_factor = stroke.stroke_width
    width = base * pen_factor * PRESSURE_WIDTH_SCALE

    if stroke.is_highlighter:
        return max(4.0, width)
    return max(0.3, min(width, 4.0))


def _draw_strokes_on_page(
    page: "fitz.Page",
    strokes: list[Stroke],
    scale_x: float,
    scale_y: float,
) -> int:
    """
    Draw all strokes on a single PDF page using PyMuPDF Shape API.

    Each stroke is drawn as a series of line segments between consecutive
    points, with per-segment width based on pressure data.

    Args:
        page: The PyMuPDF page to draw on.
        strokes: List of Stroke objects for this page.
        scale_x: Horizontal scale factor (PDF width / RM width).
        scale_y: Vertical scale factor (PDF height / RM height).

    Returns:
        Number of strokes actually drawn.
    """
    drawn = 0

    for stroke in strokes:
        if stroke.is_eraser:
            continue

        points = stroke.points
        if len(points) < 2:
            # Single point: draw a tiny dot
            if len(points) == 1:
                pt = points[0]
                px = pt.x * scale_x
                py = pt.y * scale_y
                r = _segment_width(pt, stroke) * 0.5
                rgb = _hex_to_rgb(stroke.hex_color)
                shape = page.new_shape()
                shape.draw_circle(fitz.Point(px, py), max(r, 0.5))
                shape.finish(
                    color=rgb,
                    fill=rgb,
                    width=0,
                )
                if stroke.is_highlighter:
                    shape.commit(overlay=True)
                else:
                    shape.commit(overlay=True)
                drawn += 1
            continue

        rgb = _hex_to_rgb(stroke.hex_color)
        is_hl = stroke.is_highlighter
        opacity = HIGHLIGHTER_OPACITY if is_hl else 1.0

        # For highlighter strokes, draw as a single polyline with average
        # width and semi-transparency for better visual appearance.
        if is_hl:
            avg_w = sum(_segment_width(p, stroke) for p in points) / len(points)
            shape = page.new_shape()
            scaled_points = [
                fitz.Point(p.x * scale_x, p.y * scale_y)
                for p in points
            ]
            shape.draw_polyline(scaled_points)
            # Highlighter uses yellow regardless of stored color
            hl_rgb = _hex_to_rgb("#FFD700")
            shape.finish(
                color=hl_rgb,
                width=avg_w,
                stroke_opacity=opacity,
                lineCap=1,   # round cap
                lineJoin=1,  # round join
            )
            shape.commit(overlay=True)
            drawn += 1
            continue

        # For regular strokes: draw each segment with its own width for
        # pressure-sensitive rendering.
        shape = page.new_shape()
        for i in range(len(points) - 1):
            p0 = points[i]
            p1 = points[i + 1]
            x0 = p0.x * scale_x
            y0 = p0.y * scale_y
            x1 = p1.x * scale_x
            y1 = p1.y * scale_y
            w = _segment_width(p0, stroke)

            shape.draw_line(fitz.Point(x0, y0), fitz.Point(x1, y1))
            shape.finish(
                color=rgb,
                width=w,
                stroke_opacity=opacity,
                lineCap=1,   # round cap
                lineJoin=1,  # round join
            )

        shape.commit(overlay=True)
        drawn += 1

    return drawn


def annotate_pdf(
    source_pdf_path: str,
    page_strokes: dict[int, list[Stroke]],
    output_path: str,
) -> dict:
    """
    Open a source PDF and draw strokes on the corresponding pages.

    Args:
        source_pdf_path: Path to the original PDF file.
        page_strokes: Dict mapping 0-based page index to list of Stroke objects.
        output_path: Path to write the annotated PDF.

    Returns:
        Dict with keys: success, output_path, pages_annotated, total_strokes.
    """
    _require_fitz()

    result: dict = {
        "success": False,
        "output_path": output_path,
        "pages_annotated": 0,
        "total_strokes": 0,
    }

    try:
        doc = fitz.open(source_pdf_path)
    except Exception as e:
        result["error"] = f"Failed to open PDF: {e}"
        return result

    try:
        for page_idx, strokes in page_strokes.items():
            if page_idx >= len(doc):
                continue

            page = doc[page_idx]
            rect = page.rect
            pdf_w = rect.width
            pdf_h = rect.height

            scale_x = pdf_w / RM_SCREEN_WIDTH
            scale_y = pdf_h / RM_SCREEN_HEIGHT

            drawn = _draw_strokes_on_page(page, strokes, scale_x, scale_y)
            if drawn > 0:
                result["pages_annotated"] += 1
                result["total_strokes"] += drawn

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        doc.save(output_path)
        result["success"] = True

    except Exception as e:
        result["error"] = f"Failed to annotate PDF: {e}"
    finally:
        doc.close()

    return result


def create_notebook_pdf(
    page_strokes: dict[int, list[Stroke]],
    output_path: str,
    page_count: int = 0,
) -> dict:
    """
    Create a new PDF from notebook strokes (no source PDF).

    Each page is created at reMarkable dimensions (1404x1872 pixels,
    converted to points at 72 DPI: ~468x624 pt).

    Args:
        page_strokes: Dict mapping 0-based page index to list of Stroke objects.
        output_path: Path to write the output PDF.
        page_count: Total number of pages (some may be blank). If 0, uses
                    max page index + 1.

    Returns:
        Dict with keys: success, output_path, pages_annotated, total_strokes.
    """
    _require_fitz()

    result: dict = {
        "success": False,
        "output_path": output_path,
        "pages_annotated": 0,
        "total_strokes": 0,
    }

    # Determine total pages
    if page_count <= 0:
        if page_strokes:
            page_count = max(page_strokes.keys()) + 1
        else:
            page_count = 1

    # reMarkable page in PDF points (at 72 DPI, ~468x624 pt)
    # Using a ratio that preserves the 1404:1872 aspect ratio
    pdf_w = 468.0
    pdf_h = 624.0

    try:
        doc = fitz.open()  # new empty document

        for page_idx in range(page_count):
            page = doc.new_page(width=pdf_w, height=pdf_h)

            if page_idx in page_strokes:
                strokes = page_strokes[page_idx]
                scale_x = pdf_w / RM_SCREEN_WIDTH
                scale_y = pdf_h / RM_SCREEN_HEIGHT

                drawn = _draw_strokes_on_page(page, strokes, scale_x, scale_y)
                if drawn > 0:
                    result["pages_annotated"] += 1
                    result["total_strokes"] += drawn

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        doc.save(output_path)
        result["success"] = True

    except Exception as e:
        result["error"] = f"Failed to create notebook PDF: {e}"
    finally:
        try:
            doc.close()
        except Exception:
            pass

    return result
