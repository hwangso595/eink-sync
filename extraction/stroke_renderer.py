"""
Render reMarkable .rm stroke data as SVG.

Supports two paths:

1. **v6 format (firmware 3.0+):** Uses rmscene to extract SceneLineItemBlock
   stroke data including x, y, speed, width, pressure, and color per point.

2. **Legacy v3/v5 format (firmware < 3.0):** Reuses the binary parser from
   legacy_rm_parser.py to read all pen strokes (not just highlights).

Output is SVG with:
- reMarkable page dimensions (1404x1872) as the viewBox
- Each stroke rendered as an SVG <path> element using cubic Bezier curves
- Pen color preserved via stroke attribute
- Stroke width derived from pressure/width data
- Optional transparent background for PDF overlay mode

Pen type mapping (reMarkable):
  0 = Brush (v1)         8 = Erase area
  1 = Pencil (tilt)      12 = Paint brush (v1)
  2 = Ballpoint          13 = Mechanical pencil (v1)
  3 = Marker             14 = Pencil (v2)
  4 = Fineliner          15 = Ballpoint (v2)
  5 = Highlighter        16 = Marker (v2)
  6 = Eraser             17 = Fineliner (v2)
  7 = Sharp pencil       18 = Highlighter (v2)
  21 = Calligraphy brush

Eraser types (6, 8) are skipped in rendering.
"""

import struct
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Optional

from constants import RM_SCREEN_WIDTH, RM_SCREEN_HEIGHT

try:
    from rmscene import read_blocks
    from rmscene import scene_items as si
except ImportError:
    read_blocks = None  # type: ignore[assignment]
    si = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# reMarkable pen types that are erasers (skip during rendering)
ERASER_PEN_TYPES = {6, 8}

# Color mapping: reMarkable color ID -> SVG hex color
# v6 uses PenColor enum; legacy uses integer IDs
COLOR_TO_HEX = {
    "black": "#000000",
    "gray": "#808080",
    "white": "#FFFFFF",
    "yellow": "#FFD700",
    "green": "#00C853",
    "pink": "#FF4081",
    "blue": "#2979FF",
    "red": "#FF1744",
    "gray_overlap": "#A0A0A0",
}

# Color ID -> name (legacy v3/v5 + v6 integer IDs)
COLOR_ID_TO_NAME = {
    0: "black",
    1: "gray",
    2: "white",
    3: "yellow",
    4: "green",
    5: "pink",
    6: "blue",
    7: "red",
    8: "gray_overlap",
    9: "yellow",  # highlighter default
}

# Pen type -> default stroke width multiplier
# Some pen types have pressure-sensitive width; this is the base factor
PEN_WIDTH_FACTOR = {
    0: 2.0,    # Brush
    1: 1.0,    # Pencil (tilt)
    2: 1.2,    # Ballpoint
    3: 3.0,    # Marker
    4: 1.0,    # Fineliner
    5: 15.0,   # Highlighter
    7: 0.8,    # Sharp pencil
    12: 2.0,   # Paint brush (v1)
    13: 0.8,   # Mechanical pencil (v1)
    14: 1.0,   # Pencil (v2)
    15: 1.2,   # Ballpoint (v2)
    16: 3.0,   # Marker (v2)
    17: 1.0,   # Fineliner (v2)
    18: 15.0,  # Highlighter (v2)
    21: 2.0,   # Calligraphy
}

# Highlighter pen types rendered with semi-transparency
HIGHLIGHTER_PEN_TYPES = {5, 18}

# Scale factor applied to the average per-point width when computing
# the final SVG stroke-width from pressure data.
PRESSURE_WIDTH_SCALE = 1.2

# Opacity used when rendering highlighter strokes so the underlying
# text remains visible through the highlight.
HIGHLIGHTER_OPACITY = 0.35


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class StrokePoint:
    """A single point in a pen stroke."""
    x: float
    y: float
    speed: float = 0.0
    width: float = 1.0
    pressure: float = 0.5
    tilt: float = 0.0  # tilt angle in radians (0 = perpendicular, higher = more tilted)


@dataclass
class Stroke:
    """A complete pen stroke with metadata."""
    pen_type: int
    color: str  # color name (e.g., "black")
    stroke_width: float
    points: list[StrokePoint] = field(default_factory=list)

    @property
    def is_eraser(self) -> bool:
        return self.pen_type in ERASER_PEN_TYPES

    @property
    def is_highlighter(self) -> bool:
        return self.pen_type in HIGHLIGHTER_PEN_TYPES

    @property
    def hex_color(self) -> str:
        return COLOR_TO_HEX.get(self.color, "#000000")


