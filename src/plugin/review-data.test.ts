/**
 * Tests for the review data service.
 */

import {
  generateHighlightId,
  parseHighlightsFromNote,
  buildReviewData,
  buildReviewSummary,
  applyReviewAction,
  renderAcceptedHighlights,
} from './review-data';
import type { ReviewableHighlight, ReviewableDocument, PersistedReviewState } from './review-types';
import { DEFAULT_REVIEW_STATE } from './review-types';
import type { ExtractedHighlight } from '../pipeline/types';
import type { ScannerFileSystem } from './xochitl-scanner';
import {
  HIGHLIGHTS_SECTION_START,
  HIGHLIGHTS_SECTION_END,
} from './highlight-markers';

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function makeHighlight(overrides: Partial<ExtractedHighlight> = {}): ExtractedHighlight {
  return {
    text: 'Test highlight text',
    pageNumber: 1,
    color: null,
    bounds: null,
    createdAt: null,
    ...overrides,
  };
}

function makeReviewableHighlight(
  overrides: Partial<ReviewableHighlight> = {},
): ReviewableHighlight {
  const hl = makeHighlight(overrides.highlight);
  return {
    id: 'test-id-1',
    highlight: hl,
    status: 'pending',
    editedText: null,
    documentUuid: 'doc-uuid',
    documentName: 'Test Doc',
    sourcePdfName: 'Test Doc.pdf',
    ...overrides,
  };
}

// -------------------------------------------------------------------
// generateHighlightId
// -------------------------------------------------------------------

describe('generateHighlightId', () => {
  it('should generate a deterministic ID', () => {
    const hl = makeHighlight({ text: 'Hello world', pageNumber: 5 });
    const id1 = generateHighlightId('doc-uuid', hl);
    const id2 = generateHighlightId('doc-uuid', hl);
    expect(id1).toBe(id2);
  });

  it('should generate different IDs for different texts', () => {
    const hl1 = makeHighlight({ text: 'Hello', pageNumber: 1 });
    const hl2 = makeHighlight({ text: 'World', pageNumber: 1 });
    const id1 = generateHighlightId('doc-uuid', hl1);
    const id2 = generateHighlightId('doc-uuid', hl2);
    expect(id1).not.toBe(id2);
  });

  it('should generate different IDs for different documents', () => {
    const hl = makeHighlight();
    const id1 = generateHighlightId('doc-1', hl);
    const id2 = generateHighlightId('doc-2', hl);
    expect(id1).not.toBe(id2);
  });

  it('should include page number in ID', () => {
    const hl = makeHighlight({ pageNumber: 7 });
    const id = generateHighlightId('doc-uuid', hl);
    expect(id).toContain('p7');
  });
});

// -------------------------------------------------------------------
// parseHighlightsFromNote
// -------------------------------------------------------------------

describe('parseHighlightsFromNote', () => {
  it('should parse blockquote highlights with page references', () => {
    const content = [
      '<!-- remarkable-bridge:start -->',
      '## Highlights',
      '',
      '### Page 1',
      '',
      '> This is a test highlight',
      '> -- [[doc.pdf#page=1|Page 1]]',
      '',
      '### Page 3',
      '',
      '> Another highlight on page three',
      '> -- [[doc.pdf#page=3|Page 3]]',
      '',
      '<!-- remarkable-bridge:end -->',
    ].join('\n');

    const highlights = parseHighlightsFromNote(content);
    expect(highlights).toHaveLength(2);
    expect(highlights[0].text).toBe('This is a test highlight');
    expect(highlights[0].pageNumber).toBe(1);
    expect(highlights[1].text).toBe('Another highlight on page three');
    expect(highlights[1].pageNumber).toBe(3);
  });

  it('should handle multi-line highlights', () => {
    const content = [
      '<!-- remarkable-bridge:start -->',
      '## Highlights',
      '',
      '> Line one',
      '> Line two',
      '> -- [[doc.pdf#page=2|Page 2]]',
      '',
      '<!-- remarkable-bridge:end -->',
    ].join('\n');

    const highlights = parseHighlightsFromNote(content);
    expect(highlights).toHaveLength(1);
    expect(highlights[0].text).toBe('Line one\nLine two');
    expect(highlights[0].pageNumber).toBe(2);
  });

  it('should return empty array when no markers found', () => {
    const content = '# Just a regular note\n\nSome content.';
    const highlights = parseHighlightsFromNote(content);
    expect(highlights).toHaveLength(0);
  });

  it('should return empty array when no highlights between markers', () => {
    const content = [
      '<!-- remarkable-bridge:start -->',
      '## Highlights',
      '',
      '_No highlights found in this document._',
      '',
      '<!-- remarkable-bridge:end -->',
    ].join('\n');

    const highlights = parseHighlightsFromNote(content);
    expect(highlights).toHaveLength(0);
  });

  it('should handle PDF++ page format (page=N)', () => {
    const content = [
      '<!-- remarkable-bridge:start -->',
      '> Test text',
      '> -- [[file.pdf#page=10|Page 10]]',
      '<!-- remarkable-bridge:end -->',
    ].join('\n');

    const highlights = parseHighlightsFromNote(content);
    expect(highlights).toHaveLength(1);
    expect(highlights[0].pageNumber).toBe(10);
  });
});

