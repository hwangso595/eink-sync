/**
 * Syncthing-based SyncProvider implementation.
 *
 * Communicates with the localhost Syncthing REST API to trigger rescans,
 * pause/resume folders, and check availability. No direct tablet communication
 * is needed -- Syncthing handles the peer-to-peer transfer.
 *
 * Privacy: Only calls localhost Syncthing API. No external network calls.
 */

import type { SyncProvider, SyncProgressCallback, SyncResult } from './sync-provider';
import type { SSHExecutor } from '../ssh/ssh-client';
import { ReMarkableSSHClient } from '../ssh/ssh-client';
import { stopServices, removeServices } from './service-manager';
import { logger } from '../utils/logger';

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
      const res = await fetch(`${apiUrl}/rest/db/scan?folder=${folderId}`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
      });

      // fetch() only rejects on network errors, not HTTP 4xx/5xx. A 403 (bad
      // API key) or 404 (bad folder ID) resolves normally, so we must inspect
      // the status ourselves or a misconfigured Syncthing would report success.
      if (!res.ok) {
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
      await new Promise(resolve => setTimeout(resolve, RESCAN_SETTLE_MS));

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
      const res = await fetch(`${apiUrl}/rest/config/folders/${folderId}`, {
        headers: { 'X-API-Key': apiKey },
      });
      return res.ok;
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
        method: 'wifi',
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
      const res = await fetch(`${apiUrl}/rest/config/folders/${folderId}`, {
        headers: { 'X-API-Key': apiKey },
      });
      if (!res.ok) return;

      const folderConfig = await res.json();
      folderConfig.paused = paused;

      await fetch(`${apiUrl}/rest/config/folders/${folderId}`, {
        method: 'PUT',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(folderConfig),
      });

      logger.info(`Syncthing folder ${folderId} ${paused ? 'paused' : 'resumed'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Could not ${paused ? 'pause' : 'resume'} Syncthing folder: ${msg}`);
    }
  }
}
