/**
 * Direct SFTP upload of a complete reMarkable document collection.
 *
 * Every local entry whose name is the document UUID or starts with `UUID.` is
 * copied to xochitl. Files are uploaded to a temporary name and renamed only
 * after the transfer completes. Metadata is committed last so xochitl never
 * discovers a document before its content and source file are ready.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SFTPWrapper, Stats } from 'ssh2';
import { connectSftp, type SftpConnectionOptions } from './sftp-connection';
import { XOCHITL_SYNC_PATH } from './types';

export interface SftpUploadOptions extends SftpConnectionOptions {
  localSyncDir: string;
  remotePath?: string;
}

export interface SftpUploadResult {
  filesUploaded: number;
  bytesUploaded: number;
}

/** Per-file progress reported while a document collection is uploaded. */
export type SftpUploadProgressCallback = (
  filename: string,
  current: number,
  total: number,
  bytesUploaded: number,
  totalBytes: number,
) => void;

interface UploadEntry {
  localPath: string;
  remotePath: string;
  isDirectory: boolean;
  size: number;
}

function isValidUuid(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

function collectEntries(
  localPath: string,
  remotePath: string,
  entries: UploadEntry[],
): void {
  const stat = fs.lstatSync(localPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to upload symbolic link: ${path.basename(localPath)}`);
  }

  if (stat.isDirectory()) {
    entries.push({ localPath, remotePath, isDirectory: true, size: 0 });
    for (const child of fs.readdirSync(localPath)) {
      collectEntries(
        path.join(localPath, child),
        path.posix.join(remotePath, child),
        entries,
      );
    }
    return;
  }

  if (!stat.isFile()) {
    throw new Error(`Refusing to upload unsupported entry: ${path.basename(localPath)}`);
  }
  entries.push({ localPath, remotePath, isDirectory: false, size: stat.size });
}

function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<Stats | null> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (!err) {
        resolve(stats);
        return;
      }
      const code = (err as Error & { code?: unknown }).code;
      if (code === 2 || code === 'ENOENT') {
        resolve(null);
        return;
      }
      reject(new Error(`Failed to inspect ${remotePath}: ${err.message}`));
    });
  });
}

function sftpLstat(sftp: SFTPWrapper, remotePath: string): Promise<Stats | null> {
  return new Promise((resolve, reject) => {
    sftp.lstat(remotePath, (err, stats) => {
      if (!err) {
        resolve(stats);
        return;
      }
      const code = (err as Error & { code?: unknown }).code;
      if (code === 2 || code === 'ENOENT') {
        resolve(null);
        return;
      }
      reject(new Error(`Failed to inspect ${remotePath}: ${err.message}`));
    });
  });
}

async function ensureRemoteDirectory(
  sftp: SFTPWrapper,
  remotePath: string,
  allowLinkedDirectory = false,
): Promise<void> {
  // The configured remote root is trusted and may intentionally be a link.
  // Collection descendants are data-controlled, so inspect the entry itself
  // and refuse to upload through a pre-existing symlink.
  const existing = allowLinkedDirectory
    ? await sftpStat(sftp, remotePath)
    : await sftpLstat(sftp, remotePath);
  if (existing) {
    if (!existing.isDirectory()) {
      throw new Error(`Remote upload path is not a directory: ${remotePath}`);
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    sftp.mkdir(remotePath, { mode: 0o755 }, (err) => {
      if (err) reject(new Error(`Failed to create ${remotePath}: ${err.message}`));
      else resolve();
    });
  });
}

function unlinkIfPresent(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => {
      if (!err) {
        resolve();
        return;
      }
      const code = (err as Error & { code?: unknown }).code;
      if (code === 2 || code === 'ENOENT') resolve();
      else reject(new Error(`Failed to replace ${remotePath}: ${err.message}`));
    });
  });
}

async function uploadFileAtomic(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  onProgress?: (bytesUploaded: number, totalBytes: number) => void,
): Promise<void> {
  const temporaryPath = `${remotePath}.eink-sync-part`;
  await unlinkIfPresent(sftp, temporaryPath);

  await new Promise<void>((resolve, reject) => {
    sftp.fastPut(localPath, temporaryPath, {
      step: (total, _chunk, fileSize) => onProgress?.(total, fileSize),
    }, (err) => {
      if (err) reject(new Error(`Failed to upload ${path.basename(localPath)}: ${err.message}`));
      else resolve();
    });
  });

  const existing = await sftpStat(sftp, remotePath);
  if (existing) await unlinkIfPresent(sftp, remotePath);

  await new Promise<void>((resolve, reject) => {
    sftp.rename(temporaryPath, remotePath, (err) => {
      if (err) reject(new Error(`Failed to commit ${path.basename(localPath)}: ${err.message}`));
      else resolve();
    });
  });
}

/** Upload a local UUID collection through an already-open SFTP session. */
export async function uploadDocumentCollectionWithSftp(
  sftp: SFTPWrapper,
  localSyncDir: string,
  remoteRoot: string,
  uuid: string,
  onProgress?: SftpUploadProgressCallback,
): Promise<SftpUploadResult> {
  if (!isValidUuid(uuid)) throw new Error('Refusing to upload a document with an invalid UUID.');
  if (!fs.existsSync(localSyncDir) || !fs.statSync(localSyncDir).isDirectory()) {
    throw new Error('Local sync folder is unavailable.');
  }

  const topLevel = fs.readdirSync(localSyncDir).filter(
    (entry) => entry === uuid || entry.startsWith(`${uuid}.`),
  );
  if (topLevel.length === 0) throw new Error('No local document files are available to upload.');

  const entries: UploadEntry[] = [];
  for (const entry of topLevel) {
    collectEntries(
      path.join(localSyncDir, entry),
      path.posix.join(remoteRoot, entry),
      entries,
    );
  }

  await ensureRemoteDirectory(sftp, remoteRoot, true);
  for (const directory of entries.filter((entry) => entry.isDirectory)) {
    await ensureRemoteDirectory(sftp, directory.remotePath);
  }

  const files = entries
    .filter((entry) => !entry.isDirectory)
    .sort((a, b) => {
      const aMetadata = a.remotePath.endsWith('.metadata') ? 1 : 0;
      const bMetadata = b.remotePath.endsWith('.metadata') ? 1 : 0;
      return aMetadata - bMetadata || a.remotePath.localeCompare(b.remotePath);
    });

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let bytesUploaded = 0;
  if (files.length > 0) {
    onProgress?.(path.basename(files[0].localPath), 1, files.length, 0, totalBytes);
  }
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    let lastFileBytes = 0;
    await uploadFileAtomic(
      sftp,
      file.localPath,
      file.remotePath,
      (fileBytes, fileTotal) => {
        const boundedFileBytes = Math.min(fileBytes, fileTotal, file.size);
        lastFileBytes = boundedFileBytes;
        onProgress?.(
          path.basename(file.localPath),
          index + 1,
          files.length,
          bytesUploaded + boundedFileBytes,
          totalBytes,
        );
      },
    );
    bytesUploaded += file.size;
    if (lastFileBytes < file.size) {
      onProgress?.(
        path.basename(file.localPath),
        index + 1,
        files.length,
        bytesUploaded,
        totalBytes,
      );
    }
  }

  return { filesUploaded: files.length, bytesUploaded };
}

/** Connect to the tablet and upload a complete local UUID collection. */
export async function uploadDocumentCollection(
  options: SftpUploadOptions,
  uuid: string,
  onProgress?: SftpUploadProgressCallback,
): Promise<SftpUploadResult> {
  const connection = await connectSftp(options);
  try {
    return await uploadDocumentCollectionWithSftp(
      connection.sftp,
      options.localSyncDir,
      options.remotePath ?? XOCHITL_SYNC_PATH,
      uuid,
      onProgress,
    );
  } finally {
    connection.conn.end();
  }
}
