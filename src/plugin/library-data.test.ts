/**
 * Tests for the library data service.
 *
 * Verifies:
 * - Document discovery across all types (PDF, EPUB, notebook)
 * - Folder hierarchy reconstruction from UUID parent references
 * - Sorting and filtering
 * - Edge cases: missing files, deleted entries, orphaned documents
 * - Sync summary computation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildLibrary,
  sortDocuments,
  filterDocuments,
  buildSyncSummary,
} from './library-data';
import type { LibraryDocument, SortConfig } from './library-types';

/** Create a temp directory for test fixtures. */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rm-lib-test-'));
}

/** Write a .metadata file. */
function writeMetadata(
  dir: string,
  uuid: string,
  opts: {
    visibleName?: string;
    parent?: string;
    type?: string;
    lastModified?: string;
    deleted?: boolean;
  },
): void {
  const data = {
    visibleName: opts.visibleName ?? 'Untitled',
    parent: opts.parent ?? '',
    type: opts.type ?? 'DocumentType',
    lastModified: opts.lastModified ?? '1700000000000',
    deleted: opts.deleted ?? false,
  };
  fs.writeFileSync(path.join(dir, `${uuid}.metadata`), JSON.stringify(data));
}

/** Write a .content file. */
function writeContent(
  dir: string,
  uuid: string,
  opts: { fileType?: string; pageCount?: number; pages?: string[] },
): void {
  const data = {
    fileType: opts.fileType ?? 'pdf',
    pageCount: opts.pageCount ?? 1,
    pages: opts.pages ?? ['page-1'],
  };
  fs.writeFileSync(path.join(dir, `${uuid}.content`), JSON.stringify(data));
}

