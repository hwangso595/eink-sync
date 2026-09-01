/**
 * Regression tests: a page-render failure must NOT wipe an existing note's
 * drawings. renderPageImages is mocked here so we can force the "render failed"
 * (throws) vs "genuinely empty" (returns null) cases independently.
 */

jest.mock('./page-image-renderer', () => ({
  renderPageImages: jest.fn(),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PipelineConfig,
  PipelineDependencies,
  ReMarkableDocument,
  ExtractionResult,
} from './types';
import { runExtractionPipeline } from './extraction-pipeline';
import { renderPageImages } from './page-image-renderer';
import { renderMarkdown, generateOutputFilename, DefaultMarkdownRenderer } from './markdown-renderer';
import { TemplateMarkdownRenderer } from './template-engine';

const mockedRender = renderPageImages as jest.Mock;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rm-renderfail-'));
}

function doc(overrides?: Partial<ReMarkableDocument>): ReMarkableDocument {
  return {
    uuid: 'draw-1',
    visibleName: 'Drawing Doc',
    parentUuid: '',
    type: 'pdf',
    lastModified: 1700000000000,
    pageCount: 1,
    pageUuids: ['p1'],
    hasPdf: true,
    ...overrides,
  };
}

function result(d: ReMarkableDocument, highlights: ExtractionResult['highlights'] = []): ExtractionResult {
  return {
    document: d,
    highlights,
    warnings: [],
    formatDetected: 'v6',
    success: true,
    error: null,
    extractedAt: new Date().toISOString(),
  };
}

function deps(
  d: ReMarkableDocument,
  extractionResults: ExtractionResult[],
  renderer: PipelineDependencies['renderer'] = new DefaultMarkdownRenderer(),
): PipelineDependencies {
  return {
    discovery: { discoverDocuments: async () => [d] },
    extractor: { extractHighlights: async () => extractionResults },
    renderer,
  };
}

describe('page-render failure preservation', () => {
  let xochitlDir: string;
  let outputDir: string;

  beforeEach(() => {
    xochitlDir = tmp();
    outputDir = tmp();
    mockedRender.mockReset();
  });

  afterEach(() => {
    fs.rmSync(xochitlDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
    return {
      xochitlPath: xochitlDir,
      outputPath: outputDir,
      template: null,
      sinceTimestamp: null,
      overwrite: false,
      ...overrides,
    };
  }

  it('preserves an existing note with drawings when the renderer FAILS', async () => {
    const d = doc();
    const notePath = path.join(outputDir, generateOutputFilename(d.visibleName) + '.md');

    // Existing note whose managed section embeds a rendered drawing.
    const drawings = new Map<number, string>([[1, 'draw-1_p1.png']]);
    fs.writeFileSync(notePath, renderMarkdown(result(d, []), 'draw-1.pdf', drawings), 'utf-8');
    expect(fs.readFileSync(notePath, 'utf-8')).toContain('draw-1_p1.png');

    // Re-extract: 0 text highlights, and the page renderer THROWS (e.g. missing
    // render_pages.py) so we cannot re-render the drawings this run.
    mockedRender.mockRejectedValue(new Error('render_pages.py not found'));

    const runResult = await runExtractionPipeline(makeConfig(), deps(d, [result(d, [])]));

    const after = fs.readFileSync(notePath, 'utf-8');
    expect(after).toContain('draw-1_p1.png'); // drawing NOT wiped
    expect(after).not.toContain('_No highlights or annotations found');
    expect(runResult.errors.join(' ')).toContain('page rendering failed');
  });

  it('preserves an existing NOTEBOOK note when the renderer FAILS', async () => {
    const d = doc({ uuid: 'nb-1', visibleName: 'Notebook', type: 'notebook' });
    const notePath = path.join(outputDir, generateOutputFilename(d.visibleName) + '.md');
    const drawings = new Map<number, string>([[1, 'nb-1_p1.png']]);
    fs.writeFileSync(notePath, renderMarkdown(result(d, []), undefined, drawings), 'utf-8');
    expect(fs.readFileSync(notePath, 'utf-8')).toContain('nb-1_p1.png');

    mockedRender.mockRejectedValue(new Error('render_pages.py failed'));
    await runExtractionPipeline(makeConfig(), deps(d, [result(d, [])]));

    expect(fs.readFileSync(notePath, 'utf-8')).toContain('nb-1_p1.png'); // not wiped
  });

  it('updates successful pages and carries only failed-page drawing/OCR forward', async () => {
    const d = doc({ pageCount: 2, pageUuids: ['p1', 'p2'] });
    const notePath = path.join(outputDir, generateOutputFilename(d.visibleName) + '.md');
    const oldHighlights = [
      { text: 'OLD PAGE ONE TEXT', pageNumber: 1, color: null, bounds: null, createdAt: null },
      { text: 'OLD PAGE TWO TEXT', pageNumber: 2, color: null, bounds: null, createdAt: null },
    ];
    const oldDrawings = new Map<number, string>([
      [1, 'Drawing-Doc_p1_1111.png'],
      [2, 'Drawing-Doc_p2_2222.png'],
    ]);
    const oldOcr = new Map<number, string>([
      [1, 'old page one OCR'],
      [2, 'old page two OCR'],
    ]);
    fs.writeFileSync(
      notePath,
      renderMarkdown(result(d, oldHighlights), 'draw-1.pdf', oldDrawings, undefined, oldOcr),
      'utf-8',
    );

    mockedRender.mockResolvedValue({
      pageDrawings: new Map([[1, 'Drawing-Doc_p1_1111111111111111.png']]),
      pageOcr: new Map([[1, 'new page one OCR']]),
      rendererHighlights: [],
      warnings: ['Page 2: malformed scene'],
      failedPageNumbers: [2],
    });
    const freshHighlights = [
      { text: 'NEW PAGE ONE TEXT', pageNumber: 1, color: null, bounds: null, createdAt: null },
      { text: 'NEW PAGE TWO TEXT', pageNumber: 2, color: null, bounds: null, createdAt: null },
    ];

    await runExtractionPipeline(makeConfig(), deps(d, [result(d, freshHighlights)]));

    const after = fs.readFileSync(notePath, 'utf-8');
    expect(after).toContain('Drawing-Doc_p1_1111111111111111.png');
    expect(after).toContain('new page one OCR');
    expect(after).not.toContain('Drawing-Doc_p1_1111.png');
    expect(after).not.toContain('old page one OCR');
    expect(after).toContain('Drawing-Doc_p2_2222.png');
    expect(after).toContain('old page two OCR');
    expect(after).toContain('NEW PAGE ONE TEXT');
    expect(after).toContain('NEW PAGE TWO TEXT');
    expect(after).not.toContain('OLD PAGE ONE TEXT');
    expect(after).not.toContain('OLD PAGE TWO TEXT');
  });

  it('leaves an existing note unchanged when failed-page OCR cannot be associated safely', async () => {
    const d = doc({ pageCount: 2, pageUuids: ['p1', 'p2'] });
    const notePath = path.join(outputDir, generateOutputFilename(d.visibleName) + '.md');
    const unsafe = [
      'Personal preface',
      '<!-- eink-sync:start -->',
      '## Highlights',
      '',
      '> [!note]- Handwriting (OCR)',
      '> page unknown',
      '<!-- eink-sync:end -->',
      'Personal appendix',
    ].join('\n');
    fs.writeFileSync(notePath, unsafe, 'utf-8');
    mockedRender.mockResolvedValue({
      pageDrawings: new Map([[1, 'Drawing-Doc_p1_newhash.png']]),
      pageOcr: new Map<number, string>(),
      rendererHighlights: [],
      warnings: ['Page 2: malformed scene'],
      failedPageNumbers: [2],
    });

    const runResult = await runExtractionPipeline(
      makeConfig(),
      deps(d, [result(d, [
        { text: 'NEW TEXT', pageNumber: 1, color: null, bounds: null, createdAt: null },
      ])]),
    );

    expect(fs.readFileSync(notePath, 'utf-8')).toBe(unsafe);
    expect(runResult.errors.join(' ')).toContain('could not be merged safely');
  });

  it('uses the final page token in a flat drawing filename', async () => {
    const d = doc({ visibleName: 'Report_p2', pageCount: 2, pageUuids: ['p1', 'p2'] });
    const notePath = path.join(outputDir, generateOutputFilename(d.visibleName) + '.md');
    const flatRenderer = new DefaultMarkdownRenderer(undefined, true, false);
    const oldDrawings = new Map<number, string>([
      [1, 'Report_p2_p1_abcd.png'],
      [2, 'Report_p2_p2_abcd.png'],
    ]);
    fs.writeFileSync(
      notePath,
      flatRenderer.render(result(d), 'draw-1.pdf', oldDrawings),
      'utf-8',
    );

    mockedRender.mockResolvedValue({
      pageDrawings: new Map([[2, 'Report_p2_p2_2222222222222222.png']]),
      pageOcr: new Map<number, string>(),
      rendererHighlights: [],
      warnings: ['Page 1: malformed scene'],
      failedPageNumbers: [1],
    });

    await runExtractionPipeline(
      makeConfig({ groupByPage: false }),
      deps(d, [result(d)], flatRenderer),
    );

    const after = fs.readFileSync(notePath, 'utf-8');
    expect(after).toContain('Report_p2_p1_abcd.png');
    expect(after).toContain('Report_p2_p2_2222222222222222.png');
    expect(after).not.toContain('Report_p2_p2_abcd.png');
  });

  it('leaves custom-template notes unchanged after a partial render', async () => {
    const d = doc({ pageCount: 2, pageUuids: ['p1', 'p2'] });
    const notePath = path.join(outputDir, generateOutputFilename(d.visibleName) + '.md');
    const template = [
      '<!-- eink-sync:start -->',
      '{{#each pages}}',
      '### Page {{page_number}}',
      '{{#if annotation}}![[{{annotation}}|500]]{{/if}}',
      '{{#if ocr}}{{ocr}}{{/if}}',
      '{{/each_pages}}',
      '<!-- eink-sync:end -->',
    ].join('\n');
    const templateRenderer = new TemplateMarkdownRenderer(template);
    const original = templateRenderer.render(
      result(d),
      'draw-1.pdf',
      new Map([[1, 'Drawing-Doc_p1_1111.png'], [2, 'Drawing-Doc_p2_2222.png']]),
      new Map([[1, 'old page one OCR'], [2, 'old page two OCR']]),
    );
    fs.writeFileSync(notePath, original, 'utf-8');

    mockedRender.mockResolvedValue({
      pageDrawings: new Map([[1, 'Drawing-Doc_p1_1111111111111111.png']]),
      pageOcr: new Map([[1, 'new page one OCR']]),
      rendererHighlights: [],
      warnings: ['Page 2: malformed scene'],
      failedPageNumbers: [2],
    });

    const runResult = await runExtractionPipeline(
      makeConfig({ template }),
      deps(d, [result(d)], templateRenderer),
    );

    expect(fs.readFileSync(notePath, 'utf-8')).toBe(original);
    expect(runResult.errors.join(' ')).toContain('could not be merged safely');
  });

  it('surfaces a render failure for a brand-new note (not silent)', async () => {
    const d = doc();
    mockedRender.mockRejectedValue(new Error('render_pages.py not found'));

    const runResult = await runExtractionPipeline(
      makeConfig(),
      deps(d, [result(d, [{ text: 'some text', pageNumber: 1, color: null, bounds: null, createdAt: null }])]),
    );

    expect(runResult.errors.join(' ')).toContain('page rendering failed');
  });

  it('still clears an existing note when the renderer SUCCEEDS but nothing remains', async () => {
    const d = doc();
    const notePath = path.join(outputDir, generateOutputFilename(d.visibleName) + '.md');

    // Existing note with an old text highlight.
    const old = renderMarkdown(
      result(d, [{ text: 'OLD', pageNumber: 1, color: null, bounds: null, createdAt: null }]),
      'draw-1.pdf',
    );
    fs.writeFileSync(notePath, old, 'utf-8');

    // Render succeeds with nothing to draw (legitimate empty), 0 text highlights.
    mockedRender.mockResolvedValue(null);

    await runExtractionPipeline(makeConfig(), deps(d, [result(d, [])]));

    const after = fs.readFileSync(notePath, 'utf-8');
    expect(after).not.toContain('OLD');
    expect(after).toContain('_No highlights or annotations found');
  });
});
