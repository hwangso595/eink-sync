/**
 * Review data service.
 *
 * Builds the list of reviewable documents and highlights by comparing
 * the extraction pipeline output against the persisted review state.
 *
 * Highlights that have been accepted or dismissed in previous sessions
 * are excluded from the pending list. Dismissed highlights can be
 * restored.
 *
 * Privacy: Pure computation on local data. Zero network calls.
 */

import type { ExtractedHighlight } from '../pipeline/types';
import {
  findHighlightsStart,
  findHighlightsEnd,
} from './highlight-markers';
import {
  scanDocumentsWithHighlights,
  type ScannerFileSystem,
} from './xochitl-scanner';
import type {
  ReviewableHighlight,
  ReviewableDocument,
  ReviewSummary,
  PersistedReviewState,
  HighlightReviewStatus,
} from './review-types';

// -------------------------------------------------------------------
// Highlight ID generation
// -------------------------------------------------------------------

/**
 * Generate a stable ID for a highlight.
 *
 * Uses document UUID + page number + a hash of the highlight text
 * to create a deterministic identifier that survives re-extraction.
 */
export function generateHighlightId(
  documentUuid: string,
  highlight: ExtractedHighlight,
): string {
  // Simple string hash for text identity
  const textHash = simpleHash(highlight.text);
  return `${documentUuid}:p${highlight.pageNumber}:${textHash}`;
}

/**
 * Simple non-cryptographic string hash (djb2).
 * Only used for generating stable IDs, not for security.
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// -------------------------------------------------------------------
// Highlight parsing from existing notes
// -------------------------------------------------------------------

/**
 * Parse highlights from an existing markdown note.
 *
 * Reads the section between the highlight markers and extracts
 * blockquote-based highlights with their page numbers. Accepts both
 * current and legacy markers transparently.
 */
