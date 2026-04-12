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
  /** ISO timestamp of when the check was performed. */
  timestamp: string;
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

  // 2. Available memory
  checks.push(checkAvailableMemory(deviceInfo, budget));

  // 3. Storage on /home partition
  checks.push(checkHomeStorage(deviceInfo, budget));

  // 4. Root partition safety (must not be nearly full)
  checks.push(checkRootPartition(deviceInfo));

  // 5. xochitl data directory exists
  checks.push(await checkXochitlDirectory(ssh));

  // 6. Device model identification
  checks.push(checkDeviceModel(deviceInfo));

  // Determine installation path (may throw for truly unsupported firmware)
  let installationPath: InstallationPath;
  try {
    installationPath = getInstallationPath(deviceInfo.firmware);
  } catch {
    installationPath = 'entware'; // Default fallback
    checks.push({
      name: 'Installation Path',
      passed: false,
      message: `Cannot determine installation path for firmware ${deviceInfo.firmware.raw}.`,
      severity: 'error',
    });
  }

  const passed = checks.every(c => c.severity !== 'error' || c.passed);

  const report: PreflightReport = {
    passed,
    checks,
    deviceInfo,
    installationPath,
    usesV6Format: usesV6FileFormat(deviceInfo.firmware),
    resourceBudget: budget,
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

function checkAvailableMemory(deviceInfo: DeviceInfo, budget: ResourceBudget): CheckResult {
  const available = deviceInfo.memory.availableMB;
  const required = budget.minFreeMemoryMB + budget.syncthingMaxMemoryMB;

  if (available < budget.minFreeMemoryMB) {
    return {
      name: 'Available Memory',
      passed: false,
      message: `Only ${available}MB RAM available. The tablet needs at least ${budget.minFreeMemoryMB}MB free to operate safely. ` +
        'Close any open documents on the tablet and try again.',
      severity: 'error',
    };
  }

  if (available < required) {
    return {
      name: 'Available Memory',
      passed: true,
      message: `${available}MB RAM available. This is enough for basic operation, but Syncthing may need to be tightly constrained ` +
        `(budgeted ${budget.syncthingMaxMemoryMB}MB for sync). Memory will be monitored at runtime.`,
      severity: 'warning',
    };
  }

  return {
    name: 'Available Memory',
    passed: true,
    message: `${available}MB RAM available (${deviceInfo.memory.totalMB}MB total). Sufficient for sync operations.`,
    severity: 'info',
  };
}

function checkHomeStorage(deviceInfo: DeviceInfo, budget: ResourceBudget): CheckResult {
  const homePartition = deviceInfo.storage.find(s => s.mountPoint === '/home');

  if (!homePartition) {
    return {
      name: '/home Storage',
      passed: false,
      message: 'Could not find /home partition. All bridge components install to /home/root/ for safety.',
      severity: 'error',
    };
  }

  if (homePartition.availableMB < budget.minFreeStorageMB) {
    return {
      name: '/home Storage',
      passed: false,
      message: `Only ${homePartition.availableMB}MB free on /home (need at least ${budget.minFreeStorageMB}MB). ` +
        'Remove unused documents from the tablet to free space.',
      severity: 'error',
    };
  }

  return {
    name: '/home Storage',
    passed: true,
    message: `${homePartition.availableMB}MB free on /home (${homePartition.usagePercent}% used). Sufficient for installation.`,
    severity: 'info',
  };
}

function checkRootPartition(deviceInfo: DeviceInfo): CheckResult {
  const rootPartition = deviceInfo.storage.find(s => s.mountPoint === '/');

  if (!rootPartition) {
    return {
      name: 'Root Partition',
      passed: true,
      message: 'Could not read root partition info (non-critical -- we do not write to root).',
      severity: 'warning',
    };
  }

  // We don't write to root, but warn if it's dangerously full
  if (rootPartition.usagePercent > 95) {
    return {
      name: 'Root Partition',
      passed: true,
      message: `Root partition is ${rootPartition.usagePercent}% full (${rootPartition.availableMB}MB free). ` +
        'This is concerning but does not block installation since we only write to /home.',
      severity: 'warning',
    };
  }

  return {
    name: 'Root Partition',
    passed: true,
    message: `Root partition: ${rootPartition.availableMB}MB free (${rootPartition.usagePercent}% used).`,
    severity: 'info',
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
  };

  return {
    name: 'Device Model',
    passed: true,
    message: `Detected: ${modelLabels[deviceInfo.model] ?? deviceInfo.model}. Resource budgets configured accordingly.`,
    severity: 'warning',
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
  lines.push(`Firmware: ${report.deviceInfo.firmware.raw}`);
  lines.push(`File Format: ${report.usesV6Format ? 'v6 (rmscene)' : 'Legacy (v3/v5)'}`);
  lines.push(`Installation Path: ${report.installationPath}`);
  lines.push(`Kernel: ${report.deviceInfo.kernelVersion}`);
  lines.push('');

  lines.push('--- Checks ---');
  for (const check of report.checks) {
    const icon = check.passed ? '[PASS]' : (check.severity === 'error' ? '[FAIL]' : '[WARN]');
    lines.push(`${icon} ${check.name}: ${check.message}`);
  }

  return lines.join('\n');
}
