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

function deps(d: ReMarkableDocument, extractionResults: ExtractionResult[]): PipelineDependencies {
  return {
    discovery: { discoverDocuments: async () => [d] },
    extractor: { extractHighlights: async () => extractionResults },
    renderer: new DefaultMarkdownRenderer(),
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
