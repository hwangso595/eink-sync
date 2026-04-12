/**
 * Tests for the template engine.
 */

import {
  renderTemplate,
  buildTemplateContext,
  formatPdfLink,
  validateTemplate,
  TemplateMarkdownRenderer,
  DEFAULT_TEMPLATE,
} from './template-engine';
import type { TemplateContext } from './template-engine';
import type { ExtractionResult, ExtractedHighlight } from './types';

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function makeHighlight(overrides: Partial<ExtractedHighlight> = {}): ExtractedHighlight {
  return {
    text: 'Test highlight text',
    pageNumber: 1,
    color: 'yellow',
    bounds: null,
    createdAt: null,
    ...overrides,
  };
}

function makeExtractionResult(
  highlights: ExtractedHighlight[] = [makeHighlight()],
): ExtractionResult {
  return {
    document: {
      uuid: 'test-uuid-123',
      visibleName: 'Test Document',
      parentUuid: '',
      type: 'pdf',
      lastModified: Date.now(),
      pageCount: 10,
      pageUuids: [],
      hasPdf: true,
    },
    highlights,
    warnings: [],
    formatDetected: 'v6',
    success: true,
    error: null,
    extractedAt: new Date().toISOString(),
  };
}

function makeContext(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    title: 'Test Document',
    author: 'John Doe',
    date: '2026-03-28',
    source_pdf: 'Test Document.pdf',
    source_type: 'pdf',
    uuid: 'test-uuid-123',
    highlight_count: 2,
    tags: ['remarkable', 'highlights'],
    annotations: '',
    _pages: [],
    source: '',
    highlights: [
      {
        text: 'First highlight',
        page: 1,
        color: 'yellow',
        pdf_link: '[[Test Document.pdf#page=1|Page 1]]',
        created_at: '2026-03-28',
      },
      {
        text: 'Second highlight',
        page: 3,
        color: 'blue',
        pdf_link: '[[Test Document.pdf#page=3|Page 3]]',
        created_at: '2026-03-28',
      },
    ],
    ...overrides,
  };
}

// -------------------------------------------------------------------
// formatPdfLink
// -------------------------------------------------------------------

describe('formatPdfLink', () => {
  it('should format PDF++ links correctly', () => {
    const result = formatPdfLink('doc.pdf', 5, 'pdfpp');
    expect(result).toBe('[[doc.pdf#page=5|Page 5]]');
  });

  it('should format Obsidian built-in links correctly', () => {
    const result = formatPdfLink('doc.pdf', 5, 'obsidian');
    expect(result).toBe('[[doc.pdf#page5|Page 5]]');
  });

  it('should format plain text when format is none', () => {
    const result = formatPdfLink('doc.pdf', 5, 'none');
    expect(result).toBe('Page 5');
  });
});

// -------------------------------------------------------------------
// buildTemplateContext
// -------------------------------------------------------------------

describe('buildTemplateContext', () => {
  it('should build context from extraction result', () => {
    const result = makeExtractionResult([
      makeHighlight({ text: 'Hello world', pageNumber: 3 }),
    ]);

    const ctx = buildTemplateContext(
      result,
      'Test Document.pdf',
      'pdfpp',
      ['test'],
      'Author Name',
    );

    expect(ctx.title).toBe('Test Document');
    expect(ctx.author).toBe('Author Name');
    expect(ctx.source_pdf).toBe('Test Document.pdf');
    expect(ctx.uuid).toBe('test-uuid-123');
    expect(ctx.highlight_count).toBe(1);
    expect(ctx.tags).toEqual(['test']);
    expect(ctx.highlights).toHaveLength(1);
    expect(ctx.highlights[0].text).toBe('Hello world');
    expect(ctx.highlights[0].page).toBe(3);
    expect(ctx.highlights[0].pdf_link).toBe('[[Test Document.pdf#page=3|Page 3]]');
  });

  it('should use "Unknown" author when not provided', () => {
    const result = makeExtractionResult();
    const ctx = buildTemplateContext(result, 'doc.pdf', 'pdfpp', []);
    expect(ctx.author).toBe('Unknown');
  });
});

// -------------------------------------------------------------------
// renderTemplate -- simple substitution
// -------------------------------------------------------------------

describe('renderTemplate', () => {
  it('should substitute simple variables', () => {
    const template = 'Title: {{title}}, Author: {{author}}, Date: {{date}}';
    const ctx = makeContext();
    const result = renderTemplate(template, ctx);
    expect(result).toBe('Title: Test Document, Author: John Doe, Date: 2026-03-28');
  });

  it('should substitute uuid and highlight_count', () => {
    const template = 'UUID: {{uuid}}, Count: {{highlight_count}}';
    const ctx = makeContext();
    const result = renderTemplate(template, ctx);
    expect(result).toBe('UUID: test-uuid-123, Count: 2');
  });

  it('should render tags_yaml as YAML list', () => {
    const template = 'tags:\n{{tags_yaml}}';
    const ctx = makeContext();
    const result = renderTemplate(template, ctx);
    expect(result).toBe('tags:\n  - remarkable\n  - highlights');
  });

  it('should render empty tags_yaml as empty array', () => {
    const template = 'tags: {{tags_yaml}}';
    const ctx = makeContext({ tags: [] });
    const result = renderTemplate(template, ctx);
    expect(result).toBe('tags: []');
  });

  it('should render tags_inline as comma-separated', () => {
    const template = 'Tags: {{tags_inline}}';
    const ctx = makeContext();
    const result = renderTemplate(template, ctx);
    expect(result).toBe('Tags: remarkable, highlights');
  });

  it('should render tags_hashtags', () => {
    const template = '{{tags_hashtags}}';
    const ctx = makeContext();
    const result = renderTemplate(template, ctx);
    expect(result).toBe('#remarkable #highlights');
  });
});

