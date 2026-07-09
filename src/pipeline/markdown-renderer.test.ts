/**
 * Tests for markdown-renderer.ts -- highlight rendering, frontmatter generation,
 * PDF++ link formatting, and incremental update merging.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  renderMarkdown,
  mergeWithExistingNote,
  generateOutputFilename,
  resolveOutputBaseNames,
  scanExistingNoteBaseNames,
  DefaultMarkdownRenderer,
  HIGHLIGHTS_SECTION_START,
  HIGHLIGHTS_SECTION_END,
} from './markdown-renderer';
import { ExtractionResult, ReMarkableDocument, ExtractedHighlight } from './types';

/** Create a minimal ReMarkableDocument for testing. */
function createTestDocument(overrides: Partial<ReMarkableDocument> = {}): ReMarkableDocument {
  return {
    uuid: 'test-uuid-123',
    visibleName: 'Test Paper Title',
    parentUuid: '',
    type: 'pdf',
    lastModified: 1700000000000,
    pageCount: 10,
    pageUuids: [],
    hasPdf: true,
    ...overrides,
  };
}

/** Create a minimal ExtractedHighlight for testing. */
function createTestHighlight(overrides: Partial<ExtractedHighlight> = {}): ExtractedHighlight {
  return {
    text: 'This is highlighted text.',
    pageNumber: 1,
    color: 'yellow',
    bounds: null,
    createdAt: null,
    ...overrides,
  };
}

/** Create a minimal ExtractionResult for testing. */
function createTestResult(
  highlights: ExtractedHighlight[] = [],
  docOverrides: Partial<ReMarkableDocument> = {},
): ExtractionResult {
  return {
    document: createTestDocument(docOverrides),
    highlights,
    warnings: [],
    formatDetected: 'v6',
    success: true,
    error: null,
    extractedAt: '2024-01-15T10:00:00.000Z',
  };
}

