/**
 * Archive manager for old/read documents on the reMarkable tablet.
 *
 * "Archive" means: remove from tablet to free space, keep in vault.
 * Uses Syncthing's .stignore to prevent re-syncing archived files.
 *
 * Privacy: All operations happen over SSH to the user's own tablet.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { SSHExecutor } from '../ssh/ssh-client';
import { logger } from '../utils/logger';
import { isRecord, parseJson } from '../utils/json';
import { isValidUuid } from './uuid-validation';
import {
  collectionPathDepth,
  normalizeDocumentRelativePath,
} from '../sync/document-collection';

/** Remote xochitl data directory on the tablet. */
const XOCHITL_DIR = '/home/root/.local/share/remarkable/xochitl';

/** Options controlling which documents are eligible for archiving. */
export interface ArchiveOptions {
  /** Disk usage percentage (0-100) above which archiving kicks in. */
  thresholdPercent: number;
  /** Minimum age in days before a document is eligible for archiving. */
  minAgeDays: number;
  /**
   * If true, ignore the disk usage threshold and archive all eligible docs.
   * NOTE: `force` only bypasses the disk-usage gate. It does NOT bypass the
   * local-backup verification below; archiving deletes from the tablet, so we
   * never delete a document we can't prove is already in the vault.
   */
  force: boolean;
  /**
   * Absolute path to the local synced copy of the xochitl directory. Required:
   * before deleting any document from the tablet, we confirm its complete
   * collection exists here with matching types, sizes, and checksums. Without
   * a confirmed backup, "archive" would be "delete forever".
   */
  localSyncDir: string;
}

/** Parse Use% from the final df row, even when a long filesystem wraps it. */
export function parseDfUsagePercent(output: string): number | null {
  const fields = output.trim().split(/\s+/);
  if (fields.length < 5) return null;

  const match = /^(\d+)%$/.exec(fields.at(-2) ?? '');
  if (!match) return null;

  const usagePercent = Number(match[1]);
  return Number.isInteger(usagePercent) && usagePercent >= 0 && usagePercent <= 100
    ? usagePercent
    : null;
}

/**
 * Confirm a document is safely backed up in the local sync folder before we
 * delete it from the tablet. Requires the metadata + content sidecars and the
 * actual document body (the source PDF/EPUB, or; for notebooks; the page
 * directory with at least one stroke file).
 *
 * Conservative by design: any doubt returns false, so the doc is kept on the
 * tablet rather than risked.
 */
export function hasLocalBackup(localSyncDir: string, uuid: string): boolean {
  const nonEmptyFile = (p: string): boolean => {
    try {
      const st = fs.statSync(p);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  };
  // A directory counts only if it recursively holds a non-empty regular file.
  // Future firmware may nest page assets; links are never followed.
  const dirHasContent = (p: string): boolean => {
    try {
      const root = fs.lstatSync(p);
      if (root.isSymbolicLink() || !root.isDirectory()) return false;
      const pending = [p];
      while (pending.length > 0) {
        const directory = pending.pop()!;
        for (const name of fs.readdirSync(directory)) {
          const entryPath = path.join(directory, name);
          const stat = fs.lstatSync(entryPath);
          if (stat.isSymbolicLink()) return false;
          if (stat.isFile() && stat.size > 0) return true;
          if (stat.isDirectory()) pending.push(entryPath);
        }
      }
      return false;
    } catch {
      return false;
    }
  };

  const base = path.join(localSyncDir, uuid);

  // Sidecars must be present and non-empty.
  if (!nonEmptyFile(`${base}.metadata`)) return false;
  if (!nonEmptyFile(`${base}.content`)) return false;

  // Document body: a synced source file, or a non-empty annotation dir
  // (notebooks have no source file; their content lives entirely in {uuid}/).
  const hasBody =
    nonEmptyFile(`${base}.pdf`) ||
    nonEmptyFile(`${base}.epub`) ||
    dirHasContent(base);

  return hasBody;
}

/** Exact, typed tablet snapshot used for backup verification and deletion. */
export interface TabletDocumentManifestEntry {
  relativePath: string;
  type: 'file' | 'directory';
  size: number;
  mtime: number;
  /** SHA-256 for files; null for directories. */
  sha256: string | null;
}

export interface TabletDocumentManifest {
  uuid: string;
  entries: TabletDocumentManifestEntry[];
}

/** Quote a validated remote path for the tablet's POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export interface DocumentResyncProtection {
  uuid: string;
  /** Exact lines appended by this operation; pre-existing lines are omitted. */
  addedLines: string[];
}

