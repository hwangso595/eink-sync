/**
 * Core type definitions for reMarkable device interactions.
 *
 * These types model the tablet's identity, firmware, and resource state
 * as reported over SSH. They are used across SSH, preflight, and pipeline modules.
 */

/** Supported reMarkable hardware generations. */
export type DeviceModel = 'reMarkable1' | 'reMarkable2' | 'unknown';

/** Parsed semantic firmware version. */
export interface FirmwareVersion {
  /** Raw version string as read from the device, e.g. "3.26.0.68". */
  raw: string;
  /** Major version number (e.g. 3). */
  major: number;
  /** Minor version number (e.g. 26). */
  minor: number;
  /** Patch version number (e.g. 0). */
  patch: number;
  /** Build number (e.g. 68). */
  build: number;
}

/** Memory statistics in megabytes. */
export interface MemoryInfo {
  /** Total physical RAM in MB. */
  totalMB: number;
  /** Available (free + buffers/cache) RAM in MB. */
  availableMB: number;
  /** RAM currently used by processes in MB. */
  usedMB: number;
}

/** Storage statistics for a single partition, in megabytes. */
export interface StorageInfo {
  /** Mount point path, e.g. "/home". */
  mountPoint: string;
  /** Total partition size in MB. */
  totalMB: number;
  /** Used space in MB. */
  usedMB: number;
  /** Available space in MB. */
  availableMB: number;
  /** Usage as a percentage (0-100). */
  usagePercent: number;
}

/** Aggregated device information gathered during connection. */
export interface DeviceInfo {
  model: DeviceModel;
  firmware: FirmwareVersion;
  memory: MemoryInfo;
  /** Storage info for relevant partitions (root and /home). */
  storage: StorageInfo[];
  /** Kernel version string from uname. */
  kernelVersion: string;
  /** Device serial number if available. */
  serialNumber: string | null;
}

/**
 * Resource budget thresholds, tuned per device generation.
 *
 * rM1 (512 MB) gets tighter limits than rM2 (1 GB).
 */
export interface ResourceBudget {
  /** Maximum RSS memory for Syncthing in MB. */
  syncthingMaxMemoryMB: number;
  /** Minimum free RAM before pausing sync in MB. */
  minFreeMemoryMB: number;
  /** Minimum free storage on /home before warning in MB. */
  minFreeStorageMB: number;
}

/** Default resource budgets per device model, per spec. */
export const DEFAULT_RESOURCE_BUDGETS: Record<DeviceModel, ResourceBudget> = {
  reMarkable1: {
    syncthingMaxMemoryMB: 64,
    minFreeMemoryMB: 100,
    minFreeStorageMB: 50,
  },
  reMarkable2: {
    syncthingMaxMemoryMB: 128,
    minFreeMemoryMB: 200,
    minFreeStorageMB: 50,
  },
  unknown: {
    syncthingMaxMemoryMB: 64,
    minFreeMemoryMB: 100,
    minFreeStorageMB: 50,
  },
};
