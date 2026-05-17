/**
 * Tests for the highlights-section marker migration.
 *
 * Notes written by the pre-rename `remarkable-bridge` plugin still contain
 * legacy markers. These tests pin down:
 *   - findHighlightsStart/End accept either marker form.
 *   - Writers (markdown-renderer, template-engine) emit only current markers.
 *   - On merge, a vault note containing legacy markers is rewritten to use
 *     the current markers — the section moves over without duplication.
 *   - Round-trip: parse a legacy-marker note, then re-merge; result has
 *     current markers only.
 */

import {
  HIGHLIGHTS_SECTION_START,
  HIGHLIGHTS_SECTION_END,
  LEGACY_HIGHLIGHTS_SECTION_START,
  LEGACY_HIGHLIGHTS_SECTION_END,
  findHighlightsStart,
  findHighlightsEnd,
} from './highlight-markers';
import { mergeWithExistingNote } from '../pipeline/markdown-renderer';
import { parseHighlightsFromNote } from './review-data';
import type {
  ExtractionResult,
  ReMarkableDocument,
  ExtractedHighlight,
} from '../pipeline/types';

function makeDoc(): ReMarkableDocument {
  return {
    uuid: 'doc-uuid',
    visibleName: 'Paper',
    parentUuid: '',
    type: 'pdf',
    lastModified: 1700000000000,
    pageCount: 1,
    pageUuids: [],
    hasPdf: true,
  };
}

function makeHighlight(text: string, page = 1): ExtractedHighlight {
  return { text, pageNumber: page, color: 'yellow', bounds: null, createdAt: null };
}

function makeResult(highlights: ExtractedHighlight[]): ExtractionResult {
  return {
    document: makeDoc(),
    highlights,
    warnings: [],
    formatDetected: 'v6',
    success: true,
    error: null,
    extractedAt: '2026-01-01T00:00:00Z',
  };
}

describe('highlight markers - locator helpers', () => {
  it('finds the current start marker', () => {
    const doc = `intro\n${HIGHLIGHTS_SECTION_START}\nbody\n${HIGHLIGHTS_SECTION_END}\n`;
    const start = findHighlightsStart(doc);
    expect(start).not.toBeNull();
    expect(start?.marker).toBe(HIGHLIGHTS_SECTION_START);
  });

  it('falls back to the legacy start marker', () => {
    const doc = `intro\n${LEGACY_HIGHLIGHTS_SECTION_START}\nbody\n${LEGACY_HIGHLIGHTS_SECTION_END}\n`;
    const start = findHighlightsStart(doc);
    const end = findHighlightsEnd(doc);
    expect(start?.marker).toBe(LEGACY_HIGHLIGHTS_SECTION_START);
    expect(end?.marker).toBe(LEGACY_HIGHLIGHTS_SECTION_END);
  });

  it('prefers the current marker when both are somehow present', () => {
    // Pathological case (a user manually pasted both); current wins so
    // a future write goes to the new section, not the legacy one.
    const doc = `${LEGACY_HIGHLIGHTS_SECTION_START}\nlegacy\n${LEGACY_HIGHLIGHTS_SECTION_END}\n${HIGHLIGHTS_SECTION_START}\nnew\n${HIGHLIGHTS_SECTION_END}`;
    expect(findHighlightsStart(doc)?.marker).toBe(HIGHLIGHTS_SECTION_START);
    expect(findHighlightsEnd(doc)?.marker).toBe(HIGHLIGHTS_SECTION_END);
  });

  it('returns null when neither marker is present', () => {
    expect(findHighlightsStart('plain note text')).toBeNull();
    expect(findHighlightsEnd('plain note text')).toBeNull();
  });
});

describe('mergeWithExistingNote - legacy marker migration', () => {
  it('migrates a legacy-marker note to current markers on merge', () => {
    // Simulates the user's vault note written by the pre-rename plugin.
    const before = '---\ntitle: Paper\n---\n\nUser preamble.\n\n';
    const after = '\n\nUser footer.\n';
    const legacy =
      before +
      LEGACY_HIGHLIGHTS_SECTION_START +
      '\n## Highlights\n\n> Old quote\n\n' +
      LEGACY_HIGHLIGHTS_SECTION_END +
      after;

    const result = makeResult([makeHighlight('Fresh quote', 1)]);
    const merged = mergeWithExistingNote(legacy, result, 'Paper.pdf');

    // New section uses current markers
    expect(merged).toContain(HIGHLIGHTS_SECTION_START);
    expect(merged).toContain(HIGHLIGHTS_SECTION_END);

    // Legacy markers are gone — the old section was replaced wholesale,
    // not appended next to.
    expect(merged).not.toContain(LEGACY_HIGHLIGHTS_SECTION_START);
    expect(merged).not.toContain(LEGACY_HIGHLIGHTS_SECTION_END);

    // Surrounding user content is preserved verbatim
    expect(merged).toContain('User preamble.');
    expect(merged).toContain('User footer.');

    // Old quote is gone, new quote is in
    expect(merged).not.toContain('Old quote');
    expect(merged).toContain('Fresh quote');
  });

  it('does not duplicate the section when migrating', () => {
    const legacy =
      LEGACY_HIGHLIGHTS_SECTION_START +
      '\nold\n' +
      LEGACY_HIGHLIGHTS_SECTION_END;
    const merged = mergeWithExistingNote(
      legacy,
      makeResult([makeHighlight('hi')]),
      'Paper.pdf',
    );

    // Exactly one start and one end marker
    const startMatches = merged.match(new RegExp(escapeRegex(HIGHLIGHTS_SECTION_START), 'g')) ?? [];
    const endMatches = merged.match(new RegExp(escapeRegex(HIGHLIGHTS_SECTION_END), 'g')) ?? [];
    expect(startMatches.length).toBe(1);
    expect(endMatches.length).toBe(1);
  });

  it('leaves a current-marker note alone (no churn)', () => {
    const current =
      HIGHLIGHTS_SECTION_START + '\nold\n' + HIGHLIGHTS_SECTION_END;
    const merged = mergeWithExistingNote(
      current,
      makeResult([makeHighlight('hi')]),
      'Paper.pdf',
    );
    expect(merged).toContain(HIGHLIGHTS_SECTION_START);
    expect(merged).not.toContain(LEGACY_HIGHLIGHTS_SECTION_START);
  });
});

describe('parseHighlightsFromNote - reads either marker form', () => {
  const noteBody =
    '\n## Highlights\n\n### Page 5\n\n> Quoted text from page five.\n> -- [[Paper.pdf#page=5|Page 5]]\n\n';

  it('parses a current-marker note', () => {
    const note = HIGHLIGHTS_SECTION_START + noteBody + HIGHLIGHTS_SECTION_END;
    const highlights = parseHighlightsFromNote(note);
    expect(highlights).toHaveLength(1);
    expect(highlights[0].text).toBe('Quoted text from page five.');
    expect(highlights[0].pageNumber).toBe(5);
  });

  it('parses a legacy-marker note', () => {
    const note =
      LEGACY_HIGHLIGHTS_SECTION_START +
      noteBody +
      LEGACY_HIGHLIGHTS_SECTION_END;
    const highlights = parseHighlightsFromNote(note);
    expect(highlights).toHaveLength(1);
    expect(highlights[0].text).toBe('Quoted text from page five.');
    expect(highlights[0].pageNumber).toBe(5);
  });

  it('returns empty for a note without any markers', () => {
    expect(parseHighlightsFromNote('just plain text')).toEqual([]);
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
