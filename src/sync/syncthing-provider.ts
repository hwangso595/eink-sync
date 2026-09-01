/**
 * Syncthing-based SyncProvider implementation.
 *
 * Communicates with the localhost Syncthing REST API to trigger rescans,
 * pause/resume folders, and check availability. No direct tablet communication
 * is needed -- Syncthing handles the peer-to-peer transfer.
 *
 * Privacy: Only calls localhost Syncthing API. No external network calls.
 */

import { requestUrl } from 'obsidian';
import type { SyncProvider, SyncProgressCallback, SyncResult } from './sync-provider';
import { ReMarkableSSHClient } from '../ssh/ssh-client';
import { stopServices, removeServices } from './service-manager';
import { logger } from '../utils/logger';
import { isRecord } from '../utils/json';
import type { ConnectionMethod } from '../types/config';

/** How long to wait after triggering a rescan before considering sync settled. */
const RESCAN_SETTLE_MS = 5000;

export interface SyncthingProviderConfig {
  /** Syncthing REST API URL (e.g. http://127.0.0.1:8384). */
  apiUrl: string;
  /** Syncthing REST API key. */
  apiKey: string;
  /** Syncthing folder ID for the shared xochitl folder. */
  folderId: string;
  /** SSH config for tablet-side operations (remove). */
  sshConfig?: {
    host: string;
    port: number;
    username: string;
    password: string;
    timeoutMs: number;
    connectionMethod: ConnectionMethod;
  };
}

export class SyncthingProvider implements SyncProvider {
  constructor(private config: SyncthingProviderConfig) {}

  /**
   * Trigger a Syncthing rescan and wait for it to settle.
   * Syncthing handles the actual file transfer in the background;
   * this just kicks off a rescan so any new tablet files are picked up.
   */
  async sync(onProgress?: SyncProgressCallback): Promise<SyncResult> {
    const { apiUrl, apiKey, folderId } = this.config;

    if (!apiKey || !folderId) {
      return {
        success: false,
        filesDownloaded: 0,
        filesSkipped: 0,
        summary: 'Syncthing API not configured. Using existing local files.',
        errors: ['Syncthing API key or folder ID not configured.'],
      };
    }

    onProgress?.('scanning', 'Asking Syncthing to check for changes...');

    try {
      const res = await requestUrl({
        url: `${apiUrl}/rest/db/scan?folder=${encodeURIComponent(folderId)}`,
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        throw: false,
      });

      // fetch() only rejects on network errors, not HTTP 4xx/5xx. A 403 (bad
      // API key) or 404 (bad folder ID) resolves normally, so we must inspect
      // the status ourselves or a misconfigured Syncthing would report success.
      if (res.status < 200 || res.status >= 300) {
        onProgress?.('error', `Syncthing rescan failed (HTTP ${res.status}).`);
        return {
          success: false,
          filesDownloaded: 0,
          filesSkipped: 0,
          summary: `Syncthing rescan failed (HTTP ${res.status}). Check the API key and folder ID.`,
          errors: [`Syncthing scan request returned HTTP ${res.status}.`],
        };
      }

      onProgress?.('waiting', 'Syncthing scanning... waiting for sync to settle.');
      await new Promise<void>((resolve) => window.setTimeout(resolve, RESCAN_SETTLE_MS));

      onProgress?.('complete', 'Sync complete.');
      return {
        success: true,
        filesDownloaded: 0, // Syncthing doesn't report per-file counts here
        filesSkipped: 0,
        summary: 'Syncthing rescan triggered.',
        errors: [],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.('error', `Could not reach Syncthing: ${msg}`);
      return {
        success: false,
        filesDownloaded: 0,
        filesSkipped: 0,
        summary: 'Could not reach Syncthing. Using existing local files.',
        errors: [msg],
      };
    }
  }

  /** Check if the Syncthing API is reachable and the folder exists. */
  async isAvailable(): Promise<boolean> {
    const { apiUrl, apiKey, folderId } = this.config;
    if (!apiKey || !folderId) return false;

    try {
      const res = await requestUrl({
        url: `${apiUrl}/rest/config/folders/${encodeURIComponent(folderId)}`,
        headers: { 'X-API-Key': apiKey },
        throw: false,
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  /** Pause the Syncthing folder via REST API. */
  async pause(): Promise<void> {
    await this.setFolderPaused(true);
  }

  /** Resume (unpause) the Syncthing folder via REST API. */
  async resume(): Promise<void> {
    await this.setFolderPaused(false);
  }

  /**
   * Stop and remove Syncthing from the tablet via SSH, then pause the
   * host-side folder so Syncthing stops trying to sync it.
   */
  async remove(): Promise<void> {
    // 1. Remove Syncthing from tablet via SSH (best-effort)
    if (this.config.sshConfig) {
      const ssh = new ReMarkableSSHClient({
        ...this.config.sshConfig,
        method: this.config.sshConfig.connectionMethod,
      });
      try {
        await ssh.connect();
        await stopServices(ssh);
        await removeServices(ssh);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Could not remove Syncthing from tablet: ${msg}`);
      } finally {
        await ssh.disconnect();
      }
    }

    // 2. Pause the host-side folder
    await this.pause();
  }

  /** Set the paused state of the Syncthing folder via REST API. */
  private async setFolderPaused(paused: boolean): Promise<void> {
    const { apiUrl, apiKey, folderId } = this.config;
    if (!apiKey || !folderId) return;

    try {
      const res = await requestUrl({
        url: `${apiUrl}/rest/config/folders/${encodeURIComponent(folderId)}`,
        headers: { 'X-API-Key': apiKey },
        throw: false,
      });
      if (res.status < 200 || res.status >= 300) return;

      const folderConfig: unknown = res.json;
      if (!isRecord(folderConfig)) return;
      folderConfig.paused = paused;

      await requestUrl({
        url: `${apiUrl}/rest/config/folders/${encodeURIComponent(folderId)}`,
        method: 'PUT',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(folderConfig),
        throw: false,
      });

      logger.info(`Syncthing folder ${folderId} ${paused ? 'paused' : 'resumed'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Could not ${paused ? 'pause' : 'resume'} Syncthing folder: ${msg}`);
    }
  }
}
