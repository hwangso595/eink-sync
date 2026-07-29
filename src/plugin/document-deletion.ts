/**
 * Tablet-side document deletion helpers.
 *
 * A reMarkable document is a collection of entries sharing one UUID: the
 * source file, metadata/content sidecars, annotation directories, thumbnails,
 * OCR output, and firmware-specific auxiliary files. Permanent deletion must
 * remove the whole collection, including sidecars introduced by newer
 * firmware versions.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SSHExecutor } from '../ssh/ssh-client';
import { isValidUuid } from './uuid-validation';

/** Remote xochitl data directory on the tablet. */
const XOCHITL_DIR = '/home/root/.local/share/remarkable/xochitl';

/**
 * Move a document's complete local UUID collection into Archive. An older
 * archived copy of the same UUID is replaced entry-by-entry by the freshly
 * synced copy, which also repairs archives created before SFTP tablet deletion
 * was supported.
 *
 * @returns The number of filesystem entries moved.
 */
export function archiveLocalDocumentCopies(
  uuid: string,
  syncDirectory: string,
  archiveDirectory: string,
): number {
  if (!isValidUuid(uuid)) {
    throw new Error('Refusing to archive local document copies with an invalid UUID.');
  }
  if (!syncDirectory || !archiveDirectory) {
    throw new Error('Sync and Archive folders are required.');
  }
  if (path.resolve(syncDirectory) === path.resolve(archiveDirectory)) {
    throw new Error('Sync and Archive folders must be different.');
  }
  if (!fs.existsSync(syncDirectory) || !fs.statSync(syncDirectory).isDirectory()) return 0;

  const entries = fs.readdirSync(syncDirectory).filter(
    (entry) => entry === uuid || entry.startsWith(`${uuid}.`),
  );
  if (entries.length === 0) return 0;

  fs.mkdirSync(archiveDirectory, { recursive: true });
  for (const entry of entries) {
    const source = path.join(syncDirectory, entry);
    const destination = path.join(archiveDirectory, entry);
    // A previous SFTP archive may have been re-downloaded because its tablet
    // copy was not removed. Replace that stale archived entry with this latest
    // fully synced copy.
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(source, destination);
  }
  return entries.length;
}

/**
 * Remove a document's local entries from every supplied folder, including the
 * Archive folder. Only the exact UUID entry and `UUID.*` sidecars are eligible;
 * unrelated files and other documents are preserved.
 *
 * @returns The number of filesystem entries removed.
 */
export function deleteLocalDocumentCopies(
  uuid: string,
  directories: string[],
): number {
  if (!isValidUuid(uuid)) {
    throw new Error('Refusing to delete local document copies with an invalid UUID.');
  }

  let removed = 0;
  for (const directory of new Set(directories.filter(Boolean))) {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) continue;

    const entries = fs.readdirSync(directory).filter(
      (entry) => entry === uuid || entry.startsWith(`${uuid}.`),
    );
    for (const entry of entries) {
      fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readNoteDocumentUuid(notePath: string): string | null {
  try {
    const fd = fs.openSync(notePath, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const header = buffer.toString('utf-8', 0, bytes);
      const match = header.match(/^remarkable_uuid:\s*([0-9a-fA-F-]{36})\s*$/m);
      return match?.[1].toLowerCase() ?? null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Remove the highlight note, rendered pages, and render cache generated for a
 * permanently deleted document. Archive does not use this cleanup because its
 * purpose is to retain these vault artifacts after removing the tablet copy.
 *
 * Notes are matched by UUID frontmatter rather than by visible filename. The
 * supplied base name is also checked so orphaned drawing files can be cleaned
 * up when their note has already been removed.
 *
 * @returns The number of generated files removed.
 */
export function deleteGeneratedDocumentArtifacts(
  uuid: string,
  noteBaseName: string,
  noteDirectories: string[],
  drawingsDirectory: string,
): number {
  if (!isValidUuid(uuid)) {
    throw new Error('Refusing to delete generated artifacts with an invalid UUID.');
  }

  const normalizedUuid = uuid.toLowerCase();
  const baseNames = new Set<string>();
  const safeNoteBaseName = noteBaseName
    && path.basename(noteBaseName) === noteBaseName
    && noteBaseName !== '.'
    && noteBaseName !== '..'
    ? noteBaseName
    : null;
  let suppliedNameBelongsToAnotherDocument = false;
  let removed = 0;

  for (const directory of new Set(noteDirectories.filter(Boolean))) {
    let entries: string[];
    try {
      if (!fs.statSync(directory).isDirectory()) continue;
      entries = fs.readdirSync(directory);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;

      const baseName = entry.slice(0, -3);
      const notePath = path.join(directory, entry);
      const noteUuid = readNoteDocumentUuid(notePath);
      if (safeNoteBaseName === baseName && noteUuid && noteUuid !== normalizedUuid) {
        suppliedNameBelongsToAnotherDocument = true;
      }
      if (noteUuid !== normalizedUuid) continue;

      baseNames.add(baseName);
      try {
        fs.rmSync(notePath, { force: true });
        removed++;
      } catch {
        // A locked output must not prevent the document itself being deleted.
      }
    }
  }

  if (safeNoteBaseName && !suppliedNameBelongsToAnotherDocument) {
    baseNames.add(safeNoteBaseName);
  }

  let drawingEntries: string[];
  try {
    if (!drawingsDirectory || !fs.statSync(drawingsDirectory).isDirectory()) {
      return removed;
    }
    drawingEntries = fs.readdirSync(drawingsDirectory);
  } catch {
    return removed;
  }

  const drawingPatterns = [...baseNames].map(
    (baseName) => new RegExp(
      `^${escapeRegExp(baseName)}_p\\d+(?:_[0-9a-fA-F]{4})?\\.png(?:\\.bak)?$`,
    ),
  );
  const cacheName = `.render-cache-${uuid}.json`;

  for (const entry of drawingEntries) {
    if (entry !== cacheName && !drawingPatterns.some((pattern) => pattern.test(entry))) {
      continue;
    }
    try {
      fs.rmSync(path.join(drawingsDirectory, entry), { force: true });
      removed++;
    } catch {
      // Continue removing the remaining generated artifacts when one is locked.
    }
  }

  return removed;
}

/**
 * Permanently remove a document and all of its UUID-prefixed sidecars from the
 * tablet, then verify that no matching entry remains.
 *
 * The UUID is strictly validated before it is interpolated into either shell
 * command. The `UUID.*` pattern intentionally matches only sidecars belonging
 * to that exact UUID, not other documents.
 */
export async function deleteDocumentFromTablet(
  ssh: SSHExecutor,
  uuid: string,
): Promise<void> {
  if (!isValidUuid(uuid)) {
    throw new Error('Refusing to delete a tablet document with an invalid UUID.');
  }

  const remove = await ssh.execute(
    `cd ${XOCHITL_DIR} && rm -rf ${uuid} ${uuid}.*`,
  );
  if (remove.exitCode !== 0) {
    const detail = remove.stderr.trim();
    throw new Error(`Tablet rejected document deletion${detail ? `: ${detail}` : '.'}`);
  }

  // An unmatched glob is passed through literally by the tablet shell, where
  // `test ! -e` correctly treats it as absent. If entries remain, the loop
  // exits non-zero and the caller keeps the local copy intact.
  const verify = await ssh.execute(
    `cd ${XOCHITL_DIR} && for entry in ${uuid} ${uuid}.*; do ` +
    `[ ! -e "$entry" ] || exit 1; done`,
  );
  if (verify.exitCode !== 0) {
    throw new Error('Tablet document deletion could not be verified.');
  }
}
