/**
 * Folder Migration Confirmation Modal.
 *
 * Shown when the user changes a folder path (syncFolder, highlightsFolder,
 * or archiveFolder) in settings. Displays the file count at the old path
 * and offers three choices:
 *   - Move files to the new location
 *   - Keep files at the old location (change path only)
 *   - Cancel the change entirely
 *
 * Uses Obsidian's native Modal and Setting components.
 * No custom colors -- all Obsidian CSS variables.
 */

import { App, Modal, Setting, Notice } from 'obsidian';
import {
  countFolderContents,
  migrateFiles,
  ensureFolders,
  type FolderFileCount,
  type MigrationResult,
} from './helpers';
import { logger } from '../utils/logger';

/** Which folder setting is being changed. */
export type FolderSettingKey = 'syncFolder' | 'highlightsFolder' | 'archiveFolder';

/** Human-readable labels for folder setting keys. */
const FOLDER_LABELS: Record<FolderSettingKey, string> = {
  syncFolder: 'Sync folder',
  highlightsFolder: 'Highlights folder',
  archiveFolder: 'Archive folder',
};

/** The user's chosen action from the migration dialog. */
export type MigrationChoice = 'move' | 'keep' | 'cancel';

/** Callback invoked when the user makes a choice. */
export type MigrationChoiceCallback = (
  choice: MigrationChoice,
  migrationResult?: MigrationResult,
) => void;

export class FolderMigrationModal extends Modal {
  private folderKey: FolderSettingKey;
  private oldPath: string;
  private newPath: string;
  private counts: FolderFileCount;
  private onChoice: MigrationChoiceCallback;
  private buttonsDisabled = false;

  constructor(
    app: App,
    folderKey: FolderSettingKey,
    oldPath: string,
    newPath: string,
    onChoice: MigrationChoiceCallback,
  ) {
    super(app);
    this.folderKey = folderKey;
    this.oldPath = oldPath;
    this.newPath = newPath;
    this.counts = countFolderContents(app, oldPath);
    this.onChoice = onChoice;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('remarkable-folder-migration-modal');

    const label = FOLDER_LABELS[this.folderKey];
    new Setting(contentEl).setName(`Change ${label}`).setHeading();

    // Description
    const desc = contentEl.createDiv({ cls: 'setting-item-description' });
    if (this.counts.fileCount === 0 && this.counts.folderCount === 0) {
      desc.setText(
        `You are changing the ${label.toLowerCase()} from "${this.oldPath}" to "${this.newPath}". ` +
        `The old folder is empty, so no files need to be moved.`,
      );
    } else {
      const parts: string[] = [];
      if (this.counts.fileCount > 0) {
        parts.push(`${this.counts.fileCount} file${this.counts.fileCount === 1 ? '' : 's'}`);
      }
      if (this.counts.folderCount > 0) {
        parts.push(`${this.counts.folderCount} subfolder${this.counts.folderCount === 1 ? '' : 's'}`);
      }
      desc.setText(
        `You have ${parts.join(' and ')} in "${this.oldPath}". ` +
        `What would you like to do with them?`,
      );
    }

    // Extra note for syncFolder changes
    if (this.folderKey === 'syncFolder') {
      const syncNote = contentEl.createDiv({ cls: 'setting-item-description eink-sync-folder-migration-note' });
      syncNote.setText(
        'Note: Changing the sync folder will reset the extraction timestamp. ' +
        'All documents in the new folder will be processed on the next extraction run.',
      );
    }

    // Action buttons
    const hasFiles = this.counts.fileCount > 0 || this.counts.folderCount > 0;

    if (hasFiles) {
      new Setting(contentEl)
        .setName('Move files to new location')
        .setDesc(`Move all files from "${this.oldPath}" to "${this.newPath}"`)
        .addButton((button) =>
          button
            .setButtonText('Move')
            .setCta()
            .onClick(() => this.handleMove()),
        );

      new Setting(contentEl)
        .setName('Keep files in old location')
        .setDesc(`Change the setting but leave existing files at "${this.oldPath}"`)
        .addButton((button) =>
          button
            .setButtonText('Keep')
            .onClick(() => this.handleKeep()),
        );
    } else {
      // No files to move -- just confirm or cancel
      new Setting(contentEl)
        .setName('Confirm change')
        .setDesc(`Change the ${label.toLowerCase()} to "${this.newPath}"`)
        .addButton((button) =>
          button
            .setButtonText('Confirm')
            .setCta()
            .onClick(() => this.handleKeep()),
        );
    }

    new Setting(contentEl)
      .setName('Cancel')
      .setDesc('Keep the current folder path unchanged')
      .addButton((button) =>
        button
          .setButtonText('Cancel')
          .onClick(() => this.handleCancel()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async handleMove(): Promise<void> {
    if (this.buttonsDisabled) return;
    this.buttonsDisabled = true;

    try {
      // Ensure the new folder exists before moving
      await ensureFolders(this.app, this.newPath);

      const result = await migrateFiles(this.app, this.oldPath, this.newPath);

      if (result.success) {
        new Notice(
          `E-Ink Sync: Moved ${result.filesMoved} file(s) to "${this.newPath}".`,
        );
        logger.info(
          `Folder migration complete: ${result.filesMoved} files, ${result.foldersMoved} folders ` +
          `moved from "${this.oldPath}" to "${this.newPath}"`,
        );
      } else {
        new Notice(
          `E-Ink Sync: Migration partially completed. ${result.filesMoved} file(s) moved. ` +
          `Some errors occurred: ${result.error}`,
          10000,
        );
        logger.warn(`Folder migration partial failure: ${result.error}`);
      }

      this.onChoice('move', result);
      this.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`E-Ink Sync: Migration failed. ${msg}`, 10000);
      logger.error(`Folder migration failed: ${msg}`);
      this.buttonsDisabled = false;
    }
  }

  private handleKeep(): void {
    if (this.buttonsDisabled) return;
    new Notice(
      `E-Ink Sync: Folder changed to "${this.newPath}". ` +
      `Previous files remain at "${this.oldPath}".`,
    );
    this.onChoice('keep');
    this.close();
  }

  private handleCancel(): void {
    if (this.buttonsDisabled) return;
    this.onChoice('cancel');
    this.close();
  }
}