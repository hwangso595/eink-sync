"""
Renderer quality tests.

Renders .rm test files and compares against tablet thumbnails.
Ensures renderer quality doesn't regress below established baselines.

Run: python test_renderer_quality.py
"""
import sys
import os
import math

sys.path.insert(0, os.path.dirname(__file__))

import fitz
from png_renderer import render_rm_file_to_png

TEST_DIR = os.path.join(os.path.dirname(__file__), '..', 'test-data', 'renderer-quality')
RM_DIR = os.path.join(TEST_DIR, 'rm-files')
REF_DIR = os.path.join(TEST_DIR, 'reference-thumbnails')
OUT_DIR = os.path.join(TEST_DIR, 'rendered-output')


def load_grayscale(path: str, width: int = 384, height: int = 512) -> list[int]:
    """Load image, resize, convert to grayscale."""
    doc = fitz.open()
    pg = doc.new_page(width=width, height=height)
    pg.insert_image(fitz.Rect(0, 0, width, height), filename=path)
    px = pg.get_pixmap()
    if px.n > 1:
        px = fitz.Pixmap(fitz.csGRAY, px)
    result = list(px.samples)
    doc.close()
    return result


def compute_score(pixels_a: list[int], pixels_b: list[int], width: int = 384) -> dict:
    """Compute MAE and structural similarity between two grayscale images."""
    assert len(pixels_a) == len(pixels_b), "Image sizes don't match"

    mae = sum(abs(a - b) for a, b in zip(pixels_a, pixels_b)) / len(pixels_a)

    height = len(pixels_a) // width
    window = 8
    total_diff = 0.0
    count = 0
    for y in range(0, height - window, window):
        for x in range(0, width - window, window):
            sa = sb = 0
            for dy in range(window):
                for dx in range(window):
                    idx = (y + dy) * width + (x + dx)
                    sa += pixels_a[idx]
                    sb += pixels_b[idx]
            total_diff += abs(sa / (window * window) - sb / (window * window))
            count += 1

    ssim = total_diff / count if count > 0 else 999.0
    combined = mae * 0.5 + ssim * 0.5

    return {'mae': mae, 'ssim': ssim, 'combined': combined}


# Quality baselines — scores must stay below these thresholds
# Lower = better (closer to tablet rendering)
BASELINES = {
    'quicksheets-p2': 20.0,  # Heavy pencil strokes page
    'quicksheets-p3': 10.0,  # Mixed pressure pencil page
}


def test_page(name: str) -> dict:
    """Render a test page and score against reference."""
    rm_path = os.path.join(RM_DIR, f'{name}.rm')
    ref_path = os.path.join(REF_DIR, f'{name}.png')

    if not os.path.exists(rm_path):
        return {'name': name, 'error': f'Missing .rm file: {rm_path}'}
    if not os.path.exists(ref_path):
        return {'name': name, 'error': f'Missing reference: {ref_path}'}

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, f'{name}.png')

    render_rm_file_to_png(rm_path, out_path)

    ref_pixels = load_grayscale(ref_path)
    our_pixels = load_grayscale(out_path)
    scores = compute_score(ref_pixels, our_pixels)

    baseline = BASELINES.get(name, 25.0)
    passed = scores['combined'] <= baseline

    return {
        'name': name,
        'scores': scores,
        'baseline': baseline,
        'passed': passed,
    }


def main():
    print("Renderer Quality Tests")
    print("=" * 60)

    test_cases = [name.replace('.rm', '') for name in os.listdir(RM_DIR) if name.endswith('.rm')]

    if not test_cases:
        print("No test cases found!")
        return 1

    all_passed = True
    for name in sorted(test_cases):
        result = test_page(name)

        if 'error' in result:
            print(f"  SKIP {name}: {result['error']}")
            continue

        scores = result['scores']
        status = "PASS" if result['passed'] else "FAIL"
        symbol = "OK" if result['passed'] else "XX"

        print(f"  {symbol} {name}: combined={scores['combined']:.2f} "
              f"(mae={scores['mae']:.2f}, ssim={scores['ssim']:.2f}) "
              f"[baseline: {result['baseline']:.1f}] {status}")

        if not result['passed']:
            all_passed = False

    print()
    if all_passed:
        print("All tests PASSED")
        return 0
    else:
        print("Some tests FAILED — renderer quality has regressed!")
        return 1


if __name__ == '__main__':
    sys.exit(main())