/** Failure raised while deletion is still known not to have started. */
class PreDeleteVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreDeleteVerificationError';
  }
}

function archiveIgnoreLines(uuid: string): string[] {
  if (!isValidUuid(uuid)) throw new Error('Refusing to modify ignore rules for an invalid UUID.');
  // Leading slashes anchor at the xochitl root. A wildcard only after the
  // literal dot covers sidecars without matching an unrelated UUIDsuffix.
  return [`/${uuid}`, `/${uuid}.*`];
}

function legacyArchiveIgnoreLines(uuid: string): string[] {
  return [uuid, `${uuid}.*`, `${uuid}/`, `${uuid}*`];
}

/** Add exact, deduplicated Syncthing protection and report what changed. */
export async function protectDocumentFromResync(
  ssh: SSHExecutor,
  uuid: string,
): Promise<DocumentResyncProtection> {
  const lines = archiveIgnoreLines(uuid);
  const commands = lines.map((line) =>
    `if ! grep -Fqx ${shellQuote(line)} .stignore; then ` +
    `printf '%s\\n' ${shellQuote(line)} >> .stignore && printf '%s\\n' ${shellQuote(line)}; fi`,
  );
  const result = await ssh.execute(
    `cd ${XOCHITL_DIR} && touch .stignore && ${commands.join(' && ')}`,
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`Could not protect archived document from re-sync${detail ? `: ${detail}` : '.'}`);
  }

  const addedLines = result.stdout.split('\n').filter((line) => lines.includes(line));
  return { uuid: uuid.toLowerCase(), addedLines: [...new Set(addedLines)] };
}

async function removeDocumentIgnoreLines(
  ssh: SSHExecutor,
  uuid: string,
  lines: string[],
): Promise<void> {
  archiveIgnoreLines(uuid);
  if (lines.length === 0) return;
  const allowed = new Set([...archiveIgnoreLines(uuid), ...legacyArchiveIgnoreLines(uuid)]);
  if (lines.some((line) => !allowed.has(line))) {
    throw new Error('Refusing to remove an unexpected ignore rule.');
  }

  const condition = lines.map((line) => `$0 != "${line}"`).join(' && ');
  const temporary = `.stignore.eink-sync-${uuid}.tmp`;
  const original = `.stignore.eink-sync-${uuid}.orig`;
  const result = await ssh.execute(
    `cd ${XOCHITL_DIR} && if [ -f .stignore ]; then ` +
    `cp .stignore ${original} && ` +
    `awk '${condition} { print }' ${original} > ${temporary} && ` +
    `cmp -s ${original} .stignore && mv ${temporary} .stignore; ` +
    `status=$?; rm -f ${original} ${temporary}; exit $status; fi`,
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`Could not update tablet ignore rules${detail ? `: ${detail}` : '.'}`);
  }
}

/** Remove exact current and legacy archive rules before restoring a document. */
export async function unprotectDocumentFromResync(
  ssh: SSHExecutor,
  uuid: string,
): Promise<void> {
  await removeDocumentIgnoreLines(
    ssh,
    uuid,
    [...archiveIgnoreLines(uuid), ...legacyArchiveIgnoreLines(uuid)],
  );
}

async function deleteProtectedVerifiedTabletDocument(
  ssh: SSHExecutor,
  manifest: TabletDocumentManifest,
): Promise<void> {
  const protection = await protectDocumentFromResync(ssh, manifest.uuid);
  try {
    await deleteVerifiedTabletDocument(ssh, manifest);
  } catch (err) {
    // Once a delete command may have run, keep Syncthing protection: a failed
    // batch can leave only part of the collection on the tablet.
    if (err instanceof PreDeleteVerificationError) {
      try {
        await removeDocumentIgnoreLines(ssh, manifest.uuid, protection.addedLines);
      } catch (rollbackErr) {
        const original = err instanceof Error ? err.message : String(err);
        const rollback = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(`${original} Ignore-rule rollback also failed: ${rollback}`);
      }
    }
    throw err;
  }
}