# ---------------------------------------------------------------------------
# v6 stroke extraction via rmscene
# ---------------------------------------------------------------------------

def _color_from_v6(color_val: object) -> str:
    """Convert a v6 color value (enum or int) to a color name."""
    raw = color_val.value if hasattr(color_val, "value") else color_val
    if isinstance(raw, int):
        return COLOR_ID_TO_NAME.get(raw, "black")
    return "black"


def extract_strokes_v6(rm_path: str) -> list[Stroke]:
    """
    Extract all drawing strokes from a v6 .rm file using rmscene.

    Walks the block tree looking for SceneLineItemBlock entries that
    contain point data (x, y, speed, width, pressure per point).
    Skips eraser strokes.

    Returns a list of Stroke objects.
    """
    if read_blocks is None:
        raise ImportError(
            "rmscene is required for v6 stroke extraction. "
            "Install with: pip install rmscene"
        )

    strokes: list[Stroke] = []

    try:
        with open(rm_path, "rb") as f:
            blocks = list(read_blocks(f))
    except Exception as e:
        raise ValueError(f"Failed to parse v6 .rm file: {rm_path}: {e}") from e

    for block in blocks:
        _collect_line_items(block, strokes)

    return strokes


def _collect_line_items(block: object, strokes: list[Stroke]) -> None:
    """
    Recursively walk rmscene blocks to find SceneLineItemBlock entries.

    SceneLineItemBlock.item.value is a Line object with:
      - color: PenColor enum
      - tool: Pen enum
      - points: list of (x, y, speed, width, pressure) tuples
      - thickness_scale: float
    """
    # SceneLineItemBlock: block.item.value is a Line
    if hasattr(block, "item") and hasattr(block.item, "value"):
        val = block.item.value
        if hasattr(val, "points") and hasattr(val, "color"):
            stroke = _line_to_stroke(val)
            if stroke and not stroke.is_eraser:
                strokes.append(stroke)
            return

    # Walk container structures
    for attr in ("children", "items"):
        container = getattr(block, attr, None)
        if container:
            for child in container:
                _collect_line_items(child, strokes)

    if hasattr(block, "value"):
        val = block.value
        if hasattr(val, "items"):
            for item in val.items:
                _collect_line_items(item, strokes)
        if hasattr(val, "points") and hasattr(val, "color"):
            stroke = _line_to_stroke(val)
            if stroke and not stroke.is_eraser:
                strokes.append(stroke)


def _line_to_stroke(line: object) -> Optional[Stroke]:
    """Convert an rmscene Line object to our Stroke dataclass."""
    points_data = getattr(line, "points", None)
    if not points_data:
        return None

    color_name = _color_from_v6(getattr(line, "color", 0))

    # Tool/pen type
    tool = getattr(line, "tool", None)
    pen_type = tool.value if hasattr(tool, "value") else 0

    # Thickness scale
    thickness = getattr(line, "thickness_scale", 1.0)
    if thickness is None:
        thickness = 1.0

    base_width = PEN_WIDTH_FACTOR.get(pen_type, 1.0)

    points: list[StrokePoint] = []
    for pt in points_data:
        # rmscene points can be tuples or objects with attributes
        if isinstance(pt, (list, tuple)):
            x = float(pt[0]) if len(pt) > 0 else 0.0
            y = float(pt[1]) if len(pt) > 1 else 0.0
            speed = float(pt[2]) if len(pt) > 2 else 0.0
            width = float(pt[3]) if len(pt) > 3 else 1.0
            pressure = float(pt[4]) if len(pt) > 4 else 0.5
            tilt = float(pt[5]) if len(pt) > 5 else 0.0
        else:
            x = float(getattr(pt, "x", 0.0))
            y = float(getattr(pt, "y", 0.0))
            speed = float(getattr(pt, "speed", 0.0))
            width = float(getattr(pt, "width", 1.0))
            pressure = float(getattr(pt, "pressure", 0.5))
            # rmscene stores pen tilt as 'direction' — higher values = more tilted
            # Also check tilt_x/tilt_y for newer rmscene versions
            direction = float(getattr(pt, "direction", 0.0))
            tilt_x = float(getattr(pt, "tilt_x", 0.0))
            tilt_y = float(getattr(pt, "tilt_y", 0.0))
            tilt = (tilt_x ** 2 + tilt_y ** 2) ** 0.5 if (tilt_x or tilt_y) else abs(direction)
        points.append(StrokePoint(x=x, y=y, speed=speed, width=width, pressure=pressure, tilt=tilt))

    if not points:
        return None

    return Stroke(
        pen_type=pen_type,
        color=color_name,
        stroke_width=base_width * thickness,
        points=points,
    )


