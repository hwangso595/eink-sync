/**
 * Vault Isolation and Collision Detection.
 *
 * Prevents data corruption when multiple Obsidian vaults (or nested vaults)
 * have the E-Ink Sync plugin enabled with overlapping folder paths.
 *
 * ## How It Works
 *
 * On plugin load, a lightweight "claim file" (`.eink-sync-instance`)
 * is written into each managed folder (sync source folders, highlights folder,
 * archive folder). The file contains the vault path and a timestamp.
 *
 * If another vault instance has already placed a claim file in the same folder,
 * a collision is detected and a warning is surfaced to the user. Warnings are
 * non-blocking -- they inform but never prevent the user from proceeding.
 *
 * Claim files older than 7 days without a refresh are considered stale and
 * ignored, preventing false positives from crashed or uninstalled instances.
 *
 * ## Syncthing Note
 *
 * Claim files placed inside sync folders WILL be synced by Syncthing to the
 * tablet. This is intentional -- they are tiny JSON files (~200 bytes) and
 * harmless on the tablet filesystem.
 *
 * Privacy: Pure local filesystem operations. No network calls.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

// -------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------

/** Name of the claim file written into managed folders. */
export const CLAIM_FILENAME = '.eink-sync-instance';

/**
 * Legacy claim filename from the pre-rename `remarkable-bridge` plugin.
 * Older vaults may still have these files in managed folders. We accept
 * them as valid claims on read but only write the new name.
 */
export const LEGACY_CLAIM_FILENAME = '.remarkable-bridge-instance';

/** Claims older than this are treated as stale and ignored (7 days in ms). */
export const STALE_CLAIM_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Subdirectory within the plugin data dir for claim files. */
export const CLAIMS_SUBDIR = 'claims';

/**
 * Compute a short hash of a folder path for use as a claim filename.
 * Uses SHA-256 truncated to 16 hex chars for uniqueness without excessive length.
 */
export function hashFolderPath(folderAbsPath: string): string {
  const normalised = normalisePath(folderAbsPath);
  return crypto.createHash('sha256').update(normalised).digest('hex').substring(0, 16);
}

/**
 * Get the directory where claim files are stored.
 * This is `<pluginDataDir>/claims/` — inside the plugin's own data directory,
 * NOT inside the managed (synced) folders. This avoids Syncthing conflicts.
 */
export function getClaimsDir(pluginDataDir: string): string {
  return path.join(pluginDataDir, CLAIMS_SUBDIR);
}

/**
 * Get the full path to a claim file for a given managed folder.
 * The filename encodes the folder path via a hash.
 */
export function getClaimFilePath(pluginDataDir: string, folderAbsPath: string): string {
  const hash = hashFolderPath(folderAbsPath);
  return path.join(getClaimsDir(pluginDataDir), `claim-${hash}.json`);
}

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

/**
 * Contents of a `.eink-sync-instance` claim file.
 *
 * Written as JSON into each managed folder so that other vault instances
 * can detect overlapping folder usage.
 */
export interface ClaimFileContents {
  /** Absolute path of the vault that owns this folder. */
  vaultPath: string;
  /** Plugin identifier ("eink-sync"; older claim files may say "remarkable-bridge"). */
  pluginId: string;
  /** Epoch-ms timestamp of when this claim was last written/refreshed. */
  timestamp: number;
  /** Absolute path of the managed folder being claimed. */
  folderPath?: string;
  /**
   * Human-readable note explaining the file's purpose.
   * Included so users who discover the file understand what it is.
   */
  _note: string;
}

/**
 * A detected collision between two vault instances using the same folder.
 */
export interface Collision {
  /** The managed folder path (absolute) where the collision was found. */
  folderPath: string;
  /** The vault path from the OTHER instance's claim file. */
  otherVaultPath: string;
  /** The vault path of THIS instance (the one detecting the collision). */
  thisVaultPath: string;
  /** Whether the other claim is stale (> 7 days old). */
  isStale: boolean;
  /** Timestamp from the other instance's claim file. */
  otherTimestamp: number;
}

/**
 * A warning about a folder path that resolves outside the vault root.
 */
export interface OutsideVaultWarning {
  /** The configured folder path (vault-relative). */
  configuredPath: string;
  /** The resolved absolute path. */
  resolvedPath: string;
  /** The vault base path. */
  vaultBasePath: string;
}

/**
 * Full result of running all vault isolation checks.
 */
export interface VaultIsolationResult {
  /** Collisions with other vault instances (excludes stale claims). */
  collisions: Collision[];
  /** Folders that resolve outside the vault root. */
  outsideVaultWarnings: OutsideVaultWarning[];
  /** All stale claims found (informational, not warnings). */
  staleClaimsFound: number;
  /** Errors encountered during checks (non-fatal). */
  errors: string[];
}

