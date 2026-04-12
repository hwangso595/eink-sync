/**
 * Firmware compatibility layer -- handles firmware update recovery,
 * Entware persistence verification, and post-update health checks.
 *
 * Epic 6 requirements:
 * - Detect when Syncthing service was wiped by OTA update
 * - Guide user through re-enabling the service
 * - Verify Entware is installed to /home partition (persists across updates)
 * - Post-update health check for the full pipeline
 */

import { SSHExecutor } from '../ssh/ssh-client';
import { FirmwareVersion } from '../types/device';
import { logger } from '../utils/logger';
import {
  parseFirmwareVersion,
  getInstallationPath,
  usesV6FileFormat,
  type InstallationPath,
} from './firmware';

/** Paths where Entware should be installed (on /home, survives OTA). */
const ENTWARE_HOME_PATH = '/home/root/.entware';
const ENTWARE_BIN_PATH = '/home/root/.entware/bin';
const SYNCTHING_BINARY_PATH = '/home/root/.entware/bin/syncthing';

/** Systemd service file location. */
const SYNCTHING_SERVICE_PATH = '/etc/systemd/system/remarkable-sync.service';

/** Backup location for the service file (on /home, survives OTA). */
const SYNCTHING_SERVICE_BACKUP_PATH = '/home/root/.entware/remarkable-sync.service.bak';

/** Syncthing config directory (on /home, survives OTA). */
const SYNCTHING_CONFIG_PATH = '/home/root/.config/syncthing';

/** Status of a single health check item. */
export interface HealthCheckItem {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  recoveryHint?: string;
}

/** Result of a full post-update health check. */
export interface HealthCheckResult {
  /** Whether all critical checks passed. */
  healthy: boolean;
  /** Individual check results. */
  checks: HealthCheckItem[];
  /** Detected firmware version. */
  firmwareVersion: FirmwareVersion | null;
  /** Installation path for this firmware. */
  installPath: InstallationPath | null;
  /** Whether a firmware update was detected (service missing but binaries present). */
  firmwareUpdateDetected: boolean;
  /** Recovery steps if firmware update wiped the service. */
  recoverySteps: string[];
}

/**
 * Check whether a file or directory exists on the device.
 */
async function pathExists(ssh: SSHExecutor, remotePath: string): Promise<boolean> {
  const result = await ssh.execute(`test -e ${remotePath} && echo yes || echo no`);
  return result.exitCode === 0 && result.stdout.trim() === 'yes';
}

/**
 * Check whether a systemd service is active.
 */
async function isServiceActive(ssh: SSHExecutor, serviceName: string): Promise<boolean> {
  const result = await ssh.execute(`systemctl is-active ${serviceName} 2>/dev/null`);
  return result.exitCode === 0 && result.stdout.trim() === 'active';
}

/**
 * Check whether a systemd service unit file exists.
 */
async function serviceFileExists(ssh: SSHExecutor, servicePath: string): Promise<boolean> {
  return pathExists(ssh, servicePath);
}

/**
 * Verify that Entware is installed on the /home partition.
 */
async function checkEntwareInstallation(ssh: SSHExecutor): Promise<HealthCheckItem> {
  const exists = await pathExists(ssh, ENTWARE_HOME_PATH);

  if (!exists) {
    return {
      name: 'Entware installation',
      status: 'fail',
      message: 'Entware not found at /home/root/.entware',
      recoveryHint: 'Re-run the setup wizard to install Entware.',
    };
  }

  // Verify it is on the /home partition (not /opt on root)
  const mountResult = await ssh.execute(`df ${ENTWARE_HOME_PATH} | tail -1`);
  const isOnHome = mountResult.stdout.includes('/home');

  if (!isOnHome) {
    return {
      name: 'Entware installation',
      status: 'warn',
      message: 'Entware found but may not be on /home partition. It might not survive firmware updates.',
      recoveryHint: 'Reinstall Entware to /home/root/.entware for persistence across updates.',
    };
  }

  return {
    name: 'Entware installation',
    status: 'pass',
    message: 'Entware installed on /home partition (persists across firmware updates)',
  };
}

/**
 * Check Syncthing binary availability.
 */
