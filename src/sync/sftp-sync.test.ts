/**
 * Tests for the SFTP sync engine.
 *
 * Tests the core logic (file comparison, skip patterns, UUID detection)
 * without requiring an actual SSH connection.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SftpSyncEngine, RemoteFileInfo, SftpSyncOptions } from './sftp-sync';

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
    localSyncDir: localDir,
    includeEpub: true,
  };
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

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
          size: 100,
          mtime: 1700000000,
          isDirectory: false,
        },
      ];

      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload).toHaveLength(0);
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

    it('should include annotation directories with newer mtime', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const dirName = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const localDir = path.join(tempDir, dirName);
      fs.mkdirSync(localDir);
      fs.utimesSync(localDir, new Date(1600000000000), new Date(1600000000000));

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

    it('should always include annotation directories for deeper file comparison', () => {
      const engine = new SftpSyncEngine(defaultOptions(tempDir));

      const dirName = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const localDir = path.join(tempDir, dirName);
      fs.mkdirSync(localDir);
      fs.utimesSync(localDir, new Date(1800000000000), new Date(1800000000000));

      const remoteFiles: RemoteFileInfo[] = [
        {
          path: `/xochitl/${dirName}`,
          filename: dirName,
          size: 0,
          mtime: 1700000000,
          isDirectory: true,
        },
      ];

      // Directories are always included so individual files inside are compared
      const toDownload = engine.compareFiles(remoteFiles);
      expect(toDownload).toHaveLength(1);
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