export function parseHighlightsFromNote(
  noteContent: string,
): ExtractedHighlight[] {
  const start = findHighlightsStart(noteContent);
  const end = findHighlightsEnd(noteContent);
  if (!start || !end) return [];

  const section = noteContent.substring(
    start.index + start.marker.length,
    end.index,
  );

  const highlights: ExtractedHighlight[] = [];
  const lines = section.split('\n');
  let currentText = '';
  let currentPage = 0;

  for (const line of lines) {
    if (line.startsWith('> ')) {
      const content = line.substring(2);

      // Check if this is the page reference line (e.g., "-- [[file.pdf#page=5|Page 5]]")
      const pageMatch = content.match(/^--\s+.*(?:#page[=]?)(\d+)/);
      if (pageMatch) {
        currentPage = parseInt(pageMatch[1], 10);
        // Commit the highlight
        if (currentText.trim()) {
          highlights.push({
            text: currentText.trim(),
            pageNumber: currentPage,
            color: null,
            bounds: null,
            createdAt: null,
          });
        }
        currentText = '';
        currentPage = 0;
      } else {
        // Accumulate text lines
        if (currentText) currentText += '\n';
        currentText += content;
      }
    } else if (line.startsWith('### Page ')) {
      // Page header -- reset for new page group
      const pageMatch = line.match(/^### Page (\d+)/);
      if (pageMatch) {
        currentPage = parseInt(pageMatch[1], 10);
      }
    }
  }

  return highlights;
}

// -------------------------------------------------------------------
// Build review data
// -------------------------------------------------------------------

/**
 * Scan the output folder for documents with highlights and build
 * the review data set.
 *
 * Delegates filesystem scanning to `scanDocumentsWithHighlights()` to
 * avoid duplicating xochitl traversal logic with highlight-inbox.ts.
 *
 * @param xochitlPath - Path to synced xochitl directory
 * @param outputPath - Path to the output folder with markdown notes
 * @param reviewState - Persisted review state (accepted/dismissed history)
 * @param fileSystem - Optional filesystem abstraction for testing
 */
export function buildReviewData(
  xochitlPath: string,
  outputPath: string,
  reviewState: PersistedReviewState,
  fileSystem?: ScannerFileSystem,
): ReviewableDocument[] {
  const scanned = scanDocumentsWithHighlights(
    xochitlPath,
    outputPath,
    fileSystem,
  );

  const reviewDocs: ReviewableDocument[] = [];

  for (const doc of scanned) {
    const reviewableHighlights: ReviewableHighlight[] = [];

    for (const h of doc.highlights) {
      const id = generateHighlightId(doc.uuid, h);

      // Check persisted review state
      const existingStatus = reviewState.reviewedHighlights[id];
      if (existingStatus === 'accepted' || existingStatus === 'edited') {
        // Already accepted -- skip
        continue;
      }

      const status: HighlightReviewStatus = existingStatus ?? 'pending';

      reviewableHighlights.push({
        id,
        highlight: h,
        status,
        editedText: null,
        documentUuid: doc.uuid,
        documentName: doc.visibleName,
        sourcePdfName: doc.sourcePdfName,
      });
    }

    if (reviewableHighlights.length === 0) continue;

    const pendingCount = reviewableHighlights.filter(
      (h) => h.status === 'pending',
    ).length;

    reviewDocs.push({
      uuid: doc.uuid,
      name: doc.visibleName,
      sourcePdfName: doc.sourcePdfName,
      lastModified: doc.lastModified,
      highlights: reviewableHighlights,
      pendingCount,
    });
  }

  return reviewDocs;
}

/**
 * Build a summary of the current review state.
 */
export function buildReviewSummary(
  documents: ReviewableDocument[],
): ReviewSummary {
  let totalPending = 0;
  let totalAccepted = 0;
  let totalDismissed = 0;
  let documentsWithPending = 0;

  for (const doc of documents) {
    let hasPending = false;
    for (const h of doc.highlights) {
      switch (h.status) {
        case 'pending':
          totalPending++;
          hasPending = true;
          break;
        case 'accepted':
        case 'edited':
          totalAccepted++;
          break;
        case 'dismissed':
          totalDismissed++;
          break;
      }
    }
    if (hasPending) documentsWithPending++;
  }

  return {
    documentsWithPending,
    totalPending,
    totalAccepted,
    totalDismissed,
  };
}

/**
 * Apply a review action to a highlight and return the updated state.
 */
export function applyReviewAction(
  highlight: ReviewableHighlight,
  action: 'accept' | 'dismiss' | 'undo',
  editedText?: string,
): ReviewableHighlight {
  switch (action) {
    case 'accept':
      return {
        ...highlight,
        status: editedText ? 'edited' : 'accepted',
        editedText: editedText ?? null,
      };
    case 'dismiss':
      return {
        ...highlight,
        status: 'dismissed',
      };
    case 'undo':
      return {
        ...highlight,
        status: 'pending',
        editedText: null,
      };
    default:
      return highlight;
  }
}

/**
 * Build the content for accepted highlights to append to a literature note.
 *
 * Only includes highlights that are in 'accepted' or 'edited' state.
 * Uses the existing blockquote + PDF++ link format for consistency.
 */
export function renderAcceptedHighlights(
  highlights: ReviewableHighlight[],
): string {
  const accepted = highlights.filter(
    (h) => h.status === 'accepted' || h.status === 'edited',
  );

  if (accepted.length === 0) return '';

  const lines: string[] = [];

  for (const rh of accepted) {
    const text = rh.editedText ?? rh.highlight.text;
    const quotedLines = text.split('\n').map((l) => `> ${l}`);
    lines.push(...quotedLines);
    lines.push(`> -- ${formatPdfLinkSimple(rh.sourcePdfName, rh.highlight.pageNumber)}`);

    if (rh.highlight.color && rh.highlight.color !== 'yellow') {
      lines.push(`<!-- highlight-color: ${rh.highlight.color} -->`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Simple PDF++ link formatter for review output.
 */
function formatPdfLinkSimple(pdfName: string, page: number): string {
  return `[[${pdfName}#page=${page}|Page ${page}]]`;
}
