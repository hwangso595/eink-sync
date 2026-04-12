/**
 * Bidirectional sync support for advanced users.
 *
 * By default, the pipeline is one-directional: tablet to host (read-only).
 * This module provides opt-in bidirectional sync with explicit safety
 * warnings and xochitl restart handling.
 *
 * Constraints from the spec:
 * - Must be gated behind an explicit setting with clear warning
 * - xochitl restart required for tablet to see new files
 * - NEVER writes to xochitl directory without user consent
 * - All changes are reversible
 */

import { logger } from '../utils/logger';
import type { SSHExecutor } from '../ssh/ssh-client';

/** Warning text shown to users before enabling bidirectional sync. */
export const BIDIRECTIONAL_SYNC_WARNING =
  'Bidirectional sync allows writing files to your reMarkable tablet. ' +
  'This is an advanced feature with the following implications:\n\n' +
  '1. Files written to the xochitl directory require an xochitl restart ' +
  'for the tablet to recognize them.\n' +
  '2. Incorrect file formats or metadata can cause xochitl to crash or ' +
  'ignore the files.\n' +
  '3. This modifies the tablet\'s document store, which is normally read-only.\n' +
  '4. Ensure you have a backup of your tablet data before enabling this.\n\n' +
  'Only enable this if you understand the xochitl filesystem structure ' +
  'and are comfortable with SSH access to your tablet.';

/** Configuration for bidirectional sync. */
export interface BidirectionalSyncConfig {
  /** Whether bidirectional sync is enabled. */
  enabled: boolean;
  /** Whether the user has explicitly acknowledged the warning. */
  warningAcknowledged: boolean;
  /** Timestamp when the user acknowledged the warning (epoch ms). */
  acknowledgedAt: number | null;
}

/** Default config: disabled and unacknowledged. */
export const DEFAULT_BIDIRECTIONAL_CONFIG: BidirectionalSyncConfig = {
  enabled: false,
  warningAcknowledged: false,
  acknowledgedAt: null,
};

/**
 * Validate that bidirectional sync is properly configured.
 *
 * @returns Error message if configuration is invalid, null if valid.
 */
export function validateBidirectionalConfig(
  config: BidirectionalSyncConfig,
): string | null {
  if (config.enabled && !config.warningAcknowledged) {
    return (
      'Bidirectional sync cannot be enabled without acknowledging the safety warning. ' +
      'Please review the warning and confirm before enabling.'
    );
  }
  return null;
}

/**
 * Restart xochitl on the tablet so it picks up new files.
 *
 * This is necessary after writing files to the xochitl directory.
 * xochitl will reload its document index on startup.
 *
 * @param ssh - SSH executor connected to the tablet.
 * @returns True if restart succeeded.
 */