// -------------------------------------------------------------------
// Claim file operations
// -------------------------------------------------------------------

/**
 * Build the claim file contents for this vault instance.
 */
export function buildClaimContents(vaultPath: string, folderAbsPath?: string): ClaimFileContents {
  const contents: ClaimFileContents = {
    vaultPath,
    pluginId: 'eink-sync',
    timestamp: Date.now(),
    _note:
      'This file is created by the E-Ink Sync Obsidian plugin to detect ' +
      'when multiple vaults share the same folder. It is safe to delete -- the ' +
      'plugin will recreate it on next load.',
  };
  if (folderAbsPath) {
    contents.folderPath = folderAbsPath;
  }
  return contents;
}

/**
 * Write a claim file for a managed folder into the plugin data directory.
 *
 * Claims are stored as `<pluginDataDir>/claims/claim-<hash>.json` where
 * the hash encodes the managed folder path. This keeps claim files OUT
 * of the synced folders, avoiding Syncthing conflicts.
 *
 * @param folderAbsPath - Absolute path to the managed folder being claimed.
 * @param vaultPath - Absolute path of the vault writing the claim.
 * @param pluginDataDir - Absolute path to the plugin's data directory.
 * @returns true if the write succeeded.
 */
export function writeClaimFile(folderAbsPath: string, vaultPath: string, pluginDataDir?: string): boolean {
  try {
    let claimPath: string;
    if (pluginDataDir) {
      // New behavior: write to plugin data dir
      const claimsDir = getClaimsDir(pluginDataDir);
      if (!fs.existsSync(claimsDir)) {
        fs.mkdirSync(claimsDir, { recursive: true });
      }
      claimPath = getClaimFilePath(pluginDataDir, folderAbsPath);
    } else {
      // Legacy fallback: write into the managed folder (for tests/compat)
      if (!fs.existsSync(folderAbsPath)) {
        fs.mkdirSync(folderAbsPath, { recursive: true });
      }
      claimPath = path.join(folderAbsPath, CLAIM_FILENAME);
    }

    const contents = buildClaimContents(vaultPath, folderAbsPath);
    fs.writeFileSync(claimPath, JSON.stringify(contents, null, 2), 'utf-8');
    logger.debug(`Claim file written: ${claimPath}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to write claim file for ${folderAbsPath}: ${msg}`);
    return false;
  }
}

/**
 * Read and parse a claim file for a managed folder.
 *
 * When `pluginDataDir` is provided, reads from the plugin data directory.
 * Otherwise falls back to reading from the managed folder itself (legacy).
 *
 * Returns null if the file does not exist, is unreadable, or contains
 * invalid JSON. Never throws.
 *
 * @param folderAbsPath - Absolute path to the managed folder to check.
 * @param pluginDataDir - Absolute path to the plugin's data directory (optional).
 * @returns The parsed claim contents, or null.
 */
export function readClaimFile(folderAbsPath: string, pluginDataDir?: string): ClaimFileContents | null {
  try {
    const claimPath = pluginDataDir
      ? getClaimFilePath(pluginDataDir, folderAbsPath)
      : path.join(folderAbsPath, CLAIM_FILENAME);

    if (!fs.existsSync(claimPath)) {
      return null;
    }

    const raw = fs.readFileSync(claimPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Validate required fields
    if (
      typeof parsed.vaultPath !== 'string' ||
      typeof parsed.pluginId !== 'string' ||
      typeof parsed.timestamp !== 'number'
    ) {
      logger.warn(`Invalid claim file for ${folderAbsPath}: missing required fields`);
      return null;
    }

    return parsed as ClaimFileContents;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`Could not read claim file for ${folderAbsPath}: ${msg}`);
    return null;
  }
}

/**
 * Delete a claim file (best-effort).
 *
 * Called on plugin unload. If deletion fails, the error is silently
 * logged -- stale claims are handled by the 7-day expiry logic.
 *
 * @param folderAbsPath - Absolute path to the managed folder.
 * @param pluginDataDir - Absolute path to the plugin's data directory (optional).
 * @returns true if the file was deleted or did not exist.
 */
export function removeClaimFile(folderAbsPath: string, pluginDataDir?: string): boolean {
  try {
    const claimPath = pluginDataDir
      ? getClaimFilePath(pluginDataDir, folderAbsPath)
      : path.join(folderAbsPath, CLAIM_FILENAME);

    if (fs.existsSync(claimPath)) {
      fs.unlinkSync(claimPath);
      logger.debug(`Claim file removed: ${claimPath}`);
    }

    // Also clean up legacy claim files from managed folders
    // if pluginDataDir is provided (migration cleanup)
    if (pluginDataDir) {
      const legacyPath = path.join(folderAbsPath, CLAIM_FILENAME);
      if (fs.existsSync(legacyPath)) {
        fs.unlinkSync(legacyPath);
        logger.debug(`Legacy claim file removed: ${legacyPath}`);
      }
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`Could not remove claim file for ${folderAbsPath}: ${msg}`);
    return false;
  }
}

