/**
 * Library data service.
 *
 * Reads the synced xochitl directory and builds a structured folder
 * hierarchy for the library view. Extends the Sprint 3 document
 * discovery to support all document types (PDF, EPUB, notebook)
 * and reconstructs the folder tree from UUID parent references.
 *
 * Privacy: All data comes from the local synced folder. Zero network calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import type { DocumentType } from '../pipeline/types';
import { sanitizeFilename } from './helpers';
import type {
  LibraryDocument,
  LibraryFolder,
  LibrarySyncSummary,
  DocumentSyncStatus,
  SortConfig,
} from './library-types';

/** Raw JSON shape of a .metadata file. */
interface MetadataJson {
  visibleName?: string;
  parent?: string;
  type?: string;
  lastModified?: string;
  deleted?: boolean;
}

/** Raw JSON shape of a .content file. */
interface ContentJson {
  fileType?: string;
  pageCount?: number;
  pages?: string[];
  cPages?: {
    pages?: Array<{ id?: string; uuid?: string }>;
  };
}

/** Intermediate parsed entry before hierarchy reconstruction. */
interface ParsedEntry {
  uuid: string;
  visibleName: string;
  parentUuid: string;
  entryType: string; // 'CollectionType' for folders, 'DocumentType' for documents
  lastModified: number;
  deleted: boolean;
}

/**
 * Parse a .metadata JSON file.
 */
function parseMetadata(filePath: string): ParsedEntry | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: MetadataJson = JSON.parse(raw);
    const uuid = path.basename(filePath, '.metadata');
    return {
      uuid,
      visibleName: data.visibleName ?? 'Untitled',
      parentUuid: data.parent ?? '',
      entryType: data.type ?? 'DocumentType',
      lastModified: parseInt(data.lastModified ?? '0', 10),
      deleted: data.deleted ?? false,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a .content JSON file to determine document type and page count.
 */
function parseContent(filePath: string): { fileType: string; pageCount: number } | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: ContentJson = JSON.parse(raw);
    let pageCount = data.pageCount ?? 0;
    if (pageCount === 0) {
      if (data.cPages?.pages) {
        pageCount = data.cPages.pages.length;
      } else if (data.pages) {
        pageCount = data.pages.length;
      }
    }
    return {
      fileType: data.fileType ?? '',
      pageCount,
    };
  } catch {
    return null;
  }
}

/**
 * Map xochitl fileType string to our DocumentType.
 */
function resolveDocumentType(fileType: string): DocumentType {
  switch (fileType.toLowerCase()) {
    case 'pdf':
      return 'pdf';
    case 'epub':
      return 'epub';
    default:
      return 'notebook';
  }
}

/**
 * Reconstruct the full folder path for an entry by walking up the parent chain.
 */
function buildFolderPath(
  uuid: string,
  folderMap: Map<string, ParsedEntry>,
  cache: Map<string, string>,
): string {
  if (cache.has(uuid)) return cache.get(uuid)!;

  const entry = folderMap.get(uuid);
  if (!entry || !entry.parentUuid || entry.parentUuid === '' || entry.parentUuid === 'trash') {
    const result = entry?.visibleName ?? '';
    cache.set(uuid, result);
    return result;
  }

  const parentPath = buildFolderPath(entry.parentUuid, folderMap, cache);
  const result = parentPath ? `${parentPath}/${entry.visibleName}` : entry.visibleName;
  cache.set(uuid, result);
  return result;
}

/**
 * Count extracted highlights for a document by checking if an output
 * note exists and counting blockquotes in the highlights section.
 *
 * This is a lightweight heuristic -- it counts "> " lines between
 * the managed highlights markers.
 */
