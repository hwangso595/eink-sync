#!/usr/bin/env python3
"""
Render reMarkable page templates from the firmware 3.x vector format.

Older firmware shipped templates as PNG art that could be drawn behind
strokes directly. Current firmware (observed on build 20260612085811) ships
`.template` files instead: declarative JSON describing the page furniture as
expression-driven boxes and paths, with no raster art anywhere on the device.

A template looks like this (abridged, "P Lines medium"):

    {
      "orientation": "portrait",
      "constants": [{"mobileMaxWidth": 1000}, {"magicOffsetY": 177.8}, ...],
      "items": [{
        "type": "group",
        "boundingBox": {"x": "templateWidth / 2 - templateHeight / 2",
                        "y": "offsetY", "width": "templateHeight", "height": 78.7},
        "repeat": {"rows": "down"},
        "children": [{"type": "path", "data": ["M", 0, 0, "L", "parentWidth", 0]}]
      }]
    }

So rendering means three things: evaluating the little expression language,
replicating repeated groups across the page, and stroking the resulting
paths. `text` items (planner headings, day names) are deliberately skipped --
they need the device's own font to place correctly, and the ruling is what
makes a page look right.

Drawing uses PyMuPDF, already a core dependency, so templates cost no new
install. The output is a PNG the existing renderer composites as a page
background (see png_renderer.render_rm_file_to_png).
"""

import json
import os
from typing import Optional, Union

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover - exercised by the import guard in callers
    fitz = None  # type: ignore[assignment]

from constants import RM_SCREEN_WIDTH, RM_SCREEN_HEIGHT

# Bump when a change alters rendered output, so cached page images that were
# drawn with an older renderer are regenerated (see render_pages.py).
TEMPLATE_RENDERER_VERSION = 1

# The device draws page furniture as thin, light rules -- dark enough to guide
# handwriting, light enough that strokes stay dominant.
TEMPLATE_GRAY = 0.62
TEMPLATE_LINE_WIDTH = 1.4

# A repeat whose step collapses to ~0 would loop forever; these bound it.
MIN_REPEAT_STEP = 0.5
MAX_REPEAT_COUNT = 2000

Number = Union[int, float]


# ---------------------------------------------------------------
# Expression language
# ---------------------------------------------------------------

class ExpressionError(ValueError):
    """Raised when an expression cannot be tokenized, parsed, or resolved."""


def _tokenize(text: str) -> list:
    """Split an expression into number, identifier, and operator tokens."""
    tokens: list = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch.isspace():
            i += 1
            continue
        if ch.isdigit() or (ch == '.' and i + 1 < len(text) and text[i + 1].isdigit()):
            j = i
            while j < len(text) and (text[j].isdigit() or text[j] == '.'):
                j += 1
            tokens.append(('num', float(text[i:j])))
            i = j
            continue
        if ch.isalpha() or ch == '_':
            j = i
            while j < len(text) and (text[j].isalnum() or text[j] == '_'):
                j += 1
            tokens.append(('ident', text[i:j]))
            i = j
            continue
        two = text[i:i + 2]
        if two in ('>=', '<=', '==', '!=', '&&', '||'):
            tokens.append(('op', two))
            i += 2
            continue
        if ch in '+-*/%()?:<>':
            tokens.append(('op', ch))
            i += 1
            continue
        raise ExpressionError(f"Unexpected character {ch!r} in expression {text!r}")
    return tokens


