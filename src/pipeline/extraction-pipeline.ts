/**
 * Pipeline orchestrator for PDF highlight extraction.
 *
 * Coordinates the full extraction flow:
 *   1. Discover documents in the synced xochitl directory
 *   2. Invoke the highlight extractor for parsing
 *   3. Render markdown output with frontmatter and PDF++ links
 *   4. Write or update output files, preserving user edits
 *
 * ## Multi-Source Support
 *
 * In multi-source mode, the plugin calls `runExtractionPipeline()` once per
 * `SyncSource`. Each invocation receives a `PipelineConfig` scoped to one
 * source's xochitl directory and output path. The `sourceLabel` field flows
 * through to the renderer so that highlight notes include the source in
 * their frontmatter.
 *
 * The orchestrator depends on the DocumentDiscovery, HighlightExtractor,
 * and MarkdownRenderer interfaces from types.ts (Dependency Inversion).
 * Concrete implementations are injected via PipelineDependencies, allowing
 * full unit testing with mock implementations.
 *
 * A default factory (createDefaultDependencies) wires the real implementations
 * for production use.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  PipelineConfig,
  PipelineDependencies,
  ExtractionResult,
} from './types';
import { XochitlDocumentDiscovery } from './document-discovery';
import { PythonHighlightExtractor } from './python-bridge';
import { DefaultMarkdownRenderer, generateOutputFilename, type PageDrawings } from './markdown-renderer';
import { TemplateMarkdownRenderer, validateTemplate } from './template-engine';
import { renderPageImages } from './page-image-renderer';
import { logger } from '../utils/logger';
import { BridgeError, ErrorCode } from '../types/errors';

/** Result of a full pipeline run across all documents. */
export interface PipelineRunResult {
  /** Total number of documents processed. */
  documentsProcessed: number;
  /** Number of documents that produced highlights. */
  documentsWithHighlights: number;
  /** Total number of highlights extracted across all documents. */
  totalHighlights: number;
  /** Output file paths that were written or updated. */
  outputFiles: string[];
  /** Per-document results with success/error status. */
  documentResults: DocumentPipelineResult[];
  /** Pipeline-level errors (not per-document). */
  errors: string[];
  /** ISO timestamp of pipeline run. */
  timestamp: string;
}

/** Result for a single document in the pipeline. */
export interface DocumentPipelineResult {
  uuid: string;
  visibleName: string;
  highlightCount: number;
  outputFile: string | null;
  success: boolean;
  error: string | null;
  warnings: string[];
}

/** Callback for reporting pipeline progress. */
export type PipelineProgressCallback = (
  stage: 'discovery' | 'extraction' | 'rendering' | 'writing',
  current: number,
  total: number,
  documentName?: string,
) => void;

/** Configuration for creating default pipeline dependencies. */
export interface DefaultDependenciesConfig {
  /** Path to the plugin directory (where extraction/ scripts live). */
  pluginDir?: string;
  /** Whether to include EPUB documents in extraction. */
  includeEpub?: boolean;
  /** Custom Handlebars template string, or null for the default renderer. */
  template?: string | null;
  /** Label of the sync source (for multi-source identification in frontmatter). */
  sourceLabel?: string;
  /** Whether to include color info in highlight output (default: true). */
  includeColors?: boolean;
  /** Whether to group highlights by page (default: true). */
  groupByPage?: boolean;
  /** PDF link format (default: 'pdfpp'). */
  pdfLinkFormat?: 'pdfpp' | 'obsidian' | 'none';
  /** Default tags to add to frontmatter. */
  defaultTags?: string[];
}

/**
 * Create the default production dependencies.
 *
 * Wires the concrete implementations:
 * - XochitlDocumentDiscovery for document scanning
 * - PythonHighlightExtractor for rmscene/PyMuPDF extraction
 * - DefaultMarkdownRenderer for markdown output
 */
