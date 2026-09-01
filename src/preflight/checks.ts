/**
 * Pre-flight checks for reMarkable tablet readiness.
 *
 * These checks run before any installation or sync setup to verify the device
 * is compatible and has sufficient resources. Per the spec (Epic 1, should-have):
 * "Pre-flight check reports firmware version, available RAM, available storage,
 *  and device generation; clear pass/fail indicator with explanations for any failures."
 *
 * All checks are read-only and cannot modify the device.
 */

import { DeviceInfo, ResourceBudget, DEFAULT_RESOURCE_BUDGETS } from '../types/device';
import {
  getInstallationPath,
  getFirmwareCompatibilityWarning,
  isKnownLegacyInstallerTarget,
  usesV6FileFormat,
  type InstallationPath,
} from '../device/firmware';
import { SSHExecutor } from '../ssh/ssh-client';
import { XOCHITL_DATA_PATH } from '../device/detector';
import { logger } from '../utils/logger';

/** Result of a single pre-flight check. */
export interface CheckResult {
  /** Human-readable name of the check. */
  name: string;
  /** Whether the check passed. */
  passed: boolean;
  /** Detailed message explaining the result. */
  message: string;
  /** Severity: "error" blocks installation, "warning" needs attention, "info" is a passing result. */
  severity: 'error' | 'warning' | 'info';
}

/** Aggregated result of all pre-flight checks. */
export interface PreflightReport {
  /** Overall pass/fail -- true only if all error-severity checks passed. */
  passed: boolean;
  /** Individual check results. */
  checks: CheckResult[];
  /** Device info gathered during checks. */
  deviceInfo: DeviceInfo;
  /** Recommended installation path based on firmware. */
  installationPath: InstallationPath;
  /** Whether the device uses the v6 .rm file format. */
  usesV6Format: boolean;
  /** Resource budget for this device model. */
  resourceBudget: ResourceBudget;
  /** Whether the bundled Entware/Syncthing installer may run on this device now. */
  automaticSyncthingInstallReady: boolean;
  /** ISO timestamp of when the check was performed. */
  timestamp: string;
}

interface InstallationBudgetCheck {
  result: CheckResult;
  meetsInstallationBudget: boolean;
}

/**
 * Run all pre-flight checks against a connected reMarkable.
 *
 * @param deviceInfo - Previously gathered device information.
 * @param ssh - Active SSH connection for additional checks.
 */
export async function runPreflightChecks(
  deviceInfo: DeviceInfo,
  ssh: SSHExecutor,
): Promise<PreflightReport> {
  logger.info('Running pre-flight checks...');

  const checks: CheckResult[] = [];
  const budget = DEFAULT_RESOURCE_BUDGETS[deviceInfo.model];

  // 1. Firmware compatibility
  checks.push(checkFirmwareCompatibility(deviceInfo));

  // Determine whether this hardware has a supported installer route. Resource
  // checks remain non-fatal for SFTP and expose separate installer readiness.
  let installationPath: InstallationPath;
  try {
    installationPath = getInstallationPath(deviceInfo.firmware, deviceInfo.architecture);
    if (
      installationPath === 'entware'
      && !isKnownLegacyInstallerTarget(deviceInfo.model, deviceInfo.architecture)
    ) {
      installationPath = 'sftp-only';
    }
  } catch {
    installationPath = 'sftp-only'; // Safe fallback: never guess a package architecture
    checks.push({
      name: 'Installation Path',
      passed: false,
      message: `Cannot determine installation path for firmware ${deviceInfo.firmware.raw}.`,
      severity: 'error',
    });
  }
  // 2. Available memory
  const memoryCheck = checkAvailableMemory(deviceInfo, budget);
  checks.push(memoryCheck.result);

  // 3. Storage on /home partition
  const homeStorageCheck = checkHomeStorage(deviceInfo, budget);
  checks.push(homeStorageCheck.result);

  // 4. Root partition safety (must not be nearly full)
  const rootPartitionCheck = checkRootPartition(deviceInfo);
  checks.push(rootPartitionCheck.result);

  // 5. xochitl data directory exists
  checks.push(await checkXochitlDirectory(ssh));

  // 6. Device model identification
  checks.push(checkDeviceModel(deviceInfo));

  if (installationPath === 'sftp-only') {
    checks.push({
      name: 'Automatic Syncthing Installation',
      passed: true,
      message: 'SFTP is supported. Automatic Syncthing installation is unavailable for this architecture.',
      severity: 'warning',
    });
  }

  const passed = checks.every(c => c.severity !== 'error' || c.passed);
  const automaticSyncthingInstallReady =
    passed
    && installationPath === 'entware'
    && memoryCheck.meetsInstallationBudget
    && homeStorageCheck.meetsInstallationBudget
    && rootPartitionCheck.meetsInstallationBudget;

  const report: PreflightReport = {
    passed,
    checks,
    deviceInfo,
    installationPath,
    usesV6Format: usesV6FileFormat(deviceInfo.firmware),
    resourceBudget: budget,
    automaticSyncthingInstallReady,
    timestamp: new Date().toISOString(),
  };

  logger.info(`Pre-flight checks ${passed ? 'PASSED' : 'FAILED'}: ${checks.filter(c => c.passed).length}/${checks.length} checks passed`);
  return report;
}