// -------------------------------------------------------------------
// renderTemplate -- each blocks
// -------------------------------------------------------------------

describe('renderTemplate - each blocks', () => {
  it('should render highlights in an each block', () => {
    const template = '{{#each highlights}}> {{text}} (p{{page}})\n{{/each}}';
    const ctx = makeContext();
    const result = renderTemplate(template, ctx);
    expect(result).toContain('> First highlight (p1)');
    expect(result).toContain('> Second highlight (p3)');
  });

  it('should render "no highlights" message when empty', () => {
    const template = '{{#each highlights}}> {{text}}{{/each}}';
    const ctx = makeContext({ highlights: [] });
    const result = renderTemplate(template, ctx);
    expect(result).toContain('No highlights found');
  });

  it('should provide index variable', () => {
    const template = '{{#each highlights}}{{index}}. {{text}}\n{{/each}}';
    const ctx = makeContext();
    const result = renderTemplate(template, ctx);
    expect(result).toContain('1. First highlight');
    expect(result).toContain('2. Second highlight');
  });

  it('should render color and pdf_link within each block', () => {
    const template = '{{#each highlights}}{{color}} {{pdf_link}}\n{{/each}}';
    const ctx = makeContext();
    const result = renderTemplate(template, ctx);
    expect(result).toContain('yellow [[Test Document.pdf#page=1|Page 1]]');
    expect(result).toContain('blue [[Test Document.pdf#page=3|Page 3]]');
  });
});

// -------------------------------------------------------------------
// renderTemplate -- if blocks
// -------------------------------------------------------------------

describe('renderTemplate - if blocks', () => {
  it('should render if block when condition is truthy', () => {
    const template = '{{#if highlights}}Has highlights{{/if}}';
    const ctx = makeContext();
    const result = renderTemplate(template, ctx);
    expect(result).toBe('Has highlights');
  });

  it('should not render if block when condition is falsy', () => {
    const template = '{{#if highlights}}Has highlights{{/if}}';
    const ctx = makeContext({ highlights: [] });
    const result = renderTemplate(template, ctx);
    expect(result).toBe('');
  });

  it('should handle author if block', () => {
    const template = '{{#if author}}By {{author}}{{/if}}';
    const ctx = makeContext({ author: 'Unknown' });
    const result = renderTemplate(template, ctx);
    expect(result).toBe('');
  });

  it('should render author if block when author is known', () => {
    const template = '{{#if author}}By {{author}}{{/if}}';
    const ctx = makeContext({ author: 'Jane Smith' });
    const result = renderTemplate(template, ctx);
    expect(result).toBe('By Jane Smith');
  });

  it('should handle tags if block', () => {
    const template = '{{#if tags}}Has tags{{/if}}';
    const ctx = makeContext({ tags: [] });
    const result = renderTemplate(template, ctx);
    expect(result).toBe('');
  });
});

// -------------------------------------------------------------------
// validateTemplate
// -------------------------------------------------------------------