class _Parser:
    """
    Recursive-descent parser for the template expression language.

    Deliberately not `eval`: these strings come off the device and are only
    ever arithmetic over template variables. Grammar, loosest first:

        ternary    := logical ('?' ternary ':' ternary)?
        logical    := comparison (('&&' | '||') comparison)*
        comparison := additive (('>'|'<'|'>='|'<='|'=='|'!=') additive)?
        additive   := multiplicative (('+' | '-') multiplicative)*
        multiplicative := unary (('*' | '/' | '%') unary)*
        unary      := '-'? primary
        primary    := number | identifier | '(' ternary ')'
    """

    def __init__(self, tokens: list, variables: dict):
        self.tokens = tokens
        self.pos = 0
        self.variables = variables

    def parse(self) -> float:
        value = self._ternary()
        if self.pos != len(self.tokens):
            raise ExpressionError('Trailing tokens in expression')
        return value

    def _peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else (None, None)

    def _accept(self, kind: str, value=None) -> bool:
        tok_kind, tok_value = self._peek()
        if tok_kind == kind and (value is None or tok_value == value):
            self.pos += 1
            return True
        return False

    def _expect_op(self, value: str) -> None:
        if not self._accept('op', value):
            raise ExpressionError(f"Expected {value!r}")

    def _ternary(self) -> float:
        condition = self._logical()
        if self._accept('op', '?'):
            when_true = self._ternary()
            self._expect_op(':')
            when_false = self._ternary()
            return when_true if condition else when_false
        return condition

    def _logical(self) -> float:
        value = self._comparison()
        while True:
            if self._accept('op', '&&'):
                value = 1.0 if (value and self._comparison()) else 0.0
            elif self._accept('op', '||'):
                right = self._comparison()
                value = 1.0 if (value or right) else 0.0
            else:
                return value

    def _comparison(self) -> float:
        left = self._additive()
        for op in ('>=', '<=', '==', '!=', '>', '<'):
            if self._accept('op', op):
                right = self._additive()
                result = {
                    '>=': left >= right, '<=': left <= right,
                    '==': left == right, '!=': left != right,
                    '>': left > right, '<': left < right,
                }[op]
                return 1.0 if result else 0.0
        return left

    def _additive(self) -> float:
        value = self._multiplicative()
        while True:
            if self._accept('op', '+'):
                value += self._multiplicative()
            elif self._accept('op', '-'):
                value -= self._multiplicative()
            else:
                return value

    def _multiplicative(self) -> float:
        value = self._unary()
        while True:
            if self._accept('op', '*'):
                value *= self._unary()
            elif self._accept('op', '/'):
                divisor = self._unary()
                if divisor == 0:
                    raise ExpressionError('Division by zero')
                value /= divisor
            elif self._accept('op', '%'):
                divisor = self._unary()
                if divisor == 0:
                    raise ExpressionError('Modulo by zero')
                value %= divisor
            else:
                return value

    def _unary(self) -> float:
        if self._accept('op', '-'):
            return -self._unary()
        return self._primary()

    def _primary(self) -> float:
        kind, value = self._peek()
        if kind == 'num':
            self.pos += 1
            return float(value)
        if kind == 'ident':
            self.pos += 1
            if value not in self.variables:
                raise ExpressionError(f"Unknown variable {value!r}")
            return float(self.variables[value])
        if self._accept('op', '('):
            inner = self._ternary()
            self._expect_op(')')
            return inner
        raise ExpressionError('Unexpected end of expression')


def evaluate(value, variables: dict) -> float:
    """
    Resolve a template value: numbers pass through, strings are parsed as
    expressions over `variables`. Raises ExpressionError on anything else.
    """
    if isinstance(value, bool):
        raise ExpressionError('Boolean is not a valid template value')
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return _Parser(_tokenize(value), variables).parse()
    raise ExpressionError(f"Cannot evaluate {type(value).__name__}")


def resolve_constants(constants, variables: dict) -> dict:
    """
    Fold a template's `constants` list into the variable map.

    Entries are single-key dicts evaluated in order, so a later constant may
    reference an earlier one (that ordering is how `offsetY` reads
    `magicOffsetY`). An unresolvable constant is skipped rather than failing
    the page -- items that need it are dropped individually later.
    """
    resolved = dict(variables)
    for entry in constants or []:
        if not isinstance(entry, dict):
            continue
        for name, raw in entry.items():
            try:
                resolved[name] = evaluate(raw, resolved)
            except ExpressionError:
                continue
    return resolved


# ---------------------------------------------------------------
# Layout
# ---------------------------------------------------------------

def _repeat_offsets(spec, box_size: float, extent: float, start: float) -> list:
    """
    Offsets for one repeat axis.

    Directional keywords tile until the page is covered ("down"/"right" from
    the item's own position, "up" backwards, "infinite" both ways); a number
    or expression repeats exactly that many times.
    """
    if spec is None:
        return [0.0]
    if box_size < MIN_REPEAT_STEP:
        return [0.0]

    if isinstance(spec, str) and spec in ('down', 'right', 'up', 'infinite'):
        forward = int((extent - start) / box_size) + 1 if spec != 'up' else 0
        backward = int(start / box_size) + 1 if spec in ('up', 'infinite') else 0
        forward = min(max(forward, 0), MAX_REPEAT_COUNT)
        backward = min(max(backward, 0), MAX_REPEAT_COUNT)
        return [i * box_size for i in range(-backward, forward + 1)]

    count = int(spec)
    return [i * box_size for i in range(max(min(count, MAX_REPEAT_COUNT), 0))]


