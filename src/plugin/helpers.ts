/**
 * Shared helper utilities for the reMarkable Bridge plugin.
 *
 * Centralises logic that was previously duplicated across
 * library-view.ts, sync-status-modal.ts, library-data.ts, and plugin.ts.
 *
 * Privacy: Pure utility functions -- no network calls, no side effects
 * (except ensureFolders and migrateFiles which perform local filesystem ops).
 */

import type { App, TFolder, TFile, TAbstractFile } from 'obsidian';
import { logger } from '../utils/logger';

/**
 * Check if a filename is a Syncthing conflict/temp file that should be ignored.
 */
export function isSyncthingConflict(filename: string): boolean {
  return filename.includes('sync-conflict') ||
    filename.includes('.syncthing.') ||
    filename.endsWith('.tmp');
}

/**
 * Get the vault's base filesystem path.
 */
export function getVaultBasePath(app: App): string {
  return (app.vault.adapter as { getBasePath?: () => string })
    .getBasePath?.() ?? '';
}

/**
 * Resolve a vault-relative path to an absolute filesystem path.
 */
function resolveVaultPath(app: App, relativePath: string): string {
  if (/^(\/|[A-Za-z]:[\\/])/.test(relativePath)) {
    return relativePath;
  }
  const base = getVaultBasePath(app);
  return base ? `${base}/${relativePath}` : relativePath;
}

/** Resolve a vault-relative folder path to absolute. */
export function resolvePath(app: App, folderPath: string): string {
  return resolveVaultPath(app, folderPath);
}

/**
 * Ensure folders exist in the vault.
 * Called on plugin load.
 */
export async function ensureFolders(app: App, ...folders: string[]): Promise<void> {
  for (const folder of folders) {
    if (!folder) continue;
    const exists = app.vault.getAbstractFileByPath(folder);
    if (!exists) {
      try {
        await app.vault.createFolder(folder);
      } catch {
        // May already exist on disk
      }
    }
  }
}

/**
 * Compute a simple hash of a string for path-hash validation.
 * Uses a fast DJB2-style hash -- not cryptographic, just a fingerprint
 * to detect when the sync folder path changes outside the settings UI.
 */
export function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  // Convert to unsigned hex for a compact, human-readable representation
  return (hash >>> 0).toString(16);
}

/**
 * Update Syncthing's folder path via REST API.
 * Called when the user changes the root folder in settings.
 */
export async function updateSyncthingFolderPath(
  syncthingUrl: string,
  apiKey: string,
  folderId: string,
  newPath: string,
): Promise<{ success: boolean; error?: string }> {
  if (!apiKey || !folderId) {
    return { success: false, error: 'Syncthing API key or folder ID not configured.' };
  }

  try {
    // GET current folder config
    const getResp = await fetch(`${syncthingUrl}/rest/config/folders/${folderId}`, {
      headers: { 'X-API-Key': apiKey },
    });

    if (!getResp.ok) {
      return { success: false, error: `Syncthing API error: ${getResp.status}` };
    }

    const config = await getResp.json();
    config.path = newPath;

    // PUT updated config
    const putResp = await fetch(`${syncthingUrl}/rest/config/folders/${folderId}`, {
      method: 'PUT',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });

    if (!putResp.ok) {
      return { success: false, error: `Syncthing API error: ${putResp.status}` };
    }

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Could not reach Syncthing: ${msg}` };
  }
}

// -------------------------------------------------------------------
// Relative time formatting
// -------------------------------------------------------------------

/** Millisecond constants for time calculations. */
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Format a timestamp as a human-readable relative time string.
 *
 * Supports two modes:
 *  - 'short' (default): compact for status bars, e.g. "5m ago", "2d ago"
 *  - 'long': includes week thresholds and calendar fallback for older dates,
 *    suitable for document metadata display
 *
 * Handles both epoch-millisecond (13-digit) and epoch-second (10-digit)
 * timestamps by normalising to milliseconds.
 */
export function formatRelativeTime(
  timestamp: number | null,
  mode: 'short' | 'long' = 'short',
): string {
  if (!timestamp) return mode === 'short' ? 'just now' : 'Never';

  // Normalise epoch seconds (10-digit) to epoch milliseconds (13-digit).
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const date = new Date(ms);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / MS_PER_MINUTE);
  const diffHr = Math.floor(diffMs / MS_PER_HOUR);
  const diffDays = Math.floor(diffMs / MS_PER_DAY);

  if (mode === 'short') {
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${diffDays}d ago`;
  }

  // 'long' mode -- richer labels for UI display
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

// -------------------------------------------------------------------
// Filename sanitization
// -------------------------------------------------------------------

/**
 * Sanitise a document's visible name for use as a filename.
 *
 * This is the single source of truth for the sanitization logic.
 * Both the markdown renderer output path and the library view's
 * "open note" lookup MUST use this function so they agree on the
 * expected filename.
 *
 * The regex removes characters that are illegal in Windows, macOS, and
 * Linux filenames: < > : " / \ | ? * and ASCII control characters.
 */
export function sanitizeFilename(visibleName: string): string {
  const sanitized = visibleName
    // Strip file extensions
    .replace(/\.(pdf|epub)$/i, '')
    // Remove invalid filename characters
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized || 'Untitled';
}

// -------------------------------------------------------------------
// Folder migration
// -------------------------------------------------------------------

/** Result of counting files in a vault folder. */
export interface FolderFileCount {
  /** Total number of files (recursive). */
  fileCount: number;
  /** Total number of subfolders (recursive). */
  folderCount: number;
}

/**
 * Count the files and subfolders inside a vault-relative folder path.
 * Returns { fileCount: 0, folderCount: 0 } if the folder does not exist.
 */
export function countFolderContents(app: App, folderPath: string): FolderFileCount {
  const result: FolderFileCount = { fileCount: 0, folderCount: 0 };
  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!folder || !('children' in folder)) return result;

  const walk = (node: TAbstractFile): void => {
    if ('children' in node) {
      const tfolder = node as TFolder;
      // Do not count the root folder itself
      if (tfolder.path !== folderPath) {
        result.folderCount++;
      }
      for (const child of tfolder.children) {
        walk(child);
      }
    } else {
      result.fileCount++;
    }
  };
  walk(folder);
  return result;
}