/**
 * Check whether a claim is stale (older than the threshold).
 */
export function isClaimStale(
  claim: ClaimFileContents,
  now: number = Date.now(),
): boolean {
  return (now - claim.timestamp) > STALE_CLAIM_THRESHOLD_MS;
}

// -------------------------------------------------------------------
// Collision detection
// -------------------------------------------------------------------

/**
 * Normalise a filesystem path for comparison.
 *
 * On Windows, paths are case-insensitive and may use either slash direction.
 * This normalises to lowercase with forward slashes and removes trailing slashes.
 */
export function normalisePath(p: string): string {
  let normalised = path.resolve(p).replace(/\\/g, '/');
  // Remove trailing slash (but keep root "/" or "C:/")
  if (normalised.length > 1 && normalised.endsWith('/')) {
    normalised = normalised.slice(0, -1);
  }
  // Case-insensitive on Windows
  if (process.platform === 'win32') {
    normalised = normalised.toLowerCase();
  }
  return normalised;
}

/**
 * Check a single folder for a collision with another vault instance.
 *
 * Reads the existing claim file (if any) and compares the vault path.
 * If the claim belongs to a different vault and is not stale, a collision
 * is returned.
 *
 * @param folderAbsPath - Absolute path of the managed folder.
 * @param thisVaultPath - Absolute path of this vault.
 * @param now - Current time in epoch-ms (injectable for testing).
 * @returns A Collision object if detected, null otherwise.
 */
export function checkFolderForCollision(
  folderAbsPath: string,
  thisVaultPath: string,
  now: number = Date.now(),
  pluginDataDir?: string,
): Collision | null {
  const existingClaim = readClaimFile(folderAbsPath, pluginDataDir);
  if (!existingClaim) {
    return null;
  }

  // Compare normalised vault paths
  const existingNorm = normalisePath(existingClaim.vaultPath);
  const thisNorm = normalisePath(thisVaultPath);

  if (existingNorm === thisNorm) {
    // Same vault -- no collision (this is our own claim or a previous load)
    return null;
  }

  const stale = isClaimStale(existingClaim, now);

  return {
    folderPath: folderAbsPath,
    otherVaultPath: existingClaim.vaultPath,
    thisVaultPath,
    isStale: stale,
    otherTimestamp: existingClaim.timestamp,
  };
}

/**
 * Check if a resolved folder path is outside the vault root.
 *
 * @param resolvedPath - The absolute path of the folder.
 * @param vaultBasePath - The absolute path of the vault root.
 * @param configuredPath - The user-configured (vault-relative) path.
 * @returns An OutsideVaultWarning if outside, null otherwise.
 */
export function checkOutsideVault(
  resolvedPath: string,
  vaultBasePath: string,
  configuredPath: string,
): OutsideVaultWarning | null {
  const normResolved = normalisePath(resolvedPath);
  const normVault = normalisePath(vaultBasePath);

  if (!normResolved.startsWith(normVault + '/') && normResolved !== normVault) {
    return {
      configuredPath,
      resolvedPath,
      vaultBasePath,
    };
  }

  return null;
}

// -------------------------------------------------------------------
// Orchestration
// -------------------------------------------------------------------

/**
 * Collect all managed folder paths (absolute) from the plugin configuration.
 *
 * Returns deduplicated paths for: all sync source folders, highlights folder,
 * and archive folder.
 *
 * @param vaultBasePath - Absolute path of the vault root.
 * @param syncFolders - Array of vault-relative sync folder paths.
 * @param highlightsFolder - Vault-relative highlights folder path.
 * @param archiveFolder - Vault-relative archive folder path.
 * @returns Array of unique absolute folder paths.
 */
export function collectManagedFolders(
  vaultBasePath: string,
  syncFolders: string[],
  highlightsFolder: string,
  archiveFolder: string,
): string[] {
  const resolve = (rel: string): string => {
    if (/^(\/|[A-Za-z]:[\\/])/.test(rel)) {
      return rel; // Already absolute
    }
    return path.resolve(vaultBasePath, rel);
  };

  const allPaths = [
    ...syncFolders.map(resolve),
    resolve(highlightsFolder),
    resolve(archiveFolder),
  ].filter(Boolean);

  // Deduplicate using normalised paths
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of allPaths) {
    const norm = normalisePath(p);
    if (!seen.has(norm)) {
      seen.add(norm);
      unique.push(p);
    }
  }

  return unique;
}

