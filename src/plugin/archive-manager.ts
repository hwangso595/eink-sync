/**
 * Archive manager for old/read documents on the reMarkable tablet.
 *
 * "Archive" means: remove from tablet to free space, keep in vault.
 * Uses Syncthing's .stignore to prevent re-syncing archived files.
 *
 * Privacy: All operations happen over SSH to the user's own tablet.
 */

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
  /** If true, ignore the disk usage threshold and archive all eligible docs. */
  force: boolean;
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
  const { thresholdPercent, minAgeDays, force } = options;
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;

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

    // Add to .stignore so Syncthing won't try to re-sync from vault
    await ssh.execute(
      `echo '${doc.uuid}*' >> ${XOCHITL_DIR}/.stignore && echo '${doc.uuid}/' >> ${XOCHITL_DIR}/.stignore`
    );

    // Delete from tablet
    await ssh.execute(
      `cd ${XOCHITL_DIR} && rm -rf ${doc.uuid}* 2>/dev/null; rm -rf ${doc.uuid} 2>/dev/null; true`
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
