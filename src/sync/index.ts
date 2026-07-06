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

// Service manager (teardown only -- setup is done via Syncthing's own UI)
export { stopServices, removeServices } from './service-manager';

// Sync providers (unified abstraction over SFTP and Syncthing)
export type { SyncProvider, SyncResult, SyncProgressCallback } from './sync-provider';
export { SftpProvider } from './sftp-provider';
export { SyncthingProvider } from './syncthing-provider';

// SFTP sync engine
export { SftpSyncEngine } from './sftp-sync';
export type {
  SftpSyncOptions,
  SftpSyncResult,
  RemoteFileInfo,
  SftpProgressCallback,
} from './sftp-sync';