async function checkSyncthingBinary(ssh: SSHExecutor): Promise<HealthCheckItem> {
  const exists = await pathExists(ssh, SYNCTHING_BINARY_PATH);

  if (!exists) {
    // Check if it is available via PATH (opkg may have installed elsewhere)
    const whichResult = await ssh.execute('which syncthing 2>/dev/null');
    if (whichResult.exitCode === 0 && whichResult.stdout.trim()) {
      return {
        name: 'Syncthing binary',
        status: 'pass',
        message: `Syncthing found at ${whichResult.stdout.trim()}`,
      };
    }

    return {
      name: 'Syncthing binary',
      status: 'fail',
      message: 'Syncthing binary not found',
      recoveryHint: 'Install Syncthing via: opkg install syncthing',
    };
  }

  return {
    name: 'Syncthing binary',
    status: 'pass',
    message: 'Syncthing binary present',
  };
}

/**
 * Check the Syncthing systemd service.
 *
 * This is the most common thing to break after a firmware update --
 * OTA updates overwrite the root partition, deleting systemd service files.
 */
async function checkSyncthingService(ssh: SSHExecutor): Promise<HealthCheckItem> {
  const fileExists = await serviceFileExists(ssh, SYNCTHING_SERVICE_PATH);
  const isActive = await isServiceActive(ssh, 'remarkable-sync');

  if (isActive) {
    return {
      name: 'Syncthing service',
      status: 'pass',
      message: 'Syncthing service is active and running',
    };
  }

  if (fileExists && !isActive) {
    return {
      name: 'Syncthing service',
      status: 'warn',
      message: 'Syncthing service file exists but service is not running',
      recoveryHint: 'Try: systemctl enable --now remarkable-sync',
    };
  }

  // Service file missing -- likely wiped by firmware update
  const backupExists = await pathExists(ssh, SYNCTHING_SERVICE_BACKUP_PATH);

  if (backupExists) {
    return {
      name: 'Syncthing service',
      status: 'fail',
      message: 'Syncthing service file was removed (likely by firmware update). Backup found.',
      recoveryHint:
        `Restore with: cp ${SYNCTHING_SERVICE_BACKUP_PATH} ${SYNCTHING_SERVICE_PATH} && ` +
        'systemctl daemon-reload && systemctl enable --now remarkable-sync',
    };
  }

  return {
    name: 'Syncthing service',
    status: 'fail',
    message: 'Syncthing service file not found and no backup available',
    recoveryHint: 'Re-run the setup wizard to recreate the service.',
  };
}

/**
 * Check Syncthing configuration directory.
 */
async function checkSyncthingConfig(ssh: SSHExecutor): Promise<HealthCheckItem> {
  const exists = await pathExists(ssh, SYNCTHING_CONFIG_PATH);

  if (!exists) {
    return {
      name: 'Syncthing config',
      status: 'fail',
      message: 'Syncthing configuration directory not found',
      recoveryHint: 'Re-run the setup wizard to configure Syncthing.',
    };
  }

  return {
    name: 'Syncthing config',
    status: 'pass',
    message: 'Syncthing configuration present on /home (persists across updates)',
  };
}

/**
 * Check xochitl data directory accessibility.
 */
async function checkXochitlData(ssh: SSHExecutor): Promise<HealthCheckItem> {
  const xochitlPath = '/home/root/.local/share/remarkable/xochitl';
  const exists = await pathExists(ssh, xochitlPath);

  if (!exists) {
    return {
      name: 'xochitl data',
      status: 'fail',
      message: 'xochitl data directory not found',
      recoveryHint: 'The device may not have any documents yet, or the path has changed.',
    };
  }

  // Count documents
  const countResult = await ssh.execute(`ls ${xochitlPath}/*.metadata 2>/dev/null | wc -l`);
  const docCount = parseInt(countResult.stdout.trim(), 10) || 0;

  return {
    name: 'xochitl data',
    status: 'pass',
    message: `xochitl data accessible (${docCount} document metadata files)`,
  };
}

/**
 * Run a full post-update health check.
 *
 * Verifies the complete pipeline is functional after a firmware update:
 * 1. Firmware version detected
 * 2. Entware installed on /home (persistent)
 * 3. Syncthing binary present
 * 4. Syncthing service active
 * 5. Syncthing config present
 * 6. xochitl data accessible
 *
 * If the service was wiped by a firmware update, provides recovery steps.
 */
