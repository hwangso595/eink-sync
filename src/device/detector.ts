/**
 * Device detection: queries the reMarkable over SSH to identify model,
 * firmware, and resource availability.
 *
 * All detection is read-only -- we never write to the device in this module.
 * This aligns with the "Read-only SSH testing" tier in the Safe Testing Strategy.
 */

import { SSHExecutor } from '../ssh/ssh-client';
import {
  DeviceModel,
  FirmwareVersion,
  MemoryInfo,
  StorageInfo,
  DeviceInfo,
} from '../types/device';
import { BridgeError, ErrorCode } from '../types/errors';
import { parseFirmwareVersion } from './firmware';
import { logger } from '../utils/logger';

/** Path where reMarkable stores its version string. */
const FIRMWARE_VERSION_PATH = '/etc/version';
const UPDATE_CONF_PATH = '/usr/share/remarkable/update.conf';

/** Path to the device model file on reMarkable. */
const DEVICE_MODEL_PATH = '/sys/devices/soc0/machine';

/** Fallback: check the device tree compatible string. */
const DEVICE_TREE_COMPATIBLE_PATH = '/proc/device-tree/compatible';

/** Path where xochitl stores documents. */
export const XOCHITL_DATA_PATH = '/home/root/.local/share/remarkable/xochitl';

/** RAM threshold for rM1 detection (rM1 has 512MB, well under this). */
const RM1_MAX_RAM_MB = 600;

/** RAM threshold for rM2 detection (rM2 has 1GB, well under this). */
const RM2_MAX_RAM_MB = 1200;

/**
 * Detect the reMarkable's firmware version.
 *
 * Reads /etc/version which contains the raw version string.
 */
export async function detectFirmwareVersion(ssh: SSHExecutor): Promise<FirmwareVersion> {
  // Try update.conf first — contains REMARKABLE_RELEASE_VERSION=X.Y.Z.B
  const confResult = await ssh.execute(
    `grep REMARKABLE_RELEASE_VERSION ${UPDATE_CONF_PATH} 2>/dev/null | cut -d= -f2`
  );
  if (confResult.exitCode === 0 && confResult.stdout.trim()) {
    const version = confResult.stdout.trim();
    try {
      return parseFirmwareVersion(version);
    } catch {
      // Fall through to /etc/version
    }
  }

  // Fallback to /etc/version (may be a build timestamp on newer firmware)
  const result = await ssh.execute(`cat ${FIRMWARE_VERSION_PATH}`);

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new BridgeError(
      ErrorCode.FIRMWARE_PARSE_FAILED,
      `Could not read firmware version from ${UPDATE_CONF_PATH} or ${FIRMWARE_VERSION_PATH}.`,
      'This device may not be a reMarkable tablet.',
    );
  }

  return parseFirmwareVersion(result.stdout.trim());
}

/**
 * Detect the device model (rM1 vs rM2).
 *
 * Tries /sys/devices/soc0/machine first, falls back to /proc/device-tree/compatible,
 * and finally to RAM-based heuristic (rM1 = 512MB, rM2 = 1GB).
 */
export async function detectDeviceModel(ssh: SSHExecutor): Promise<DeviceModel> {
  // Try the machine file first
  const machineResult = await ssh.execute(`cat ${DEVICE_MODEL_PATH} 2>/dev/null`);
  if (machineResult.exitCode === 0 && machineResult.stdout.trim()) {
    return parseModelString(machineResult.stdout.trim());
  }

  // Fallback: device tree compatible string
  const dtResult = await ssh.execute(`cat ${DEVICE_TREE_COMPATIBLE_PATH} 2>/dev/null`);
  if (dtResult.exitCode === 0 && dtResult.stdout) {
    return parseModelString(dtResult.stdout);
  }

  // Last resort: RAM-based heuristic
  logger.warn('Could not read device model file, falling back to RAM-based detection');
  const memInfo = await detectMemoryInfo(ssh);
  if (memInfo.totalMB < RM1_MAX_RAM_MB) {
    return 'reMarkable1';
  } else if (memInfo.totalMB < RM2_MAX_RAM_MB) {
    return 'reMarkable2';
  }

  return 'unknown';
}

/**
 * Parse a model identification string into our enum.
 */
