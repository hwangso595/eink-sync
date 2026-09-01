/**
 * Entware and Syncthing installation on the reMarkable tablet.
 *
 * Installation flow:
 * 1. Check if Entware is already installed
 * 2. If not, install Entware from Evidlo/remarkable_entware
 * 3. Install Syncthing via opkg
 * 4. Verify the Syncthing binary works
 *
 * Legacy layout and safety notes:
 * - Package data lives in /home/root/.entware
 * - The upstream installer also creates /opt and /etc/systemd/system/opt.mount
 * - It is restricted to the legacy ARMv7 devices for which it was designed
 * - It never modifies xochitl document files
 * - Syncthing removal: opkg remove syncthing
 */

import type { SSHExecutor } from '../ssh/ssh-client';
import { BridgeError, ErrorCode } from '../types/errors';
import { SYNCTHING_BIN_PATH } from './types';
import { logger } from '../utils/logger';
import {
  detectDeviceArchitecture,
  detectDeviceModelIdentity,
} from '../device/detector';
import { isKnownLegacyInstallerTarget } from '../device/firmware';

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

/**
 * Pinned legacy ARMv7 Entware installer and its SHA-256 digest.
 *
 * Never point this at a mutable branch: the script runs as root. This installer
 * is intentionally disabled for AArch64 devices because it configures the
 * armv7sf feed and writes protected root-filesystem paths.
 */
const ENTWARE_INSTALL_COMMIT = '5636b8b56a44eb122a5d2253dfdb0addf28c744d';
const ENTWARE_INSTALL_URL =
  `https://raw.githubusercontent.com/Evidlo/remarkable_entware/${ENTWARE_INSTALL_COMMIT}/install.sh`;
const ENTWARE_INSTALL_SHA256 = 'e9c864d27197b9a68fd8d1c3945b23a4352d8285377bfe9e92cf285c6c921d5d';

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
 * Check whether Syncthing is installed via Entware and can execute.
 */
export async function isSyncthingInstalled(ssh: SSHExecutor): Promise<boolean> {
  return (await getSyncthingVersion(ssh)) !== null;
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

/** Fail closed before invoking the legacy ARMv7 package stack. */
async function requireLegacyArmv7(ssh: SSHExecutor): Promise<void> {
  const architecture = await detectDeviceArchitecture(ssh);
  const model = await detectDeviceModelIdentity(ssh);
  if (isKnownLegacyInstallerTarget(model, architecture)) return;

  throw new BridgeError(
    ErrorCode.SYNC_INSTALL_FAILED,
    architecture === 'aarch64'
      ? 'Automatic Syncthing installation is not supported on this AArch64 reMarkable.'
      : architecture !== 'armv7'
        ? 'Automatic Syncthing installation is disabled because the tablet architecture could not be verified.'
        : `Automatic Syncthing installation is disabled for the unverified tablet model "${model}".`,
    'Use SFTP sync on this tablet. The legacy Entware installer is only safe for ARMv7 reMarkable 1/2 devices.',
  );
}

/**
 * Install Entware on the reMarkable tablet.
 *
 * Downloads and runs the Evidlo/remarkable_entware installer script.
 * This creates /home/root/.entware, bind-mounts it at /opt, and creates an
 * opt.mount systemd unit under /etc. Those root-filesystem changes are why the
 * installer is not offered on current protected AArch64 devices.
 *
 * Prerequisites:
 * - SSH connection to the tablet
 * - Internet access from the tablet (for wget)
 *
 * Rollback follows the upstream uninstall steps, including unmounting /opt and
 * removing opt.mount before deleting /home/root/.entware.
 *
 * @param ssh - Active SSH connection.
 * @param onProgress - Optional progress callback.
 */
export async function installEntware(
  ssh: SSHExecutor,
  onProgress?: InstallProgressCallback,
): Promise<InstallResult> {
  const progress = onProgress ?? (() => {});

  // Check architecture before trusting a pre-existing executable bit. An old
  // ARMv7 Entware directory may have been copied onto an AArch64 tablet.
  await requireLegacyArmv7(ssh);

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

  // Evidlo's installer is explicitly tied to Entware's armv7sf feed. Running
  // it on current AArch64 tablets can install unusable binaries and attempt to
  // modify protected /etc and /opt paths, so unknown architectures fail safe.
  // Verify internet connectivity from tablet
  progress('Verifying', 'Checking tablet internet connectivity...');
  const pingResult = await ssh.execute(
    'wget -q --spider https://bin.entware.net/ 2>&1 && echo "ok" || echo "fail"',
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
    `wget -q -O /tmp/entware_install.sh "${ENTWARE_INSTALL_URL}" && ` +
      `echo "${ENTWARE_INSTALL_SHA256}  /tmp/entware_install.sh" | sha256sum -c - && ` +
      'sh /tmp/entware_install.sh 2>&1',
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

  // This exported function can be called independently of installEntware, so
  // it must enforce the same architecture boundary itself.
  await requireLegacyArmv7(ssh);

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
  const existingVersion = await getSyncthingVersion(ssh);
  if (existingVersion) {
    const version = existingVersion;
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