def _resolve_repeat_spec(spec, variables: dict):
    """Numbers and expressions resolve to counts; keywords pass through."""
    if spec is None or (isinstance(spec, str) and spec in ('down', 'right', 'up', 'infinite')):
        return spec
    try:
        return evaluate(spec, variables)
    except ExpressionError:
        return None


def _path_segments(data, variables: dict) -> list:
    """
    Turn a path `data` array into segments in the parent box's coordinates.

    Tokens interleave commands with coordinates: M/L take a point, C takes
    three (two controls and an endpoint), Z closes back to the subpath start.
    """
    segments: list = []
    tokens = list(data or [])
    index = 0
    current = None
    start = None

    def take(count: int) -> list:
        nonlocal index
        values = []
        for _ in range(count):
            if index >= len(tokens):
                raise ExpressionError('Path data ended mid-command')
            values.append(evaluate(tokens[index], variables))
            index += 1
        return values

    while index < len(tokens):
        token = tokens[index]
        if not isinstance(token, str) or len(token) != 1 or not token.isalpha():
            raise ExpressionError(f"Expected a path command, got {token!r}")
        command = token.upper()
        index += 1

        if command == 'M':
            x, y = take(2)
            current = start = (x, y)
        elif command == 'L':
            if current is None:
                raise ExpressionError('L before M')
            x, y = take(2)
            segments.append(('line', current, (x, y)))
            current = (x, y)
        elif command == 'C':
            if current is None:
                raise ExpressionError('C before M')
            x1, y1, x2, y2, x, y = take(6)
            segments.append(('bezier', current, (x1, y1), (x2, y2), (x, y)))
            current = (x, y)
        elif command == 'Z':
            if current is not None and start is not None and current != start:
                segments.append(('line', current, start))
            current = start
        else:
            raise ExpressionError(f"Unsupported path command {command!r}")

    return segments


def _collect(item, origin, variables: dict, canvas, out: list, depth: int = 0) -> None:
    """
    Walk one item, emitting absolute-coordinate segments into `out`.

    A malformed item (unknown variable, bad expression) is skipped along with
    its subtree instead of failing the page: a template with one odd group
    should still draw the rest of its ruling.
    """
    if depth > 8 or not isinstance(item, dict):
        return

    box = item.get('boundingBox') or {}
    try:
        width = evaluate(box.get('width', variables['parentWidth']), variables)
        height = evaluate(box.get('height', variables['parentHeight']), variables)
        x = origin[0] + evaluate(box.get('x', 0), variables)
        y = origin[1] + evaluate(box.get('y', 0), variables)
    except ExpressionError:
        return

    child_vars = dict(variables)
    child_vars['parentWidth'] = width
    child_vars['parentHeight'] = height

    repeat = item.get('repeat') or {}
    rows = _resolve_repeat_spec(repeat.get('rows'), child_vars)
    columns = _resolve_repeat_spec(repeat.get('columns'), child_vars)
    dys = _repeat_offsets(rows, height, canvas[1], y)
    dxs = _repeat_offsets(columns, width, canvas[0], x)

    item_type = item.get('type')
    for dy in dys:
        for dx in dxs:
            spot = (x + dx, y + dy)
            # Fully off-canvas repeats contribute nothing.
            if spot[0] > canvas[0] or spot[1] > canvas[1]:
                continue
            if spot[0] + width < 0 or spot[1] + height < 0:
                continue

            if item_type == 'path':
                try:
                    for kind, *points in _path_segments(item.get('data'), child_vars):
                        out.append((
                            kind,
                            *[(spot[0] + px, spot[1] + py) for px, py in points],
                        ))
                except ExpressionError:
                    continue
            # `text` items are intentionally not rendered (see module docstring).
            for child in item.get('children') or []:
                _collect(child, spot, child_vars, canvas, out, depth + 1)


