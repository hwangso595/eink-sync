"""
Render reMarkable .rm stroke data as a PNG image using PyMuPDF (fitz).

Takes an .rm file path and renders the strokes directly onto a blank canvas
at the reMarkable's native resolution (1404x1872). No coordinate mapping
to PDF pages is needed -- the .rm stroke coordinates are used as-is.

Pen rendering modes:
    - Pencil types (1, 7, 13, 14): Particle-scatter rendering that simulates
      graphite texture. Particles are scattered along the stroke path with
      density based on pressure and opacity based on tilt.
    - Paintbrush (0, 12): Semi-transparent overlapping strokes with soft edges.
    - Ballpoint/Fineliner (2, 4, 15, 17): Clean solid lines.
    - Highlighter (5, 18): Semi-transparent yellow overlay.
    - Shader (23): Light gray particle scatter for shading.
    - Eraser (6, 8): Skipped.
"""

import math
import os
import random
from typing import Optional

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None  # type: ignore[assignment]

from constants import RM_SCREEN_WIDTH, RM_SCREEN_HEIGHT
from stroke_renderer import (
    Stroke,
    StrokePoint,
    extract_strokes,
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
            "PyMuPDF (fitz) is required for PNG rendering. "
            "Install with: pip install PyMuPDF"
        )


def _hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    """Convert a hex color string like '#FF0000' to (r, g, b) floats 0..1."""
    hex_color = hex_color.lstrip("#")
    r = int(hex_color[0:2], 16) / 255.0
    g = int(hex_color[2:4], 16) / 255.0
    b = int(hex_color[4:6], 16) / 255.0
    return (r, g, b)


# Pen types that use particle-scatter rendering (pencil/graphite texture)
PENCIL_PEN_TYPES = {1, 7, 13, 14}
SHADER_PEN_TYPE = 23
BRUSH_PEN_TYPES = {0, 12}


def _segment_width(point: StrokePoint, stroke: Stroke, tilt_override: float = -1) -> float:
    """
    Compute the line width for a segment at a given point.
    tilt_override: if >= 0, use this instead of point.tilt (for smoothed values)
    """
    raw_width = point.width if point.width > 0 else 1.0
    base = raw_width / 20.0
    pen_factor = stroke.stroke_width

    # Per-pen-type width scaling
    pen_scale = {
        1: 1.01, 7: 1.01, 13: 1.01, 14: 1.01,  # Pencils — iterative sweep
        23: 1.0,  # Shader — wide
        4: 0.7, 17: 0.7,  # Fineliners
    }.get(stroke.pen_type, 1.0)

    # Pencil types use higher pressure width scale (tuned via multi-page sweep)
    pws = 1.21 if stroke.pen_type in (1, 7, 13, 14, 23) else PRESSURE_WIDTH_SCALE
    width = base * pen_factor * pws * pen_scale

    # Tilt = wider stroke (side of pencil). rM1 tilt ranges 0-255
    tilt = tilt_override if tilt_override >= 0 else point.tilt
    if tilt > 10:
        tilt_norm = min(tilt / 255.0, 1.0)
        tilt_factor = 1.0 + tilt_norm * 1.54  # iterative sweep
        width *= tilt_factor

    if stroke.is_highlighter:
        return max(8.0, width)
    return max(0.5, min(width, 25.0))


def _compute_offsets(strokes: list[Stroke]) -> tuple[float, float]:
    """
    Compute minimal offsets so content fits in the canvas.

    Small negative coordinates (margin annotations) are clipped — matching
    the tablet's behavior. Only shift when content extends far off-canvas.
    Threshold: only offset if min coordinate is below -200 (significant content
    outside the visible area).
    """
    min_x = 0.0
    min_y = 0.0
    for stroke in strokes:
        if stroke.is_eraser:
            continue
        for pt in stroke.points:
            if pt.x < min_x:
                min_x = pt.x
            if pt.y < min_y:
                min_y = pt.y
    # Only offset if content extends significantly beyond the canvas
    offset_x = -min_x if min_x < -200 else 0.0
    offset_y = -min_y if min_y < -200 else 0.0
    return offset_x, offset_y