function parseModelString(raw: string): DeviceModel {
  const lower = raw.toLowerCase();

  // rM1: "reMarkable 1.0", "reMarkable Prototype 1"
  // The machine file typically contains "reMarkable 1.0" or "reMarkable 2.0"
  if (lower.includes('remarkable') && (lower.includes('1') || lower.includes('prototype'))) {
    return 'reMarkable1';
  }

  if (lower.includes('remarkable') && lower.includes('2')) {
    return 'reMarkable2';
  }

  if (lower.includes('remarkable')) {
    // It's a reMarkable but we can't tell which generation
    logger.warn(`Recognized as reMarkable but unknown generation: "${raw}"`);
    return 'unknown';
  }

  logger.warn(`Device model string not recognized as reMarkable: "${raw}"`);
  return 'unknown';
}

/**
 * Read memory information from /proc/meminfo.
 */
export async function detectMemoryInfo(ssh: SSHExecutor): Promise<MemoryInfo> {
  const result = await ssh.execute('cat /proc/meminfo');

  if (result.exitCode !== 0) {
    throw new BridgeError(
      ErrorCode.PREFLIGHT_CHECK_FAILED,
      'Could not read memory information from the device.',
    );
  }

  const lines = result.stdout.split('\n');
  const values: Record<string, number> = {};

  for (const line of lines) {
    const match = line.match(/^(\w+):\s+(\d+)\s+kB/);
    if (match) {
      values[match[1]] = parseInt(match[2], 10);
    }
  }

  const totalKB = values['MemTotal'] ?? 0;
  const availableKB = values['MemAvailable'] ?? values['MemFree'] ?? 0;

  return {
    totalMB: Math.round(totalKB / 1024),
    availableMB: Math.round(availableKB / 1024),
    usedMB: Math.round((totalKB - availableKB) / 1024),
  };
}

/**
 * Read storage information for a given mount point using df.
 */
export async function detectStorageInfo(
  ssh: SSHExecutor,
  mountPoint: string,
): Promise<StorageInfo> {
  // Use df with 1M block size for MB values
  const result = await ssh.execute(`df -m ${mountPoint} | tail -1`);

  if (result.exitCode !== 0) {
    throw new BridgeError(
      ErrorCode.PREFLIGHT_CHECK_FAILED,
      `Could not read storage information for ${mountPoint}.`,
    );
  }

  // df output: Filesystem 1M-blocks Used Available Use% Mounted on
  const parts = result.stdout.trim().split(/\s+/);
  if (parts.length < 6) {
    throw new BridgeError(
      ErrorCode.PREFLIGHT_CHECK_FAILED,
      `Unexpected df output format for ${mountPoint}: "${result.stdout}"`,
    );
  }

  const totalMB = parseInt(parts[1], 10);
  const usedMB = parseInt(parts[2], 10);
  const availableMB = parseInt(parts[3], 10);
  const usagePercent = parseInt(parts[4].replace('%', ''), 10);

  return {
    mountPoint,
    totalMB: isNaN(totalMB) ? 0 : totalMB,
    usedMB: isNaN(usedMB) ? 0 : usedMB,
    availableMB: isNaN(availableMB) ? 0 : availableMB,
    usagePercent: isNaN(usagePercent) ? 0 : usagePercent,
  };
}

/**
 * Gather complete device information in a single call.
 *
 * This runs all detection queries and assembles a DeviceInfo object.
 * All operations are read-only.
 */
export async function detectDeviceInfo(ssh: SSHExecutor): Promise<DeviceInfo> {
  logger.info('Starting device detection...');

  const firmware = await detectFirmwareVersion(ssh);
  logger.info(`Firmware: ${firmware.raw}`);

  const model = await detectDeviceModel(ssh);
  logger.info(`Model: ${model}`);

  const memory = await detectMemoryInfo(ssh);
  logger.info(`Memory: ${memory.totalMB}MB total, ${memory.availableMB}MB available`);

  // Get storage for both root and /home partitions
  const rootStorage = await detectStorageInfo(ssh, '/');
  const homeStorage = await detectStorageInfo(ssh, '/home');
  logger.info(`Storage /home: ${homeStorage.availableMB}MB free`);

  // Kernel version
  const unameResult = await ssh.execute('uname -r');
  const kernelVersion = unameResult.exitCode === 0 ? unameResult.stdout.trim() : 'unknown';

  // Serial number (optional, may not be readable)
  let serialNumber: string | null = null;
  const serialResult = await ssh.execute('cat /sys/devices/soc0/serial_number 2>/dev/null');
  if (serialResult.exitCode === 0 && serialResult.stdout.trim()) {
    serialNumber = serialResult.stdout.trim();
  }

  const deviceInfo: DeviceInfo = {
    model,
    firmware,
    memory,
    storage: [rootStorage, homeStorage],
    kernelVersion,
    serialNumber,
  };

  logger.info('Device detection complete');
  return deviceInfo;
}
