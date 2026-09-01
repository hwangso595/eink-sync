/**
 * Unified adapter for document mutations on a reMarkable tablet.
 *
 * Pulling files may use SFTP or Syncthing, but sending, restoring, archiving,
 * deleting, and refreshing must have the same observable behavior. This
 * adapter owns those shared sequences and hides the direct SSH/SFTP details
 * from plugin views.
 */

import type { SSHExecutor } from '../ssh/ssh-client';
import { deleteDocumentFromTablet } from '../plugin/document-deletion';
import {
  archiveVerifiedTabletDocument,
  protectDocumentFromResync,
  unprotectDocumentFromResync,
} from '../plugin/archive-manager';
import {
  uploadDocumentCollection,
  type SftpUploadOptions,
  type SftpUploadProgressCallback,
  type SftpUploadResult,
} from './sftp-upload';

export interface TabletDocumentResult {
  /** Whether the tablet document UI restarted after the mutation. */
  tabletLibraryRefreshed: boolean;
}

export type TabletDocumentProgressPhase =
  | 'connecting'
  | 'uploading'
  | 'refreshing'
  | 'complete';

export type TabletDocumentProgressCallback = (
  phase: TabletDocumentProgressPhase,
  detail: string,
  current?: number,
  total?: number,
  percent?: number,
) => void;

interface TabletDocumentAdapterDependencies {
  upload: (
    options: SftpUploadOptions,
    uuid: string,
    onProgress?: SftpUploadProgressCallback,
  ) => Promise<SftpUploadResult>;
  deleteRemote: typeof deleteDocumentFromTablet;
  archiveRemote: typeof archiveVerifiedTabletDocument;
  protectRemote: typeof protectDocumentFromResync;
  unprotectRemote: typeof unprotectDocumentFromResync;
}

const DEFAULT_DEPENDENCIES: TabletDocumentAdapterDependencies = {
  upload: uploadDocumentCollection,
  deleteRemote: deleteDocumentFromTablet,
  archiveRemote: archiveVerifiedTabletDocument,
  protectRemote: protectDocumentFromResync,
  unprotectRemote: unprotectDocumentFromResync,
};

export class TabletDocumentAdapter {
  constructor(
    private readonly connection: Omit<SftpUploadOptions, 'localSyncDir'>,
    private readonly withSSH: <T>(fn: (ssh: SSHExecutor) => Promise<T>) => Promise<T>,
    private readonly refreshTabletLibrary: () => Promise<boolean>,
    private readonly dependencies: TabletDocumentAdapterDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  /** Upload a complete local collection and immediately refresh the tablet UI. */
  async sendDocument(
    uuid: string,
    localSyncDir: string,
    onProgress?: TabletDocumentProgressCallback,
  ): Promise<TabletDocumentResult> {
    onProgress?.('connecting', 'Connecting to tablet...');
    let lastPercent = -1;
    await this.dependencies.upload(
      { ...this.connection, localSyncDir },
      uuid,
      (filename, current, total, bytesUploaded, totalBytes) => {
        const percent = totalBytes > 0
          ? Math.min(100, Math.floor((bytesUploaded / totalBytes) * 100))
          : 100;
        if (percent === lastPercent) return;
        lastPercent = percent;
        onProgress?.('uploading', filename, current, total, percent);
      },
    );
    onProgress?.('refreshing', 'Refreshing tablet library...');
    const tabletLibraryRefreshed = await this.refreshTabletLibrary();
    onProgress?.('complete', 'Upload complete.');
    return { tabletLibraryRefreshed };
  }

  /**
   * Restore local archive files, deliver them, and roll back the local move if
   * delivery fails. This gives both sync modes the same restore transaction.
   */
  async restoreDocument(
    uuid: string,
    localSyncDir: string,
    restoreLocal: () => void,
    rollbackLocal: () => void,
    onProgress?: TabletDocumentProgressCallback,
  ): Promise<TabletDocumentResult> {
    restoreLocal();
    try {
      // Archived UUID patterns must be removed before upload or Syncthing can
      // immediately hide/delete the restored collection again.
      await this.withSSH((ssh) => this.dependencies.unprotectRemote(ssh, uuid));
      return await this.sendDocument(uuid, localSyncDir, onProgress);
    } catch (err) {
      let recoveryError: unknown;
      try {
        rollbackLocal();
      } catch (rollbackErr) {
        recoveryError = rollbackErr;
      }
      try {
        // The local collection is back in Archive, so restore its protection.
        await this.withSSH((ssh) => this.dependencies.protectRemote(ssh, uuid));
      } catch (protectErr) {
        recoveryError = recoveryError ?? protectErr;
      }
      if (recoveryError) {
        const original = err instanceof Error ? err.message : String(err);
        const recovery = recoveryError instanceof Error
          ? recoveryError.message
          : typeof recoveryError === 'string' ? recoveryError : 'Unknown rollback error';
        throw new Error(`${original} Restore rollback also failed: ${recovery}`);
      }
      throw err;
    }
  }

  /**
   * Delete the tablet collection first, commit the corresponding local
   * deletion, then refresh the tablet UI. A local failure still refreshes the
   * already-completed remote deletion before the error is returned.
   */
  async deleteDocument(
    uuid: string,
    deleteLocal: () => void,
  ): Promise<TabletDocumentResult> {
    await this.withSSH((ssh) => this.dependencies.deleteRemote(ssh, uuid));

    let tabletLibraryRefreshed = false;
    try {
      deleteLocal();
    } finally {
      tabletLibraryRefreshed = await this.refreshTabletLibrary();
    }
    return { tabletLibraryRefreshed };
  }

  /** Delete the tablet copy, archive the existing local copy, and refresh. */
  async archiveDocument(
    uuid: string,
    localSyncDir: string,
    archiveLocal: () => void,
  ): Promise<TabletDocumentResult> {
    await this.withSSH((ssh) => this.dependencies.archiveRemote(ssh, localSyncDir, uuid));

    let tabletLibraryRefreshed = false;
    try {
      archiveLocal();
    } finally {
      tabletLibraryRefreshed = await this.refreshTabletLibrary();
    }
    return { tabletLibraryRefreshed };
  }
}
