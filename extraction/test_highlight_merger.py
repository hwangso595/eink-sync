"""
Tests for highlight_merger.py.

The fixtures here intentionally mirror real fragmentation patterns observed
in the user's vault output for `agz_unformatted_nature` (the AlphaGo Zero
paper). Each test names the source page and the artifact being addressed
so a future reader can map the test back to the bug report.

PDF coordinate convention: y grows downward, units are PDF points (1/72").
A standard body-text line is ~14pt tall.
"""

import unittest

from highlight_extractor import ExtractedHighlight
from highlight_merger import merge_fragmented_highlights


def H(text, *, page=1, color="yellow", x=0.0, y=0.0, w=50.0, h=14.0):
    """Build an ExtractedHighlight with PDF-space bounds."""
    return ExtractedHighlight(
        text=text,
        page_number=page,
        color=color,
        bounds={"x": x, "y": y, "width": w, "height": h},
        created_at=None,
    )


class MergeSameLineTest(unittest.TestCase):
    """Adjacent fragments on the same line should join into one quote."""

    def test_two_fragments_close_x_gap_merge(self):
        # Mirrors p3 of agz_unformatted_nature where "Each edge (s, a)" and
        # "stores a prior probability P(s, a), a visit count N(s, a)" were
        # split into two highlights by the device.
        a = H("Each edge (s, a)", x=72, y=400, w=110, h=14)
        b = H("stores a prior probability", x=190, y=400, w=180, h=14)  # 8pt gap
        merged = merge_fragmented_highlights([a, b])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0].text, "Each edge (s, a) stores a prior probability")

    def test_far_apart_on_same_line_stays_separate(self):
        # User intentionally underlined two different phrases on the same
        # line with a wide gap (e.g. table columns). Don't glue these.
        a = H("first phrase", x=72, y=400, w=80, h=14)
        b = H("second phrase", x=400, y=400, w=80, h=14)  # ~250pt gap
        merged = merge_fragmented_highlights([a, b])
        self.assertEqual(len(merged), 2)

    def test_different_colors_dont_merge(self):
        # Yellow and pink underlines are conceptually distinct even when
        # they sit adjacent in space.
        a = H("first", x=72, y=400, color="yellow")
        b = H("second", x=130, y=400, color="pink")
        merged = merge_fragmented_highlights([a, b])
        self.assertEqual(len(merged), 2)


class MergeLineWrapTest(unittest.TestCase):
    """An underline that wraps to the next line should merge across the wrap."""

    def test_wrapped_underline_joins(self):
        # Line 1 ends near right margin, line 2 starts at left margin —
        # classic wrap of a single drawn underline.
        a = H("U(s, a) is the upper confidence bound where", x=72, y=400, w=400, h=14)
        b = H("N(s, a) is the visit count", x=72, y=418, w=200, h=14)
        merged = merge_fragmented_highlights([a, b])
        self.assertEqual(len(merged), 1)
        self.assertIn("upper confidence bound where", merged[0].text)
        self.assertIn("N(s, a) is the visit count", merged[0].text)

    def test_distant_lines_dont_merge(self):
        # Highlight on line 1 and another five lines below — different
        # underlines, must stay separate.
        a = H("first highlight", x=72, y=400, w=120, h=14)
        b = H("much later highlight", x=72, y=500, w=140, h=14)  # ~7 lines below
        merged = merge_fragmented_highlights([a, b])
        self.assertEqual(len(merged), 2)

    def test_wrap_to_indented_line_doesnt_merge(self):
        # Next-line highlight is far from the leftmost margin — looks
        # like a separate intentional underline, not a wrap.
        a = H("ends near right side", x=300, y=400, w=180, h=14)
        b = H("indented unrelated phrase", x=200, y=418, w=180, h=14)  # not at left
        merged = merge_fragmented_highlights([a, b])
        self.assertEqual(len(merged), 2)


