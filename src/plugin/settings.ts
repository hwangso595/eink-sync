/**
 * Plugin settings schema and defaults.
 *
 * ## Multi-Source Architecture
 *
 * The plugin supports extracting highlights from multiple reMarkable tablets
 * (or multiple sync origins) simultaneously. The data model works as follows:
 *
 * - **SyncSource[]** (`syncSources` in PluginData): Each entry represents one
 *   tablet/sync origin with its own `syncFolder`, `syncthingFolderId`, and
 *   per-source `lastExtractionTimestamps`. Sources are identified by a UUID `id`
 *   and displayed to the user via their `label`.
 *
 * - **Extraction flow**: `plugin.runExtraction()` iterates over all (or a
 *   filtered subset of) sync sources. For each source, `runExtractionForSource()`
 *   resolves the absolute xochitl path, determines the output folder (optionally
 *   using `highlightsSubfolder`), and invokes `runExtractionPipeline()`. Each
 *   source's extraction timestamp is updated independently.
 *
 * - **Backward compatibility**: Legacy top-level fields (`syncFolder`,
 *   `syncthingFolderId`, `lastExtractionTimestamps`, `syncFolderPathHash`) are
 *   always mirrored from `sources[0]` (the primary source). See
 *   `updateSyncSources()` in plugin.ts for the invariant.
 *
 * - **Library view**: Documents are tagged with `sourceId` and `sourceLabel`
 *   during library building. The sidebar provides a source filter dropdown
 *   when multiple sources are configured.
 *
 * Three configurable folder paths:
 *   syncFolder       — where Syncthing puts raw tablet files
 *   highlightsFolder — where extracted highlight notes go
 *   archiveFolder    — where archived documents are moved
 *
 * All default to the same parent folder "reMarkable/" with subfolders.
 */

import * as os from 'os';
import type { ConnectionMethod } from '../types/config';

/**
 * Return the device key used for per-device extraction timestamps.
 * Uses os.hostname() for a stable, human-readable identifier.
 */
export function getDeviceKey(): string {
  return os.hostname();
}

/**
 * Per-device state that is stored in a separate file (device-state-<hostname>.json)
 * to avoid Syncthing conflicts on data.json. Each device only writes its own
 * device state file, so no two devices ever touch the same file.
 */
export interface DeviceState {
  /** Per-source extraction timestamps, keyed by source ID. */
  sourceTimestamps: Record<string, number>;
  /** Per-source sync folder path hashes, keyed by source ID. */
  sourcePathHashes: Record<string, string>;
  /** Dismissed collision warning keys. */
  dismissedCollisions: string[];
}

/** Default (empty) device state. */
export const DEFAULT_DEVICE_STATE: DeviceState = {
  sourceTimestamps: {},
  sourcePathHashes: {},
  dismissedCollisions: [],
};

/**
 * Read the extraction timestamp for a source from device state.
 * Returns null if no timestamp has been recorded for this source.
 */
export function getSourceTimestamp(deviceState: DeviceState, sourceId: string): number | null {
  return deviceState.sourceTimestamps[sourceId] ?? null;
}

/**
 * Set the extraction timestamp for a source in device state.
 */
export function setSourceTimestamp(deviceState: DeviceState, sourceId: string, timestamp: number): void {
  deviceState.sourceTimestamps[sourceId] = timestamp;
}

/**
 * Get the path hash for a source from device state.
 */
export function getSourcePathHash(deviceState: DeviceState, sourceId: string): string | null {
  return deviceState.sourcePathHashes[sourceId] ?? null;
}

/**
 * Set the path hash for a source in device state.
 */
export function setSourcePathHash(deviceState: DeviceState, sourceId: string, hash: string): void {
  deviceState.sourcePathHashes[sourceId] = hash;
}

/**
 * A named sync source representing a single reMarkable tablet or sync origin.
 *
 * Each source has its own xochitl sync folder, Syncthing folder ID,
 * and extraction timestamp. This enables multi-tablet setups where
 * each device extracts independently into a shared vault.
 *
 * The extraction pipeline processes each source independently via
 * `runExtractionForSource()`, which builds a `PipelineConfig` scoped
 * to the source's `syncFolder` and optional `highlightsSubfolder`.
 *
 * Sources are persisted in `PluginData.syncSources` and managed via
 * `plugin.updateSyncSources()`. The first source (`sources[0]`) is
 * considered the primary source for backward-compatibility purposes.
 */
export interface SyncSource {
  /** Unique identifier (UUID v4). */
  id: string;
  /** User-visible label (e.g., "My rM1", "Partner's rM2"). */
  label: string;
  /** Path to the synced xochitl directory (relative to vault). */
  syncFolder: string;
  /** Syncthing folder ID for this source. */
  syncthingFolderId: string;
  /**
   * @deprecated Use `lastExtractionTimestamps` instead.
   * Kept temporarily for migration from older data.json files.
   */
  lastExtractionTimestamp?: number | null;
  /**
   * @deprecated Moved to DeviceState.sourceTimestamps (keyed by source ID).
   * Kept for backward compatibility during migration from older data.json files.
   * Per-device extraction timestamps, keyed by `os.hostname()`.
   */
  lastExtractionTimestamps: Record<string, number>;
  /**
   * @deprecated Moved to DeviceState.sourcePathHashes (keyed by source ID).
   * Kept for backward compatibility during migration from older data.json files.
   * Hash of syncFolder at the time lastExtractionTimestamps was set.
   */
  syncFolderPathHash: string | null;
  /**
   * Optional subfolder within highlightsFolder for this source's notes.
   * If set, highlight notes go to `highlightsFolder/highlightsSubfolder/`.
   * If not set, notes go directly to `highlightsFolder/`.
   */
  highlightsSubfolder: string | null;
}

