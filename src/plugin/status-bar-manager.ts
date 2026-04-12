/**
 * StatusBarManager -- manages the Obsidian status bar item for the plugin.
 *
 * Extracted from plugin.ts. Handles rendering status text/icons, periodic
 * health checks, and document count caching.
 */

import type { Plugin } from 'obsidian';
import { SyncStatusModal } from './sync-status-modal';
import { buildLibrary } from './library-data';
import { resolvePath, formatRelativeTime } from './helpers';
import type { SyncSource } from './settings';

type StatusState = 'idle' | 'connected' | 'syncing' | 'extracting' | 'error' | 'disconnected';

export class StatusBarManager {
  private statusBarEl: HTMLElement | null = null;
  private statusCheckInterval: ReturnType<typeof setInterval> | null = null;
  /** Cached document count to avoid synchronous FS reads on every status bar update. */
  private cachedDocCount: number | null = null;
  private cachedDocCountExpiry = 0;

  constructor(
    private plugin: Plugin,
    private getApp: () => any,
    private getSettings: () => { showStatusBar: boolean; setupComplete: boolean; lastSyncTimestamp: number | null },
    private getSyncSources: () => SyncSource[],
    private onStatusCheck: () => void,
  ) {}

  /** Create and show the status bar element. */
  init(): void {
    const settings = this.getSettings();
    if (!settings.showStatusBar) return;

    this.statusBarEl = this.plugin.addStatusBarItem();
    this.statusBarEl.addClass('remarkable-status-bar');
    this.update('idle');

    this.statusBarEl.addEventListener('click', () => {
      new SyncStatusModal(this.getApp(), this.plugin as any).open();
    });
  }

  /** Update the status bar text based on current state. */
  update(state: StatusState): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();

    const icons: Record<string, string> = {
      idle: '\u25CB',
      connected: '\u25CF',
      syncing: '\u21BB',
      extracting: '\u2699',
      error: '\u26A0',
      disconnected: '\u25CB',
    };

    const shortLabels: Record<string, string> = {
      idle: 'rM',
      connected: 'rM',
      syncing: 'rM syncing',
      extracting: 'rM extracting',
      error: 'rM error',
      disconnected: 'rM',
    };

    const dotSpan = this.statusBarEl.createSpan({
      cls: `remarkable-statusbar-dot remarkable-statusbar-dot--${state}`,
    });
    dotSpan.setText(icons[state]);

    this.statusBarEl.createSpan({
      cls: 'remarkable-statusbar-label',
      text: ` ${shortLabels[state]}`,
    });

    if (state !== 'error' && state !== 'disconnected') {
      const summary = this.getQuickSyncSummary();
      if (summary) {
        if (summary.totalDocuments > 0) {
          this.statusBarEl.createSpan({
            cls: 'remarkable-statusbar-docs',
            text: ` ${summary.totalDocuments} docs`,
          });
        }
        if (summary.lastSyncTime) {
          const ago = formatRelativeTime(summary.lastSyncTime, 'short');
          this.statusBarEl.createSpan({
            cls: 'remarkable-statusbar-sync-time',
            text: ` \u00B7 ${ago}`,
          });
        }
      }
    }

    this.statusBarEl.setAttribute('aria-label', 'Click for sync details');
  }

  /** Show or hide the status bar item based on settings. */
  updateVisibility(): void {
    const settings = this.getSettings();
    if (settings.showStatusBar && !this.statusBarEl) {
      this.statusBarEl = this.plugin.addStatusBarItem();
      this.statusBarEl.addClass('remarkable-status-bar');
      this.update('idle');
      this.statusBarEl.addEventListener('click', () => {
        new SyncStatusModal(this.getApp(), this.plugin as any).open();
      });
      if (settings.setupComplete) {
        this.startChecks();
      }
    } else if (!settings.showStatusBar && this.statusBarEl) {
      this.statusBarEl.remove();
      this.statusBarEl = null;
      this.stopChecks();
    }
  }

  /** Start periodic status checks. */
  startChecks(): void {
    if (this.statusCheckInterval) return;
    this.statusCheckInterval = setInterval(() => {
      this.invalidateCache();
      this.update('idle');
      this.onStatusCheck();
    }, 60_000);
  }

  /** Stop periodic status checks. */
  stopChecks(): void {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
  }

  /** Invalidate the cached document count. */
  invalidateCache(): void {
    this.cachedDocCount = null;
    this.cachedDocCountExpiry = 0;
  }

  private getQuickSyncSummary(): { totalDocuments: number; lastSyncTime: number | null } | null {
    const sources = this.getSyncSources();
    if (sources.length === 0) return null;

    const now = Date.now();
    if (this.cachedDocCount !== null && now < this.cachedDocCountExpiry) {
      return {
        totalDocuments: this.cachedDocCount,
        lastSyncTime: this.getSettings().lastSyncTimestamp,
      };
    }

    try {
      let totalDocs = 0;
      for (const source of sources) {
        if (!source.syncFolder) continue;
        const { documents } = buildLibrary(resolvePath(this.getApp(), source.syncFolder), null);
        totalDocs += documents.length;
      }
      this.cachedDocCount = totalDocs;
      this.cachedDocCountExpiry = now + 30_000;
      return {
        totalDocuments: totalDocs,
        lastSyncTime: this.getSettings().lastSyncTimestamp,
      };
    } catch {
      return null;
    }
  }
}
