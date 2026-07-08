/**
 * Tests for document-discovery.ts -- xochitl directory scanning and
 * UUID-to-human-name resolution.
 *
 * Uses a temporary directory with mock xochitl file structures.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverDocuments, discoverDocumentsWithStatus, XochitlDocumentDiscovery, computeTrashedUuids } from './document-discovery';

/** Create a temporary xochitl directory for testing. */
function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rm-test-'));
}

/** Write a JSON file to the test directory. */
function writeJson(dir: string, filename: string, data: object): void {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data), 'utf-8');
}

/** Create a fake PDF file. */
function writeFakePdf(dir: string, uuid: string): void {
  fs.writeFileSync(path.join(dir, `${uuid}.pdf`), '%PDF-1.4 fake', 'utf-8');
}

describe('computeTrashedUuids', () => {
  it('flags documents whose parent is trash directly', () => {
    const trashed = computeTrashedUuids(new Map([
      ['doc-a', 'trash'],
      ['doc-b', ''],
    ]));
    expect(trashed.has('doc-a')).toBe(true);
    expect(trashed.has('doc-b')).toBe(false);
  });

  it('flags documents inside a trashed ancestor folder', () => {
    const trashed = computeTrashedUuids(new Map([
      ['folder', 'trash'],   // folder is in trash
      ['doc', 'folder'],     // doc lives in that folder
      ['other', ''],         // top-level, not trashed
    ]));
    expect(trashed.has('folder')).toBe(true);
    expect(trashed.has('doc')).toBe(true);
    expect(trashed.has('other')).toBe(false);
  });

  it('does not hang on a parent cycle', () => {
    const trashed = computeTrashedUuids(new Map([
      ['a', 'b'],
      ['b', 'a'],
    ]));
    expect(trashed.has('a')).toBe(false);
    expect(trashed.has('b')).toBe(false);
  });
});

describe('discoverDocuments', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('counts a mid-sync doc (metadata but no content) as pending, not discovered', () => {
    writeJson(tmpDir, 'pending-1.metadata', {
      visibleName: 'Mid Sync',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000001000',
      deleted: false,
    });
    // No .content file yet -> pending.
    const { documents, pendingCount } = discoverDocumentsWithStatus(tmpDir);
    expect(documents).toHaveLength(0);
    expect(pendingCount).toBe(1);
  });

  it('discovers PDF documents with correct metadata', () => {
    writeJson(tmpDir, 'doc-1.metadata', {
      visibleName: 'Test Paper',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000001000',
      deleted: false,
    });
    writeJson(tmpDir, 'doc-1.content', {
      fileType: 'pdf',
      pageCount: 10,
      pages: ['p1', 'p2', 'p3'],
    });
    writeFakePdf(tmpDir, 'doc-1');

    const docs = discoverDocuments(tmpDir);

    expect(docs).toHaveLength(1);
    expect(docs[0].uuid).toBe('doc-1');
    expect(docs[0].visibleName).toBe('Test Paper');
    expect(docs[0].type).toBe('pdf');
    expect(docs[0].pageCount).toBe(10);
    expect(docs[0].pageUuids).toEqual(['p1', 'p2', 'p3']);
    expect(docs[0].hasPdf).toBe(true);
  });

  it('excludes deleted documents', () => {
    writeJson(tmpDir, 'doc-deleted.metadata', {
      visibleName: 'Deleted Paper',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: true,
    });
    writeJson(tmpDir, 'doc-deleted.content', {
      fileType: 'pdf',
      pageCount: 1,
      pages: ['p1'],
    });

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(0);
  });

  it('includes notebook documents with type "notebook"', () => {
    writeJson(tmpDir, 'notebook-1.metadata', {
      visibleName: 'My Notes',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });
    writeJson(tmpDir, 'notebook-1.content', {
      fileType: '',
      pageCount: 5,
      pages: ['n1', 'n2'],
    });

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0].type).toBe('notebook');
    expect(docs[0].visibleName).toBe('My Notes');
  });

  it('excludes folder entries (CollectionType)', () => {
    writeJson(tmpDir, 'folder-1.metadata', {
      visibleName: 'Research',
      parent: '',
      type: 'CollectionType',
      lastModified: '1700000000000',
      deleted: false,
    });

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(0);
  });

  it('handles v6 cPages structure for page UUIDs', () => {
    writeJson(tmpDir, 'doc-v6.metadata', {
      visibleName: 'V6 Paper',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000001000',
      deleted: false,
    });
    writeJson(tmpDir, 'doc-v6.content', {
      fileType: 'pdf',
      pageCount: 2,
      cPages: {
        pages: [{ id: 'v6-page-1' }, { id: 'v6-page-2' }],
      },
    });
    writeFakePdf(tmpDir, 'doc-v6');

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0].pageUuids).toEqual(['v6-page-1', 'v6-page-2']);
  });

  it('detects when PDF file is missing', () => {
    writeJson(tmpDir, 'doc-nopdf.metadata', {
      visibleName: 'No PDF',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000001000',
      deleted: false,
    });
    writeJson(tmpDir, 'doc-nopdf.content', {
      fileType: 'pdf',
      pageCount: 1,
      pages: ['p1'],
    });
    // No PDF file created

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0].hasPdf).toBe(false);
  });

  it('returns empty array for nonexistent directory', () => {
    const docs = discoverDocuments('/nonexistent/path');
    expect(docs).toHaveLength(0);
  });

  it('returns empty array for empty directory', () => {
    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(0);
  });

  it('handles malformed .metadata files gracefully', () => {
    // Write an invalid JSON file
    fs.writeFileSync(path.join(tmpDir, 'bad.metadata'), 'not json{{{');
    writeJson(tmpDir, 'good.metadata', {
      visibleName: 'Good Paper',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });
    writeJson(tmpDir, 'good.content', {
      fileType: 'pdf',
      pageCount: 1,
      pages: ['p1'],
    });
    writeFakePdf(tmpDir, 'good');

    // Should discover the good document and skip the bad one
    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0].visibleName).toBe('Good Paper');
  });

  it('handles missing .content file gracefully', () => {
    writeJson(tmpDir, 'no-content.metadata', {
      visibleName: 'No Content',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });
    // No .content file

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(0);
  });

  it('defaults missing fields in metadata', () => {
    writeJson(tmpDir, 'minimal.metadata', {});
    writeJson(tmpDir, 'minimal.content', {
      fileType: 'pdf',
      pageCount: 1,
      pages: ['p1'],
    });
    writeFakePdf(tmpDir, 'minimal');

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0].visibleName).toBe('Untitled');
  });

  it('discovers multiple PDF documents', () => {
    for (let i = 1; i <= 3; i++) {
      writeJson(tmpDir, `doc-${i}.metadata`, {
        visibleName: `Paper ${i}`,
        parent: '',
        type: 'DocumentType',
        lastModified: `${1700000000000 + i}`,
        deleted: false,
      });
      writeJson(tmpDir, `doc-${i}.content`, {
        fileType: 'pdf',
        pageCount: i,
        pages: Array.from({ length: i }, (_, j) => `p${j}`),
      });
      writeFakePdf(tmpDir, `doc-${i}`);
    }

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(3);
  });
});