/** How PDF++ links are formatted in highlight notes. */
export type PdfLinkFormat =
  | 'pdfpp'      // [[file.pdf#page=5]]
  | 'obsidian'   // [[file.pdf#page5]]
  | 'none';      // No link

/** Extraction preferences. */
export interface ExtractionPreferences {
  incrementalOnly: boolean;
  includeColors: boolean;
  groupByPage: boolean;
  pdfLinkFormat: PdfLinkFormat;
  defaultTags: string[];
  overwriteExisting: boolean;
  /**
   * Crop trailing blank space on short notebook/quick-sheet pages so a page
   * with only a little content doesn't embed a tall empty image.
   */
  truncateBlankSpace: boolean;
  /**
   * Run local OCR (Tesseract) on notebook pages so handwriting becomes
   * searchable text, folded under each page image. Requires Tesseract to be
   * installed; off by default.
   */
  ocrEnabled: boolean;
  /** Tesseract language code(s) for OCR, e.g. "eng" or "eng+deu". */
  ocrLanguage: string;
}

/** Which method to use for syncing files from the tablet. */
export type SyncMethodSetting = 'sftp' | 'syncthing';

/** Full plugin settings persisted to data.json. */
export interface ReMarkableBridgeSettings {
  tabletIp: string;
  rootPassword: string;
  sshPort: number;
  connectionMethod: ConnectionMethod;
  sshTimeoutMs: number;
  /** Sync method: 'sftp' for direct SSH transfer, 'syncthing' for Syncthing. */
  syncMethod: SyncMethodSetting;
  /** Folder where Syncthing syncs raw tablet files (relative to vault). */
  syncFolder: string;
  /** Folder where extracted highlight notes go (relative to vault). */
  highlightsFolder: string;
  /** Folder where archived documents are moved (relative to vault). */
  archiveFolder: string;
  /** Syncthing API key. */
  syncthingApiKey: string;
  /** Syncthing GUI address. */
  syncthingUrl: string;
  /** Syncthing folder ID for the reMarkable shared folder. */
  syncthingFolderId: string;
  extraction: ExtractionPreferences;
  setupComplete: boolean;
  lastSyncTimestamp: number | null;
  showStatusBar: boolean;
  debugLogging: boolean;
  autoExtractEnabled: boolean;
  includeEpub: boolean;
  /** Whether to automatically sync from tablet on a timer (SFTP only). */
  autoSyncEnabled: boolean;
  /** Interval in minutes between automatic SFTP syncs. */
  autoSyncIntervalMinutes: number;
  archiveEnabled: boolean;
  archiveThresholdPercent: number;
  archiveMinAgeDays: number;
  /** Path to the highlight note template file (relative to vault). */
  templatePath: string;
}

/**
 * Derive the drawings folder path from the highlights folder.
 * Drawings are stored as a subfolder of the highlights folder
 * so that relative image links in highlight notes resolve correctly.
 */
export function getDrawingsFolder(settings: ReMarkableBridgeSettings): string {
  return `${settings.highlightsFolder}/drawings`;
}

/** Non-settings plugin data stored in data.json. */
export interface PluginData extends ReMarkableBridgeSettings {
  /**
   * @deprecated Kept for backward compatibility during migration.
   * New code should use `syncSources[n].lastExtractionTimestamps`.
   */
  lastExtractionTimestamp: number | null;
  /**
   * @deprecated Kept for backward compatibility during migration.
   * New code should use `syncSources[n].syncFolderPathHash`.
   */
  syncFolderPathHash: string | null;
  /** Named sync sources for multi-device support. */
  syncSources: SyncSource[];
  /**
   * @deprecated Moved to DeviceState.dismissedCollisions.
   * Kept for backward compatibility during migration from older data.json files.
   * Dismissed collision warnings, keyed by collision key (folder::otherVault).
   */
  dismissedCollisions: string[];
}

/**
 * Generate a simple UUID-like identifier for a sync source.
 * Uses crypto.randomUUID when available, falls back to a timestamp-based ID.
 */
export function generateSourceId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for environments without crypto.randomUUID
    return `src-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }
}

/** Sensible defaults. */
export const DEFAULT_SETTINGS: ReMarkableBridgeSettings = {
  tabletIp: '10.11.99.1',
  rootPassword: '',
  sshPort: 22,
  connectionMethod: 'usb',
  sshTimeoutMs: 10_000,
  syncMethod: 'sftp',
  syncFolder: 'reMarkable/Sync',
  highlightsFolder: 'reMarkable/Highlights',
  archiveFolder: 'reMarkable/Archive',
  syncthingApiKey: '',
  syncthingUrl: 'http://127.0.0.1:8384',
  syncthingFolderId: 'remarkable-xochitl',
  extraction: {
    incrementalOnly: true,
    includeColors: true,
    groupByPage: true,
    pdfLinkFormat: 'pdfpp',
    defaultTags: [],
    overwriteExisting: false,
    truncateBlankSpace: true,
    ocrEnabled: false,
    ocrLanguage: 'eng',
  },
  setupComplete: false,
  lastSyncTimestamp: null,
  showStatusBar: true,
  debugLogging: false,
  autoExtractEnabled: true,
  includeEpub: true,
  autoSyncEnabled: false,
  autoSyncIntervalMinutes: 15,
  archiveEnabled: false,
  archiveThresholdPercent: 80,
  archiveMinAgeDays: 7,
  templatePath: 'reMarkable/template.md',
};
