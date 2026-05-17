"""
Merge over-fragmented highlights from the same continuous underline.

The reMarkable device emits one GlyphRange block per stroke. A single underline
the user drew across "Each edge (s, a) stores a prior probability" can become
3-4 separate ExtractedHighlight entries. Worse, when a stroke barely clips
the next/previous word, you get one-letter "tail" fragments like "M", "v", or
"hiev" alongside the real highlight.

This module post-processes the extractor output to:

  1. **Merge by spatial adjacency** (per page, per color):
     - Same line: y-overlap > 50% of average height AND x-gap small.
     - Line wrap: next highlight starts on the next line, near left margin.

  2. **Drop substring duplicates**: if highlight A's text is a substring of an
     adjacent (within ~100 PDF pt) highlight B, drop A.

Inputs use the ExtractedHighlight dataclass from highlight_extractor.py with
`bounds = {x, y, width, height}` in PDF coordinates (not reMarkable px).

Highlights without bounds are passed through untouched (we have nothing to
merge on).
"""

from dataclasses import replace
from typing import Optional


# Tunable thresholds. PDF coordinates are points (1/72 inch); typical body
# text line height is ~12-15pt. A space is ~3-5pt wide. We err on the side
# of NOT merging when ambiguous — the substring-dedupe pass cleans up most
# remaining noise.
SAME_LINE_Y_OVERLAP_RATIO = 0.5
SAME_LINE_MAX_X_GAP = 30.0       # ~6 spaces; deliberately loose
# Wrap threshold: gap from previous line's BOTTOM to next line's TOP, as a
# fraction of the avg highlight height.
#
# Tuned against page 26 of agz_unformatted_nature in reMarkable native coords:
# - real same-paragraph wrap: gap/height ≈ 0.9-1.0
# - real paragraph break:     gap/height > 1.2
# 1.0 cleanly separates them. (Earlier 0.5 was tuned only against synthetic
# PDF-point fixtures and was too conservative for real device output.)
LINE_WRAP_MAX_Y_GAP_LINES = 1.0
SUBSTRING_DEDUPE_MAX_DISTANCE = 100.0  # PDF pt
MIN_FRAGMENT_LEN_FOR_DEDUPE = 1  # only consider very short fragments


def _bounds_bottom(b: dict) -> float:
    return b["y"] + b["height"]


def _y_overlap_ratio(a: dict, b: dict) -> float:
    """Vertical overlap as a fraction of the smaller box's height."""
    top = max(a["y"], b["y"])
    bot = min(_bounds_bottom(a), _bounds_bottom(b))
    overlap = max(0.0, bot - top)
    smallest = max(1e-6, min(a["height"], b["height"]))
    return overlap / smallest


def _is_same_line(a: dict, b: dict) -> bool:
    return _y_overlap_ratio(a, b) >= SAME_LINE_Y_OVERLAP_RATIO


def _is_line_wrap(prev: dict, curr: dict, leftmost_x: float) -> bool:
    """Curr looks like a wrap of prev: starts on a later line, at the same
    leftmost x position as the running merge group."""
    if curr["y"] <= _bounds_bottom(prev):
        return False  # not a later line
    avg_h = (prev["height"] + curr["height"]) / 2.0
    y_gap = curr["y"] - _bounds_bottom(prev)
    if y_gap > avg_h * LINE_WRAP_MAX_Y_GAP_LINES:
        return False  # too far apart vertically
    # Curr must start at (or very near) the leftmost extent of the running
    # group. This catches genuine line-wraps but rejects unrelated highlights
    # that just happen to sit on the next line at a different x position.
    return abs(curr["x"] - leftmost_x) < 20.0


def _x_gap(a: dict, b: dict) -> float:
    """Horizontal gap from end of a to start of b (negative if overlapping)."""
    return b["x"] - (a["x"] + a["width"])


def _join_text(left: str, right: str) -> str:
    """Join two highlight texts with a single space unless punctuation handles it."""
    if not left:
        return right
    if not right:
        return left
    if left.endswith(" ") or right.startswith(" "):
        return (left + right).replace("  ", " ")
    # If `left` ends mid-word (e.g. "hiev") and `right` starts mid-word
    # ("ed"), naive space-join produces "hiev ed". The substring-dedupe
    # pass usually removes the smaller fragment first, so we accept the
    # occasional artifact here in exchange for not guessing at word breaks.
    return left + " " + right


def _union_bounds(a: dict, b: dict) -> dict:
    x = min(a["x"], b["x"])
    y = min(a["y"], b["y"])
    right = max(a["x"] + a["width"], b["x"] + b["width"])
    bottom = max(_bounds_bottom(a), _bounds_bottom(b))
    return {"x": x, "y": y, "width": right - x, "height": bottom - y}