# ---------------------------------------------------------------------------
# Legacy v3/v5 stroke extraction (all strokes, not just highlights)
# ---------------------------------------------------------------------------

V3_HEADER_SIZE = 48
V5_HEADER_SIZE = 48


def _detect_legacy_version(header_bytes: bytes) -> Optional[int]:
    """Detect the version number from header bytes."""
    header_str = header_bytes[:48].decode("ascii", errors="replace")
    if "version=5" in header_str:
        return 5
    if "version=3" in header_str:
        return 3
    return None


def extract_strokes_legacy(rm_path: str) -> list[Stroke]:
    """
    Extract all drawing strokes from a v3/v5 .rm file.

    Unlike the highlight-only parser in legacy_rm_parser.py, this extracts
    ALL pen strokes (including handwriting, drawings, etc.) for rendering.
    Eraser strokes are excluded.

    Returns a list of Stroke objects.
    """
    with open(rm_path, "rb") as f:
        data = f.read()

    if len(data) < V5_HEADER_SIZE + 4:
        raise ValueError(f"File too small to be a valid .rm file: {rm_path}")

    version = _detect_legacy_version(data[:V5_HEADER_SIZE])
    if version is None:
        raise ValueError(f"Not a v3/v5 .rm file: {rm_path}")

    offset = V5_HEADER_SIZE

    if offset + 4 > len(data):
        raise ValueError(f"Truncated file: cannot read layer count: {rm_path}")

    (num_layers,) = struct.unpack_from("<i", data, offset)
    offset += 4

    strokes: list[Stroke] = []

    for _layer_idx in range(num_layers):
        if offset + 4 > len(data):
            break

        (num_strokes,) = struct.unpack_from("<i", data, offset)
        offset += 4

        for _stroke_idx in range(num_strokes):
            if offset + 16 > len(data):
                break

            pen_type, color_id, _unknown1 = struct.unpack_from("<iii", data, offset)
            offset += 12

            (stroke_width,) = struct.unpack_from("<f", data, offset)
            offset += 4

            if version == 5:
                if offset + 4 > len(data):
                    break
                offset += 4  # skip unknown_2

            if offset + 4 > len(data):
                break

            (num_points,) = struct.unpack_from("<i", data, offset)
            offset += 4

            if num_points < 0 or num_points > 1_000_000:
                raise ValueError(
                    f"Suspicious point count ({num_points}) -- file may be corrupt"
                )

            points_bytes = 6 * 4 * num_points
            if offset + points_bytes > len(data):
                break

            points: list[StrokePoint] = []
            for _pt_idx in range(num_points):
                x, y, speed, direction, width, pressure = struct.unpack_from(
                    "<ffffff", data, offset
                )
                offset += 6 * 4
                points.append(StrokePoint(
                    x=x, y=y, speed=speed, width=width, pressure=pressure, tilt=abs(direction),
                ))

            # Skip erasers
            if pen_type in ERASER_PEN_TYPES:
                continue

            if not points:
                continue

            color_name = COLOR_ID_TO_NAME.get(color_id, "black")
            base_width = PEN_WIDTH_FACTOR.get(pen_type, 1.0)

            strokes.append(Stroke(
                pen_type=pen_type,
                color=color_name,
                stroke_width=stroke_width if stroke_width > 0 else base_width,
                points=points,
            ))

    return strokes


# ---------------------------------------------------------------------------
# Format auto-detection
# ---------------------------------------------------------------------------

def detect_rm_format(rm_path: str) -> str:
    """Detect .rm file format from header bytes. Returns 'v6', 'v5', 'v3', or 'unknown'."""
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


def extract_strokes(rm_path: str) -> list[Stroke]:
    """
    Extract strokes from an .rm file with automatic format detection.

    Routes to the appropriate parser based on the file header.
    """
    fmt = detect_rm_format(rm_path)
    if fmt == "v6":
        return extract_strokes_v6(rm_path)
    elif fmt in ("v3", "v5"):
        return extract_strokes_legacy(rm_path)
    else:
        raise ValueError(f"Unsupported .rm format '{fmt}' for: {rm_path}")


@dataclass
class GlyphHighlight:
    """
    A text-selection highlight stored as GlyphRange in v6 .rm files.

    Unlike stroke-based highlights (pen_type 5/18), these are stored as
    rectangular regions over specific PDF text runs. The `text` field
    contains the highlighted text directly, so no PDF clipping is needed.
    """
    text: str
    # Each rect: (x, y, w, h) in reMarkable logical coordinates.
    # x is center-origin (x=0 = horizontal centre of page).
    # y is top-origin.
    rectangles: list[tuple[float, float, float, float]] = field(default_factory=list)