function checkFirmwareCompatibility(deviceInfo: DeviceInfo): CheckResult {
  const fw = deviceInfo.firmware;
  const warning = getFirmwareCompatibilityWarning(fw);

  if (fw.major < 2 || (fw.major === 2 && fw.minor < 6)) {
    return {
      name: 'Firmware Version',
      passed: false,
      message: `Firmware ${fw.raw} is below the minimum supported version (2.6.x.x). Please update your firmware.`,
      severity: 'error',
    };
  }

  if (warning) {
    return {
      name: 'Firmware Version',
      passed: true,
      message: warning,
      severity: 'warning',
    };
  }

  return {
    name: 'Firmware Version',
    passed: true,
    message: `Firmware ${fw.raw} is in the supported range.`,
    severity: 'info',
  };
}

function checkAvailableMemory(
  deviceInfo: DeviceInfo,
  budget: ResourceBudget,
): InstallationBudgetCheck {
  const available = deviceInfo.memory.availableMB;
  const required = budget.minFreeMemoryMB + budget.syncthingMaxMemoryMB;

  if (available < budget.minFreeMemoryMB) {
    return {
      result: {
        name: 'Available Memory',
        passed: true,
        message: `Only ${available}MB RAM available, below the ${budget.minFreeMemoryMB}MB legacy installation safety budget. ` +
          'SFTP-only setup can continue because it does not install or run Syncthing on the tablet; close open documents if the tablet becomes unstable.',
        severity: 'warning',
      },
      meetsInstallationBudget: false,
    };
  }

  if (available < required) {
    return {
      result: {
        name: 'Available Memory',
        passed: true,
        message: `${available}MB RAM available. This is enough for basic operation, but Syncthing may need to be tightly constrained ` +
          `(budgeted ${budget.syncthingMaxMemoryMB}MB for sync). Memory will be monitored at runtime.`,
        severity: 'warning',
      },
      meetsInstallationBudget: true,
    };
  }

  return {
    result: {
      name: 'Available Memory',
      passed: true,
      message: `${available}MB RAM available (${deviceInfo.memory.totalMB}MB total). Sufficient for sync operations.`,
      severity: 'info',
    },
    meetsInstallationBudget: true,
  };
}

function checkHomeStorage(
  deviceInfo: DeviceInfo,
  budget: ResourceBudget,
): InstallationBudgetCheck {
  const homePartition = deviceInfo.storage.find(s => s.mountPoint === '/home');

  if (!homePartition) {
    return {
      result: {
        name: '/home Storage',
        passed: false,
        message: 'Could not find /home partition. Tablet documents and legacy package data are expected under /home.',
        severity: 'error',
      },
      meetsInstallationBudget: false,
    };
  }

  if (homePartition.availableMB < budget.minFreeStorageMB) {
    return {
      result: {
        name: '/home Storage',
        passed: true,
        message: `Only ${homePartition.availableMB}MB free on /home, below the ${budget.minFreeStorageMB}MB legacy installation budget. ` +
          'SFTP-only setup can continue because it installs no tablet packages, but free space before adding or syncing more documents.',
        severity: 'warning',
      },
      meetsInstallationBudget: false,
    };
  }

  return {
    result: {
      name: '/home Storage',
      passed: true,
      message: `${homePartition.availableMB}MB free on /home (${homePartition.usagePercent}% used). Sufficient for sync operations.`,
      severity: 'info',
    },
    meetsInstallationBudget: true,
  };
}

