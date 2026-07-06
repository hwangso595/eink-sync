/**
 * Render extraction results as Obsidian-compatible markdown.
 *
 * Produces a markdown note for each PDF document with:
 * - YAML frontmatter (title, author, date, source PDF path, tags)
 * - Each highlight as a blockquote with page number reference
 * - PDF++ compatible links (e.g., [[file.pdf#page=5]])
 * - Dataview-compatible fields in frontmatter
 *
 * Implements the MarkdownRenderer interface from pipeline/types.ts.
 *
 * The update logic appends new highlights to existing notes without
 * overwriting user edits. It identifies the managed section (between
 * markers) and only updates that section.
 */

import { ExtractionResult, ExtractedHighlight, MarkdownRenderer } from './types';
import type { PdfLinkFormat } from '../plugin/settings';
import { formatPdfLink, formatHighlightDate, updateFrontmatterHighlightCount } from './render-helpers';
import { logger } from '../utils/logger';
import {
  HIGHLIGHTS_SECTION_START,
  HIGHLIGHTS_SECTION_END,
  findHighlightsStart,
  findHighlightsEnd,
} from '../plugin/highlight-markers';

/** Default frontmatter template fields. */
interface FrontmatterData {
  title: string;
  source_pdf?: string;
  source_type: string;
  date_highlighted: string;
  highlight_count: number;
  remarkable_uuid: string;
  tags?: string[];
  /** Label of the sync source that produced this note (multi-source support). */
  source?: string;
}

/**
 * Build YAML frontmatter from document metadata.
 *
 * The frontmatter is dataview-compatible, using standard YAML scalar types.
 * String values containing special YAML characters are quoted.
 */