def _scatter_particles_on_segment(
    pixmap: "fitz.Pixmap",
    x0: float, y0: float, x1: float, y1: float,
    width: float, pressure: float, tilt: float,
    color: tuple[int, int, int],
    is_shader: bool = False,
) -> None:
    """
    Draw a pencil/graphite segment by scattering particles between two points.

    Simulates graphite by placing semi-random dots along and around the stroke path.
    - Higher pressure = more particles (denser coverage)
    - Higher tilt = wider scatter, fewer particles per area (lighter shading)
    - Particles are slightly randomized in position for natural texture
    """
    dx = x1 - x0
    dy = y1 - y0
    length = math.sqrt(dx * dx + dy * dy)
    if length < 0.5:
        return

    # Normalize direction
    nx = dx / length
    ny = dy / length
    # Perpendicular
    px = -ny
    py = nx

    # Particle density based on pressure (0-255)
    pressure_norm = min(pressure / 255.0, 1.0)

    # Tilt affects scatter width and density
    tilt_norm = min(tilt / 255.0, 1.0) if tilt > 10 else 0.0

    # Base particles per pixel of stroke length
    if is_shader:
        density = 1.5 + pressure_norm * 3.0
        scatter_width = width * 1.5
        alpha_base = 0.10 + pressure_norm * 0.20
    else:
        # Pencil rendering — smooth blend between writing and shading modes:
        # tilt_norm 0.0 = upright (writing): tight scatter, dense, solid
        # tilt_norm 1.0 = fully tilted (shading): wide scatter, light, grainy
        # Smooth interpolation between the two extremes
        # Parameters from 5-round iterative sweep (score 13.2)
        writing_scatter = width * 2.10
        shading_scatter = width * 0.515 * (1.0 + tilt_norm * 3.04)
        scatter_width = writing_scatter + tilt_norm * (shading_scatter - writing_scatter)

        width_factor = min(4.59, max(1.0, scatter_width / 8.82))
        writing_density = (1.24 + pressure_norm * 18.28) * width_factor
        shading_density = (1.53 + pressure_norm * 3.82) * width_factor
        density = writing_density + tilt_norm * (shading_density - writing_density)

        # Super-linear pressure curve (1.51) — heavy pressure gets dark fast
        pn_curved = pressure_norm ** 1.51
        base_alpha = 0.067 + pn_curved * 0.692
        tilt_alpha_reduction = tilt_norm * 0.379
        alpha_base = base_alpha * (1.0 - tilt_alpha_reduction)

    num_particles = max(1, int(length * density))

    w = pixmap.width
    h = pixmap.height
    n = pixmap.n  # number of components (3 for RGB, 4 for RGBA)
    samples = pixmap.samples_mv  # mutable memoryview

    r, g, b = color

    rng = random.Random(int(x0 * 1000 + y0 * 7))  # deterministic seed for consistency

    half_w = scatter_width * 0.5

    for i in range(num_particles):
        # Position along the segment with slight overshoot for smooth blending
        t = rng.random() * 1.1 - 0.05
        cx = x0 + dx * t
        cy = y0 + dy * t

        # Random offset perpendicular to stroke direction
        # Use gaussian-like distribution (sum of randoms) for natural falloff from center
        r1 = rng.random() + rng.random() + rng.random()
        offset = (r1 / 3.0 - 0.5) * 2.0 * half_w
        cx += px * offset
        cy += py * offset

        # Jitter increases with tilt (shading mode needs more randomness to avoid banding)
        jitter = 2.0 + tilt_norm * 5.0
        cx += (rng.random() - 0.5) * jitter
        cy += (rng.random() - 0.5) * jitter

        ix = int(cx)
        iy = int(cy)

        if ix < 0 or ix >= w or iy < 0 or iy >= h:
            continue

        # Particle alpha varies randomly for texture
        alpha = alpha_base * (0.5 + rng.random() * 0.5)
        alpha = min(alpha, 1.0)

        if ix < 0 or ix >= w or iy < 0 or iy >= h:
            continue

        # Blend particle with existing pixel
        idx = (iy * w + ix) * n
        if n >= 3:
            samples[idx] = int(samples[idx] * (1 - alpha) + r * alpha)
            samples[idx + 1] = int(samples[idx + 1] * (1 - alpha) + g * alpha)
            samples[idx + 2] = int(samples[idx + 2] * (1 - alpha) + b * alpha)


