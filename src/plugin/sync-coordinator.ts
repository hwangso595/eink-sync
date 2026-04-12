/**
 * SyncCoordinator -- manages auto-sync timer and coordinates SFTP sync runs.
 *
 * Extracted from plugin.ts to isolate sync-related orchestration logic.
 * The coordinator owns the periodic auto-sync timer and delegates actual
 * sync operations to the SyncProvider abstraction.
 *
 * Depends on a narrow interface rather than the full plugin to improve
 * testability and make dependencies explicit.
 */

import { logger } from '../utils/logger';

/** Narrow interface describing what SyncCoordinator needs from the plugin. */
export interface SyncCoordinatorDeps {
  settings: {
    autoSyncEnabled: boolean;
    autoSyncIntervalMinutes: number;
    syncMethod: string;
    connectionMethod: string;
    setupComplete: boolean;
  };
  testConnection(): Promise<boolean>;
  syncViaSftp(): Promise<unknown>;
  updateStatusBar(state: 'idle' | 'syncing' | 'error'): void;
}

export class SyncCoordinator {
  /** Handle for the auto-sync timer (SFTP periodic sync). */
  private autoSyncTimerHandle: ReturnType<typeof setInterval> | null = null;
  /** Whether an auto-sync is currently in progress (prevents overlapping runs). */
  private autoSyncInProgress = false;

  constructor(private plugin: SyncCoordinatorDeps) {}

  /**
   * Start the auto-sync timer.
   * Pings the tablet first; if reachable, runs SFTP sync + extraction.
   * Prevents overlapping runs via the autoSyncInProgress flag.
   */
  start(): void {
    this.stop();

    const intervalMs = (this.plugin.settings.autoSyncIntervalMinutes ?? 15) * 60 * 1000;
    if (intervalMs <= 0) return;

    logger.info(`Auto-sync timer started: every ${this.plugin.settings.autoSyncIntervalMinutes} minutes`);

    this.autoSyncTimerHandle = setInterval(async () => {
      if (this.autoSyncInProgress) {
        logger.debug('Auto-sync: previous run still in progress, skipping');
        return;
      }

      if (this.plugin.settings.syncMethod !== 'sftp') {
        logger.debug('Auto-sync: not in SFTP mode, skipping');
        return;
      }

      // Respect USB-only mode: don't auto-sync over WiFi
      if (this.plugin.settings.connectionMethod === 'usb') {
        logger.debug('Auto-sync: USB-only mode, skipping (auto-sync requires WiFi)');
        return;
      }

      this.autoSyncInProgress = true;
      try {
        // Quick ping to check if tablet is reachable
        const reachable = await this.plugin.testConnection();
        if (!reachable) {
          logger.debug('Auto-sync: tablet not reachable, skipping');
          return;
        }

        logger.info('Auto-sync: tablet reachable, starting SFTP sync');
        this.plugin.updateStatusBar('syncing');

        await this.plugin.syncViaSftp();

        this.plugin.updateStatusBar('idle');
        logger.info('Auto-sync: complete');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Auto-sync failed: ${msg}`);
        this.plugin.updateStatusBar('error');
      } finally {
        this.autoSyncInProgress = false;
      }
    }, intervalMs);
  }

  /** Stop the auto-sync timer. */
  stop(): void {
    if (this.autoSyncTimerHandle) {
      clearInterval(this.autoSyncTimerHandle);
      this.autoSyncTimerHandle = null;
      logger.info('Auto-sync timer stopped');
    }
  }

  /** Toggle the auto-sync timer based on current settings. */
  toggle(): void {
    if (
      this.plugin.settings.autoSyncEnabled &&
      this.plugin.settings.syncMethod === 'sftp' &&
      this.plugin.settings.setupComplete
    ) {
      this.start();
    } else {
      this.stop();
    }
  }
}
