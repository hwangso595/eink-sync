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
    extract_glyph_highlights,
    GlyphHighlight,
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

# Truncation: when a notebook page's content sits entirely within this fraction
# of the standard page height, the rendered canvas is cropped to just below the
# content. This keeps short "quick sheet" pages from embedding a tall blank area
# in the note. Only applied to notebook renders (no PDF background).
TRUNCATE_HEIGHT_THRESHOLD = 0.5
# Never crop shorter than this, so even a single line of writing renders sanely.
MIN_TRUNCATED_HEIGHT = 240


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
    # Non-pencil strokes are rendered as pixmap circles; 0.5 scale matched
    # by visual sweep against the tablet's own thumbnail.
    non_pencil_scale = 0.5 if stroke.pen_type not in (1, 7, 13, 14, 23) else 1.0
    width = base * pen_factor * pws * pen_scale * non_pencil_scale

    # Tilt = wider stroke (side of pencil). rM1 tilt ranges 0-255
    tilt = tilt_override if tilt_override >= 0 else point.tilt
    if tilt > 10:
        tilt_norm = min(tilt / 255.0, 1.0)
        tilt_factor = 1.0 + tilt_norm * 1.54  # iterative sweep
        width *= tilt_factor

    if stroke.is_highlighter:
        # Highlighter has fixed width stored in stroke.stroke_width (in pt).
        # point.width for highlights is an internal tablet value unrelated to
        # visible width — using it would produce ~200px wide highlights.
        return max(8.0, stroke.stroke_width)
    return max(0.5, min(width, 25.0))


def _smooth_widths(points: list[StrokePoint], stroke: Stroke) -> list[float]:
    """Smooth per-point widths with a small moving average to reduce jaggedness."""
    raw = [_segment_width(p, stroke) for p in points]
    if len(raw) < 3:
        return raw
    smoothed = raw[:]
    window = 5
    half = window // 2
    for i in range(len(raw)):
        start = max(0, i - half)
        end = min(len(raw), i + half + 1)
        smoothed[i] = sum(raw[start:end]) / (end - start)
    return smoothed


def _compute_offsets(strokes: list[Stroke],
                     canvas_w: float = RM_SCREEN_WIDTH,
                     canvas_h: float = RM_SCREEN_HEIGHT) -> tuple[float, float]:
    """
    Compute minimal offsets so content fits in the canvas.

    Only shifts an axis when:
      1. Content extends to the negative side (min < -50), AND
      2. Shifting would NOT push the positive-side content off canvas.

    This prevents left-margin annotations (large negative x) from displacing
    on-page content off the right edge.
    """
    min_x = min_y = 0.0
    max_x = max_y = 0.0
    for stroke in strokes:
        if stroke.is_eraser:
            continue
        for pt in stroke.points:
            if pt.x < min_x:
                min_x = pt.x
            if pt.x > max_x:
                max_x = pt.x
            if pt.y < min_y:
                min_y = pt.y
            if pt.y > max_y:
                max_y = pt.y

    shift_x = -min_x if min_x < -50 else 0.0
    if shift_x > 0 and max_x + shift_x > canvas_w:
        shift_x = 0.0  # shifting would push positive content off the right edge

    shift_y = -min_y if min_y < -50 else 0.0
    if shift_y > 0 and max_y + shift_y > canvas_h:
        shift_y = 0.0  # shifting would push positive content off the bottom

    return shift_x, shift_y


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


