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
 * - Every UUID and UUID.* collection entry is preserved, including unknown
 *   future sidecars and recursively nested directories.
 * - Files are compared by mtime+size and downloaded atomically.
 * - Unsafe traversal names, symlinks, and special files fail the document
 *   closed instead of being followed or copied outside the sync directory.
 * - Progress callback for UI integration.
 *
 * Privacy: Only communicates with the user's tablet over SSH/SFTP.
 * No external network calls.
 */

import { Client, SFTPWrapper } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { BridgeError } from '../types/errors';
import type { ConnectionMethod } from '../types/config';
import { connectSftp } from './sftp-connection';
import { XOCHITL_SYNC_PATH } from './types';
import {
  assertSafeRemotePathSegment,
  documentUuidForCollectionEntry,
} from './document-collection';

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
  /** Whether this endpoint is reached over the tablet's USB or WiFi interface. */
  connectionMethod: ConnectionMethod;
  /** Local directory to sync files into (absolute path). */
  localSyncDir: string;
  /** Remote xochitl path on the tablet. */
  remotePath?: string;
  /**
   * Retained for API compatibility. Complete backups always sync EPUB source
   * files; the extraction pipeline separately decides whether to process them.
   */
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
  /** Owning document UUID for UUID / UUID.* collection entries. */
  documentUuid?: string;
  /** Filesystem entry type. Symlinks and special files are never downloaded. */
  entryType?: 'file' | 'directory' | 'symlink' | 'special';
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
// Collection state
// ---------------------------------------------------------------

/**
 * Markers live outside document collections so they can never be uploaded to
 * the tablet when an archived document is restored.
 */
const INCOMPLETE_MARKER = '.eink-sync-incomplete';
const SYNC_STATE_DIR = '.eink-sync-state';
const MAX_COLLECTION_DEPTH = 64;

const FILE_TYPE_MASK = 0o170000;
const REGULAR_FILE_TYPE = 0o100000;
const DIRECTORY_TYPE = 0o040000;
const SYMLINK_TYPE = 0o120000;

function entryTypeFromMode(mode: number): RemoteFileInfo['entryType'] {
  switch (mode & FILE_TYPE_MASK) {
    case REGULAR_FILE_TYPE: return 'file';
    case DIRECTORY_TYPE: return 'directory';
    case SYMLINK_TYPE: return 'symlink';
    default: return 'special';
  }
}

function isRegenerableCollectionEntry(filename: string, uuid: string): boolean {
  return filename === `${uuid}.cache` || filename === `${uuid}.thumbnails`;
}

/** Template asset formats shipped by supported firmware generations. */
export function isSupportedTemplateAsset(filename: string): boolean {
  const lower = filename.toLowerCase();
  return filename === 'templates.json'
    || lower.endsWith('.png')
    || lower.endsWith('.template')
    || lower.endsWith('.svg');
}

// ---------------------------------------------------------------
// SFTP helpers (promisified wrappers around ssh2 callbacks)
// ---------------------------------------------------------------

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
        isDirectory: (entry.attrs.mode & FILE_TYPE_MASK) === DIRECTORY_TYPE,
        entryType: entryTypeFromMode(entry.attrs.mode),
      }));
      resolve(entries);
    });
  });
}

function missingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Return the target's path segments below a trusted local root. */
function localDescendantSegments(localRoot: string, targetPath: string): string[] {
  const root = path.resolve(localRoot);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === '') return [];
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside the local sync directory: ${targetPath}`);
  }
  return relative.split(path.sep);
}

/** Create descendants one segment at a time without following links. */
function ensureSafeLocalDirectory(localRoot: string, directoryPath: string): void {
  const root = path.resolve(localRoot);
  fs.mkdirSync(root, { recursive: true });
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Local sync path is not a directory: ${localRoot}`);
  }

  let current = root;
  for (const segment of localDescendantSegments(root, directoryPath)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (!missingPath(error)) throw error;
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write through a local symlink or junction: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Local download parent is not a directory: ${current}`);
    }
  }
}

/** Validate the destination and temporary file before SFTP opens either. */
function assertSafeLocalFileTarget(localRoot: string, localPath: string): void {
  localDescendantSegments(localRoot, localPath);
  ensureSafeLocalDirectory(localRoot, path.dirname(localPath));

  for (const candidate of [localPath, `${localPath}.part`]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (missingPath(error)) continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write through a local symlink or junction: ${candidate}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Local download target is not a regular file: ${candidate}`);
    }
  }
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
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  remoteMtime?: number,
  validateLocalPaths?: () => void,
): Promise<void> {
  validateLocalPaths?.();
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
        validateLocalPaths?.();
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

  private downloadToLocalFile(
    sftp: SFTPWrapper,
    remotePath: string,
    localPath: string,
    remoteMtime?: number,
    localRoot = this.options.localSyncDir,
  ): Promise<void> {
    const validate = (): void => assertSafeLocalFileTarget(localRoot, localPath);
    return sftpDownloadFile(sftp, remotePath, localPath, remoteMtime, validate);
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
      const msg = err instanceof BridgeError
        ? err.toUserMessage()
        : err instanceof Error ? err.message : String(err);
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
   * .content files are held back this run; the stale local metadata makes
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
    const attemptedDocs = new Set(
      toDownload
        .map((entry) => entry.documentUuid ?? documentUuidForCollectionEntry(entry.filename))
        .filter((uuid): uuid is string => uuid !== null && uuid !== undefined),
    );

    // Quarantine discovery sidecars for a document before transfer ordering
    // can expose them. The special entry itself is still visited and reported.
    for (const entry of toDownload) {
      const entryType = entry.entryType ?? (entry.isDirectory ? 'directory' : 'file');
      if (entryType === 'file' || entryType === 'directory') continue;
      const uuid = entry.documentUuid ?? documentUuidForCollectionEntry(entry.filename);
      if (uuid && !isRegenerableCollectionEntry(entry.filename, uuid)) failedDocs.add(uuid);
    }

    for (let i = 0; i < toDownload.length; i++) {
      const file = toDownload[i];
      const verb = file.isDirectory ? 'Syncing' : 'Downloading';
      progress('downloading', `${verb} ${file.filename}`, i + 1, toDownload.length);

      try {
        const entryType = file.entryType ?? (file.isDirectory ? 'directory' : 'file');
        if (entryType !== 'file' && entryType !== 'directory') {
          throw new Error(
            `Unsupported ${entryType} in tablet document collection: ${file.filename}`,
          );
        }
        if (file.isDirectory) {
          const dirResult = await this.downloadDirectory(sftp, file);
          filesDownloaded += dirResult.filesDownloaded;
          bytesDownloaded += dirResult.bytesDownloaded;
          if (dirResult.errors.length > 0) {
            const uuid = file.documentUuid ?? documentUuidForCollectionEntry(file.filename);
            if (uuid && !isRegenerableCollectionEntry(file.filename, uuid)) failedDocs.add(uuid);
          }
          errors.push(...dirResult.errors);
        } else {
          const ext = path.extname(file.filename).toLowerCase();
          const uuid = file.documentUuid ?? documentUuidForCollectionEntry(file.filename);
          if (uuid && (ext === '.metadata' || ext === '.content') && failedDocs.has(uuid)) {
            logger.warn(
              `SFTP sync: holding back ${file.filename} (page data failed; will retry next sync)`,
            );
            continue;
          }
          const localPath = path.join(this.options.localSyncDir, file.filename);
          await this.downloadToLocalFile(sftp, file.path, localPath, file.mtime);
          filesDownloaded++;
          bytesDownloaded += file.size;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`SFTP sync: failed to download ${file.filename}: ${msg}`);
        errors.push(`${file.filename}: ${msg}`);
        const uuid = file.documentUuid ?? documentUuidForCollectionEntry(file.filename);
        if (uuid && !isRegenerableCollectionEntry(file.filename, uuid)) failedDocs.add(uuid);
      }
    }

    for (const uuid of attemptedDocs) {
      this.setIncompleteMarker(uuid, failedDocs.has(uuid));
    }

    return { filesDownloaded, bytesDownloaded, errors };
  }

  private incompleteMarkerPath(uuid: string): string {
    return path.join(this.options.localSyncDir, SYNC_STATE_DIR, `${uuid}${INCOMPLETE_MARKER}`);
  }

  private setIncompleteMarker(uuid: string, incomplete: boolean): void {
    const markerPath = this.incompleteMarkerPath(uuid);
    try {
      if (incomplete) {
        assertSafeLocalFileTarget(this.options.localSyncDir, markerPath);
        fs.writeFileSync(markerPath, '');
      } else {
        fs.rmSync(markerPath, { force: true });
      }
    } catch {
      // Best effort. Download errors are still returned to the caller.
    }
  }

  /**
   * List all relevant files in the remote xochitl directory.
   *
   * Every exact UUID and UUID.* entry belongs to the document collection.
   * This intentionally does not use an extension allowlist: newer firmware
   * can add sidecars without requiring a plugin release first.
   */
  async listRemoteFiles(sftp: SFTPWrapper): Promise<RemoteFileInfo[]> {
    const remotePath = this.options.remotePath;
    const entries = await sftpReaddir(sftp, remotePath);
    const relevant: RemoteFileInfo[] = [];

    for (const entry of entries) {
      const documentUuid = documentUuidForCollectionEntry(entry.filename);
      if (!documentUuid) continue;

      assertSafeRemotePathSegment(entry.filename);
      const entryType = entry.entryType ?? (entry.isDirectory ? 'directory' : 'file');
      relevant.push({ ...entry, documentUuid, entryType });
    }

    return relevant;
  }

  /**
   * List files inside a remote annotation directory (UUID folder).
   * These typically contain .rm files with pen stroke data.
   *
   * Throws on listing failure; swallowing it here would make the dir look
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
   * - Every collection directory: recursively inventoried on every run because
   *   nested files can change without a reliable parent/metadata timestamp;
   *   downloadDirectory() still deduplicates unchanged regular files.
   *
   * Directories are ordered before files so page data lands before the
   * .metadata/.content that gates it; a failed dir download leaves the old
   * metadata in place and is retried on the next sync.
   */
  compareFiles(remoteFiles: RemoteFileInfo[]): RemoteFileInfo[] {
    const incompleteDocs = new Set<string>();
    for (const remote of remoteFiles) {
      const uuid = remote.documentUuid ?? documentUuidForCollectionEntry(remote.filename);
      if (uuid && fs.existsSync(this.incompleteMarkerPath(uuid))) incompleteDocs.add(uuid);
    }

    const dirs: RemoteFileInfo[] = [];
    const files: RemoteFileInfo[] = [];

    for (const remote of remoteFiles) {
      const entryType = remote.entryType ?? (remote.isDirectory ? 'directory' : 'file');
      if (entryType !== 'file' && entryType !== 'directory') {
        // Never let a pre-existing local path make an unsupported remote entry
        // appear up to date. downloadAll() records this as a document failure.
        files.push(remote);
        continue;
      }
      if (remote.isDirectory) {
        // Recursively inventory every collection directory. A nested sidecar
        // can change without metadata or the parent directory mtime changing.
        dirs.push(remote);
        continue;
      }
      const uuid = remote.documentUuid ?? documentUuidForCollectionEntry(remote.filename);
      if ((uuid && incompleteDocs.has(uuid)) || this.fileNeedsDownload(remote)) {
        files.push(remote);
      }
    }

    // Commit metadata/content last. If any earlier authoritative collection
    // member fails, downloadAll() holds these mutable discovery sidecars back.
    // Regenerable cache/thumbnail failures are reported but do not gate them.
    files.sort((a, b) => {
      const aExt = path.extname(a.filename).toLowerCase();
      const bExt = path.extname(b.filename).toLowerCase();
      const aCommit = aExt === '.metadata' || aExt === '.content' ? 1 : 0;
      const bCommit = bExt === '.metadata' || bExt === '.content' ? 1 : 0;
      return aCommit - bCommit || a.filename.localeCompare(b.filename);
    });
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
        const localStat = fs.lstatSync(localPath);
        return !localStat.isFile() || localStat.isSymbolicLink() || localStat.size !== remote.size;
      } catch {
        return true;
      }
    }

    // Everything else (.metadata/.content): compare mtime and size. xochitl
    // can rewrite a sidecar within the same one-second mtime tick, so checking
    // only mtime can leave an older local file that later fails archive's
    // byte-for-byte backup verification.
    try {
      const localStat = fs.lstatSync(localPath);
      if (!localStat.isFile() || localStat.isSymbolicLink()) return true;
      const localMtime = Math.floor(localStat.mtimeMs / 1000);
      return remote.mtime > localMtime || remote.size !== localStat.size;
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
    await this.downloadToLocalFile(sftp, remotePath, localPath);
  }

  /**
   * Download all files from a remote directory (UUID annotation dir).
   * Only downloads files that are newer than local copies or missing.
   */
  async downloadDirectory(
    sftp: SFTPWrapper,
    dirInfo: RemoteFileInfo,
  ): Promise<{ filesDownloaded: number; bytesDownloaded: number; errors: string[] }> {
    assertSafeRemotePathSegment(dirInfo.filename);
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

    ensureSafeLocalDirectory(this.options.localSyncDir, localDir);

    const walk = async (
      currentEntries: RemoteFileInfo[],
      currentLocalDir: string,
      relativePrefix: string,
      depth: number,
    ): Promise<void> => {
      if (depth > MAX_COLLECTION_DEPTH) {
        errors.push(`${relativePrefix}: collection nesting exceeds ${MAX_COLLECTION_DEPTH} levels`);
        return;
      }

      for (const entry of currentEntries) {
        const relativeName = `${relativePrefix}/${entry.filename}`;
        try {
          assertSafeRemotePathSegment(entry.filename);
          const entryType = entry.entryType ?? (entry.isDirectory ? 'directory' : 'file');
          if (entryType !== 'file' && entryType !== 'directory') {
            throw new Error(`unsupported ${entryType}`);
          }

          const localEntryPath = path.join(currentLocalDir, entry.filename);
          if (entryType === 'directory') {
            let children: RemoteFileInfo[];
            try {
              children = await this.listRemoteAnnotationDir(sftp, entry.path);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(`${relativeName}: ${msg}`);
              continue;
            }
            ensureSafeLocalDirectory(this.options.localSyncDir, localEntryPath);
            await walk(children, localEntryPath, relativeName, depth + 1);
            continue;
          }

          if (fs.existsSync(localEntryPath)) {
            try {
              const localStat = fs.lstatSync(localEntryPath);
              const localMtime = Math.floor(localStat.mtimeMs / 1000);
              if (localStat.isFile() && entry.mtime <= localMtime && localStat.size === entry.size) {
                continue;
              }
            } catch {
              // Stat failed -> download
            }
          }

          await this.downloadToLocalFile(sftp, entry.path, localEntryPath, entry.mtime);
          filesDownloaded++;
          bytesDownloaded += entry.size;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${relativeName}: ${msg}`);
        }
      }
    };

    await walk(entries, localDir, dirInfo.filename, 1);

    return { filesDownloaded, bytesDownloaded, errors };
  }

  /**
   * Fetch the reMarkable page-template art from the tablet.
   *
   * The templates (ruled/grid/planner backgrounds) live at
   * `/usr/share/remarkable/templates/` on the device and are NOT part of the
   * synced xochitl data, so they must be pulled separately. Downloads
   * `templates.json`, every `*.png` (older firmware), `*.template` vector
   * definition, and `*.svg` asset (including Paper Pro firmware) into
   * `localTemplatesDir`, skipping files already present and up to date.
   * Manages its own connection.
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

      ensureSafeLocalDirectory(localTemplatesDir, localTemplatesDir);
      const entries = await sftpReaddir(sftp, remoteTemplatesDir);

      for (const entry of entries) {
        // Two firmware generations: older devices ship PNG art, firmware 3.x
        // ships `.template` definitions or SVG assets. Take all supported art
        // plus the name-to-file map.
        if (!isSupportedTemplateAsset(entry.filename)) continue;

        try {
          assertSafeRemotePathSegment(entry.filename);
          const entryType = entry.entryType ?? (entry.isDirectory ? 'directory' : 'file');
          if (entryType !== 'file') throw new Error(`unsupported ${entryType}`);
        } catch (err) {
          errors.push(`${entry.filename}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        const localFilePath = path.join(localTemplatesDir, entry.filename);
        if (fs.existsSync(localFilePath)) {
          try {
            const localStat = fs.lstatSync(localFilePath);
            const localMtime = Math.floor(localStat.mtimeMs / 1000);
            if (
              localStat.isFile()
              && !localStat.isSymbolicLink()
              && entry.mtime <= localMtime
              && localStat.size === entry.size
            ) {
              continue; // up to date
            }
          } catch {
            // fall through and re-download
          }
        }

        try {
          await this.downloadToLocalFile(
            sftp,
            entry.path,
            localFilePath,
            entry.mtime,
            localTemplatesDir,
          );
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