describe('validateTemplate', () => {
  it('should pass validation for the default template', () => {
    const result = validateTemplate(DEFAULT_TEMPLATE);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('should warn about missing title', () => {
    const template = '{{#each highlights}}{{text}}{{/each}}';
    const result = validateTemplate(template);
    expect(result.valid).toBe(false);
    expect(result.warnings).toContain('Template is missing {{title}} variable.');
  });

  it('should warn about missing each block', () => {
    const template = '# {{title}}';
    const result = validateTemplate(template);
    expect(result.warnings.some((w) => w.includes('each highlights'))).toBe(true);
  });

  it('should warn about missing highlight markers', () => {
    const template = '# {{title}}\n{{#each highlights}}{{text}}{{/each}}';
    const result = validateTemplate(template);
    expect(result.warnings.some((w) => w.includes('markers'))).toBe(true);
  });
});

// -------------------------------------------------------------------
// TemplateMarkdownRenderer
// -------------------------------------------------------------------

describe('TemplateMarkdownRenderer', () => {
  it('should render a complete note from the default template', () => {
    const renderer = new TemplateMarkdownRenderer(DEFAULT_TEMPLATE, 'pdfpp', ['test']);
    const result = makeExtractionResult([
      makeHighlight({ text: 'Important finding', pageNumber: 5 }),
    ]);

    const output = renderer.render(result, 'Test Document.pdf');

    expect(output).toContain('title: "Test Document"');
    expect(output).toContain('source_pdf: "[[Test Document.pdf]]"');
    expect(output).toContain('highlight_count: 1');
    expect(output).toContain('> Important finding');
    expect(output).toContain('[[Test Document.pdf#page=5|Page 5]]');
    expect(output).toContain('remarkable-bridge:start');
    expect(output).toContain('remarkable-bridge:end');
  });

  // -----------------------------------------------------------------
  // Regression tests: note preservation
  // -----------------------------------------------------------------

  it('should preserve empty notes (no user content) after merge', () => {
    // Regression: Empty <!-- notes --> blocks were being collapsed or removed
    const renderer = new TemplateMarkdownRenderer(DEFAULT_TEMPLATE, 'pdfpp', []);
    const result = makeExtractionResult([
      makeHighlight({ text: 'Highlight A', pageNumber: 1 }),
    ]);

    const existing = [
      '---',
      'title: "Test"',
      'highlight_count: 1',
      '---',
      '',
      '<!-- remarkable-bridge:start -->',
      '### Page 1',
      '',
      '> Highlight A',
      '> -- [[Test.pdf#page=1|Page 1]]',
      '<!-- notes -->',
      '<!-- /notes -->',
      '',
      '<!-- remarkable-bridge:end -->',
    ].join('\n');

    const merged = renderer.mergeWithExisting(existing, result, 'Test.pdf');

    // Empty notes blocks should still be present
    expect(merged).toContain('<!-- notes -->');
    expect(merged).toContain('<!-- /notes -->');
  });

  it('should preserve notes with user content after merge', () => {
    // Regression: User notes between <!-- notes --> markers were lost on re-extraction
    const renderer = new TemplateMarkdownRenderer(DEFAULT_TEMPLATE, 'pdfpp', []);
    const result = makeExtractionResult([
      makeHighlight({ text: 'Updated highlight', pageNumber: 1 }),
    ]);

    const existing = [
      '---',
      'title: "Test"',
      'highlight_count: 1',
      '---',
      '',
      '<!-- remarkable-bridge:start -->',
      '### Page 1',
      '',
      '> Old highlight',
      '> -- [[Test.pdf#page=1|Page 1]]',
      '<!-- notes -->',
      'My important thought about this passage.',
      '<!-- /notes -->',
      '',
      '<!-- remarkable-bridge:end -->',
    ].join('\n');

    const merged = renderer.mergeWithExisting(existing, result, 'Test.pdf');

    // User note content must survive the merge
    expect(merged).toContain('My important thought about this passage.');
  });

  it('should preserve multiple notes across pages positionally', () => {
    // Regression: Notes for different pages were mixed up or lost
    const renderer = new TemplateMarkdownRenderer(DEFAULT_TEMPLATE, 'pdfpp', []);
    const result = makeExtractionResult([
      makeHighlight({ text: 'Highlight 1', pageNumber: 1 }),
      makeHighlight({ text: 'Highlight 2', pageNumber: 2 }),
    ]);

    const existing = [
      '---',
      'title: "Test"',
      'highlight_count: 2',
      '---',
      '',
      '<!-- remarkable-bridge:start -->',
      '### Page 1',
      '',
      '> Highlight 1',
      '> -- [[Test.pdf#page=1|Page 1]]',
      '<!-- notes -->',
      'Note for page 1 highlight',
      '<!-- /notes -->',
      '',
      '### Page 2',
      '',
      '> Highlight 2',
      '> -- [[Test.pdf#page=2|Page 2]]',
      '<!-- notes -->',
      'Note for page 2 highlight',
      '<!-- /notes -->',
      '',
      '<!-- remarkable-bridge:end -->',
    ].join('\n');

    const merged = renderer.mergeWithExisting(existing, result, 'Test.pdf');

    // Both notes must be preserved in their correct positions
    expect(merged).toContain('Note for page 1 highlight');
    expect(merged).toContain('Note for page 2 highlight');

    // Verify positional ordering: page 1 note comes before page 2 note
    const idx1 = merged.indexOf('Note for page 1 highlight');
    const idx2 = merged.indexOf('Note for page 2 highlight');
    expect(idx1).toBeLessThan(idx2);
  });

  it('should merge with existing content', () => {
    const renderer = new TemplateMarkdownRenderer(DEFAULT_TEMPLATE, 'pdfpp', ['test']);

    const existing = [
      '---',
      'title: "Test Document"',
      'highlight_count: 1',
      '---',
      '',
      '# Test Document',
      '',
      '<!-- remarkable-bridge:start -->',
      '## Highlights',
      '',
      '> Old highlight',
      '> -- [[Test Document.pdf#page=1|Page 1]]',
      '',
      '<!-- remarkable-bridge:end -->',
      '',
      '## My Notes',
      'This is my personal note.',
    ].join('\n');

    const result = makeExtractionResult([
      makeHighlight({ text: 'New highlight', pageNumber: 2 }),
    ]);

    const merged = renderer.mergeWithExisting(existing, result, 'Test Document.pdf');

    expect(merged).toContain('> New highlight');
    expect(merged).toContain('## My Notes');
    expect(merged).toContain('This is my personal note.');
    expect(merged).toContain('highlight_count: 1');
  });
});
