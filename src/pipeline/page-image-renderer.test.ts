/**
 * Tests for the OCR-aware render process timeout.
 *
 * OCR runs per page inside a single Python process, so with OCR enabled the
 * process budget must scale with the page count; otherwise a large notebook
 * would blow the fixed 120s and fail the whole (otherwise fine) render.
 */

import {
  computeRenderTimeoutMs,
  pageImageResultFromRenderOutput,
} from './page-image-renderer';

describe('computeRenderTimeoutMs', () => {
  it('uses the fixed 120s budget when OCR is off, regardless of page count', () => {
    expect(computeRenderTimeoutMs(0, false)).toBe(120_000);
    expect(computeRenderTimeoutMs(5, false)).toBe(120_000);
    expect(computeRenderTimeoutMs(500, false)).toBe(120_000);
  });

  it('scales with stroked page count when OCR is on', () => {
    expect(computeRenderTimeoutMs(0, true)).toBe(120_000);
    expect(computeRenderTimeoutMs(1, true)).toBe(135_000);
    expect(computeRenderTimeoutMs(10, true)).toBe(270_000);
  });

  it('caps the OCR budget at 20 minutes for huge notebooks', () => {
    // 200 pages would compute 3.12M ms; the cap holds it at 1.2M.
    expect(computeRenderTimeoutMs(200, true)).toBe(1_200_000);
    expect(computeRenderTimeoutMs(10_000, true)).toBe(1_200_000);
  });

  it('never returns less than the base budget for odd inputs', () => {
    expect(computeRenderTimeoutMs(-5, true)).toBe(120_000);
  });
});

describe('pageImageResultFromRenderOutput', () => {
  it('preserves successful pages and exposes per-page errors', () => {
    const result = pageImageResultFromRenderOutput({
      success: true,
      pages: [{ page_number: 1, filename: 'Doc_p1_new.png', has_strokes: true }],
      failed_pages: [2],
      errors: ['Page 2: malformed scene'],
    });

    expect(result.pageDrawings).toEqual(new Map([[1, 'Doc_p1_new.png']]));
    expect(result.failedPageNumbers).toEqual([2]);
    expect(result.warnings).toEqual(['Page 2: malformed scene']);
  });

  it('throws when every page failed so an existing note is preserved', () => {
    expect(() => pageImageResultFromRenderOutput({
      success: false,
      pages: [],
      failed_pages: [1],
      errors: ['Page 1: malformed scene'],
    })).toThrow('Page 1: malformed scene');
  });
});
