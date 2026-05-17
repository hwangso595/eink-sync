/**
 * High-level sync orchestrator that ties together installation,
 * configuration, service management, and status reporting.
 *
 * SyncManager is the main entry point for Sprint 2's sync functionality.
 * It handles:
 * - Choosing between Syncthing and rsync based on device capabilities
 * - Installing and configuring the chosen sync engine
 * - Starting/stopping sync services
 * - Reporting sync status for the Obsidian UI
 *
 * All tablet communication goes through the SSHExecutor interface
 * (dependency injection from Sprint 1).
 */

import type { SSHExecutor } from '../ssh/ssh-client';
import type { DeviceInfo, ResourceBudget } from '../types/device';
import { DEFAULT_RESOURCE_BUDGETS } from '../types/device';
import { BridgeError, ErrorCode } from '../types/errors';
import { logger } from '../utils/logger';

import type { SyncConfig, SyncMethod, SyncStatus, SyncthingConfig } from './types';
import {
  createDefaultSyncConfig,
  SYNCTHING_CONFIG_DIR,
  SYNCTHING_SERVICE_NAME,
  XOCHITL_SYNC_PATH,
} from './types';

/** Timeout for Syncthing identity generation. */
const GENERATE_IDENTITY_TIMEOUT_MS = 30_000;

/** Timeout for reading the Syncthing device ID. */
const READ_DEVICE_ID_TIMEOUT_MS = 15_000;

/** Timeout for rsync installation via Entware. */
const RSYNC_INSTALL_TIMEOUT_MS = 120_000;

/** Timeout for restarting the Syncthing systemd service. */
const SERVICE_RESTART_TIMEOUT_MS = 15_000;

import {
  isEntwareInstalled,
  isSyncthingInstalled,
  installSyncStack,
  getSyncthingVersion,
  type InstallProgressCallback,
} from './installer';

import {
  generateSyncthingConfig,
  generateApiKey,
} from './syncthing-config';

import {
  deployServices,
  startServices,
  stopServices,
  isServiceRunning,
  getSyncthingMemoryUsage,
} from './service-manager';

import {
  isRsyncAvailable,
  verifyRsyncCapability,
} from './rsync-fallback';

/** Progress callback for setup operations. */
export type SetupProgressCallback = (phase: string, step: string, detail: string) => void;

/** Result of the full sync setup flow. */
export interface SyncSetupResult {
  /** Whether setup completed successfully. */
  success: boolean;
  /** The sync method that was configured. */
  method: SyncMethod;
  /** The final sync configuration. */
  config: SyncConfig;
  /** Human-readable summary of what was done. */
  summary: string;
  /** Warnings collected during setup (non-fatal issues). */
  warnings: string[];
}

/**
 * Determine the best sync method for the device.
 *
 * Logic:
 * - rM1 with tight memory: prefer rsync (2MB vs 50-100MB)
 * - rM2 or rM1 with sufficient RAM: prefer Syncthing (continuous sync)
 * - If Syncthing is already installed: use it regardless
 * - Fallback to rsync if Syncthing install fails
 *
 * @param ssh - Active SSH connection.
 * @param deviceInfo - Device detection results.
 * @returns Recommended sync method.
 */
export async function recommendSyncMethod(
  ssh: SSHExecutor,
  deviceInfo: DeviceInfo,
): Promise<SyncMethod> {
  // If Syncthing is already installed, recommend keeping it
  if (await isSyncthingInstalled(ssh)) {
    logger.info('Syncthing already installed, recommending Syncthing');
    return 'syncthing';
  }

  const budget = DEFAULT_RESOURCE_BUDGETS[deviceInfo.model];

  // rM1 with very low available RAM: recommend rsync
  if (deviceInfo.model === 'reMarkable1' &&
      deviceInfo.memory.availableMB < budget.minFreeMemoryMB + budget.syncthingMaxMemoryMB) {
    logger.info(
      `rM1 with ${deviceInfo.memory.availableMB}MB available RAM. ` +
      `Need ${budget.minFreeMemoryMB + budget.syncthingMaxMemoryMB}MB for Syncthing. ` +
      'Recommending rsync fallback.',
    );
    return 'rsync';
  }

  // Default: Syncthing for continuous sync
  return 'syncthing';
}