// -------------------------------------------------------------------
// applyReviewAction
// -------------------------------------------------------------------

describe('applyReviewAction', () => {
  it('should accept a pending highlight', () => {
    const rh = makeReviewableHighlight({ status: 'pending' });
    const updated = applyReviewAction(rh, 'accept');
    expect(updated.status).toBe('accepted');
    expect(updated.editedText).toBeNull();
  });

  it('should accept with edited text', () => {
    const rh = makeReviewableHighlight({ status: 'pending' });
    const updated = applyReviewAction(rh, 'accept', 'Modified text');
    expect(updated.status).toBe('edited');
    expect(updated.editedText).toBe('Modified text');
  });

  it('should dismiss a pending highlight', () => {
    const rh = makeReviewableHighlight({ status: 'pending' });
    const updated = applyReviewAction(rh, 'dismiss');
    expect(updated.status).toBe('dismissed');
  });

  it('should undo a dismissed highlight', () => {
    const rh = makeReviewableHighlight({ status: 'dismissed' });
    const updated = applyReviewAction(rh, 'undo');
    expect(updated.status).toBe('pending');
    expect(updated.editedText).toBeNull();
  });

  it('should not mutate the original object', () => {
    const rh = makeReviewableHighlight({ status: 'pending' });
    const updated = applyReviewAction(rh, 'accept');
    expect(rh.status).toBe('pending');
    expect(updated.status).toBe('accepted');
  });
});

// -------------------------------------------------------------------
// buildReviewSummary
// -------------------------------------------------------------------

describe('buildReviewSummary', () => {
  it('should count pending, accepted, and dismissed highlights', () => {
    const docs: ReviewableDocument[] = [
      {
        uuid: 'doc-1',
        name: 'Doc 1',
        sourcePdfName: 'Doc 1.pdf',
        lastModified: Date.now(),
        pendingCount: 2,
        highlights: [
          makeReviewableHighlight({ id: '1', status: 'pending' }),
          makeReviewableHighlight({ id: '2', status: 'pending' }),
          makeReviewableHighlight({ id: '3', status: 'accepted' }),
        ],
      },
      {
        uuid: 'doc-2',
        name: 'Doc 2',
        sourcePdfName: 'Doc 2.pdf',
        lastModified: Date.now(),
        pendingCount: 1,
        highlights: [
          makeReviewableHighlight({ id: '4', status: 'pending' }),
          makeReviewableHighlight({ id: '5', status: 'dismissed' }),
        ],
      },
    ];

    const summary = buildReviewSummary(docs);
    expect(summary.totalPending).toBe(3);
    expect(summary.totalAccepted).toBe(1);
    expect(summary.totalDismissed).toBe(1);
    expect(summary.documentsWithPending).toBe(2);
  });

  it('should handle empty document list', () => {
    const summary = buildReviewSummary([]);
    expect(summary.totalPending).toBe(0);
    expect(summary.totalAccepted).toBe(0);
    expect(summary.totalDismissed).toBe(0);
    expect(summary.documentsWithPending).toBe(0);
  });
});

// -------------------------------------------------------------------
// renderAcceptedHighlights
// -------------------------------------------------------------------