describe('renderMarkdown', () => {
  it('renders frontmatter with correct fields', () => {
    const result = createTestResult([createTestHighlight()]);
    const md = renderMarkdown(result, 'Test Paper Title.pdf');

    expect(md).toContain('---');
    expect(md).toContain('title: "Test Paper Title"');
    expect(md).toContain('source_pdf: "[[Test Paper Title.pdf]]"');
    expect(md).toContain('source_type: pdf');
    expect(md).toContain('highlight_count: 1');
    expect(md).toContain('remarkable_uuid: test-uuid-123');
  });

  it('does not add default tags to frontmatter', () => {
    const result = createTestResult([createTestHighlight()]);
    const md = renderMarkdown(result, 'Test Paper Title.pdf');

    // No tags should appear in the default renderer output
    expect(md).not.toContain('tags:');
    expect(md).not.toContain('  - remarkable');
  });

  it('includes overwrite warning comment after frontmatter', () => {
    const result = createTestResult([createTestHighlight()]);
    const md = renderMarkdown(result, 'Paper.pdf');

    expect(md).toContain('<!-- Note: Highlights between the %% markers are auto-generated');
    expect(md).toContain('Add your own notes outside the markers. -->');
  });

  it('renders highlights as blockquotes', () => {
    const result = createTestResult([
      createTestHighlight({ text: 'First highlight', pageNumber: 3 }),
    ]);
    const md = renderMarkdown(result, 'Paper.pdf');

    expect(md).toContain('> First highlight');
  });

  it('includes PDF++ compatible page links', () => {
    const result = createTestResult([
      createTestHighlight({ text: 'Some text', pageNumber: 5 }),
    ]);
    const md = renderMarkdown(result, 'Paper.pdf');

    expect(md).toContain('[[Paper.pdf#page=5|Page 5]]');
  });

  it('groups highlights by page with subheadings', () => {
    const result = createTestResult([
      createTestHighlight({ text: 'First on page 1', pageNumber: 1 }),
      createTestHighlight({ text: 'Second on page 1', pageNumber: 1 }),
      createTestHighlight({ text: 'On page 3', pageNumber: 3 }),
    ]);
    const md = renderMarkdown(result, 'Paper.pdf');

    expect(md).toContain('### Page 1');
    expect(md).toContain('### Page 3');
    expect(md).toContain('> First on page 1');
    expect(md).toContain('> Second on page 1');
    expect(md).toContain('> On page 3');
  });

  it('shows message when no highlights found', () => {
    const result = createTestResult([]);
    const md = renderMarkdown(result);

    expect(md).toContain('_No highlights or annotations found in this document._');
  });

  it('includes highlight color for non-yellow highlights', () => {
    const result = createTestResult([
      createTestHighlight({ text: 'Blue highlight', color: 'blue' }),
    ]);
    const md = renderMarkdown(result, 'Paper.pdf');

    expect(md).toContain('<!-- highlight-color: blue -->');
  });

  it('omits color comment for yellow highlights', () => {
    const result = createTestResult([
      createTestHighlight({ text: 'Yellow highlight', color: 'yellow' }),
    ]);
    const md = renderMarkdown(result, 'Paper.pdf');

    expect(md).not.toContain('highlight-color');
  });

  it('includes section markers for incremental updates', () => {
    const result = createTestResult([createTestHighlight()]);
    const md = renderMarkdown(result);

    expect(md).toContain(HIGHLIGHTS_SECTION_START);
    expect(md).toContain(HIGHLIGHTS_SECTION_END);
  });

  it('includes warnings section when warnings exist', () => {
    const result = createTestResult([]);
    result.warnings = ['Missing page 5 annotations', 'Low confidence on page 8'];
    const md = renderMarkdown(result);

    expect(md).toContain('## Extraction Notes');
    expect(md).toContain('- Missing page 5 annotations');
    expect(md).toContain('- Low confidence on page 8');
  });

  it('handles multi-line highlight text', () => {
    const result = createTestResult([
      createTestHighlight({
        text: 'Line one\nLine two\nLine three',
        pageNumber: 1,
      }),
    ]);
    const md = renderMarkdown(result, 'Paper.pdf');

    expect(md).toContain('> Line one');
    expect(md).toContain('> Line two');
    expect(md).toContain('> Line three');
  });

  it('escapes special YAML characters in title', () => {
    const result = createTestResult([], {
      visibleName: 'Paper: "A Study" of Things',
    });
    const md = renderMarkdown(result);

    expect(md).toContain('title: "Paper: \\"A Study\\" of Things"');
  });

  it('defaults source PDF name from document visible name', () => {
    const result = createTestResult([
      createTestHighlight({ text: 'Test', pageNumber: 1 }),
    ]);
    const md = renderMarkdown(result);
    // Default should use visibleName + .pdf
    expect(md).toContain('Test Paper Title.pdf');
  });
});

describe('mergeWithExistingNote', () => {
  it('replaces content between markers', () => {
    const existing = [
      '---',
      'title: "Test"',
      'highlight_count: 1',
      '---',
      '',
      '# My Notes',
      '',
      'Some user-written content here.',
      '',
      HIGHLIGHTS_SECTION_START,
      '## Highlights',
      '',
      '### Page 1',
      '',
      '> Old highlight',
      '> -- [[Paper.pdf#page=1|Page 1]]',
      '',
      HIGHLIGHTS_SECTION_END,
      '',
      'More user content below.',
    ].join('\n');

    const result = createTestResult([
      createTestHighlight({ text: 'New highlight', pageNumber: 2 }),
    ]);
    const merged = mergeWithExistingNote(existing, result, 'Paper.pdf');

    // User content is preserved
    expect(merged).toContain('Some user-written content here.');
    expect(merged).toContain('More user content below.');

    // Old highlight is replaced
    expect(merged).not.toContain('Old highlight');

    // New highlight is present
    expect(merged).toContain('> New highlight');
    expect(merged).toContain('[[Paper.pdf#page=2|Page 2]]');
  });

  it('updates frontmatter highlight count', () => {
    const existing = [
      '---',
      'title: "Test"',
      'highlight_count: 1',
      '---',
      '',
      HIGHLIGHTS_SECTION_START,
      '## Highlights',
      HIGHLIGHTS_SECTION_END,
    ].join('\n');

    const result = createTestResult([
      createTestHighlight({ text: 'H1', pageNumber: 1 }),
      createTestHighlight({ text: 'H2', pageNumber: 2 }),
      createTestHighlight({ text: 'H3', pageNumber: 3 }),
    ]);
    const merged = mergeWithExistingNote(existing, result, 'Paper.pdf');

    expect(merged).toContain('highlight_count: 3');
    expect(merged).not.toContain('highlight_count: 1');
  });

  it('appends section when no markers exist', () => {
    const existing = [
      '---',
      'title: "Test"',
      '---',
      '',
      '# Manual Note',
      '',
      'User wrote this.',
    ].join('\n');

    const result = createTestResult([
      createTestHighlight({ text: 'New highlight', pageNumber: 1 }),
    ]);
    const merged = mergeWithExistingNote(existing, result, 'Paper.pdf');

    // Original content preserved
    expect(merged).toContain('User wrote this.');

    // Section appended
    expect(merged).toContain(HIGHLIGHTS_SECTION_START);
    expect(merged).toContain('> New highlight');
    expect(merged).toContain(HIGHLIGHTS_SECTION_END);
  });

  it('preserves content before and after markers exactly', () => {
    const before = 'BEFORE CONTENT\n';
    const after = '\nAFTER CONTENT';
    const existing = before + HIGHLIGHTS_SECTION_START + '\nold stuff\n' + HIGHLIGHTS_SECTION_END + after;

    const result = createTestResult([]);
    const merged = mergeWithExistingNote(existing, result, 'Paper.pdf');

    expect(merged.startsWith('BEFORE CONTENT')).toBe(true);
    expect(merged.endsWith('AFTER CONTENT')).toBe(true);
  });
});

