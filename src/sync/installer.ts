/**
 * Entware and Syncthing installation on the reMarkable tablet.
 *
 * Installation flow:
 * 1. Check if Entware is already installed
 * 2. If not, install Entware from Evidlo/remarkable_entware
 * 3. Install Syncthing via opkg
 * 4. Verify the Syncthing binary works
 *
 * Safety guarantees:
 * - All installs go to /home/root/.entware (survives firmware updates)
 * - Never touches the root partition or xochitl files
 * - Each step is individually reversible
 * - Entware removal: rm -rf /home/root/.entware + remove PATH from .bashrc
 * - Syncthing removal: opkg remove syncthing
 */

import type { SSHExecutor } from '../ssh/ssh-client';
import { BridgeError, ErrorCode } from '../types/errors';
import { ENTWARE_PATH, SYNCTHING_BIN_PATH } from './types';
import { logger } from '../utils/logger';

/** Callback for reporting installation progress. */
export type InstallProgressCallback = (step: string, detail: string) => void;

/** Result of an installation attempt. */
export interface InstallResult {
  /** Whether the installation completed successfully. */
  success: boolean;
  /** Whether the component was already installed (skipped). */
  alreadyInstalled: boolean;
  /** Human-readable message describing the result. */
  message: string;
  /** Syncthing version string, if available after install. */
  syncthingVersion: string | null;
}

/** URL for the Entware installer script (Evidlo's remarkable_entware). */
const ENTWARE_INSTALL_URL = 'https://raw.githubusercontent.com/Evidlo/remarkable_entware/master/install.sh';

/** The opkg binary path inside Entware. */
const OPKG_BIN = '/home/root/.entware/bin/opkg';

/** Timeout for installation commands (Entware install can be slow). */
const INSTALL_TIMEOUT_MS = 120_000;

/** Timeout for quick check commands. */
const CHECK_TIMEOUT_MS = 10_000;

/**
 * Check whether Entware is installed on the tablet.
 *
 * Looks for the opkg binary at the expected Entware path.
 */
export async function isEntwareInstalled(ssh: SSHExecutor): Promise<boolean> {
  const result = await ssh.execute(
    `test -x ${OPKG_BIN} && echo "yes" || echo "no"`,
    CHECK_TIMEOUT_MS,
  );
  return result.exitCode === 0 && result.stdout.trim() === 'yes';
}

/**
 * Check whether Syncthing is installed via Entware.
 *
 * Verifies the binary exists and is executable.
 */
export async function isSyncthingInstalled(ssh: SSHExecutor): Promise<boolean> {
  const result = await ssh.execute(
    `test -x ${SYNCTHING_BIN_PATH} && echo "yes" || echo "no"`,
    CHECK_TIMEOUT_MS,
  );
  return result.exitCode === 0 && result.stdout.trim() === 'yes';
}

/**
 * Get the installed Syncthing version string.
 *
 * @returns Version string like "syncthing v1.27.0" or null if not installed.
 */
export async function getSyncthingVersion(ssh: SSHExecutor): Promise<string | null> {
  const result = await ssh.execute(
    `${SYNCTHING_BIN_PATH} --version 2>/dev/null`,
    CHECK_TIMEOUT_MS,
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return null;
  }
  // Output format: "syncthing v1.27.0 ..."
  return result.stdout.trim().split('\n')[0];
}

/**
 * Install Entware on the reMarkable tablet.
 *
 * Downloads and runs the Evidlo/remarkable_entware installer script.
 * This creates /home/root/.entware and adds it to PATH.
 *
 * Prerequisites:
 * - SSH connection to the tablet
 * - Internet access from the tablet (for wget)
 *
 * Rollback: rm -rf /home/root/.entware
 *
 * @param ssh - Active SSH connection.
 * @param onProgress - Optional progress callback.
 */
