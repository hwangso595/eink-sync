export {
  detectFirmwareVersion,
  detectDeviceModel,
  detectDeviceModelIdentity,
  detectDeviceArchitecture,
  detectMemoryInfo,
  detectStorageInfo,
  detectDeviceInfo,
  XOCHITL_DATA_PATH,
} from './detector';

export {
  parseFirmwareVersion,
  compareFirmwareVersions,
  getInstallationPath,
  isKnownLegacyInstallerTarget,
  usesV6FileFormat,
  getFirmwareCompatibilityWarning,
} from './firmware';

export type { InstallationPath } from './firmware';

// Sprint 7: Firmware compatibility layer
export {
  runPostUpdateHealthCheck,
  formatHealthCheckReport,
} from './firmware-compat';
export type {
  HealthCheckItem,
  HealthCheckResult,
} from './firmware-compat';