function checkRootPartition(deviceInfo: DeviceInfo): InstallationBudgetCheck {
  const rootPartition = deviceInfo.storage.find(s => s.mountPoint === '/');

  if (!rootPartition) {
    return {
      result: {
        name: 'Root Partition',
        passed: true,
        message: 'Could not read root partition info. This is non-critical for SFTP; the legacy Entware installer does create root-filesystem mount configuration.',
        severity: 'warning',
      },
      meetsInstallationBudget: false,
    };
  }

  // SFTP does not write package files, but the legacy installer creates a
  // small mount configuration on root and should not run when it is full.
  if (rootPartition.usagePercent > 95) {
    return {
      result: {
        name: 'Root Partition',
        passed: true,
        message: `Root partition is ${rootPartition.usagePercent}% full (${rootPartition.availableMB}MB free). ` +
          'SFTP can still operate, but do not run the legacy Entware installer until space is available.',
        severity: 'warning',
      },
      meetsInstallationBudget: false,
    };
  }

  return {
    result: {
      name: 'Root Partition',
      passed: true,
      message: `Root partition: ${rootPartition.availableMB}MB free (${rootPartition.usagePercent}% used).`,
      severity: 'info',
    },
    meetsInstallationBudget: true,
  };
}

async function checkXochitlDirectory(ssh: SSHExecutor): Promise<CheckResult> {
  const result = await ssh.execute(`test -d ${XOCHITL_DATA_PATH} && echo "exists" || echo "missing"`);

  if (result.stdout.trim() === 'exists') {
    return {
      name: 'xochitl Data Directory',
      passed: true,
      message: `Document directory found at ${XOCHITL_DATA_PATH}.`,
      severity: 'info',
    };
  }

  return {
    name: 'xochitl Data Directory',
    passed: false,
    message: `Document directory not found at ${XOCHITL_DATA_PATH}. ` +
      'This is where reMarkable stores documents. The device may not be a reMarkable or xochitl has not been initialized.',
    severity: 'error',
  };
}

function checkDeviceModel(deviceInfo: DeviceInfo): CheckResult {
  if (deviceInfo.model === 'unknown') {
    return {
      name: 'Device Model',
      passed: true,
      message: 'Could not determine exact device model. The bridge will use conservative resource limits.',
      severity: 'warning',
    };
  }

  const modelLabels: Record<string, string> = {
    reMarkable1: 'reMarkable 1 (512MB RAM, ARM Cortex-A9)',
    reMarkable2: 'reMarkable 2 (1GB RAM, ARM Cortex-A7)',
    paperPro: 'reMarkable Paper Pro (2GB RAM, AArch64)',
    paperProMove: 'reMarkable Paper Pro Move (2GB RAM, AArch64)',
    paperPure: 'reMarkable Paper Pure (2GB RAM, AArch64)',
  };

  return {
    name: 'Device Model',
    passed: true,
    message: `Detected: ${modelLabels[deviceInfo.model] ?? deviceInfo.model}; architecture ${deviceInfo.architecture}. Resource budgets configured accordingly.`,
    severity: 'info',
  };
}

/**
 * Format a preflight report as a human-readable string.
 *
 * Used for display in the setup wizard and logging.
 */
export function formatPreflightReport(report: PreflightReport): string {
  const lines: string[] = [];

  lines.push(`=== Pre-flight Check Report ===`);
  lines.push(`Time: ${report.timestamp}`);
  lines.push(`Overall: ${report.passed ? 'PASS' : 'FAIL'}`);
  lines.push('');

  lines.push(`Device: ${report.deviceInfo.model}`);
  lines.push(`Architecture: ${report.deviceInfo.architecture}`);
  lines.push(`Firmware: ${report.deviceInfo.firmware.raw}`);
  lines.push(`File Format: ${report.usesV6Format ? 'v6 (rmscene)' : 'Legacy (v3/v5)'}`);
  lines.push(`Installation Path: ${report.installationPath}`);
  lines.push(`Automatic Syncthing Install: ${report.automaticSyncthingInstallReady ? 'READY' : 'BLOCKED'}`);
  lines.push(`Kernel: ${report.deviceInfo.kernelVersion}`);
  lines.push('');

  lines.push('--- Checks ---');
  for (const check of report.checks) {
    const icon = check.passed ? '[PASS]' : (check.severity === 'error' ? '[FAIL]' : '[WARN]');
    lines.push(`${icon} ${check.name}: ${check.message}`);
  }

  return lines.join('\n');
}
