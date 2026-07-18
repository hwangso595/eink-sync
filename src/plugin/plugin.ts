/**
 * Main Obsidian plugin class for E-Ink Sync.
 *
 * This is the entry point that Obsidian loads. It:
 * - Registers the settings tab, commands, ribbon icon, and status bar
 * - Manages the plugin lifecycle (onload/onunload)
 * - Orchestrates SSH connections, sync setup, and extraction
 * - Opens the setup wizard on first run
 *
 * Privacy: No external network calls. Only SSH to the user's tablet
 * and localhost Syncthing API calls (folder path updates and scan triggers).
 * No analytics, telemetry, or update checks.
 */

import { Plugin, Notice, addIcon, WorkspaceLeaf, TFile, FuzzySuggestModal, App } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  DEFAULT_SETTINGS,
  getDrawingsFolder,
  generateSourceId,
  getDeviceKey,
  type DeviceState,
  type ReMarkableBridgeSettings,
  type PluginData,
  type SyncSource,
} from './settings';
import { ReMarkableBridgeSettingTab } from './settings-tab';
import { SetupWizardModal } from './setup-wizard';
import { ReMarkableLibraryView, LIBRARY_VIEW_TYPE } from './library-view';
import { SyncStatusModal } from './sync-status-modal';
import { buildLibrary } from './library-data';

// Sprint 1 imports
import { ReMarkableSSHClient, type SSHExecutor } from '../ssh/ssh-client';
import type { SSHConfig } from '../types/config';
import type { DeviceInfo } from '../types/device';
import {
  connectAndVerify,
  testConnection,
  testConnectionDetailed,
  type ConnectionResult,
  type ConnectionTestResult,
  type ProgressCallback,
} from '../ssh/connection-manager';
import { initHostKeyStore } from '../ssh/host-key-store';

// Sprint 2 imports
import {
  isSyncthingInstalled,
  isEntwareInstalled,
  installSyncStack,
  type InstallProgressCallback,
} from '../sync/installer';
import { materializeExtractionAssets } from './extraction-assets';

/**
 * Progress callback for the multi-phase install flow.
 * (phase, step, detail) -> void
 */
type SetupProgressCallback = (phase: string, step: string, detail: string) => void;

// Sprint 3 imports
import {
  runExtractionPipeline,
  type PipelineRunResult,
} from '../pipeline/extraction-pipeline';
import { ensureManagedPython } from '../pipeline/python-env';
import type { PipelineConfig } from '../pipeline/types';

// SFTP sync engine
import { SftpSyncEngine, type SftpProgressCallback, type SftpSyncResult } from '../sync/sftp-sync';

// Sync providers (unified abstraction over SFTP and Syncthing)
import type { SyncProvider, SyncProgressCallback as SyncProviderProgressCallback } from '../sync/sync-provider';
import { SftpProvider } from '../sync/sftp-provider';
import { SyncthingProvider } from '../sync/syncthing-provider';

// File watcher
import { XochitlFileWatcher } from '../pipeline/file-watcher';
import { discoverDocumentsWithStatus } from '../pipeline/document-discovery';

// Archive manager
import { archiveOldDocuments as runArchive } from './archive-manager';

// Template engine
import { DEFAULT_TEMPLATE } from '../pipeline/template-engine';

// Error types
import { BridgeError, ErrorCode } from '../types/errors';

// Utilities
import { logger, setLogLevel, LogLevel } from '../utils/logger';
import { resolvePath, ensureFolders, formatRelativeTime, hashString, getVaultBasePath } from './helpers';

// Extracted modules
import { SyncCoordinator } from './sync-coordinator';
import { DeviceStateManager } from './device-state-manager';
import { StatusBarManager } from './status-bar-manager';

// Vault isolation
import {
  writeClaimsAndCheckCollisions,
  removeAllClaims,
  collisionKey,
  type Collision,
  type OutsideVaultWarning,
  type VaultIsolationResult,
} from './vault-isolation';

/** Hardcoded debounce for auto-extraction (seconds). */
const AUTO_EXTRACT_DEBOUNCE_S = 10;

/** Cooldown for periodic archive checks (30 minutes in milliseconds). */
const ARCHIVE_CHECK_COOLDOWN_MS = 30 * 60 * 1000;

/** Custom icon SVG for the ribbon. Tablet with text lines (100x100 viewBox for Obsidian). */
const REMARKABLE_ICON_SVG = `<g transform="translate(10,2) scale(3.5)"><rect x="1" y="0" width="20" height="26" rx="2" ry="2" stroke="currentColor" stroke-width="1.5" fill="none"/><line x1="1" y1="21" x2="21" y2="21" stroke="currentColor" stroke-width="1"/><circle cx="11" cy="23.5" r="1" fill="currentColor"/><line x1="5" y1="5" x2="17" y2="5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="9" x2="15" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="13" x2="13" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="17" x2="11" y2="17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></g>`;

export default class ReMarkableBridgePlugin extends Plugin {
  settings: ReMarkableBridgeSettings = DEFAULT_SETTINGS;
  /** Coordinates auto-sync timer and SFTP sync runs. */
  private syncCoordinator = new SyncCoordinator(this);
  /** Manages per-device state persistence (timestamps, path hashes). */
  private deviceStateManager = new DeviceStateManager(() => this.getPluginDir());
  /** Manages the status bar element and periodic health checks. */
  private statusBarManager = new StatusBarManager(
    this,
    () => this.app,
    () => this.settings,
    () => this._pluginData.syncSources,
    () => this.periodicArchiveCheck(),
  );
  /** File watchers for automatic extraction (one per sync source). */
  private fileWatchers: XochitlFileWatcher[] = [];
  /**
   * @deprecated Kept for backward compatibility. Use fileWatchers array instead.
   */
  private fileWatcher: XochitlFileWatcher | null = null;
  /** Handle for the deferred xochitl-restart timeout in pushPdfToSyncFolder. */
  private pdfSyncTimeoutHandle: number | null = null;
  /** Handle for the debounced xochitl restart. */
  private xochitlRestartHandle: number | null = null;
  /** Whether a xochitl restart is currently in progress. */
  private xochitlRestartInProgress = false;
  /** Timestamp of the last periodic archive check, used for 30-minute cooldown. */
  private lastArchiveCheckTimestamp = 0;
  /**
   * The most recent sync/connection failure, surfaced in the status bar tooltip
   * and the sync status modal so a silent timeout no longer looks like "no new
   * docs". Cleared on the next successful sync.
   */
  private _lastSyncError: { message: string; at: number } | null = null;
  // Auto-sync timer state is now managed by SyncCoordinator.
  // These fields are kept for backward compatibility but delegate to the coordinator.

  /** Non-settings plugin data (timestamps, etc.). */
  private _pluginData: {
    lastExtractionTimestamp: number | null;
    syncFolderPathHash: string | null;
    syncSources: SyncSource[];
    dismissedCollisions: string[];
  } = {
    lastExtractionTimestamp: null,
    syncFolderPathHash: null,
    syncSources: [],
    dismissedCollisions: [],
  };

  /** Active collision warnings from the last isolation check. */
  private _activeCollisions: import('./vault-isolation').Collision[] = [];
  /** Active outside-vault warnings from the last isolation check. */
  private _outsideVaultWarnings: import('./vault-isolation').OutsideVaultWarning[] = [];