export async function restartXochitl(ssh: SSHExecutor): Promise<boolean> {
  logger.info('Restarting xochitl on tablet');

  try {
    const result = await ssh.execute('systemctl restart xochitl');
    if (result.exitCode !== 0) {
      logger.error(`xochitl restart failed: ${result.stderr}`);
      return false;
    }

    // Wait for xochitl to come back up (it takes a few seconds)
    logger.info('Waiting for xochitl to restart...');
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Verify xochitl is running
    const check = await ssh.execute('systemctl is-active xochitl');
    const isActive = check.stdout.trim() === 'active';

    if (isActive) {
      logger.info('xochitl restarted successfully');
    } else {
      logger.error('xochitl did not restart properly');
    }

    return isActive;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to restart xochitl: ${msg}`);
    return false;
  }
}

/**
 * Check if xochitl is currently running on the tablet.
 *
 * @param ssh - SSH executor connected to the tablet.
 * @returns True if xochitl is active.
 */
export async function isXochitlRunning(ssh: SSHExecutor): Promise<boolean> {
  try {
    const result = await ssh.execute('systemctl is-active xochitl');
    return result.stdout.trim() === 'active';
  } catch {
    return false;
  }
}

/** Valid Syncthing folder types for bidirectional toggling. */
type SyncthingFolderType = 'sendreceive' | 'sendonly';

/** Path to the temporary JSON file written on the tablet for safe curl payloads. */
const TEMP_CONFIG_PATH = '/tmp/remarkable-bridge-folder-config.json';

/**
 * Escape a string for safe inclusion in a single-quoted shell argument.
 *
 * Replaces every single quote with the sequence: end quote, escaped
 * literal quote, reopen quote ('\\''). This is the standard POSIX
 * technique for embedding a single quote inside a single-quoted string.
 */
function shellEscapeSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/**
 * Shared helper to GET a Syncthing folder config, change its type, and
 * PUT the updated config back via the Syncthing REST API on the tablet.
 *
 * The JSON payload is written to a temp file on the tablet and referenced
 * with `curl -d @file` to avoid shell injection from folder config values.
 *
 * @param ssh - SSH executor connected to the tablet.
 * @param folderId - The Syncthing folder ID (typically "xochitl").
 * @param apiKey - The Syncthing API key on the tablet.
 * @param folderType - Target folder type to set.
 * @returns True if configuration succeeded.
 */
async function setSyncthingFolderType(
  ssh: SSHExecutor,
  folderId: string,
  apiKey: string,
  folderType: SyncthingFolderType,
): Promise<boolean> {
  // Sanitize user-provided values for shell interpolation
  const safeApiKey = shellEscapeSingleQuote(apiKey);
  const safeFolderId = shellEscapeSingleQuote(folderId);

  // GET current folder config
  const getResult = await ssh.execute(
    `curl -s -H 'X-API-Key: ${safeApiKey}' 'http://127.0.0.1:8384/rest/config/folders/${safeFolderId}'`,
  );

  if (getResult.exitCode !== 0 || !getResult.stdout.trim()) {
    logger.error(`Failed to get Syncthing folder config: ${getResult.stderr}`);
    return false;
  }

  let folderConfig: Record<string, unknown>;
  try {
    folderConfig = JSON.parse(getResult.stdout);
  } catch {
    logger.error('Failed to parse Syncthing folder config JSON');
    return false;
  }

  folderConfig['type'] = folderType;

  // Write the JSON payload to a temp file on the tablet to avoid shell
  // injection from arbitrary values inside the folder config object.
  const configJson = JSON.stringify(folderConfig);
  const safeConfigJson = shellEscapeSingleQuote(configJson);
  const writeResult = await ssh.execute(
    `printf '%s' '${safeConfigJson}' > '${TEMP_CONFIG_PATH}'`,
  );

  if (writeResult.exitCode !== 0) {
    logger.error(`Failed to write temp config file: ${writeResult.stderr}`);
    return false;
  }

  // PUT using the temp file as the request body
  const putResult = await ssh.execute(
    `curl -s -X PUT -H 'X-API-Key: ${safeApiKey}' -H 'Content-Type: application/json' ` +
    `-d '@${TEMP_CONFIG_PATH}' ` +
    `'http://127.0.0.1:8384/rest/config/folders/${safeFolderId}'`,
  );

  // Clean up temp file (best-effort, ignore errors)
  await ssh.execute(`rm -f '${TEMP_CONFIG_PATH}'`).catch(() => {});

  if (putResult.exitCode !== 0) {
    logger.error(`Failed to update Syncthing folder config: ${putResult.stderr}`);
    return false;
  }

  return true;
}

/**
 * Configure Syncthing folder as Send-Receive (bidirectional) on the tablet.
 *
 * Default is Send-Only (tablet to host). This switches to Send-Receive
 * so the host can push files back to the tablet.
 *
 * Requires the Syncthing API to be accessible on the tablet.
 *
 * @param ssh - SSH executor connected to the tablet.
 * @param folderId - The Syncthing folder ID (typically "xochitl").
 * @param apiKey - The Syncthing API key on the tablet.
 * @returns True if configuration succeeded.
 */
export async function enableBidirectionalFolder(
  ssh: SSHExecutor,
  folderId: string,
  apiKey: string,
): Promise<boolean> {
  logger.info(`Enabling bidirectional sync for folder: ${folderId}`);

  try {
    const success = await setSyncthingFolderType(ssh, folderId, apiKey, 'sendreceive');
    if (success) {
      logger.info('Bidirectional sync enabled for folder');
    }
    return success;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to enable bidirectional sync: ${msg}`);
    return false;
  }
}

/**
 * Revert Syncthing folder to Send-Only (one-directional) on the tablet.
 *
 * @param ssh - SSH executor connected to the tablet.
 * @param folderId - The Syncthing folder ID.
 * @param apiKey - The Syncthing API key on the tablet.
 * @returns True if configuration succeeded.
 */
export async function disableBidirectionalFolder(
  ssh: SSHExecutor,
  folderId: string,
  apiKey: string,
): Promise<boolean> {
  logger.info(`Disabling bidirectional sync for folder: ${folderId}`);

  try {
    const success = await setSyncthingFolderType(ssh, folderId, apiKey, 'sendonly');
    if (success) {
      logger.info('Bidirectional sync disabled, reverted to send-only');
    }
    return success;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to disable bidirectional sync: ${msg}`);
    return false;
  }
}
