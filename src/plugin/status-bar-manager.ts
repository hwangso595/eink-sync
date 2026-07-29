/**
 * StatusBarManager -- manages the Obsidian status bar item for the plugin.
 *
 * Extracted from plugin.ts. Handles rendering status text/icons, periodic
 * health checks, and document count caching.
 */

import type { App } from 'obsidian';
import { SyncStatusModal } from './sync-status-modal';
import { buildLibrary } from './library-data';
import { resolvePath, formatRelativeTime } from './helpers';
import type { SyncSource } from './settings';
import type ReMarkableBridgePlugin from './plugin';

type StatusState = 'idle' | 'connected' | 'syncing' | 'extracting' | 'error' | 'disconnected';

export class StatusBarManager {
  private statusBarEl: HTMLElement | null = null;
  private statusCheckInterval: number | null = null;
  /** Cached document count to avoid synchronous FS reads on every status bar update. */
  private cachedDocCount: number | null = null;
  private cachedDocCountExpiry = 0;

  constructor(
    private plugin: ReMarkableBridgePlugin,
    private getApp: () => App,
    private getSettings: () => { showStatusBar: boolean; setupComplete: boolean; lastSyncTimestamp: number | null },
    private getSyncSources: () => SyncSource[],
    private onStatusCheck: () => void,
  ) {}

  /** Create and show the status bar element. */
  init(): void {
    if (!this.ensureStatusBarElement()) return;
    this.update('idle');
  }

  /** Create the item on demand and recover if Obsidian detached its element. */
  private ensureStatusBarElement(): boolean {
    if (this.statusBarEl && !this.statusBarEl.isConnected) {
      this.statusBarEl = null;
    }
    if (this.statusBarEl) return true;
    if (!this.getSettings().showStatusBar) return false;

    this.statusBarEl = this.plugin.addStatusBarItem();
    this.statusBarEl.addClass('remarkable-status-bar');
    this.statusBarEl.addEventListener('click', () => {
      new SyncStatusModal(this.getApp(), this.plugin).open();
    });
    return true;
  }

  /** Update the status bar state and optional active-operation detail. */
  update(state: StatusState, detail?: string): void {
    if (!this.ensureStatusBarElement() || !this.statusBarEl) return;
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
      text: ` ${detail ? `rM ${detail}` : shortLabels[state]}`,
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

    // When something is wrong, put the specific reason in the tooltip instead
    // of a generic "click for details"; a stale-IP timeout should be legible
    // on hover, not buried.
    let tooltip = detail ?? 'Click for sync details';
    if (state === 'error' || state === 'disconnected') {
      const lastErr = this.plugin.getLastSyncError();
      if (lastErr) {
        const firstLine = lastErr.message.split('\n')[0];
        tooltip = `Sync issue: ${firstLine}; click for details`;
      }
    }
    this.statusBarEl.setAttribute('aria-label', tooltip);
  }

  /** Show or hide the status bar item based on settings. */
  updateVisibility(): void {
    const settings = this.getSettings();
    if (settings.showStatusBar && !this.statusBarEl) {
      this.ensureStatusBarElement();
      this.update('idle');
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
    const handle = window.setInterval(() => {
      this.invalidateCache();
      this.update('idle');
      this.onStatusCheck();
    }, 60_000);
    this.statusCheckInterval = handle;
    this.plugin.registerInterval(handle);
  }

  /** Stop periodic status checks. */
  stopChecks(): void {
    if (this.statusCheckInterval !== null) {
      window.clearInterval(this.statusCheckInterval);
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
