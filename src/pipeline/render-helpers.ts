/**
 * Small rendering helpers shared by the two markdown renderers
 * (markdown-renderer.ts and template-engine.ts).
 *
 * These were previously duplicated byte-for-byte in both files; keeping a
 * single source of truth avoids the two output paths silently drifting
 * (e.g. a PDF-link format change applied to one renderer but not the other).
 */

import type { PdfLinkFormat } from '../plugin/settings';

/**
 * Format a PDF page link according to the configured format.
 *
 * - `pdfpp`   -> `[[doc.pdf#page=5|Page 5]]` (PDF++ syntax; the default)
 * - `obsidian`-> `[[doc.pdf#page5|Page 5]]` (Obsidian native PDF anchor)
 * - `none`    -> `Page 5` (no link)
 */
export function formatPdfLink(
  pdfName: string,
  pageNumber: number,
  format: PdfLinkFormat,
): string {
  switch (format) {
    case 'pdfpp':
      return `[[${pdfName}#page=${pageNumber}|Page ${pageNumber}]]`;
    case 'obsidian':
      return `[[${pdfName}#page${pageNumber}|Page ${pageNumber}]]`;
    case 'none':
      return `Page ${pageNumber}`;
    default:
      return `[[${pdfName}#page=${pageNumber}|Page ${pageNumber}]]`;
  }
}

/**
 * Derive the note's `date` field (YYYY-MM-DD) from a document's lastModified
 * timestamp. Using the tablet's own timestamp keeps the value deterministic so
 * the same vault synced across machines doesn't produce conflicting dates.
 * Falls back to "today" only when no lastModified is available.
 */
export function formatHighlightDate(lastModifiedEpochMs: number): string {
  const date = lastModifiedEpochMs > 0
    ? new Date(lastModifiedEpochMs)
    : new Date();
  return date.toISOString().split('T')[0];
}

/** Frontmatter `highlight_count:` line, matched anywhere in the block. */
const HIGHLIGHT_COUNT_RE = /^highlight_count:\s*\d+$/m;

/**
 * Replace the `highlight_count:` value in a note's frontmatter, if present.
 * Returns the content unchanged when there is no such line.
 */
export function updateFrontmatterHighlightCount(content: string, newCount: number): string {
  return content.replace(HIGHLIGHT_COUNT_RE, `highlight_count: ${newCount}`);
}
