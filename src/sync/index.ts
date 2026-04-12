// Sync types
export type {
  SyncMethod,
  SyncthingConfig,
  SyncSchedule,
  SyncConfig,
  SyncStatus,
} from './types';

export {
  XOCHITL_SYNC_PATH,
  ENTWARE_PATH,
  SYNCTHING_BIN_PATH,
  SYNCTHING_CONFIG_DIR,
  SYNCTHING_SERVICE_NAME,
  SYNCTHING_SERVICE_PATH,
  WATCHDOG_SERVICE_NAME,
  WATCHDOG_SERVICE_PATH,
  WATCHDOG_SCRIPT_PATH,
  SYNCTHING_LISTEN_PORT,
  SYNCTHING_GUI_PORT,
  RM1_MIN_FREE_RAM_MB,
  RM1_MAX_SYNCTHING_RSS_MB,
  createDefaultSyncConfig,
} from './types';

// Syncthing config generator
export {
  generateSyncthingConfig,
  generateApiKey,
  isValidDeviceId,
} from './syncthing-config';

// Installer
export {
  isEntwareInstalled,
  isSyncthingInstalled,
  getSyncthingVersion,
  installEntware,
  installSyncthing,
  installSyncStack,
} from './installer';
export type { InstallProgressCallback, InstallResult } from './installer';

// Service manager
export {
  generateSyncthingServiceUnit,
  generateWatchdogScript,
  generateWatchdogServiceUnit,
  deployServices,
  startServices,
  stopServices,
  isServiceRunning,
  getSyncthingMemoryUsage,
  removeServices,
} from './service-manager';

// Rsync fallback
export {
  isRsyncAvailable,
  buildRsyncArgs,
  buildRsyncCommand,
  getHostRsyncCommand,
  parseRsyncOutput,
  verifyRsyncCapability,
} from './rsync-fallback';
export type { RsyncResult, HostRsyncCommand } from './rsync-fallback';

// Sync manager (orchestrator)
export {
  recommendSyncMethod,
  setupSync,
  getSyncStatus,
  stopSync,
  restartSync,
} from './sync-manager';
export type { SetupProgressCallback, SyncSetupResult } from './sync-manager';

// SFTP sync engine
export { SftpSyncEngine } from './sftp-sync';
export type {
  SftpSyncOptions,
  SftpSyncResult,
  RemoteFileInfo,
  SftpProgressCallback,
} from './sftp-sync';
