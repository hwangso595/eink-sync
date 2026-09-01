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
  DeviceArchitecture,
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
const OS_RELEASE_PATH = '/etc/os-release';

/**
 * Where the release version can be read, best source first.
 *
 * update.conf is absent on some models, and /etc/version holds a build timestamp
 * on firmware 3.x -- so all three are tried in order.
 */
const FIRMWARE_SOURCES: ReadonlyArray<{ label: string; command: string }> = [
  {
    label: `${UPDATE_CONF_PATH} (REMARKABLE_RELEASE_VERSION)`,
    command: `. ${UPDATE_CONF_PATH} 2>/dev/null && echo "$REMARKABLE_RELEASE_VERSION"`,
  },
  {
    label: `${OS_RELEASE_PATH} (IMG_VERSION)`,
    command: `. ${OS_RELEASE_PATH} 2>/dev/null && echo "$IMG_VERSION"`,
  },
  {
    label: FIRMWARE_VERSION_PATH,
    command: `cat ${FIRMWARE_VERSION_PATH} 2>/dev/null`,
  },
];

/** Path to the device model file on reMarkable. */
const DEVICE_MODEL_PATH = '/sys/devices/soc0/machine';

/** Newer tablets also expose a human-readable device-tree model. */
const DEVICE_TREE_MODEL_PATH = '/proc/device-tree/model';

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
 * Tries each source in FIRMWARE_SOURCES and uses the first that yields a parsable
 * version. Every rejected source is logged so a miss is never silent.
 */
export async function detectFirmwareVersion(ssh: SSHExecutor): Promise<FirmwareVersion> {
  const attempts: string[] = [];

  for (const source of FIRMWARE_SOURCES) {
    const result = await ssh.execute(source.command);
    const value = result.stdout.trim();

    if (result.exitCode !== 0 || !value) {
      attempts.push(`${source.label}: not present`);
      continue;
    }

    try {
      const firmware = parseFirmwareVersion(value);
      logger.info(`Firmware version ${value} read from ${source.label}`);
      return firmware;
    } catch (err) {
      // A source that exists but holds a non-version is worth surfacing even
      // when a later source succeeds.
      const reason = err instanceof Error ? err.message : String(err);
      attempts.push(`${source.label}: ${reason}`);
      logger.warn(`Firmware source ${source.label}: ${reason}`);
    }
  }

  throw new BridgeError(
    ErrorCode.FIRMWARE_PARSE_FAILED,
    ['Could not read a firmware version from the device.', ...attempts].join('\n'),
    'This device may not be a reMarkable tablet, or the firmware version format has changed. ' +
      'Please report this along with the lines above.',
  );
}

/**
 * Detect the device model across every released reMarkable generation.
 *
 * Tries the human-readable machine/model sources first, then the compatible
 * string, and finally a RAM heuristic for the two legacy devices. Unknown
 * values never stop later, more specific sources from being checked.
 */
