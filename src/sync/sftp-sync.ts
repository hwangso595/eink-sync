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
 * - Annotation dirs (UUID folders with .rm files) are only listed when the
 *   document's .metadata/.content changed (xochitl rewrites those on every
 *   save), so unchanged documents cost zero extra round trips per sync.
 *   Within a listed dir, files are compared by mtime+size.
 * - Skips non-essential directories: .textconversion, .highlights, .stfolder,
 *   .cache and .thumbnails (tablet-rendered previews the extraction pipeline
 *   never reads, regenerated on every page view), .pagedata files, and
 *   Syncthing conflict files.
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
 * Marker file left inside a local annotation dir whose last download had
 * errors. Its presence forces compareFiles() to re-include the dir on the
 * next sync even when the doc's metadata looks up to date, so a partial
 * download can never masquerade as a complete one.
 */
const INCOMPLETE_MARKER = '.eink-sync-incomplete';

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
      // Preserve remote mtime so the next sync's freshness comparisons
      // (fileNeedsDownload, per-file checks in downloadDirectory) see
      // unchanged files as up to date instead of re-downloading them
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

      // Step 4: Download files sequentially (annotation dirs first)
      const dl = await this.downloadAll(sftp, toDownload, progress);
      filesDownloaded = dl.filesDownloaded;
      bytesDownloaded = dl.bytesDownloaded;
      errors.push(...dl.errors);

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
   * Download the compared set sequentially: annotation dirs first, then files.
   *
   * When a document's annotation dir had download errors, its .metadata and
   * .content files are held back this run — the stale local metadata makes
   * compareFiles() re-include the dir on the next sync instead of silently
   * leaving pages missing.
   */
  private async downloadAll(
    sftp: SFTPWrapper,
    toDownload: RemoteFileInfo[],
    progress: SftpProgressCallback,
  ): Promise<{ filesDownloaded: number; bytesDownloaded: number; errors: string[] }> {
    let filesDownloaded = 0;
    let bytesDownloaded = 0;
    const errors: string[] = [];
    const failedDocs = new Set<string>();

    for (let i = 0; i < toDownload.length; i++) {
      const file = toDownload[i];
      const verb = file.isDirectory ? 'Syncing' : 'Downloading';
      progress('downloading', `${verb} ${file.filename}`, i + 1, toDownload.length);

      try {
        if (file.isDirectory) {
          const dirResult = await this.downloadDirectory(sftp, file);
          filesDownloaded += dirResult.filesDownloaded;
          bytesDownloaded += dirResult.bytesDownloaded;
          if (dirResult.errors.length > 0) {
            failedDocs.add(file.filename);
          }
          errors.push(...dirResult.errors);
        } else {
          const ext = path.extname(file.filename).toLowerCase();
          const uuid = path.basename(file.filename, ext);
          if ((ext === '.metadata' || ext === '.content') && failedDocs.has(uuid)) {
            logger.warn(
              `SFTP sync: holding back ${file.filename} (page data failed; will retry next sync)`,
            );
            continue;
          }
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

    return { filesDownloaded, bytesDownloaded, errors };
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
        // Include only UUID-named annotation directories. UUID.cache /
        // UUID.thumbnails hold tablet-rendered previews that the pipeline
        // renders itself from stroke data — syncing them would re-download
        // every page's preview each scan (they're touched on every page view).
        if (isUuidLike(entry.filename)) {
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
   *
   * Throws on listing failure — swallowing it here would make the dir look
   * successfully synced (zero errors), defeating the retry logic that keys
   * off download errors.
   */
  async listRemoteAnnotationDir(sftp: SFTPWrapper, dirPath: string): Promise<RemoteFileInfo[]> {
    return await sftpReaddir(sftp, dirPath);
  }

  /**
   * Compare remote files against local copies.
   *
   * Returns the subset of remote files that need downloading:
   * - New files (not present locally)
   * - Changed files (newer mtime for .metadata/.content)
   * - PDFs/EPUBs: skip if local file exists with matching size (immutable)
   * - Annotation dirs: only when the document changed — judged by its
   *   .metadata/.content files, which xochitl rewrites on every save. Dirs
   *   with no metadata sibling in the listing or no local copy are always
   *   included (conservative fallback; per-file comparison inside
   *   downloadDirectory() still deduplicates).
   *
   * Directories are ordered before files so page data lands before the
   * .metadata/.content that gates it — a failed dir download leaves the old
   * metadata in place and is retried on the next sync.
   */
  compareFiles(remoteFiles: RemoteFileInfo[]): RemoteFileInfo[] {
    // First pass: which documents changed, judged by their sidecar files
    const docChanged = new Map<string, boolean>();
    for (const remote of remoteFiles) {
      if (remote.isDirectory) continue;
      const ext = path.extname(remote.filename).toLowerCase();
      if (ext !== '.metadata' && ext !== '.content') continue;
      const uuid = path.basename(remote.filename, ext);
      const changed = docChanged.get(uuid) ?? false;
      docChanged.set(uuid, changed || this.fileNeedsDownload(remote));
    }

    const dirs: RemoteFileInfo[] = [];
    const files: RemoteFileInfo[] = [];

    for (const remote of remoteFiles) {
      if (remote.isDirectory) {
        const localDir = path.join(this.options.localSyncDir, remote.filename);
        const incomplete = fs.existsSync(path.join(localDir, INCOMPLETE_MARKER));
        if (
          docChanged.get(remote.filename) !== false
          || incomplete
          || !fs.existsSync(localDir)
        ) {
          dirs.push(remote);
        }
        continue;
      }
      if (this.fileNeedsDownload(remote)) {
        files.push(remote);
      }
    }

    return [...dirs, ...files];
  }

  /** Decide whether a single remote (non-directory) file needs downloading. */
  private fileNeedsDownload(remote: RemoteFileInfo): boolean {
    const localPath = path.join(this.options.localSyncDir, remote.filename);

    if (!fs.existsSync(localPath)) return true;

    const ext = path.extname(remote.filename).toLowerCase();

    // PDFs and EPUBs are immutable on reMarkable: skip if size matches
    if (ext === '.pdf' || ext === '.epub') {
      try {
        return fs.statSync(localPath).size !== remote.size;
      } catch {
        return true;
      }
    }

    // Everything else (.metadata/.content): compare mtime
    try {
      const localMtime = Math.floor(fs.statSync(localPath).mtimeMs / 1000);
      return remote.mtime > localMtime;
    } catch {
      return true;
    }
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

    let filesDownloaded = 0;
    let bytesDownloaded = 0;
    const errors: string[] = [];

    // List first, before creating the local dir: a failed listing must not
    // consume compareFiles()'s missing-local-dir fallback.
    let entries: RemoteFileInfo[];
    try {
      entries = await this.listRemoteAnnotationDir(sftp, dirInfo.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to list annotation dir ${dirInfo.path}: ${msg}`);
      errors.push(`${dirInfo.filename}: ${msg}`);
      return { filesDownloaded, bytesDownloaded, errors };
    }

    fs.mkdirSync(localDir, { recursive: true });

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

    // Maintain the incomplete marker so a partial download is re-attempted
    // next sync even after the doc's metadata catches up locally.
    const markerPath = path.join(localDir, INCOMPLETE_MARKER);
    try {
      if (errors.length > 0) {
        fs.writeFileSync(markerPath, '');
      } else {
        fs.rmSync(markerPath, { force: true });
      }
    } catch {
      // Best-effort: marker maintenance must not fail the sync
    }

    return { filesDownloaded, bytesDownloaded, errors };
  }

  /**
   * Fetch the reMarkable page-template art from the tablet.
   *
   * The templates (ruled/grid/planner backgrounds) live at
   * `/usr/share/remarkable/templates/` on the device and are NOT part of the
   * synced xochitl data, so they must be pulled separately. Downloads
   * `templates.json`, every `*.png` (older firmware) and every `*.template`
   * (firmware 3.x vector definitions) into `localTemplatesDir`, skipping files
   * already present and up to date. Manages its own connection.
   *
   * Best-effort: returns the count and any per-file errors rather than throwing,
   * so a template-fetch hiccup never fails the document sync.
   */
  async fetchTemplates(
    localTemplatesDir: string,
    remoteTemplatesDir = '/usr/share/remarkable/templates',
  ): Promise<{ downloaded: number; errors: string[] }> {
    const errors: string[] = [];
    let downloaded = 0;
    let conn: Client | undefined;

    try {
      const connection = await connectSftp(this.options);
      conn = connection.conn;
      const sftp = connection.sftp;

      fs.mkdirSync(localTemplatesDir, { recursive: true });
      const entries = await sftpReaddir(sftp, remoteTemplatesDir);

      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const lower = entry.filename.toLowerCase();
        // Two firmware generations: older devices ship PNG art, firmware 3.x
        // ships `.template` vector definitions (and no PNGs at all). Take
        // both, plus the name->file map.
        if (!lower.endsWith('.png') && !lower.endsWith('.template')
            && entry.filename !== 'templates.json') continue;

        const localFilePath = path.join(localTemplatesDir, entry.filename);
        if (fs.existsSync(localFilePath)) {
          try {
            const localStat = fs.statSync(localFilePath);
            const localMtime = Math.floor(localStat.mtimeMs / 1000);
            if (entry.mtime <= localMtime && localStat.size === entry.size) {
              continue; // up to date
            }
          } catch {
            // fall through and re-download
          }
        }

        try {
          await sftpDownloadFile(sftp, entry.path, localFilePath, entry.mtime);
          downloaded++;
        } catch (err) {
          errors.push(`${entry.filename}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      errors.push(`templates: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      try { conn?.end(); } catch { /* ignore */ }
    }

    return { downloaded, errors };
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