describe('generateOutputFilename', () => {
  it('returns the visible name as-is when clean', () => {
    expect(generateOutputFilename('Clean Title')).toBe('Clean Title');
  });

  it('removes invalid filename characters', () => {
    expect(generateOutputFilename('File: A <test> "name"')).toBe('File A test name');
  });

  it('collapses multiple spaces', () => {
    expect(generateOutputFilename('Too   Many    Spaces')).toBe('Too Many Spaces');
  });

  it('returns Untitled for empty input', () => {
    expect(generateOutputFilename('')).toBe('Untitled');
  });

  it('returns Untitled for all-invalid characters', () => {
    expect(generateOutputFilename(':<>|?*')).toBe('Untitled');
  });

  it('trims whitespace', () => {
    expect(generateOutputFilename('  Padded  ')).toBe('Padded');
  });
});

describe('resolveOutputBaseNames', () => {
  it('leaves uniquely-named documents unchanged', () => {
    const map = resolveOutputBaseNames([
      { uuid: 'aaaaaaaa-1', visibleName: 'Alpha' },
      { uuid: 'bbbbbbbb-2', visibleName: 'Beta' },
    ]);
    expect(map.get('aaaaaaaa-1')).toBe('Alpha');
    expect(map.get('bbbbbbbb-2')).toBe('Beta');
  });

  it('suffixes ALL documents in a colliding group with their uuid', () => {
    const map = resolveOutputBaseNames([
      { uuid: 'f6d11d23-xxxx', visibleName: 'Quick sheets' },
      { uuid: '5a5e2c9f-yyyy', visibleName: 'Quick sheets' },
    ]);
    expect(map.get('f6d11d23-xxxx')).toBe('Quick sheets (f6d11d23)');
    expect(map.get('5a5e2c9f-yyyy')).toBe('Quick sheets (5a5e2c9f)');
  });

  it('detects collisions after sanitization, and only within the colliding name', () => {
    const map = resolveOutputBaseNames([
      { uuid: 'aaaaaaaa-1', visibleName: 'Report: 2024' },
      { uuid: 'bbbbbbbb-2', visibleName: 'Report 2024' }, // sanitizes to same
      { uuid: 'cccccccc-3', visibleName: 'Unique' },
    ]);
    expect(map.get('aaaaaaaa-1')).toBe('Report 2024 (aaaaaaaa)');
    expect(map.get('bbbbbbbb-2')).toBe('Report 2024 (bbbbbbbb)');
    expect(map.get('cccccccc-3')).toBe('Unique');
  });

  it('is deterministic regardless of input order', () => {
    const docs = [
      { uuid: 'f6d11d23-xxxx', visibleName: 'Quick sheets' },
      { uuid: '5a5e2c9f-yyyy', visibleName: 'Quick sheets' },
    ];
    const a = resolveOutputBaseNames(docs);
    const b = resolveOutputBaseNames([...docs].reverse());
    expect(a.get('f6d11d23-xxxx')).toBe(b.get('f6d11d23-xxxx'));
    expect(a.get('5a5e2c9f-yyyy')).toBe(b.get('5a5e2c9f-yyyy'));
  });

  // --- sticky naming (existingByUuid) ---

  it('reuses the existing note name for a document that already has one', () => {
    const existing = new Map([['bbbbbbbb-2', 'Report (bbbbbbbb)']]);
    const map = resolveOutputBaseNames(
      [{ uuid: 'bbbbbbbb-2', visibleName: 'Report' }],
      existing,
    );
    // Sticky: does NOT revert to the clean 'Report' now that it's the only one.
    expect(map.get('bbbbbbbb-2')).toBe('Report (bbbbbbbb)');
  });

  it('does not revert a suffixed note when its colliding sibling is removed', () => {
    // docA ('Report') is gone; only docB remains, holding a suffixed note.
    const existing = new Map([['bbbbbbbb-2', 'Report (bbbbbbbb)']]);
    const map = resolveOutputBaseNames(
      [{ uuid: 'bbbbbbbb-2', visibleName: 'Report' }],
      existing,
    );
    expect(map.get('bbbbbbbb-2')).toBe('Report (bbbbbbbb)');
  });

  it('gives a new document the clean name when the existing sibling is suffixed', () => {
    const existing = new Map([['bbbbbbbb-2', 'Report (bbbbbbbb)']]);
    const map = resolveOutputBaseNames(
      [
        { uuid: 'bbbbbbbb-2', visibleName: 'Report' },   // keeps suffixed note
        { uuid: 'cccccccc-3', visibleName: 'Report' },   // new, 'Report' is free
      ],
      existing,
    );
    expect(map.get('bbbbbbbb-2')).toBe('Report (bbbbbbbb)');
    expect(map.get('cccccccc-3')).toBe('Report');
  });

  it('suffixes a new document that collides with an existing plain note', () => {
    const existing = new Map([['aaaaaaaa-1', 'Report']]);
    const map = resolveOutputBaseNames(
      [
        { uuid: 'aaaaaaaa-1', visibleName: 'Report' },   // keeps 'Report'
        { uuid: 'dddddddd-4', visibleName: 'Report' },   // new, must not clobber
      ],
      existing,
    );
    expect(map.get('aaaaaaaa-1')).toBe('Report');
    expect(map.get('dddddddd-4')).toBe('Report (dddddddd)');
  });
});

