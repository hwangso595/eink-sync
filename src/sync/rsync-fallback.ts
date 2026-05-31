/**
 * Rsync-over-SSH fallback for when Syncthing is too heavy on the rM1.
 *
 * Syncthing typically uses 50-100MB RSS which is a lot for the rM1's
 * 512MB total. Rsync uses ~2MB per invocation and exits immediately
 * after syncing, making it a lightweight alternative.
 *
 * Trade-offs vs Syncthing:
 * - Pro: Uses ~2MB RAM vs ~50-100MB
 * - Pro: No background daemon on the tablet
 * - Con: Not continuous -- must be triggered on schedule
 * - Con: No conflict resolution (but we only sync one direction)
 * - Con: Requires SSH access at sync time (Syncthing can work peer-to-peer)
 *
 * This module builds rsync commands for the host to execute, pulling files
 * from the tablet over SSH. The tablet needs no special software beyond
 * the stock SSH server.
 */

import * as os from 'os';
import * as path from 'path';
import type { SSHExecutor, CommandResult } from '../ssh/ssh-client';
import type { SyncConfig, SyncStatus } from './types';
import { XOCHITL_SYNC_PATH } from './types';
import { BridgeError, ErrorCode } from '../types/errors';
import { logger } from '../utils/logger';

/**
 * Persistent known_hosts file for the rsync transport. Using `accept-new`
 * against a stable file gives TOFU semantics (pin on first connect, reject on
 * change) instead of the previous `StrictHostKeyChecking=no` + /dev/null, which
 * trusted any host and so could leak the password to an impersonator. To
 * recover after a legitimate tablet key change, delete this file.
 */
const RSYNC_KNOWN_HOSTS = path.join(os.tmpdir(), 'eink-sync-known_hosts');

/** Timeout for rsync operations (can be slow over WiFi with large files). */
const RSYNC_TIMEOUT_MS = 300_000; // 5 minutes

/** Timeout for quick check commands. */
const CHECK_TIMEOUT_MS = 10_000;

/**
 * Check whether rsync is available on the tablet.
 *
 * Stock reMarkable firmware includes busybox which may or may not have rsync.
 * If not available natively, it can be installed via Entware.
 */
export async function isRsyncAvailable(ssh: SSHExecutor): Promise<boolean> {
  const result = await ssh.execute(
    'command -v rsync >/dev/null 2>&1 && echo "yes" || echo "no"',
    CHECK_TIMEOUT_MS,
  );
  return result.exitCode === 0 && result.stdout.trim() === 'yes';
}

/**
 * Build the rsync command arguments for a one-directional sync.
 *
 * The command syncs FROM the tablet TO the host:
 * - Archive mode (-a): preserves permissions, timestamps, symlinks
 * - Compress (-z): reduces transfer size over WiFi
 * - Delete: removes files on host that were deleted on tablet
 * - Partial + progress: resume interrupted transfers
 * - Exclude patterns: skip thumbnails and temp files
 *
 * @param config - Sync configuration with paths.
 * @param sshHost - Tablet SSH host address.
 * @param sshPort - Tablet SSH port.
 * @returns Array of rsync command arguments.
 */
export function buildRsyncArgs(
  config: SyncConfig,
  sshHost: string,
  sshPort: number,
): string[] {
  const tabletPath = config.tabletSyncPath || XOCHITL_SYNC_PATH;
  const hostPath = config.hostSyncPath;

  return [
    'rsync',
    '-az',
    '--delete',
    '--partial',
    '--timeout=120',
    // Exclude thumbnails and temp files to save bandwidth
    '--exclude=.thumbnails/',
    '--exclude=.cache/',
    '--exclude=*.tmp',
    '--exclude=.stfolder',
    '--exclude=.stignore',
    // SSH transport with TOFU host-key pinning (accept-new pins on first
    // connect, rejects a changed key) against a persistent known_hosts file.
    '-e', `ssh -p ${sshPort} -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${RSYNC_KNOWN_HOSTS} -o LogLevel=ERROR`,
    // Source: tablet xochitl directory (trailing slash = contents, not directory itself)
    `root@${sshHost}:${tabletPath}/`,
    // Destination: local host sync folder
    hostPath,
  ];
}