/**
 * Set up file synchronization on the reMarkable tablet.
 *
 * This is the main entry point for the setup wizard's sync configuration step.
 * It handles the full flow: method selection, installation, configuration,
 * and service deployment.
 *
 * @param ssh - Active SSH connection.
 * @param deviceInfo - Device detection results from Sprint 1.
 * @param hostSyncPath - Where to sync files on the host.
 * @param hostDeviceId - Syncthing device ID of the host (if using Syncthing).
 * @param hostAddress - TCP address of the host for Syncthing.
 * @param onProgress - Optional progress callback.
 * @param forcedMethod - Override the auto-detected method.
 */
export async function setupSync(
  ssh: SSHExecutor,
  deviceInfo: DeviceInfo,
  hostSyncPath: string,
  hostDeviceId?: string,
  hostAddress?: string,
  onProgress?: SetupProgressCallback,
  forcedMethod?: SyncMethod,
): Promise<SyncSetupResult> {
  const progress = onProgress ?? (() => {});
  const warnings: string[] = [];
  const budget = DEFAULT_RESOURCE_BUDGETS[deviceInfo.model];

  // Step 1: Determine sync method
  progress('Planning', 'Method Selection', 'Determining best sync method for your device...');
  const method = forcedMethod ?? await recommendSyncMethod(ssh, deviceInfo);
  logger.info(`Selected sync method: ${method}`);

  const config = createDefaultSyncConfig(deviceInfo.model, budget, hostSyncPath);
  config.method = method;

  if (method === 'rsync') {
    return setupRsync(ssh, config, progress, warnings);
  }

  return setupSyncthing(ssh, config, deviceInfo, hostDeviceId, hostAddress, progress, warnings);
}

/**
 * Set up Syncthing-based sync.
 */
async function setupSyncthing(
  ssh: SSHExecutor,
  config: SyncConfig,
  deviceInfo: DeviceInfo,
  hostDeviceId?: string,
  hostAddress?: string,
  onProgress?: SetupProgressCallback,
  warnings: string[] = [],
): Promise<SyncSetupResult> {
  const progress = onProgress ?? (() => {});

  try {
    // Step 2: Install Entware + Syncthing
    progress('Installing', 'Sync Stack', 'Installing Entware and Syncthing...');
    const installProgress: InstallProgressCallback = (step, detail) => {
      progress('Installing', step, detail);
    };
    await installSyncStack(ssh, installProgress);

    // Step 3: Generate Syncthing device ID by running syncthing once
    progress('Configuring', 'Device ID', 'Generating Syncthing device identity...');
    const tabletDeviceId = await getOrCreateTabletDeviceId(ssh);

    // Step 4: Build Syncthing config
    progress('Configuring', 'Config', 'Writing Syncthing configuration...');

    const syncthingConfig: SyncthingConfig = {
      tabletDeviceId,
      hostDeviceId: hostDeviceId ?? '',
      tabletApiKey: generateApiKey(),
      tabletListenAddress: 'tcp://0.0.0.0:22000',
      hostAddress: hostAddress ?? 'dynamic',
      guiListenAddress: '127.0.0.1:8384',
    };

    config.syncthing = syncthingConfig;

    // Write config.xml to tablet
    const configXml = generateSyncthingConfig(config, syncthingConfig);
    const writeResult = await ssh.execute(
      `mkdir -p ${SYNCTHING_CONFIG_DIR} && cat > ${SYNCTHING_CONFIG_DIR}/config.xml << 'CONFIGEOF'
${configXml}
CONFIGEOF`,
    );

    if (writeResult.exitCode !== 0) {
      throw new BridgeError(
        ErrorCode.SYNC_CONFIG_FAILED,
        'Failed to write Syncthing configuration.',
        `Error: ${writeResult.stderr}`,
      );
    }

    // Create .stfolder marker in the sync directory
    await ssh.execute(`mkdir -p ${config.tabletSyncPath}/.stfolder`);

    // Step 5: Deploy systemd services
    progress('Deploying', 'Services', 'Setting up systemd services...');
    await deployServices(ssh, config);

    // Step 6: Start services
    progress('Starting', 'Sync', 'Starting Syncthing and watchdog...');
    await startServices(ssh);

    // Step 7: Verify
    progress('Verifying', 'Status', 'Verifying sync service is running...');
    const running = await isServiceRunning(ssh);
    if (!running) {
      warnings.push('Syncthing service was started but is not currently running. It may take a moment to initialize.');
    }

    const version = await getSyncthingVersion(ssh);

    return {
      success: true,
      method: 'syncthing',
      config,
      summary: `Syncthing ${version ?? ''} configured for local-only sync. ` +
        `Tablet device ID: ${tabletDeviceId}. ` +
        `Memory limit: ${config.resourceBudget.syncthingMaxMemoryMB}MB. ` +
        `Watchdog active: pauses sync if free RAM < ${config.resourceBudget.minFreeMemoryMB}MB.`,
      warnings,
    };
  } catch (err) {
    // If Syncthing setup fails, try falling back to rsync
    if (err instanceof BridgeError && err.code === ErrorCode.SYNC_INSTALL_FAILED) {
      logger.warn('Syncthing installation failed, falling back to rsync');
      warnings.push(`Syncthing setup failed: ${err.message}. Falling back to rsync.`);
      config.method = 'rsync';
      return setupRsync(ssh, config, onProgress, warnings);
    }
    throw err;
  }
}