export async function detectDeviceModel(ssh: SSHExecutor): Promise<DeviceModel> {
  const identifiedModel = await detectDeviceModelIdentity(ssh);
  if (identifiedModel !== 'unknown') return identifiedModel;

  // Last resort: RAM-based heuristic
  logger.warn('Could not read device model file, falling back to RAM-based detection');
  try {
    const memInfo = await detectMemoryInfo(ssh);
    if (memInfo.totalMB > 0 && memInfo.totalMB < RM1_MAX_RAM_MB) {
      return 'reMarkable1';
    } else if (memInfo.totalMB > 0 && memInfo.totalMB < RM2_MAX_RAM_MB) {
      return 'reMarkable2';
    }
  } catch (err) {
    logger.warn(`RAM-based device detection unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  return 'unknown';
}

/**
 * Identify a model only from the tablet's explicit hardware identity files.
 *
 * Unlike {@link detectDeviceModel}, this deliberately does not infer a legacy
 * model from RAM size. Mutating legacy installer paths use this stricter result
 * so an unknown/future ARMv7 device can never be authorized by a memory guess.
 */
export async function detectDeviceModelIdentity(
  ssh: SSHExecutor,
): Promise<DeviceModel> {
  const sources = [DEVICE_MODEL_PATH, DEVICE_TREE_MODEL_PATH, DEVICE_TREE_COMPATIBLE_PATH];
  for (const source of sources) {
    const result = await ssh.execute(`cat ${source} 2>/dev/null`);
    if (result.exitCode !== 0 || !result.stdout.trim()) continue;

    const model = parseModelString(result.stdout);
    if (model !== 'unknown') return model;
  }

  return 'unknown';
}

/**
 * Parse a model identification string into our enum.
 */
function parseModelString(raw: string): DeviceModel {
  const lower = raw
    .toLowerCase()
    .replace(/\0/g, ' ')
    .replace(/[_,-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Current devices use internal codenames in their machine/device-tree data.
  // Check the most specific names first so words or digits in marketing names
  // cannot be mistaken for a legacy generation.
  if (lower.includes('chiappa') || /remarkable paper pro move/.test(lower)) {
    return 'paperProMove';
  }
  if (lower.includes('tatsu') || /remarkable paper (?:pro )?pure/.test(lower)) {
    return 'paperPure';
  }
  if (lower.includes('ferrari') || /remarkable paper pro/.test(lower)) {
    return 'paperPro';
  }

  // rM1: "reMarkable 1.0", "reMarkable Prototype 1"
  // The machine file typically contains "reMarkable 1.0" or "reMarkable 2.0"
  if (/remarkable (?:1(?:\.0)?|prototype 1)(?: |$)/.test(lower)) {
    return 'reMarkable1';
  }

  if (/remarkable ?2(?:\.0)?(?: |$)/.test(lower)) {
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

/** Detect and normalize the kernel architecture reported by uname. */
export async function detectDeviceArchitecture(
  ssh: SSHExecutor,
): Promise<DeviceArchitecture> {
  const result = await ssh.execute('uname -m');
  const raw = result.exitCode === 0 ? result.stdout.trim().toLowerCase() : '';

  if (raw === 'aarch64' || raw === 'arm64') return 'aarch64';
  if (/^armv7/.test(raw)) return 'armv7';

  logger.warn(`Device architecture not recognized: "${raw || 'unavailable'}"`);
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
  const result = await ssh.execute(`df -m ${mountPoint}`);

  if (result.exitCode !== 0) {
    throw new BridgeError(
      ErrorCode.PREFLIGHT_CHECK_FAILED,
      `Could not read storage information for ${mountPoint}.`,
    );
  }

  // Read from the right: a long filesystem source can wrap onto the preceding
  // line, leaving only Total/Used/Available/Use%/Mount on the final row.
  const parts = result.stdout.trim().split(/\s+/);
  if (parts.length < 5) {
    throw new BridgeError(
      ErrorCode.PREFLIGHT_CHECK_FAILED,
      `Unexpected df output format for ${mountPoint}: "${result.stdout}"`,
    );
  }

  // `df <path>` reports the containing filesystem's mount target, not the
  // queried path itself. For example, `/home` legitimately reports `/` when
  // a device keeps both directories on one filesystem.
  const [total, used, available, usage] = parts.slice(-5);
  const totalMB = parseInt(total, 10);
  const usedMB = parseInt(used, 10);
  const availableMB = parseInt(available, 10);
  const usageMatch = /^(\d+)%$/.exec(usage);
  const usagePercent = usageMatch ? parseInt(usageMatch[1], 10) : NaN;

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

  const architecture = await detectDeviceArchitecture(ssh);
  logger.info(`Architecture: ${architecture}`);

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
    architecture,
    firmware,
    memory,
    storage: [rootStorage, homeStorage],
    kernelVersion,
    serialNumber,
  };

  logger.info('Device detection complete');
  return deviceInfo;
}
