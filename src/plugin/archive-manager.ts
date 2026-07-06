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
import type { SSHExecutor } from '../ssh/ssh-client';
import { logger } from '../utils/logger';
import { isValidUuid } from './uuid-validation';

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
   * local-backup verification below — archiving deletes from the tablet, so we
   * never delete a document we can't prove is already in the vault.
   */
  force: boolean;
  /**
   * Absolute path to the local synced copy of the xochitl directory. Required:
   * before deleting any document from the tablet, we confirm its files exist
   * (and are non-empty) here. Without a confirmed backup, "archive" would be
   * "delete forever".
   */
  localSyncDir: string;
}

/**
 * Confirm a document is safely backed up in the local sync folder before we
 * delete it from the tablet. Requires the metadata + content sidecars and the
 * actual document body (the source PDF/EPUB, or — for notebooks — the page
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
  // A directory counts only if it holds at least one non-empty file, so an
  // empty .rm from a torn sync can't pass the gate.
  const dirHasContent = (p: string): boolean => {
    try {
      if (!fs.statSync(p).isDirectory()) return false;
      return fs.readdirSync(p).some((name) => nonEmptyFile(path.join(p, name)));
    } catch {
      return false;
    }
  };

  const base = path.join(localSyncDir, uuid);

  // Sidecars must be present and non-empty.
  if (!nonEmptyFile(`${base}.metadata`)) return false;
  if (!nonEmptyFile(`${base}.content`)) return false;

  // Document body: a synced source file, or a non-empty annotation dir
  // (notebooks have no source file — their content lives entirely in {uuid}/).
  const hasBody =
    nonEmptyFile(`${base}.pdf`) ||
    nonEmptyFile(`${base}.epub`) ||
    dirHasContent(base);

  return hasBody;
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
  const { thresholdPercent, minAgeDays, force, localSyncDir } = options;
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;

  if (!localSyncDir) {
    logger.warn('Archive aborted: no local sync directory provided — refusing to delete unverified documents');
    return 0;
  }

  // Step 1: Check /home disk usage
  const dfResult = await ssh.execute("df /home | tail -1 | awk '{print $5}' | tr -d '%'");
  const usagePercent = parseInt(dfResult.stdout.trim(), 10);

  if (isNaN(usagePercent)) {
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
    `find ${XOCHITL_DIR} -maxdepth 1 -name '*.metadata' -type f`
  );

  if (lsResult.exitCode !== 0 || !lsResult.stdout.trim()) {
    logger.info('No metadata files found on tablet');
    return 0;
  }

  const metadataFiles = lsResult.stdout.trim().split('\n').filter(Boolean);
  const now = Date.now();
  const cutoffTimestamp = now - minAgeMs;

  interface DocEntry { uuid: string; lastOpened: number }
  const eligible: DocEntry[] = [];

  for (const metaPath of metadataFiles) {
    const uuid = metaPath.replace(`${XOCHITL_DIR}/`, '').replace('.metadata', '');
    const catResult = await ssh.execute(`cat "${metaPath}"`);
    if (catResult.exitCode !== 0) continue;

    try {
      const meta = JSON.parse(catResult.stdout);
      const lastOpened = parseInt(meta.lastOpened ?? '0', 10);
      const lastModified = parseInt(meta.lastModified ?? '0', 10);
      const lastActivity = Math.max(lastOpened, lastModified);

      if (lastActivity > cutoffTimestamp) continue;

      if (lastOpened === 0) {
        const created = parseInt(meta.createdTime ?? '0', 10);
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
  let archivedCount = 0;
  for (const doc of eligible) {
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

    // Add to .stignore so Syncthing won't try to re-sync from vault
    await ssh.execute(
      `echo '${doc.uuid}*' >> ${XOCHITL_DIR}/.stignore && echo '${doc.uuid}/' >> ${XOCHITL_DIR}/.stignore`
    );

    // Delete from tablet — explicit, auditable file list (no glob).
    // Covers every sidecar/dir xochitl creates for a document.
    const u = doc.uuid;
    const targets = [
      `${u}.metadata`, `${u}.content`, `${u}.pdf`, `${u}.epub`,
      `${u}.pagedata`, `${u}.local`,
      u, `${u}.cache`, `${u}.thumbnails`, `${u}.textconversion`, `${u}.highlights`,
    ].join(' ');
    await ssh.execute(
      `cd ${XOCHITL_DIR} && rm -rf ${targets} 2>/dev/null; true`
    );

    archivedCount++;

    // Re-check disk usage; stop if below threshold
    if (!force) {
      const recheckResult = await ssh.execute("df /home | tail -1 | awk '{print $5}' | tr -d '%'");
      const currentUsage = parseInt(recheckResult.stdout.trim(), 10);
      if (!isNaN(currentUsage) && currentUsage < thresholdPercent) {
        logger.info(`Disk usage now ${currentUsage}%, below threshold -- stopping`);
        break;
      }
    }
  }

  // Step 4: Signal that xochitl needs a restart if we archived anything
  if (archivedCount > 0) {
    logger.info(`Archived ${archivedCount} document(s), requesting xochitl restart`);
    onNeedsXochitlRestart?.();
  }

  return archivedCount;
}