/**
 * Set up rsync-based sync (lightweight fallback).
 */
async function setupRsync(
  ssh: SSHExecutor,
  config: SyncConfig,
  onProgress?: SetupProgressCallback,
  warnings: string[] = [],
): Promise<SyncSetupResult> {
  const progress = onProgress ?? (() => {});

  config.method = 'rsync';

  // Check if rsync is available on the tablet
  progress('Checking', 'Rsync', 'Checking rsync availability...');
  const rsyncCheck = await verifyRsyncCapability(ssh, config.tabletSyncPath);

  if (!rsyncCheck.available) {
    let rsyncInstalled = false;

    // Try installing rsync via Entware if available
    if (await isEntwareInstalled(ssh)) {
      progress('Installing', 'Rsync', 'Installing rsync via Entware...');
      const installResult = await ssh.execute(
        '/home/root/.entware/bin/opkg update && /home/root/.entware/bin/opkg install rsync 2>&1',
        RSYNC_INSTALL_TIMEOUT_MS,
      );

      if (installResult.exitCode === 0) {
        rsyncInstalled = true;
      } else {
        warnings.push('Could not install rsync via Entware. You may need to install it manually.');
      }
    } else {
      warnings.push(
        'rsync is not available on the tablet and Entware is not installed. ' +
        'rsync fallback requires either stock rsync (some firmwares include it) or Entware.',
      );
    }

    if (!rsyncInstalled) {
      return {
        success: false,
        method: 'rsync',
        config,
        summary: 'rsync is not available on the tablet and could not be installed.',
        warnings,
      };
    }
  }

  return {
    success: true,
    method: 'rsync',
    config,
    summary: 'Rsync-over-SSH configured as the sync method. ' +
      'Sync will be triggered on schedule rather than running continuously. ' +
      'This uses minimal tablet resources (~2MB RAM per sync).',
    warnings,
  };
}

/**
 * Get the tablet's Syncthing device ID, creating a new identity if needed.
 *
 * Runs `syncthing generate` to create keys if they don't exist,
 * then reads the device ID.
 */
async function getOrCreateTabletDeviceId(ssh: SSHExecutor): Promise<string> {
  // Check if config.xml already exists with a device identity
  const existingResult = await ssh.execute(
    `test -f ${SYNCTHING_CONFIG_DIR}/config.xml && ` +
    `grep -oP 'id="\\K[^"]+' ${SYNCTHING_CONFIG_DIR}/config.xml 2>/dev/null | head -1`,
  );

  if (existingResult.exitCode === 0 && existingResult.stdout.trim()) {
    const existingId = existingResult.stdout.trim();
    logger.info(`Reusing existing Syncthing device ID: ${existingId.substring(0, 7)}...`);
    return existingId;
  }

  // No existing identity found -- generate a new one
  logger.info('No existing Syncthing identity found, generating new one');
  const generateResult = await ssh.execute(
    `/home/root/.entware/bin/syncthing generate --home=${SYNCTHING_CONFIG_DIR} 2>&1`,
    GENERATE_IDENTITY_TIMEOUT_MS,
  );

  if (generateResult.exitCode !== 0) {
    throw new BridgeError(
      ErrorCode.SYNC_CONFIG_FAILED,
      'Failed to generate Syncthing identity.',
      `syncthing generate failed: ${generateResult.stderr || generateResult.stdout}`,
    );
  }

  // Read the device ID from the newly generated identity
  const idResult = await ssh.execute(
    `/home/root/.entware/bin/syncthing --home=${SYNCTHING_CONFIG_DIR} --device-id 2>/dev/null`,
    READ_DEVICE_ID_TIMEOUT_MS,
  );

  if (idResult.exitCode === 0 && idResult.stdout.trim()) {
    return idResult.stdout.trim();
  }

  throw new BridgeError(
    ErrorCode.SYNC_CONFIG_FAILED,
    'Could not determine Syncthing device ID after generating identity.',
    'Check that Syncthing is installed correctly.',
  );
}

