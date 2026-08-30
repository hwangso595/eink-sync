/**
 * Tests for the SFTP sync engine.
 *
 * Tests file comparison, UUID collection discovery, recursive safety, and
 * template compatibility
 * without requiring an actual SSH connection.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { connectSftp } from './sftp-connection';
import { BridgeError, ErrorCode } from '../types/errors';
import {
  SftpSyncEngine,
  RemoteFileInfo,
  SftpSyncOptions,
  isSupportedTemplateAsset,
} from './sftp-sync';

jest.mock('./sftp-connection', () => ({ connectSftp: jest.fn() }));

const mockedConnectSftp = connectSftp as jest.MockedFunction<typeof connectSftp>;

const UUID = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';

function sftpEntry(filename: string, mode: number, size = 0, mtime = 1700000000): any {
  return { filename, attrs: { mode, size, mtime } };
}

// ---------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-sync-test-'));
}

function cleanupDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function defaultOptions(localDir: string): SftpSyncOptions {
  return {
    host: '10.11.99.1',
    port: 22,
    username: 'root',
    password: 'test',
    timeoutMs: 5000,
    connectionMethod: 'usb',
    localSyncDir: localDir,
    includeEpub: true,
  };
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe('template asset support', () => {
  it('includes SVG art used by Paper Pro firmware', () => {
    expect(isSupportedTemplateAsset('P Grid medium.svg')).toBe(true);
    expect(isSupportedTemplateAsset('P Grid medium.SVG')).toBe(true);
    expect(isSupportedTemplateAsset('notes.txt')).toBe(false);
  });

  it('downloads only safe regular template assets and reports rejected entries', async () => {
    const localDir = createTempDir();
    const end = jest.fn();
    const sftp = {
      readdir: jest.fn((_remotePath: string, callback: Function) => callback(undefined, [
        sftpEntry('Paper Pro.svg', 0o100644, 4),
        sftpEntry('../escape.svg', 0o100644, 4),
        sftpEntry('..\\escape.svg', 0o100644, 4),
        sftpEntry('linked.svg', 0o120777, 4),
        sftpEntry('directory.svg', 0o040755),
        sftpEntry('pipe.svg', 0o010644),
      ])),
      fastGet: jest.fn((_remotePath: string, localPath: string, callback: Function) => {
        fs.writeFileSync(localPath, '<svg/>');
        callback(undefined);
      }),
    } as any;
    mockedConnectSftp.mockResolvedValueOnce({ conn: { end } as any, sftp });
    const engine = new SftpSyncEngine(defaultOptions(localDir));

    const result = await engine.fetchTemplates(path.join(localDir, 'templates'));

    expect(result.downloaded).toBe(1);
    expect(result.errors).toHaveLength(5);
    expect(fs.existsSync(path.join(localDir, 'templates', 'Paper Pro.svg'))).toBe(true);
    expect(fs.existsSync(path.join(localDir, 'escape.svg'))).toBe(false);
    expect(sftp.fastGet).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalled();
    cleanupDir(localDir);
  });

  it('does not treat a local template symlink target as up to date', async () => {
    const localDir = createTempDir();
    const outsideDir = createTempDir();
    const templatesDir = path.join(localDir, 'templates');
    fs.mkdirSync(templatesDir);
    const localAsset = path.join(templatesDir, 'Existing.svg');
    fs.symlinkSync(
      outsideDir,
      localAsset,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const targetStat = fs.statSync(outsideDir);
    const end = jest.fn();
    const sftp = {
      readdir: jest.fn((_remotePath: string, callback: Function) => callback(undefined, [
        sftpEntry(
          'Existing.svg',
          0o100644,
          targetStat.size,
          Math.floor(targetStat.mtimeMs / 1000),
        ),
      ])),
      fastGet: jest.fn(),
    } as any;
    mockedConnectSftp.mockResolvedValueOnce({ conn: { end } as any, sftp });
    const engine = new SftpSyncEngine(defaultOptions(localDir));

    const result = await engine.fetchTemplates(templatesDir);

    expect(result.downloaded).toBe(0);
    expect(result.errors.join('\n')).toContain('symlink or junction');
    expect(sftp.fastGet).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
    cleanupDir(localDir);
    cleanupDir(outsideDir);
  });
});

describe('connection errors', () => {
  it('keeps actionable BridgeError guidance in a failed sync result', async () => {
    const localDir = createTempDir();
    mockedConnectSftp.mockRejectedValueOnce(new BridgeError(
      ErrorCode.SSH_SOCKET_ACCESS_DENIED,
      'SSH access to 10.11.99.1:22 was denied before authentication (EACCES).',
      'Confirm USB SSH, then allow outbound TCP 22.',
    ));

    const result = await new SftpSyncEngine(defaultOptions(localDir)).sync();

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('denied before authentication');
    expect(result.errors[0]).toContain('Suggestion: Confirm USB SSH');
    cleanupDir(localDir);
  });
});

describe('SftpSyncEngine', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  describe('compareFiles', () => {
    it('should mark missing files for download', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: '/xochitl/abc-123.metadata',
          filename: 'abc-123.metadata',
          size: 256,
          mtime: 1700000000,
          isDirectory: false,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload).toHaveLength(1);
      expect(toDownload[0].filename).toBe('abc-123.metadata');
    });

    it('should skip PDFs with matching local size', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      // Create a local PDF with a specific size
      const pdfPath = path.join(tempDir, 'doc-uuid.pdf');
      fs.writeFileSync(pdfPath, Buffer.alloc(1024));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: '/xochitl/doc-uuid.pdf',
          filename: 'doc-uuid.pdf',
          size: 1024,
          mtime: 1700000000,
          isDirectory: false,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload).toHaveLength(0);
    });

    it('should download PDFs with different local size', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const pdfPath = path.join(tempDir, 'doc-uuid.pdf');
      fs.writeFileSync(pdfPath, Buffer.alloc(512));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: '/xochitl/doc-uuid.pdf',
          filename: 'doc-uuid.pdf',
          size: 1024,
          mtime: 1700000000,
          isDirectory: false,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload).toHaveLength(1);
    });

    it('should skip EPUBs with matching local size', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const epubPath = path.join(tempDir, 'book.epub');
      fs.writeFileSync(epubPath, Buffer.alloc(2048));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: '/xochitl/book.epub',
          filename: 'book.epub',
          size: 2048,
          mtime: 1700000000,
          isDirectory: false,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload).toHaveLength(0);
    });

    it('should download metadata files with newer mtime', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      // Create a local file with an older mtime
      const metaPath = path.join(tempDir, 'abc.metadata');
      fs.writeFileSync(metaPath, '{}');
      // Set mtime to something old
      fs.utimesSync(metaPath, new Date(1600000000000), new Date(1600000000000));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: '/xochitl/abc.metadata',
          filename: 'abc.metadata',
          size: 100,
          mtime: 1700000000,
          isDirectory: false,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload).toHaveLength(1);
    });

    it('should skip metadata files with same or older mtime', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const metaPath = path.join(tempDir, 'abc.metadata');
      fs.writeFileSync(metaPath, '{}');
      // Set mtime to something newer than remote
      fs.utimesSync(metaPath, new Date(1800000000000), new Date(1800000000000));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: '/xochitl/abc.metadata',
          filename: 'abc.metadata',
          size: 2,
          mtime: 1700000000,
          isDirectory: false,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload).toHaveLength(0);
    });

    it('should download metadata with a size mismatch even in the same mtime tick', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const metaPath = path.join(tempDir, 'abc.metadata');
      fs.writeFileSync(metaPath, '{}');
      fs.utimesSync(metaPath, new Date(1700000000000), new Date(1700000000000));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: '/xochitl/abc.metadata',
          filename: 'abc.metadata',
          size: 100,
          mtime: 1700000000,
          isDirectory: false,
        },
      ];

      expect(engine.compareFiles(remoteFiles)).toHaveLength(1);
    });

    it('should include new annotation directories', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: '/xochitl/a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          filename: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          size: 0,
          mtime: 1700000000,
          isDirectory: true,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload).toHaveLength(1);
    });

    it('should include annotation directories whose document metadata changed', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const dirName = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      fs.mkdirSync(path.join(tempDir, dirName));
      const metaPath = path.join(tempDir, `${dirName}.metadata`);
      fs.writeFileSync(metaPath, '{}');
      fs.utimesSync(metaPath, new Date(1600000000000), new Date(1600000000000));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: `/xochitl/${dirName}.metadata`,
          filename: `${dirName}.metadata`,
          size: 2,
          mtime: 1700000000,
          isDirectory: false,
        },
        {
          path: `/xochitl/${dirName}`,
          filename: dirName,
          size: 0,
          mtime: 1500000000,
          isDirectory: true,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload.map((f) => f.filename)).toEqual([dirName, `${dirName}.metadata`]);
    });

    it('should inventory annotation directories even for unchanged documents', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const dirName = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      fs.mkdirSync(path.join(tempDir, dirName));
      for (const ext of ['.metadata', '.content']) {
        const filePath = path.join(tempDir, `${dirName}${ext}`);
        fs.writeFileSync(filePath, '{}');
        fs.utimesSync(filePath, new Date(1700000000000), new Date(1700000000000));
      }

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: `/xochitl/${dirName}.metadata`,
          filename: `${dirName}.metadata`,
          size: 2,
          mtime: 1700000000,
          isDirectory: false,
        },
        {
          path: `/xochitl/${dirName}.content`,
          filename: `${dirName}.content`,
          size: 2,
          mtime: 1700000000,
          isDirectory: false,
        },
        {
          path: `/xochitl/${dirName}`,
          filename: dirName,
          size: 0,
          mtime: 1700000000,
          isDirectory: true,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload.map((entry) => entry.filename)).toEqual([dirName]);
    });

    it('should include unchanged-doc directories when the local copy is missing', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const dirName = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      // Local metadata is fresh, but the annotation dir was never downloaded
      const metaPath = path.join(tempDir, `${dirName}.metadata`);
      fs.writeFileSync(metaPath, '{}');
      fs.utimesSync(metaPath, new Date(1700000000000), new Date(1700000000000));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: `/xochitl/${dirName}.metadata`,
          filename: `${dirName}.metadata`,
          size: 2,
          mtime: 1700000000,
          isDirectory: false,
        },
        {
          path: `/xochitl/${dirName}`,
          filename: dirName,
          size: 0,
          mtime: 1700000000,
          isDirectory: true,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload.map((f) => f.filename)).toEqual([dirName]);
    });

    it('should include unchanged-doc directories carrying the incomplete marker', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const dirName = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const localDir = path.join(tempDir, dirName);
      fs.mkdirSync(localDir);
      // A previous partial download left the marker outside the collection.
      const stateDir = path.join(tempDir, '.eink-sync-state');
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(stateDir, `${dirName}.eink-sync-incomplete`), '');
      const metaPath = path.join(tempDir, `${dirName}.metadata`);
      fs.writeFileSync(metaPath, '{}');
      fs.utimesSync(metaPath, new Date(1700000000000), new Date(1700000000000));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: `/xochitl/${dirName}.metadata`,
          filename: `${dirName}.metadata`,
          size: 2,
          mtime: 1700000000,
          isDirectory: false,
        },
        {
          path: `/xochitl/${dirName}`,
          filename: dirName,
          size: 0,
          mtime: 1700000000,
          isDirectory: true,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload.map((f) => f.filename)).toEqual([dirName, `${dirName}.metadata`]);
    });

    it('should include directories with no metadata sibling in the listing', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const dirName = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      fs.mkdirSync(path.join(tempDir, dirName));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: `/xochitl/${dirName}`,
          filename: dirName,
          size: 0,
          mtime: 1700000000,
          isDirectory: true,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload).toHaveLength(1);
    });
  });

  describe('future-compatible collection discovery', () => {
    it('includes unknown UUID sidecars and sidecar directories', async () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));
      const sftp = {
        readdir: jest.fn((_remotePath: string, callback: Function) => callback(undefined, [
          sftpEntry(`${UUID}.metadata`, 0o100644, 4),
          sftpEntry(`${UUID}.future`, 0o100644, 0),
          sftpEntry(`${UUID}.assets`, 0o040755),
          sftpEntry(`${UUID}lookalike`, 0o100644, 3),
          sftpEntry('unrelated.metadata', 0o100644, 3),
        ])),
      } as any;

      const files = await engine.listRemoteFiles(sftp);
      expect(files.map((entry) => entry.filename)).toEqual([
        `${UUID}.metadata`,
        `${UUID}.future`,
        `${UUID}.assets`,
      ]);
      expect(files.every((entry) => entry.documentUuid === UUID)).toBe(true);
    });

    it('rejects top-level symlinks in a document collection', async () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));
      const sftp = {
        readdir: jest.fn((_remotePath: string, callback: Function) => callback(undefined, [
          sftpEntry(`${UUID}.metadata`, 0o120777),
        ])),
      } as any;

      await expect(engine.listRemoteFiles(sftp)).rejects.toThrow('Unsupported symlink');
    });

    it('downloads zero-byte files and recursively nested unknown directories', async () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));
      const root = `/xochitl/${UUID}.assets`;
      const listings = new Map<string, any[]>([
        [root, [sftpEntry('zero.bin', 0o100644, 0), sftpEntry('a', 0o040755)]],
        [`${root}/a`, [sftpEntry('b', 0o040755)]],
        [`${root}/a/b`, [sftpEntry('c', 0o040755)]],
        [`${root}/a/b/c`, [sftpEntry('payload.bin', 0o100644, 7)]],
      ]);
      const sftp = {
        readdir: jest.fn((remotePath: string, callback: Function) => {
          callback(undefined, listings.get(remotePath) ?? []);
        }),
        fastGet: jest.fn((remotePath: string, localPath: string, callback: Function) => {
          fs.writeFileSync(localPath, remotePath.endsWith('zero.bin') ? '' : 'payload');
          callback(undefined);
        }),
      } as any;

      const result = await engine.downloadDirectory(sftp, {
        path: root,
        filename: `${UUID}.assets`,
        size: 0,
        mtime: 1700000000,
        isDirectory: true,
        entryType: 'directory',
        documentUuid: UUID,
      });

      expect(result.errors).toEqual([]);
      expect(result.filesDownloaded).toBe(2);
      expect(fs.statSync(path.join(tempDir, `${UUID}.assets`, 'zero.bin')).size).toBe(0);
      expect(fs.readFileSync(
        path.join(tempDir, `${UUID}.assets`, 'a', 'b', 'c', 'payload.bin'),
        'utf-8',
      )).toBe('payload');
    });

    it('fails a recursive collection containing a symlink without following it', async () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));
      const root = `/xochitl/${UUID}`;
      const sftp = {
        readdir: jest.fn((_remotePath: string, callback: Function) => callback(undefined, [
          sftpEntry('outside.rm', 0o120777),
        ])),
        fastGet: jest.fn(),
      } as any;

      const result = await engine.downloadDirectory(sftp, {
        path: root,
        filename: UUID,
        size: 0,
        mtime: 1700000000,
        isDirectory: true,
        entryType: 'directory',
        documentUuid: UUID,
      });

      expect(result.errors[0]).toContain('unsupported symlink');
      expect(sftp.fastGet).not.toHaveBeenCalled();
    });

    it('rejects a pre-existing local directory link before downloadFile writes', async () => {
      const outsideDir = createTempDir();
      const linkedDir = path.join(tempDir, 'linked');
      fs.symlinkSync(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
      const sftp = { fastGet: jest.fn() } as any;
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      await expect(engine.downloadFile(
        sftp,
        '/xochitl/escape.bin',
        path.join(linkedDir, 'escape.bin'),
      )).rejects.toThrow('symlink or junction');
      expect(sftp.fastGet).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(outsideDir, 'escape.bin'))).toBe(false);
      cleanupDir(outsideDir);
    });

    it('rejects a nested local directory link during recursive collection download', async () => {
      const outsideDir = createTempDir();
      const collectionDir = path.join(tempDir, `${UUID}.assets`);
      fs.mkdirSync(collectionDir);
      fs.symlinkSync(
        outsideDir,
        path.join(collectionDir, 'nested'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const root = `/xochitl/${UUID}.assets`;
      const sftp = {
        readdir: jest.fn((remotePath: string, callback: Function) => callback(undefined,
          remotePath === root
            ? [sftpEntry('nested', 0o040755)]
            : [sftpEntry('escape.bin', 0o100644, 4)],
        )),
        fastGet: jest.fn(),
      } as any;
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const result = await engine.downloadDirectory(sftp, {
        path: root,
        filename: `${UUID}.assets`,
        size: 0,
        mtime: 1700000000,
        isDirectory: true,
        entryType: 'directory',
        documentUuid: UUID,
      });

      expect(result.errors.join('\n')).toContain('symlink or junction');
      expect(sftp.fastGet).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(outsideDir, 'escape.bin'))).toBe(false);
      cleanupDir(outsideDir);
    });
  });

  describe('buildResult', () => {
    it('should produce correct summary for empty sync', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));
      // Access via sync result format
      const result = (engine as any).buildResult(true, 0, 10, 0, 1500, []);
      expect(result.success).toBe(true);
      expect(result.filesDownloaded).toBe(0);
      expect(result.filesSkipped).toBe(10);
      expect(result.summary).toContain('up to date');
    });

    it('should produce correct summary for successful download', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));
      const result = (engine as any).buildResult(true, 5, 10, 5242880, 3000, []);
      expect(result.success).toBe(true);
      expect(result.filesDownloaded).toBe(5);
      expect(result.summary).toContain('5 file(s)');
      expect(result.summary).toContain('5.0 MB');
    });

    it('should produce correct summary with errors', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));
      const result = (engine as any).buildResult(false, 3, 5, 1048576, 2000, ['error 1']);
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.summary).toContain('error(s)');
    });
  });
});