function countHighlightsForDocument(
  visibleName: string,
  outputPath: string | null,
): number {
  if (!outputPath) return 0;

  const safeName = sanitizeFilename(visibleName);
  const filePath = path.join(outputPath, `${safeName}.md`);

  try {
    if (!fs.existsSync(filePath)) return 0;
    const content = fs.readFileSync(filePath, 'utf-8');
    // Read highlight_count from frontmatter
    const match = content.match(/^highlight_count:\s*(\d+)$/m);
    if (match) {
      return parseInt(match[1], 10);
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Scan the xochitl directory and build a complete library of documents
 * grouped by reconstructed folder hierarchy.
 *
 * Unlike Sprint 3's discoverDocuments (which only finds PDFs), this
 * returns all document types: PDF, EPUB, and notebook.
 */
export function buildLibrary(
  xochitlPath: string,
  outputPath: string | null,
): { documents: LibraryDocument[]; folders: LibraryFolder } {
  const emptyRoot: LibraryFolder = {
    uuid: '',
    name: 'My reMarkable',
    path: '',
    documents: [],
    children: [],
    collapsed: false,
  };

  if (!xochitlPath || !fs.existsSync(xochitlPath) || !fs.statSync(xochitlPath).isDirectory()) {
    logger.warn(`Library: xochitl path not found: ${xochitlPath}`);
    return { documents: [], folders: emptyRoot };
  }

  const entries = fs.readdirSync(xochitlPath);

  // Phase 1: Parse all .metadata files
  const allEntries = new Map<string, ParsedEntry>();
  for (const entry of entries) {
    if (!entry.endsWith('.metadata')) continue;
    if (entry.includes('sync-conflict')) continue;
    const meta = parseMetadata(path.join(xochitlPath, entry));
    if (meta && !meta.deleted) {
      allEntries.set(meta.uuid, meta);
    }
  }

  // Phase 2: Separate folders from documents
  const folderEntries = new Map<string, ParsedEntry>();
  const documentEntries = new Map<string, ParsedEntry>();
  for (const [uuid, entry] of allEntries) {
    if (entry.entryType === 'CollectionType') {
      folderEntries.set(uuid, entry);
    } else {
      documentEntries.set(uuid, entry);
    }
  }

  // Phase 3: Build folder path cache
  const pathCache = new Map<string, string>();

  // Phase 4: Build document list
  const documents: LibraryDocument[] = [];
  for (const [uuid, meta] of documentEntries) {
    const contentPath = path.join(xochitlPath, `${uuid}.content`);
    const content = fs.existsSync(contentPath)
      ? parseContent(contentPath)
      : null;

    const docType = resolveDocumentType(content?.fileType ?? '');

    // Check for source file
    const hasSourceFile =
      (docType === 'pdf' && fs.existsSync(path.join(xochitlPath, `${uuid}.pdf`))) ||
      (docType === 'epub' && fs.existsSync(path.join(xochitlPath, `${uuid}.epub`)));

    // Build folder path for this document
    let folderPath = '';
    if (meta.parentUuid && meta.parentUuid !== '' && meta.parentUuid !== 'trash') {
      folderPath = buildFolderPath(meta.parentUuid, folderEntries, pathCache);
    }

    const highlightCount = countHighlightsForDocument(meta.visibleName, outputPath);

    documents.push({
      uuid,
      name: meta.visibleName,
      type: docType,
      lastModified: meta.lastModified,
      highlightCount,
      pageCount: content?.pageCount ?? 0,
      // KNOWN LIMITATION: syncStatus is hardcoded to 'synced' for all documents.
      // The type system, view layer, and sync summary all support the full range
      // of statuses (synced, pending, extracting, error, unknown), but actual
      // status detection requires Syncthing event API integration which is not
      // yet implemented. This will be addressed when Syncthing event API
      // integration is added in a future sprint. Until then, pending/error
      // counts in the status modal will always be 0.
      syncStatus: 'synced' as DocumentSyncStatus,
      folderPath,
      parentUuid: meta.parentUuid,
      hasSourceFile,
    });
  }

  // Phase 5: Build folder tree
  const root = buildFolderTree(folderEntries, documents, pathCache);

  logger.info(
    `Library built: ${documents.length} documents in ${folderEntries.size} folders`,
  );

  return { documents, folders: root };
}

/**
 * Build a nested folder tree from the flat folder entries and documents.
 */
function buildFolderTree(
  folderEntries: Map<string, ParsedEntry>,
  documents: LibraryDocument[],
  pathCache: Map<string, string>,
): LibraryFolder {
  const root: LibraryFolder = {
    uuid: '',
    name: 'My reMarkable',
    path: '',
    documents: [],
    children: [],
    collapsed: false,
  };

  // Create LibraryFolder for each folder entry
  const folderNodes = new Map<string, LibraryFolder>();
  for (const [uuid, entry] of folderEntries) {
    const folderPath = buildFolderPath(uuid, folderEntries, pathCache);
    folderNodes.set(uuid, {
      uuid,
      name: entry.visibleName,
      path: folderPath,
      documents: [],
      children: [],
      collapsed: true,
    });
  }

  // Assign documents to their parent folders
  for (const doc of documents) {
    if (!doc.parentUuid || doc.parentUuid === '') {
      root.documents.push(doc);
    } else {
      const parentFolder = folderNodes.get(doc.parentUuid);
      if (parentFolder) {
        parentFolder.documents.push(doc);
      } else {
        // Orphaned document -- place in root
        root.documents.push(doc);
      }
    }
  }

  // Build folder parent-child relationships
  for (const [uuid, entry] of folderEntries) {
    const node = folderNodes.get(uuid)!;
    if (!entry.parentUuid || entry.parentUuid === '') {
      root.children.push(node);
    } else {
      const parent = folderNodes.get(entry.parentUuid);
      if (parent) {
        parent.children.push(node);
      } else {
        root.children.push(node);
      }
    }
  }

  // Sort children and documents alphabetically
  sortFolderRecursive(root);

  return root;
}

/**
 * Recursively sort folder children and documents by name.
 */
function sortFolderRecursive(folder: LibraryFolder): void {
  folder.children.sort((a, b) => a.name.localeCompare(b.name));
  folder.documents.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of folder.children) {
    sortFolderRecursive(child);
  }
}

/**
 * Sort documents by the given configuration.
 */
export function sortDocuments(
  documents: LibraryDocument[],
  sort: SortConfig,
): LibraryDocument[] {
  const sorted = [...documents];
  const dir = sort.direction === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    switch (sort.field) {
      case 'name':
        return dir * a.name.localeCompare(b.name);
      case 'lastModified':
        return dir * (a.lastModified - b.lastModified);
      case 'type':
        return dir * a.type.localeCompare(b.type);
      case 'highlightCount':
        return dir * (a.highlightCount - b.highlightCount);
      default:
        return 0;
    }
  });

  return sorted;
}

/**
 * Filter documents by a search query.
 * Matches against document name (case-insensitive).
 */
export function filterDocuments(
  documents: LibraryDocument[],
  query: string,
): LibraryDocument[] {
  if (!query.trim()) return documents;
  const lower = query.toLowerCase();
  return documents.filter(
    (doc) =>
      doc.name.toLowerCase().includes(lower) ||
      doc.folderPath.toLowerCase().includes(lower),
  );
}

/**
 * Build a sync summary from the current library state.
 */
export function buildSyncSummary(
  documents: LibraryDocument[],
  lastSyncTime: number | null,
  connectionHealthy: boolean,
): LibrarySyncSummary {
  return {
    totalDocuments: documents.length,
    pendingDocuments: documents.filter((d) => d.syncStatus === 'pending').length,
    errorDocuments: documents.filter((d) => d.syncStatus === 'error').length,
    totalHighlights: documents.reduce((sum, d) => sum + d.highlightCount, 0),
    lastSyncTime,
    connectionHealthy,
  };
}