/** Clean up temp directory. */
function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('buildLibrary', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('returns empty results for nonexistent path', () => {
    const { documents, folders } = buildLibrary('/nonexistent/path', null);
    expect(documents).toHaveLength(0);
    expect(folders.name).toBe('My reMarkable');
  });

  it('returns empty results for empty directory', () => {
    const { documents } = buildLibrary(tmpDir, null);
    expect(documents).toHaveLength(0);
  });

  it('discovers a PDF document', () => {
    writeMetadata(tmpDir, 'doc-1', { visibleName: 'Test Paper', type: 'DocumentType' });
    writeContent(tmpDir, 'doc-1', { fileType: 'pdf', pageCount: 5 });
    // Create a fake PDF file
    fs.writeFileSync(path.join(tmpDir, 'doc-1.pdf'), 'fake pdf');

    const { documents } = buildLibrary(tmpDir, null);
    expect(documents).toHaveLength(1);
    expect(documents[0].name).toBe('Test Paper');
    expect(documents[0].type).toBe('pdf');
    expect(documents[0].pageCount).toBe(5);
    expect(documents[0].hasSourceFile).toBe(true);
  });

  it('discovers an EPUB document', () => {
    writeMetadata(tmpDir, 'doc-2', { visibleName: 'My Book', type: 'DocumentType' });
    writeContent(tmpDir, 'doc-2', { fileType: 'epub', pageCount: 100 });
    fs.writeFileSync(path.join(tmpDir, 'doc-2.epub'), 'fake epub');

    const { documents } = buildLibrary(tmpDir, null);
    expect(documents).toHaveLength(1);
    expect(documents[0].type).toBe('epub');
    expect(documents[0].hasSourceFile).toBe(true);
  });

  it('discovers a notebook', () => {
    writeMetadata(tmpDir, 'doc-3', { visibleName: 'My Notebook', type: 'DocumentType' });
    writeContent(tmpDir, 'doc-3', { fileType: '', pageCount: 3 });

    const { documents } = buildLibrary(tmpDir, null);
    expect(documents).toHaveLength(1);
    expect(documents[0].type).toBe('notebook');
    expect(documents[0].hasSourceFile).toBe(false);
  });

  it('skips deleted documents', () => {
    writeMetadata(tmpDir, 'doc-4', { visibleName: 'Deleted', deleted: true });
    writeContent(tmpDir, 'doc-4', { fileType: 'pdf' });

    const { documents } = buildLibrary(tmpDir, null);
    expect(documents).toHaveLength(0);
  });

  it('skips CollectionType entries as documents', () => {
    writeMetadata(tmpDir, 'folder-1', { visibleName: 'Research', type: 'CollectionType' });

    const { documents } = buildLibrary(tmpDir, null);
    expect(documents).toHaveLength(0);
  });

  it('reconstructs folder hierarchy', () => {
    // Create folder
    writeMetadata(tmpDir, 'folder-1', {
      visibleName: 'Research',
      type: 'CollectionType',
      parent: '',
    });

    // Create subfolder
    writeMetadata(tmpDir, 'folder-2', {
      visibleName: 'Papers',
      type: 'CollectionType',
      parent: 'folder-1',
    });

    // Document in subfolder
    writeMetadata(tmpDir, 'doc-5', {
      visibleName: 'Important Paper',
      type: 'DocumentType',
      parent: 'folder-2',
    });
    writeContent(tmpDir, 'doc-5', { fileType: 'pdf' });

    const { documents, folders } = buildLibrary(tmpDir, null);
    expect(documents).toHaveLength(1);
    expect(documents[0].folderPath).toBe('Research/Papers');

    // Check folder tree
    expect(folders.children).toHaveLength(1);
    expect(folders.children[0].name).toBe('Research');
    expect(folders.children[0].children).toHaveLength(1);
    expect(folders.children[0].children[0].name).toBe('Papers');
    expect(folders.children[0].children[0].documents).toHaveLength(1);
  });

  it('places root-level documents in the root folder', () => {
    writeMetadata(tmpDir, 'doc-6', {
      visibleName: 'Root Doc',
      parent: '',
    });
    writeContent(tmpDir, 'doc-6', { fileType: 'pdf' });

    const { folders } = buildLibrary(tmpDir, null);
    expect(folders.documents).toHaveLength(1);
    expect(folders.documents[0].name).toBe('Root Doc');
  });

  it('handles orphaned documents (parent folder deleted)', () => {
    writeMetadata(tmpDir, 'doc-7', {
      visibleName: 'Orphan',
      parent: 'nonexistent-folder',
    });
    writeContent(tmpDir, 'doc-7', { fileType: 'pdf' });

    const { documents, folders } = buildLibrary(tmpDir, null);
    expect(documents).toHaveLength(1);
    // Orphaned docs go to root
    expect(folders.documents).toHaveLength(1);
  });

  it('handles malformed .metadata files gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.metadata'), 'not json');
    writeMetadata(tmpDir, 'good', { visibleName: 'Good Doc' });
    writeContent(tmpDir, 'good', { fileType: 'pdf' });

    const { documents } = buildLibrary(tmpDir, null);
    expect(documents).toHaveLength(1);
  });

  it('discovers multiple document types in one library', () => {
    writeMetadata(tmpDir, 'd1', { visibleName: 'PDF Doc' });
    writeContent(tmpDir, 'd1', { fileType: 'pdf' });

    writeMetadata(tmpDir, 'd2', { visibleName: 'EPUB Doc' });
    writeContent(tmpDir, 'd2', { fileType: 'epub' });

    writeMetadata(tmpDir, 'd3', { visibleName: 'Notebook' });
    writeContent(tmpDir, 'd3', { fileType: '' });

    const { documents } = buildLibrary(tmpDir, null);
    expect(documents).toHaveLength(3);
    const types = documents.map((d) => d.type).sort();
    expect(types).toEqual(['epub', 'notebook', 'pdf']);
  });
});

describe('sortDocuments', () => {
  const docs: LibraryDocument[] = [
    {
      uuid: '1', name: 'Zebra', noteBaseName: 'Zebra', type: 'pdf', lastModified: 100,
      highlightCount: 5, pageCount: 10, syncStatus: 'synced',
      folderPath: '', parentUuid: '', hasSourceFile: true,
    },
    {
      uuid: '2', name: 'Alpha', noteBaseName: 'Alpha', type: 'epub', lastModified: 300,
      highlightCount: 0, pageCount: 20, syncStatus: 'synced',
      folderPath: '', parentUuid: '', hasSourceFile: true,
    },
    {
      uuid: '3', name: 'Middle', noteBaseName: 'Middle', type: 'notebook', lastModified: 200,
      highlightCount: 3, pageCount: 5, syncStatus: 'pending',
      folderPath: '', parentUuid: '', hasSourceFile: false,
    },
  ];

  it('sorts by name ascending', () => {
    const sorted = sortDocuments(docs, { field: 'name', direction: 'asc' });
    expect(sorted.map((d) => d.name)).toEqual(['Alpha', 'Middle', 'Zebra']);
  });

  it('sorts by name descending', () => {
    const sorted = sortDocuments(docs, { field: 'name', direction: 'desc' });
    expect(sorted.map((d) => d.name)).toEqual(['Zebra', 'Middle', 'Alpha']);
  });

  it('sorts by lastModified ascending', () => {
    const sorted = sortDocuments(docs, { field: 'lastModified', direction: 'asc' });
    expect(sorted.map((d) => d.lastModified)).toEqual([100, 200, 300]);
  });

  it('sorts by highlightCount descending', () => {
    const sorted = sortDocuments(docs, { field: 'highlightCount', direction: 'desc' });
    expect(sorted.map((d) => d.highlightCount)).toEqual([5, 3, 0]);
  });

  it('sorts by type ascending', () => {
    const sorted = sortDocuments(docs, { field: 'type', direction: 'asc' });
    expect(sorted.map((d) => d.type)).toEqual(['epub', 'notebook', 'pdf']);
  });
});

