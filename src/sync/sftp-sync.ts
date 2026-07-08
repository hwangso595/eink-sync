/**
 * SFTP-based sync engine for pulling reMarkable tablet files over SSH.
 *
 * This is an alternative to Syncthing that works by directly downloading
 * files from the tablet via SFTP. It is simpler to set up (no Syncthing
 * installation needed on the tablet) and works well for rM1 users who
 * want a lightweight sync method.
 *
 * Design decisions:
 * - Sequential transfers: one file at a time to avoid overwhelming the rM1.
 * - PDFs/EPUBs are immutable: skip download if local copy matches by size.
 * - Annotation dirs (UUID folders with .rm files) are always re-synced
 *   based on mtime comparison.
 * - Skips non-essential directories: .textconversion,
 *   .highlights, .stfolder, .pagedata files, and Syncthing conflict files.
 * - Progress callback for UI integration.
 *
 * Privacy: Only communicates with the user's tablet over SSH/SFTP.
 * No external network calls.
 */

import { Client, SFTPWrapper } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { makeHostVerifier } from '../ssh/host-key-store';
import { XOCHITL_SYNC_PATH } from './types';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

/** Configuration for an SFTP sync run. */
export interface SftpSyncOptions {
  /** Tablet IP address. */
  host: string;
  /** SSH port (default 22). */
  port: number;
  /** SSH username (always 'root' on reMarkable). */
  username: string;
  /** Root password for the tablet. */
  password: string;
  /** SSH connection timeout in milliseconds. */
  timeoutMs: number;
  /** Local directory to sync files into (absolute path). */
  localSyncDir: string;
  /** Remote xochitl path on the tablet. */
  remotePath?: string;
  /** Whether to include EPUB files. */
  includeEpub?: boolean;
}

/** Information about a remote file on the tablet. */
export interface RemoteFileInfo {
  /** Full remote path. */
  path: string;
  /** File name (without directory). */
  filename: string;
  /** File size in bytes. */
  size: number;
  /** Last modification time (Unix epoch seconds). */
  mtime: number;
  /** Whether this is a directory. */
  isDirectory: boolean;
}

/** Result of an SFTP sync operation. */
export interface SftpSyncResult {
  /** Whether the sync completed successfully. */
  success: boolean;
  /** Number of files downloaded. */
  filesDownloaded: number;
  /** Number of files skipped (already up to date). */
  filesSkipped: number;
  /** Total bytes downloaded. */
  bytesDownloaded: number;
  /** Duration of the sync in milliseconds. */
  durationMs: number;
  /** Errors encountered during sync (non-fatal). */
  errors: string[];
  /** Human-readable summary. */
  summary: string;
}

/** Progress callback for reporting sync progress to the UI. */
export type SftpProgressCallback = (
  phase: 'connecting' | 'listing' | 'comparing' | 'downloading' | 'complete' | 'error',
  detail: string,
  /** Current file index (1-based) during download phase. */
  current?: number,
  /** Total files to download. */
  total?: number,
) => void;

// ---------------------------------------------------------------
// Skip patterns
// ---------------------------------------------------------------

/**
 * Directory names to skip during sync.
 * These are non-essential for highlight extraction.
 */
const SKIP_DIRS = new Set([
  '.textconversion',
  '.highlights',
  '.stfolder',
]);

/**
 * File names/patterns to skip during sync.
 */
const SKIP_FILES = new Set([
  '.stignore',
  '.local',
]);

/** File extensions to skip. */
const SKIP_EXTENSIONS = new Set([
  '.pagedata',
]);

/**
 * Check whether a filename should be skipped.
 */
function shouldSkipEntry(filename: string, isDirectory: boolean): boolean {
  if (isDirectory) {
    return SKIP_DIRS.has(filename);
  }

  if (SKIP_FILES.has(filename)) return true;

  // Skip Syncthing conflict files
  if (filename.includes('sync-conflict')) return true;

  // Skip by extension
  const ext = path.extname(filename).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return true;

  return false;
}

/**
 * Check whether a filename represents a document we want to sync.
 * We want: .metadata, .content, .pdf, .epub, and UUID annotation directories.
 */
