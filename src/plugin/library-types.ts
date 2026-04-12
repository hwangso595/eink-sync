/**
 * Type definitions for the Library View.
 *
 * These types model the document hierarchy reconstructed from
 * the flat UUID-based xochitl filesystem, as well as sync status
 * per document and across the library.
 */

import type { DocumentType } from '../pipeline/types';

/** Sync status for an individual document. */
export type DocumentSyncStatus =
  | 'synced'      // Up to date with tablet
  | 'pending'     // Modified on tablet, not yet synced
  | 'extracting'  // Currently being processed
  | 'error'       // Last extraction failed
  | 'archived'    // Moved to archive, not on tablet
  | 'unknown';    // No sync data available

/** A document entry in the library view. */
export interface LibraryDocument {
  /** UUID from xochitl. */
  uuid: string;
  /** Human-readable name from .metadata visibleName. */
  name: string;
  /** Document type. */
  type: DocumentType;
  /** Last modified timestamp (epoch ms). */
  lastModified: number;
  /** Number of extracted highlights (0 if none or not yet extracted). */
  highlightCount: number;
  /** Number of pages. */
  pageCount: number;
  /** Sync status for this document. */
  syncStatus: DocumentSyncStatus;
  /** Full reconstructed folder path (e.g., "Research/Papers"). */
  folderPath: string;
  /** Parent folder UUID. */
  parentUuid: string;
  /** Whether source PDF/EPUB file exists in sync folder. */
  hasSourceFile: boolean;
  /** Label of the sync source that produced this document (multi-source). */
  sourceLabel?: string;
  /** ID of the sync source (multi-source). */
  sourceId?: string;
}

/** A folder in the reconstructed hierarchy. */
export interface LibraryFolder {
  /** UUID of the folder from xochitl. */
  uuid: string;
  /** Display name. */
  name: string;
  /** Full path (e.g., "Research/Papers"). */
  path: string;
  /** Documents directly in this folder. */
  documents: LibraryDocument[];
  /** Child folders. */
  children: LibraryFolder[];
  /** Whether the folder is collapsed in the UI. */
  collapsed: boolean;
}

/** Sort options for the document list. */
export type SortField = 'name' | 'lastModified' | 'type' | 'highlightCount';
export type SortDirection = 'asc' | 'desc';

export interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

/** Overall library sync summary for the status bar. */
export interface LibrarySyncSummary {
  /** Total number of synced documents. */
  totalDocuments: number;
  /** Number of documents with pending changes. */
  pendingDocuments: number;
  /** Number of documents with extraction errors. */
  errorDocuments: number;
  /** Total highlights across all documents. */
  totalHighlights: number;
  /** Last sync timestamp (epoch ms) or null. */
  lastSyncTime: number | null;
  /** Whether the tablet connection is healthy. */
  connectionHealthy: boolean;
}