def build_segments(
    template: dict,
    width: float,
    height: float,
    canvas_width: Optional[float] = None,
    canvas_height: Optional[float] = None,
) -> list:
    """
    Resolve a parsed template into absolute-coordinate drawing segments.

    `width`/`height` are the device screen the template is written against and
    feed `templateWidth`/`templateHeight`, so expressions resolve exactly as
    they do on the tablet. The canvas may be larger -- notebook pages grow
    downwards as they are scrolled -- so repeats tile to the canvas extent
    while keeping the screen-derived geometry. Passing the taller size as
    `height` instead would silently change every expression that reads
    `templateHeight`.
    """
    variables = {
        'templateWidth': float(width),
        'templateHeight': float(height),
        'parentWidth': float(width),
        'parentHeight': float(height),
    }
    variables = resolve_constants(template.get('constants'), variables)
    canvas = (
        float(canvas_width if canvas_width is not None else width),
        float(canvas_height if canvas_height is not None else height),
    )
    segments: list = []
    for item in template.get('items') or []:
        _collect(item, (0.0, 0.0), variables, canvas, segments)
    return segments


# ---------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------

def render_template_file(
    template_path: str,
    out_path: str,
    width: float = RM_SCREEN_WIDTH,
    height: float = RM_SCREEN_HEIGHT,
    canvas_height: Optional[float] = None,
) -> bool:
    """
    Render a `.template` file to a PNG page background.

    `canvas_height` extends the output for scrolled notebook pages, which are
    taller than one screen: the ruling continues at its true rhythm instead of
    stopping a screen down.

    Landscape templates are laid out on a rotated canvas and turned upright,
    so their ruling lands the same way the device draws it.

    Returns False (leaving the page on plain white) when the template is
    unreadable, unsupported, or yields nothing drawable.
    """
    if fitz is None:
        return False

    try:
        with open(template_path, 'r', encoding='utf-8') as handle:
            template = json.load(handle)
    except (OSError, ValueError):
        return False

    if template.get('formatVersion') not in (None, 1):
        return False

    landscape = str(template.get('orientation', 'portrait')).lower() == 'landscape'
    layout_w, layout_h = (height, width) if landscape else (width, height)
    # Only the portrait canvas grows; a landscape template is rotated upright
    # afterwards, so extending it here would stretch the wrong axis.
    out_h = max(float(canvas_height), layout_h) if canvas_height and not landscape else layout_h

    segments = build_segments(template, layout_w, layout_h, layout_w, out_h)
    if not segments:
        return False

    try:
        doc = fitz.open()
        page = doc.new_page(width=layout_w, height=out_h)
        shape = page.new_shape()
        for kind, *points in segments:
            if kind == 'bezier':
                shape.draw_bezier(*[fitz.Point(*p) for p in points])
            else:
                shape.draw_line(fitz.Point(*points[0]), fitz.Point(*points[1]))
        shape.finish(
            color=(TEMPLATE_GRAY, TEMPLATE_GRAY, TEMPLATE_GRAY),
            width=TEMPLATE_LINE_WIDTH,
        )
        shape.commit()

        pixmap = page.get_pixmap(alpha=False)
        if landscape:
            # Turn the rotated layout upright for the portrait page canvas.
            rotated = fitz.open()
            rotated_page = rotated.new_page(width=width, height=height)
            rotated_page.insert_image(
                fitz.Rect(0, 0, width, height), pixmap=pixmap, rotate=90,
            )
            pixmap = rotated_page.get_pixmap(alpha=False)
            rotated.close()

        os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
        pixmap.save(out_path)
        doc.close()
        return True
    except Exception:
        return False


def render_template_cached(
    template_path: str,
    cache_dir: str,
    width: float = RM_SCREEN_WIDTH,
    height: float = RM_SCREEN_HEIGHT,
    canvas_height: Optional[float] = None,
) -> Optional[str]:
    """
    Render a template once and reuse it: pages of a notebook share a
    template, and so do notebooks. Re-renders when the source `.template`
    is newer than the cached PNG or the renderer version changed.

    Page height is part of the key, since scrolled pages need a taller draw.
    """
    stem = os.path.splitext(os.path.basename(template_path))[0]
    out_h = int(max(float(canvas_height), height)) if canvas_height else int(height)
    out_path = os.path.join(
        cache_dir,
        f"{stem}-{int(width)}x{out_h}-v{TEMPLATE_RENDERER_VERSION}.png",
    )

    try:
        if (os.path.exists(out_path)
                and os.path.getmtime(out_path) >= os.path.getmtime(template_path)):
            return out_path
    except OSError:
        pass

    rendered = render_template_file(template_path, out_path, width, height, canvas_height)
    return out_path if rendered else None
