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

import { Notice } from 'obsidian';
import { logger } from '../utils/logger';
import type { ConnectionTestResult } from '../ssh/connection-manager';

/**
 * After this many consecutive unreachable auto-sync cycles, surface a single
 * Notice. We don't notify on every cycle (that would spam every interval), and
 * we don't notify on the first miss (the tablet sleeps constantly — a single
 * miss is normal). Sustained failure is what the user needs to know about.
 */
const UNREACHABLE_NOTICE_THRESHOLD = 3;

/** Narrow interface describing what SyncCoordinator needs from the plugin. */
export interface SyncCoordinatorDeps {
  settings: {
    autoSyncEnabled: boolean;
    autoSyncIntervalMinutes: number;
    syncMethod: string;
    connectionMethod: string;
    setupComplete: boolean;
    tabletIp: string;
  };
  testConnectionDetailed(): Promise<ConnectionTestResult>;
  syncViaSftp(): Promise<unknown>;
  updateStatusBar(state: 'idle' | 'syncing' | 'error'): void;
  recordSyncError(err: unknown): void;
  clearSyncError(): void;
  /** Pass-through to Plugin#registerInterval so the timer is cleared on unload. */
  registerInterval(handle: number): number;
}

export class SyncCoordinator {
  /** Handle for the auto-sync timer (SFTP periodic sync). */
  private autoSyncTimerHandle: number | null = null;
  /** Whether an auto-sync is currently in progress (prevents overlapping runs). */
  private autoSyncInProgress = false;
  /** Count of consecutive cycles where the tablet was unreachable. */
  private consecutiveUnreachable = 0;
  /** Whether we've already shown the "auto-sync paused" Notice this outage. */
  private unreachableNotified = false;

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

    const handle = window.setInterval(async () => {
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
        // Check reachability, keeping the specific reason if it fails.
        const result = await this.plugin.testConnectionDetailed();
        if (!result.ok) {
          this.consecutiveUnreachable++;
          this.plugin.recordSyncError(result.error ?? new Error('Tablet not reachable'));
          this.plugin.updateStatusBar('error');
          logger.debug(
            `Auto-sync: tablet not reachable (${this.consecutiveUnreachable} in a row), skipping`,
          );
          // Surface one Notice once the failure is clearly sustained, not on
          // every cycle and not on a single expected sleep-miss.
          if (
            this.consecutiveUnreachable >= UNREACHABLE_NOTICE_THRESHOLD &&
            !this.unreachableNotified
          ) {
            this.unreachableNotified = true;
            const reason = result.error?.message ?? 'connection timed out';
            new Notice(
              `E-Ink Sync: can't reach your reMarkable at ${this.plugin.settings.tabletIp} ` +
              `(${reason}). Auto-sync is paused until it's reachable. ` +
              `If you changed Wi-Fi networks, update the tablet IP in settings.`,
              10000,
            );
          }
          return;
        }

        // Recovered (or first success): reset failure tracking.
        this.consecutiveUnreachable = 0;
        this.unreachableNotified = false;

        logger.info('Auto-sync: tablet reachable, starting SFTP sync');
        this.plugin.updateStatusBar('syncing');

        await this.plugin.syncViaSftp();

        this.plugin.updateStatusBar('idle');
        logger.info('Auto-sync: complete');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Auto-sync failed: ${msg}`);
        this.plugin.recordSyncError(err);
        this.plugin.updateStatusBar('error');
      } finally {
        this.autoSyncInProgress = false;
      }
    }, intervalMs);
    this.autoSyncTimerHandle = handle;
    this.plugin.registerInterval(handle);
  }

  /** Stop the auto-sync timer. */
  stop(): void {
    if (this.autoSyncTimerHandle !== null) {
      window.clearInterval(this.autoSyncTimerHandle);
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
