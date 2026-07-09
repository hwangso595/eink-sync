/**
 * Type definitions for the extraction pipeline.
 *
 * These establish the contract between pipeline stages:
 *   File Discovery -> Format Detection -> Parsing -> Text Extraction -> Markdown Output
 *
 * Sprint 1 defines the interfaces. Sprints 2-3 implement the stages.
 */

/** Supported .rm file format versions. */
export type RmFileFormat = 'v3' | 'v5' | 'v6' | 'unknown';

/** Type of document on the reMarkable. */
export type DocumentType = 'pdf' | 'epub' | 'notebook';

/** Represents a single document in the xochitl filesystem. */
export interface ReMarkableDocument {
  /** UUID identifier (directory/file name in xochitl). */
  uuid: string;
  /** Human-readable name from .metadata visibleName field. */
  visibleName: string;
  /** Parent folder UUID, or empty string for root. */
  parentUuid: string;
  /** Document type. */
  type: DocumentType;
  /** Last modified timestamp (epoch ms). */
  lastModified: number;
  /** Number of pages in the document. */
  pageCount: number;
  /** UUIDs of individual pages, in order. */
  pageUuids: string[];
  /** Whether the source PDF is present (for PDF documents). */
  hasPdf: boolean;
}

/** A single highlight extracted from a PDF annotation. */
export interface ExtractedHighlight {
  /** The highlighted text content. */
  text: string;
  /** Page number in the PDF (1-indexed). */
  pageNumber: number;
  /** Color of the highlight, if available. */
  color: string | null;
  /** Bounding rectangle in PDF coordinates, if available. */
  bounds: { x: number; y: number; width: number; height: number } | null;
  /** Timestamp when the highlight was created, if available. */
  createdAt: number | null;
}

/** Result of extracting annotations from a single document. */
export interface ExtractionResult {
  /** The source document. */
  document: ReMarkableDocument;
  /** Extracted text highlights. */
  highlights: ExtractedHighlight[];
  /** Warnings encountered during extraction (non-fatal issues). */
  warnings: string[];
  /** Per-page .rm file format detected. */
  formatDetected: RmFileFormat;
  /** Whether extraction completed successfully. */
  success: boolean;
  /** Error message if extraction failed. */
  error: string | null;
  /** ISO timestamp of extraction. */
  extractedAt: string;
  /** Document-level tags from the tablet. */
  tags?: string[];
  /** Page-level tags: maps page UUID to tag names. */
  pageTags?: Record<string, string[]>;
}

/**
 * Interface for a pipeline stage that discovers documents.
 */
export interface DocumentDiscovery {
  /**
   * Scan the xochitl directory and return all documents.
   *
   * @param xochitlPath - Path to the synced xochitl directory on the host.
   */
  discoverDocuments(xochitlPath: string): Promise<ReMarkableDocument[]>;
}

/**
 * Interface for a pipeline stage that extracts highlights from documents.
 *
 * Accepts the full list of discovered documents and the xochitl path,
 * and returns per-document extraction results. This matches the batch
 * processing model of the Python bridge.
 */
export interface HighlightExtractor {
  /**
   * Extract highlights from one or more documents.
   *
   * @param documents - The documents to extract from.
   * @param xochitlPath - Path to the synced xochitl directory on the host.
   * @param sinceTimestamp - Only process documents modified after this epoch-ms timestamp.
   */
  extractHighlights(
    documents: ReMarkableDocument[],
    xochitlPath: string,
    sinceTimestamp?: number,
  ): Promise<ExtractionResult[]>;
}

/**
 * Interface for a pipeline stage that produces markdown output.
 */
/**
 * Map from 1-based page number to PNG filename.
 * Each entry represents a rendered page of pen strokes.
 */
export type PageDrawings = Map<number, string>;

/**
 * Map from 1-based page number to the OCR'd handwriting text for that page.
 * Rendered as a collapsed callout under the page image so it stays searchable
 * without cluttering the note.
 */
export type PageOcr = Map<number, string>;

export interface MarkdownRenderer {
  /**
   * Render extraction results as a markdown string.
   *
   * @param result - Extraction result for a single document.
   * @param sourcePdfName - Name of the source PDF for link generation.
   * @param pageDrawings - Optional map of page number to PNG filename.
   * @param pageOcr - Optional map of page number to OCR text.
   */
  render(
    result: ExtractionResult,
    sourcePdfName?: string,
    pageDrawings?: PageDrawings | null,
    pageOcr?: PageOcr | null,
  ): string;

  /**
   * Merge new extraction results into an existing markdown note,
   * preserving user edits outside the managed highlights section.
   *
   * @param existingContent - The current content of the markdown file.
   * @param result - New extraction result to merge.
   * @param sourcePdfName - Name of the source PDF for link generation.
   * @param pageDrawings - Optional map of page number to PNG filename.
   * @param pageOcr - Optional map of page number to OCR text.
   */
  mergeWithExisting(
    existingContent: string,
    result: ExtractionResult,
    sourcePdfName: string,
    pageDrawings?: PageDrawings | null,
    pageOcr?: PageOcr | null,
  ): string;
}

/**
 * Dependencies for the extraction pipeline, following the Dependency Inversion
 * Principle. Each stage is represented by its interface so the orchestrator
 * can be unit-tested with mock implementations.
 */
export interface PipelineDependencies {
  discovery: DocumentDiscovery;
  extractor: HighlightExtractor;
  renderer: MarkdownRenderer;
}

/**
 * Pipeline configuration for a single extraction run.
 *
 * In multi-source mode, one `PipelineConfig` is created per `SyncSource`
 * by `runExtractionForSource()`. The `xochitlPath` and `outputPath` are
 * resolved from the source's `syncFolder` and optional `highlightsSubfolder`.
 * The `sourceLabel` and `sourceId` fields propagate into the rendered
 * frontmatter so that highlight notes can be traced back to their origin.
 */
export interface PipelineConfig {
  /** Path to the synced xochitl directory on the host. */
  xochitlPath: string;
  /** Path to output markdown files. */
  outputPath: string;
  /** Optional template for markdown rendering. */
  template: string | null;
  /** Only process documents modified after this timestamp. */
  sinceTimestamp: number | null;
  /** Whether to overwrite existing output files. */
  overwrite: boolean;
  /** Optional list of document UUIDs to process. When set, only these documents are extracted. */
  uuidFilter?: string[];
  /** Path to the plugin directory (where extraction/ scripts live). */
  pluginDir?: string;
  /** Absolute path to the drawings folder for SVG output. */
  drawingsPath?: string;
  /** Whether to include EPUB documents in extraction (default: true). */
  includeEpub?: boolean;
  /** Label of the sync source that produced this extraction (for multi-source). */
  sourceLabel?: string;
  /** Unique ID of the sync source (for multi-source). */
  sourceId?: string;
  /** Whether to include color info in highlight output (default: true). */
  includeColors?: boolean;
  /** Whether to group highlights by page with ### Page N headers (default: true). */
  groupByPage?: boolean;
  /** PDF link format: 'pdfpp', 'obsidian', or 'none' (default: 'pdfpp'). */
  pdfLinkFormat?: 'pdfpp' | 'obsidian' | 'none';
  /** Default tags to add to highlight note frontmatter. */
  defaultTags?: string[];
  /** Crop trailing blank space on short notebook pages (default: true). */
  truncateBlankSpace?: boolean;
  /** Run local OCR on notebook pages for handwriting search (default: false). */
  ocrEnabled?: boolean;
  /** Tesseract language code(s) for OCR (default: 'eng'). */
  ocrLanguage?: string;
}