def extract_glyph_highlights(rm_path: str) -> list[GlyphHighlight]:
    """
    Extract glyph-range (text-selection) highlights from a v6 .rm file.

    These are stored as SceneGlyphItemBlock entries with GlyphRange values,
    NOT as stroke data. extract_strokes() will never see them.

    Returns an empty list for non-v6 files or when rmscene is unavailable.
    """
    if read_blocks is None:
        return []
    fmt = detect_rm_format(rm_path)
    if fmt != "v6":
        return []

    highlights: list[GlyphHighlight] = []
    try:
        with open(rm_path, "rb") as f:
            blocks = list(read_blocks(f))
    except Exception:
        return []

    for block in blocks:
        # SceneGlyphItemBlock has .item.value which is a GlyphRange
        item = getattr(block, "item", None)
        if item is None:
            continue
        val = getattr(item, "value", None)
        if val is None:
            continue
        # GlyphRange has .text and .rectangles
        text = getattr(val, "text", None)
        rects_raw = getattr(val, "rectangles", None)
        if text is None or rects_raw is None:
            continue
        rects = []
        for r in rects_raw:
            x = float(getattr(r, "x", 0.0))
            y = float(getattr(r, "y", 0.0))
            w = float(getattr(r, "w", 0.0))
            h = float(getattr(r, "h", 0.0))
            rects.append((x, y, w, h))
        if rects:
            highlights.append(GlyphHighlight(text=text, rectangles=rects))

    return highlights


# ---------------------------------------------------------------------------
# SVG rendering
# ---------------------------------------------------------------------------

def _stroke_to_svg_path(stroke: Stroke) -> str:
    """
    Convert a stroke's points to an SVG path data string (d attribute).

    Uses quadratic Bezier curves (Q) for smooth rendering when there are
    enough points. Falls back to line segments (L) for short strokes.
    """
    pts = stroke.points
    if not pts:
        return ""

    if len(pts) == 1:
        # Single point: draw a tiny circle
        return f"M {pts[0].x:.2f} {pts[0].y:.2f} l 0.01 0"

    # Start at the first point
    d_parts = [f"M {pts[0].x:.2f} {pts[0].y:.2f}"]

    if len(pts) == 2:
        d_parts.append(f"L {pts[1].x:.2f} {pts[1].y:.2f}")
    else:
        # Use quadratic Bezier for smooth curves:
        # For each pair of consecutive points, use the first as control point
        # and the midpoint between the pair as the curve endpoint.
        for i in range(1, len(pts) - 1):
            cx = pts[i].x
            cy = pts[i].y
            # Midpoint between current and next
            mx = (pts[i].x + pts[i + 1].x) / 2
            my = (pts[i].y + pts[i + 1].y) / 2
            d_parts.append(f"Q {cx:.2f} {cy:.2f} {mx:.2f} {my:.2f}")

        # End at the last point
        last = pts[-1]
        d_parts.append(f"L {last.x:.2f} {last.y:.2f}")

    return " ".join(d_parts)


def _average_width(stroke: Stroke) -> float:
    """Compute the average pressure-adjusted width for a stroke.

    Raw point.width values from the reMarkable are in screen units (~30-70
    range for normal writing). We divide by a large factor to get reasonable
    SVG stroke widths relative to the 1404x1872 viewBox:
    - Sharp pencil: ~1-2
    - Ballpoint: ~2-3
    - Marker/thick: ~3-5
    - Highlighter: ~10-15
    """
    if not stroke.points:
        return max(0.5, stroke.stroke_width)

    widths = [pt.width for pt in stroke.points if pt.width > 0]
    if not widths:
        return max(0.5, stroke.stroke_width)

    avg = sum(widths) / len(widths)
    # Divide by ~20 to get from screen units to reasonable SVG units
    scaled = avg / 20.0
    # Apply the pen type thickness multiplier
    scaled *= stroke.stroke_width
    if stroke.is_highlighter:
        return max(8.0, scaled)
    return max(0.5, min(scaled, 5.0))