describe('renderAcceptedHighlights', () => {
  it('should render accepted highlights as blockquotes with PDF++ links', () => {
    const highlights: ReviewableHighlight[] = [
      makeReviewableHighlight({
        status: 'accepted',
        highlight: makeHighlight({ text: 'Important finding', pageNumber: 5 }),
        sourcePdfName: 'Paper.pdf',
      }),
    ];

    const output = renderAcceptedHighlights(highlights);
    expect(output).toContain('> Important finding');
    expect(output).toContain('> -- [[Paper.pdf#page=5|Page 5]]');
  });

  it('should use edited text when available', () => {
    const highlights: ReviewableHighlight[] = [
      makeReviewableHighlight({
        status: 'edited',
        editedText: 'Corrected text',
        highlight: makeHighlight({ text: 'Original text', pageNumber: 1 }),
        sourcePdfName: 'Paper.pdf',
      }),
    ];

    const output = renderAcceptedHighlights(highlights);
    expect(output).toContain('> Corrected text');
    expect(output).not.toContain('Original text');
  });

  it('should skip pending and dismissed highlights', () => {
    const highlights: ReviewableHighlight[] = [
      makeReviewableHighlight({ id: '1', status: 'pending' }),
      makeReviewableHighlight({ id: '2', status: 'dismissed' }),
      makeReviewableHighlight({
        id: '3',
        status: 'accepted',
        highlight: makeHighlight({ text: 'Accepted one' }),
      }),
    ];

    const output = renderAcceptedHighlights(highlights);
    expect(output).toContain('> Accepted one');
    expect(output).not.toContain('Test highlight text');
  });

  it('should return empty string when no accepted highlights', () => {
    const highlights: ReviewableHighlight[] = [
      makeReviewableHighlight({ status: 'pending' }),
    ];

    const output = renderAcceptedHighlights(highlights);
    expect(output).toBe('');
  });

  it('should include color comment for non-yellow highlights', () => {
    const highlights: ReviewableHighlight[] = [
      makeReviewableHighlight({
        status: 'accepted',
        highlight: makeHighlight({ text: 'Blue hl', color: 'blue', pageNumber: 1 }),
        sourcePdfName: 'doc.pdf',
      }),
    ];

    const output = renderAcceptedHighlights(highlights);
    expect(output).toContain('<!-- highlight-color: blue -->');
  });
});

// -------------------------------------------------------------------
// buildReviewData (with injectable filesystem)
// -------------------------------------------------------------------

/**
 * Helper: build a mock ScannerFileSystem from a virtual file tree.
 *
 * The `files` map uses absolute paths as keys and file contents as values.
 * `dirs` is a set of paths that should be treated as existing directories.
 */
function createMockFs(
  files: Record<string, string>,
  dirs: Set<string>,
): ScannerFileSystem {
  /** Normalise path separators to forward slashes for cross-platform matching. */
  const norm = (p: string) => p.replace(/\\/g, '/');

  return {
    existsSync(p: string): boolean {
      const n = norm(p);
      for (const d of dirs) { if (norm(d) === n) return true; }
      for (const k of Object.keys(files)) { if (norm(k) === n) return true; }
      return false;
    },
    readFileSync(p: string, _encoding: 'utf-8'): string {
      const n = norm(p);
      for (const [k, v] of Object.entries(files)) {
        if (norm(k) === n) return v;
      }
      throw new Error(`ENOENT: no such file: ${p}`);
    },
    readdirSync(p: string): string[] {
      const n = norm(p);
      const prefix = n.endsWith('/') ? n : n + '/';
      const entries = new Set<string>();
      for (const key of Object.keys(files)) {
        const normKey = norm(key);
        if (normKey.startsWith(prefix)) {
          const rest = normKey.substring(prefix.length);
          // Only direct children (no nested slashes)
          if (!rest.includes('/')) {
            entries.add(rest);
          }
        }
      }
      return Array.from(entries);
    },
  };
}

/** Build a note with highlights between markers. */
function buildNoteWithHighlights(highlights: { text: string; page: number }[]): string {
  const lines = [
    '---',
    'title: "Test"',
    '---',
    '',
    HIGHLIGHTS_SECTION_START,
    '## Highlights',
    '',
  ];
  for (const h of highlights) {
    lines.push(`> ${h.text}`);
    lines.push(`> -- [[Test.pdf#page=${h.page}|Page ${h.page}]]`);
    lines.push('');
  }
  lines.push(HIGHLIGHTS_SECTION_END);
  return lines.join('\n');
}

