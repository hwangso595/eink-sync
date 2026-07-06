/**
 * Library View -- sidebar panel listing all synced reMarkable documents.
 *
 * Extends Obsidian's ItemView to create a native-feeling sidebar panel.
 * Documents are grouped by folder (reconstructed from UUID/.metadata
 * hierarchy), searchable, and sortable.
 *
 * Design direction: editorial and minimal, like a file explorer.
 * Uses Obsidian CSS variables exclusively -- no custom colors.
 * Respects dark/light theme automatically.
 *
 * Privacy: All data comes from the local synced folder. Zero network calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ItemView, TFile, WorkspaceLeaf, setIcon, Menu, Notice, Setting } from 'obsidian';
import { logger } from '../utils/logger';
import type ReMarkableBridgePlugin from './plugin';
import type {
  LibraryDocument,
  LibraryFolder,
  SortConfig,
  SortField,
  DocumentSyncStatus,
} from './library-types';
import {
  buildLibrary,
  sortDocuments,
  filterDocuments,
} from './library-data';
import { resolvePath, formatRelativeTime, sanitizeFilename } from './helpers';
import { isValidUuid } from './uuid-validation';
import type { SSHExecutor } from '../ssh/ssh-client';
import type { SyncProgressCallback } from '../sync/sync-provider';

/** View type identifier for Obsidian's view registry. */
export const LIBRARY_VIEW_TYPE = 'remarkable-library-view';

