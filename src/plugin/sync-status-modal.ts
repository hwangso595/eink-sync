/**
 * Sync Status Detail Modal.
 *
 * Opened by clicking the status bar widget. Shows detailed sync health:
 * - Last sync time
 * - Number of pending documents
 * - Connection health
 * - Document-level sync status breakdown
 * - Quick actions (refresh, run extraction)
 *
 * Uses Obsidian's native Modal and Setting components.
 * No custom colors -- all Obsidian CSS variables.
 */

import { App, Modal, Setting } from 'obsidian';
import type ReMarkableBridgePlugin from './plugin';
import type { LibraryDocument, LibrarySyncSummary } from './library-types';
import { buildLibrary, buildSyncSummary } from './library-data';
import { resolvePath, formatRelativeTime } from './helpers';

export class SyncStatusModal extends Modal {
  private plugin: ReMarkableBridgePlugin;
  /** Documents loaded once on open and shared across render methods. */
  private loadedDocuments: LibraryDocument[] = [];

  constructor(app: App, plugin: ReMarkableBridgePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('eink-sync-status-modal');

    new Setting(contentEl).setName('Sync Status').setHeading();

    const { summary, documents } = this.buildCurrentSummary();
    this.loadedDocuments = documents;
    this.renderConnectionStatus(contentEl, summary);
    this.renderSyncDetails(contentEl, summary);
    this.renderDocumentBreakdown(contentEl, summary);
    this.renderActions(contentEl);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private buildCurrentSummary(): { summary: LibrarySyncSummary; documents: LibraryDocument[] } {
    const emptySummary: LibrarySyncSummary = {
      totalDocuments: 0,
      pendingDocuments: 0,
      errorDocuments: 0,
      totalHighlights: 0,
      lastSyncTime: this.plugin.settings.lastSyncTimestamp,
      connectionHealthy: false,
    };

    const syncFolder = this.plugin.settings.syncFolder;
    if (!syncFolder) {
      return { summary: emptySummary, documents: [] };
    }

    const outputPath = resolvePath(this.app, this.plugin.settings.highlightsFolder);

    try {
      const { documents } = buildLibrary(resolvePath(this.app, syncFolder), outputPath);
      const summary = buildSyncSummary(
        documents,
        this.plugin.settings.lastSyncTimestamp,
        this.plugin.settings.setupComplete,
      );
      return { summary, documents };
    } catch {
      return { summary: emptySummary, documents: [] };
    }
  }

  private renderConnectionStatus(container: HTMLElement, summary: LibrarySyncSummary): void {
    const statusRow = container.createDiv({ cls: 'eink-sync-status-row' });

    const indicator = statusRow.createSpan({ cls: 'eink-sync-status-indicator' });
    const dotCls = summary.connectionHealthy ? 'eink-sync-dot--synced' : 'eink-sync-dot--error';
    indicator.createSpan({ cls: `eink-sync-dot ${dotCls}` });

    statusRow.createSpan({
      cls: 'eink-sync-status-text',
      text: summary.connectionHealthy ? 'Setup complete' : 'Not configured',
    });
  }

  private renderSyncDetails(container: HTMLElement, summary: LibrarySyncSummary): void {
    const details = container.createDiv({ cls: 'eink-sync-details' });

    // Last sync time
    this.renderDetailRow(details, 'Last sync', this.formatSyncTime(summary.lastSyncTime));

    // Total documents
    this.renderDetailRow(details, 'Documents', `${summary.totalDocuments}`);

    // Total highlights
    this.renderDetailRow(details, 'Highlights', `${summary.totalHighlights}`);

    // Last extraction
    const lastExtraction = this.plugin.getPluginData().lastExtractionTimestamp;
    this.renderDetailRow(
      details,
      'Last extraction',
      this.formatSyncTime(lastExtraction),
    );

    // Pending
    if (summary.pendingDocuments > 0) {
      this.renderDetailRow(
        details,
        'Pending',
        `${summary.pendingDocuments} document${summary.pendingDocuments !== 1 ? 's' : ''}`,
      );
    }

    // Errors
    if (summary.errorDocuments > 0) {
      this.renderDetailRow(
        details,
        'Errors',
        `${summary.errorDocuments} document${summary.errorDocuments !== 1 ? 's' : ''}`,
      );
    }
  }

  private renderDetailRow(container: HTMLElement, label: string, value: string): void {
    const row = container.createDiv({ cls: 'remarkable-info-row' });
    row.createSpan({ cls: 'remarkable-info-label', text: label });
    row.createSpan({ cls: 'remarkable-info-value', text: value });
  }

  private renderDocumentBreakdown(container: HTMLElement, summary: LibrarySyncSummary): void {
    if (summary.totalDocuments === 0) return;

    new Setting(container).setName('Document Types').setHeading();

    // Reuse documents loaded in buildCurrentSummary() -- no second filesystem scan.
    const typeCounts = new Map<string, number>();
    for (const doc of this.loadedDocuments) {
      const count = typeCounts.get(doc.type) ?? 0;
      typeCounts.set(doc.type, count + 1);
    }

    const breakdown = container.createDiv({ cls: 'eink-sync-details' });
    for (const [type, count] of typeCounts) {
      this.renderDetailRow(breakdown, type.toUpperCase(), `${count}`);
    }
  }

  private renderActions(container: HTMLElement): void {
    new Setting(container).setName('Actions').setHeading();

    new Setting(container)
      .setName('Run extraction')
      .setDesc('Extract highlights from all synced documents.')
      .addButton((btn) => {
        btn.setButtonText('Extract').setCta().onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Extracting...');
          try {
            await this.plugin.runExtraction();
            btn.setButtonText('Done');
            // Refresh the modal content
            setTimeout(() => this.onOpen(), 1500);
          } catch {
            btn.setButtonText('Failed');
          }
        });
      });

    new Setting(container)
      .setName('Open library')
      .setDesc('Browse all synced documents in the sidebar.')
      .addButton((btn) => {
        btn.setButtonText('Open').onClick(() => {
          this.plugin.activateLibraryView();
          this.close();
        });
      });

    new Setting(container)
      .setName('Test connection')
      .setDesc('Verify SSH connectivity to your reMarkable.')
      .addButton((btn) => {
        btn.setButtonText('Test').onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Testing...');
          try {
            const ok = await this.plugin.testConnection();
            btn.setButtonText(ok ? 'Connected' : 'Failed');
          } catch {
            btn.setButtonText('Error');
          }
          setTimeout(() => {
            btn.setDisabled(false);
            btn.setButtonText('Test');
          }, 3000);
        });
      });
  }

  private formatSyncTime(timestamp: number | null): string {
    return formatRelativeTime(timestamp, 'long');
  }
}