/**
 * Enumerate an exact UUID / UUID.* collection without a depth or size filter.
 * The command reports entry type so links and special files cannot be mistaken
 * for backed-up regular files. Newlines/tabs in a name make parsing fail closed.
 */
export async function readTabletDocumentManifest(
  ssh: SSHExecutor,
  uuid: string,
): Promise<TabletDocumentManifest> {
  if (!isValidUuid(uuid)) throw new Error('Refusing to inspect an invalid document UUID.');

  const result = await ssh.execute(
    `cd ${XOCHITL_DIR} || exit 1; set -e; ` +
    `for root in './${uuid}' './${uuid}'.*; do ` +
    `[ -e "$root" ] || [ -L "$root" ] || continue; ` +
    `find "$root" -exec sh -c '` +
    `entry="$1"; ` +
    `if [ -L "$entry" ]; then kind=l; size=0; mtime=0; digest=-; ` +
    `elif [ -f "$entry" ]; then kind=f; ` +
    `if size=$(stat -c %s "$entry") && mtime=$(stat -c %Y "$entry") ` +
    `&& digest=$(sha256sum "$entry"); then digest=${'$'}{digest%% *}; ` +
    `else kind=e; size=0; mtime=0; digest=-; fi; ` +
    `elif [ -d "$entry" ]; then size=0; digest=-; ` +
    `if mtime=$(stat -c %Y "$entry"); then kind=d; else kind=e; mtime=0; fi; ` +
    `else kind=o; size=0; mtime=0; digest=-; fi; ` +
    `printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$kind" "$size" "$mtime" "$digest" "$entry"` +
    `' sh {} \\;; done`,
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`Could not inventory tablet document${detail ? `: ${detail}` : '.'}`);
  }

  const entries: TabletDocumentManifestEntry[] = [];
  const seen = new Set<string>();
  for (const line of result.stdout.split('\n').filter((value) => value.length > 0)) {
    const fields = line.split('\t');
    if (fields.length !== 5) throw new Error('Tablet returned an unsafe document path.');

    const [kind, sizeText, mtimeText, digest, rawPath] = fields;
    if (kind === 'l' || kind === 'o') {
      throw new Error(`Unsupported tablet entry type in ${uuid}.`);
    }
    if (kind !== 'f' && kind !== 'd') throw new Error('Tablet returned an invalid entry type.');

    const relativePath = normalizeDocumentRelativePath(uuid, rawPath);
    if (seen.has(relativePath)) throw new Error('Tablet returned a duplicate document entry.');
    seen.add(relativePath);

    const size = Number(sizeText);
    const mtime = Number(mtimeText);
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(mtime) || mtime < 0) {
      throw new Error('Tablet returned invalid document metadata.');
    }
    if (kind === 'f' && !/^[0-9a-f]{64}$/i.test(digest)) {
      throw new Error('Tablet returned an invalid document checksum.');
    }
    if (kind === 'd' && digest !== '-') {
      throw new Error('Tablet returned an invalid directory checksum.');
    }
    entries.push({
      relativePath,
      type: kind === 'f' ? 'file' : 'directory',
      size,
      mtime,
      sha256: kind === 'f' ? digest.toLowerCase() : null,
    });
  }

  return { uuid: uuid.toLowerCase(), entries };
}