function isRelevantFile(filename: string, includeEpub: boolean): boolean {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.metadata' || ext === '.content' || ext === '.pdf') return true;
  if (ext === '.epub' && includeEpub) return true;
  return false;
}

/**
 * Check whether a name looks like a UUID (8-4-4-4-12 hex pattern).
 */
function isUuidLike(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);
}

// ---------------------------------------------------------------
// SFTP helpers (promisified wrappers around ssh2 callbacks)
// ---------------------------------------------------------------

/** Connect to the tablet via SSH and open an SFTP session. */
function connectSftp(options: SftpSyncOptions): Promise<{ conn: Client; sftp: SFTPWrapper }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    const timeoutId = setTimeout(() => {
      conn.destroy();
      reject(new Error(
        `SFTP connection to ${options.host}:${options.port} timed out after ${options.timeoutMs}ms.`,
      ));
    }, options.timeoutMs + 1000);

    conn.on('ready', () => {
      clearTimeout(timeoutId);
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          reject(new Error(`Failed to open SFTP session: ${err.message}`));
          return;
        }
        resolve({ conn, sftp });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`SSH connection failed: ${err.message}`));
    });

    conn.connect({
      host: options.host,
      port: options.port,
      username: options.username,
      password: options.password,
      readyTimeout: options.timeoutMs,
      // Pin the tablet's host key (TOFU) — see ssh/host-key-store.
      hostVerifier: makeHostVerifier(options.host),
      // reMarkable uses dropbear SSH with limited algorithm support
      algorithms: {
        kex: [
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
        ],
        serverHostKey: [
          'ssh-ed25519',
          'ecdsa-sha2-nistp256',
          'ssh-rsa',
        ],
      },
    });
  });
}

/** List files in a remote directory. */
function sftpReaddir(sftp: SFTPWrapper, remotePath: string): Promise<RemoteFileInfo[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) {
        reject(new Error(`Failed to list ${remotePath}: ${err.message}`));
        return;
      }
      const entries: RemoteFileInfo[] = list.map((entry) => ({
        path: `${remotePath}/${entry.filename}`,
        filename: entry.filename,
        size: entry.attrs.size,
        mtime: entry.attrs.mtime,
        isDirectory: (entry.attrs.mode & 0o040000) !== 0,
      }));
      resolve(entries);
    });
  });
}

/** Get file stats for a remote path. */
function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<{ size: number; mtime: number }> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) {
        reject(new Error(`Failed to stat ${remotePath}: ${err.message}`));
        return;
      }
      resolve({ size: stats.size, mtime: stats.mtime });
    });
  });
}

/**
 * Download a single file from remote to local using fastGet, preserving remote
 * mtime.
 *
 * Downloads to a temporary `.part` file and atomically renames it into place on
 * success. This guarantees a reader (e.g. document discovery, which runs on a
 * timer/file-watch) never observes a half-written `.content`/`.metadata` and
 * silently drops the document. A failed transfer leaves the previous good copy
 * (or nothing) rather than a torn file.
 */
