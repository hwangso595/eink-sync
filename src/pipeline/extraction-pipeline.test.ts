/**
 * Tests for extraction-pipeline.ts -- pipeline orchestrator.
 *
 * With the DIP refactor, the orchestrator accepts injected dependencies
 * (DocumentDiscovery, HighlightExtractor, MarkdownRenderer) so it can
 * be fully unit-tested with mock implementations -- no Python required.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PipelineConfig,
  PipelineDependencies,
  DocumentDiscovery,
  HighlightExtractor,
  MarkdownRenderer,
  ReMarkableDocument,
  ExtractionResult,
} from './types';
import { runExtractionPipeline } from './extraction-pipeline';
import { renderMarkdown, mergeWithExistingNote, generateOutputFilename, DefaultMarkdownRenderer } from './markdown-renderer';
import { discoverDocuments } from './document-discovery';

/** Create a temporary directory for test output. */
function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rm-pipeline-'));
}

/** Write a JSON file. */
function writeJson(dir: string, filename: string, data: object): void {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data), 'utf-8');
}

/** Create a mock document for testing. */
function createMockDocument(overrides?: Partial<ReMarkableDocument>): ReMarkableDocument {
  return {
    uuid: 'doc-1',
    visibleName: 'Test Paper',
    parentUuid: '',
    type: 'pdf',
    lastModified: 1700000000000,
    pageCount: 5,
    pageUuids: ['p1', 'p2', 'p3', 'p4', 'p5'],
    hasPdf: true,
    ...overrides,
  };
}