def _smooth_tilts(points: list[StrokePoint]) -> list[float]:
    """
    Smooth tilt values across a stroke to avoid hard transitions.

    The reMarkable always reports tilt=0 for the first and last point of a stroke
    (pen touchdown/liftoff). This creates abrupt thin-thick-thin transitions.
    We fix this by:
    1. Replacing start/end tilt=0 with the nearest real tilt value
    2. Applying a moving average to smooth transitions
    """
    if len(points) < 3:
        return [p.tilt for p in points]

    tilts = [p.tilt for p in points]

    # Fix start: if first few points are 0 but middle isn't, use middle value
    first_nonzero = next((i for i, t in enumerate(tilts) if t > 10), len(tilts))
    if first_nonzero < len(tilts) and first_nonzero > 0:
        fill_val = tilts[first_nonzero]
        for i in range(first_nonzero):
            tilts[i] = fill_val

    # Fix end: if last few points are 0 but middle isn't, use middle value
    last_nonzero = next((i for i in range(len(tilts) - 1, -1, -1) if tilts[i] > 10), -1)
    if last_nonzero >= 0 and last_nonzero < len(tilts) - 1:
        fill_val = tilts[last_nonzero]
        for i in range(last_nonzero + 1, len(tilts)):
            tilts[i] = fill_val

    # Moving average (window=9) for smooth transitions
    smoothed = tilts[:]
    window = 9
    half = window // 2
    for i in range(len(tilts)):
        start = max(0, i - half)
        end = min(len(tilts), i + half + 1)
        smoothed[i] = sum(tilts[start:end]) / (end - start)

    return smoothed