describe('scanExistingNoteBaseNames', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-notes-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps each note to its document UUID from frontmatter', () => {
    fs.writeFileSync(
      path.join(dir, 'Quick sheets.md'),
      '---\ntitle: "Quick sheets"\nremarkable_uuid: 5a5e2c9f-a85e-4c2c-978c-4fa3cca428f7\n---\nbody',
    );
    fs.writeFileSync(
      path.join(dir, 'Report (aaaaaaaa).md'),
      '---\nremarkable_uuid: aaaaaaaa-1111-2222-3333-444444444444\n---\n',
    );
    const map = scanExistingNoteBaseNames(dir);
    expect(map.get('5a5e2c9f-a85e-4c2c-978c-4fa3cca428f7')).toBe('Quick sheets');
    expect(map.get('aaaaaaaa-1111-2222-3333-444444444444')).toBe('Report (aaaaaaaa)');
  });

  it('ignores non-md files and notes without a uuid', () => {
    fs.writeFileSync(path.join(dir, 'note.txt'), 'remarkable_uuid: 5a5e2c9f-a85e-4c2c-978c-4fa3cca428f7');
    fs.writeFileSync(path.join(dir, 'No UUID.md'), '---\ntitle: x\n---\n');
    expect(scanExistingNoteBaseNames(dir).size).toBe(0);
  });

  it('returns an empty map for a missing folder', () => {
    expect(scanExistingNoteBaseNames(path.join(dir, 'does-not-exist')).size).toBe(0);
  });
});