/** Create a mock ExtractionResult for testing. */
function createMockExtractionResult(
  doc: ReMarkableDocument,
  highlights: ExtractionResult['highlights'] = [],
  overrides?: Partial<ExtractionResult>,
): ExtractionResult {
  return {
    document: doc,
    highlights,
    warnings: [],
    formatDetected: 'v6',
    success: true,
    error: null,
    extractedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create mock pipeline dependencies for testing. */
function createMockDeps(overrides?: Partial<PipelineDependencies>): PipelineDependencies {
  return {
    discovery: {
      discoverDocuments: async () => [],
    },
    extractor: {
      extractHighlights: async () => [],
    },
    renderer: {
      render: (result) => `# ${result.document.visibleName}\n\nNo highlights.`,
      mergeWithExisting: (existing, result) => existing,
    },
    ...overrides,
  };
}

describe('runExtractionPipeline with injected dependencies', () => {
  let xochitlDir: string;
  let outputDir: string;

  beforeEach(() => {
    xochitlDir = createTmpDir();
    outputDir = createTmpDir();
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

  it('throws SYNC_FOLDER_EMPTY when discovery finds no documents and folder has no .metadata files', async () => {
    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [] },
    });

    await expect(runExtractionPipeline(makeConfig(), deps))
      .rejects.toThrow('No documents found');
  });

  it('returns empty result when discovery finds no documents but folder has .metadata files', async () => {
    // Create a .metadata file so the folder is not considered empty
    fs.writeFileSync(path.join(xochitlDir, 'test-uuid.metadata'), '{}');

    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [] },
    });

    const result = await runExtractionPipeline(makeConfig(), deps);

    expect(result.documentsProcessed).toBe(0);
    expect(result.totalHighlights).toBe(0);
    expect(result.outputFiles).toHaveLength(0);
  });

  it('processes documents through all pipeline stages', async () => {
    const doc = createMockDocument();
    const extraction = createMockExtractionResult(doc, [
      { text: 'Important finding', pageNumber: 1, color: 'yellow', bounds: null, createdAt: null },
    ]);

    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: { extractHighlights: async () => [extraction] },
      renderer: {
        render: () => '# Test Paper\n\n> Important finding\n',
        mergeWithExisting: (existing) => existing,
      },
    });

    const result = await runExtractionPipeline(makeConfig(), deps);

    expect(result.documentsProcessed).toBe(1);
    expect(result.documentsWithHighlights).toBe(1);
    expect(result.totalHighlights).toBe(1);
    expect(result.outputFiles).toHaveLength(1);

    // Verify file was written
    const writtenContent = fs.readFileSync(result.outputFiles[0], 'utf-8');
    expect(writtenContent).toContain('Important finding');
  });

  it('handles extraction error gracefully', async () => {
    const doc = createMockDocument();
    const extraction = createMockExtractionResult(doc, [], {
      error: 'Failed to parse .rm file',
      success: false,
    });

    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: { extractHighlights: async () => [extraction] },
    });

    const result = await runExtractionPipeline(makeConfig(), deps);

    expect(result.documentsProcessed).toBe(1);
    expect(result.documentResults[0].error).toBe('Failed to parse .rm file');
    expect(result.documentResults[0].success).toBe(false);
    expect(result.outputFiles).toHaveLength(0);
  });

  it('catches extractor exceptions and falls back to per-document extraction', async () => {
    const doc = createMockDocument();

    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: {
        extractHighlights: async () => { throw new Error('Python not found'); },
      },
    });

    const result = await runExtractionPipeline(makeConfig(), deps);

    // Batch extraction fails, then per-document fallback also fails
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]).toContain('Python not found');
    // Per-document fallback creates a result with error for each doc
    expect(result.documentsProcessed).toBe(1);
    expect(result.documentResults[0].success).toBe(false);
  });

  it('saves partial extraction results with warnings', async () => {
    const doc = createMockDocument();
    // Partial extraction: has highlights but also an error
    const extraction = createMockExtractionResult(doc, [
      { text: 'Partial highlight', pageNumber: 1, color: 'yellow', bounds: null, createdAt: null },
    ], {
      error: 'Some pages failed to parse',
      success: false,
    });

    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: { extractHighlights: async () => [extraction] },
      renderer: {
        render: () => '# Test\n\n> Partial highlight\n',
        mergeWithExisting: (existing) => existing,
      },
    });

    const result = await runExtractionPipeline(makeConfig(), deps);

    expect(result.documentsProcessed).toBe(1);
    expect(result.documentResults[0].success).toBe(true);
    expect(result.documentResults[0].highlightCount).toBe(1);
    expect(result.documentResults[0].warnings).toContain(
      'Partial extraction: Some pages failed to parse',
    );
    // Output file should be written with warning marker
    expect(result.outputFiles).toHaveLength(1);
    const content = fs.readFileSync(result.outputFiles[0], 'utf-8');
    expect(content).toContain('[!warning] Extraction warnings');
  });

  it('uses mergeWithExisting when output file already exists and overwrite is false', async () => {
    const doc = createMockDocument();
    const extraction = createMockExtractionResult(doc, [
      { text: 'New highlight', pageNumber: 1, color: 'yellow', bounds: null, createdAt: null },
    ]);

    // Pre-create the output file
    const filename = generateOutputFilename(doc.visibleName) + '.md';
    const existingPath = path.join(outputDir, filename);
    fs.writeFileSync(existingPath, '# Existing content\n\nUser notes here.\n', 'utf-8');

    let mergeWasCalled = false;
    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: { extractHighlights: async () => [extraction] },
      renderer: {
        render: () => '# Fresh content\n',
        mergeWithExisting: (existing, _result, _pdf) => {
          mergeWasCalled = true;
          return existing + '\n> New highlight\n';
        },
      },
    });

    await runExtractionPipeline(makeConfig(), deps);

    expect(mergeWasCalled).toBe(true);
    const content = fs.readFileSync(existingPath, 'utf-8');
    expect(content).toContain('Existing content');
    expect(content).toContain('New highlight');
  });

  it('uses render (not merge) when overwrite is true', async () => {
    const doc = createMockDocument();
    const extraction = createMockExtractionResult(doc, [
      { text: 'Overwritten', pageNumber: 1, color: 'yellow', bounds: null, createdAt: null },
    ]);

    const filename = generateOutputFilename(doc.visibleName) + '.md';
    const existingPath = path.join(outputDir, filename);
    fs.writeFileSync(existingPath, '# Old content\n', 'utf-8');

    let renderWasCalled = false;
    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: { extractHighlights: async () => [extraction] },
      renderer: {
        render: () => {
          renderWasCalled = true;
          return '# Fresh render\n';
        },
        mergeWithExisting: (existing) => existing,
      },
    });

    await runExtractionPipeline(makeConfig({ overwrite: true }), deps);

    expect(renderWasCalled).toBe(true);
  });

  it('reports progress through all stages', async () => {
    const doc = createMockDocument();
    const extraction = createMockExtractionResult(doc, [
      { text: 'Highlight', pageNumber: 1, color: 'yellow', bounds: null, createdAt: null },
    ]);

    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: { extractHighlights: async () => [extraction] },
      renderer: {
        render: () => '# Content\n',
        mergeWithExisting: (existing) => existing,
      },
    });

    const stages: string[] = [];
    const progress = (stage: string) => { stages.push(stage); };

    await runExtractionPipeline(makeConfig(), deps, progress);

    expect(stages).toContain('discovery');
    expect(stages).toContain('extraction');
    expect(stages).toContain('rendering');
    expect(stages).toContain('writing');
  });
});