export async function installEntware(
  ssh: SSHExecutor,
  onProgress?: InstallProgressCallback,
): Promise<InstallResult> {
  const progress = onProgress ?? (() => {});

  // Check if already installed
  progress('Checking', 'Checking for existing Entware installation...');
  if (await isEntwareInstalled(ssh)) {
    logger.info('Entware already installed, skipping');
    return {
      success: true,
      alreadyInstalled: true,
      message: 'Entware is already installed.',
      syncthingVersion: null,
    };
  }

  // Verify internet connectivity from tablet
  progress('Verifying', 'Checking tablet internet connectivity...');
  const pingResult = await ssh.execute(
    'wget -q --spider http://bin.entware.net/ 2>&1 && echo "ok" || echo "fail"',
    CHECK_TIMEOUT_MS,
  );
  if (pingResult.stdout.trim() !== 'ok') {
    throw new BridgeError(
      ErrorCode.SYNC_INSTALL_FAILED,
      'The tablet cannot reach the Entware repository (bin.entware.net).',
      'Ensure the tablet has internet access. If connected via USB, the tablet needs WiFi for package downloads.',
    );
  }

  // Download and run the Entware installer
  progress('Installing', 'Downloading and installing Entware (this may take 1-2 minutes)...');
  logger.info('Installing Entware from Evidlo/remarkable_entware...');

  const installResult = await ssh.execute(
    `wget -q -O /tmp/entware_install.sh "${ENTWARE_INSTALL_URL}" && sh /tmp/entware_install.sh 2>&1`,
    INSTALL_TIMEOUT_MS,
  );

  if (installResult.exitCode !== 0) {
    throw new BridgeError(
      ErrorCode.SYNC_INSTALL_FAILED,
      `Entware installation failed (exit code ${installResult.exitCode}).`,
      `Output: ${installResult.stderr || installResult.stdout}. ` +
        'You can manually install by following https://github.com/Evidlo/remarkable_entware',
    );
  }

  // Verify installation
  progress('Verifying', 'Verifying Entware installation...');
  if (!(await isEntwareInstalled(ssh))) {
    throw new BridgeError(
      ErrorCode.SYNC_INSTALL_FAILED,
      'Entware installation appeared to succeed but opkg binary not found.',
      `Expected opkg at ${OPKG_BIN}. Check installation logs.`,
    );
  }

  logger.info('Entware installed successfully');
  return {
    success: true,
    alreadyInstalled: false,
    message: 'Entware installed successfully.',
    syncthingVersion: null,
  };
}

/**
 * Install Syncthing via Entware's opkg package manager.
 *
 * Prerequisites:
 * - Entware must be installed (call installEntware first)
 * - Internet access from the tablet (for opkg update/install)
 *
 * Rollback: opkg remove syncthing
 *
 * @param ssh - Active SSH connection.
 * @param onProgress - Optional progress callback.
 */
export async function installSyncthing(
  ssh: SSHExecutor,
  onProgress?: InstallProgressCallback,
): Promise<InstallResult> {
  const progress = onProgress ?? (() => {});

  // Verify Entware is installed
  if (!(await isEntwareInstalled(ssh))) {
    throw new BridgeError(
      ErrorCode.SYNC_INSTALL_FAILED,
      'Cannot install Syncthing: Entware is not installed.',
      'Run the Entware installation step first.',
    );
  }

  // Check if already installed
  progress('Checking', 'Checking for existing Syncthing installation...');
  if (await isSyncthingInstalled(ssh)) {
    const version = await getSyncthingVersion(ssh);
    logger.info(`Syncthing already installed: ${version}`);
    return {
      success: true,
      alreadyInstalled: true,
      message: `Syncthing is already installed (${version ?? 'unknown version'}).`,
      syncthingVersion: version,
    };
  }

  // Update opkg package lists
  progress('Updating', 'Updating Entware package lists...');
  const updateResult = await ssh.execute(
    `${OPKG_BIN} update 2>&1`,
    INSTALL_TIMEOUT_MS,
  );

  if (updateResult.exitCode !== 0) {
    throw new BridgeError(
      ErrorCode.SYNC_INSTALL_FAILED,
      'Failed to update Entware package lists.',
      `Output: ${updateResult.stderr || updateResult.stdout}. ` +
        'Ensure the tablet has internet access.',
    );
  }

  // Install Syncthing
  progress('Installing', 'Installing Syncthing via opkg (this may take 1-2 minutes)...');
  logger.info('Installing Syncthing via opkg...');

  const installResult = await ssh.execute(
    `${OPKG_BIN} install syncthing 2>&1`,
    INSTALL_TIMEOUT_MS,
  );

  if (installResult.exitCode !== 0) {
    throw new BridgeError(
      ErrorCode.SYNC_INSTALL_FAILED,
      `Syncthing installation failed (exit code ${installResult.exitCode}).`,
      `Output: ${installResult.stderr || installResult.stdout}`,
    );
  }

  // Verify the binary works
  progress('Verifying', 'Verifying Syncthing binary...');
  const version = await getSyncthingVersion(ssh);

  if (!version) {
    throw new BridgeError(
      ErrorCode.SYNC_INSTALL_FAILED,
      'Syncthing was installed but the binary does not execute correctly.',
      `Check ${SYNCTHING_BIN_PATH} on the tablet.`,
    );
  }

  logger.info(`Syncthing installed successfully: ${version}`);
  return {
    success: true,
    alreadyInstalled: false,
    message: `Syncthing installed successfully (${version}).`,
    syncthingVersion: version,
  };
}

/**
 * Perform a full installation: Entware + Syncthing.
 *
 * Convenience function that runs both installation steps in sequence.
 *
 * @param ssh - Active SSH connection.
 * @param onProgress - Optional progress callback.
 */
export async function installSyncStack(
  ssh: SSHExecutor,
  onProgress?: InstallProgressCallback,
): Promise<InstallResult> {
  const progress = onProgress ?? (() => {});

  progress('Entware', 'Starting Entware installation...');
  await installEntware(ssh, onProgress);

  progress('Syncthing', 'Starting Syncthing installation...');
  const result = await installSyncthing(ssh, onProgress);

  return result;
}