def _draw_solid_circles_on_pixmap(
    pixmap: "fitz.Pixmap",
    canvas_pts: list,
    smooth_ws: list[float],
    color: tuple[int, int, int],
    opacity: float = 1.0,
) -> None:
    """
    Render a non-pencil stroke as overlapping filled circles on the pixmap.

    Painting directly on the pixmap (like the pencil scatter pass) avoids
    PyMuPDF's Shape API entirely, sidestepping:
      - The lineJoin bug (inserts literal keyword into PDF stream)
      - Miter-joint spikes at sharp V-turns
      - PDF winding-rule fill that turns closed-loop doodles into solid blobs

    Adjacent circles overlap and create a solid-looking stroke. Because this
    is direct pixel blending (not PDF path fill), enclosed areas stay empty.
    """
    w = pixmap.width
    h = pixmap.height
    n = pixmap.n
    samples = pixmap.samples_mv
    r_c, g_c, b_c = color

    def _paint_circle(cx: float, cy: float, radius: float) -> None:
        # Expand by 1 px for the anti-aliasing fringe
        outer = radius + 1.0
        ix0 = max(0, int(cx - outer))
        ix1 = min(w - 1, int(cx + outer) + 1)
        iy0 = max(0, int(cy - outer))
        iy1 = min(h - 1, int(cy + outer) + 1)
        for iy in range(iy0, iy1 + 1):
            dy = iy - cy
            dy2 = dy * dy
            if dy2 > outer * outer:
                continue
            row_base = iy * w * n
            for ix in range(ix0, ix1 + 1):
                dist2 = (ix - cx) ** 2 + dy2
                if dist2 <= radius * radius:
                    # Fully inside — apply at full opacity
                    a = opacity
                elif dist2 <= outer * outer:
                    # Anti-aliasing fringe: linearly fade over the last pixel
                    dist = math.sqrt(dist2)
                    a = opacity * max(0.0, outer - dist)
                else:
                    continue
                if a <= 0.0:
                    continue
                idx = row_base + ix * n
                inv = 1.0 - a
                samples[idx]     = int(samples[idx]     * inv + r_c * a)
                samples[idx + 1] = int(samples[idx + 1] * inv + g_c * a)
                samples[idx + 2] = int(samples[idx + 2] * inv + b_c * a)

    if not canvas_pts:
        return

    # Paint the first point unconditionally.
    r0 = max(smooth_ws[0] * 0.5, 0.5)
    _paint_circle(canvas_pts[0].x, canvas_pts[0].y, r0)
    last_cx, last_cy, last_r = canvas_pts[0].x, canvas_pts[0].y, r0

    for i in range(1, len(canvas_pts)):
        pt = canvas_pts[i]
        cx = pt.x
        cy = pt.y
        radius = max(smooth_ws[i] * 0.5, 0.5)

        dx_step = cx - last_cx
        dy_step = cy - last_cy
        dist = math.sqrt(dx_step * dx_step + dy_step * dy_step)

        if dist < radius * 0.5:
            # Too close — earlier circle already covers this; skip.
            continue

        if dist > last_r:
            # Gap between consecutive sample points: interpolate circles
            # spaced every half-radius to ensure continuous coverage.
            step_size = max(last_r * 0.5, 0.5)
            steps = max(1, int(dist / step_size))
            for s in range(1, steps):
                t = s / steps
                _paint_circle(last_cx + dx_step * t,
                               last_cy + dy_step * t,
                               last_r + (radius - last_r) * t)

        _paint_circle(cx, cy, radius)
        last_cx, last_cy, last_r = cx, cy, radius


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
    coord_scale: float = None,
    glyph_highlights: list = None,
    truncate_blank: bool = False,
) -> int:
    """
    Render a list of strokes as a PNG image using PyMuPDF.

    Uses two rendering modes:
    - Pencil/shader types: particle-scatter for graphite texture
    - Other types: Shape API line drawing

    coord_scale: stroke coordinate scale factor. Pass 226/300 for PDF documents,
    1.0 for notebooks. If None, falls back to auto-detection (unreliable for PDF
    pages where strokes don't happen to exceed canvas height).

    truncate_blank: for notebook renders (no PDF background), crop trailing blank
    space when the content occupies less than TRUNCATE_HEIGHT_THRESHOLD of the
    page height. Ignored for PDF-backed pages (their geometry is fixed). Off by
    default so untouched pages render byte-for-byte identically.

    Returns number of strokes actually drawn.
    """
    _require_fitz()

    # Filter out erasers early
    renderable = [s for s in strokes if not s.is_eraser] if strokes else []
    if not renderable and not glyph_highlights:
        return 0

    canvas_w = RM_SCREEN_WIDTH
    canvas_h = RM_SCREEN_HEIGHT

    # reMarkable coordinate system:
    #   x=0 is the horizontal centre of the page (negative = left, positive = right)
    #   y=0 is the top of the UI including toolbar; strokes start below the toolbar
    #
    # PDF documents use a 300-DPI logical space (scale=226/300≈0.753).
    # Notebooks use 1:1 screen-pixel coordinates (scale=1.0).
    # Callers should pass coord_scale explicitly; auto-detect is a fallback only.
    if coord_scale is not None:
        COORD_SCALE = coord_scale
    else:
        all_ys = [pt.y for s in renderable for pt in s.points]
        max_stroke_y = max(all_ys) if all_ys else 0.0
        COORD_SCALE = (226 / 300) if max_stroke_y > canvas_h * 1.05 else 1.0

    # x: centre-origin → shift by half the canvas width
    # y: no per-stroke offset; the PDF background carries the toolbar offset below
    x_origin = canvas_w / 2  # coord x=0 maps to the horizontal centre of the canvas
    offset_x, offset_y = x_origin, 0.0
    canvas_w_int = int(canvas_w)
    canvas_h_int = int(canvas_h)

    # Notebooks are a vertically- (and slightly horizontally-) scrollable canvas:
    # strokes can extend past the standard 1404x1872 screen (verticalScroll pages).
    # A fixed canvas silently clips that scrolled-in content (the pixmap bounds
    # checks in the scatter/circle painters drop out-of-range pixels). For
    # notebooks (no PDF background) grow the canvas to the content's bounding box,
    # shifting right/down only when content spills off the top/left edge. Pages
    # that already fit get no shift and no growth, so their renders stay
    # byte-identical. PDFs keep fixed page geometry so strokes stay aligned to the
    # page background.
    if pdf_path is None:
        cxs = [pt.x * COORD_SCALE + offset_x for s in renderable for pt in s.points]
        cys = [pt.y * COORD_SCALE for s in renderable for pt in s.points]
        if glyph_highlights:
            for gh in glyph_highlights:
                for (rx, ry, rw, rh) in gh.rectangles:
                    cxs += [rx * COORD_SCALE + offset_x, (rx + rw) * COORD_SCALE + offset_x]
                    cys += [ry * COORD_SCALE, (ry + rh) * COORD_SCALE]
        if cxs and cys:
            MARGIN = 8
            min_cx, max_cx = min(cxs), max(cxs)
            min_cy, max_cy = min(cys), max(cys)
            if min_cx < 0:  # content off the left edge → shift right
                shift = -min_cx + MARGIN
                offset_x += shift
                max_cx += shift
            if min_cy < 0:  # content off the top edge → shift down
                shift = -min_cy + MARGIN
                offset_y += shift
                max_cy += shift
            # Grow ONLY when content genuinely spills past the standard page.
            # A page that fits inside 1404x1872 gets no shift and no growth, so it
            # renders byte-for-byte identically to the pre-fix output.
            if max_cx > canvas_w_int:
                canvas_w_int = int(math.ceil(max_cx)) + MARGIN
            if max_cy > canvas_h_int:
                canvas_h_int = int(math.ceil(max_cy)) + MARGIN

            # Crop trailing blank space for short pages. Only when the content's
            # bottom edge sits within the top TRUNCATE_HEIGHT_THRESHOLD of the
            # standard page (so a full page never shrinks). Width is left intact
            # to preserve horizontal layout.
            if truncate_blank:
                content_bottom = max_cy + MARGIN
                if content_bottom < RM_SCREEN_HEIGHT * TRUNCATE_HEIGHT_THRESHOLD:
                    canvas_h_int = max(int(math.ceil(content_bottom)), MIN_TRUNCATED_HEIGHT)

    # Create document and page for Shape API (non-pencil strokes)
    # If a PDF is provided, use the PDF page as the background
    pdf_doc = None
    if pdf_path and os.path.exists(pdf_path):
        try:
            pdf_doc = fitz.open(pdf_path)
            if page_index < len(pdf_doc):
                pdf_page = pdf_doc[page_index]
                pdf_rect = pdf_page.rect

                # bestFit: scale PDF to fit canvas width.
                # The toolbar occupies the top ~130 canvas-px; the PDF starts below it.
                # Strokes are in a coordinate system where y=0 is the screen top
                # (toolbar included), so placing the PDF at y_offset=130 aligns them.
                RM_TOOLBAR_HEIGHT = 0  # calibrated by visual sweep: cs=0.73, tb=0
                scale = canvas_w_int / pdf_rect.width
                scaled_w = canvas_w_int
                scaled_h = pdf_rect.height * scale
                x_offset = 0
                y_offset = RM_TOOLBAR_HEIGHT

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
    # Queue for non-pencil strokes rendered on pixmap in pass 2
    _non_pencil_queue: list = []
    # Queue for highlight strokes rendered last on pixmap (so they sit on top)
    _highlight_queue: list = []

    def _cx(v): return v * COORD_SCALE + offset_x   # offset_x = canvas_w/2
    def _cy(v): return v * COORD_SCALE + offset_y   # offset_y = 0

    # First pass: classify strokes into queues. Highlights go last so they
    # aren't covered by opaque non-pencil circles from pass 2.
    for stroke in renderable:
        points = stroke.points
        if not points:
            continue

        is_pencil = stroke.pen_type in PENCIL_PEN_TYPES
        is_shader = stroke.pen_type == SHADER_PEN_TYPE
        is_brush = stroke.pen_type in BRUSH_PEN_TYPES
        is_hl = stroke.is_highlighter

        if is_hl:
            smooth_ws = [_segment_width(p, stroke) for p in points]
            canvas_pts = [fitz.Point(_cx(pt.x), _cy(pt.y)) for pt in points]
            _highlight_queue.append((canvas_pts, smooth_ws))
            drawn += 1
            continue

        # Pencil/shader rendered entirely via particle scatter in pass 2
        if is_pencil or is_shader:
            continue

        # Non-pencil strokes are queued for pixmap rendering in pass 2.
        rgb = _hex_to_rgb(stroke.hex_color)
        brush_opacity = 0.7 if is_brush else 1.0
        smooth_ws = _smooth_widths(points, stroke)
        canvas_pts = [fitz.Point(_cx(pt.x), _cy(pt.y)) for pt in points]
        _non_pencil_queue.append((stroke, canvas_pts, smooth_ws, rgb, brush_opacity))

        drawn += 1

    # Render to pixmap for particle-based pencil/shader strokes AND
    # non-pencil strokes (also rendered directly on pixmap to avoid
    # PyMuPDF Shape API bugs: lineJoin spikes, PDF-fill blobs).
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
                    px = int(pt.x * COORD_SCALE + offset_x)
                    py = int(pt.y * COORD_SCALE + offset_y)
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
                x0 = p0.x * COORD_SCALE + offset_x
                y0 = p0.y * COORD_SCALE + offset_y
                x1 = p1.x * COORD_SCALE + offset_x
                y1 = p1.y * COORD_SCALE + offset_y
                smooth_tilt = smoothed_tilts[i]
                w = _segment_width(p0, stroke, tilt_override=smooth_tilt)

                _scatter_particles_on_segment(
                    pixmap, x0, y0, x1, y1, w,
                    p0.pressure, smooth_tilt, color,
                    is_shader=is_shader,
                )

            drawn += 1

    # Non-pencil strokes: solid filled circles on pixmap.
    # Done after pencil pass so both share the same final pixmap.
    for stroke, canvas_pts, smooth_ws, rgb, brush_opacity in _non_pencil_queue:
        hex_c = stroke.hex_color.lstrip("#")
        color = (
            int(hex_c[0:2], 16),
            int(hex_c[2:4], 16),
            int(hex_c[4:6], 16),
        )
        _draw_solid_circles_on_pixmap(pixmap, canvas_pts, smooth_ws, color,
                                      opacity=brush_opacity)

    # Highlight pass: painted last so they sit on top of all drawings.
    hl_color = (255, 215, 0)  # #FFD700 gold yellow

    # Stroke-based highlights (pen_type 5/18): circle rendering with gap-fill.
    if _highlight_queue:
        for canvas_pts, smooth_ws in _highlight_queue:
            _draw_solid_circles_on_pixmap(
                pixmap, canvas_pts, smooth_ws, hl_color,
                opacity=HIGHLIGHTER_OPACITY,
            )

    # Glyph-range highlights (SceneGlyphItemBlock): filled rectangles.
    # These are the text-selection highlights that reMarkable stores as
    # GlyphRange objects (with exact rectangles and text), NOT as strokes.
    if glyph_highlights:
        w = pixmap.width
        h = pixmap.height
        n = pixmap.n
        samples = pixmap.samples_mv
        r_c, g_c, b_c = hl_color
        a = HIGHLIGHTER_OPACITY
        inv = 1.0 - a
        for gh in glyph_highlights:
            for (rx, ry, rw, rh) in gh.rectangles:
                # Convert from reMarkable logical coords to canvas pixels.
                # x is center-origin; y is top-origin.
                cx0 = int(rx * COORD_SCALE + offset_x)
                cy0 = int(ry * COORD_SCALE + offset_y)
                cx1 = int((rx + rw) * COORD_SCALE + offset_x)
                cy1 = int((ry + rh) * COORD_SCALE + offset_y)
                cx0 = max(0, min(cx0, w - 1))
                cy0 = max(0, min(cy0, h - 1))
                cx1 = max(0, min(cx1, w - 1))
                cy1 = max(0, min(cy1, h - 1))
                for iy in range(cy0, cy1 + 1):
                    row_base = iy * w * n
                    for ix in range(cx0, cx1 + 1):
                        idx = row_base + ix * n
                        samples[idx]     = int(samples[idx]     * inv + r_c * a)
                        samples[idx + 1] = int(samples[idx + 1] * inv + g_c * a)
                        samples[idx + 2] = int(samples[idx + 2] * inv + b_c * a)

    # Save
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    pixmap.save(output_path)
    doc.close()
    return drawn


