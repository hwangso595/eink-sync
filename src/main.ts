/**
 * reMarkable-Obsidian Bridge: Main plugin entry point.
 *
 * Obsidian loads the default export from this module as the plugin class.
 * The plugin class is defined in ./plugin/plugin.ts and wires together
 * all Sprint 1-4 infrastructure.
 *
 * This module also re-exports the public API for programmatic use
 * and testing.
 */

// The default export must be the Plugin subclass for Obsidian to load.
export { default } from './plugin/plugin';

// Re-export plugin UI components
export { ReMarkableBridgeSettingTab } from './plugin/settings-tab';
export { SetupWizardModal } from './plugin/setup-wizard';
export { ReMarkableLibraryView, LIBRARY_VIEW_TYPE } from './plugin/library-view';
export { SyncStatusModal } from './plugin/sync-status-modal';
export { buildLibrary, sortDocuments, filterDocuments, buildSyncSummary } from './plugin/library-data';
export {
  buildReviewData,
  buildReviewSummary,
  applyReviewAction,
  renderAcceptedHighlights,
  parseHighlightsFromNote,
  generateHighlightId,
} from './plugin/review-data';
export type {
  ReMarkableBridgeSettings,
  PdfLinkFormat,
  ExtractionPreferences,
} from './plugin/settings';
export { DEFAULT_SETTINGS } from './plugin/settings';
export type {
  LibraryDocument,
  LibraryFolder,
  LibrarySyncSummary,
  DocumentSyncStatus,
  SortConfig,
  SortField,
  SortDirection,
} from './plugin/library-types';
export type {
  ReviewableHighlight,
  ReviewableDocument,
  ReviewSummary,
  PersistedReviewState,
  HighlightReviewStatus,
} from './plugin/review-types';
export { DEFAULT_REVIEW_STATE } from './plugin/review-types';

// Sprint 1: SSH and device detection
export { ReMarkableSSHClient } from './ssh/ssh-client';
export type { SSHExecutor } from './ssh/ssh-client';
export { connectAndVerify, testConnection } from './ssh/connection-manager';
export {
  detectFirmwareVersion,
  detectDeviceModel,
  detectDeviceInfo,
} from './device/detector';
export {
  parseFirmwareVersion,
  compareFirmwareVersions,
  getInstallationPath,
  usesV6FileFormat,
  getFirmwareCompatibilityWarning,
} from './device/firmware';
export {
  runPreflightChecks,
  formatPreflightReport,
} from './preflight/checks';
export {
  detectRmFormat,
  isFormatSupported,
  getParserForFormat,
} from './pipeline/format-detector';

// Sprint 2: File synchronization
export {
  generateSyncthingConfig,
  generateApiKey,
  isValidDeviceId,
  isEntwareInstalled,
  isSyncthingInstalled,
  getSyncthingVersion,
  installEntware,
  installSyncthing,
  installSyncStack,
  generateSyncthingServiceUnit,
  generateWatchdogScript,
  generateWatchdogServiceUnit,
  deployServices,
  startServices,
  stopServices,
  isServiceRunning,
  getSyncthingMemoryUsage,
  removeServices,
  isRsyncAvailable,
  buildRsyncArgs,
  buildRsyncCommand,
  getHostRsyncCommand,
  parseRsyncOutput,
  verifyRsyncCapability,
  recommendSyncMethod,
  setupSync,
  getSyncStatus,
  stopSync,
  restartSync,
  createDefaultSyncConfig,
  XOCHITL_SYNC_PATH,
  ENTWARE_PATH,
  SYNCTHING_BIN_PATH,
  SYNCTHING_CONFIG_DIR,
  SYNCTHING_SERVICE_NAME,
} from './sync';

// Sprint 3: PDF highlight extraction pipeline
export {
  discoverDocuments,
  XochitlDocumentDiscovery,
  runPythonExtraction,
  resolveScriptPath,
  detectPythonPath,
  checkPythonDependencies,
  renderMarkdown,
  mergeWithExistingNote,
  generateOutputFilename,
  DefaultMarkdownRenderer,
  HIGHLIGHTS_SECTION_START,
  HIGHLIGHTS_SECTION_END,
  runExtractionPipeline,
} from './pipeline';

// Sprint 6: Template engine
export {
  renderTemplate,
  buildTemplateContext,
  formatPdfLink,
  validateTemplate,
  TemplateMarkdownRenderer,
  DEFAULT_TEMPLATE,
} from './pipeline/template-engine';
export type {
  TemplateContext,
  HighlightTemplateContext,
} from './pipeline/template-engine';

// Re-export types
export type { CommandResult } from './ssh/ssh-client';
export type { ConnectionResult, ProgressCallback } from './ssh/connection-manager';
export type {
  DeviceModel,
  FirmwareVersion,
  MemoryInfo,
  StorageInfo,
  DeviceInfo,
  ResourceBudget,
} from './types/device';
export type {
  ConnectionMethod,
  SSHConfig,
  BridgeConfig,
} from './types/config';
export type {
  CheckResult,
  PreflightReport,
} from './preflight/checks';
export type {
  RmFileFormat,
  DocumentType,
  ReMarkableDocument,
  ExtractedHighlight,
  ExtractionResult,
  PipelineConfig,
} from './pipeline/types';
export type {
  SyncMethod,
  SyncthingConfig,
  SyncSchedule,
  SyncConfig,
  SyncStatus,
} from './sync';
export type {
  InstallProgressCallback,
  InstallResult,
} from './sync';
export type {
  RsyncResult,
  HostRsyncCommand,
} from './sync';
export type {
  SetupProgressCallback,
  SyncSetupResult,
} from './sync';
export type {
  PythonExtractionOutput,
  PythonDocumentResult,
  PythonHighlight,
  ExtractionOptions,
} from './pipeline';
export type {
  PipelineRunResult,
  DocumentPipelineResult,
  PipelineProgressCallback,
} from './pipeline';

export { BridgeError, ErrorCode } from './types/errors';
export { DEFAULT_SSH_CONFIG, DEFAULT_BRIDGE_CONFIG } from './types/config';
export { DEFAULT_RESOURCE_BUDGETS } from './types/device';