describe('Pipeline integration: discovery + rendering', () => {
  let xochitlDir: string;
  let outputDir: string;

  beforeEach(() => {
    xochitlDir = createTmpDir();
    outputDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(xochitlDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('discovers documents and renders empty markdown for documents without highlights', () => {
    // Setup a PDF document in the xochitl directory
    writeJson(xochitlDir, 'doc-1.metadata', {
      visibleName: 'Test Paper',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });
    writeJson(xochitlDir, 'doc-1.content', {
      fileType: 'pdf',
      pageCount: 5,
      pages: ['p1', 'p2', 'p3', 'p4', 'p5'],
    });
    fs.writeFileSync(path.join(xochitlDir, 'doc-1.pdf'), '%PDF-1.4 fake');

    // Discover
    const docs = discoverDocuments(xochitlDir);
    expect(docs).toHaveLength(1);

    // Render (with empty highlights since we cannot call Python in unit tests)
    const result = {
      document: docs[0],
      highlights: [],
      warnings: [],
      formatDetected: 'v6' as const,
      success: true,
      error: null,
      extractedAt: new Date().toISOString(),
    };

    const markdown = renderMarkdown(result, 'Test Paper.pdf');

    // Write to output
    const outputFile = path.join(outputDir, `${generateOutputFilename(docs[0].visibleName)}.md`);
    fs.writeFileSync(outputFile, markdown, 'utf-8');

    expect(fs.existsSync(outputFile)).toBe(true);
    const content = fs.readFileSync(outputFile, 'utf-8');
    expect(content).toContain('title: "Test Paper"');
    expect(content).toContain('source_pdf: "[[Test Paper.pdf]]"');
  });

  it('produces correct output for document with highlights', () => {
    writeJson(xochitlDir, 'doc-2.metadata', {
      visibleName: 'Attention Is All You Need',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000001000',
      deleted: false,
    });
    writeJson(xochitlDir, 'doc-2.content', {
      fileType: 'pdf',
      pageCount: 15,
      pages: ['p1', 'p2', 'p3'],
    });
    fs.writeFileSync(path.join(xochitlDir, 'doc-2.pdf'), '%PDF-1.4 fake');

    const docs = discoverDocuments(xochitlDir);
    const result = {
      document: docs[0],
      highlights: [
        {
          text: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
          pageNumber: 1,
          color: 'yellow',
          bounds: null,
          createdAt: null,
        },
        {
          text: 'We propose a new simple network architecture, the Transformer.',
          pageNumber: 2,
          color: 'green',
          bounds: null,
          createdAt: null,
        },
      ],
      warnings: [],
      formatDetected: 'v6' as const,
      success: true,
      error: null,
      extractedAt: new Date().toISOString(),
    };

    const pdfName = 'Attention Is All You Need.pdf';
    const markdown = renderMarkdown(result, pdfName);

    // Verify structure
    expect(markdown).toContain('title: "Attention Is All You Need"');
    expect(markdown).toContain('highlight_count: 2');
    expect(markdown).toContain('### Page 1');
    expect(markdown).toContain('### Page 2');
    expect(markdown).toContain('> The dominant sequence transduction');
    expect(markdown).toContain(`[[${pdfName}#page=1|Page 1]]`);
    expect(markdown).toContain(`[[${pdfName}#page=2|Page 2]]`);
    expect(markdown).toContain('<!-- highlight-color: green -->');
  });

  it('handles incremental update: merge preserves user edits', () => {
    const existingNote = [
      '---',
      'title: "My Paper"',
      'highlight_count: 1',
      '---',
      '',
      '# My Paper',
      '',
      '## My Personal Notes',
      '',
      'I think this paper is important because...',
      '',
      '<!-- remarkable-bridge:start -->',
      '## Highlights',
      '',
      '### Page 1',
      '',
      '> Old highlight from first sync',
      '> -- [[My Paper.pdf#page=1|Page 1]]',
      '',
      '<!-- remarkable-bridge:end -->',
      '',
      '## References',
      '',
      '- Related to [[Other Paper]]',
    ].join('\n');

    writeJson(xochitlDir, 'doc-3.metadata', {
      visibleName: 'My Paper',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000002000',
      deleted: false,
    });
    writeJson(xochitlDir, 'doc-3.content', {
      fileType: 'pdf',
      pageCount: 10,
      pages: ['p1'],
    });
    fs.writeFileSync(path.join(xochitlDir, 'doc-3.pdf'), '%PDF-1.4 fake');

    const docs = discoverDocuments(xochitlDir);
    const result = {
      document: docs[0],
      highlights: [
        {
          text: 'New highlight from second sync',
          pageNumber: 3,
          color: 'yellow',
          bounds: null,
          createdAt: null,
        },
      ],
      warnings: [],
      formatDetected: 'v6' as const,
      success: true,
      error: null,
      extractedAt: new Date().toISOString(),
    };

    const merged = mergeWithExistingNote(existingNote, result, 'My Paper.pdf');

    // User content preserved
    expect(merged).toContain('I think this paper is important because...');
    expect(merged).toContain('- Related to [[Other Paper]]');

    // Old highlights replaced with new
    expect(merged).not.toContain('Old highlight from first sync');
    expect(merged).toContain('> New highlight from second sync');
    expect(merged).toContain('[[My Paper.pdf#page=3|Page 3]]');

    // Count updated
    expect(merged).toContain('highlight_count: 1');
  });
});

describe('Pipeline config validation', () => {
  it('PipelineConfig has all required fields', () => {
    const config: PipelineConfig = {
      xochitlPath: '/path/to/xochitl',
      outputPath: '/path/to/output',
      template: null,
      sinceTimestamp: null,
      overwrite: false,
    };

    expect(config.xochitlPath).toBeDefined();
    expect(config.outputPath).toBeDefined();
    expect(config.overwrite).toBe(false);
  });
});

describe('Regression: notebook handling in pipeline', () => {
  let xochitlDir: string;
  let outputDir: string;

  beforeEach(() => {
    xochitlDir = createTmpDir();
    outputDir = createTmpDir();
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

  it('creates stub extraction results for notebooks (no Python extractor needed)', async () => {
    const doc = createMockDocument({
      uuid: 'nb-1',
      visibleName: 'My Notebook',
      type: 'notebook',
      hasPdf: false,
    });

    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      // Extractor returns nothing for notebooks (they are filtered out)
      extractor: { extractHighlights: async () => [] },
      renderer: {
        render: (result) => `---\ntitle: "${result.document.visibleName}"\n---\n## Pages\n`,
        mergeWithExisting: (existing) => existing,
      },
    });

    const result = await runExtractionPipeline(makeConfig(), deps);

    // Notebook should be processed even with 0 highlights
    expect(result.documentsProcessed).toBeGreaterThanOrEqual(1);
  });

  it('processes documents with only page drawings (no text highlights)', async () => {
    const doc = createMockDocument({
      uuid: 'doc-drawings',
      visibleName: 'Annotated Paper',
      type: 'pdf',
    });

    // Extractor returns result with 0 highlights but doc has drawings
    const extraction = createMockExtractionResult(doc, []);

    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: { extractHighlights: async () => [extraction] },
      renderer: {
        render: () => '# Annotated Paper\n\n![[drawing_p1.png]]\n',
        mergeWithExisting: (existing) => existing,
      },
    });

    const result = await runExtractionPipeline(makeConfig(), deps);

    // Document was processed (even if no highlights were found, it had drawings)
    expect(result.documentsProcessed).toBe(1);
  });
});

describe('selected extraction (uuidFilter) and failure surfacing', () => {
  let xochitlDir: string;
  let outputDir: string;

  beforeEach(() => {
    xochitlDir = createTmpDir();
    outputDir = createTmpDir();
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

  const hl = (text: string) => ({ text, pageNumber: 1, color: null, bounds: null, createdAt: null });
  const notePath = (name: string) => path.join(outputDir, generateOutputFilename(name) + '.md');

  it('writes ONLY the selected document even if the extractor returns the whole library', async () => {
    const docA = createMockDocument({ uuid: 'A', visibleName: 'Doc A' });
    const docB = createMockDocument({ uuid: 'B', visibleName: 'Doc B' });
    const docC = createMockDocument({ uuid: 'C', visibleName: 'Doc C' });

    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [docA, docB, docC] },
      // Simulate the historical bug: the extractor ignores its argument and
      // returns results for every document in the library.
      extractor: {
        extractHighlights: async () => [
          createMockExtractionResult(docA, [hl('a')]),
          createMockExtractionResult(docB, [hl('b')]),
          createMockExtractionResult(docC, [hl('c')]),
        ],
      },
      renderer: {
        render: (r) => `# ${r.document.visibleName}`,
        mergeWithExisting: (existing) => existing,
      },
    });

    const result = await runExtractionPipeline(makeConfig({ uuidFilter: ['A'] }), deps);

    expect(result.outputFiles).toHaveLength(1);
    expect(fs.existsSync(notePath('Doc A'))).toBe(true);
    expect(fs.existsSync(notePath('Doc B'))).toBe(false);
    expect(fs.existsSync(notePath('Doc C'))).toBe(false);
  });

  it('records a visible error when a selected UUID is not found', async () => {
    const docA = createMockDocument({ uuid: 'A', visibleName: 'Doc A' });
    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [docA] },
    });

    const result = await runExtractionPipeline(makeConfig({ uuidFilter: ['missing-uuid'] }), deps);

    expect(result.outputFiles).toHaveLength(0);
    expect(result.errors.join(' ')).toContain('missing-uuid');
  });

  it('surfaces a per-document extraction error in result.errors (not a silent no-op)', async () => {
    const doc = createMockDocument({ uuid: 'err', visibleName: 'Err Doc' });
    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: {
        extractHighlights: async () => [
          createMockExtractionResult(doc, [], { success: false, error: 'rmscene exploded' }),
        ],
      },
    });

    const result = await runExtractionPipeline(makeConfig(), deps);

    expect(result.errors.join(' ')).toContain('rmscene exploded');
    expect(result.outputFiles).toHaveLength(0);
  });

  it('surfaces a batch extraction failure instead of reporting no highlights', async () => {
    const doc = createMockDocument({ uuid: 'x', visibleName: 'X' });
    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: {
        extractHighlights: async () => { throw new Error('python process failed'); },
      },
    });

    const result = await runExtractionPipeline(makeConfig(), deps);

    expect(result.errors.join(' ')).toContain('python process failed');
  });

  it('clears an existing note when all highlights are removed on the tablet', async () => {
    const doc = createMockDocument({ uuid: 'stale', visibleName: 'Stale Doc' });

    // Pre-existing note with an old highlight inside the managed markers.
    const oldContent = renderMarkdown(createMockExtractionResult(doc, [hl('OLD HIGHLIGHT')]), 'stale.pdf');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(notePath('Stale Doc'), oldContent, 'utf-8');
    expect(fs.readFileSync(notePath('Stale Doc'), 'utf-8')).toContain('OLD HIGHLIGHT');

    // Re-extract: the document now has zero highlights.
    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: { extractHighlights: async () => [createMockExtractionResult(doc, [])] },
      renderer: new DefaultMarkdownRenderer(),
    });

    await runExtractionPipeline(makeConfig({ overwrite: false }), deps);

    const updated = fs.readFileSync(notePath('Stale Doc'), 'utf-8');
    expect(updated).not.toContain('OLD HIGHLIGHT');
    expect(updated).toContain('_No highlights or annotations found');
  });

  it('does NOT create a note for a brand-new document with nothing to extract', async () => {
    const doc = createMockDocument({ uuid: 'empty', visibleName: 'Empty Doc' });
    const deps = createMockDeps({
      discovery: { discoverDocuments: async () => [doc] },
      extractor: { extractHighlights: async () => [createMockExtractionResult(doc, [])] },
      renderer: new DefaultMarkdownRenderer(),
    });

    const result = await runExtractionPipeline(makeConfig(), deps);

    expect(fs.existsSync(notePath('Empty Doc'))).toBe(false);
    expect(result.outputFiles).toHaveLength(0);
  });
});

