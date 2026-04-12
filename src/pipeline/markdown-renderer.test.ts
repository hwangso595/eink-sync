/**
 * Tests for markdown-renderer.ts -- highlight rendering, frontmatter generation,
 * PDF++ link formatting, and incremental update merging.
 */

import {
  renderMarkdown,
  mergeWithExistingNote,
  generateOutputFilename,
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
