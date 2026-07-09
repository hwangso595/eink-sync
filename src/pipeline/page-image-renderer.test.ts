/**
 * Tests for the OCR-aware render process timeout.
 *
 * OCR runs per page inside a single Python process, so with OCR enabled the
 * process budget must scale with the page count — otherwise a large notebook
 * would blow the fixed 120s and fail the whole (otherwise fine) render.
 */

import { computeRenderTimeoutMs } from './page-image-renderer';

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