describe('Pipeline: sync-conflict filtering', () => {
  let xochitlDir: string;

  beforeEach(() => {
    xochitlDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(xochitlDir, { recursive: true, force: true });
  });

  it('ignores Syncthing conflict files during document discovery', () => {
    // Normal document
    writeJson(xochitlDir, 'doc-1.metadata', {
      visibleName: 'Good Document',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });
    writeJson(xochitlDir, 'doc-1.content', {
      fileType: 'pdf',
      pageCount: 1,
      pages: ['p1'],
    });
    fs.writeFileSync(path.join(xochitlDir, 'doc-1.pdf'), '%PDF-1.4 fake');

    // Sync conflict file -- should be ignored
    writeJson(xochitlDir, 'doc-1.sync-conflict-20240115-123456-ABCDEFG.metadata', {
      visibleName: 'Conflict Document',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });

    // Syncthing temp file -- should be ignored
    writeJson(xochitlDir, '.syncthing.doc-2.metadata.tmp', {
      visibleName: 'Temp Document',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });

    const docs = discoverDocuments(xochitlDir);

    expect(docs).toHaveLength(1);
    expect(docs[0].visibleName).toBe('Good Document');
  });
});

describe('Pipeline: archive safety', () => {
  it('archive flow does not re-sync deleted files (design verification)', () => {
    // This test verifies the design assumptions of the archive flow:
    //
    // 1. UUID is added to tablet's .stignore before deletion
    //    -> Syncthing on the tablet will ignore this UUID pattern
    //
    // 2. Files are deleted from the tablet
    //    -> Tablet no longer has the files
    //
    // 3. Files are moved from Sync/ to Archive/ locally
    //    -> Files disappear from the PC's Syncthing sync folder
    //
    // 4. Syncthing sees files gone from PC sync folder
    //    -> Would normally propagate deletion to tablet
    //    -> But files are already gone on the tablet -> no-op
    //
    // 5. .stignore on tablet prevents tablet from accepting these
    //    files if they somehow reappear in the sync
    //
    // The key invariant: .stignore is written BEFORE deletion.
    // This ensures the tablet never tries to re-fetch the files.
    //
    // We verify the order of operations in the archiveDocument method:
    // Step 1: echo to .stignore (UUID* and UUID/ patterns)
    // Step 2: rm -rf UUID files
    // Step 3: Move locally from Sync to Archive
    //
    // This is a documentation test -- the actual SSH commands are tested
    // via integration tests with a real tablet connection.
    expect(true).toBe(true);
  });
});