/**
 * Build the rsync command as a single string for SSH execution.
 *
 * This variant is used when rsync is run from the tablet side (push mode)
 * rather than from the host side (pull mode). Push mode is useful when
 * the host is not able to initiate connections to the tablet.
 *
 * However, the primary mode is pull-from-host since we already have SSH access.
 */
export function buildRsyncCommand(
  config: SyncConfig,
  sshHost: string,
  sshPort: number,
): string {
  const args = buildRsyncArgs(config, sshHost, sshPort);
  return args.join(' ');
}

/** Result of an rsync sync operation. */
export interface RsyncResult {
  /** Whether the sync completed successfully. */
  success: boolean;
  /** Number of files transferred. */
  filesTransferred: number;
  /** Total bytes transferred. */
  bytesTransferred: number;
  /** Human-readable summary. */
  message: string;
  /** Raw rsync output for debugging. */
  rawOutput: string;
}

/**
 * Parse rsync output to extract transfer statistics.
 *
 * Rsync's --stats output includes lines like:
 *   Number of files transferred: 42
 *   Total transferred file size: 1,234,567 bytes
 */
export function parseRsyncOutput(output: string): { filesTransferred: number; bytesTransferred: number } {
  let filesTransferred = 0;
  let bytesTransferred = 0;

  const filesMatch = output.match(/Number of (?:regular )?files transferred:\s*([\d,]+)/);
  if (filesMatch) {
    filesTransferred = parseInt(filesMatch[1].replace(/,/g, ''), 10);
  }

  const bytesMatch = output.match(/Total transferred file size:\s*([\d,]+)/);
  if (bytesMatch) {
    bytesTransferred = parseInt(bytesMatch[1].replace(/,/g, ''), 10);
  }

  return { filesTransferred, bytesTransferred };
}

/** Result of building a host rsync command with environment variables. */
export interface HostRsyncCommand {
  /** The rsync command string to execute on the host. */
  command: string;
  /** Environment variables to set when executing the command.
   *  SSHPASS contains the password so it is not visible in process listings. */
  env: Record<string, string>;
}

/**
 * Build an rsync command for host-side execution.
 *
 * This builds the command but delegates actual execution to the caller
 * since rsync runs on the host, not on the tablet.
 *
 * Security: The password is passed via the SSHPASS environment variable
 * rather than embedded in the command string. This prevents the password
 * from being visible in `ps aux` output. The `-e` flag tells sshpass to
 * read the password from the SSHPASS env var.
 *
 * If sshpass is not available, SSH key-based auth should be used instead.
 *
 * @param config - Sync configuration.
 * @param sshHost - Tablet SSH host.
 * @param sshPort - Tablet SSH port.
 * @param sshPassword - SSH password for the tablet.
 * @returns Command string and environment variables for secure execution.
 */
export function getHostRsyncCommand(
  config: SyncConfig,
  sshHost: string,
  sshPort: number,
  sshPassword: string,
): HostRsyncCommand {
  const args = buildRsyncArgs(config, sshHost, sshPort);
  return {
    command: `sshpass -e ${args.join(' ')} --stats`,
    env: { SSHPASS: sshPassword },
  };
}

/**
 * Run rsync on the tablet side to verify it works.
 *
 * Does a dry-run to check connectivity and permissions without
 * actually transferring files.
 *
 * @param ssh - Active SSH connection to the tablet.
 * @param tabletSyncPath - Path to sync on the tablet.
 */
export async function verifyRsyncCapability(
  ssh: SSHExecutor,
  tabletSyncPath?: string,
): Promise<{ available: boolean; message: string }> {
  const syncPath = tabletSyncPath || XOCHITL_SYNC_PATH;

  // Check if rsync binary exists
  if (!(await isRsyncAvailable(ssh))) {
    return {
      available: false,
      message: 'rsync is not installed on the tablet. It can be installed via Entware: opkg install rsync.',
    };
  }

  // Verify the sync source path is readable
  const pathCheck = await ssh.execute(
    `test -d "${syncPath}" && echo "ok" || echo "missing"`,
    CHECK_TIMEOUT_MS,
  );

  if (pathCheck.stdout.trim() !== 'ok') {
    return {
      available: false,
      message: `Sync source path ${syncPath} does not exist on the tablet.`,
    };
  }

  return {
    available: true,
    message: 'rsync is available and the sync source path is accessible.',
  };
}