def extract_highlight_texts(
    strokes: list[Stroke],
    pdf_path: str,
    page_index: int,
    canvas_w: float = RM_SCREEN_WIDTH,
    canvas_h: float = RM_SCREEN_HEIGHT,
    toolbar_height: int = 0,
    coord_scale: float = None,
) -> list[str]:
    """
    Extract the PDF text that falls under each highlight stroke.

    Converts highlight stroke canvas coordinates back to PDF point coordinates
    using the inverse of the rendering transform, then uses PyMuPDF's
    get_text(clip=...) to pull the text from each highlighted region.

    Returns a list of non-empty text strings, one per highlight stroke that
    overlaps with PDF content.
    """
    _require_fitz()

    highlights = [s for s in strokes if s.is_highlighter]
    if not highlights or not pdf_path or not os.path.exists(pdf_path):
        return []

    try:
        pdf_doc = fitz.open(pdf_path)
        if page_index >= len(pdf_doc):
            pdf_doc.close()
            return []
        pdf_page = pdf_doc[page_index]
        pdf_rect = pdf_page.rect
    except Exception:
        return []

    canvas_w_int = int(canvas_w)

    # Determine COORD_SCALE: use caller-supplied value, or fall back to auto-detect.
    if coord_scale is not None:
        COORD_SCALE = coord_scale
    else:
        all_ys = [pt.y for s in strokes for pt in s.points]
        max_stroke_y = max(all_ys) if all_ys else 0.0
        COORD_SCALE = (226 / 300) if max_stroke_y > canvas_h * 1.05 else 1.0

    x_origin = canvas_w / 2
    scale = canvas_w_int / pdf_rect.width  # canvas px per PDF pt
    x_offset = 0
    y_offset = toolbar_height

    # Inverse transform: canvas px → PDF pt
    # canvas_x = raw_x * COORD_SCALE + x_origin  →  pdf_x = (canvas_x - x_offset) / scale
    # canvas_y = raw_y * COORD_SCALE              →  pdf_y = (canvas_y - y_offset) / scale

    texts = []
    for stroke in highlights:
        if not stroke.points:
            continue

        # Bounding box of this stroke in canvas coordinates
        xs = [pt.x * COORD_SCALE + x_origin for pt in stroke.points]
        ys = [pt.y * COORD_SCALE for pt in stroke.points]

        # Expand by half the highlight width for full text coverage
        half_w = _segment_width(stroke.points[0], stroke) * 0.5

        cx0 = min(xs) - half_w
        cy0 = min(ys) - half_w
        cx1 = max(xs) + half_w
        cy1 = max(ys) + half_w

        # Convert to PDF point coordinates
        px0 = (cx0 - x_offset) / scale
        py0 = (cy0 - y_offset) / scale
        px1 = (cx1 - x_offset) / scale
        py1 = (cy1 - y_offset) / scale

        clip = fitz.Rect(px0, py0, px1, py1)
        clip &= pdf_rect  # clamp to page bounds
        if clip.is_empty:
            continue

        text = pdf_page.get_text("text", clip=clip).strip()
        if text:
            texts.append(text)

    pdf_doc.close()
    return texts