export async function runPostUpdateHealthCheck(
  ssh: SSHExecutor,
): Promise<HealthCheckResult> {
  logger.info('Running post-update health check...');

  const result: HealthCheckResult = {
    healthy: true,
    checks: [],
    firmwareVersion: null,
    installPath: null,
    firmwareUpdateDetected: false,
    recoverySteps: [],
  };

  // Check firmware version
  try {
    const versionResult = await ssh.execute('cat /etc/version');
    if (versionResult.exitCode === 0 && versionResult.stdout.trim()) {
      result.firmwareVersion = parseFirmwareVersion(versionResult.stdout.trim());
      result.installPath = getInstallationPath(result.firmwareVersion);

      result.checks.push({
        name: 'Firmware version',
        status: 'pass',
        message: `Firmware ${result.firmwareVersion.raw} detected (${result.installPath} path)`,
      });
    }
  } catch (err) {
    result.checks.push({
      name: 'Firmware version',
      status: 'warn',
      message: `Could not parse firmware version: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Run all component checks
  const entwareCheck = await checkEntwareInstallation(ssh);
  const binaryCheck = await checkSyncthingBinary(ssh);
  const serviceCheck = await checkSyncthingService(ssh);
  const configCheck = await checkSyncthingConfig(ssh);
  const xochitlCheck = await checkXochitlData(ssh);

  result.checks.push(entwareCheck, binaryCheck, serviceCheck, configCheck, xochitlCheck);

  // Detect firmware update scenario:
  // Syncthing binary exists but service file is missing
  const binaryPresent = binaryCheck.status === 'pass';
  const serviceMissing = serviceCheck.status === 'fail';
  const configPresent = configCheck.status === 'pass';

  if (binaryPresent && serviceMissing && configPresent) {
    result.firmwareUpdateDetected = true;
    logger.warn('Firmware update detected: Syncthing binary and config present but service missing');

    // Build recovery steps
    result.recoverySteps = buildRecoverySteps(serviceCheck);
  }

  // Determine overall health
  result.healthy = result.checks.every(
    (c) => c.status === 'pass' || c.status === 'warn',
  );

  logger.info(
    `Health check complete: ${result.healthy ? 'HEALTHY' : 'ISSUES FOUND'} ` +
    `(${result.checks.filter(c => c.status === 'pass').length}/${result.checks.length} passed)`,
  );

  return result;
}

/**
 * Build recovery steps for a firmware update scenario.
 */
function buildRecoverySteps(serviceCheck: HealthCheckItem): string[] {
  const steps: string[] = [
    'A firmware update appears to have removed the Syncthing service.',
    'Your Syncthing binary and configuration are safe on /home.',
  ];

  if (serviceCheck.recoveryHint?.includes('cp')) {
    steps.push(
      'Step 1: Restore the service file from backup:',
      `  ${serviceCheck.recoveryHint?.split('&&')[0]?.trim()}`,
      'Step 2: Reload systemd and start the service:',
      '  systemctl daemon-reload && systemctl enable --now remarkable-sync',
    );
  } else {
    steps.push(
      'Step 1: Re-run the setup wizard from the Obsidian plugin settings.',
      'Step 2: The wizard will detect the existing installation and only recreate the service file.',
    );
  }

  steps.push(
    'Tip: Consider disabling automatic firmware updates with codexctl to prevent this.',
  );

  return steps;
}

/**
 * Format the health check result as a human-readable report.
 */
export function formatHealthCheckReport(result: HealthCheckResult): string {
  const lines: string[] = [];

  lines.push('=== Post-Update Health Check ===');
  lines.push('');

  if (result.firmwareVersion) {
    lines.push(`Firmware: ${result.firmwareVersion.raw}`);
    lines.push(`Install path: ${result.installPath}`);
    lines.push('');
  }

  for (const check of result.checks) {
    const icon = check.status === 'pass' ? 'OK' : check.status === 'warn' ? 'WARN' : 'FAIL';
    lines.push(`[${icon}] ${check.name}: ${check.message}`);
    if (check.recoveryHint) {
      lines.push(`       Fix: ${check.recoveryHint}`);
    }
  }

  lines.push('');

  if (result.firmwareUpdateDetected) {
    lines.push('*** Firmware update detected ***');
    for (const step of result.recoverySteps) {
      lines.push(step);
    }
    lines.push('');
  }

  lines.push(
    result.healthy
      ? 'Overall: HEALTHY - pipeline is functional'
      : 'Overall: ISSUES FOUND - see above for recovery steps',
  );

  return lines.join('\n');
}
