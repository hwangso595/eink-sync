"""
Tests for the firmware 3.x vector template renderer.

Fixtures are written by hand in the device's format rather than shipping
reMarkable's own template files. LINES_MEDIUM mirrors the structure of the
stock "Lines medium" template (expression constants, a square bounding box,
`repeat: rows down`, one horizontal path) so the expected geometry below is
the geometry the device produces.
"""

import json
import os
import tempfile
import unittest

from template_renderer import (
    ExpressionError,
    build_segments,
    evaluate,
    resolve_constants,
    _repeat_offsets,
    _path_segments,
)

LINES_MEDIUM = {
    "name": "Lines medium",
    "formatVersion": 1,
    "orientation": "portrait",
    "constants": [
        {"mobileMaxWidth": 1000},
        {"mobileOffsetY": 160},
        {"magicOffsetY": 177.8},
        {"offsetY": "templateWidth > mobileMaxWidth ? magicOffsetY : mobileOffsetY"},
    ],
    "items": [{
        "type": "group",
        "boundingBox": {
            "x": "templateWidth / 2 - templateHeight / 2",
            "y": "offsetY",
            "width": "templateHeight",
            "height": 78.7,
        },
        "repeat": {"rows": "down"},
        "children": [{"type": "path", "data": ["M", 0, 0, "L", "parentWidth", 0]}],
    }],
}


class TestExpressions(unittest.TestCase):
    def test_arithmetic_and_precedence(self):
        self.assertEqual(evaluate("2 + 3 * 4", {}), 14.0)
        self.assertEqual(evaluate("(2 + 3) * 4", {}), 20.0)
        self.assertEqual(evaluate("-5 + 1", {}), -4.0)

    def test_variables_and_numbers(self):
        self.assertEqual(evaluate("w / 2", {"w": 1404}), 702.0)
        self.assertEqual(evaluate(78.7, {}), 78.7)

    def test_ternary_picks_by_comparison(self):
        variables = {"templateWidth": 1404, "wide": 99, "narrow": 11, "max": 1000}
        self.assertEqual(evaluate("templateWidth > max ? wide : narrow", variables), 99.0)
        variables["templateWidth"] = 500
        self.assertEqual(evaluate("templateWidth > max ? wide : narrow", variables), 11.0)

    def test_rejects_unknown_variables_and_junk(self):
        for expr in ("nope + 1", "2 +", "2 $ 3", "import os"):
            with self.assertRaises(ExpressionError):
                evaluate(expr, {"known": 1})

    def test_constants_resolve_in_order(self):
        variables = resolve_constants(
            LINES_MEDIUM["constants"], {"templateWidth": 1404.0, "templateHeight": 1872.0},
        )
        # 1404 > 1000, so offsetY takes the "magic" branch
        self.assertAlmostEqual(variables["offsetY"], 177.8)

    def test_unresolvable_constant_is_skipped_not_fatal(self):
        variables = resolve_constants([{"bad": "missingVar * 2"}, {"good": 5}], {})
        self.assertNotIn("bad", variables)
        self.assertEqual(variables["good"], 5.0)


class TestRepeatOffsets(unittest.TestCase):
    def test_down_tiles_to_the_canvas_extent(self):
        offsets = _repeat_offsets("down", 100.0, 1000.0, 0.0)
        self.assertEqual(offsets[0], 0.0)
        self.assertGreaterEqual(offsets[-1], 900.0)

    def test_up_tiles_backwards_only(self):
        offsets = _repeat_offsets("up", 100.0, 1000.0, 500.0)
        self.assertLess(min(offsets), 0.0)
        self.assertEqual(max(offsets), 0.0)

    def test_numeric_count_repeats_exactly(self):
        self.assertEqual(_repeat_offsets(3, 10.0, 1000.0, 0.0), [0.0, 10.0, 20.0])

    def test_absent_repeat_yields_a_single_placement(self):
        self.assertEqual(_repeat_offsets(None, 10.0, 1000.0, 0.0), [0.0])

    def test_degenerate_step_cannot_loop_forever(self):
        self.assertEqual(_repeat_offsets("down", 0.0, 10_000.0, 0.0), [0.0])


class TestPathSegments(unittest.TestCase):
    def test_move_line_and_expressions(self):
        segments = _path_segments(["M", 0, 0, "L", "parentWidth", 0], {"parentWidth": 500})
        self.assertEqual(segments, [("line", (0.0, 0.0), (500.0, 0.0))])

    def test_bezier_keeps_all_control_points(self):
        segments = _path_segments(["M", 0, 0, "C", 1, 2, 3, 4, 5, 6], {})
        self.assertEqual(segments[0][0], "bezier")
        self.assertEqual(len(segments[0]), 5)

    def test_close_returns_to_subpath_start(self):
        segments = _path_segments(["M", 0, 0, "L", 10, 0, "L", 10, 10, "Z"], {})
        self.assertEqual(segments[-1], ("line", (10.0, 10.0), (0.0, 0.0)))

    def test_malformed_paths_raise(self):
        for data in (["L", 1, 1], ["M", 0], ["Q", 1, 2, 3, 4], [0, 0]):
            with self.assertRaises(ExpressionError):
                _path_segments(data, {})