function sftpDownloadFile(
  sftp: SFTPWrapper, remotePath: string, localPath: string, remoteMtime?: number,
): Promise<void> {
  const tmpPath = `${localPath}.part`;
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, tmpPath, (err) => {
      if (err) {
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore cleanup */ }
        reject(new Error(`Failed to download ${remotePath}: ${err.message}`));
        return;
      }
      // Preserve remote mtime so freshness comparisons between
      // .rm files and cache/thumbnail PNGs work correctly
      if (remoteMtime && remoteMtime > 0) {
        try {
          fs.utimesSync(tmpPath, remoteMtime, remoteMtime);
        } catch {
          // Non-fatal: mtime preservation failed
        }
      }
      try {
        fs.renameSync(tmpPath, localPath);
      } catch (renameErr) {
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore cleanup */ }
        const msg = renameErr instanceof Error ? renameErr.message : String(renameErr);
        reject(new Error(`Failed to finalize ${localPath}: ${msg}`));
        return;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------
// SftpSyncEngine
// ---------------------------------------------------------------

/**
 * SFTP-based sync engine that downloads reMarkable files over SSH.
 *
 * Usage:
 *   const engine = new SftpSyncEngine(options);
 *   const result = await engine.sync(onProgress);
 */
export class SftpSyncEngine {
  private readonly options: Required<SftpSyncOptions>;

  constructor(options: SftpSyncOptions) {
    this.options = {
      ...options,
      remotePath: options.remotePath ?? XOCHITL_SYNC_PATH,
      includeEpub: options.includeEpub ?? true,
    };
  }

  /**
   * Run a full SFTP sync: connect, list remote files, compare with local,
   * and download changed/new files.
   */
  async sync(onProgress?: SftpProgressCallback): Promise<SftpSyncResult> {
    const progress = onProgress ?? (() => {});
    const startTime = Date.now();
    const errors: string[] = [];
    let filesDownloaded = 0;
    let filesSkipped = 0;
    let bytesDownloaded = 0;

    // Ensure local sync directory exists
    fs.mkdirSync(this.options.localSyncDir, { recursive: true });

    let conn: Client | undefined;
    let sftp: SFTPWrapper | undefined;

    try {
      // Step 1: Connect
      progress('connecting', `Connecting to ${this.options.host}...`);
      logger.info(`SFTP sync: connecting to ${this.options.host}:${this.options.port}`);
      const connection = await connectSftp(this.options);
      conn = connection.conn;
      sftp = connection.sftp;
      logger.info('SFTP sync: connected');

      // Step 2: List remote files
      progress('listing', 'Reading file list from tablet...');
      const remoteFiles = await this.listRemoteFiles(sftp);
      logger.info(`SFTP sync: found ${remoteFiles.length} relevant entries on tablet`);

      // Step 3: Compare and determine what to download
      progress('comparing', `Comparing ${remoteFiles.length} files with local copies...`);
      const toDownload = this.compareFiles(remoteFiles);
      const toSkip = remoteFiles.length - toDownload.length;
      filesSkipped = toSkip;
      logger.info(`SFTP sync: ${toDownload.length} to download, ${toSkip} up to date`);

      if (toDownload.length === 0) {
        progress('complete', 'All files are up to date.');
        return this.buildResult(true, 0, filesSkipped, 0, Date.now() - startTime, errors);
      }

      // Step 4: Download files sequentially
      for (let i = 0; i < toDownload.length; i++) {
        const file = toDownload[i];
        const displayName = file.filename;
        progress('downloading', `Downloading ${displayName}`, i + 1, toDownload.length);

        try {
          if (file.isDirectory) {
            const dirResult = await this.downloadDirectory(sftp, file);
            filesDownloaded += dirResult.filesDownloaded;
            bytesDownloaded += dirResult.bytesDownloaded;
            errors.push(...dirResult.errors);
          } else {
            const localPath = path.join(this.options.localSyncDir, file.filename);
            await sftpDownloadFile(sftp, file.path, localPath, file.mtime);
            filesDownloaded++;
            bytesDownloaded += file.size;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`SFTP sync: failed to download ${file.filename}: ${msg}`);
          errors.push(`${file.filename}: ${msg}`);
        }
      }

      progress('complete', `Downloaded ${filesDownloaded} file(s).`);
      const success = errors.length === 0;
      return this.buildResult(success, filesDownloaded, filesSkipped, bytesDownloaded, Date.now() - startTime, errors);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`SFTP sync failed: ${msg}`);
      progress('error', msg);
      errors.push(msg);
      return this.buildResult(false, filesDownloaded, filesSkipped, bytesDownloaded, Date.now() - startTime, errors);
    } finally {
      // Always clean up the connection
      if (conn) {
        try {
          conn.end();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Run an incremental sync: only download files newer than the given timestamp.
   * This is a convenience wrapper around sync() that pre-filters by mtime.
   */
  async syncIncremental(
    sinceTimestamp: number,
    onProgress?: SftpProgressCallback,
  ): Promise<SftpSyncResult> {
    const progress = onProgress ?? (() => {});
    const startTime = Date.now();
    const errors: string[] = [];
    let filesDownloaded = 0;
    let filesSkipped = 0;
    let bytesDownloaded = 0;

    fs.mkdirSync(this.options.localSyncDir, { recursive: true });

    let conn: Client | undefined;
    let sftp: SFTPWrapper | undefined;

    try {
      progress('connecting', `Connecting to ${this.options.host}...`);
      const connection = await connectSftp(this.options);
      conn = connection.conn;
      sftp = connection.sftp;

      progress('listing', 'Reading file list from tablet...');
      const remoteFiles = await this.listRemoteFiles(sftp);

      // Filter to files modified after the given timestamp
      const sinceSeconds = Math.floor(sinceTimestamp / 1000);
      const newerFiles = remoteFiles.filter((f) => f.mtime > sinceSeconds);

      progress('comparing', `Found ${newerFiles.length} file(s) modified since last sync...`);
      const toDownload = this.compareFiles(newerFiles);
      filesSkipped = newerFiles.length - toDownload.length;

      if (toDownload.length === 0) {
        progress('complete', 'All files are up to date.');
        return this.buildResult(true, 0, filesSkipped, 0, Date.now() - startTime, errors);
      }

      for (let i = 0; i < toDownload.length; i++) {
        const file = toDownload[i];
        progress('downloading', `Downloading ${file.filename}`, i + 1, toDownload.length);

        try {
          if (file.isDirectory) {
            const dirResult = await this.downloadDirectory(sftp, file);
            filesDownloaded += dirResult.filesDownloaded;
            bytesDownloaded += dirResult.bytesDownloaded;
            errors.push(...dirResult.errors);
          } else {
            const localPath = path.join(this.options.localSyncDir, file.filename);
            await sftpDownloadFile(sftp, file.path, localPath, file.mtime);
            filesDownloaded++;
            bytesDownloaded += file.size;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${file.filename}: ${msg}`);
        }
      }

      progress('complete', `Downloaded ${filesDownloaded} file(s).`);
      return this.buildResult(
        errors.length === 0, filesDownloaded, filesSkipped, bytesDownloaded, Date.now() - startTime, errors,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      progress('error', msg);
      errors.push(msg);
      return this.buildResult(false, filesDownloaded, filesSkipped, bytesDownloaded, Date.now() - startTime, errors);
    } finally {
      if (conn) {
        try { conn.end(); } catch { /* ignore */ }
      }
    }
  }

  /**
   * List all relevant files in the remote xochitl directory.
   *
   * Returns: .metadata, .content, .pdf, .epub files, and UUID annotation
   * directories (which contain .rm pen stroke files).
   */
  async listRemoteFiles(sftp: SFTPWrapper): Promise<RemoteFileInfo[]> {
    const remotePath = this.options.remotePath;
    const entries = await sftpReaddir(sftp, remotePath);
    const relevant: RemoteFileInfo[] = [];

    for (const entry of entries) {
      // Skip known non-essential entries
      if (shouldSkipEntry(entry.filename, entry.isDirectory)) {
        continue;
      }

      if (entry.isDirectory) {
        // Include UUID-named directories (annotation data) and
        // UUID.cache / UUID.thumbnails directories (tablet-rendered images)
        const baseName = entry.filename.replace(/\.(cache|thumbnails)$/, '');
        if (isUuidLike(baseName)) {
          relevant.push(entry);
        }
        continue;
      }

      // Include relevant document files
      if (isRelevantFile(entry.filename, this.options.includeEpub)) {
        relevant.push(entry);
      }
    }

    return relevant;
  }

  /**
   * List files inside a remote annotation directory (UUID folder).
   * These typically contain .rm files with pen stroke data.
   */
  async listRemoteAnnotationDir(sftp: SFTPWrapper, dirPath: string): Promise<RemoteFileInfo[]> {
    try {
      return await sftpReaddir(sftp, dirPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to list annotation dir ${dirPath}: ${msg}`);
      return [];
    }
  }

  /**
   * Compare remote files against local copies.
   *
   * Returns the subset of remote files that need downloading:
   * - New files (not present locally)
   * - Changed files (different mtime for metadata/content/annotation dirs)
   * - PDFs/EPUBs: skip if local file exists with matching size (immutable)
   */
  compareFiles(remoteFiles: RemoteFileInfo[]): RemoteFileInfo[] {
    const toDownload: RemoteFileInfo[] = [];

    for (const remote of remoteFiles) {
      const localPath = path.join(this.options.localSyncDir, remote.filename);

      if (remote.isDirectory) {
        // Always check directories for updated files inside.
        // Directory mtime isn't reliable across filesystems, and .cache/.thumbnails
        // dirs contain rendering data that may update independently of the dir mtime.
        // The per-file comparison inside downloadDirectory() handles deduplication.
        toDownload.push(remote);
        continue;
      }

      // File doesn't exist locally -> download
      if (!fs.existsSync(localPath)) {
        toDownload.push(remote);
        continue;
      }

      const ext = path.extname(remote.filename).toLowerCase();

      // PDFs and EPUBs are immutable on reMarkable: skip if size matches
      if (ext === '.pdf' || ext === '.epub') {
        try {
          const localStat = fs.statSync(localPath);
          if (localStat.size === remote.size) {
            // Same size -> skip (immutable content)
            continue;
          }
        } catch {
          // Stat failed -> download
        }
        toDownload.push(remote);
        continue;
      }

      // .metadata and .content files: compare mtime
      try {
        const localStat = fs.statSync(localPath);
        const localMtime = Math.floor(localStat.mtimeMs / 1000);
        if (remote.mtime > localMtime) {
          toDownload.push(remote);
        }
      } catch {
        // Stat failed -> download
        toDownload.push(remote);
      }
    }

    return toDownload;
  }

  /**
   * Download a single file from the tablet.
   * Creates parent directories as needed.
   */
  async downloadFile(
    sftp: SFTPWrapper,
    remotePath: string,
    localPath: string,
  ): Promise<void> {
    const dir = path.dirname(localPath);
    fs.mkdirSync(dir, { recursive: true });
    await sftpDownloadFile(sftp, remotePath, localPath);
  }

  /**
   * Download all files from a remote directory (UUID annotation dir).
   * Only downloads files that are newer than local copies or missing.
   */
  async downloadDirectory(
    sftp: SFTPWrapper,
    dirInfo: RemoteFileInfo,
  ): Promise<{ filesDownloaded: number; bytesDownloaded: number; errors: string[] }> {
    const localDir = path.join(this.options.localSyncDir, dirInfo.filename);
    fs.mkdirSync(localDir, { recursive: true });

    let filesDownloaded = 0;
    let bytesDownloaded = 0;
    const errors: string[] = [];

    try {
      const entries = await this.listRemoteAnnotationDir(sftp, dirInfo.path);

      for (const entry of entries) {
        if (entry.isDirectory) continue; // Skip nested directories

        const localFilePath = path.join(localDir, entry.filename);

        // Check if local file exists and is up to date
        if (fs.existsSync(localFilePath)) {
          try {
            const localStat = fs.statSync(localFilePath);
            const localMtime = Math.floor(localStat.mtimeMs / 1000);
            if (entry.mtime <= localMtime && localStat.size === entry.size) {
              continue; // Up to date
            }
          } catch {
            // Stat failed -> download
          }
        }

        try {
          await sftpDownloadFile(sftp, entry.path, localFilePath, entry.mtime);
          filesDownloaded++;
          bytesDownloaded += entry.size;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${dirInfo.filename}/${entry.filename}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${dirInfo.filename}: ${msg}`);
    }

    return { filesDownloaded, bytesDownloaded, errors };
  }

  /** Build a SftpSyncResult object. */
  private buildResult(
    success: boolean,
    filesDownloaded: number,
    filesSkipped: number,
    bytesDownloaded: number,
    durationMs: number,
    errors: string[],
  ): SftpSyncResult {
    const mbDownloaded = (bytesDownloaded / (1024 * 1024)).toFixed(1);
    const seconds = (durationMs / 1000).toFixed(1);
    let summary: string;

    if (filesDownloaded === 0 && errors.length === 0) {
      summary = `All files up to date (${filesSkipped} checked in ${seconds}s).`;
    } else if (errors.length > 0) {
      summary = `Downloaded ${filesDownloaded} file(s) (${mbDownloaded} MB) in ${seconds}s. ` +
        `${errors.length} error(s) occurred.`;
    } else {
      summary = `Downloaded ${filesDownloaded} file(s) (${mbDownloaded} MB) in ${seconds}s. ` +
        `${filesSkipped} file(s) already up to date.`;
    }

    logger.info(`SFTP sync result: ${summary}`);

    return {
      success,
      filesDownloaded,
      filesSkipped,
      bytesDownloaded,
      durationMs,
      errors,
      summary,
    };
  }
}