function buildFrontmatter(data: FrontmatterData): string {
  const lines: string[] = ['---'];

  lines.push(`title: "${escapeYamlString(data.title)}"`);
  if (data.source_pdf) {
    lines.push(`source_pdf: "[[${escapeYamlString(data.source_pdf)}]]"`);
  }
  lines.push(`source_type: ${data.source_type}`);
  lines.push(`date_highlighted: ${data.date_highlighted}`);
  lines.push(`highlight_count: ${data.highlight_count}`);
  lines.push(`remarkable_uuid: ${data.remarkable_uuid}`);

  if (data.source) {
    lines.push(`source: "${escapeYamlString(data.source)}"`);
  }

  if (data.tags && data.tags.length > 0) {
    lines.push('tags:');
    for (const tag of data.tags) {
      lines.push(`  - ${tag}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Escape special characters in a YAML string value.
 */
function escapeYamlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/** Options controlling how a highlight is formatted. */
interface FormatHighlightOptions {
  includeColors?: boolean;
  pdfLinkFormat?: PdfLinkFormat;
}

/**
 * Format a single highlight as a markdown blockquote with PDF link.
 *
 * Output format:
 *   > highlighted text content here
 *   > -- [[source.pdf#page=5|Page 5]]
 *
 * If the highlight has a color and includeColors is true, it is included as a comment.
 */
function formatHighlight(
  highlight: ExtractedHighlight,
  sourcePdfName: string,
  options: FormatHighlightOptions = {},
): string {
  const { includeColors = true, pdfLinkFormat = 'pdfpp' } = options;
  const lines: string[] = [];

  // Main blockquote with the highlighted text
  const quotedLines = highlight.text
    .split('\n')
    .map((line) => `> ${line}`);
  lines.push(...quotedLines);

  // Page reference with PDF link
  const pdfLink = formatPdfLink(sourcePdfName, highlight.pageNumber, pdfLinkFormat);
  lines.push(`> -- ${pdfLink}`);

  // Color indicator as HTML comment (non-intrusive), only when includeColors is true
  if (includeColors && highlight.color && highlight.color !== 'yellow') {
    lines.push(`<!-- highlight-color: ${highlight.color} -->`);
  }

  return lines.join('\n');
}

/**
 * Render a full markdown note from extraction results.
 *
 * This produces the complete content for a new note file. For updates
 * to existing notes, use mergeWithExistingNote() instead.
 */
/**
 * Map from 1-based page number to PNG filename.
 * Each entry represents a rendered page of pen strokes.
 */
export type PageDrawings = Map<number, string>;

/** Options for the renderMarkdown function. */
export interface RenderMarkdownOptions {
  sourceLabel?: string;
  includeColors?: boolean;
  groupByPage?: boolean;
  pdfLinkFormat?: PdfLinkFormat;
  defaultTags?: string[];
}

export function renderMarkdown(
  result: ExtractionResult,
  sourcePdfName?: string,
  pageDrawings?: PageDrawings | null,
  sourceLabelOrOptions?: string | RenderMarkdownOptions,
): string {
  // Support both old signature (sourceLabel string) and new (options object)
  const options: RenderMarkdownOptions = typeof sourceLabelOrOptions === 'string'
    ? { sourceLabel: sourceLabelOrOptions }
    : (sourceLabelOrOptions ?? {});
  const {
    sourceLabel,
    includeColors = true,
    groupByPage = true,
    pdfLinkFormat = 'pdfpp',
    defaultTags = [],
  } = options;
  // Clean the visible name — strip file extension if present
  const cleanName = stripFileExtension(result.document.visibleName);
  const isNotebook = result.document.type === 'notebook';
  const pdfName = isNotebook ? null : (sourcePdfName ?? ensurePdfExtension(result.document.visibleName));
  // Use the document's lastModified timestamp for a deterministic date that
  // won't conflict when the same vault is synced across multiple machines.
  const now = formatHighlightDate(result.document.lastModified);

  const frontmatterData: FrontmatterData = {
    title: cleanName,
    source_type: isNotebook ? 'notebook' : 'pdf',
    date_highlighted: now,
    highlight_count: result.highlights.length,
    remarkable_uuid: result.document.uuid,
  };
  if (pdfName) {
    frontmatterData.source_pdf = pdfName;
  }
  // Add source label for multi-source identification
  if (sourceLabel) {
    frontmatterData.source = sourceLabel;
  }
  // Merge document-level tags from the tablet with default tags from settings
  const allTags = [...defaultTags, ...(result.tags ?? [])];
  if (allTags.length > 0) {
    // Deduplicate while preserving order
    frontmatterData.tags = [...new Set(allTags)];
  }
  const frontmatter = buildFrontmatter(frontmatterData);

  const sections: string[] = [frontmatter, ''];

  // Warning comment for users
  sections.push('<!-- Note: Highlights between the %% markers are auto-generated and will be overwritten on re-extraction. Add your own notes outside the markers. -->');
  sections.push('');

  // Build page tags map: page number → tag names
  const pageTagsByNumber = buildPageTagsByNumber(
    result.pageTags ?? {},
    result.document.pageUuids,
  );

  // Build highlights + annotations section using shared function
  sections.push(buildHighlightsSection(
    result.highlights,
    pdfName ?? '',
    pageDrawings,
    isNotebook,
    pageTagsByNumber,
    { includeColors, groupByPage, pdfLinkFormat },
  ));
  sections.push('');

  // Warnings section (if any)
  if (result.warnings.length > 0) {
    sections.push('## Extraction Notes');
    sections.push('');
    for (const warning of result.warnings) {
      sections.push(`- ${warning}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Group highlights by page number, maintaining insertion order within each page.
 */
function groupHighlightsByPage(
  highlights: ExtractedHighlight[],
): Map<number, ExtractedHighlight[]> {
  const groups = new Map<number, ExtractedHighlight[]>();

  for (const h of highlights) {
    const existing = groups.get(h.pageNumber);
    if (existing) {
      existing.push(h);
    } else {
      groups.set(h.pageNumber, [h]);
    }
  }

  return groups;
}

/**
 * Merge new extraction results into an existing markdown note.
 *
 * This preserves any user edits outside the managed highlights section
 * (between HIGHLIGHTS_SECTION_START and HIGHLIGHTS_SECTION_END markers).
 * Only the content between markers is replaced with the latest highlights.
 *
 * If the note does not contain the markers, the highlights section is
 * appended at the end.
 *
 * @param existingContent - The current content of the markdown file.
 * @param result - The new extraction result.
 * @param sourcePdfName - The PDF filename for links.
 * @returns The merged markdown content.
 */
export function mergeWithExistingNote(
  existingContent: string,
  result: ExtractionResult,
  sourcePdfName?: string,
  pageDrawings?: PageDrawings | null,
  renderOptions?: RenderMarkdownOptions,
): string {
  const pdfName = sourcePdfName ?? ensurePdfExtension(result.document.visibleName);
  const start = findHighlightsStart(existingContent);
  const end = findHighlightsEnd(existingContent);

  const isNotebook = result.document.type === 'notebook';
  const sectionOpts: HighlightsSectionOptions = {
    includeColors: renderOptions?.includeColors ?? true,
    groupByPage: renderOptions?.groupByPage ?? true,
    pdfLinkFormat: renderOptions?.pdfLinkFormat ?? 'pdfpp',
  };
  const newSection = buildHighlightsSection(result.highlights, pdfName, pageDrawings, isNotebook, undefined, sectionOpts);

  // If markers exist, replace the section between them (legacy markers migrate
  // to current ones because newSection always uses HIGHLIGHTS_SECTION_*).
  if (start && end) {
    const before = existingContent.substring(0, start.index);
    const after = existingContent.substring(end.index + end.marker.length);

    // Update frontmatter highlight count if present
    const updatedBefore = updateFrontmatterHighlightCount(before, result.highlights.length);

    return updatedBefore + newSection + after;
  }

  // No markers found: append the highlights section at the end
  logger.info('No highlight markers found in existing note, appending section');
  return existingContent.trimEnd() + '\n\n' + newSection + '\n';
}

/** Options for buildHighlightsSection. */
interface HighlightsSectionOptions {
  includeColors?: boolean;
  groupByPage?: boolean;
  pdfLinkFormat?: PdfLinkFormat;
}

/**
 * Build just the highlights section content (between markers).
 */
function buildHighlightsSection(
  highlights: ExtractedHighlight[],
  pdfName: string,
  pageDrawings?: PageDrawings | null,
  isNotebook = false,
  pageTagsByNumber?: Map<number, string[]>,
  sectionOptions: HighlightsSectionOptions = {},
): string {
  const {
    includeColors = true,
    groupByPage = true,
    pdfLinkFormat = 'pdfpp',
  } = sectionOptions;
  const highlightOpts: FormatHighlightOptions = { includeColors, pdfLinkFormat };

  const lines: string[] = [HIGHLIGHTS_SECTION_START];
  lines.push(isNotebook ? '## Pages' : '## Highlights');
  lines.push('');

  const byPage = groupHighlightsByPage(highlights);

  // Collect all page numbers that have content (highlights or drawings)
  const allPages = new Set<number>();
  for (const p of byPage.keys()) allPages.add(p);
  if (pageDrawings) {
    for (const p of pageDrawings.keys()) allPages.add(p);
  }

  if (allPages.size === 0) {
    lines.push('_No highlights or annotations found in this document._');
  } else if (groupByPage) {
    // Render all pages in order with ### Page N headers
    const sortedPages = [...allPages].sort((a, b) => a - b);

    for (const pageNum of sortedPages) {
      const pageTags = pageTagsByNumber?.get(pageNum);
      if (pageTags && pageTags.length > 0) {
        lines.push(`### Page ${pageNum}  ${pageTags.map(t => `#${t}`).join(' ')}`);
      } else {
        lines.push(`### Page ${pageNum}`);
      }
      lines.push('');

      // Highlights for this page (rendered first)
      const pageHighlights = byPage.get(pageNum);
      if (pageHighlights) {
        for (const h of pageHighlights) {
          lines.push(formatHighlight(h, pdfName, highlightOpts));
          lines.push('');
        }
      }

      // Drawings for this page (rendered below highlights)
      const drawingFilename = pageDrawings?.get(pageNum);
      if (drawingFilename) {
        lines.push(`![[${drawingFilename}|500]]`);
        lines.push('');
      }
    }
  } else {
    // Flat list: no page headers, just highlights in order
    const sortedPages = [...allPages].sort((a, b) => a - b);

    for (const pageNum of sortedPages) {
      const pageHighlights = byPage.get(pageNum);
      if (pageHighlights) {
        for (const h of pageHighlights) {
          lines.push(formatHighlight(h, pdfName, highlightOpts));
          lines.push('');
        }
      }

      const drawingFilename = pageDrawings?.get(pageNum);
      if (drawingFilename) {
        lines.push(`![[${drawingFilename}|500]]`);
        lines.push('');
      }
    }
  }

  lines.push(HIGHLIGHTS_SECTION_END);
  return lines.join('\n');
}


/**
 * Generate a safe filename from a document's visible name.
 *
 * Removes characters that are invalid in file paths and replaces
 * spaces with hyphens for cleaner filenames.
 */
/**
 * Strip common file extensions (.pdf, .epub) from a document name.
 * reMarkable stores the full filename as visibleName for uploaded documents.
 */
function stripFileExtension(name: string): string {
  return name.replace(/\.(pdf|epub)$/i, '');
}

/**
 * Ensure a name has a .pdf extension (for building PDF++ links).
 * If it already ends in .pdf, return as-is. Otherwise append .pdf.
 */
function ensurePdfExtension(name: string): string {
  if (/\.pdf$/i.test(name)) return name;
  return `${name}.pdf`;
}

/**
 * Convert page tags (keyed by page UUID) to page tags keyed by page number.
 */
function buildPageTagsByNumber(
  pageTags: Record<string, string[]>,
  pageUuids: string[],
): Map<number, string[]> {
  const result = new Map<number, string[]>();
  for (const [pageUuid, tags] of Object.entries(pageTags)) {
    const pageIndex = pageUuids.indexOf(pageUuid);
    if (pageIndex !== -1) {
      result.set(pageIndex + 1, tags); // 1-indexed
    }
  }
  return result;
}

export function generateOutputFilename(visibleName: string): string {
  const sanitized = stripFileExtension(visibleName)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized) {
    return 'Untitled';
  }

  return sanitized;
}

/**
 * MarkdownRenderer implementation that uses the default template.
 */
export class DefaultMarkdownRenderer implements MarkdownRenderer {
  private options: RenderMarkdownOptions;

  constructor(
    sourceLabel?: string,
    includeColors = true,
    groupByPage = true,
    pdfLinkFormat: PdfLinkFormat = 'pdfpp',
    defaultTags: string[] = [],
  ) {
    this.options = { sourceLabel, includeColors, groupByPage, pdfLinkFormat, defaultTags };
  }

  render(result: ExtractionResult, sourcePdfName?: string, pageDrawings?: PageDrawings | null): string {
    return renderMarkdown(result, sourcePdfName, pageDrawings, this.options);
  }

  mergeWithExisting(
    existingContent: string,
    result: ExtractionResult,
    sourcePdfName?: string,
    pageDrawings?: PageDrawings | null,
  ): string {
    return mergeWithExistingNote(existingContent, result, sourcePdfName, pageDrawings, this.options);
  }
}

// Export markers for testing
export { HIGHLIGHTS_SECTION_START, HIGHLIGHTS_SECTION_END };