def extract_glyph_highlight_texts(
    glyph_highlights: list,
    pdf_path: str,
    page_index: int,
    canvas_w: float = RM_SCREEN_WIDTH,
    coord_scale: float = None,
) -> list[str]:
    """
    Extract clean PDF text for glyph-range highlights using their rectangle bounds.

    GlyphRange.text is unreliable: one user highlight creates one GlyphRange per
    PDF text run, producing many fragments with broken ligatures. Using PyMuPDF
    to clip text from the rectangle gives clean, reading-order text instead.

    Groups all rectangles per GlyphHighlight into one bounding clip, then calls
    pdf_page.get_text("text", clip=...) to get the text in one shot.
    """
    _require_fitz()

    if not glyph_highlights or not pdf_path or not os.path.exists(pdf_path):
        return []

    try:
        pdf_doc = fitz.open(pdf_path)
        if page_index >= len(pdf_doc):
            pdf_doc.close()
            return []
        pdf_page = pdf_doc[page_index]
        pdf_rect = pdf_page.rect
    except Exception:
        return []

    cs = coord_scale if coord_scale is not None else (226 / 300)
    canvas_w_int = int(canvas_w)
    x_origin = canvas_w / 2
    scale = canvas_w_int / pdf_rect.width  # canvas px per PDF pt

    texts = []
    for gh in glyph_highlights:
        if not gh.rectangles:
            continue
        # Union bounding box of all rects (in logical coords)
        rxs = [r[0] for r in gh.rectangles] + [r[0] + r[2] for r in gh.rectangles]
        rys = [r[1] for r in gh.rectangles] + [r[1] + r[3] for r in gh.rectangles]
        rx0, ry0, rx1, ry1 = min(rxs), min(rys), max(rxs), max(rys)

        # Logical → canvas pixels
        cx0 = rx0 * cs + x_origin
        cy0 = ry0 * cs
        cx1 = rx1 * cs + x_origin
        cy1 = ry1 * cs

        # Canvas pixels → PDF points
        px0 = cx0 / scale
        py0 = cy0 / scale
        px1 = cx1 / scale
        py1 = cy1 / scale

        clip = fitz.Rect(px0, py0, px1, py1)
        clip &= pdf_rect
        if clip.is_empty:
            continue

        text = pdf_page.get_text("text", clip=clip).strip()
        if text:
            texts.append(text)

    pdf_doc.close()
    return texts


def render_rm_file_to_png(
    rm_path: str,
    output_path: str,
    transparent_bg: bool = False,
    pdf_path: str = None,
    page_index: int = 0,
    coord_scale: float = None,
    truncate_blank: bool = False,
) -> int:
    """
    Convenience: parse an .rm file and render its strokes as a PNG.
    For PDF documents, pass pdf_path and page_index to render strokes
    on top of the PDF page content. Pass coord_scale=226/300 for PDFs,
    1.0 for notebooks (defaults to auto-detect if omitted).
    Also renders glyph-range highlights (text selections) as filled rectangles.
    truncate_blank crops trailing blank space on short notebook pages.
    """
    strokes = extract_strokes(rm_path)
    glyph_hls = extract_glyph_highlights(rm_path)
    if not strokes and not glyph_hls:
        return 0
    return render_strokes_to_png(strokes, output_path, transparent_bg,
                                 pdf_path=pdf_path, page_index=page_index,
                                 coord_scale=coord_scale,
                                 glyph_highlights=glyph_hls,
                                 truncate_blank=truncate_blank)
