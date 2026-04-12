/**
 * Shared xochitl directory scanner.
 *
 * Provides a common function to scan the reMarkable's xochitl metadata
 * directory and return PDF documents with their extracted highlights.
 * Both the review data service and highlight inbox generator use this
 * to avoid duplicating the filesystem scanning logic.
 *
 * Privacy: Pure local filesystem operations. Zero network calls.
 */

import * as path from 'path';
import { logger } from '../utils/logger';
import type { ExtractedHighlight } from '../pipeline/types';
import { sanitizeFilename } from './helpers';
import { parseHighlightsFromNote } from './review-data';

// -------------------------------------------------------------------
// Shared types for xochitl metadata
// -------------------------------------------------------------------

/** Raw metadata JSON shape from .metadata files. */
export interface MetadataJson {
  visibleName?: string;
  parent?: string;
  type?: string;
  lastModified?: string;
  deleted?: boolean;
}

/** Raw content JSON shape from .content files. */
export interface ContentJson {
  fileType?: string;
}

// -------------------------------------------------------------------
// Filesystem abstraction for testability
// -------------------------------------------------------------------

/**
 * Filesystem operations required by the xochitl scanner.
 *
 * Callers can provide a mock implementation for testing.
 * The default implementation uses Node's `fs` module.
 */
export interface ScannerFileSystem {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf-8'): string;
  readdirSync(path: string): string[];
}

/** Default filesystem implementation using Node's fs module. */
export function createNodeFileSystem(): ScannerFileSystem {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  return {
    existsSync: (p: string) => fs.existsSync(p),
    readFileSync: (p: string, encoding: 'utf-8') => fs.readFileSync(p, encoding),
    readdirSync: (p: string) => fs.readdirSync(p) as unknown as string[],
  };
}

// -------------------------------------------------------------------
// Scanned document result
// -------------------------------------------------------------------

/** A document found by the scanner with its highlights and metadata. */
export interface ScannedDocument {
  /** Document UUID (basename of .metadata file). */
  uuid: string;
  /** Human-readable name from metadata. */
  visibleName: string;
  /** Source PDF filename (visibleName + ".pdf"). */
  sourcePdfName: string;
  /** Last modified timestamp from metadata (epoch ms). */
  lastModified: number;
  /** Highlights parsed from the extracted note. */
  highlights: ExtractedHighlight[];
  /** Content of the extracted note file. */
  noteContent: string;
}

// -------------------------------------------------------------------
// Scanner function
// -------------------------------------------------------------------

/**
 * Scan the xochitl directory for PDF documents that have extracted
 * highlight notes in the output folder.
 *
 * Returns an array of ScannedDocument objects sorted by lastModified
 * (most recent first). Both `buildReviewData()` and
 * `generateHighlightInbox()` delegate their filesystem work to this
 * function.
 *
 * @param xochitlPath - Path to synced xochitl directory
 * @param outputPath - Path to the output folder with markdown notes
 * @param fileSystem - Filesystem abstraction (defaults to Node fs)
 */
export function scanDocumentsWithHighlights(
  xochitlPath: string,
  outputPath: string,
  fileSystem?: ScannerFileSystem,
): ScannedDocument[] {
  const fs = fileSystem ?? createNodeFileSystem();

  if (!xochitlPath || !fs.existsSync(xochitlPath)) {
    logger.warn(`Scanner: xochitl path not found: ${xochitlPath}`);
    return [];
  }

  if (!outputPath || !fs.existsSync(outputPath)) {
    logger.warn(`Scanner: output path not found: ${outputPath}`);
    return [];
  }

  const results: ScannedDocument[] = [];
  const entries = fs.readdirSync(xochitlPath);

  for (const entry of entries) {
    if (!entry.endsWith('.metadata')) continue;

    const metaPath = path.join(xochitlPath, entry);
    let meta: MetadataJson;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      continue;
    }

    if (meta.deleted) continue;
    if (meta.type === 'CollectionType') continue; // Skip folders

    const uuid = path.basename(entry, '.metadata');
    const visibleName = meta.visibleName ?? 'Untitled';

    // Check content type -- only process PDFs
    const contentPath = path.join(xochitlPath, `${uuid}.content`);
    if (fs.existsSync(contentPath)) {
      try {
        const content: ContentJson = JSON.parse(
          fs.readFileSync(contentPath, 'utf-8'),
        );
        if (content.fileType && content.fileType.toLowerCase() !== 'pdf') {
          continue;
        }
      } catch {
        // Assume PDF if .content cannot be read
      }
    }

    // Check if we have an extracted note for this document
    const safeName = sanitizeFilename(visibleName);
    const notePath = path.join(outputPath, `${safeName}.md`);
    if (!fs.existsSync(notePath)) continue;

    // Read the note content
    let noteContent: string;
    try {
      noteContent = fs.readFileSync(notePath, 'utf-8');
    } catch {
      continue;
    }

    const highlights = parseHighlightsFromNote(noteContent);
    if (highlights.length === 0) continue;

    const lastModified = parseInt(meta.lastModified ?? '0', 10);

    results.push({
      uuid,
      visibleName,
      sourcePdfName: `${visibleName}.pdf`,
      lastModified,
      highlights,
      noteContent,
    });
  }

  // Sort by most recent first
  results.sort((a, b) => b.lastModified - a.lastModified);

  return results;
}
