/**
 * Firmware version parsing and compatibility checking.
 *
 * reMarkable firmware versions follow the pattern: major.minor.patch.build
 * e.g., "3.26.0.68"
 *
 * Compatibility routing (per spec):
 * - Firmware 2.6 to 3.3: Toltec path (package manager available)
 * - Firmware 3.4+: Entware-only path (Toltec incompatible)
 * - Firmware < 2.6: unsupported
 */

import { FirmwareVersion } from '../types/device';
import { BridgeError, ErrorCode } from '../types/errors';

/** Regex for reMarkable firmware version strings. */
const FIRMWARE_REGEX = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

/** Minimum supported firmware version. */
const MIN_FIRMWARE = { major: 2, minor: 6 };

/** Firmware threshold where Toltec stops working and Entware is required. */
const ENTWARE_ONLY_THRESHOLD = { major: 3, minor: 4 };

/** Firmware version where v6 .rm file format was introduced. */
const V6_FORMAT_THRESHOLD = { major: 3, minor: 0 };

/**
 * Parse a raw firmware version string into a structured object.
 *
 * @param raw - Version string like "3.26.0.68"
 * @throws BridgeError if the string doesn't match the expected format.
 */
export function parseFirmwareVersion(raw: string): FirmwareVersion {
  const trimmed = raw.trim();
  const match = trimmed.match(FIRMWARE_REGEX);

  if (!match) {
    throw new BridgeError(
      ErrorCode.FIRMWARE_PARSE_FAILED,
      `Cannot parse firmware version: "${trimmed}". Expected format: X.Y.Z.B (e.g., 3.26.0.68).`,
      'This may not be a reMarkable device, or the firmware version format has changed.',
    );
  }

  return {
    raw: trimmed,
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    build: parseInt(match[4], 10),
  };
}

/**
 * Compare two firmware versions.
 *
 * @returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareFirmwareVersions(a: FirmwareVersion, b: FirmwareVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return a.build - b.build;
}

/** Which installation path to use based on firmware version. */
export type InstallationPath = 'toltec' | 'entware';

/**
 * Determine the installation path for a given firmware version.
 *
 * @throws BridgeError if the firmware is too old to support.
 */
export function getInstallationPath(firmware: FirmwareVersion): InstallationPath {
  if (firmware.major < MIN_FIRMWARE.major ||
      (firmware.major === MIN_FIRMWARE.major && firmware.minor < MIN_FIRMWARE.minor)) {
    throw new BridgeError(
      ErrorCode.FIRMWARE_UNSUPPORTED,
      `Firmware ${firmware.raw} is below the minimum supported version (2.6.x.x).`,
      'Consider updating your firmware. You can use codexctl to manage firmware versions.',
    );
  }

  if (firmware.major > ENTWARE_ONLY_THRESHOLD.major ||
      (firmware.major === ENTWARE_ONLY_THRESHOLD.major && firmware.minor >= ENTWARE_ONLY_THRESHOLD.minor)) {
    return 'entware';
  }

  return 'toltec';
}

/**
 * Check whether the device uses the v6 .rm file format.
 *
 * Firmware 3.0+ uses the new scene-based format parsed by rmscene.
 * Earlier versions use the legacy v3/v5 binary .lines format.
 */
export function usesV6FileFormat(firmware: FirmwareVersion): boolean {
  return firmware.major > V6_FORMAT_THRESHOLD.major ||
    (firmware.major === V6_FORMAT_THRESHOLD.major && firmware.minor >= V6_FORMAT_THRESHOLD.minor);
}

/**
 * Check whether the firmware is in the known-good range.
 *
 * Returns a warning message if the firmware is untested, or null if it's known-good.
 */
export function getFirmwareCompatibilityWarning(firmware: FirmwareVersion): string | null {
  // Known-good range per spec: 3.0 through 3.26.x
  if (firmware.major === 3 && firmware.minor <= 26) {
    return null;
  }

  if (firmware.major > 3 || (firmware.major === 3 && firmware.minor > 26)) {
    return `Firmware ${firmware.raw} is newer than the tested range (up to 3.26.x). ` +
      'The bridge should still work, but some features may behave unexpectedly. ' +
      'Please report any issues.';
  }

  // Very old firmware
  return `Firmware ${firmware.raw} is older than the primary target range. ` +
    'Basic functionality should work, but some features may be limited.';
}
