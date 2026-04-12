export {
  detectFirmwareVersion,
  detectDeviceModel,
  detectMemoryInfo,
  detectStorageInfo,
  detectDeviceInfo,
  XOCHITL_DATA_PATH,
} from './detector';

export {
  parseFirmwareVersion,
  compareFirmwareVersions,
  getInstallationPath,
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
