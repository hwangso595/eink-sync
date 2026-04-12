/**
 * Tests for notebook-renderer.ts -- markdown generation for notebook documents.
 *
 * Tests cover:
 * - Frontmatter generation with notebook-specific fields
 * - Page structure with embedded SVG images
 * - Blank page handling
 * - Error/warning propagation
 * - PDF annotation image rendering
 * - YAML escaping
 */

import {
  renderNotebookMarkdown,
  renderPdfAnnotationImage,
} from './notebook-renderer';
import type { NotebookRenderConfig, NotebookRenderResult } from './notebook-renderer';
import type { StrokeRenderOutput, RenderedPage } from './stroke-renderer-bridge';
import type { ReMarkableDocument } from './types';

function makeDocument(overrides?: Partial<ReMarkableDocument>): ReMarkableDocument {
  return {
    uuid: 'test-uuid-123',
    visibleName: 'My Notebook',
    parentUuid: '',
    type: 'notebook',
    lastModified: Date.now(),
    pageCount: 3,
    pageUuids: ['page-1', 'page-2', 'page-3'],
    hasPdf: false,
    ...overrides,
  };
}

function makeRenderOutput(overrides?: Partial<StrokeRenderOutput>): StrokeRenderOutput {
  return {
    success: true,
    docType: 'notebook',
    visibleName: 'My Notebook',
    errors: [],
    pages: [
      {
        pageIndex: 0,
        pageUuid: 'page-1',
        svgPath: '/output/page-1.svg',
        hasStrokes: true,
        strokeCount: 25,
      },
      {
        pageIndex: 1,
        pageUuid: 'page-2',
        svgPath: null,
        hasStrokes: false,
        strokeCount: 0,
      },
      {
        pageIndex: 2,
        pageUuid: 'page-3',
        svgPath: '/output/page-3.svg',
        hasStrokes: true,
        strokeCount: 10,
      },
    ],
    ...overrides,
  };
}

const defaultConfig: NotebookRenderConfig = {
  attachmentsFolder: 'ReMarkable/attachments',
  outputFolder: 'ReMarkable',
};