class SubstringDedupeTest(unittest.TestCase):
    """Tail fragments like "M", "hiev", "ithm" should drop when shadowed."""

    def test_single_letter_substring_of_neighbor_drops(self):
        # p26 of agz_unformatted_nature: "M" appears as a tail-fragment
        # under "MCTS may be viewed as a self-play..." — the M underline
        # accidentally clipped the next word's leading letter.
        full = H("MCTS may be viewed as a self-play algorithm", x=72, y=400, w=350, h=14)
        tail = H("M", x=72, y=415, w=10, h=14)  # nearby, substring of `full`
        merged = merge_fragmented_highlights([full, tail])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0].text, "MCTS may be viewed as a self-play algorithm")

    def test_substring_far_from_neighbor_is_kept(self):
        # A standalone "v" highlighted as a math variable elsewhere on the
        # page. There's a paragraph mentioning "v" but it's nowhere near
        # the standalone underline — must NOT drop.
        far_text = H("the value v is computed as v = f(s)", x=72, y=200, w=300, h=14)
        standalone = H("v", x=400, y=600, w=10, h=14)  # nowhere near far_text
        merged = merge_fragmented_highlights([far_text, standalone])
        self.assertEqual(len(merged), 2)

    def test_partial_word_tail_fragment_drops(self):
        # p8: "hiev" appears as a tail-fragment of an underline that mostly
        # captured "achieved lower error". Drop it.
        full = H("achieved lower error and improved performance",
                 x=72, y=400, w=400, h=14)
        tail = H("hiev", x=80, y=415, w=25, h=14)
        merged = merge_fragmented_highlights([full, tail])
        self.assertEqual(len(merged), 1)
        self.assertNotIn("hiev ", merged[0].text)


class IntegrationTest(unittest.TestCase):
    """End-to-end: a realistic page-3 fragment set should collapse cleanly."""

    def test_agz_page_3_realistic_fragments(self):
        # Approximate reconstruction of the 9 fragments emitted on p3 of
        # agz_unformatted_nature. Three logical underlines were emitted as
        # 9 GlyphRanges. After merging we should see ~3 highlights.
        page_3 = [
            # Logical underline 1 (one line, 4 fragments)
            H("Each edge (s, a)", x=72, y=400, w=100, h=14),
            H("stores a prior probability P(s, a),", x=180, y=400, w=200, h=14),
            H("a visit count N(s, a),", x=72, y=418, w=140, h=14),
            H("and an action-value Q(s, a).", x=220, y=418, w=180, h=14),

            # Logical underline 2 (one line, 2 fragments + tail)
            H("selects", x=72, y=450, w=50, h=14),
            H("moves that maximise an upper confidence bound", x=130, y=450, w=320, h=14),
            H("M", x=72, y=465, w=8, h=14),  # tail fragment

            # Logical underline 3 (single fragment, separate paragraph)
            H("U(s, a) ∝ P(s, a)/(1 + N(s, a))", x=72, y=550, w=300, h=14),
        ]
        merged = merge_fragmented_highlights(page_3)
        # Expect 3 logical highlights after merge + dedupe
        self.assertEqual(len(merged), 3)

        joined = " | ".join(h.text for h in merged)
        self.assertIn("Each edge (s, a)", joined)
        self.assertIn("stores a prior probability", joined)
        self.assertIn("upper confidence bound", joined)
        self.assertIn("U(s, a) ∝", joined)
        # Tail fragment is gone
        self.assertNotIn(" | M | ", " | " + joined + " | ")


class EdgeCaseTest(unittest.TestCase):
    def test_empty_input_returns_empty(self):
        self.assertEqual(merge_fragmented_highlights([]), [])

    def test_single_highlight_passes_through(self):
        h = H("solo", x=72, y=400)
        out = merge_fragmented_highlights([h])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].text, "solo")

    def test_highlights_without_bounds_pass_through_unmerged(self):
        # If `bounds` is None we have nothing to merge on — emit verbatim.
        a = ExtractedHighlight(text="alpha", page_number=1, color="yellow",
                               bounds=None, created_at=None)
        b = ExtractedHighlight(text="beta", page_number=1, color="yellow",
                               bounds=None, created_at=None)
        out = merge_fragmented_highlights([a, b])
        self.assertEqual(len(out), 2)
        self.assertEqual({h.text for h in out}, {"alpha", "beta"})

    def test_different_pages_dont_merge(self):
        # Same coords, different pages → must not merge.
        a = H("page one text", page=1, x=72, y=400, w=120, h=14)
        b = H("page two text", page=2, x=130, y=400, w=120, h=14)
        merged = merge_fragmented_highlights([a, b])
        self.assertEqual(len(merged), 2)
        self.assertEqual({h.page_number for h in merged}, {1, 2})

    def test_does_not_mutate_input(self):
        a = H("first", x=72, y=400, w=80, h=14)
        b = H("second", x=160, y=400, w=80, h=14)
        original = [a, b]
        merge_fragmented_highlights(original)
        # Originals untouched
        self.assertEqual(original[0].text, "first")
        self.assertEqual(original[1].text, "second")


if __name__ == "__main__":
    unittest.main()
