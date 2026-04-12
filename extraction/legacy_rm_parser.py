"""
Parse legacy v3 and v5 .rm (a.k.a. .lines) binary files from firmware < 3.0.

The v3/v5 binary format stores pen strokes as sequences of points with
coordinates, speed, direction, width, and pressure. Highlights are represented
as thick semi-transparent strokes (the highlighter tool).

Binary layout (v5):
  Header:  "reMarkable .lines file, version=N"  (43 bytes + padding to 48)
  int32:   number_of_layers
  For each layer:
    int32:  number_of_strokes
    For each stroke:
      int32:  pen_type      (0-8, 15-17; 5/18 = highlighter)
      int32:  color          (0=black, 1=gray, 2=white, 3=yellow, 4=green, 5=pink)
      int32:  unknown_1      (padding/reserved)
      float32: stroke_width
      int32:  unknown_2      (v5 only: segment transform or similar)
      int32:  number_of_points
      For each point:
        float32: x            (in reMarkable coordinates: 0-1404)
        float32: y            (in reMarkable coordinates: 0-1872)
        float32: speed
        float32: direction    (tilt)
        float32: width        (pressure-based)
        float32: pressure

v3 is similar but lacks the unknown_2 field per stroke.

This parser extracts highlight strokes only (pen_type == 5 or 18) and returns
their bounding rectangles, which are then used for rectangle-based text
extraction from the source PDF.
"""

import struct
from dataclasses import dataclass
from typing import Optional

from constants import RM_SCREEN_WIDTH, RM_SCREEN_HEIGHT


# Highlighter pen type IDs in reMarkable firmware < 3.0
HIGHLIGHTER_PEN_TYPES = {5, 18}

# Header sizes
V3_HEADER_SIZE = 48  # 43 chars + padding
V5_HEADER_SIZE = 48

# Color mapping for legacy format
LEGACY_COLOR_MAP = {
    0: "black",
    1: "gray",
    2: "white",
    3: "yellow",
    4: "green",
    5: "pink",
}

# Backwards-compatible aliases
RM_WIDTH = RM_SCREEN_WIDTH
RM_HEIGHT = RM_SCREEN_HEIGHT


@dataclass
class LegacyHighlightStroke:
    """A single highlight stroke from a legacy .rm file."""

    pen_type: int
    color: str
    width: float
    points: list[tuple[float, float]]  # (x, y) pairs
    bounds: dict  # {x, y, width, height} in reMarkable coordinates


@dataclass
class LegacyHighlightRegion:
    """
    A region of highlights on a page, formed by grouping nearby strokes.

    Multiple strokes from the same highlighter pass are merged into a single
    region for text extraction.
    """

    color: str
    bounds: dict  # {x, y, width, height} in reMarkable coordinates
    stroke_count: int


def _detect_version(header_bytes: bytes) -> Optional[int]:
    """Detect the version number from header bytes."""
    header_str = header_bytes[:48].decode("ascii", errors="replace")
    if "version=5" in header_str:
        return 5
    if "version=3" in header_str:
        return 3
    return None


