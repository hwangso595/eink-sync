/**
 * DeviceStateManager -- per-device state persistence.
 *
 * Extracted from plugin.ts. Manages reading/writing the device-specific
 * state file (device-state-<hostname>.json) that stores extraction
 * timestamps, path hashes, and dismissed collision keys.
 *
 * This state is intentionally stored outside Obsidian's data.json to
 * avoid Syncthing conflicts when multiple computers share the vault.
 */

import * as fs from 'fs';
import {
  DEFAULT_DEVICE_STATE,
  getDeviceKey,
  getSourceTimestamp,
  getSourcePathHash,
  setSourceTimestamp,
  setSourcePathHash,
  type DeviceState,
} from './settings';
import { logger } from '../utils/logger';

export class DeviceStateManager {
  private _deviceState: DeviceState = { ...DEFAULT_DEVICE_STATE };

  constructor(private getPluginDir: () => string) {}

  /** Get the file path for the current device's state file. */
  getFilePath(): string {
    const hostname = getDeviceKey();
    return `${this.getPluginDir()}/device-state-${hostname}.json`;
  }

  /**
   * Load device state from the per-device JSON file.
   * Returns defaults if the file does not exist or is unreadable.
   */
  load(): DeviceState {
    const filePath = this.getFilePath();
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this._deviceState = {
          sourceTimestamps: parsed.sourceTimestamps ?? {},
          sourcePathHashes: parsed.sourcePathHashes ?? {},
          dismissedCollisions: Array.isArray(parsed.dismissedCollisions) ? parsed.dismissedCollisions : [],
        };
        return this._deviceState;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Could not load device state: ${msg}`);
    }
    this._deviceState = { sourceTimestamps: {}, sourcePathHashes: {}, dismissedCollisions: [] };
    return this._deviceState;
  }

  /**
   * Save device state to the per-device JSON file.
   * Only writes to device-state-<hostname>.json, never to data.json.
   */
  async save(): Promise<void> {
    const filePath = this.getFilePath();
    try {
      fs.writeFileSync(filePath, JSON.stringify(this._deviceState, null, 2), 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Could not save device state: ${msg}`);
    }
  }

  /** Get the current device state. */
  get state(): DeviceState {
    return this._deviceState;
  }

  /** Replace the entire device state (used during migration). */
  set state(value: DeviceState) {
    this._deviceState = value;
  }

  /** Get extraction timestamp for a specific source. */
  getSourceTimestamp(sourceId: string): number | null {
    return getSourceTimestamp(this._deviceState, sourceId);
  }

  /** Set extraction timestamp for a specific source. */
  setSourceTimestamp(sourceId: string, timestamp: number): void {
    setSourceTimestamp(this._deviceState, sourceId, timestamp);
  }

  /** Get path hash for a specific source. */
  getSourcePathHash(sourceId: string): string | null {
    return getSourcePathHash(this._deviceState, sourceId);
  }

  /** Set path hash for a specific source. */
  setSourcePathHash(sourceId: string, hash: string): void {
    setSourcePathHash(this._deviceState, sourceId, hash);
  }

  /**
   * Reset extraction timestamps so the next run processes all documents.
   *
   * @param sourceId - If provided, only reset this source. Otherwise resets all.
   * @param syncSources - Sync sources array (for clearing legacy fields).
   */
  resetTimestamps(sourceId?: string, syncSources?: { id: string; lastExtractionTimestamps: Record<string, number>; syncFolderPathHash: string | null }[]): void {
    if (sourceId) {
      delete this._deviceState.sourceTimestamps[sourceId];
      delete this._deviceState.sourcePathHashes[sourceId];
      if (syncSources) {
        const source = syncSources.find((s) => s.id === sourceId);
        if (source) {
          source.lastExtractionTimestamps = {};
          source.syncFolderPathHash = null;
        }
      }
      logger.info(`Extraction timestamp reset for source "${sourceId}"`);
    } else {
      this._deviceState.sourceTimestamps = {};
      this._deviceState.sourcePathHashes = {};
      if (syncSources) {
        for (const source of syncSources) {
          source.lastExtractionTimestamps = {};
          source.syncFolderPathHash = null;
        }
      }
      logger.info('Extraction timestamps reset for all sources');
    }
    // Persist immediately
    this.save();
  }

  /** Add a dismissed collision key. */
  async dismissCollision(key: string): Promise<void> {
    if (!this._deviceState.dismissedCollisions.includes(key)) {
      this._deviceState.dismissedCollisions.push(key);
      await this.save();
    }
  }
}