def _compute_stroke_bounds(
    strokes: list[Stroke],
    padding: float = 20.0,
) -> tuple[float, float, float, float]:
    """
    Compute the bounding box that contains all stroke points.

    Returns (min_x, min_y, width, height) with padding applied.
    Falls back to full reMarkable page dimensions if there are no points.
    """
    min_x = float("inf")
    min_y = float("inf")
    max_x = float("-inf")
    max_y = float("-inf")

    has_points = False
    for stroke in strokes:
        if stroke.is_eraser:
            continue
        for pt in stroke.points:
            has_points = True
            min_x = min(min_x, pt.x)
            min_y = min(min_y, pt.y)
            max_x = max(max_x, pt.x)
            max_y = max(max_y, pt.y)

    if not has_points:
        return 0.0, 0.0, RM_SCREEN_WIDTH, RM_SCREEN_HEIGHT

    # Apply padding
    min_x -= padding
    min_y -= padding
    max_x += padding
    max_y += padding

    return min_x, min_y, max_x - min_x, max_y - min_y


def render_strokes_to_svg(
    strokes: list[Stroke],
    width: float = RM_SCREEN_WIDTH,
    height: float = RM_SCREEN_HEIGHT,
    transparent_bg: bool = False,
) -> str:
    """
    Render a list of strokes as an SVG string.

    The viewBox is computed from the actual stroke bounding box so that
    strokes with negative coordinates (common for annotations that extend
    into margins) are not clipped. The width/height attributes are omitted
    so the SVG scales to its container.

    Args:
        strokes: Pen strokes to render.
        width: Ignored (kept for API compatibility). ViewBox is auto-computed.
        height: Ignored (kept for API compatibility). ViewBox is auto-computed.
        transparent_bg: If True, omit the background rectangle (for PDF overlay).

    Returns:
        SVG document as a string.
    """
    # Compute bounding box from actual stroke coordinates
    vb_x, vb_y, vb_w, vb_h = _compute_stroke_bounds(strokes)

    # Build SVG using ElementTree for proper escaping
    svg_ns = "http://www.w3.org/2000/svg"
    ET.register_namespace("", svg_ns)

    root = ET.Element(
        "svg",
        xmlns=svg_ns,
        viewBox=f"{vb_x:.1f} {vb_y:.1f} {vb_w:.1f} {vb_h:.1f}",
    )

    # Background
    if not transparent_bg:
        ET.SubElement(root, "rect", {
            "width": "100%",
            "height": "100%",
            "fill": "#FFFFFF",
        })

    # Group for strokes
    g = ET.SubElement(root, "g", {
        "fill": "none",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
    })

    for stroke in strokes:
        if stroke.is_eraser:
            continue

        path_data = _stroke_to_svg_path(stroke)
        if not path_data:
            continue

        avg_w = _average_width(stroke)

        attrs = {
            "d": path_data,
            "stroke": stroke.hex_color,
            "stroke-width": f"{avg_w:.2f}",
        }

        if stroke.is_highlighter:
            attrs["opacity"] = str(HIGHLIGHTER_OPACITY)

        ET.SubElement(g, "path", attrs)

    # Serialize
    return ET.tostring(root, encoding="unicode", xml_declaration=False)


# ---------------------------------------------------------------------------
# High-level rendering functions
# ---------------------------------------------------------------------------

def render_rm_file_to_svg(
    rm_path: str,
    transparent_bg: bool = False,
) -> str:
    """
    Render an .rm file to SVG with automatic format detection.

    Args:
        rm_path: Path to the .rm file.
        transparent_bg: If True, omit background (for PDF overlay).

    Returns:
        SVG document as a string.
    """
    strokes = extract_strokes(rm_path)
    return render_strokes_to_svg(strokes, transparent_bg=transparent_bg)


def render_page_strokes(
    rm_path: str,
    page_index: int = 0,
    for_pdf_overlay: bool = False,
    pdf_page_width: Optional[float] = None,
    pdf_page_height: Optional[float] = None,
) -> Optional[str]:
    """
    Render strokes from a single .rm page file.

    For PDF overlay mode, uses transparent background and optionally
    scales the SVG viewBox to match PDF page dimensions.

    Args:
        rm_path: Path to the .rm file.
        page_index: 0-based page index (for logging only).
        for_pdf_overlay: If True, use transparent background.
        pdf_page_width: Optional PDF page width for viewBox scaling.
        pdf_page_height: Optional PDF page height for viewBox scaling.

    Returns:
        SVG string, or None if the file has no renderable strokes.
    """
    try:
        strokes = extract_strokes(rm_path)
    except (ValueError, ImportError, OSError):
        return None

    if not strokes:
        return None

    width = pdf_page_width if pdf_page_width else RM_SCREEN_WIDTH
    height = pdf_page_height if pdf_page_height else RM_SCREEN_HEIGHT

    return render_strokes_to_svg(
        strokes,
        width=width,
        height=height,
        transparent_bg=for_pdf_overlay,
    )