/**
 * Write claim files to all managed folders and check for collisions.
 *
 * This is the main entry point called on plugin load. It:
 * 1. Collects all managed folder paths.
 * 2. Reads existing claim files to check for collisions BEFORE overwriting.
 * 3. Writes this vault's claim file into each folder.
 * 4. Checks each folder for outside-vault-root warnings.
 *
 * @param vaultBasePath - Absolute path of the vault root.
 * @param syncFolders - Array of vault-relative sync folder paths.
 * @param highlightsFolder - Vault-relative highlights folder path.
 * @param archiveFolder - Vault-relative archive folder path.
 * @returns A VaultIsolationResult with all findings.
 */
export function writeClaimsAndCheckCollisions(
  vaultBasePath: string,
  syncFolders: string[],
  highlightsFolder: string,
  archiveFolder: string,
  pluginDataDir?: string,
): VaultIsolationResult {
  const result: VaultIsolationResult = {
    collisions: [],
    outsideVaultWarnings: [],
    staleClaimsFound: 0,
    errors: [],
  };

  const managedFolders = collectManagedFolders(
    vaultBasePath, syncFolders, highlightsFolder, archiveFolder,
  );

  // Map of vault-relative paths for outside-vault checks
  const relativePathMap = new Map<string, string>();
  for (const sf of syncFolders) {
    const abs = /^(\/|[A-Za-z]:[\\/])/.test(sf)
      ? sf
      : path.resolve(vaultBasePath, sf);
    relativePathMap.set(normalisePath(abs), sf);
  }
  {
    const hlAbs = /^(\/|[A-Za-z]:[\\/])/.test(highlightsFolder)
      ? highlightsFolder
      : path.resolve(vaultBasePath, highlightsFolder);
    relativePathMap.set(normalisePath(hlAbs), highlightsFolder);
  }
  {
    const arAbs = /^(\/|[A-Za-z]:[\\/])/.test(archiveFolder)
      ? archiveFolder
      : path.resolve(vaultBasePath, archiveFolder);
    relativePathMap.set(normalisePath(arAbs), archiveFolder);
  }

  for (const folderAbs of managedFolders) {
    // 1. Check for collisions BEFORE overwriting the claim
    const collision = checkFolderForCollision(folderAbs, vaultBasePath, Date.now(), pluginDataDir);
    if (collision) {
      if (collision.isStale) {
        result.staleClaimsFound++;
        logger.debug(
          `Stale claim found in ${folderAbs} from vault "${collision.otherVaultPath}" — ignoring`,
        );
      } else {
        result.collisions.push(collision);
        logger.warn(
          `Collision detected in ${folderAbs}: claimed by vault "${collision.otherVaultPath}"`,
        );
      }
    }

    // 2. Write our claim (overwriting any existing stale/own claim)
    const written = writeClaimFile(folderAbs, vaultBasePath, pluginDataDir);
    if (!written) {
      result.errors.push(`Failed to write claim file in ${folderAbs}`);
    }

    // 3. Check for outside-vault-root
    const configuredPath = relativePathMap.get(normalisePath(folderAbs)) ?? folderAbs;
    const outsideWarning = checkOutsideVault(folderAbs, vaultBasePath, configuredPath);
    if (outsideWarning) {
      result.outsideVaultWarnings.push(outsideWarning);
      logger.warn(
        `Folder "${configuredPath}" resolves outside vault root: ${folderAbs}`,
      );
    }
  }

  return result;
}

/**
 * Remove claim files from all managed folders (best-effort).
 *
 * Called on plugin unload. Failures are silently logged.
 */
export function removeAllClaims(
  vaultBasePath: string,
  syncFolders: string[],
  highlightsFolder: string,
  archiveFolder: string,
  pluginDataDir?: string,
): void {
  const managedFolders = collectManagedFolders(
    vaultBasePath, syncFolders, highlightsFolder, archiveFolder,
  );

  for (const folderAbs of managedFolders) {
    removeClaimFile(folderAbs, pluginDataDir);
  }
}

// -------------------------------------------------------------------
// Collision key utilities
// -------------------------------------------------------------------

/**
 * Generate a unique key for a collision, used for tracking dismissals.
 *
 * The key is based on the folder path and the OTHER vault path, so that
 * if the colliding vault changes, the dismissal is reset.
 */
export function collisionKey(collision: Collision): string {
  const normFolder = normalisePath(collision.folderPath);
  const normOther = normalisePath(collision.otherVaultPath);
  return `${normFolder}::${normOther}`;
}