describe('filterDocuments', () => {
  const docs: LibraryDocument[] = [
    {
      uuid: '1', name: 'Machine Learning Paper', noteBaseName: 'Machine Learning Paper', type: 'pdf', lastModified: 100,
      highlightCount: 5, pageCount: 10, syncStatus: 'synced',
      folderPath: 'Research/ML', parentUuid: '', hasSourceFile: true,
    },
    {
      uuid: '2', name: 'Cooking Recipes', noteBaseName: 'Cooking Recipes', type: 'epub', lastModified: 200,
      highlightCount: 0, pageCount: 20, syncStatus: 'synced',
      folderPath: 'Hobbies', parentUuid: '', hasSourceFile: true,
    },
    {
      uuid: '3', name: 'Daily Notes', noteBaseName: 'Daily Notes', type: 'notebook', lastModified: 300,
      highlightCount: 0, pageCount: 5, syncStatus: 'synced',
      folderPath: '', parentUuid: '', hasSourceFile: false,
    },
  ];

  it('returns all documents for empty query', () => {
    expect(filterDocuments(docs, '')).toHaveLength(3);
    expect(filterDocuments(docs, '  ')).toHaveLength(3);
  });

  it('filters by document name (case-insensitive)', () => {
    const result = filterDocuments(docs, 'machine');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Machine Learning Paper');
  });

  it('filters by folder path', () => {
    const result = filterDocuments(docs, 'research');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Machine Learning Paper');
  });

  it('returns empty for no match', () => {
    expect(filterDocuments(docs, 'nonexistent')).toHaveLength(0);
  });
});

describe('buildSyncSummary', () => {
  it('computes correct summary', () => {
    const docs: LibraryDocument[] = [
      {
        uuid: '1', name: 'Doc 1', noteBaseName: 'Doc 1', type: 'pdf', lastModified: 100,
        highlightCount: 3, pageCount: 10, syncStatus: 'synced',
        folderPath: '', parentUuid: '', hasSourceFile: true,
      },
      {
        uuid: '2', name: 'Doc 2', noteBaseName: 'Doc 2', type: 'pdf', lastModified: 200,
        highlightCount: 7, pageCount: 20, syncStatus: 'pending',
        folderPath: '', parentUuid: '', hasSourceFile: true,
      },
      {
        uuid: '3', name: 'Doc 3', noteBaseName: 'Doc 3', type: 'pdf', lastModified: 300,
        highlightCount: 0, pageCount: 5, syncStatus: 'error',
        folderPath: '', parentUuid: '', hasSourceFile: true,
      },
    ];

    const summary = buildSyncSummary(docs, 1700000000000, true);
    expect(summary.totalDocuments).toBe(3);
    expect(summary.pendingDocuments).toBe(1);
    expect(summary.errorDocuments).toBe(1);
    expect(summary.totalHighlights).toBe(10);
    expect(summary.lastSyncTime).toBe(1700000000000);
    expect(summary.connectionHealthy).toBe(true);
  });

  it('handles empty document list', () => {
    const summary = buildSyncSummary([], null, false);
    expect(summary.totalDocuments).toBe(0);
    expect(summary.totalHighlights).toBe(0);
    expect(summary.lastSyncTime).toBeNull();
    expect(summary.connectionHealthy).toBe(false);
  });
});