/** Outcome of a file migration operation. */
export interface MigrationResult {
  success: boolean;
  filesMoved: number;
  foldersMoved: number;
  error?: string;
}

/**
 * Migrate all files and subdirectories from one vault folder to another.
 *
 * Uses the Obsidian vault API (app.vault.rename) where possible so that
 * Obsidian's internal caches, links, and file index stay consistent.
 * Falls back to Node.js fs for paths outside the vault.
 *
 * The migration is best-effort: if a single file move fails, the error
 * is recorded but remaining files continue. Callers should check
 * the returned MigrationResult for partial failures.
 *
 * @param app - Obsidian App instance
 * @param oldFolder - Source folder path (vault-relative)
 * @param newFolder - Destination folder path (vault-relative)
 * @returns A MigrationResult with counts and error info
 */
export async function migrateFiles(
  app: App,
  oldFolder: string,
  newFolder: string,
): Promise<MigrationResult> {
  const result: MigrationResult = { success: true, filesMoved: 0, foldersMoved: 0 };

  const source = app.vault.getAbstractFileByPath(oldFolder);
  if (!source || !('children' in source)) {
    result.success = false;
    result.error = `Source folder "${oldFolder}" does not exist or is not a folder.`;
    return result;
  }

  // Ensure destination exists
  await ensureFolders(app, newFolder);

  const srcFolder = source as TFolder;
  const errors: string[] = [];

  // Collect all direct children first (snapshot), because moving them
  // mutates the children array.
  const children = [...srcFolder.children];

  for (const child of children) {
    const relativePath = child.path.substring(oldFolder.length + 1);
    const newPath = `${newFolder}/${relativePath}`;
    try {
      // For subdirectories, ensure the parent in the destination exists
      if ('children' in child) {
        await ensureFolders(app, newPath);
        // Recursively move contents of this subfolder
        const subResult = await migrateFiles(app, child.path, newPath);
        result.filesMoved += subResult.filesMoved;
        result.foldersMoved += subResult.foldersMoved;
        if (!subResult.success) {
          errors.push(subResult.error ?? `Failed to migrate subfolder ${child.path}`);
        }
        // Remove the now-empty source subfolder
        try {
          await app.vault.delete(child, true);
          result.foldersMoved++;
        } catch {
          // Folder may not be empty if some files failed to move
        }
      } else {
        // Check if destination file already exists
        const existing = app.vault.getAbstractFileByPath(newPath);
        if (existing) {
          logger.warn(`Migration: skipping "${newPath}" — file already exists at destination`);
          errors.push(`Skipped "${relativePath}" — already exists at destination`);
          continue;
        }
        await app.fileManager.renameFile(child, newPath);
        result.filesMoved++;
        logger.debug(`Migrated: ${child.path} -> ${newPath}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to move "${child.path}": ${msg}`);
      logger.error(`Migration error: ${msg}`);
      result.success = false;
    }
  }

  if (errors.length > 0) {
    result.error = errors.join('; ');
    result.success = false;
  }

  return result;
}