def _group_key(h) -> tuple:
    """Group highlights by (page, color) for merge candidacy."""
    return (h.page_number, h.color)


def _merge_group(group: list) -> list:
    """
    Merge a single (page, color) group sorted top-to-bottom, left-to-right.

    Implementation detail: we accumulate fragments into a "running group" and
    compare each new candidate against the LAST fragment (not the union box).
    The union box would span multiple lines after a wrap merge and confuse
    the same-line / x-gap heuristic for the next candidate on that last line.
    """
    if len(group) <= 1:
        return list(group)

    items = sorted(group, key=lambda h: (h.bounds["y"], h.bounds["x"]))
    merged: list = []
    # Running group state
    run_fragments: list = []
    run_leftmost_x: Optional[float] = None

    def _flush():
        if not run_fragments:
            return
        text = run_fragments[0].text
        bounds = dict(run_fragments[0].bounds)
        for f in run_fragments[1:]:
            text = _join_text(text, f.text)
            bounds = _union_bounds(bounds, f.bounds)
        merged.append(replace(run_fragments[0], text=text, bounds=bounds))

    for h in items:
        if not run_fragments:
            run_fragments = [h]
            run_leftmost_x = h.bounds["x"]
            continue

        last = run_fragments[-1]
        lb, cb = last.bounds, h.bounds

        same_line = _is_same_line(lb, cb)
        same_line_close = same_line and 0 <= _x_gap(lb, cb) < SAME_LINE_MAX_X_GAP

        wrapped = (
            not same_line
            and run_leftmost_x is not None
            and _is_line_wrap(lb, cb, run_leftmost_x)
        )

        if same_line_close or wrapped:
            run_fragments.append(h)
            if run_leftmost_x is None or cb["x"] < run_leftmost_x:
                run_leftmost_x = cb["x"]
        else:
            _flush()
            run_fragments = [h]
            run_leftmost_x = cb["x"]

    _flush()
    return merged


def _dedupe_substrings(highlights: list) -> list:
    """
    Drop highlights whose text is a substring of a SPATIALLY ADJACENT highlight
    (within SUBSTRING_DEDUPE_MAX_DISTANCE PDF pt). Spatial adjacency prevents
    legitimate single-char highlights (math vars `v`, `Q`) on a different part
    of the page from being deleted just because some other highlight contains
    that letter.
    """
    if len(highlights) < 2:
        return list(highlights)

    drop = set()
    for i, h in enumerate(highlights):
        if i in drop:
            continue
        if h.bounds is None or len(h.text) < MIN_FRAGMENT_LEN_FOR_DEDUPE:
            continue
        for j, other in enumerate(highlights):
            if j == i or j in drop:
                continue
            if other.bounds is None:
                continue
            if other.page_number != h.page_number:
                continue
            if len(h.text) >= len(other.text):
                continue  # only drop the shorter
            if h.text not in other.text:
                continue
            # Spatial proximity check: gap between bounding boxes (not midpoint
            # distance — a wide highlight has a far-right midpoint that would
            # falsely reject a left-side tail fragment sitting one line below).
            if _box_gap(h.bounds, other.bounds) <= SUBSTRING_DEDUPE_MAX_DISTANCE:
                drop.add(i)
                break

    return [h for i, h in enumerate(highlights) if i not in drop]


def _box_gap(a: dict, b: dict) -> float:
    """Manhattan-style gap between two axis-aligned boxes; 0 if they overlap."""
    ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
    bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]
    dx = max(0.0, max(b["x"] - ax2, a["x"] - bx2))
    dy = max(0.0, max(b["y"] - ay2, a["y"] - by2))
    return dx + dy


def merge_fragmented_highlights(highlights: list) -> list:
    """
    Merge spatially-adjacent fragments and drop substring duplicates.

    Returns a new list; the input is not mutated. Highlights without bounds
    are kept verbatim and emitted in their original order before merged ones.
    """
    if not highlights:
        return []

    boundless = [h for h in highlights if h.bounds is None]
    bounded = [h for h in highlights if h.bounds is not None]

    # Dedupe substring tail fragments BEFORE merging. Otherwise a tail like
    # "M" sitting one line below "MCTS may be viewed..." gets merged in
    # via the line-wrap heuristic, defeating the point.
    deduped = _dedupe_substrings(bounded)

    # Group by (page, color), merge each group, then flatten.
    groups: dict[tuple, list] = {}
    for h in deduped:
        groups.setdefault(_group_key(h), []).append(h)

    merged_all: list = []
    for key in sorted(groups.keys()):
        merged_all.extend(_merge_group(groups[key]))

    # Final ordering: by page, then top-to-bottom (natural reading order).
    merged_all.sort(key=lambda h: (h.page_number, h.bounds["y"], h.bounds["x"]))

    return boundless + merged_all