def render_strokes_to_png(
    strokes: list[Stroke],
    output_path: str,
    transparent_bg: bool = False,
    pdf_path: str = None,
    page_index: int = 0,
) -> int:
    """
    Render a list of strokes as a PNG image using PyMuPDF.

    Uses two rendering modes:
    - Pencil/shader types: particle-scatter for graphite texture
    - Other types: Shape API line drawing

    Returns number of strokes actually drawn.
    """
    _require_fitz()

    if not strokes:
        return 0

    # Filter out erasers early
    renderable = [s for s in strokes if not s.is_eraser]
    if not renderable:
        return 0

    canvas_w = RM_SCREEN_WIDTH
    canvas_h = RM_SCREEN_HEIGHT

    offset_x, offset_y = _compute_offsets(renderable)
    # Keep canvas at native resolution — don't expand for negative coordinates
    canvas_w_int = int(canvas_w)
    canvas_h_int = int(canvas_h)

    # Create document and page for Shape API (non-pencil strokes)
    # If a PDF is provided, use the PDF page as the background
    pdf_doc = None
    if pdf_path and os.path.exists(pdf_path):
        try:
            pdf_doc = fitz.open(pdf_path)
            if page_index < len(pdf_doc):
                pdf_page = pdf_doc[page_index]
                pdf_rect = pdf_page.rect

                # bestFit: scale PDF to fit canvas width with toolbar offset.
                # The reMarkable has a ~230px toolbar at the top that pushes
                # PDF content down. Stroke coordinates include this offset.
                RM_TOOLBAR_OFFSET = 230
                scale = canvas_w_int / pdf_rect.width
                scaled_w = canvas_w_int
                scaled_h = pdf_rect.height * scale
                x_offset = 0
                y_offset = RM_TOOLBAR_OFFSET

                mat = fitz.Matrix(scale, scale)
                pix = pdf_page.get_pixmap(matrix=mat)

                doc = fitz.open()
                page = doc.new_page(width=canvas_w_int, height=canvas_h_int)
                # White background
                shape = page.new_shape()
                shape.draw_rect(fitz.Rect(0, 0, canvas_w_int, canvas_h_int))
                shape.finish(color=(1, 1, 1), fill=(1, 1, 1))
                shape.commit()
                # Insert PDF centered
                page.insert_image(
                    fitz.Rect(x_offset, y_offset, x_offset + scaled_w, y_offset + scaled_h),
                    pixmap=pix,
                )
            else:
                doc = fitz.open()
                page = doc.new_page(width=canvas_w_int, height=canvas_h_int)
        except Exception:
            doc = fitz.open()
            page = doc.new_page(width=canvas_w_int, height=canvas_h_int)
    else:
        doc = fitz.open()
        page = doc.new_page(width=canvas_w_int, height=canvas_h_int)

    # Draw white background only for notebooks (PDFs have their own background)
    if not transparent_bg and not pdf_doc:
        shape = page.new_shape()
        shape.draw_rect(fitz.Rect(0, 0, canvas_w_int, canvas_h_int))
        shape.finish(color=(1, 1, 1), fill=(1, 1, 1))
        shape.commit()

    if pdf_doc:
        pdf_doc.close()

    drawn = 0

    # First pass: draw ALL strokes using Shape API
    # Pencil/shader get semi-transparent base lines; particles added in second pass
    for stroke in renderable:
        points = stroke.points
        if not points:
            continue

        is_pencil = stroke.pen_type in PENCIL_PEN_TYPES
        is_shader = stroke.pen_type == SHADER_PEN_TYPE
        is_brush = stroke.pen_type in BRUSH_PEN_TYPES

        # Color
        rgb = _hex_to_rgb(stroke.hex_color)
        is_hl = stroke.is_highlighter

        if len(points) == 1:
            pt = points[0]
            px = pt.x + offset_x
            py = pt.y + offset_y
            r = _segment_width(pt, stroke) * 0.5
            shape = page.new_shape()
            shape.draw_circle(fitz.Point(px, py), max(r, 0.5))
            shape.finish(color=rgb, fill=rgb, width=0)
            shape.commit(overlay=True)
            drawn += 1
            continue

        if is_hl:
            avg_w = sum(_segment_width(p, stroke) for p in points) / len(points)
            shape = page.new_shape()
            scaled_points = [
                fitz.Point(p.x + offset_x, p.y + offset_y) for p in points
            ]
            shape.draw_polyline(scaled_points)
            hl_rgb = _hex_to_rgb("#FFD700")
            shape.finish(
                color=hl_rgb, width=avg_w,
                stroke_opacity=HIGHLIGHTER_OPACITY, closePath=False,
            )
            shape.commit(overlay=True)
            drawn += 1
            continue

        # Pencil/shader: draw semi-transparent base line for consistent thickness
        # Particles will be added on top in the second pass for texture
        if is_pencil or is_shader:
            # Pencil/shader rendered entirely via particle scatter in pass 2
            # No base line needed — particles provide both coverage and texture
            continue

        # Non-pencil strokes: draw as polyline for smooth continuous stroke
        brush_opacity = 0.7 if is_brush else 1.0
        avg_w = sum(_segment_width(p, stroke) for p in points) / len(points)

        shape = page.new_shape()
        poly_points = [fitz.Point(p.x + offset_x, p.y + offset_y) for p in points]
        shape.draw_polyline(poly_points)
        shape.finish(
            color=rgb, width=avg_w, closePath=False,
            lineCap=1, stroke_opacity=brush_opacity,
        )
        shape.commit(overlay=True)

        drawn += 1

    # Render to pixmap for particle-based pencil/shader strokes
    if transparent_bg:
        pixmap = page.get_pixmap(alpha=True)
    else:
        pixmap = page.get_pixmap(alpha=False)

    # Second pass: pencil and shader strokes via particle scatter
    pencil_strokes = [s for s in renderable
                      if s.pen_type in PENCIL_PEN_TYPES or s.pen_type == SHADER_PEN_TYPE]

    if pencil_strokes:
        for stroke in pencil_strokes:
            points = stroke.points
            if not points or len(points) < 2:
                if len(points) == 1:
                    # Single dot
                    pt = points[0]
                    px = int(pt.x + offset_x)
                    py = int(pt.y + offset_y)
                    if 0 <= px < pixmap.width and 0 <= py < pixmap.height:
                        idx = (py * pixmap.width + px) * pixmap.n
                        if pixmap.n >= 3:
                            pixmap.samples_mv[idx] = 0
                            pixmap.samples_mv[idx + 1] = 0
                            pixmap.samples_mv[idx + 2] = 0
                    drawn += 1
                continue

            is_shader = stroke.pen_type == SHADER_PEN_TYPE
            if is_shader:
                color = (128, 128, 128)  # gray
            else:
                hex_c = stroke.hex_color.lstrip("#")
                color = (
                    int(hex_c[0:2], 16),
                    int(hex_c[2:4], 16),
                    int(hex_c[4:6], 16),
                )

            # Smooth tilt values to avoid hard transitions mid-stroke
            smoothed_tilts = _smooth_tilts(points)

            for i in range(len(points) - 1):
                p0 = points[i]
                p1 = points[i + 1]
                x0 = p0.x + offset_x
                y0 = p0.y + offset_y
                x1 = p1.x + offset_x
                y1 = p1.y + offset_y
                smooth_tilt = smoothed_tilts[i]
                w = _segment_width(p0, stroke, tilt_override=smooth_tilt)

                _scatter_particles_on_segment(
                    pixmap, x0, y0, x1, y1, w,
                    p0.pressure, smooth_tilt, color,
                    is_shader=is_shader,
                )

            drawn += 1

    # Save
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    pixmap.save(output_path)
    doc.close()
    return drawn


def render_rm_file_to_png(
    rm_path: str,
    output_path: str,
    transparent_bg: bool = False,
    pdf_path: str = None,
    page_index: int = 0,
) -> int:
    """
    Convenience: parse an .rm file and render its strokes as a PNG.
    For PDF documents, pass pdf_path and page_index to render strokes
    on top of the PDF page content.
    """
    strokes = extract_strokes(rm_path)
    if not strokes:
        return 0
    return render_strokes_to_png(strokes, output_path, transparent_bg,
                                 pdf_path=pdf_path, page_index=page_index)
