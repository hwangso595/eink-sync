/**
 * SFTP-based SyncProvider implementation.
 *
 * Wraps the existing SftpSyncEngine to conform to the SyncProvider interface.
 * SFTP is on-demand (no background daemon), so pause/resume are no-ops.
 *
 * Privacy: Only communicates with the user's tablet over SSH/SFTP.
 */

import type { SyncProvider, SyncProgressCallback, SyncResult } from './sync-provider';
import { SftpSyncEngine, type SftpProgressCallback } from './sftp-sync';
import { connectSftp } from './sftp-connection';
import { ReMarkableSSHClient } from '../ssh/ssh-client';
import { stopServices, removeServices } from './service-manager';
import type { ConnectionMethod } from '../types/config';

export interface SftpProviderConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
  connectionMethod: ConnectionMethod;
  localSyncDir: string;
  includeEpub: boolean;
}

export class SftpProvider implements SyncProvider {
  constructor(private config: SftpProviderConfig) {}

  async sync(onProgress?: SyncProgressCallback): Promise<SyncResult> {
    // Adapt the generic SyncProgressCallback to the SFTP-specific callback
    const sftpProgress: SftpProgressCallback | undefined = onProgress
      ? (phase, detail, current, total) => {
          onProgress(phase, detail, current, total);
        }
      : undefined;

    const engine = new SftpSyncEngine({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      timeoutMs: this.config.timeoutMs,
      connectionMethod: this.config.connectionMethod,
      localSyncDir: this.config.localSyncDir,
      includeEpub: this.config.includeEpub,
    });

    const result = await engine.sync(sftpProgress);

    return {
      // Honor the SyncResult contract: success implies no errors.
      success: result.success && result.errors.length === 0,
      filesDownloaded: result.filesDownloaded,
      filesSkipped: result.filesSkipped,
      summary: result.summary,
      errors: result.errors,
    };
  }

  async isAvailable(): Promise<boolean> {
    let connection: Awaited<ReturnType<typeof connectSftp>>['conn'] | null = null;
    try {
      const session = await connectSftp({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        password: this.config.password,
        timeoutMs: this.config.timeoutMs,
        connectionMethod: this.config.connectionMethod,
      });
      connection = session.conn;
      return true;
    } catch {
      return false;
    } finally {
      connection?.end();
    }
  }

  /** SFTP is on-demand -- no background process to pause. */
  async pause(): Promise<void> {
    // No-op: SFTP syncs are initiated on demand, not continuously.
  }

  /** SFTP is on-demand -- no background process to resume. */
  async resume(): Promise<void> {
    // No-op
  }

  /**
   * Remove Syncthing infrastructure from the tablet via SSH.
   * Called when switching from Syncthing to SFTP.
   */
  async remove(): Promise<void> {
    const ssh = new ReMarkableSSHClient({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      timeoutMs: this.config.timeoutMs,
      method: this.config.connectionMethod,
    });
    try {
      await ssh.connect();
      await stopServices(ssh);
      await removeServices(ssh);
    } finally {
      await ssh.disconnect();
    }
  }
}