  async onload(): Promise<void> {
    logger.info('Loading E-Ink Sync plugin');

    // Write the embedded Python extraction scripts to disk. Obsidian's plugin
    // auto-updater only delivers manifest.json/main.js/styles.css, so the
    // scripts are bundled into main.js and materialized here; extraction would
    // otherwise fail on an auto-updated install with no extraction/ folder.
    try {
      materializeExtractionAssets(this.getPluginDir());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Could not write extraction scripts to disk: ${msg}`);
      new Notice(
        `E-Ink Sync: could not install its extraction scripts (${msg}). ` +
        `Highlight extraction will not work until this is resolved.`,
        12000,
      );
    }

    // Load persisted settings
    await this.loadSettings();
    this.applyLogLevel();

    // Initialise the SSH host-key store (TOFU) so the tablet's key is pinned
    // and key changes are surfaced to the user rather than silently trusted.
    initHostKeyStore(`${this.getPluginDir()}/known-hosts.json`, (host) => {
      new Notice(
        `E-Ink Sync: the SSH host key for ${host} changed, so the connection was ` +
        `refused. If another device could be impersonating your tablet, do not ` +
        `proceed. If you reflashed the tablet, remove ${host} from ` +
        `known-hosts.json in the plugin folder to re-trust it.`,
        15000,
      );
    });

    // Ensure folders exist
    await ensureFolders(this.app,
      this.settings.syncFolder,
      this.settings.highlightsFolder,
      this.settings.archiveFolder,
      getDrawingsFolder(this.settings),
    );

    // Run vault isolation checks (claim files + collision detection)
    this.runVaultIsolationChecks();

    // Create default highlight template if it doesn't exist
    await this.ensureDefaultTemplate();

    // Register the custom ribbon icon
    addIcon('remarkable-tablet', REMARKABLE_ICON_SVG);

    // Register the library sidebar view
    this.registerView(LIBRARY_VIEW_TYPE, (leaf: WorkspaceLeaf) => {
      return new ReMarkableLibraryView(leaf, this);
    });

    // Settings tab
    this.addSettingTab(new ReMarkableBridgeSettingTab(this.app, this));

    // Ribbon icon -- opens library if setup is done, otherwise wizard
    this.addRibbonIcon('remarkable-tablet', 'reMarkable Library', () => {
      if (!this.settings.setupComplete) {
        this.openSetupWizard();
      } else {
        this.activateLibraryView();
      }
    });

    // Status bar -- checks local sync folder health (no SSH required)
    this.statusBarManager.init();

    // Register commands
    this.registerCommands();

    // Start periodic local status checks if setup is complete
    if (this.settings.setupComplete) {
      this.statusBarManager.startChecks();
    }

    // Start file watcher if enabled (monitors all sync source folders)
    if (this.settings.autoExtractEnabled && this._pluginData.syncSources.length > 0) {
      this.startFileWatcher();
    }

    // Start auto-sync timer if enabled (SFTP periodic sync)
    if (this.settings.autoSyncEnabled && this.settings.syncMethod === 'sftp' && this.settings.setupComplete) {
      this.startAutoSyncTimer();
    }

    // Show setup wizard on first load
    if (!this.settings.setupComplete) {
      this.app.workspace.onLayoutReady(() => {
        new Notice(
          'E-Ink Sync: First-time setup required. Opening the setup wizard.',
        );
        this.openSetupWizard();
      });
    }

    logger.info('E-Ink Sync plugin loaded');
  }

  async onunload(): Promise<void> {
    logger.info('Unloading E-Ink Sync plugin');

    // Best-effort cleanup of claim files
    this.removeVaultClaims();

    this.stopFileWatcher();
    this.syncCoordinator.stop();
    this.statusBarManager.stopChecks();
    // Clear any pending PDF sync timeout
    if (this.pdfSyncTimeoutHandle !== null) {
      window.clearTimeout(this.pdfSyncTimeoutHandle);
      this.pdfSyncTimeoutHandle = null;
    }
    // Clear any pending xochitl restart
    if (this.xochitlRestartHandle !== null) {
      window.clearTimeout(this.xochitlRestartHandle);
      this.xochitlRestartHandle = null;
    }
    this.app.workspace.detachLeavesOfType(LIBRARY_VIEW_TYPE);
  }

  // -------------------------------------------------------------------
  // Settings persistence
  // -------------------------------------------------------------------

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Ensure nested objects are properly merged
    if (data?.extraction) {
      this.settings.extraction = Object.assign(
        {},
        DEFAULT_SETTINGS.extraction,
        data.extraction,
      );
    }
    // Restore defaults for empty string settings that shouldn't be empty
    if (!this.settings.templatePath) {
      this.settings.templatePath = DEFAULT_SETTINGS.templatePath;
    }
    if (!this.settings.syncFolder) {
      this.settings.syncFolder = DEFAULT_SETTINGS.syncFolder;
    }
    if (!this.settings.highlightsFolder) {
      this.settings.highlightsFolder = DEFAULT_SETTINGS.highlightsFolder;
    }
    if (!this.settings.archiveFolder) {
      this.settings.archiveFolder = DEFAULT_SETTINGS.archiveFolder;
    }
    // drawingsFolder is now derived from highlightsFolder (no longer a setting)
    // Clean up legacy drawingsFolder if present in saved data
    delete (this.settings as unknown as Record<string, unknown>).drawingsFolder;
    // Load non-settings plugin data (legacy fields, kept for backward compat)
    this._pluginData.lastExtractionTimestamp = data?.lastExtractionTimestamp ?? null;
    this._pluginData.syncFolderPathHash = data?.syncFolderPathHash ?? null;

    // Multi-source migration: if syncSources is missing/empty but the old
    // single-source fields exist, wrap them into a default source entry.
    const rawSources = data?.syncSources;
    if (Array.isArray(rawSources) && rawSources.length > 0) {
      // Already migrated — load sources, but migrate per-source timestamps
      // from old lastExtractionTimestamp (number) to lastExtractionTimestamps (Record)
      for (const source of rawSources) {
        if (!source.lastExtractionTimestamps || typeof source.lastExtractionTimestamps !== 'object') {
          source.lastExtractionTimestamps = {};
        }
        // Migrate old scalar timestamp into the per-device map
        if (typeof source.lastExtractionTimestamp === 'number' && source.lastExtractionTimestamp > 0) {
          const deviceKey = getDeviceKey();
          if (!source.lastExtractionTimestamps[deviceKey]) {
            source.lastExtractionTimestamps[deviceKey] = source.lastExtractionTimestamp;
          }
          delete source.lastExtractionTimestamp;
        }
      }
      this._pluginData.syncSources = rawSources;
    } else if (this.settings.syncFolder) {
      // Migrate: create a "Default" source from the existing settings
      const deviceKey = getDeviceKey();
      const timestamps: Record<string, number> = {};
      if (this._pluginData.lastExtractionTimestamp) {
        timestamps[deviceKey] = this._pluginData.lastExtractionTimestamp;
      }
      const defaultSource: SyncSource = {
        id: generateSourceId(),
        label: 'Default',
        syncFolder: this.settings.syncFolder,
        syncthingFolderId: this.settings.syncthingFolderId ?? '',
        lastExtractionTimestamps: timestamps,
        syncFolderPathHash: this._pluginData.syncFolderPathHash,
        highlightsSubfolder: null,
      };
      this._pluginData.syncSources = [defaultSource];
      logger.info(
        'Multi-source migration: created "Default" source from existing settings',
      );
    } else {
      this._pluginData.syncSources = [];
    }

    // Load dismissed collisions (legacy, for migration)
    this._pluginData.dismissedCollisions = Array.isArray(data?.dismissedCollisions)
      ? data.dismissedCollisions
      : [];

    // --- Device state: load from per-device file ---
    this.deviceStateManager.state = this.loadDeviceState();

    // --- Migration: move device-specific data from data.json to device state ---
    let needsDeviceStateSave = false;
    let needsDataJsonCleanup = false;

    // Migrate per-source timestamps and path hashes from SyncSource into DeviceState
    const deviceKey = getDeviceKey();
    for (const source of this._pluginData.syncSources) {
      // Migrate timestamp for current device
      const tsFromSource = source.lastExtractionTimestamps[deviceKey] ?? null;
      if (tsFromSource !== null && !(source.id in this.deviceStateManager.state.sourceTimestamps)) {
        this.deviceStateManager.state.sourceTimestamps[source.id] = tsFromSource;
        needsDeviceStateSave = true;
      }
      // Migrate path hash
      if (source.syncFolderPathHash && !(source.id in this.deviceStateManager.state.sourcePathHashes)) {
        this.deviceStateManager.state.sourcePathHashes[source.id] = source.syncFolderPathHash;
        needsDeviceStateSave = true;
      }
      // Clean up deprecated fields from data.json
      if (Object.keys(source.lastExtractionTimestamps).length > 0) {
        source.lastExtractionTimestamps = {};
        needsDataJsonCleanup = true;
      }
      if (source.syncFolderPathHash !== null) {
        source.syncFolderPathHash = null;
        needsDataJsonCleanup = true;
      }
    }

    // Migrate dismissed collisions from data.json to device state
    if (this._pluginData.dismissedCollisions.length > 0 && this.deviceStateManager.state.dismissedCollisions.length === 0) {
      this.deviceStateManager.state.dismissedCollisions = [...this._pluginData.dismissedCollisions];
      needsDeviceStateSave = true;
    }
    if (this._pluginData.dismissedCollisions.length > 0) {
      this._pluginData.dismissedCollisions = [];
      needsDataJsonCleanup = true;
    }

    // Persist migration results
    if (needsDeviceStateSave) {
      await this.saveDeviceState();
      logger.info('Device state migration: moved timestamps/collisions to device-state file');
    }
    if (needsDataJsonCleanup) {
      await this.saveSettings();
      logger.info('Device state migration: cleaned up deprecated fields from data.json');
    }
  }

  async saveSettings(): Promise<void> {
    // Merge settings + plugin data for persistence.
    // Device-specific state (timestamps, path hashes, dismissed collisions)
    // is stored in device-state-<hostname>.json, NOT here.
    await this.saveData({
      ...this.settings,
      lastExtractionTimestamp: this._pluginData.lastExtractionTimestamp,
      syncFolderPathHash: this._pluginData.syncFolderPathHash,
      syncSources: this._pluginData.syncSources,
      dismissedCollisions: this._pluginData.dismissedCollisions,
    });
  }

  /** Expose plugin data (timestamps) for read access by settings tab and other UI. */
  getPluginData(): PluginData {
    return {
      ...this.settings,
      lastExtractionTimestamp: this._pluginData.lastExtractionTimestamp,
      syncFolderPathHash: this._pluginData.syncFolderPathHash,
      syncSources: this._pluginData.syncSources,
      dismissedCollisions: this._pluginData.dismissedCollisions,
    };
  }

  /** Get all configured sync sources. */
  getSyncSources(): SyncSource[] {
    return this._pluginData.syncSources;
  }

  /**
   * Update sync sources array and save.
   *
   * **Backward-compatibility invariant:** The legacy top-level settings fields
   * (`syncFolder`, `syncthingFolderId`, `lastExtractionTimestamp`,
   * `syncFolderPathHash`) are always kept in sync with `sources[0]` -- the
   * first (primary) source. This ensures that older data.json consumers and
   * any code paths still referencing `settings.syncFolder` continue to work.
   *
   * When reordering or removing sources, callers must ensure the intended
   * primary source remains at index 0. Removing the primary source causes
   * the next source to become primary.
   */
  async updateSyncSources(sources: SyncSource[]): Promise<void> {
    this._pluginData.syncSources = sources;
    // Keep legacy top-level fields in sync with the first (primary) source
    if (sources.length > 0) {
      this.settings.syncFolder = sources[0].syncFolder;
      this.settings.syncthingFolderId = sources[0].syncthingFolderId;
      this._pluginData.lastExtractionTimestamp = this.deviceStateManager.getSourceTimestamp(sources[0].id);
      this._pluginData.syncFolderPathHash = this.deviceStateManager.getSourcePathHash(sources[0].id);
    }
    await this.saveSettings();
  }

  // -------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------

  private registerCommands(): void {
    this.addCommand({
      id: 'open-setup-wizard',
      name: 'Open setup wizard',
      callback: () => this.openSetupWizard(),
    });

    this.addCommand({
      id: 'run-extraction',
      name: 'Extract new highlights',
      callback: () => this.runExtraction(),
    });

    this.addCommand({
      id: 'run-extraction-all',
      name: 'Extract all highlights (re-process everything)',
      callback: () => this.runExtraction(true),
    });

    this.addCommand({
      id: 'test-connection',
      name: 'Test reMarkable connection',
      callback: () => this.testConnectionCommand(),
    });

    this.addCommand({
      id: 'send-to-remarkable',
      name: 'Send document to reMarkable',
      callback: () => this.sendDocumentToRemarkable(),
    });

    this.addCommand({
      id: 'open-library',
      name: 'Open reMarkable library',
      callback: () => this.activateLibraryView(),
    });


    this.addCommand({
      id: 'archive-old-documents',
      name: 'Archive old documents on reMarkable',
      callback: () => this.archiveOldDocuments(),
    });
  }

  // -------------------------------------------------------------------
  // Public methods (called by settings tab and wizard)
  // -------------------------------------------------------------------

  /** Open the setup wizard modal. */
  openSetupWizard(): void {
    const wizard = new SetupWizardModal(this.app, this);
    wizard.open();
  }

  /** Activate (or reveal) the library sidebar view. */
  async activateLibraryView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      const view = existing[0].view;
      if (view instanceof ReMarkableLibraryView) {
        await view.refreshLibrary();
      }
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: LIBRARY_VIEW_TYPE,
        active: true,
      });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  /** Build an SSHConfig from current settings. */
  buildSSHConfig(): SSHConfig {
    return {
      host: this.settings.tabletIp,
      port: this.settings.sshPort,
      username: 'root',
      password: this.settings.rootPassword,
      timeoutMs: this.settings.sshTimeoutMs,
      method: this.settings.connectionMethod,
    };
  }

  /**
   * Open an SSH session, run the callback, and guarantee cleanup.
   * Centralises the connect-try-finally-disconnect pattern so every
   * caller gets consistent error handling and resource release.
   */
  async withSSH<T>(fn: (ssh: SSHExecutor) => Promise<T>): Promise<T> {
    const ssh = new ReMarkableSSHClient(this.buildSSHConfig());
    try {
      await ssh.connect();
      return await fn(ssh);
    } finally {
      await ssh.disconnect();
    }
  }

  /**
   * Get the appropriate SyncProvider based on current settings.
   *
   * Returns an SftpProvider or SyncthingProvider that encapsulates all
   * transport-specific logic. Callers use the unified SyncProvider interface
   * instead of branching on `syncMethod`.
   *
   * @param sourceId - Optional: use the sync folder from a specific source.
   */
  getSyncProvider(sourceId?: string): SyncProvider {
    const sources = this._pluginData.syncSources;
    const source = sourceId
      ? sources.find((s) => s.id === sourceId) ?? sources[0]
      : sources[0];

    const syncMethod = this.settings.syncMethod ?? 'sftp';

    if (syncMethod === 'sftp') {
      const localSyncDir = source
        ? resolvePath(this.app, source.syncFolder)
        : resolvePath(this.app, this.settings.syncFolder);

      return new SftpProvider({
        host: this.settings.tabletIp,
        port: this.settings.sshPort,
        username: 'root',
        password: this.settings.rootPassword,
        timeoutMs: this.settings.sshTimeoutMs,
        localSyncDir,
        includeEpub: this.settings.includeEpub,
      });
    }

    // Syncthing provider
    return new SyncthingProvider({
      apiUrl: this.settings.syncthingUrl,
      apiKey: this.settings.syncthingApiKey,
      folderId: source?.syncthingFolderId ?? this.settings.syncthingFolderId,
      sshConfig: {
        host: this.settings.tabletIp,
        port: this.settings.sshPort,
        username: 'root',
        password: this.settings.rootPassword,
        timeoutMs: this.settings.sshTimeoutMs,
      },
    });
  }

  /**
   * Whether the active sync mode can push local changes back to the tablet.
   *
   * SFTP is pull-only: "Send to reMarkable", and per-document archive / delete /
   * unarchive cannot affect the tablet in SFTP mode. Only Syncthing propagates
   * local changes bidirectionally. UI surfaces branch on this so they never
   * claim a tablet-side effect they can't deliver.
   *
   * (This is distinct from the SSH-based bulk "Archive old documents" command,
   * which genuinely deletes from the tablet over SSH and works in either mode.)
   */
  isPushCapable(): boolean {
    return (this.settings.syncMethod ?? 'sftp') === 'syncthing';
  }

  /**
   * Schedule a debounced xochitl restart on the tablet.
   *
   * Multiple callers (archive, delete, send-to-remarkable) may request
   * a restart in quick succession. This method ensures only one restart
   * fires, with a 5-second debounce. If a restart is already in progress,
   * new requests are queued.
   */
  scheduleXochitlRestart(): void {
    // Clear any pending debounce timer
    if (this.xochitlRestartHandle !== null) {
      window.clearTimeout(this.xochitlRestartHandle);
    }

    const handle = window.setTimeout(async () => {
      this.xochitlRestartHandle = null;

      // Skip if a restart is already in progress
      if (this.xochitlRestartInProgress) {
        logger.info('xochitl restart already in progress, skipping');
        return;
      }

      this.xochitlRestartInProgress = true;
      try {
        await this.withSSH(async (ssh) => {
          logger.info('Restarting xochitl on tablet');
          await ssh.execute('systemctl restart xochitl');
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to restart xochitl: ${msg}`);
      } finally {
        this.xochitlRestartInProgress = false;
      }
    }, 5000);
    this.xochitlRestartHandle = handle;
    this.registerInterval(handle);
  }

  /** Quick connection test. Returns true if SSH works. */
  async testConnection(): Promise<boolean> {
    const config = this.buildSSHConfig();
    return testConnection(config);
  }

  /**
   * Connection test that preserves the specific failure reason, so UI surfaces
   * can tell the user *why* (timeout at IP vs. wrong password vs. refused)
   * instead of a bare "Failed".
   */
  async testConnectionDetailed(): Promise<ConnectionTestResult> {
    const config = this.buildSSHConfig();
    return testConnectionDetailed(config);
  }

  /** The most recent sync/connection failure (for status bar + modal). */
  getLastSyncError(): { message: string; at: number } | null {
    return this._lastSyncError;
  }

  /** Record a sync/connection failure for later display. */
  recordSyncError(err: unknown): void {
    const message = err instanceof BridgeError
      ? err.toUserMessage()
      : (err instanceof Error ? err.message : String(err));
    this._lastSyncError = { message, at: Date.now() };
  }

  /** Clear the last sync error after a successful sync. */
  clearSyncError(): void {
    this._lastSyncError = null;
  }

  /**
   * Detect the tablet's WiFi IP address via SSH and read the wlan0 interface IP.
   * Returns null if the tablet is not on WiFi.
   *
   * @param overrideHost - Connect to this host instead of the saved tablet IP.
   *   Used by the "find tablet via USB" recovery flow: when the saved WiFi IP is
   *   stale (e.g. after a network change), we connect over USB (10.11.99.1) to
   *   ask the tablet what its current WiFi IP actually is.
   */
  async detectTabletWifiIp(overrideHost?: string): Promise<string | null> {
    const config = this.buildSSHConfig();
    const ssh = new ReMarkableSSHClient(
      overrideHost ? { ...config, host: overrideHost, method: 'usb' } : config,
    );
    try {
      await ssh.connect();
      const result = await ssh.execute('ip -4 addr show wlan0 2>/dev/null');
      const match = result.stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } finally {
      await ssh.disconnect();
    }
  }

  /** Full connection + device detection + preflight check. */
  async connectAndVerify(
    onProgress?: ProgressCallback,
  ): Promise<ConnectionResult> {
    const config = this.buildSSHConfig();
    return connectAndVerify(config, onProgress);
  }

  /**
   * Sync files from the tablet via SFTP, then run extraction.
   *
   * This is the main entry point for SFTP-based sync. It:
   * 1. Connects to the tablet via SSH/SFTP
   * 2. Downloads new/changed files to the sync folder
   * 3. Runs the extraction pipeline on the synced files
   *
   * @param onProgress - Progress callback for UI updates.
   * @param sourceId - Optional: sync only a specific source.
   * @returns The combined SFTP sync result and extraction result.
   */
  async syncViaSftp(
    onProgress?: SftpProgressCallback,
    sourceId?: string,
  ): Promise<{ syncResult: SftpSyncResult; extractionResult: PipelineRunResult | null }> {
    // Enforce USB-only mode: block WiFi sync when connectionMethod is 'usb'
    if (this.settings.connectionMethod === 'usb' && this.settings.tabletIp !== '10.11.99.1') {
      throw new Error(
        'USB-only mode is enabled but tablet IP is not the USB address (10.11.99.1). ' +
        'Change connection method to WiFi in settings, or connect via USB.',
      );
    }

    const sources = this._pluginData.syncSources;
    let targetSources = sourceId
      ? sources.filter((s) => s.id === sourceId)
      : sources;

    if (targetSources.length === 0) {
      throw new Error('No sync sources configured.');
    }

    // SFTP uses one global tablet connection, so it can only sync a single
    // source -- syncing every folder from the same tablet would overwrite them
    // with duplicate data. Restrict to the primary/target source. (Multi-tablet
    // setups need Syncthing, which has per-source folder IDs.)
    if (targetSources.length > 1) {
      logger.warn(
        `SFTP syncs a single tablet; only "${targetSources[0].label}" of ` +
        `${targetSources.length} sources will be synced.`,
      );
      targetSources = [targetSources[0]];
    }

    // Sync every target source, each into its own local folder, and aggregate
    // the results. Previously only the first source was synced while extraction
    // scanned them all -- so extra sources looked "synced" but never were.
    const syncResult: SftpSyncResult = {
      success: true,
      filesDownloaded: 0,
      filesSkipped: 0,
      bytesDownloaded: 0,
      durationMs: 0,
      errors: [],
      summary: '',
    };
    const summaries: string[] = [];

    for (const src of targetSources) {
      const engine = new SftpSyncEngine({
        host: this.settings.tabletIp,
        port: this.settings.sshPort,
        username: 'root',
        password: this.settings.rootPassword,
        timeoutMs: this.settings.sshTimeoutMs,
        localSyncDir: resolvePath(this.app, src.syncFolder),
        includeEpub: this.settings.includeEpub,
      });

      const r = await engine.sync(onProgress);
      syncResult.filesDownloaded += r.filesDownloaded;
      syncResult.filesSkipped += r.filesSkipped;
      syncResult.bytesDownloaded += r.bytesDownloaded;
      syncResult.durationMs += r.durationMs;
      syncResult.errors.push(...r.errors);
      if (!r.success) syncResult.success = false;
      summaries.push(r.summary);
    }

    // Pull the reMarkable page-template art (ruled/grid/planner backgrounds) so
    // the renderer can draw it behind notebook strokes. Best-effort: the tablet
    // is already reachable here, and any failure only means pages stay on white.
    if (this.settings.extraction.renderTemplates) {
      try {
        const tmplEngine = new SftpSyncEngine({
          host: this.settings.tabletIp,
          port: this.settings.sshPort,
          username: 'root',
          password: this.settings.rootPassword,
          timeoutMs: this.settings.sshTimeoutMs,
          localSyncDir: resolvePath(this.app, targetSources[0].syncFolder),
          includeEpub: this.settings.includeEpub,
        });
        const tr = await tmplEngine.fetchTemplates(this.getTemplatesDir());
        if (tr.downloaded > 0) {
          logger.info(`Fetched ${tr.downloaded} reMarkable template file(s)`);
        }
        if (tr.errors.length > 0) {
          logger.warn(`Template fetch had issues: ${tr.errors.join('; ')}`);
        }
      } catch (err) {
        logger.warn(`Template fetch skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    syncResult.summary = targetSources.length === 1
      ? summaries[0]
      : `Synced ${targetSources.length} sources: ${syncResult.filesDownloaded} downloaded, ` +
        `${syncResult.filesSkipped} up to date` +
        (syncResult.errors.length > 0 ? `, ${syncResult.errors.length} error(s)` : '') + '.';

    // A clean transfer is success AND no per-file errors. Anything less must
    // not look healthy (no cleared error, advanced timestamp, or cursor).
    const cleanTransfer = syncResult.success && syncResult.errors.length === 0;
    if (!cleanTransfer) {
      this.recordSyncError(new Error(syncResult.errors[0] || syncResult.summary || 'SFTP sync failed'));
    } else {
      this.clearSyncError();
    }

    // Run extraction after sync completes (even if some files had errors).
    let extractionResult: PipelineRunResult | null = null;
    if (syncResult.filesDownloaded > 0 || syncResult.filesSkipped > 0) {
      try {
        // Extract exactly the source we synced (SFTP is one source), so
        // extraction never scans a folder this run didn't refresh.
        extractionResult = await this.runExtraction(false, targetSources[0].id, undefined, {
          allowCursorAdvance: cleanTransfer,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Extraction after SFTP sync failed: ${msg}`);
      }
    }

    if (cleanTransfer) {
      this.settings.lastSyncTimestamp = Date.now();
      await this.saveSettings();
    }

    return { syncResult, extractionResult };
  }

  /** Install Entware + Syncthing on the tablet. */
  async installSyncStack(
    onProgress?: SetupProgressCallback,
  ): Promise<void> {
    await this.withSSH(async (ssh) => {
      const installProgress: InstallProgressCallback = (step, detail) => {
        onProgress?.('Installing', step, detail);
      };
      await installSyncStack(ssh, installProgress);
    });
  }

  /** Verify that Entware and Syncthing are installed. */
  async verifySyncInstallation(): Promise<boolean> {
    return this.withSSH(async (ssh) => {
      const entware = await isEntwareInstalled(ssh);
      const syncthing = await isSyncthingInstalled(ssh);
      return entware && syncthing;
    });
  }

  /**
   * Run the full extraction pipeline across all sync sources (or a specific source).
   *
   * @param forceAll - If true, ignore incremental timestamps and re-extract everything.
   * @param sourceId - If provided, only extract from this specific source.
   * @param docUuid - If provided, only extract this specific document.
   */
  async runExtraction(
    forceAll = false,
    sourceId?: string,
    docUuid?: string,
    opts?: { allowCursorAdvance?: boolean },
  ): Promise<PipelineRunResult> {
    // A failed transfer can leave disk not reflecting the tablet, so the caller
    // may forbid advancing the incremental cursor (default: allowed).
    const allowCursorAdvance = opts?.allowCursorAdvance ?? true;
    const sources = this._pluginData.syncSources;

    if (sources.length === 0) {
      new Notice('E-Ink Sync: No sync sources configured.');
      throw new Error('No sync sources configured.');
    }

    // Filter to specific source if requested
    const targetSources = sourceId
      ? sources.filter((s) => s.id === sourceId)
      : sources;

    if (targetSources.length === 0) {
      new Notice('E-Ink Sync: Sync source not found.');
      throw new Error(`Sync source "${sourceId}" not found.`);
    }

    // Load custom template if configured
    let template: string | null = null;
    if (this.settings.templatePath) {
      try {
        const templateFile = this.app.vault.getAbstractFileByPath(this.settings.templatePath);
        if (templateFile && templateFile instanceof TFile) {
          template = await this.app.vault.read(templateFile);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Could not read template file: ${msg}, using default`);
      }
    }

    // Resolve the Python interpreter once for all sources. A hard failure here
    // aborts the run: proceeding without the deps would overwrite existing
    // notes with empty "no highlights found" content.
    let pythonPath: string | undefined;
    if (this.settings.managedPythonEnv) {
      try {
        const env = await ensureManagedPython({
          ocrExtras: this.settings.extraction.ocrEnabled,
          onProgress: (message) => new Notice(message),
        });
        pythonPath = env.pythonPath;
        if (env.created) {
          new Notice('E-Ink Sync: Python environment ready.');
        }
      } catch (err) {
        this.updateStatusBar('error');
        const msg = err instanceof BridgeError
          ? err.toUserMessage()
          : err instanceof Error ? err.message : String(err);
        new Notice(`E-Ink Sync: extraction aborted — ${msg}`, 15_000);
        throw err;
      }
    }

    this.updateStatusBar('extracting');

    // Aggregate results across all sources
    const aggregateResult: PipelineRunResult = {
      documentsProcessed: 0,
      documentsWithHighlights: 0,
      totalHighlights: 0,
      outputFiles: [],
      documentResults: [],
      errors: [],
      timestamp: new Date().toISOString(),
    };

    let lastError: Error | null = null;

    for (const source of targetSources) {
      try {
        // Capture the incremental cursor BEFORE extraction, from the tablet's
        // own clock domain. The previous code stored Date.now() (the host PC's
        // clock) and compared it against each doc's metadata.lastModified (the
        // tablet's clock). An offline rM1 whose clock lags the host would make
        // genuinely-new docs look "older than the cursor" and silently drop
        // them from every future incremental run. Using max(observed
        // lastModified) keeps the comparison tablet-vs-tablet, and capturing it
        // pre-run means a doc modified during extraction stays > cursor and is
        // re-picked-up next run rather than being skipped.
        const { maxTimestamp: observedCursor, pendingCount } =
          this.computeSourceCursorStatus(source.syncFolder);

        const sourceResult = await this.runExtractionForSource(
          source, forceAll, template, docUuid, pythonPath,
        );

        // Accumulate results
        aggregateResult.documentsProcessed += sourceResult.documentsProcessed;
        aggregateResult.documentsWithHighlights += sourceResult.documentsWithHighlights;
        aggregateResult.totalHighlights += sourceResult.totalHighlights;
        aggregateResult.outputFiles.push(...sourceResult.outputFiles);
        aggregateResult.documentResults.push(...sourceResult.documentResults);
        aggregateResult.errors.push(...sourceResult.errors);

        // Only advance the cursor after a clean full scan. A targeted (docUuid)
        // run, a run with errors, or one where documents are still mid-sync
        // (pendingCount) left documents unprocessed; advancing past them would
        // silently skip them on future incremental runs.
        const cleanFullScan =
          allowCursorAdvance && !docUuid && sourceResult.errors.length === 0 && pendingCount === 0;
        if (cleanFullScan) {
          const prevCursor = this.deviceStateManager.getSourceTimestamp(source.id) ?? 0;
          this.deviceStateManager.setSourceTimestamp(source.id, Math.max(prevCursor, observedCursor));
          this.deviceStateManager.setSourcePathHash(source.id, hashString(source.syncFolder));
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const msg = lastError.message;

        // For empty sync folder on a specific source, log but continue to next source
        if (err instanceof BridgeError && err.code === ErrorCode.SYNC_FOLDER_EMPTY) {
          logger.warn(`Source "${source.label}": empty sync folder — ${msg}`);
          aggregateResult.errors.push(`Source "${source.label}": ${msg}`);
          if (targetSources.length === 1) {
            // Only source — propagate the error
            this.updateStatusBar('error');
            const suggestion = err.suggestion ?? '';
            new Notice(`E-Ink Sync: ${err.message}\n${suggestion}`, 15000);
            throw err;
          }
          continue;
        }

        logger.error(`Extraction failed for source "${source.label}": ${msg}`);
        aggregateResult.errors.push(`Source "${source.label}": ${msg}`);

        if (targetSources.length === 1) {
          this.updateStatusBar('error');
          new Notice(`E-Ink Sync: Extraction failed.\n${msg}`, 15000);
          throw err;
        }
      }
    }

    // Keep legacy top-level timestamp in sync (see updateSyncSources invariant)
    if (targetSources.length > 0) {
      this._pluginData.lastExtractionTimestamp = this.deviceStateManager.getSourceTimestamp(targetSources[0].id);
      this._pluginData.syncFolderPathHash = this.deviceStateManager.getSourcePathHash(targetSources[0].id);
    }

    this.invalidateLibraryCache();
    // Only save device state after extraction -- NOT data.json.
    // This is the critical change that prevents Syncthing conflicts on every extraction.
    await this.saveDeviceState();

    // Notify user. Surface errors whenever present -- a run that produced no
    // highlights *because* something failed must not read as a clean
    // "No new highlights found."
    if (aggregateResult.totalHighlights > 0) {
      new Notice(
        `E-Ink Sync: Extracted ${aggregateResult.totalHighlights} highlight(s) from ${aggregateResult.documentsWithHighlights} document(s).`,
      );
    } else if (aggregateResult.errors.length > 0) {
      new Notice(
        `E-Ink Sync: Extraction completed with ${aggregateResult.errors.length} error(s). See the console for details.`,
        12000,
      );
    } else {
      new Notice('E-Ink Sync: No new highlights found.');
    }

    this.updateStatusBar('idle');
    return aggregateResult;
  }

  /**
   * Run extraction for a single sync source.
   * Handles per-source path-hash validation and timestamp management.
   */
  /**
   * Newest `lastModified` (tablet-clock, epoch-ms) across a source's
   * discoverable documents, plus the count of present-but-not-yet-extractable
   * ("pending") docs. The cursor stays in the tablet's clock domain; pendingCount
   * lets callers avoid advancing the cursor past mid-sync documents. On a scan
   * failure we report a pending doc so the cursor does not advance.
   */
  private computeSourceCursorStatus(syncFolder: string): { maxTimestamp: number; pendingCount: number } {
    try {
      const { documents, pendingCount } = discoverDocumentsWithStatus(resolvePath(this.app, syncFolder));
      let max = 0;
      for (const doc of documents) {
        if (doc.lastModified > max) max = doc.lastModified;
      }
      return { maxTimestamp: max, pendingCount };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Could not compute extraction cursor for "${syncFolder}": ${msg}`);
      return { maxTimestamp: 0, pendingCount: 1 };
    }
  }

  private async runExtractionForSource(
    source: SyncSource,
    forceAll: boolean,
    template: string | null,
    docUuid?: string,
    pythonPath?: string,
  ): Promise<PipelineRunResult> {
    if (!source.syncFolder) {
      throw new Error(`Sync folder not configured for source "${source.label}".`);
    }

    // Determine output path: use source-specific subfolder if configured
    let outputFolder = this.settings.highlightsFolder;
    if (source.highlightsSubfolder) {
      outputFolder = `${outputFolder}/${source.highlightsSubfolder}`;
    }
    const outputPath = resolvePath(this.app, outputFolder);

    // Path-hash validation: detect when syncFolder changed outside the settings UI
    let effectiveTimestamp = forceAll ? null
      : (this.settings.extraction.incrementalOnly ? this.deviceStateManager.getSourceTimestamp(source.id) : null);

    const currentPathHash = hashString(source.syncFolder);
    const storedPathHash = this.deviceStateManager.getSourcePathHash(source.id);
    if (
      effectiveTimestamp !== null &&
      storedPathHash !== null &&
      storedPathHash !== currentPathHash
    ) {
      logger.warn(
        `Source "${source.label}": path hash mismatch — ` +
        `stored="${storedPathHash}", current="${currentPathHash}". ` +
        `Running full extraction.`,
      );
      new Notice(
        `E-Ink Sync: Source "${source.label}" folder changed. Running full extraction.`,
      );
      effectiveTimestamp = null;
    }

    const pipelineConfig: PipelineConfig = {
      xochitlPath: resolvePath(this.app, source.syncFolder),
      outputPath,
      template,
      sinceTimestamp: effectiveTimestamp,
      overwrite: this.settings.extraction.overwriteExisting,
      pluginDir: this.getPluginDir(),
      drawingsPath: resolvePath(this.app, getDrawingsFolder(this.settings)),
      includeEpub: this.settings.includeEpub,
      sourceLabel: source.label,
      sourceId: source.id,
      includeColors: this.settings.extraction.includeColors,
      groupByPage: this.settings.extraction.groupByPage,
      pdfLinkFormat: this.settings.extraction.pdfLinkFormat,
      defaultTags: this.settings.extraction.defaultTags,
      truncateBlankSpace: this.settings.extraction.truncateBlankSpace,
      ocrEnabled: this.settings.extraction.ocrEnabled,
      ocrLanguage: this.settings.extraction.ocrLanguage,
      templatesDir: this.settings.extraction.renderTemplates ? this.getTemplatesDir() : undefined,
      uuidFilter: docUuid ? [docUuid] : undefined,
      pythonPath,
    };

    logger.info(`Running extraction for source "${source.label}" (${source.syncFolder})${docUuid ? ` [doc: ${docUuid}]` : ''}`);
    return runExtractionPipeline(pipelineConfig);
  }

  // -------------------------------------------------------------------
  // File Watcher
  // -------------------------------------------------------------------

  /** Toggle file watchers based on settings. */
  toggleFileWatcher(): void {
    if (this.settings.autoExtractEnabled && this._pluginData.syncSources.length > 0) {
      this.startFileWatcher();
    } else {
      this.stopFileWatcher();
    }
  }

  /**
   * Restart file watchers for all sync sources.
   * Called after a sync folder path changes so the watchers monitor
   * the correct locations.
   */
  restartFileWatcher(): void {
    if (this.settings.autoExtractEnabled && this._pluginData.syncSources.length > 0) {
      logger.info('Restarting file watchers for sync sources');
      this.startFileWatcher(); // startFileWatcher calls stopFileWatcher internally
    }
  }

  /**
   * Reset extraction timestamps so that the next extraction run
   * processes all documents.
   *
   * @param sourceId - If provided, only reset the timestamp for this source.
   *                   Otherwise resets all sources.
   */
  resetExtractionTimestamp(sourceId?: string): void {
    this.deviceStateManager.resetTimestamps(sourceId, this._pluginData.syncSources);
    // Also reset legacy top-level timestamp
    this._pluginData.lastExtractionTimestamp = null;
    this._pluginData.syncFolderPathHash = null;
  }

  /** Start file watchers for all sync sources. */
  private startFileWatcher(): void {
    this.stopFileWatcher();

    const sources = this._pluginData.syncSources;
    if (sources.length === 0) {
      logger.warn('Cannot start file watcher: no sync sources configured');
      return;
    }

    for (const source of sources) {
      if (!source.syncFolder) continue;

      try {
        const watcher = new XochitlFileWatcher({
          xochitlPath: resolvePath(this.app, source.syncFolder),
          debounceMs: AUTO_EXTRACT_DEBOUNCE_S * 1000,
          registerInterval: (handle) => this.registerInterval(handle),
        });

        watcher.on((event, detail) => {
          if (event === 'extraction-due') {
            logger.info(`Auto-extraction triggered for source "${source.label}": ${detail}`);
            this.runExtraction(false, source.id).catch((err) => {
              logger.error(`Auto-extraction failed for source "${source.label}": ${err}`);
            });
          }
        });

        watcher.start();
        this.fileWatchers.push(watcher);
        logger.info(`File watcher started for source "${source.label}" (${source.syncFolder})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to start file watcher for source "${source.label}": ${msg}`);
      }
    }

    // Keep legacy field pointing to first watcher for backward compat
    this.fileWatcher = this.fileWatchers.length > 0 ? this.fileWatchers[0] : null;
  }

  /** Stop all file watchers. */
  private stopFileWatcher(): void {
    for (const watcher of this.fileWatchers) {
      watcher.stop();
    }
    this.fileWatchers = [];
    this.fileWatcher = null;
  }

  // -------------------------------------------------------------------
  // Auto-Sync Timer (SFTP periodic sync)
  // -------------------------------------------------------------------

  /** Start the auto-sync timer. Delegates to SyncCoordinator. */
  startAutoSyncTimer(): void {
    this.syncCoordinator.start();
  }

  /** Stop the auto-sync timer. Delegates to SyncCoordinator. */
  stopAutoSyncTimer(): void {
    this.syncCoordinator.stop();
  }

  /** Toggle the auto-sync timer based on current settings. Delegates to SyncCoordinator. */
  toggleAutoSyncTimer(): void {
    this.syncCoordinator.toggle();
  }

  // -------------------------------------------------------------------
  // Vault Isolation
  // -------------------------------------------------------------------

  /**
   * Run vault isolation checks: write claim files and detect collisions.
   *
   * Called on plugin load and after folder changes. Non-blocking -- all
   * findings are stored for the settings tab to display as warnings.
   * New (undismissed) collisions trigger a one-time Notice.
   */
  runVaultIsolationChecks(): void {
    try {
      const vaultBase = getVaultBasePath(this.app);
      if (!vaultBase) {
        logger.warn('Vault isolation: could not determine vault base path');
        return;
      }

      const syncFolders = this._pluginData.syncSources
        .map((s) => s.syncFolder)
        .filter(Boolean);

      const result = writeClaimsAndCheckCollisions(
        vaultBase,
        syncFolders,
        this.settings.highlightsFolder,
        this.settings.archiveFolder,
        this.getPluginDir(),
      );

      this._activeCollisions = result.collisions;
      this._outsideVaultWarnings = result.outsideVaultWarnings;

      // Show Notice for new (undismissed) collisions
      const dismissed = new Set(this.deviceStateManager.state.dismissedCollisions);
      const newCollisions = result.collisions.filter(
        (c) => !dismissed.has(collisionKey(c)),
      );

      if (newCollisions.length > 0) {
        const folders = newCollisions.map((c) => c.folderPath).join(', ');
        new Notice(
          `E-Ink Sync: Folder collision detected. ` +
          `Another vault is using the same folder(s): ${folders}. ` +
          `Check Settings for details.`,
          15000,
        );
      }

      // Show Notice for outside-vault warnings
      for (const w of result.outsideVaultWarnings) {
        new Notice(
          `E-Ink Sync: The folder "${w.configuredPath}" resolves ` +
          `outside your vault. This is unusual and may cause issues with Obsidian indexing.`,
          10000,
        );
      }

      if (result.errors.length > 0) {
        logger.warn(`Vault isolation errors: ${result.errors.join('; ')}`);
      }

      logger.info(
        `Vault isolation: ${result.collisions.length} collision(s), ` +
        `${result.outsideVaultWarnings.length} outside-vault warning(s), ` +
        `${result.staleClaimsFound} stale claim(s)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Vault isolation check failed: ${msg}`);
    }
  }

  /**
   * Remove claim files from all managed folders (best-effort).
   * Called on plugin unload.
   */
  private removeVaultClaims(): void {
    try {
      const vaultBase = getVaultBasePath(this.app);
      if (!vaultBase) return;

      const syncFolders = this._pluginData.syncSources
        .map((s) => s.syncFolder)
        .filter(Boolean);

      removeAllClaims(
        vaultBase,
        syncFolders,
        this.settings.highlightsFolder,
        this.settings.archiveFolder,
        this.getPluginDir(),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`Claim cleanup failed: ${msg}`);
    }
  }

  /** Get active collisions for the settings tab to display. */
  getActiveCollisions(): Collision[] {
    return this._activeCollisions;
  }

  /** Get active outside-vault warnings for the settings tab to display. */
  getOutsideVaultWarnings(): OutsideVaultWarning[] {
    return this._outsideVaultWarnings;
  }

  /** Get dismissed collision keys. */
  getDismissedCollisions(): string[] {
    return this.deviceStateManager.state.dismissedCollisions;
  }

  /** Dismiss a collision warning. */
  async dismissCollision(key: string): Promise<void> {
    await this.deviceStateManager.dismissCollision(key);
  }

  // -------------------------------------------------------------------
  // Send PDF to reMarkable
  // -------------------------------------------------------------------

  /** Supported file types for sending to reMarkable. */
  private static readonly SENDABLE_EXTENSIONS = ['pdf', 'epub'];

  /** Let user pick a document from the vault and send it to reMarkable via sync folder. */
  async sendDocumentToRemarkable(): Promise<void> {
    // SFTP is download-only. Writing files into the local sync folder does
    // nothing on the tablet, so refuse rather than pretend the send worked.
    if (!this.isPushCapable()) {
      new Notice(
        'E-Ink Sync: Sending documents to the tablet requires Syncthing sync mode. ' +
        'SFTP is download-only. Switch to Syncthing in settings to enable this.',
        10000,
      );
      return;
    }

    const sources = this._pluginData.syncSources;
    if (sources.length === 0 || !sources[0].syncFolder) {
      new Notice('E-Ink Sync: No sync source configured. Run setup wizard first.');
      return;
    }

    // Find all sendable documents in the vault
    const docFiles = this.app.vault.getFiles().filter(
      (f) => ReMarkableBridgePlugin.SENDABLE_EXTENSIONS.includes(f.extension.toLowerCase())
    );

    if (docFiles.length === 0) {
      new Notice('E-Ink Sync: No PDF or EPUB files found in your vault.');
      return;
    }

    // Show picker
    new DocumentPickerModal(this.app, docFiles, async (file) => {
      await this.pushDocumentToSyncFolder(file);
    }).open();
  }

  /** Create xochitl-compatible files for a document and place in sync folder. */
  private async pushDocumentToSyncFolder(file: TFile): Promise<void> {

    const syncDir = resolvePath(this.app, this.settings.syncFolder);

    // Generate UUID for the document
    const uuid = crypto.randomUUID();

    const visibleName = file.basename;
    const fileType = file.extension.toLowerCase(); // 'pdf' or 'epub'

    // Create metadata file
    const metadata = {
      createdTime: String(Date.now()),
      deleted: false,
      lastModified: String(Date.now()),
      lastOpened: '0',
      lastOpenedPage: 0,
      metadatamodified: true,
      modified: true,
      new: true,
      parent: '',
      pinned: false,
      source: '',
      synced: false,
      type: 'DocumentType',
      version: 0,
      visibleName: visibleName,
    };

    // Create content file
    const content = {
      coverPageNumber: 0,
      documentMetadata: {},
      extraMetadata: {},
      fileType: fileType,
      fontName: '',
      formatVersion: 1,
      lineHeight: -1,
      orientation: 'portrait',
      pageCount: 0,
      pageTags: [],
      pages: [],
      textAlignment: 'justify',
      textScale: 1,
      zoomMode: 'bestFit',
    };

    try {
      // Write metadata
      fs.writeFileSync(
        path.join(syncDir, `${uuid}.metadata`),
        JSON.stringify(metadata, null, 4)
      );

      // Write content
      fs.writeFileSync(
        path.join(syncDir, `${uuid}.content`),
        JSON.stringify(content, null, 4)
      );

      // Copy the document file (reMarkable uses .pdf extension even for EPUBs it converts)
      const docData = await this.app.vault.readBinary(file);
      fs.writeFileSync(
        path.join(syncDir, `${uuid}.${fileType}`),
        Buffer.from(docData)
      );

      new Notice(`E-Ink Sync: "${visibleName}" queued. Syncing to tablet...`);

      // Best-effort: wait for Syncthing to push the file, then try to restart xochitl.
      // If SSH is unavailable, Syncthing will still deliver the file and the tablet
      // will see it after the next xochitl restart or reboot.
      const pdfHandle = window.setTimeout(async () => {
        this.pdfSyncTimeoutHandle = null;
        try {
          await this.withSSH(async (ssh) => {
            const check = await ssh.execute(`test -f /home/root/.local/share/remarkable/xochitl/${uuid}.${fileType} && echo yes || echo no`);
            if (check.stdout.trim() === 'yes') {
              this.scheduleXochitlRestart();
              new Notice(`E-Ink Sync: "${visibleName}" is now on your tablet.`);
            } else {
              new Notice(`E-Ink Sync: "${visibleName}" is syncing. It will appear on the tablet shortly.`);
            }
          });
        } catch {
          // SSH unavailable -- Syncthing will still deliver the file
          new Notice(`E-Ink Sync: "${visibleName}" will appear on the tablet after sync completes and the tablet restarts.`);
        }
      }, 15000);
      this.pdfSyncTimeoutHandle = pdfHandle;
      this.registerInterval(pdfHandle);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`E-Ink Sync: Failed to send PDF. ${msg}`);
    }
  }

  // -------------------------------------------------------------------
  // Status bar
  // -------------------------------------------------------------------

  /** Update the status bar text based on current state. Delegates to StatusBarManager. */
  updateStatusBar(
    state: 'idle' | 'connected' | 'syncing' | 'extracting' | 'error' | 'disconnected',
  ): void {
    this.statusBarManager.update(state);
  }

  /** Invalidate the cached document count (called after extraction or refresh). */
  invalidateLibraryCache(): void {
    this.statusBarManager.invalidateCache();
  }

  /** Show or hide the status bar item based on settings. Delegates to StatusBarManager. */
  updateStatusBarVisibility(): void {
    this.statusBarManager.updateVisibility();
  }

  /**
   * Create the default highlight template file in the vault if it doesn't exist.
   * The template path is configurable via settings.templatePath.
   */
  private async ensureDefaultTemplate(): Promise<void> {
    const templatePath = this.settings.templatePath;
    if (!templatePath) return;

    try {
      const existing = this.app.vault.getAbstractFileByPath(templatePath);
      if (existing) return; // Template already exists, don't overwrite

      // Ensure parent folder exists
      const parentDir = templatePath.substring(0, templatePath.lastIndexOf('/'));
      if (parentDir) {
        await ensureFolders(this.app, parentDir);
      }

      await this.app.vault.create(templatePath, DEFAULT_TEMPLATE);
      logger.info(`Created default highlight template at ${templatePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Could not create default template: ${msg}`);
    }
  }

  /** Apply the current log level from settings. */
  applyLogLevel(): void {
    setLogLevel(this.settings.debugLogging ? LogLevel.DEBUG : LogLevel.INFO);
  }

  /** Get the plugin's installation directory (where extraction/ scripts live). */
  /** Absolute path to this plugin's folder (also read by the settings tab). */
  getPluginDir(): string {
    const basePath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '';
    const configDir = this.app.vault.configDir;
    return basePath
      ? `${basePath}/${configDir}/plugins/${this.manifest.id}`
      : `${configDir}/plugins/${this.manifest.id}`;
  }

  /**
   * Local cache dir for reMarkable page-template art fetched from the tablet.
   * Lives inside the plugin folder (not synced), so it persists across runs and
   * is available to the Python renderer as an absolute path.
   */
  private getTemplatesDir(): string {
    return path.join(this.getPluginDir(), 'rm-templates');
  }

  // -------------------------------------------------------------------
  // Device state persistence (per-device file, avoids Syncthing conflicts)
  // -------------------------------------------------------------------

  /**
   * Get the file path for the current device's state file.
   * Delegates to DeviceStateManager.
   */
  getDeviceStateFilePath(): string {
    return this.deviceStateManager.getFilePath();
  }

  /**
   * Load device state from the per-device JSON file.
   * Delegates to DeviceStateManager.
   */
  loadDeviceState(): DeviceState {
    return this.deviceStateManager.load();
  }

  /**
   * Save device state to the per-device JSON file.
   * Delegates to DeviceStateManager.
   */
  async saveDeviceState(): Promise<void> {
    await this.deviceStateManager.save();
  }

  /** Get the current device state (for settings tab and other UI). */
  getDeviceState(): DeviceState {
    return this.deviceStateManager.state;
  }

  // -------------------------------------------------------------------
  // Periodic status checks (local only -- no SSH required)
  // -------------------------------------------------------------------

  // Status checks are now managed by StatusBarManager.
  // The onStatusCheck callback delegates to periodicArchiveCheck().

  // -------------------------------------------------------------------
  // Storage management -- archive old documents
  // -------------------------------------------------------------------

  /**
   * Archive old/read documents on the reMarkable to free /home space.
   * Delegates to the archive-manager module over an SSH session.
   */
  async archiveOldDocuments(force = false): Promise<number> {
    try {
      // Resolve the local synced copy so archive can verify a backup exists
      // before deleting anything from the tablet.
      const sources = this._pluginData.syncSources;
      const localSyncDir = sources[0]?.syncFolder
        ? resolvePath(this.app, sources[0].syncFolder)
        : resolvePath(this.app, this.settings.syncFolder);

      const archived = await this.withSSH(async (ssh) => {
        return runArchive(ssh, {
          thresholdPercent: this.settings.archiveThresholdPercent,
          minAgeDays: this.settings.archiveMinAgeDays,
          force,
          localSyncDir,
        }, () => this.scheduleXochitlRestart());
      });

      if (archived > 0) {
        new Notice(`E-Ink Sync: Archived ${archived} old document(s) to free space.`);
      } else {
        new Notice('E-Ink Sync: No documents needed archiving.');
      }

      return archived;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Archive operation failed: ${msg}`);
      new Notice(`E-Ink Sync: Archive failed -- ${msg}`);
      return 0;
    }
  }

  /**
   * Best-effort periodic archive check. Called alongside the status bar
   * health check. Rate-limited to run at most once every 30 minutes to
   * avoid opening an SSH session on every 60-second status check cycle.
   */
  private async periodicArchiveCheck(): Promise<void> {
    if (!this.settings.archiveEnabled) return;
    if (!this.settings.setupComplete) return;

    const now = Date.now();
    if (now - this.lastArchiveCheckTimestamp < ARCHIVE_CHECK_COOLDOWN_MS) return;
    this.lastArchiveCheckTimestamp = now;

    try {
      await this.archiveOldDocuments(false);
    } catch {
      // Best-effort -- swallow errors silently
    }
  }

  // -------------------------------------------------------------------
  // Command implementations
  // -------------------------------------------------------------------

  private async testConnectionCommand(): Promise<void> {
    new Notice('E-Ink Sync: Testing connection...');
    try {
      const result = await this.connectAndVerify(
        (step, detail) => logger.info(`[connection-test] ${step}: ${detail}`),
      );
      if (result.success) {
        new Notice(
          `E-Ink Sync: Connected to ${result.deviceInfo?.model ?? 'device'} ` +
          `(firmware ${result.deviceInfo?.firmware.raw ?? 'unknown'}).`,
        );
        this.updateStatusBar('connected');
      } else {
        new Notice(`E-Ink Sync: Connection failed. ${result.summary}`);
        this.updateStatusBar('disconnected');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`E-Ink Sync: ${msg}`);
      this.updateStatusBar('error');
    }
  }
}

/**
 * Fuzzy-search modal for picking a PDF file from the vault.
 */
class DocumentPickerModal extends FuzzySuggestModal<TFile> {
  private files: TFile[];
  private onChoose: (file: TFile) => void;

  constructor(app: App, files: TFile[], onChoose: (file: TFile) => void) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder('Pick a document to send to reMarkable...');
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.onChoose(item);
  }
}