describe('renderNotebookMarkdown', () => {
  it('generates frontmatter with notebook-specific fields', () => {
    const result = renderNotebookMarkdown(
      makeDocument(),
      makeRenderOutput(),
      defaultConfig,
    );

    expect(result.markdownContent).toContain('---');
    expect(result.markdownContent).toContain('title: "My Notebook"');
    expect(result.markdownContent).toContain('source_type: notebook');
    expect(result.markdownContent).toContain('page_count: 3');
    expect(result.markdownContent).toContain('pages_with_content: 2');
    expect(result.markdownContent).toContain('remarkable_uuid: test-uuid-123');
    expect(result.markdownContent).toContain('  - remarkable');
    expect(result.markdownContent).toContain('  - notebook');
  });

  it('generates heading with notebook name', () => {
    const result = renderNotebookMarkdown(
      makeDocument(),
      makeRenderOutput(),
      defaultConfig,
    );

    expect(result.markdownContent).toContain('# My Notebook');
  });

  it('embeds SVG images for pages with strokes', () => {
    const result = renderNotebookMarkdown(
      makeDocument(),
      makeRenderOutput(),
      defaultConfig,
    );

    expect(result.markdownContent).toContain(
      '![[ReMarkable/attachments/My Notebook/page-1.svg]]',
    );
    expect(result.markdownContent).toContain(
      '![[ReMarkable/attachments/My Notebook/page-3.svg]]',
    );
  });

  it('marks blank pages', () => {
    const result = renderNotebookMarkdown(
      makeDocument(),
      makeRenderOutput(),
      defaultConfig,
    );

    expect(result.markdownContent).toContain('_Blank page_');
  });

  it('shows stroke count for rendered pages', () => {
    const result = renderNotebookMarkdown(
      makeDocument(),
      makeRenderOutput(),
      defaultConfig,
    );

    expect(result.markdownContent).toContain('*25 strokes*');
    expect(result.markdownContent).toContain('*10 strokes*');
  });

  it('returns correct SVG paths', () => {
    const result = renderNotebookMarkdown(
      makeDocument(),
      makeRenderOutput(),
      defaultConfig,
    );

    expect(result.svgPaths).toHaveLength(2);
    expect(result.svgPaths[0]).toBe('ReMarkable/attachments/My Notebook/page-1.svg');
    expect(result.svgPaths[1]).toBe('ReMarkable/attachments/My Notebook/page-3.svg');
  });

  it('returns correct page counts', () => {
    const result = renderNotebookMarkdown(
      makeDocument(),
      makeRenderOutput(),
      defaultConfig,
    );

    expect(result.pagesWithStrokes).toBe(2);
    expect(result.totalPages).toBe(3);
  });

  it('generates correct markdown path', () => {
    const result = renderNotebookMarkdown(
      makeDocument(),
      makeRenderOutput(),
      defaultConfig,
    );

    expect(result.markdownPath).toBe('ReMarkable/My Notebook.md');
  });

  it('handles documents with no pages', () => {
    const result = renderNotebookMarkdown(
      makeDocument({ pageCount: 0 }),
      makeRenderOutput({ pages: [] }),
      defaultConfig,
    );

    expect(result.markdownContent).toContain('_This notebook has no pages._');
    expect(result.svgPaths).toHaveLength(0);
    expect(result.pagesWithStrokes).toBe(0);
  });

  it('propagates page-level errors', () => {
    const output = makeRenderOutput();
    output.pages[1] = {
      ...output.pages[1],
      error: 'Unsupported format',
    };

    const result = renderNotebookMarkdown(
      makeDocument(),
      output,
      defaultConfig,
    );

    expect(result.markdownContent).toContain('[!warning] Rendering error');
    expect(result.markdownContent).toContain('Unsupported format');
    expect(result.warnings).toContain('Page 2: Unsupported format');
  });

  it('propagates document-level errors', () => {
    const output = makeRenderOutput({
      errors: ['Failed to read .content file'],
    });

    const result = renderNotebookMarkdown(
      makeDocument(),
      output,
      defaultConfig,
    );

    expect(result.markdownContent).toContain('## Rendering Notes');
    expect(result.markdownContent).toContain('Failed to read .content file');
    expect(result.warnings).toContain('Failed to read .content file');
  });

  it('escapes YAML special characters in title', () => {
    const result = renderNotebookMarkdown(
      makeDocument({ visibleName: 'Notes "with" quotes' }),
      makeRenderOutput({ visibleName: 'Notes "with" quotes' }),
      defaultConfig,
    );

    expect(result.markdownContent).toContain('title: "Notes \\"with\\" quotes"');
  });

  it('sanitizes filename for attachments path', () => {
    const result = renderNotebookMarkdown(
      makeDocument({ visibleName: 'File: with <invalid> chars?' }),
      makeRenderOutput(),
      defaultConfig,
    );

    // generateOutputFilename removes invalid chars
    expect(result.markdownPath).not.toContain(':');
    expect(result.markdownPath).not.toContain('<');
    expect(result.markdownPath).not.toContain('>');
    expect(result.markdownPath).not.toContain('?');
  });
});

describe('renderPdfAnnotationImage', () => {
  it('returns empty string for page without strokes', () => {
    const page: RenderedPage = {
      pageIndex: 0,
      pageUuid: 'p1',
      svgPath: null,
      hasStrokes: false,
      strokeCount: 0,
    };

    expect(renderPdfAnnotationImage(page, 'attachments', 'MyPdf')).toBe('');
  });

  it('generates annotation callout for page with strokes', () => {
    const page: RenderedPage = {
      pageIndex: 2,
      pageUuid: 'p3',
      svgPath: '/output/page-3.svg',
      hasStrokes: true,
      strokeCount: 8,
    };

    const markdown = renderPdfAnnotationImage(page, 'attachments', 'MyPdf');
    expect(markdown).toContain('[!note] Handwritten annotations');
    expect(markdown).toContain('![[attachments/MyPdf/page-3-annotations.svg]]');
  });

  it('uses 1-indexed page number in filename', () => {
    const page: RenderedPage = {
      pageIndex: 0,
      pageUuid: 'p1',
      svgPath: '/output/page-1.svg',
      hasStrokes: true,
      strokeCount: 5,
    };

    const markdown = renderPdfAnnotationImage(page, 'att', 'doc');
    expect(markdown).toContain('page-1-annotations.svg');
  });
});