class TestBuildSegments(unittest.TestCase):
    def test_lines_medium_matches_device_geometry(self):
        segments = build_segments(LINES_MEDIUM, 1404, 1872)
        ys = sorted({round(s[1][1], 1) for s in segments})

        self.assertAlmostEqual(ys[0], 177.8)
        self.assertAlmostEqual(ys[1] - ys[0], 78.7, places=1)
        self.assertLessEqual(ys[-1], 1872)
        # The square bounding box spans wider than the page, so every rule
        # crosses the full width once clipped.
        self.assertLessEqual(segments[0][1][0], 0)
        self.assertGreaterEqual(segments[0][2][0], 1404)

    def test_taller_canvas_continues_the_rhythm(self):
        short = build_segments(LINES_MEDIUM, 1404, 1872)
        tall = build_segments(LINES_MEDIUM, 1404, 1872, 1404, 6182)
        self.assertGreater(len(tall), len(short) * 2)

        ys = sorted({round(s[1][1], 1) for s in tall})
        # Spacing stays constant across what would have been the page seam.
        gaps = {round(b - a, 1) for a, b in zip(ys, ys[1:])}
        self.assertEqual(gaps, {78.7})
        self.assertGreater(ys[-1], 6000)

    def test_template_dimensions_stay_screen_sized_when_canvas_grows(self):
        # x depends on templateHeight; a taller canvas must not move it.
        short = build_segments(LINES_MEDIUM, 1404, 1872)
        tall = build_segments(LINES_MEDIUM, 1404, 1872, 1404, 6182)
        self.assertAlmostEqual(short[0][1][0], tall[0][1][0])

    def test_paper_origin_is_available_to_constants(self):
        # Dot and isometric grids offset from paperOriginX; when it is missing
        # their constants fail to resolve and the whole template draws nothing.
        template = {
            "formatVersion": 1,
            "constants": [{"xpos": "paperOriginX + 10"}],
            "items": [{
                "type": "group",
                "boundingBox": {"x": "xpos", "y": 0, "width": 40, "height": 40},
                "repeat": {"columns": "infinite", "rows": "infinite"},
                "children": [{"type": "path", "data": ["M", 0, 0, "L", 1, 0]}],
            }],
        }
        segments = build_segments(template, 1404, 1872)
        self.assertGreater(len(segments), 100)
        # The square drawing area is centred, so its origin sits left of the page.
        xs = [s[1][0] for s in segments]
        self.assertLess(min(xs), 0)
        self.assertGreater(max(xs), 1404 - 40)

    def test_text_items_are_skipped(self):
        template = {
            "formatVersion": 1,
            "items": [
                {"type": "text", "boundingBox": {"x": 0, "y": 0, "width": 10, "height": 10},
                 "text": "Monday"},
                {"type": "path", "data": ["M", 0, 0, "L", 10, 0]},
            ],
        }
        self.assertEqual(len(build_segments(template, 100, 100)), 1)

    def test_a_broken_item_does_not_lose_the_rest(self):
        template = {
            "formatVersion": 1,
            "items": [
                {"type": "path", "boundingBox": {"x": "nonsense +", "y": 0}, "data": ["M", 0, 0]},
                {"type": "path", "data": ["M", 0, 0, "L", 10, 0]},
            ],
        }
        self.assertEqual(len(build_segments(template, 100, 100)), 1)

    def test_nested_groups_offset_children(self):
        template = {
            "formatVersion": 1,
            "items": [{
                "type": "group",
                "boundingBox": {"x": 100, "y": 50, "width": 200, "height": 200},
                "children": [{"type": "path", "data": ["M", 0, 0, "L", "parentWidth", 0]}],
            }],
        }
        segments = build_segments(template, 1000, 1000)
        self.assertEqual(segments, [("line", (100.0, 50.0), (300.0, 50.0))])


class TestRenderTemplateFile(unittest.TestCase):
    """Rendering needs PyMuPDF; skipped where it is unavailable."""

    def setUp(self):
        try:
            import fitz  # noqa: F401
        except ImportError:
            self.skipTest("PyMuPDF not installed")

    def test_renders_a_png_and_caches_by_size(self):
        from template_renderer import render_template_file, render_template_cached

        with tempfile.TemporaryDirectory() as td:
            template_path = os.path.join(td, "P Lines medium.template")
            with open(template_path, "w", encoding="utf-8") as f:
                json.dump(LINES_MEDIUM, f)

            out_path = os.path.join(td, "out.png")
            self.assertTrue(render_template_file(template_path, out_path))
            self.assertGreater(os.path.getsize(out_path), 0)

            cache_dir = os.path.join(td, ".rendered")
            first = render_template_cached(template_path, cache_dir)
            second = render_template_cached(template_path, cache_dir)
            self.assertEqual(first, second)
            taller = render_template_cached(template_path, cache_dir, canvas_height=6182)
            self.assertNotEqual(first, taller)

    def test_unreadable_or_unsupported_templates_return_false(self):
        from template_renderer import render_template_file

        with tempfile.TemporaryDirectory() as td:
            out_path = os.path.join(td, "out.png")
            self.assertFalse(render_template_file(os.path.join(td, "missing.template"), out_path))

            broken = os.path.join(td, "broken.template")
            with open(broken, "w", encoding="utf-8") as f:
                f.write("{not json")
            self.assertFalse(render_template_file(broken, out_path))

            future = os.path.join(td, "future.template")
            with open(future, "w", encoding="utf-8") as f:
                json.dump({"formatVersion": 99, "items": []}, f)
            self.assertFalse(render_template_file(future, out_path))


if __name__ == "__main__":
    unittest.main()