/**
 * Get the current sync status.
 *
 * Queries the tablet to determine what sync method is active,
 * whether it's running, memory usage, etc.
 *
 * @param ssh - Active SSH connection.
 * @param config - Current sync configuration.
 */
export async function getSyncStatus(
  ssh: SSHExecutor,
  config: SyncConfig,
): Promise<SyncStatus> {
  const baseStatus: SyncStatus = {
    running: false,
    method: config.method,
    lastSyncTimestamp: null,
    pendingFiles: 0,
    tabletReachable: false,
    syncProcessMemoryMB: null,
    message: 'Checking status...',
  };

  // Check tablet connectivity
  try {
    const pingOk = await ssh.ping();
    baseStatus.tabletReachable = pingOk;
  } catch {
    baseStatus.tabletReachable = false;
    baseStatus.message = 'Tablet is not reachable.';
    return baseStatus;
  }

  if (config.method === 'syncthing') {
    return getSyncthingStatus(ssh, baseStatus);
  }

  return getRsyncStatus(ssh, baseStatus);
}

/**
 * Get status for Syncthing-based sync.
 */
async function getSyncthingStatus(
  ssh: SSHExecutor,
  status: SyncStatus,
): Promise<SyncStatus> {
  status.running = await isServiceRunning(ssh);
  status.syncProcessMemoryMB = await getSyncthingMemoryUsage(ssh);

  if (status.running) {
    status.message = `Syncthing running (${status.syncProcessMemoryMB ?? '?'}MB RSS).`;
  } else {
    status.message = 'Syncthing service is not running.';
  }

  return status;
}

/**
 * Get status for rsync-based sync.
 */
async function getRsyncStatus(
  ssh: SSHExecutor,
  status: SyncStatus,
): Promise<SyncStatus> {
  // rsync is not a daemon, so it's only "running" during an active transfer
  const rsyncCheck = await ssh.execute(
    'pgrep rsync >/dev/null 2>&1 && echo "running" || echo "idle"',
  );

  status.running = rsyncCheck.stdout.trim() === 'running';
  status.message = status.running
    ? 'rsync transfer in progress.'
    : 'rsync idle (will sync on next scheduled interval).';

  return status;
}

/**
 * Stop sync on the tablet, regardless of method.
 *
 * For Syncthing: stops the systemd services.
 * For rsync: kills any running rsync process (though it usually exits on its own).
 */
export async function stopSync(
  ssh: SSHExecutor,
  config: SyncConfig,
): Promise<void> {
  if (config.method === 'syncthing') {
    await stopServices(ssh);
  } else {
    await ssh.execute('pkill rsync 2>/dev/null');
  }
  logger.info('Sync stopped');
}

/**
 * Restart sync on the tablet.
 *
 * For Syncthing: restarts the systemd service.
 * For rsync: no-op (rsync runs on schedule, not as a daemon).
 */
export async function restartSync(
  ssh: SSHExecutor,
  config: SyncConfig,
): Promise<void> {
  if (config.method === 'syncthing') {
    await ssh.execute(`systemctl restart ${SYNCTHING_SERVICE_NAME}`, SERVICE_RESTART_TIMEOUT_MS);
    logger.info('Syncthing service restarted');
  } else {
    logger.info('rsync does not run as a daemon; no restart needed');
  }
}
