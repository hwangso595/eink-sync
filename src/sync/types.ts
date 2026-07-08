/**
 * Configuration types for the file synchronization layer.
 *
 * Supports two sync strategies:
 * - Syncthing: Continuous background sync via peer-to-peer protocol.
 * - Rsync: Lightweight fallback using rsync-over-SSH, suitable for rM1.
 *
 * Key constraints from the spec:
 * - No reMarkable Cloud: uses Syncthing with relays enabled (end-to-end encrypted) for cross-network sync
 * - One-directional: Send Only on tablet, Receive Only on host
 * - Memory: RSS under 64MB on rM1, pause if free RAM < 100MB
 * - All installs to /home/root/ only
 */

import type { DeviceModel, ResourceBudget } from '../types/device';

/** Which sync engine to use. */
export type SyncMethod = 'syncthing' | 'rsync';

/** Syncthing-specific configuration values. */
export interface SyncthingConfig {
  /** Device ID of the tablet's Syncthing instance. */
  tabletDeviceId: string;
  /** Device ID of the host's Syncthing instance. */
  hostDeviceId: string;
  /** API key for Syncthing REST calls (tablet-side). */
  tabletApiKey: string;
  /** TCP listen address on the tablet, e.g. "tcp://0.0.0.0:22000". */
  tabletListenAddress: string;
  /** TCP address the tablet uses to reach the host, e.g. "tcp://10.11.99.2:22000". */
  hostAddress: string;
  /** GUI listen address on tablet. Bound to localhost for safety. */
  guiListenAddress: string;
}

/** Schedule for batch sync (to preserve battery on the tablet). */
export interface SyncSchedule {
  /** Whether sync is currently enabled. */
  enabled: boolean;
  /** Interval in minutes between sync batches (0 = continuous). */
  intervalMinutes: number;
  /** Only sync when on WiFi (not just USB). */
  wifiOnly: boolean;
}

/** Full sync configuration combining method, schedule, and engine-specific settings. */
export interface SyncConfig {
  /** Active sync method. */
  method: SyncMethod;
  /** Path on the tablet to sync from (the xochitl data directory). */
  tabletSyncPath: string;
  /** Path on the host to sync to. */
  hostSyncPath: string;
  /** Sync schedule settings. */
  schedule: SyncSchedule;
  /** Syncthing-specific config (only used when method = 'syncthing'). */
  syncthing: SyncthingConfig | null;
  /** Device model this config targets (affects memory limits). */
  deviceModel: DeviceModel;
  /** Resource budget for the device (from preflight). */
  resourceBudget: ResourceBudget;
}

/** Default xochitl data path on the tablet. */
export const XOCHITL_SYNC_PATH = '/home/root/.local/share/remarkable/xochitl';

/** Default Entware install path on the tablet. */
export const ENTWARE_PATH = '/home/root/.entware';

/** Syncthing binary path when installed via Entware. */
export const SYNCTHING_BIN_PATH = '/home/root/.entware/bin/syncthing';

/** Syncthing config directory on the tablet. */
export const SYNCTHING_CONFIG_DIR = '/home/root/.config/syncthing';

/** Systemd service name for our Syncthing instance. */
export const SYNCTHING_SERVICE_NAME = 'eink-sync';

/** Systemd service file path. */
export const SYNCTHING_SERVICE_PATH = `/etc/systemd/system/${SYNCTHING_SERVICE_NAME}.service`;

/** Memory watchdog service name. */
export const WATCHDOG_SERVICE_NAME = 'eink-sync-watchdog';

/** Memory watchdog service file path. */
export const WATCHDOG_SERVICE_PATH = `/etc/systemd/system/${WATCHDOG_SERVICE_NAME}.service`;

/** Memory watchdog script path on the tablet. */
export const WATCHDOG_SCRIPT_PATH = '/home/root/.config/syncthing/memory-watchdog.sh';

/** Default listen port for Syncthing protocol. */
export const SYNCTHING_LISTEN_PORT = 22000;

/** Default GUI port for Syncthing. */
export const SYNCTHING_GUI_PORT = 8384;

/** Minimum free RAM (MB) below which sync is paused on rM1. */
export const RM1_MIN_FREE_RAM_MB = 100;

/** Maximum RSS memory (MB) for Syncthing on rM1. */
export const RM1_MAX_SYNCTHING_RSS_MB = 64;

/** Default sync config for a fresh setup. */
export function createDefaultSyncConfig(
  deviceModel: DeviceModel,
  resourceBudget: ResourceBudget,
  hostSyncPath: string,
): SyncConfig {
  return {
    method: 'syncthing',
    tabletSyncPath: XOCHITL_SYNC_PATH,
    hostSyncPath,
    schedule: {
      enabled: true,
      intervalMinutes: 5,
      wifiOnly: false,
    },
    syncthing: null,
    deviceModel,
    resourceBudget,
  };
}

/** Status of the sync engine at a point in time. */
export interface SyncStatus {
  /** Whether the sync engine is currently running. */
  running: boolean;
  /** Active sync method. */
  method: SyncMethod;
  /** Timestamp of last successful sync (epoch ms), or null if never synced. */
  lastSyncTimestamp: number | null;
  /** Number of files pending sync. */
  pendingFiles: number;
  /** Whether the tablet is reachable. */
  tabletReachable: boolean;
  /** Current memory usage of the sync process in MB, or null if not running. */
  syncProcessMemoryMB: number | null;
  /** Human-readable status message. */
  message: string;
}
