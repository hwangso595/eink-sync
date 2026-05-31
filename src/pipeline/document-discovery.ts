/**
 * Discover reMarkable documents by scanning the synced xochitl directory.
 *
 * The xochitl filesystem stores documents as flat UUID-named files:
 *   {uuid}.metadata  -- JSON with visibleName, parent UUID, type
 *   {uuid}.content   -- JSON with page UUIDs, file format
 *   {uuid}/          -- Directory with per-page .rm annotation files
 *   {uuid}.pdf       -- Source PDF file (for PDF documents)
 *
 * This module reads those files to build a structured document list with
 * reconstructed folder paths. It implements the DocumentDiscovery interface
 * defined in pipeline/types.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReMarkableDocument, DocumentDiscovery } from './types';
import { logger } from '../utils/logger';

/** Raw JSON shape of a .metadata file. */
interface MetadataJson {
  visibleName?: string;
  parent?: string;
  type?: string;
  lastModified?: string;
  deleted?: boolean;
  pinned?: boolean;
  version?: number;
}

/** Raw JSON shape of a .content file. */
interface ContentJson {
  fileType?: string;
  pageCount?: number;
  pages?: string[];
  orientation?: string;
  cPages?: {
    pages?: Array<{ id?: string; uuid?: string; deleted?: boolean }>;
  };
}

/** Parsed metadata for a single xochitl entry. */
interface ParsedMetadata {
  uuid: string;
  visibleName: string;
  parentUuid: string;
  docType: string;
  lastModified: number;
  deleted: boolean;
}

/** Parsed content info for a single document. */
interface ParsedContent {
  uuid: string;
  fileType: string;
  pageCount: number;
  pageUuids: string[];
}

/**
 * Parse a .metadata JSON file.
 *
 * @returns Parsed metadata or null if the file is missing/malformed.
 */
function parseMetadataFile(filePath: string): ParsedMetadata | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: MetadataJson = JSON.parse(raw);
    const basename = path.basename(filePath, '.metadata');

    return {
      uuid: basename,
      visibleName: data.visibleName ?? 'Untitled',
      parentUuid: data.parent ?? '',
      docType: data.type ?? 'DocumentType',
      lastModified: parseInt(data.lastModified ?? '0', 10),
      deleted: data.deleted ?? false,
    };
  } catch {
    logger.warn(`Failed to parse metadata: ${filePath}`);
    return null;
  }
}

/**
 * Parse a .content JSON file to get page UUIDs and format info.
 *
 * Handles both legacy (pages array) and v6 (cPages structure) formats.
 */
function parseContentFile(filePath: string): ParsedContent | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: ContentJson = JSON.parse(raw);
    const basename = path.basename(filePath, '.content');

    let pageUuids: string[] = [];

    // v6 format: cPages.pages[].id
    if (data.cPages?.pages) {
      pageUuids = data.cPages.pages
        .filter((p) => !p.deleted)
        .map((p) => p.id ?? p.uuid ?? '')
        .filter((id) => id !== '');
    }
    // Legacy format: pages array
    else if (data.pages) {
      pageUuids = data.pages;
    }

    return {
      uuid: basename,
      fileType: data.fileType ?? '',
      pageCount: data.pageCount ?? pageUuids.length,
      pageUuids,
    };
  } catch {
    logger.warn(`Failed to parse content: ${filePath}`);
    return null;
  }
}

/**
 * Scan the xochitl directory and return all non-deleted PDF documents.
 *
 * Implements the DocumentDiscovery interface from pipeline/types.ts.
 */
export class XochitlDocumentDiscovery implements DocumentDiscovery {
  async discoverDocuments(xochitlPath: string): Promise<ReMarkableDocument[]> {
    return discoverDocuments(xochitlPath);
  }
}

/**
 * Scan the synced xochitl directory and return all non-deleted PDF documents
 * with reconstructed folder paths and page UUID lists.
 *
 * @param xochitlPath - Absolute path to the synced xochitl directory.
 * @returns Array of ReMarkableDocument objects for all PDF documents found.
 */
export function discoverDocuments(xochitlPath: string): ReMarkableDocument[] {
  if (!fs.existsSync(xochitlPath) || !fs.statSync(xochitlPath).isDirectory()) {
    logger.warn(`xochitl path does not exist or is not a directory: ${xochitlPath}`);
    return [];
  }

  const entries = fs.readdirSync(xochitlPath);

  // Phase 1: Parse all .metadata files
  const metadataMap = new Map<string, ParsedMetadata>();
  for (const entry of entries) {
    if (!entry.endsWith('.metadata')) continue;
    if (entry.includes('sync-conflict') || entry.includes('.syncthing.')) continue;
    const meta = parseMetadataFile(path.join(xochitlPath, entry));
    if (meta && !meta.deleted) {
      metadataMap.set(meta.uuid, meta);
    }
  }

  // Phase 2: Parse .content files for non-deleted documents.
  // Track two distinct failure modes so Phase 3 can give the user an
  // actionable signal instead of silently dropping the document:
  //   - content file absent  -> doc not yet flushed (still open on tablet)
  //   - content file present but unparseable -> torn/partial sync
  const contentMap = new Map<string, ParsedContent>();
  const corruptContent = new Set<string>();
  for (const uuid of metadataMap.keys()) {
    const contentPath = path.join(xochitlPath, `${uuid}.content`);
    if (fs.existsSync(contentPath)) {
      const content = parseContentFile(contentPath);
      if (content) {
        contentMap.set(uuid, content);
      } else {
        corruptContent.add(uuid);
      }
    }
  }

  // Phase 3: Build document list (PDFs and EPUBs)
  const documents: ReMarkableDocument[] = [];
  for (const [uuid, meta] of metadataMap) {
    if (meta.docType === 'CollectionType') continue;

    const content = contentMap.get(uuid);
    if (!content) {
      // The document is on the tablet but has no usable .content yet. Tell the
      // user why it won't appear, instead of dropping it silently.
      if (corruptContent.has(uuid)) {
        logger.warn(
          `Document "${meta.visibleName}" (${uuid}) has a partial/corrupt .content file ` +
          `— likely mid-sync. It will be picked up on the next sync once the file finishes transferring.`,
        );
      } else {
        logger.warn(
          `Document "${meta.visibleName}" (${uuid}) is on the tablet but its content isn't flushed yet. ` +
          `Close the document on the tablet, then sync again so it can be extracted.`,
        );
      }
      continue;
    }

    const isPdf = content.fileType === 'pdf';
    const isEpub = content.fileType === 'epub';
    const isNotebook = content.fileType === 'notebook' || content.fileType === '';
    if (!isPdf && !isEpub && !isNotebook) continue;

    const hasPdf = fs.existsSync(path.join(xochitlPath, `${uuid}.pdf`));

    const docType = isNotebook ? 'notebook' : (isEpub ? 'epub' : 'pdf');

    documents.push({
      uuid,
      visibleName: meta.visibleName,
      parentUuid: meta.parentUuid,
      type: docType as 'pdf' | 'epub' | 'notebook',
      lastModified: meta.lastModified,
      pageCount: content.pageCount,
      pageUuids: content.pageUuids,
      hasPdf,
    });

    logger.debug(
      `Discovered: ${meta.visibleName} (${uuid}) [${docType}, ${content.pageCount} pages]`,
    );
  }

  logger.info(`Discovered ${documents.length} document(s) in ${xochitlPath}`);
  return documents;
}