export function createDefaultDependencies(config: DefaultDependenciesConfig = {}): PipelineDependencies {
  const { pluginDir, includeEpub, template, sourceLabel } = config;
  const pdfLinkFormat = config.pdfLinkFormat ?? 'pdfpp';
  const defaultTags = config.defaultTags ?? [];
  const includeColors = config.includeColors ?? true;
  const groupByPage = config.groupByPage ?? true;
  let renderer: PipelineDependencies['renderer'];

  if (template) {
    const validation = validateTemplate(template);
    if (validation.warnings.length > 0) {
      for (const w of validation.warnings) {
        logger.warn(`Template warning: ${w}`);
      }
    }
    renderer = new TemplateMarkdownRenderer(template, pdfLinkFormat, defaultTags, sourceLabel, includeColors, groupByPage);
  } else {
    renderer = new DefaultMarkdownRenderer(sourceLabel, includeColors, groupByPage, pdfLinkFormat, defaultTags);
  }

  return {
    discovery: new XochitlDocumentDiscovery(),
    extractor: new PythonHighlightExtractor(pluginDir, includeEpub),
    renderer,
  };
}

/**
 * Ensure the output directory exists, creating it recursively if needed.
 */
function ensureOutputDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logger.debug(`Created output directory: ${dirPath}`);
  }
}

/**
 * Write a markdown file atomically: write to a temp file, then rename.
 *
 * This prevents corrupted output if the process is interrupted mid-write.
 * On Windows, we fall back to direct write since rename over existing files
 * is not atomic on all Windows filesystems.
 */
function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    // Rename to final path (overwrites existing on most platforms)
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Fallback: direct write if rename fails (e.g., cross-device move)
    logger.warn(`Atomic rename failed for ${filePath}, falling back to direct write`);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmp file may not exist
    }
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

/**
 * Run the full extraction pipeline.
 *
 * This is the main entry point for the pipeline. It:
 * 1. Discovers documents in the xochitl directory
 * 2. Extracts highlights via the injected HighlightExtractor
 * 3. Renders each document's highlights as markdown
 * 4. Writes or updates output files, preserving user edits
 *
 * @param config - Pipeline configuration (paths, filters, options).
 * @param deps - Injected pipeline stage implementations. Uses defaults if omitted.
 * @param progress - Optional callback for progress reporting.
 * @returns A summary of the pipeline run.
 */