describe('buildReviewData', () => {
  const xochitlPath = '/mock/xochitl';
  const outputPath = '/mock/output';

  it('should return documents with pending highlights', () => {
    const note = buildNoteWithHighlights([
      { text: 'First highlight', page: 1 },
      { text: 'Second highlight', page: 3 },
    ]);

    const mockFs = createMockFs(
      {
        [`${xochitlPath}/abc123.metadata`]: JSON.stringify({
          visibleName: 'My Paper',
          type: 'DocumentType',
          lastModified: '1700000000000',
        }),
        [`${xochitlPath}/abc123.content`]: JSON.stringify({ fileType: 'pdf' }),
        [`${outputPath}/My Paper.md`]: note,
      },
      new Set([xochitlPath, outputPath]),
    );

    const reviewState: PersistedReviewState = { ...DEFAULT_REVIEW_STATE };
    const docs = buildReviewData(xochitlPath, outputPath, reviewState, mockFs);

    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe('My Paper');
    expect(docs[0].highlights).toHaveLength(2);
    expect(docs[0].highlights[0].status).toBe('pending');
    expect(docs[0].highlights[1].status).toBe('pending');
    expect(docs[0].pendingCount).toBe(2);
  });

  it('should skip already-accepted highlights', () => {
    const note = buildNoteWithHighlights([
      { text: 'Accepted one', page: 1 },
      { text: 'Still pending', page: 2 },
    ]);

    const mockFs = createMockFs(
      {
        [`${xochitlPath}/doc1.metadata`]: JSON.stringify({
          visibleName: 'Paper',
          type: 'DocumentType',
          lastModified: '1700000000000',
        }),
        [`${xochitlPath}/doc1.content`]: JSON.stringify({ fileType: 'pdf' }),
        [`${outputPath}/Paper.md`]: note,
      },
      new Set([xochitlPath, outputPath]),
    );

    // Mark the first highlight as accepted
    const reviewState: PersistedReviewState = { ...DEFAULT_REVIEW_STATE };
    // We need the actual ID -- build it by generating one for the first highlight
    const { generateHighlightId: genId } = require('./review-data');
    const hlAccepted = makeHighlight({ text: 'Accepted one', pageNumber: 1 });
    const acceptedId = genId('doc1', hlAccepted);
    reviewState.reviewedHighlights[acceptedId] = 'accepted';

    const docs = buildReviewData(xochitlPath, outputPath, reviewState, mockFs);

    expect(docs).toHaveLength(1);
    expect(docs[0].highlights).toHaveLength(1);
    expect(docs[0].highlights[0].highlight.text).toBe('Still pending');
  });

  it('should mark dismissed highlights with their status', () => {
    const note = buildNoteWithHighlights([
      { text: 'Dismissed highlight', page: 5 },
    ]);

    const mockFs = createMockFs(
      {
        [`${xochitlPath}/d1.metadata`]: JSON.stringify({
          visibleName: 'Doc',
          type: 'DocumentType',
          lastModified: '1700000000000',
        }),
        [`${outputPath}/Doc.md`]: note,
      },
      new Set([xochitlPath, outputPath]),
    );

    const reviewState: PersistedReviewState = { ...DEFAULT_REVIEW_STATE };
    const hlDismissed = makeHighlight({ text: 'Dismissed highlight', pageNumber: 5 });
    const dismissedId = generateHighlightId('d1', hlDismissed);
    reviewState.reviewedHighlights[dismissedId] = 'dismissed';

    const docs = buildReviewData(xochitlPath, outputPath, reviewState, mockFs);

    expect(docs).toHaveLength(1);
    expect(docs[0].highlights[0].status).toBe('dismissed');
  });

  it('should skip non-PDF documents', () => {
    const note = buildNoteWithHighlights([{ text: 'A highlight', page: 1 }]);

    const mockFs = createMockFs(
      {
        [`${xochitlPath}/epub1.metadata`]: JSON.stringify({
          visibleName: 'EpubDoc',
          type: 'DocumentType',
          lastModified: '1700000000000',
        }),
        [`${xochitlPath}/epub1.content`]: JSON.stringify({ fileType: 'epub' }),
        [`${outputPath}/EpubDoc.md`]: note,
      },
      new Set([xochitlPath, outputPath]),
    );

    const docs = buildReviewData(
      xochitlPath,
      outputPath,
      { ...DEFAULT_REVIEW_STATE },
      mockFs,
    );

    expect(docs).toHaveLength(0);
  });

  it('should skip deleted documents', () => {
    const note = buildNoteWithHighlights([{ text: 'Deleted doc hl', page: 1 }]);

    const mockFs = createMockFs(
      {
        [`${xochitlPath}/del1.metadata`]: JSON.stringify({
          visibleName: 'Deleted',
          type: 'DocumentType',
          deleted: true,
          lastModified: '1700000000000',
        }),
        [`${outputPath}/Deleted.md`]: note,
      },
      new Set([xochitlPath, outputPath]),
    );

    const docs = buildReviewData(
      xochitlPath,
      outputPath,
      { ...DEFAULT_REVIEW_STATE },
      mockFs,
    );

    expect(docs).toHaveLength(0);
  });

  it('should skip folders (CollectionType)', () => {
    const mockFs = createMockFs(
      {
        [`${xochitlPath}/folder1.metadata`]: JSON.stringify({
          visibleName: 'MyFolder',
          type: 'CollectionType',
          lastModified: '1700000000000',
        }),
      },
      new Set([xochitlPath, outputPath]),
    );

    const docs = buildReviewData(
      xochitlPath,
      outputPath,
      { ...DEFAULT_REVIEW_STATE },
      mockFs,
    );

    expect(docs).toHaveLength(0);
  });

  it('should return empty array for missing xochitl path', () => {
    const mockFs = createMockFs({}, new Set([outputPath]));

    const docs = buildReviewData(
      '/nonexistent',
      outputPath,
      { ...DEFAULT_REVIEW_STATE },
      mockFs,
    );

    expect(docs).toHaveLength(0);
  });

  it('should return empty array for missing output path', () => {
    const mockFs = createMockFs({}, new Set([xochitlPath]));

    const docs = buildReviewData(
      xochitlPath,
      '/nonexistent',
      { ...DEFAULT_REVIEW_STATE },
      mockFs,
    );

    expect(docs).toHaveLength(0);
  });

  it('should skip documents with no extracted note', () => {
    const mockFs = createMockFs(
      {
        [`${xochitlPath}/no-note.metadata`]: JSON.stringify({
          visibleName: 'NoNote',
          type: 'DocumentType',
          lastModified: '1700000000000',
        }),
        [`${xochitlPath}/no-note.content`]: JSON.stringify({ fileType: 'pdf' }),
        // Note: no output/NoNote.md file
      },
      new Set([xochitlPath, outputPath]),
    );

    const docs = buildReviewData(
      xochitlPath,
      outputPath,
      { ...DEFAULT_REVIEW_STATE },
      mockFs,
    );

    expect(docs).toHaveLength(0);
  });

  it('should exclude documents where all highlights are accepted', () => {
    const note = buildNoteWithHighlights([{ text: 'Only highlight', page: 1 }]);

    const mockFs = createMockFs(
      {
        [`${xochitlPath}/all-done.metadata`]: JSON.stringify({
          visibleName: 'AllDone',
          type: 'DocumentType',
          lastModified: '1700000000000',
        }),
        [`${outputPath}/AllDone.md`]: note,
      },
      new Set([xochitlPath, outputPath]),
    );

    const reviewState: PersistedReviewState = { ...DEFAULT_REVIEW_STATE };
    const hl = makeHighlight({ text: 'Only highlight', pageNumber: 1 });
    const id = generateHighlightId('all-done', hl);
    reviewState.reviewedHighlights[id] = 'accepted';

    const docs = buildReviewData(xochitlPath, outputPath, reviewState, mockFs);

    expect(docs).toHaveLength(0);
  });

  it('should handle multiple documents sorted by lastModified', () => {
    const noteA = buildNoteWithHighlights([{ text: 'HL A', page: 1 }]);
    const noteB = buildNoteWithHighlights([{ text: 'HL B', page: 1 }]);

    const mockFs = createMockFs(
      {
        [`${xochitlPath}/older.metadata`]: JSON.stringify({
          visibleName: 'Older',
          type: 'DocumentType',
          lastModified: '1600000000000',
        }),
        [`${outputPath}/Older.md`]: noteA,
        [`${xochitlPath}/newer.metadata`]: JSON.stringify({
          visibleName: 'Newer',
          type: 'DocumentType',
          lastModified: '1700000000000',
        }),
        [`${outputPath}/Newer.md`]: noteB,
      },
      new Set([xochitlPath, outputPath]),
    );

    const docs = buildReviewData(
      xochitlPath,
      outputPath,
      { ...DEFAULT_REVIEW_STATE },
      mockFs,
    );

    expect(docs).toHaveLength(2);
    // Most recent first
    expect(docs[0].name).toBe('Newer');
    expect(docs[1].name).toBe('Older');
  });
});