export class ReMarkableLibraryView extends ItemView {
  private plugin: ReMarkableBridgePlugin;
  private documents: LibraryDocument[] = [];
  private rootFolder: LibraryFolder | null = null;
  private searchQuery = '';
  private sortConfig: SortConfig = { field: 'name', direction: 'asc' };
  private collapsedFolders = new Set<string>();
  private contentContainer: HTMLElement | null = null;
  /** Timer handle for debouncing search input. */
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounce delay in milliseconds for search keystrokes. */
  private static readonly SEARCH_DEBOUNCE_MS = 200;
  /** Current source filter: 'all' or a source ID. */
  private sourceFilter = 'all';
  /** Reference to the source filter dropdown for updating options. */
  private sourceFilterEl: HTMLSelectElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ReMarkableBridgePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return LIBRARY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'reMarkable Library';
  }

  getIcon(): string {
    return 'remarkable-tablet';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('remarkable-library');

    this.renderToolbar(container);

    this.contentContainer = container.createDiv({
      cls: 'remarkable-library-content',
    });

    await this.refreshLibrary();
  }

  async onClose(): Promise<void> {
    // Cleanup handled by Obsidian
  }

  /**
   * Refresh the library data from disk and re-render.
   * Called on open and when the user triggers a manual refresh.
   */
  /** Trigger sync (SFTP or Syncthing), extract highlights, then refresh the library. */
  private async syncAndRefresh(btn: HTMLElement): Promise<void> {
    btn.addClass('is-loading');

    if (this.contentContainer) {
      this.contentContainer.empty();
      const progress = this.contentContainer.createDiv({ cls: 'remarkable-library-sync-progress' });
      const statusEl = progress.createDiv({ cls: 'remarkable-wizard-status is-loading' });

      await this.syncWithProgress(statusEl);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    btn.removeClass('is-loading');
    await this.refreshLibrary();
  }

  /**
   * Run sync via the unified SyncProvider, then extract highlights.
   * The provider handles SFTP vs Syncthing differences internally.
   */
  private async syncWithProgress(statusEl: HTMLElement): Promise<void> {
    const isSftp = (this.plugin.settings.syncMethod ?? 'sftp') === 'sftp';
    const sources = this.plugin.getSyncSources();

    if (sources.length === 0) {
      statusEl.setText('No sync sources configured. Open Settings to add a source.');
      statusEl.removeClass('is-loading', 'is-success');
      statusEl.addClass('is-error');
      return;
    }

    statusEl.setText(isSftp ? 'Connecting to tablet via SFTP...' : 'Asking Syncthing to check for changes...');

    const onSyncProgress: SyncProgressCallback = (phase, detail, current, total) => {
      switch (phase) {
        case 'connecting':
          statusEl.setText('Connecting to tablet...');
          break;
        case 'listing':
          statusEl.setText('Reading file list from tablet...');
          break;
        case 'comparing':
          statusEl.setText(detail);
          break;
        case 'downloading':
          statusEl.setText(current && total ? `Downloading ${current}/${total}: ${detail}` : detail);
          break;
        case 'scanning':
        case 'waiting':
        case 'complete':
          statusEl.setText(detail);
          break;
        case 'error':
          statusEl.setText(`Sync error: ${detail}`);
          break;
        default:
          statusEl.setText(detail);
          break;
      }
    };

    try {
      // Sync every configured source, not just the first. Aggregate the
      // outcome so the UI reflects the whole set.
      let allSuccess = true;
      let firstError = '';
      let totalErrors = 0;
      let anyTransferred = false;
      const summaries: string[] = [];

      for (const source of sources) {
        const provider = this.plugin.getSyncProvider(source.id);
        const syncResult = await provider.sync(onSyncProgress);
        if (!syncResult.success) {
          allSuccess = false;
          if (!firstError && syncResult.errors[0]) firstError = syncResult.errors[0];
        }
        totalErrors += syncResult.errors.length;
        if (syncResult.filesDownloaded > 0 || syncResult.filesSkipped > 0) anyTransferred = true;
        summaries.push(syncResult.summary);
      }

      // A failed transfer/API call must not be reported as success. Providers
      // return failures in-band (they don't throw), so branch on success.
      if (!allSuccess) {
        const detail = firstError ? ` (${firstError})` : '';
        statusEl.setText(`Sync failed${detail}.`);
        statusEl.removeClass('is-loading', 'is-success');
        statusEl.addClass('is-error');
        return;
      }

      const partialSuffix = totalErrors > 0
        ? ` (${totalErrors} file error(s) — see console)`
        : '';
      const summary = sources.length === 1 ? summaries[0] : `Synced ${sources.length} sources.`;

      // Run extraction for Syncthing always; for SFTP only if something transferred.
      if (!isSftp || anyTransferred) {
        statusEl.removeClass('is-success', 'is-error');
        statusEl.addClass('is-loading');
        statusEl.setText('Extracting highlights and annotations...');

        try {
          const extractionResult = await this.plugin.runExtraction(true);
          if (extractionResult.totalHighlights > 0 || extractionResult.documentsProcessed > 0) {
            statusEl.setText(
              `Done! ${summary} ` +
              `${extractionResult.totalHighlights} highlight(s) from ${extractionResult.documentsProcessed} document(s).${partialSuffix}`,
            );
          } else {
            statusEl.setText(`${summary} No new highlights found.${partialSuffix}`);
          }
          statusEl.removeClass('is-loading');
          statusEl.addClass('is-success');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          statusEl.setText(`Extraction failed: ${msg}`);
          statusEl.removeClass('is-loading');
          statusEl.addClass('is-error');
        }
      } else {
        statusEl.setText(`${summary}${partialSuffix}`);
        statusEl.removeClass('is-loading');
        statusEl.addClass('is-success');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.setText(`Sync failed: ${msg}`);
      statusEl.removeClass('is-loading');
      statusEl.addClass('is-error');
    }
  }

  async refreshLibrary(): Promise<void> {
    const sources = this.plugin.getSyncSources();

    if (sources.length === 0) {
      this.renderEmptyState('No sync sources configured. Open Settings to add a source.');
      return;
    }

    // Filter to selected source if not "all"
    const activeSources = this.sourceFilter === 'all'
      ? sources
      : sources.filter((s) => s.id === this.sourceFilter);

    const archivePath = resolvePath(this.plugin.app, this.plugin.settings.archiveFolder);
    const outputPath = resolvePath(this.plugin.app, this.plugin.settings.highlightsFolder);

    try {
      let allSyncDocs: LibraryDocument[] = [];
      let rootFolder: LibraryFolder | null = null;

      // Build from each source's sync folder
      for (const source of activeSources) {
        if (!source.syncFolder) continue;

        const syncPath = resolvePath(this.plugin.app, source.syncFolder);

        // Determine output path for this source
        let sourceOutputPath = outputPath;
        if (source.highlightsSubfolder) {
          sourceOutputPath = resolvePath(
            this.plugin.app,
            `${this.plugin.settings.highlightsFolder}/${source.highlightsSubfolder}`,
          );
        }

        const { documents: syncDocs, folders } = buildLibrary(syncPath, sourceOutputPath);

        // Tag documents with source info (stored on the existing folderPath for display)
        if (sources.length > 1) {
          for (const doc of syncDocs) {
            doc.sourceLabel = source.label;
            doc.sourceId = source.id;
          }
        }

        allSyncDocs.push(...syncDocs);

        // Use the first source's folder tree as root, or merge
        if (!rootFolder) {
          rootFolder = folders;
        } else {
          // Merge additional source's documents into root
          rootFolder.documents.push(...folders.documents);
          rootFolder.children.push(...folders.children);
        }
      }

      // Build from archive folder (only when showing "all" sources)
      let archivedDocs: LibraryDocument[] = [];
      if (this.sourceFilter === 'all') {
        if (fs.existsSync(archivePath)) {
          try {
            const { documents: archDocs } = buildLibrary(archivePath, outputPath);
            archivedDocs = archDocs.map(d => ({ ...d, syncStatus: 'archived' as DocumentSyncStatus }));
          } catch (archErr) {
            logger.warn('Archive scan failed:', archErr);
          }
        }
      }

      logger.info(`Library: ${allSyncDocs.length} active, ${archivedDocs.length} archived`);
      this.documents = [...allSyncDocs, ...archivedDocs];
      this.rootFolder = rootFolder;

      // Update source filter dropdown options
      this.updateSourceFilterOptions();

      if (this.documents.length === 0) {
        this.renderEmptyState('No documents found. Sync your reMarkable to see documents here.');
      } else {
        this.renderDocumentList();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.renderEmptyState(`Failed to load library: ${msg}`);
    }
  }

  /** Update the source filter dropdown options to reflect current sources. */
  private updateSourceFilterOptions(): void {
    if (!this.sourceFilterEl) return;
    const sources = this.plugin.getSyncSources();

    // Only show filter if there are multiple sources
    const filterContainer = this.sourceFilterEl.parentElement;
    if (filterContainer) {
      filterContainer.toggle(sources.length > 1);
    }

    // Preserve current selection
    const current = this.sourceFilterEl.value;
    this.sourceFilterEl.empty();

    const allOpt = this.sourceFilterEl.createEl('option', { value: 'all', text: 'All sources' });
    if (current === 'all') allOpt.selected = true;

    for (const source of sources) {
      const opt = this.sourceFilterEl.createEl('option', {
        value: source.id,
        text: source.label,
      });
      if (current === source.id) opt.selected = true;
    }
  }

  // -------------------------------------------------------------------
  // Toolbar: search, sort, refresh
  // -------------------------------------------------------------------

  private renderToolbar(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: 'remarkable-library-toolbar' });

    // Search input
    const searchWrap = toolbar.createDiv({ cls: 'remarkable-library-search' });
    const searchIcon = searchWrap.createSpan({ cls: 'remarkable-library-search-icon' });
    setIcon(searchIcon, 'search');

    const searchInput = searchWrap.createEl('input', {
      cls: 'remarkable-library-search-input',
      attr: {
        type: 'text',
        placeholder: 'Search documents...',
        'aria-label': 'Search reMarkable documents',
      },
    });
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      if (this.searchDebounceTimer) {
        clearTimeout(this.searchDebounceTimer);
      }
      this.searchDebounceTimer = setTimeout(() => {
        this.renderDocumentList();
      }, ReMarkableLibraryView.SEARCH_DEBOUNCE_MS);
    });

    // Source filter (only visible when multiple sources exist)
    const sourceFilterWrap = toolbar.createDiv({ cls: 'remarkable-library-source-filter' });
    const sourceFilterLabel = sourceFilterWrap.createSpan({
      cls: 'remarkable-library-sort-label',
      text: 'Source:',
    });
    sourceFilterLabel.setAttribute('aria-hidden', 'true');

    this.sourceFilterEl = sourceFilterWrap.createEl('select', {
      cls: 'remarkable-library-sort-select dropdown',
      attr: { 'aria-label': 'Filter by source' },
    });

    // Populate options initially
    const sources = this.plugin.getSyncSources();
    this.sourceFilterEl.createEl('option', { value: 'all', text: 'All sources' });
    for (const source of sources) {
      this.sourceFilterEl.createEl('option', { value: source.id, text: source.label });
    }

    // Hide if only one source
    if (sources.length <= 1) {
      sourceFilterWrap.hide();
    }

    this.sourceFilterEl.addEventListener('change', () => {
      this.sourceFilter = this.sourceFilterEl!.value;
      this.refreshLibrary();
    });

    // Controls row: sort + refresh
    const controls = toolbar.createDiv({ cls: 'remarkable-library-controls' });

    // Sort dropdown
    const sortWrap = controls.createDiv({ cls: 'remarkable-library-sort' });
    const sortLabel = sortWrap.createSpan({
      cls: 'remarkable-library-sort-label',
      text: 'Sort:',
    });
    sortLabel.setAttribute('aria-hidden', 'true');

    const sortSelect = sortWrap.createEl('select', {
      cls: 'remarkable-library-sort-select dropdown',
      attr: { 'aria-label': 'Sort documents by' },
    });

    const sortOptions: { value: SortField; label: string }[] = [
      { value: 'name', label: 'Name' },
      { value: 'lastModified', label: 'Modified' },
      { value: 'type', label: 'Type' },
      { value: 'highlightCount', label: 'Highlights' },
    ];

    for (const opt of sortOptions) {
      const optEl = sortSelect.createEl('option', {
        value: opt.value,
        text: opt.label,
      });
      if (opt.value === this.sortConfig.field) {
        optEl.selected = true;
      }
    }

    sortSelect.addEventListener('change', () => {
      this.sortConfig.field = sortSelect.value as SortField;
      this.renderDocumentList();
    });

    // Sort direction toggle
    const dirBtn = controls.createEl('button', {
      cls: 'remarkable-library-sort-dir clickable-icon',
      attr: {
        'aria-label': 'Toggle sort direction',
      },
    });
    this.updateSortDirIcon(dirBtn);
    dirBtn.addEventListener('click', () => {
      this.sortConfig.direction = this.sortConfig.direction === 'asc' ? 'desc' : 'asc';
      this.updateSortDirIcon(dirBtn);
      this.renderDocumentList();
    });

    // Add document button
    const addBtn = controls.createEl('button', {
      cls: 'remarkable-library-add clickable-icon',
      attr: { 'aria-label': 'Send document to reMarkable' },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => {
      this.plugin.sendDocumentToRemarkable();
    });

    // Sync & Refresh button
    const refreshBtn = controls.createEl('button', {
      cls: 'remarkable-library-refresh clickable-icon',
      attr: { 'aria-label': 'Sync & refresh' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => {
      this.syncAndRefresh(refreshBtn);
    });
  }

  private updateSortDirIcon(btn: HTMLElement): void {
    btn.empty();
    setIcon(btn, this.sortConfig.direction === 'asc' ? 'arrow-up' : 'arrow-down');
  }

  // -------------------------------------------------------------------
  // Document list rendering
  // -------------------------------------------------------------------

  private renderDocumentList(): void {
    if (!this.contentContainer) return;
    this.contentContainer.empty();

    let filtered = filterDocuments(this.documents, this.searchQuery);
    filtered = sortDocuments(filtered, this.sortConfig);

    if (filtered.length === 0 && this.searchQuery) {
      this.renderEmptyState(`No documents match "${this.searchQuery}".`);
      return;
    }

    // If searching, show flat list; otherwise show folder tree + archived
    if (this.searchQuery) {
      this.renderFlatList(this.contentContainer, filtered);
    } else {
      if (this.rootFolder) {
        this.renderFolderTree(this.contentContainer, this.rootFolder);
      }

      // Show archived documents in a separate section
      const archived = filtered.filter(d => d.syncStatus === 'archived');
      if (archived.length > 0) {
        const archiveSection = this.contentContainer.createDiv({ cls: 'remarkable-library-archive-section' });
        new Setting(archiveSection).setName('Archived').setHeading();
        for (const doc of archived) {
          this.renderDocumentItem(archiveSection, doc, false);
        }
      }
    }

    // Document count footer
    const footer = this.contentContainer.createDiv({ cls: 'remarkable-library-footer' });
    footer.createSpan({
      cls: 'remarkable-library-count',
      text: `${filtered.length} document${filtered.length !== 1 ? 's' : ''}`,
    });
  }

  private renderFlatList(container: HTMLElement, documents: LibraryDocument[]): void {
    const list = container.createDiv({ cls: 'remarkable-library-list' });
    for (const doc of documents) {
      this.renderDocumentItem(list, doc, true);
    }
  }

  private renderFolderTree(container: HTMLElement, folder: LibraryFolder): void {
    // Render root-level documents first
    if (folder.documents.length > 0) {
      const sortedDocs = sortDocuments(folder.documents, this.sortConfig);
      const list = container.createDiv({ cls: 'remarkable-library-list' });
      for (const doc of sortedDocs) {
        this.renderDocumentItem(list, doc, false);
      }
    }

    // Render child folders
    for (const child of folder.children) {
      this.renderFolderNode(container, child, 0);
    }
  }

  private renderFolderNode(container: HTMLElement, folder: LibraryFolder, depth: number): void {
    // Skip empty folders (no docs and no non-empty children)
    const hasContent = folder.documents.length > 0 || folder.children.some(
      (c) => c.documents.length > 0 || c.children.length > 0,
    );
    if (!hasContent) return;

    const isCollapsed = this.collapsedFolders.has(folder.uuid);

    const folderEl = container.createDiv({ cls: 'remarkable-library-folder' });
    if (depth > 0) {
      // Dynamic indent via CSS custom property so styling stays themeable
      folderEl.style.setProperty('--eink-sync-folder-depth', String(depth));
    }

    // Folder header
    const header = folderEl.createDiv({
      cls: 'remarkable-library-folder-header tree-item-self',
    });

    const collapseIcon = header.createSpan({
      cls: 'remarkable-library-folder-collapse tree-item-icon collapse-icon',
    });
    setIcon(collapseIcon, 'chevron-down');
    // is-collapsed rotates the chevron to point right (CSS transform)
    if (isCollapsed) {
      collapseIcon.addClass('is-collapsed');
    }

    const folderIcon = header.createSpan({ cls: 'remarkable-library-folder-icon' });
    setIcon(folderIcon, 'folder');

    header.createSpan({
      cls: 'remarkable-library-folder-name',
      text: folder.name,
    });

    const docCount = this.countDocumentsRecursive(folder);
    header.createSpan({
      cls: 'remarkable-library-folder-count',
      text: `${docCount}`,
    });

    // Toggle collapse on click
    header.addEventListener('click', () => {
      if (this.collapsedFolders.has(folder.uuid)) {
        this.collapsedFolders.delete(folder.uuid);
      } else {
        this.collapsedFolders.add(folder.uuid);
      }
      this.renderDocumentList();
    });

    // Folder contents (if not collapsed)
    if (!isCollapsed) {
      const contents = folderEl.createDiv({ cls: 'remarkable-library-folder-contents' });

      // Documents in this folder
      if (folder.documents.length > 0) {
        const sortedDocs = sortDocuments(folder.documents, this.sortConfig);
        for (const doc of sortedDocs) {
          this.renderDocumentItem(contents, doc, false);
        }
      }

      // Child folders
      for (const child of folder.children) {
        this.renderFolderNode(contents, child, depth + 1);
      }
    }
  }

  private renderDocumentItem(
    container: HTMLElement,
    doc: LibraryDocument,
    showPath: boolean,
  ): void {
    const item = container.createDiv({ cls: 'remarkable-library-item tree-item-self' });

    // Type icon
    const iconEl = item.createSpan({ cls: 'remarkable-library-item-icon' });
    setIcon(iconEl, this.getDocTypeIcon(doc.type));

    // Document info
    const info = item.createDiv({ cls: 'remarkable-library-item-info' });

    // Name
    info.createDiv({
      cls: 'remarkable-library-item-name',
      text: doc.name,
    });

    // Metadata row
    const meta = info.createDiv({ cls: 'remarkable-library-item-meta' });

    // Type badge
    meta.createSpan({
      cls: 'remarkable-library-item-type',
      text: doc.type.toUpperCase(),
    });

    // Last modified
    meta.createSpan({
      cls: 'remarkable-library-item-date',
      text: this.formatDate(doc.lastModified),
    });

    // Highlight count (only show if > 0)
    if (doc.highlightCount > 0) {
      const hlSpan = meta.createSpan({ cls: 'remarkable-library-item-highlights' });
      const hlIcon = hlSpan.createSpan({ cls: 'remarkable-library-highlight-icon' });
      setIcon(hlIcon, 'highlighter');
      hlSpan.createSpan({ text: `${doc.highlightCount}` });
    }

    // Folder path (in search/flat mode)
    if (showPath && doc.folderPath) {
      meta.createSpan({
        cls: 'remarkable-library-item-path',
        text: doc.folderPath,
      });
    }

    // Sync status indicator
    const statusEl = item.createSpan({ cls: 'remarkable-library-item-status' });
    this.renderSyncStatusDot(statusEl, doc.syncStatus);

    const isArchived = doc.syncStatus === 'archived';

    // Click: open highlights first, fall back to source file
    item.addEventListener('click', () => {
      this.openHighlightNote(doc);
    });

    // Right-click: context menu
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = new Menu();

      menu.addItem((menuItem) => {
        menuItem
          .setTitle('Go to highlights')
          .setIcon('highlighter')
          .onClick(() => this.openHighlightNote(doc));
      });

      menu.addItem((menuItem) => {
        menuItem
          .setTitle('Open source file')
          .setIcon('file-text')
          .onClick(() => this.openSourceFile(doc));
      });

      menu.addItem((menuItem) => {
        menuItem
          .setTitle('Extract highlights')
          .setIcon('download')
          .onClick(() => this.extractSingleDocument(doc));
      });

      menu.addSeparator();

      if (isArchived) {
        menu.addItem((menuItem) => {
          menuItem
            .setTitle('Send back to reMarkable')
            .setIcon('upload')
            .onClick(() => this.unarchiveDocument(doc));
        });
      } else {
        menu.addItem((menuItem) => {
          menuItem
            .setTitle('Archive from tablet')
            .setIcon('archive')
            .onClick(() => this.archiveDocument(doc));
        });
      }

      menu.addItem((menuItem) => {
        menuItem
          .setTitle('Delete')
          .setIcon('trash-2')
          .onClick(() => this.deleteDocument(doc));
      });

      menu.showAtMouseEvent(e);
    });
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private getDocTypeIcon(type: string): string {
    switch (type) {
      case 'pdf':
        return 'file-text';
      case 'epub':
        return 'book-open';
      case 'notebook':
        return 'edit-3';
      default:
        return 'file';
    }
  }

  private formatDate(timestamp: number): string {
    if (!timestamp) return '';
    return formatRelativeTime(timestamp, 'long');
  }

  private renderSyncStatusDot(container: HTMLElement, status: DocumentSyncStatus): void {
    const dot = container.createSpan({
      cls: `eink-sync-dot eink-sync-dot--${status}`,
      attr: { 'aria-label': `Sync status: ${status}` },
    });
    dot.setAttribute('title', this.getSyncStatusLabel(status));
  }

  private getSyncStatusLabel(status: DocumentSyncStatus): string {
    switch (status) {
      case 'synced':
        return 'Synced';
      case 'pending':
        return 'Pending sync';
      case 'extracting':
        return 'Extracting...';
      case 'error':
        return 'Extraction error';
      case 'archived':
        return 'Archived (not on tablet)';
      case 'unknown':
        return 'Status unknown';
      default:
        return status;
    }
  }

  private countDocumentsRecursive(folder: LibraryFolder): number {
    let count = folder.documents.length;
    for (const child of folder.children) {
      count += this.countDocumentsRecursive(child);
    }
    return count;
  }

  private renderEmptyState(message: string): void {
    if (!this.contentContainer) return;
    this.contentContainer.empty();

    const empty = this.contentContainer.createDiv({ cls: 'remarkable-library-empty' });
    const iconEl = empty.createDiv({ cls: 'remarkable-library-empty-icon' });
    setIcon(iconEl, 'inbox');
    empty.createDiv({
      cls: 'remarkable-library-empty-text',
      text: message,
    });
  }

  /**
   * Open the source file (PDF/EPUB) for a document.
   * Checks both Sync and Archive folders.
   */
  private async openSourceFile(doc: LibraryDocument): Promise<void> {
    // Check all sync source folders + archive folder
    const sourceFolders = this.plugin.getSyncSources().map((s) => s.syncFolder);
    const folders = [
      ...sourceFolders,
      this.plugin.settings.archiveFolder,
    ];

    for (const folder of folders) {
      for (const ext of ['pdf', 'epub']) {
        const filePath = `${folder}/${doc.uuid}.${ext}`;
        const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          await this.plugin.app.workspace.getLeaf(false).openFile(file);
          return;
        }
      }
    }

    new Notice(`No source file found for "${doc.name}".`);
  }

  /** Open the highlight note directly (creates it if needed). */
  private async openHighlightNote(doc: LibraryDocument): Promise<void> {
    const highlightsFolder = this.plugin.settings.highlightsFolder;
    const safeName = sanitizeFilename(doc.name);
    const notePath = `${highlightsFolder}/${safeName}.md`;

    const noteFile = this.plugin.app.vault.getAbstractFileByPath(notePath);
    if (noteFile instanceof TFile) {
      await this.plugin.app.workspace.getLeaf(false).openFile(noteFile);
    } else {
      // Note doesn't exist yet — extract then open
      await this.extractSingleDocument(doc);
      // Try again after extraction
      const created = this.plugin.app.vault.getAbstractFileByPath(notePath);
      if (created instanceof TFile) {
        await this.plugin.app.workspace.getLeaf(false).openFile(created);
      } else {
        // No highlights — open source file instead
        await this.openSourceFile(doc);
      }
    }
  }

  /** Sync from tablet, then extract highlights for a single document. */
  private async extractSingleDocument(doc: LibraryDocument): Promise<void> {
    try {
      // Sync first — pull latest files from tablet via the unified provider.
      // A failed sync is non-fatal here (we fall back to existing local files),
      // but it must be surfaced rather than silently swallowed.
      new Notice(`Syncing "${doc.name}" from tablet...`);
      try {
        const provider = this.plugin.getSyncProvider(doc.sourceId);
        const syncResult = await provider.sync();
        if (!syncResult.success) {
          const detail = syncResult.errors[0] ? ` (${syncResult.errors[0]})` : '';
          new Notice(`Sync failed${detail}. Extracting from existing local files.`, 8000);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Sync failed (${msg}). Extracting from existing local files.`, 8000);
      }

      new Notice(`Extracting from "${doc.name}"...`);
      const result = await this.plugin.runExtraction(true, doc.sourceId, doc.uuid);
      if (result.totalHighlights > 0 || result.outputFiles.length > 0) {
        const parts: string[] = [];
        if (result.totalHighlights > 0) parts.push(`${result.totalHighlights} highlight(s)`);
        if (result.outputFiles.length > 0 && result.totalHighlights === 0) parts.push('page drawings');
        new Notice(`Extracted ${parts.join(' and ')} from "${doc.name}".`);
      } else {
        new Notice(`No highlights or annotations found in "${doc.name}".`);
      }
      await this.refreshLibrary();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Extraction failed: ${msg}`);
    }
  }

  /**
   * Unarchive: move from Archive back to Sync folder.
   * Syncthing will sync it back to the tablet.
   */
  private async unarchiveDocument(doc: LibraryDocument): Promise<void> {
    if (!isValidUuid(doc.uuid)) {
      new Notice(`Cannot unarchive: invalid document UUID.`);
      return;
    }

    try {
      // Restore to the first source's sync folder
      const sources = this.plugin.getSyncSources();
      const syncDir = resolvePath(this.plugin.app, sources.length > 0 ? sources[0].syncFolder : this.plugin.settings.syncFolder);
      const archiveDir = resolvePath(this.plugin.app, this.plugin.settings.archiveFolder);

      const entries = fs.readdirSync(archiveDir).filter((f: string) => f.startsWith(doc.uuid));
      if (entries.length === 0) {
        new Notice(`No archived files found for "${doc.name}".`);
        return;
      }

      for (const entry of entries) {
        fs.renameSync(path.join(archiveDir, entry), path.join(syncDir, entry));
      }

      new Notice(
        this.plugin.isPushCapable()
          ? `"${doc.name}" sent back to reMarkable. Syncthing will sync it.`
          : `"${doc.name}" restored to your vault. (SFTP is download-only — the tablet is unchanged.)`,
      );
      await this.refreshLibrary();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Unarchive failed: ${msg}`);
    }
  }

  /**
   * Archive: move from Sync to Archive folder.
   * Syncthing propagates the removal to the tablet automatically.
   * No SSH needed.
   */
  private async archiveDocument(doc: LibraryDocument): Promise<void> {
    if (!isValidUuid(doc.uuid)) {
      new Notice(`Cannot archive: invalid document UUID.`);
      return;
    }

    try {
      const archiveDir = resolvePath(this.plugin.app, this.plugin.settings.archiveFolder);
      fs.mkdirSync(archiveDir, { recursive: true });

      // Find the document in any source folder
      let found = false;
      for (const source of this.plugin.getSyncSources()) {
        const syncDir = resolvePath(this.plugin.app, source.syncFolder);
        if (!fs.existsSync(syncDir)) continue;
        const entries = fs.readdirSync(syncDir).filter((f: string) => f.startsWith(doc.uuid));
        if (entries.length > 0) {
          for (const entry of entries) {
            fs.renameSync(path.join(syncDir, entry), path.join(archiveDir, entry));
          }
          found = true;
          break;
        }
      }

      if (!found) {
        new Notice(`No files found for "${doc.name}".`);
        return;
      }

      new Notice(
        this.plugin.isPushCapable()
          ? `"${doc.name}" archived. Syncthing will remove it from the tablet.`
          : `"${doc.name}" archived in your vault. (SFTP is download-only — it stays on the tablet and will re-sync unless removed there.)`,
      );
      await this.refreshLibrary();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Archive failed: ${msg}`);
    }
  }

  /**
   * Delete from sync folder. Syncthing propagates deletion to tablet.
   * No SSH needed.
   */
  private async deleteDocument(doc: LibraryDocument): Promise<void> {
    if (!isValidUuid(doc.uuid)) {
      new Notice(`Cannot delete: invalid document UUID.`);
      return;
    }

    const canPush = this.plugin.isPushCapable();
    const confirmed = confirm(
      `Permanently delete "${doc.name}"?\n\n` +
      (canPush
        ? `This removes it from your vault and the tablet. This cannot be undone.`
        : `This removes it from your vault only. SFTP is download-only, so it stays on the ` +
          `tablet and will re-download on the next sync. This cannot be undone.`)
    );
    if (!confirmed) return;

    try {
      // Search all source folders for the document
      for (const source of this.plugin.getSyncSources()) {
        const syncDir = resolvePath(this.plugin.app, source.syncFolder);
        if (!fs.existsSync(syncDir)) continue;
        const entries = fs.readdirSync(syncDir).filter((f: string) => f.startsWith(doc.uuid));
        for (const entry of entries) {
          fs.rmSync(path.join(syncDir, entry), { recursive: true, force: true });
        }
      }

      new Notice(
        canPush
          ? `"${doc.name}" deleted. Syncthing will remove it from the tablet.`
          : `"${doc.name}" removed from your vault. (It remains on the tablet in SFTP mode.)`,
      );
      await this.refreshLibrary();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Delete failed: ${msg}`);
    }
  }
}