export async function runExtractionPipeline(
  config: PipelineConfig,
  deps?: PipelineDependencies,
  progress?: PipelineProgressCallback,
): Promise<PipelineRunResult> {
  const { discovery, extractor, renderer } = deps ?? createDefaultDependencies({
    pluginDir: config.pluginDir,
    includeEpub: config.includeEpub,
    template: config.template,
    sourceLabel: config.sourceLabel,
    includeColors: config.includeColors,
    groupByPage: config.groupByPage,
    pdfLinkFormat: config.pdfLinkFormat,
    defaultTags: config.defaultTags,
  });

  const result: PipelineRunResult = {
    documentsProcessed: 0,
    documentsWithHighlights: 0,
    totalHighlights: 0,
    outputFiles: [],
    documentResults: [],
    errors: [],
    timestamp: new Date().toISOString(),
  };

  // Validate input paths
  if (!config.xochitlPath || !fs.existsSync(config.xochitlPath)) {
    throw new BridgeError(
      ErrorCode.XOCHITL_PATH_NOT_FOUND,
      `xochitl directory not found: ${config.xochitlPath}`,
      'Ensure the sync folder is configured and accessible.',
    );
  }

  if (!config.outputPath) {
    throw new BridgeError(
      ErrorCode.PIPELINE_NOT_CONFIGURED,
      'Output path is not configured.',
      'Set the output folder in the plugin settings.',
    );
  }

  ensureOutputDir(config.outputPath);

  // Stage 1: Discovery
  progress?.('discovery', 0, 1);
  logger.info(`Discovering documents in ${config.xochitlPath}`);

  let documents = await discovery.discoverDocuments(config.xochitlPath);
  if (documents.length === 0) {
    // Distinguish "no new highlights" from "empty/missing sync folder".
    // Check if the folder has any .metadata files at all.
    const hasMetadataFiles = fs.readdirSync(config.xochitlPath)
      .some((f) => f.endsWith('.metadata'));

    if (!hasMetadataFiles) {
      throw new BridgeError(
        ErrorCode.SYNC_FOLDER_EMPTY,
        `No documents found in "${config.xochitlPath}".`,
        'Is Syncthing running and synced? The sync folder should contain .metadata files from the tablet.',
      );
    }

    logger.info('No PDF documents found in xochitl directory');
    return result;
  }

  // Apply UUID filter if provided (used by extractSelected for targeted extraction)
  if (config.uuidFilter && config.uuidFilter.length > 0) {
    const uuidSet = new Set(config.uuidFilter);
    documents = documents.filter((doc) => uuidSet.has(doc.uuid));
    if (documents.length === 0) {
      logger.info('No documents matched the UUID filter');
      return result;
    }
    logger.info(`UUID filter applied: ${documents.length} of ${config.uuidFilter.length} requested document(s) found`);
  }

  logger.info(`Found ${documents.length} PDF document(s)`);
  progress?.('discovery', 1, 1);

  // Stage 2: Extraction (via injected extractor)
  // Graceful degradation: if batch extraction fails, attempt per-document
  // extraction so that one bad document does not halt the entire pipeline.
  // Only send non-notebook documents to the Python highlight extractor
  const extractableDocs = documents.filter(d => d.type !== 'notebook');

  progress?.('extraction', 0, extractableDocs.length);
  logger.info(`Running highlight extraction on ${extractableDocs.length} document(s) (${documents.length - extractableDocs.length} notebook(s) skipped)`);

  let extractionResults: ExtractionResult[];
  try {
    extractionResults = await extractor.extractHighlights(
      extractableDocs,
      config.xochitlPath,
      config.sinceTimestamp ?? undefined,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`Batch extraction failed, attempting per-document fallback: ${errMsg}`);
    result.errors.push(`Batch extraction failed (falling back to per-document): ${errMsg}`);

    // Per-document fallback: extract each document individually so failures
    // are isolated and partial results are preserved.
    extractionResults = [];
    for (let i = 0; i < extractableDocs.length; i++) {
      const doc = extractableDocs[i];
      progress?.('extraction', i, extractableDocs.length, doc.visibleName);
      try {
        const singleResults = await extractor.extractHighlights(
          [doc],
          config.xochitlPath,
          config.sinceTimestamp ?? undefined,
        );
        extractionResults.push(...singleResults);
      } catch (docErr) {
        const docErrMsg = docErr instanceof Error ? docErr.message : String(docErr);
        logger.error(`Extraction failed for ${doc.visibleName}: ${docErrMsg}`);
        // Create a partial result with the error logged but pipeline continues
        extractionResults.push({
          document: doc,
          highlights: [],
          warnings: [`Extraction failed: ${docErrMsg}`],
          formatDetected: 'unknown',
          success: false,
          error: docErrMsg,
          extractedAt: new Date().toISOString(),
        });
      }
    }
  }

  progress?.('extraction', documents.length, documents.length);

  // Stage 2.5: Handle notebooks (no text highlights, only drawings)
  // Notebooks are not sent to the Python extractor, so we create stub results for them.
  const notebookDocs = documents.filter(d => d.type === 'notebook');
  for (const doc of notebookDocs) {
    const alreadyProcessed = extractionResults.some(r => r.document.uuid === doc.uuid);
    if (!alreadyProcessed) {
      extractionResults.push({
        document: doc,
        highlights: [],
        warnings: [],
        formatDetected: 'v6',
        success: true,
        error: null,
        extractedAt: new Date().toISOString(),
      });
    }
  }

  // Stage 3 & 4: Render and write each document
  const total = extractionResults.length;
  for (let i = 0; i < total; i++) {
    const extractionResult = extractionResults[i];
    const doc = extractionResult.document;
    progress?.('rendering', i, total, doc.visibleName);

    const docResult: DocumentPipelineResult = {
      uuid: doc.uuid,
      visibleName: doc.visibleName,
      highlightCount: 0,
      outputFile: null,
      success: false,
      error: null,
      warnings: [],
    };

    try {
      if (extractionResult.error && extractionResult.highlights.length === 0 && doc.type !== 'notebook') {
        // Complete failure for non-notebook: no highlights extracted
        docResult.error = extractionResult.error;
        docResult.warnings = extractionResult.warnings;
        result.documentResults.push(docResult);
        result.documentsProcessed++;
        logger.warn(
          `Skipping ${doc.visibleName}: ${extractionResult.error} (graceful degradation)`,
        );
        continue;
      }

      // Partial extraction: some highlights extracted despite errors.
      // Save what we have with a warning marker.
      if (extractionResult.error && extractionResult.highlights.length > 0) {
        docResult.warnings.push(
          `Partial extraction: ${extractionResult.error}`,
        );
        logger.warn(
          `Partial extraction for ${doc.visibleName}: ${extractionResult.highlights.length} highlights ` +
          `extracted despite error: ${extractionResult.error}`,
        );
      }

      docResult.highlightCount = extractionResult.highlights.length;
      docResult.warnings = [...docResult.warnings, ...extractionResult.warnings];

      // Generate output file path
      const filename = generateOutputFilename(doc.visibleName) + '.md';
      const outputFilePath = path.join(config.outputPath, filename);
      docResult.outputFile = outputFilePath;

      // Render page images (PNGs) for pen strokes
      logger.info(`Calling renderPageImages for ${doc.visibleName} (type=${doc.type}, uuid=${doc.uuid})`);
      logger.info(`  xochitlPath=${config.xochitlPath}, drawingsPath=${config.drawingsPath}, pluginDir=${config.pluginDir}`);

      let pageDrawings: PageDrawings | null = null;
      try {
        pageDrawings = await renderPageImages(
          doc, config.xochitlPath, config.drawingsPath, config.pluginDir,
        );
      } catch (drawErr) {
        logger.error(`renderPageImages failed for ${doc.visibleName}: ${drawErr}`);
      }

      logger.info(
        `${doc.visibleName}: ${extractionResult.highlights.length} highlights, ` +
        `${pageDrawings ? pageDrawings.size : 0} page drawings`
      );

      // Skip documents with nothing to show (no highlights AND no drawings)
      if (extractionResult.highlights.length === 0 && (!pageDrawings || pageDrawings.size === 0)) {
        if (doc.type !== 'notebook') {
          // For PDFs without highlights or drawings, skip creating a note
          result.documentsProcessed++;
          docResult.success = true;
          result.documentResults.push(docResult);
          continue;
        }
      }

      // The actual PDF filename in the vault is UUID.pdf
      const sourcePdfName = `${doc.uuid}.pdf`;

      // Render or merge markdown
      let markdownContent: string;
      if (!config.overwrite && fs.existsSync(outputFilePath)) {
        const existingContent = fs.readFileSync(outputFilePath, 'utf-8');
        markdownContent = renderer.mergeWithExisting(
          existingContent,
          extractionResult,
          sourcePdfName,
          pageDrawings,
        );
        logger.debug(`Merged highlights into existing: ${outputFilePath}`);
      } else {
        markdownContent = renderer.render(extractionResult, sourcePdfName, pageDrawings);
        logger.debug(`Created new note: ${outputFilePath}`);
      }

      // If there are warnings, prepend a warning callout to the content
      if (docResult.warnings.length > 0) {
        const warningBlock =
          '> [!warning] Extraction warnings\n' +
          docResult.warnings.map((w) => `> - ${w}`).join('\n') +
          '\n\n';
        // Only add if not already present (avoid duplicates on re-run)
        if (!markdownContent.includes('[!warning] Extraction warnings')) {
          markdownContent = warningBlock + markdownContent;
        }
      }

      // Write atomically
      progress?.('writing', i, total, doc.visibleName);
      writeFileAtomic(outputFilePath, markdownContent);

      docResult.success = true;
      result.outputFiles.push(outputFilePath);

      if (extractionResult.highlights.length > 0) {
        result.documentsWithHighlights++;
        result.totalHighlights += extractionResult.highlights.length;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      docResult.error = errMsg;
      logger.error(`Failed to process ${doc.visibleName}: ${errMsg}`);
    }

    result.documentsProcessed++;
    result.documentResults.push(docResult);
  }

  logger.info(
    `Pipeline complete: ${result.documentsProcessed} documents processed, ` +
    `${result.totalHighlights} highlights extracted, ` +
    `${result.outputFiles.length} files written`,
  );

  return result;
}