def _compute_bounds(points: list[tuple[float, float]], stroke_width: float) -> dict:
    """Compute bounding box for a list of points, adding half stroke width as padding."""
    if not points:
        return {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    half_w = stroke_width / 2.0

    min_x = min(xs) - half_w
    min_y = min(ys) - half_w
    max_x = max(xs) + half_w
    max_y = max(ys) + half_w

    return {
        "x": max(0.0, min_x),
        "y": max(0.0, min_y),
        "width": max_x - min_x,
        "height": max_y - min_y,
    }


def _merge_nearby_strokes(
    strokes: list[LegacyHighlightStroke],
    y_merge_threshold: float = 40.0,
) -> list[LegacyHighlightRegion]:
    """
    Merge highlight strokes that are close together vertically into regions.

    Highlighter strokes on the same line of text typically have similar y
    coordinates. We group strokes whose y-ranges overlap or are within
    y_merge_threshold pixels of each other, then compute a combined bounding box.
    """
    if not strokes:
        return []

    # Sort by y center
    sorted_strokes = sorted(strokes, key=lambda s: s.bounds["y"])

    regions: list[LegacyHighlightRegion] = []
    current_group: list[LegacyHighlightStroke] = [sorted_strokes[0]]

    for i in range(1, len(sorted_strokes)):
        stroke = sorted_strokes[i]
        prev = current_group[-1]

        prev_bottom = prev.bounds["y"] + prev.bounds["height"]
        curr_top = stroke.bounds["y"]

        if curr_top - prev_bottom <= y_merge_threshold and stroke.color == prev.color:
            current_group.append(stroke)
        else:
            # Flush current group
            regions.append(_group_to_region(current_group))
            current_group = [stroke]

    # Flush final group
    if current_group:
        regions.append(_group_to_region(current_group))

    return regions


def _group_to_region(strokes: list[LegacyHighlightStroke]) -> LegacyHighlightRegion:
    """Convert a group of strokes into a single highlight region."""
    all_bounds = [s.bounds for s in strokes]

    min_x = min(b["x"] for b in all_bounds)
    min_y = min(b["y"] for b in all_bounds)
    max_x = max(b["x"] + b["width"] for b in all_bounds)
    max_y = max(b["y"] + b["height"] for b in all_bounds)

    return LegacyHighlightRegion(
        color=strokes[0].color,
        bounds={
            "x": min_x,
            "y": min_y,
            "width": max_x - min_x,
            "height": max_y - min_y,
        },
        stroke_count=len(strokes),
    )


def parse_legacy_rm_file(file_path: str) -> list[LegacyHighlightRegion]:
    """
    Parse a legacy v3/v5 .rm file and extract highlight regions.

    Only highlighter strokes (pen type 5 or 18) are extracted.
    Nearby strokes are merged into regions for text extraction.

    Args:
        file_path: Path to the .rm file.

    Returns:
        List of LegacyHighlightRegion objects.

    Raises:
        ValueError: If the file format is not v3 or v5.
        OSError: If the file cannot be read.
    """
    with open(file_path, "rb") as f:
        data = f.read()

    if len(data) < V5_HEADER_SIZE + 4:
        raise ValueError(f"File too small to be a valid .rm file: {file_path}")

    version = _detect_version(data[:V5_HEADER_SIZE])
    if version is None:
        raise ValueError(
            f"Not a v3/v5 .rm file (unrecognized header): {file_path}"
        )

    offset = V5_HEADER_SIZE

    # Number of layers
    if offset + 4 > len(data):
        raise ValueError(f"Truncated file: cannot read layer count: {file_path}")

    (num_layers,) = struct.unpack_from("<i", data, offset)
    offset += 4

    highlight_strokes: list[LegacyHighlightStroke] = []

    for _layer_idx in range(num_layers):
        if offset + 4 > len(data):
            break

        (num_strokes,) = struct.unpack_from("<i", data, offset)
        offset += 4

        for _stroke_idx in range(num_strokes):
            if offset + 16 > len(data):
                break

            # Read stroke header
            pen_type, color_id, _unknown1 = struct.unpack_from("<iii", data, offset)
            offset += 12

            (stroke_width,) = struct.unpack_from("<f", data, offset)
            offset += 4

            # v5 has an extra int32 field
            if version == 5:
                if offset + 4 > len(data):
                    break
                offset += 4  # skip unknown_2

            if offset + 4 > len(data):
                break

            (num_points,) = struct.unpack_from("<i", data, offset)
            offset += 4

            # Sanity check: prevent absurd allocations from corrupt data
            if num_points < 0 or num_points > 1_000_000:
                raise ValueError(
                    f"Suspicious point count ({num_points}) in stroke -- file may be corrupt"
                )

            # Read points: 6 float32s per point
            points_bytes = 6 * 4 * num_points
            if offset + points_bytes > len(data):
                break

            points: list[tuple[float, float]] = []
            for _pt_idx in range(num_points):
                x, y = struct.unpack_from("<ff", data, offset)
                offset += 6 * 4  # skip speed, direction, width, pressure
                points.append((x, y))

            # Only keep highlighter strokes
            if pen_type in HIGHLIGHTER_PEN_TYPES and points:
                color_name = LEGACY_COLOR_MAP.get(color_id, f"unknown_{color_id}")
                bounds = _compute_bounds(points, stroke_width)
                highlight_strokes.append(
                    LegacyHighlightStroke(
                        pen_type=pen_type,
                        color=color_name,
                        width=stroke_width,
                        points=points,
                        bounds=bounds,
                    )
                )

    return _merge_nearby_strokes(highlight_strokes)