describe('DefaultMarkdownRenderer', () => {
  it('implements MarkdownRenderer interface', () => {
    const renderer = new DefaultMarkdownRenderer();
    const result = createTestResult([createTestHighlight()]);
    const md = renderer.render(result);

    expect(md).toContain('title: "Test Paper Title"');
    expect(md).toContain('> This is highlighted text.');
  });
});

describe('Page drawings in markdown output', () => {
  it('includes page drawings in correct page sections', () => {
    const result = createTestResult([
      createTestHighlight({ text: 'Some text', pageNumber: 1 }),
    ]);
    const pageDrawings = new Map<number, string>([
      [1, 'My Doc_p1.png'],
      [3, 'My Doc_p3.png'],
    ]);

    const md = renderMarkdown(result, 'Paper.pdf', pageDrawings);

    expect(md).toContain('### Page 1');
    expect(md).toContain('![[My Doc_p1.png|500]]');
    expect(md).toContain('### Page 3');
    expect(md).toContain('![[My Doc_p3.png|500]]');
  });

  it('generates content for notebooks with only drawings (no highlights)', () => {
    const result = createTestResult([], {
      type: 'notebook',
      visibleName: 'My Notebook',
      hasPdf: false,
    });
    const pageDrawings = new Map<number, string>([
      [1, 'My Notebook_p1.png'],
      [2, 'My Notebook_p2.png'],
    ]);

    const md = renderMarkdown(result, undefined, pageDrawings);

    // Should NOT say "no highlights found" because there are drawings
    expect(md).not.toContain('_No highlights or annotations found');
    expect(md).toContain('### Page 1');
    expect(md).toContain('![[My Notebook_p1.png|500]]');
    expect(md).toContain('### Page 2');
    expect(md).toContain('![[My Notebook_p2.png|500]]');
    expect(md).toContain('source_type: notebook');
  });

  it('shows empty message when document has no highlights and no drawings', () => {
    const result = createTestResult([]);
    const md = renderMarkdown(result, 'Paper.pdf', null);

    expect(md).toContain('_No highlights or annotations found in this document._');
  });
});

describe('OCR handwriting text in markdown output', () => {
  it('renders OCR text as a collapsed callout under the page image', () => {
    const result = createTestResult([], {
      type: 'notebook',
      visibleName: 'My Notebook',
      hasPdf: false,
    });
    const pageDrawings = new Map<number, string>([[1, 'My Notebook_p1.png']]);
    const pageOcr = new Map<number, string>([[1, 'Buy milk\nCall dentist']]);

    const md = renderMarkdown(result, undefined, pageDrawings, undefined, pageOcr);

    // Collapsed by default: the `-` after the callout type.
    expect(md).toContain('> [!note]- Handwriting (OCR)');
    // Text stays searchable and preserves line breaks inside the callout.
    expect(md).toContain('> Buy milk');
    expect(md).toContain('> Call dentist');
    // The callout appears after the page image.
    const imgIdx = md.indexOf('![[My Notebook_p1.png|500]]');
    const ocrIdx = md.indexOf('> [!note]- Handwriting (OCR)');
    expect(imgIdx).toBeGreaterThanOrEqual(0);
    expect(ocrIdx).toBeGreaterThan(imgIdx);
  });

  it('omits the OCR callout entirely when no OCR text is provided', () => {
    const result = createTestResult([], {
      type: 'notebook',
      visibleName: 'My Notebook',
      hasPdf: false,
    });
    const pageDrawings = new Map<number, string>([[1, 'My Notebook_p1.png']]);

    const md = renderMarkdown(result, undefined, pageDrawings, undefined, null);

    expect(md).not.toContain('Handwriting (OCR)');
  });

  it('surfaces a page that has OCR text even without a drawing', () => {
    const result = createTestResult([], {
      type: 'notebook',
      visibleName: 'My Notebook',
      hasPdf: false,
    });
    const pageOcr = new Map<number, string>([[2, 'orphan handwriting']]);

    const md = renderMarkdown(result, undefined, null, undefined, pageOcr);

    expect(md).toContain('### Page 2');
    expect(md).toContain('> orphan handwriting');
  });
});