// -------------------------------------------------------------------
// Regression tests
// -------------------------------------------------------------------

describe('Regression: Syncthing conflict files must be filtered', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('excludes sync-conflict metadata files from discovery', () => {
    // Regression: sync-conflict files were being parsed as real documents
    writeJson(tmpDir, 'doc-real.metadata', {
      visibleName: 'Real Paper',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });
    writeJson(tmpDir, 'doc-real.content', {
      fileType: 'pdf',
      pageCount: 1,
      pages: ['p1'],
    });
    writeFakePdf(tmpDir, 'doc-real');

    // Sync conflict file -- must be filtered out
    writeJson(tmpDir, 'doc-real.sync-conflict-20240115-123456-ABCDEFG.metadata', {
      visibleName: 'Conflict Paper',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0].visibleName).toBe('Real Paper');
  });

  it('excludes .syncthing. temp files from discovery', () => {
    // Regression: .syncthing. temp files caused parsing errors
    writeJson(tmpDir, 'doc-ok.metadata', {
      visibleName: 'OK Paper',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });
    writeJson(tmpDir, 'doc-ok.content', {
      fileType: 'pdf',
      pageCount: 1,
      pages: ['p1'],
    });
    writeFakePdf(tmpDir, 'doc-ok');

    // Syncthing temp file
    writeJson(tmpDir, '.syncthing.doc-ok.metadata.tmp', {
      visibleName: 'Temp Paper',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0].visibleName).toBe('OK Paper');
  });
});

describe('Regression: Notebook support in document discovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers notebooks with empty fileType', () => {
    // Regression: Notebooks with fileType="" were not discovered
    writeJson(tmpDir, 'nb-1.metadata', {
      visibleName: 'My Notebook',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });
    writeJson(tmpDir, 'nb-1.content', {
      fileType: '',
      pageCount: 3,
      pages: ['n1', 'n2', 'n3'],
    });

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0].type).toBe('notebook');
    expect(docs[0].visibleName).toBe('My Notebook');
    expect(docs[0].pageUuids).toEqual(['n1', 'n2', 'n3']);
  });

  it('discovers notebooks with explicit "notebook" fileType', () => {
    // Regression: Notebooks with fileType="notebook" were not discovered
    writeJson(tmpDir, 'nb-2.metadata', {
      visibleName: 'Explicit Notebook',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });
    writeJson(tmpDir, 'nb-2.content', {
      fileType: 'notebook',
      pageCount: 2,
      pages: ['n1', 'n2'],
    });

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0].type).toBe('notebook');
  });

  it('notebooks get page UUIDs for page drawings', () => {
    // Regression: Notebooks need page UUIDs to find per-page .rm files
    writeJson(tmpDir, 'nb-pages.metadata', {
      visibleName: 'Notebook With Pages',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });
    writeJson(tmpDir, 'nb-pages.content', {
      fileType: '',
      pageCount: 5,
      pages: ['p1', 'p2', 'p3', 'p4', 'p5'],
    });

    const docs = discoverDocuments(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0].pageUuids).toHaveLength(5);
    expect(docs[0].hasPdf).toBe(false);
  });
});

describe('XochitlDocumentDiscovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('implements DocumentDiscovery interface', async () => {
    writeJson(tmpDir, 'doc-1.metadata', {
      visibleName: 'Interface Test',
      parent: '',
      type: 'DocumentType',
      lastModified: '1700000000000',
      deleted: false,
    });
    writeJson(tmpDir, 'doc-1.content', {
      fileType: 'pdf',
      pageCount: 1,
      pages: ['p1'],
    });
    writeFakePdf(tmpDir, 'doc-1');

    const discovery = new XochitlDocumentDiscovery();
    const docs = await discovery.discoverDocuments(tmpDir);

    expect(docs).toHaveLength(1);
    expect(docs[0].visibleName).toBe('Interface Test');
  });
});