/** Hash without loading a potentially large PDF/EPUB into memory. */
function hashLocalFileSha256(filePath: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    let bytesRead: number;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

/** Confirm every entry locally by type, size, and SHA-256. */
export function localBackupMatchesManifest(
  localSyncDir: string,
  manifest: TabletDocumentManifest,
): boolean {
  if (manifest.entries.length === 0) return false;

  for (const entry of manifest.entries) {
    let safeRelativePath: string;
    try {
      safeRelativePath = normalizeDocumentRelativePath(manifest.uuid, entry.relativePath);
    } catch {
      return false;
    }
    if (safeRelativePath !== entry.relativePath) return false;
    const parts = safeRelativePath.split('/');
    let localPath = localSyncDir;
    try {
      for (let index = 0; index < parts.length; index++) {
        localPath = path.join(localPath, parts[index]);
        const stat = fs.lstatSync(localPath);
        if (stat.isSymbolicLink()) return false;
        if (index < parts.length - 1 && !stat.isDirectory()) return false;
        if (index === parts.length - 1) {
          if (entry.type === 'file') {
            if (!stat.isFile() || stat.size !== entry.size) return false;
            if (entry.sha256 === null || hashLocalFileSha256(localPath) !== entry.sha256) return false;
          }
          if (entry.type === 'directory' && !stat.isDirectory()) return false;
        }
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** Empty remote state is safe only when the complete local document remains. */
function verifiedLocalBackupCoversManifest(
  localSyncDir: string,
  manifest: TabletDocumentManifest,
): boolean {
  return manifest.entries.length === 0
    ? hasLocalBackup(localSyncDir, manifest.uuid)
    : localBackupMatchesManifest(localSyncDir, manifest);
}

/** Compare two snapshots immediately before deletion to close common races. */
function manifestsMatch(a: TabletDocumentManifest, b: TabletDocumentManifest): boolean {
  if (a.uuid !== b.uuid || a.entries.length !== b.entries.length) return false;
  const byPath = new Map(a.entries.map((entry) => [entry.relativePath, entry]));
  return b.entries.every((entry) => {
    const previous = byPath.get(entry.relativePath);
    return previous?.type === entry.type
      && previous.size === entry.size
      && previous.mtime === entry.mtime
      && previous.sha256 === entry.sha256;
  });
}

async function runExactDeleteCommands(ssh: SSHExecutor, commands: string[]): Promise<void> {
  const MAX_COMMAND_LENGTH = 6000;
  let batch: string[] = [];
  let length = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const result = await ssh.execute(`cd ${XOCHITL_DIR} && ${batch.join(' && ')}`);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim();
      throw new Error(`Tablet rejected archive deletion${detail ? `: ${detail}` : '.'}`);
    }
    batch = [];
    length = 0;
  };

  for (const command of commands) {
    if (batch.length > 0 && length + command.length + 4 > MAX_COMMAND_LENGTH) await flush();
    batch.push(command);
    length += command.length + 4;
  }
  await flush();
}

/** Delete only the entries present in a verified, unchanged manifest. */
export async function deleteVerifiedTabletDocument(
  ssh: SSHExecutor,
  manifest: TabletDocumentManifest,
): Promise<void> {
  let current: TabletDocumentManifest;
  try {
    current = await readTabletDocumentManifest(ssh, manifest.uuid);
  } catch (err) {
    throw new PreDeleteVerificationError(err instanceof Error ? err.message : String(err));
  }
  if (!manifestsMatch(manifest, current)) {
    throw new PreDeleteVerificationError(
      'Tablet document changed during archive; sync it again before retrying.',
    );
  }

  const commitRank = (relativePath: string): number => {
    if (relativePath === `${manifest.uuid}.metadata`) return 2;
    if (relativePath === `${manifest.uuid}.content`) return 1;
    return 0;
  };
  const files = manifest.entries
    .filter((entry) => entry.type === 'file')
    .sort((a, b) => {
      return commitRank(a.relativePath) - commitRank(b.relativePath)
        || collectionPathDepth(b.relativePath) - collectionPathDepth(a.relativePath);
    });
  const directories = manifest.entries
    .filter((entry) => entry.type === 'directory')
    .sort((a, b) => collectionPathDepth(b.relativePath) - collectionPathDepth(a.relativePath));

  await runExactDeleteCommands(ssh, [
    ...files.map((entry) => {
      const remotePath = shellQuote(`./${entry.relativePath}`);
      return `[ -f ${remotePath} ] && [ ! -L ${remotePath} ] ` +
        `&& [ "$(stat -c %s ${remotePath})" = '${entry.size}' ] ` +
        `&& [ "$(sha256sum ${remotePath} | awk '{print $1}')" = '${entry.sha256}' ] ` +
        `&& rm -f ${remotePath}`;
    }),
    ...directories.map((entry) => `rmdir ${shellQuote(`./${entry.relativePath}`)}`),
  ]);

  const remaining = await readTabletDocumentManifest(ssh, manifest.uuid);
  if (remaining.entries.length > 0) {
    throw new Error('Tablet document deletion could not be verified.');
  }
}

/**
 * Authoritative pre-delete check used by archive flows. Every tablet entry,
 * including zero-byte/deep/unknown entries, must have a matching local copy.
 */
export async function tabletFilesBackedUpLocally(
  ssh: SSHExecutor,
  localSyncDir: string,
  uuid: string,
): Promise<boolean> {
  try {
    const manifest = await readTabletDocumentManifest(ssh, uuid);
    return verifiedLocalBackupCoversManifest(localSyncDir, manifest);
  } catch {
    return false;
  }
}

/** Verify a complete local backup and remove only that verified collection. */
export async function archiveVerifiedTabletDocument(
  ssh: SSHExecutor,
  localSyncDir: string,
  uuid: string,
): Promise<void> {
  if (!hasLocalBackup(localSyncDir, uuid)) {
    throw new Error('The local backup is incomplete; the tablet copy was not deleted.');
  }
  const manifest = await readTabletDocumentManifest(ssh, uuid);
  if (!verifiedLocalBackupCoversManifest(localSyncDir, manifest)) {
    throw new Error('The tablet has document files that are not completely backed up locally.');
  }
  await deleteProtectedVerifiedTabletDocument(ssh, manifest);
}

/**
 * Archive old documents: remove from tablet, add to .stignore, keep in vault.
 *
 * Flow:
 *  1. Check /home disk usage on the tablet.
 *  2. Find documents not opened in the last N days.
 *  3. Add each UUID to .stignore so Syncthing won't re-sync it.
 *  4. Delete the files from the tablet to free space.
 *  5. Restart xochitl so removed docs disappear from the UI.
 *
 * The files remain in the vault's sync folder untouched.
 *
 * @returns The number of documents archived.
 */
export async function archiveOldDocuments(
  ssh: SSHExecutor,
  options: ArchiveOptions,
  onNeedsXochitlRestart?: () => void,
): Promise<number> {
  const {
    thresholdPercent,
    minAgeDays,
    force,
    localSyncDir,
  } = options;
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;

  if (!localSyncDir) {
    logger.warn('Archive aborted: no local sync directory provided; refusing to delete unverified documents');
    return 0;
  }

  let archivedCount = 0;
  const archiveFailures: string[] = [];
  try {
    // Step 1: Check /home disk usage
    const dfResult = await ssh.execute('df /home');
    const usagePercent = dfResult.exitCode === 0
      ? parseDfUsagePercent(dfResult.stdout)
      : null;

    if (usagePercent === null) {
      logger.warn('Could not parse /home disk usage');
      return 0;
    }

    logger.info(`reMarkable /home usage: ${usagePercent}%`);

    if (!force && usagePercent < thresholdPercent) {
      logger.info(`Disk usage ${usagePercent}% is below threshold ${thresholdPercent}%, skipping archive`);
      return 0;
    }

    // Step 2: List all metadata files and parse lastOpened timestamps
    const lsResult = await ssh.execute(
      `find ${XOCHITL_DIR} -maxdepth 1 -name '*.metadata' -type f`,
    );

    if (lsResult.exitCode !== 0 || !lsResult.stdout.trim()) {
      logger.info('No metadata files found on tablet');
      return 0;
    }

    const metadataFiles = lsResult.stdout.trim().split(/\r?\n/).filter(Boolean);
    const now = Date.now();
    const cutoffTimestamp = now - minAgeMs;

    interface DocEntry { uuid: string; lastOpened: number }
    const eligible: DocEntry[] = [];

    for (const metaPath of metadataFiles) {
      const prefix = `${XOCHITL_DIR}/`;
      const suffix = '.metadata';
      if (!metaPath.startsWith(prefix) || !metaPath.endsWith(suffix)) {
        logger.warn(`Skipping unexpected metadata path: ${metaPath}`);
        continue;
      }

      const uuid = metaPath.slice(prefix.length, -suffix.length);
      const canonicalPath = `${prefix}${uuid}${suffix}`;
      if (!isValidUuid(uuid) || metaPath !== canonicalPath) {
        logger.warn(`Skipping unexpected metadata path: ${metaPath}`);
        continue;
      }

      let catResult;
      try {
        catResult = await ssh.execute(`cat ${shellQuote(canonicalPath)}`);
      } catch (err) {
        logger.warn(
          `Could not read archive metadata for ${uuid}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (catResult.exitCode !== 0) continue;

      try {
        const meta = parseJson(catResult.stdout);
        if (!isRecord(meta)) continue;
        const lastOpened = parseInt(typeof meta.lastOpened === 'string' ? meta.lastOpened : '0', 10);
        const lastModified = parseInt(typeof meta.lastModified === 'string' ? meta.lastModified : '0', 10);
        const lastActivity = Math.max(lastOpened, lastModified);

        if (lastActivity > cutoffTimestamp) continue;

        if (lastOpened === 0) {
          const created = parseInt(typeof meta.createdTime === 'string' ? meta.createdTime : '0', 10);
          if (created > cutoffTimestamp) continue;
        }

        eligible.push({ uuid, lastOpened: lastActivity });
      } catch {
        continue;
      }
    }

    if (eligible.length === 0) {
      logger.info('No documents eligible for archiving');
      return 0;
    }

    // Sort oldest-activity first
    eligible.sort((a, b) => a.lastOpened - b.lastOpened);

    // Step 3: Archive each eligible document
    for (const doc of eligible) {
      try {
        // Validate UUID before constructing any shell commands to prevent injection
        if (!isValidUuid(doc.uuid)) {
          logger.warn(`Skipping document with invalid UUID: ${doc.uuid}`);
          continue;
        }

        // SAFETY GATE: never delete from the tablet unless we can prove the
        // document is already backed up locally. Applies even when force=true.
        if (!hasLocalBackup(localSyncDir, doc.uuid)) {
          logger.warn(
            `Skipping archive of ${doc.uuid}: no confirmed local backup in ${localSyncDir}. ` +
            `Sync this document to the vault before archiving.`,
          );
          continue;
        }

        // Authoritative manifest: every tablet entry, including unknown sidecars,
        // empty files, empty directories, and deeply nested data, must exist in
        // the local backup with the same type, size, and SHA-256. An already
        // absent collection is idempotent only because hasLocalBackup passed.
        const manifest = await readTabletDocumentManifest(ssh, doc.uuid);
        if (!verifiedLocalBackupCoversManifest(localSyncDir, manifest)) {
          logger.warn(
            `Skipping archive of ${doc.uuid}: the tablet has files not yet backed up ` +
            `locally (e.g. annotations). Sync it fully before archiving.`,
          );
          continue;
        }

        // Protect against Syncthing re-delivery, re-check the snapshot, and delete
        // only its exact entries. New children remain preserved.
        await deleteProtectedVerifiedTabletDocument(ssh, manifest);
        archivedCount++;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        archiveFailures.push(`${doc.uuid}: ${detail}`);
        logger.error(
          `Could not archive ${doc.uuid}: ${detail}`,
        );
        continue;
      }

      // Re-check disk usage; stop if below threshold
      if (!force) {
        try {
          const recheckResult = await ssh.execute('df /home');
          const currentUsage = recheckResult.exitCode === 0
            ? parseDfUsagePercent(recheckResult.stdout)
            : null;
          if (currentUsage !== null && currentUsage < thresholdPercent) {
            logger.info(`Disk usage now ${currentUsage}%, below threshold -- stopping`);
            break;
          }
        } catch (err) {
          logger.warn(
            `Could not re-check disk usage after archiving ${doc.uuid}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (archivedCount === 0 && archiveFailures.length > 0) {
      throw new Error(`Could not archive any eligible documents: ${archiveFailures.join('; ')}`);
    }

    if (archiveFailures.length > 0) {
      logger.warn(
        `Archived ${archivedCount} document(s), but ${archiveFailures.length} archive attempt(s) failed`,
      );
    }

    return archivedCount;
  } finally {
    // A later failure must not suppress the refresh required by an earlier
    // successful deletion. Preserve the original error while signalling once.
    if (archivedCount > 0) {
      logger.info(`Archived ${archivedCount} document(s), requesting xochitl restart`);
      try {
        onNeedsXochitlRestart?.();
      } catch (err) {
        logger.warn(`Could not request xochitl restart: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
