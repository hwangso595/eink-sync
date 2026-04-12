/**
 * Tests for the OCR bridge module.
 *
 * Tests the TypeScript-side formatting and script path resolution.
 * The actual Python subprocess is not invoked in unit tests.
 */

import * as path from 'path';
import {
  resolveOcrScriptPath,
  formatOcrCollapsible,
  formatOcrAltText,
} from './ocr-bridge';

describe('resolveOcrScriptPath', () => {
  it('returns path to run_ocr.py in extraction directory', () => {
    const result = resolveOcrScriptPath('/some/plugin/dir');
    expect(result).toBe(path.join('/some/plugin/dir', 'extraction', 'run_ocr.py'));
  });

  it('handles paths with trailing slashes', () => {
    const result = resolveOcrScriptPath('/plugin/');
    expect(result).toContain('run_ocr.py');
  });
});

describe('formatOcrCollapsible', () => {
  it('returns empty string for empty text', () => {
    expect(formatOcrCollapsible('', 50)).toBe('');
    expect(formatOcrCollapsible('   ', 50)).toBe('');
  });

  it('wraps text in a callout collapsible block', () => {
    const result = formatOcrCollapsible('Hello world', 95);
    expect(result).toContain('[!note]- OCR Text');
    expect(result).toContain('95% confidence');
    expect(result).toContain('> Hello world');
  });

  it('handles multi-line text', () => {
    const result = formatOcrCollapsible('Line 1\nLine 2\nLine 3', 80);
    expect(result).toContain('> Line 1');
    expect(result).toContain('> Line 2');
    expect(result).toContain('> Line 3');
  });

  it('omits confidence when negative', () => {
    const result = formatOcrCollapsible('Some text', -1);
    expect(result).toContain('[!note]- OCR Text');
    expect(result).not.toContain('confidence');
  });
});

describe('formatOcrAltText', () => {
  it('returns empty string for empty input', () => {
    expect(formatOcrAltText('')).toBe('');
  });

  it('replaces newlines with spaces', () => {
    expect(formatOcrAltText('Line 1\nLine 2')).toBe('Line 1 Line 2');
  });

  it('collapses whitespace', () => {
    expect(formatOcrAltText('word1   word2\t\tword3')).toBe('word1 word2 word3');
  });

  it('truncates long text at 500 characters', () => {
    const longText = 'A'.repeat(600);
    const result = formatOcrAltText(longText);
    expect(result.length).toBe(503); // 500 + '...'
    expect(result).toMatch(/\.\.\.$/);
  });

  it('does not truncate text under 500 characters', () => {
    const text = 'A'.repeat(499);
    expect(formatOcrAltText(text)).toBe(text);
  });
});
