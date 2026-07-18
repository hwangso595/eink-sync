/**
 * Obsidian settings tab for the E-Ink Sync plugin.
 *
 * Simplified into two sections:
 *   1. Main -- the essential settings most users need
 *   2. Advanced (collapsed) -- power-user settings, folder paths, archive
 *
 * Folder paths (sync, output) are set during wizard setup and hidden
 * by default. They're accessible under Advanced for users who need to
 * change them, but changing the sync folder requires reconfiguring Syncthing.
 */

import * as path from 'path';
import { App, PluginSettingTab, Setting, Notice, Modal } from 'obsidian';
import type ReMarkableBridgePlugin from './plugin';
import { generateSourceId, getSourceTimestamp, type PdfLinkFormat, type SyncMethodSetting, type SyncSource } from './settings';
import { ensureFolders, updateSyncthingFolderPath, getVaultBasePath, formatRelativeTime } from './helpers';
import {
  FolderMigrationModal,
  type FolderSettingKey,
} from './folder-migration-modal';
import { collisionKey } from './vault-isolation';
import { isValidIpv4, sharesLocalSubnet, localIpv4Interfaces } from './net-utils';
import { stopServices, removeServices } from '../sync/service-manager';
import type { SyncProvider } from '../sync/sync-provider';

const SAVE_DEBOUNCE_MS = 500;

export class ReMarkableBridgeSettingTab extends PluginSettingTab {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, private plugin: ReMarkableBridgePlugin) {
    super(app, plugin);
  }

  private debouncedSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      await this.plugin.saveSettings();
    }, SAVE_DEBOUNCE_MS);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ===== Collision / Outside-vault Warnings =====
    this.renderWarningBanners(containerEl);

    // ===== Main Settings =====
    this.renderMainSection(containerEl);

    // ===== Sync Sources =====
    this.renderSyncSourcesSection(containerEl);

    // ===== Actions =====
    this.renderActionsSection(containerEl);

    // ===== Advanced (collapsed) =====
    this.renderAdvancedSection(containerEl);
  }

  // -------------------------------------------------------------------
  // Warning Banners (vault isolation)
  // -------------------------------------------------------------------

  /**
   * Render persistent warning banners for active collisions and
   * outside-vault-root warnings. Uses Obsidian CSS variables for
   * native-looking validation messages.
   *
   * Each collision warning has a "Dismiss" button that persists the
   * dismissal keyed to the specific vault+folder pair. If the colliding
   * vault changes, the key no longer matches and the warning reappears.
   */
  private renderWarningBanners(containerEl: HTMLElement): void {
    const collisions = this.plugin.getActiveCollisions();
    const outsideWarnings = this.plugin.getOutsideVaultWarnings();
    const dismissed = new Set(this.plugin.getDismissedCollisions());

    // Filter out dismissed collisions
    const activeCollisions = collisions.filter(
      (c) => !dismissed.has(collisionKey(c)),
    );

    if (activeCollisions.length === 0 && outsideWarnings.length === 0) {
      return;
    }

    // Collision warnings
    for (const collision of activeCollisions) {
      const key = collisionKey(collision);
      const banner = containerEl.createDiv({ cls: 'remarkable-warning-banner remarkable-collision-banner' });

      const textEl = banner.createDiv({ cls: 'remarkable-warning-banner-text' });
      textEl.createEl('strong', {
        text: 'Folder collision detected',
        cls: 'remarkable-warning-title',
      });

      // Extract the folder name for a concise message
      const folderName = collision.folderPath.split(/[\\/]/).pop() ?? collision.folderPath;
      textEl.createEl('p', {
        text: `The folder "${folderName}" is also claimed by the vault at "${collision.otherVaultPath}". ` +
          'Running both plugins on the same folder may cause duplicate extractions or data corruption.',
        cls: 'remarkable-warning-detail',
      });

      // Dismiss button
      const dismissBtn = banner.createEl('button', { text: 'Dismiss', cls: 'remarkable-dismiss-btn' });
      dismissBtn.addEventListener('click', async () => {
        await this.plugin.dismissCollision(key);
        this.display();
      });
    }

    // Outside-vault warnings
    for (const warning of outsideWarnings) {
      const banner = containerEl.createDiv({ cls: 'remarkable-warning-banner' });

      banner.createEl('strong', {
        text: 'Folder outside vault',
        cls: 'remarkable-warning-title',
      });

      banner.createEl('p', {
        text: `The folder "${warning.configuredPath}" resolves to "${warning.resolvedPath}", ` +
          'which is outside your vault root. This may cause issues with Obsidian indexing.',
        cls: 'remarkable-warning-detail',
      });
    }
  }

  private renderMainSection(containerEl: HTMLElement): void {
    // Per Obsidian style guidance, the top-level heading is omitted — the
    // plugin name is already shown in the settings tab title.
    const isSyncthing = (this.plugin.settings.syncMethod ?? 'sftp') === 'syncthing';
    const isSftp = !isSyncthing;
    const isWifi = this.plugin.settings.connectionMethod === 'wifi';

    // 1. Connection method (USB/WiFi)
    new Setting(containerEl)
      .setName('Connection method')
      .setDesc(
        'USB-only mode blocks all WiFi sync and disables auto-sync. ' +
        'Use this if you want to ensure no data is sent over your network.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('usb', 'USB only')
          .addOption('wifi', 'WiFi')
          .setValue(this.plugin.settings.connectionMethod)
          .onChange(async (value) => {
            this.plugin.settings.connectionMethod = value as 'usb' | 'wifi';
            if (value === 'usb') {
              this.plugin.settings.tabletIp = '10.11.99.1';
              this.plugin.settings.autoSyncEnabled = false;
              this.plugin.toggleAutoSyncTimer();
            }
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    // 2. Tablet IP — only shown when WiFi selected (USB is always 10.11.99.1)
    if (isWifi) {
      const ipWarnEl = containerEl.createDiv({
        cls: 'setting-item-description remarkable-field-warning',
      });
      ipWarnEl.hide();

      // Validate format and flag a likely network-switch (saved IP not on this
      // computer's subnet) — the #1 cause of silent sync failure.
      const refreshIpWarnings = (value: string): void => {
        const ip = value.trim();
        if (ip.length === 0) {
          ipWarnEl.hide();
          return;
        }
        if (!isValidIpv4(ip)) {
          ipWarnEl.setText(`"${ip}" is not a valid IPv4 address (expected e.g. 192.168.1.42).`);
          ipWarnEl.show();
          return;
        }
        if (!sharesLocalSubnet(ip)) {
          const locals = localIpv4Interfaces().map((i) => i.address).join(', ') || 'unknown';
          ipWarnEl.setText(
            `Heads up: ${ip} isn't on this computer's network (this machine: ${locals}). ` +
            `If you switched Wi-Fi, the tablet likely has a new IP — use "Detect via USB" below.`,
          );
          ipWarnEl.show();
          return;
        }
        ipWarnEl.hide();
      };

      new Setting(containerEl)
        .setName('Tablet IP address')
        .setDesc('Check your tablet\'s network settings for the WiFi IP address.')
        .addText((text) =>
          text
            .setPlaceholder('10.11.99.1')
            .setValue(this.plugin.settings.tabletIp)
            .onChange((value) => {
              this.plugin.settings.tabletIp = value.trim();
              refreshIpWarnings(value);
              this.debouncedSave();
            }),
        )
        .addExtraButton((btn) =>
          btn
            .setIcon('usb')
            .setTooltip('Detect the tablet\'s current Wi-Fi IP over USB')
            .onClick(async () => {
              new Notice('E-Ink Sync: connect the tablet via USB, then detecting...');
              try {
                const detected = await this.plugin.detectTabletWifiIp('10.11.99.1');
                if (!detected) {
                  new Notice('E-Ink Sync: tablet not on Wi-Fi (no wlan0 IP found).', 6000);
                  return;
                }
                this.plugin.settings.tabletIp = detected;
                await this.plugin.saveSettings();
                new Notice(`E-Ink Sync: found tablet at ${detected}. Updated.`, 6000);
                this.display();
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                new Notice(`E-Ink Sync: USB detection failed — ${msg}`, 8000);
              }
            }),
        );

      // Move the warning element to directly follow the IP setting row.
      containerEl.append(ipWarnEl);
      refreshIpWarnings(this.plugin.settings.tabletIp);
    }

    // 3. Root password — always shown (needed for both modes)
    new Setting(containerEl)
      .setName('Root password')
      .setDesc('Tablet > Settings > Help > About > Copyrights and Licenses')
      .addText((text) => {
        text
          .setPlaceholder('Enter root password')
          .setValue(this.plugin.settings.rootPassword)
          .onChange((value) => {
            this.plugin.settings.rootPassword = value;
            this.debouncedSave();
          });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
      });

    // 4. Sync method (SFTP/Syncthing) — with switching logic
    new Setting(containerEl)
      .setName('Sync method')
      .setDesc('SFTP downloads files directly over SSH (simpler setup). Syncthing uses continuous background sync.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('sftp', 'SFTP (direct SSH transfer)')
          .addOption('syncthing', 'Syncthing (background sync)')
          .setValue(this.plugin.settings.syncMethod ?? 'sftp')
          .onChange(async (value) => {
            const newMethod = value as SyncMethodSetting;
            const oldMethod = this.plugin.settings.syncMethod ?? 'sftp';

            if (newMethod === oldMethod) return;

            if (newMethod === 'sftp' && oldMethod === 'syncthing') {
              // Switching to SFTP — use the old Syncthing provider to clean up
              const oldProvider = this.plugin.getSyncProvider();

              const wantsRemove = confirm(
                'Would you like to stop and remove Syncthing from your tablet? ' +
                'This frees up RAM on the tablet.',
              );
              if (wantsRemove) {
                try {
                  await oldProvider.remove();
                  new Notice('E-Ink Sync: Syncthing removed from tablet.');
                } catch {
                  new Notice(
                    'E-Ink Sync: Could not reach tablet to remove Syncthing — you can remove it later.',
                  );
                }
              } else {
                // Just pause the host-side folder
                try {
                  await oldProvider.pause();
                  new Notice('E-Ink Sync: Syncthing folder paused on this computer.');
                } catch {
                  // Syncthing not running on host or API unreachable — that's fine
                }
              }

              // Keep Syncthing settings (API key, folder ID) so we can unpause if user switches back
              this.plugin.settings.syncMethod = 'sftp';
              this.plugin.settings.setupComplete = true;
              await this.plugin.saveSettings();
              this.display();
            } else if (newMethod === 'syncthing' && oldMethod === 'sftp') {
              // Switching to Syncthing — build a Syncthing provider to resume
              this.plugin.settings.syncMethod = 'syncthing';
              const newProvider = this.plugin.getSyncProvider();

              // Try to resume the host-side folder
              try {
                await newProvider.resume();
                new Notice('E-Ink Sync: Syncthing folder resumed.');
              } catch {
                // Syncthing not running — wizard will handle setup
              }

              // Check if Syncthing is already set up on the tablet
              const { syncthingApiKey } = this.plugin.settings;
              let tabletHasSyncthing = false;
              try {
                tabletHasSyncthing = await this.plugin.verifySyncInstallation();
              } catch {
                // Can't reach tablet
              }

              if (tabletHasSyncthing && syncthingApiKey) {
                // Syncthing already set up on both sides — just switch
                this.plugin.settings.setupComplete = true;
                new Notice('E-Ink Sync: Switched to Syncthing mode.');
              } else {
                // Need to install Syncthing on tablet
                this.plugin.settings.setupComplete = false;
                new Notice('E-Ink Sync: Syncthing needs to be set up on your tablet. Opening the setup wizard.');
                this.plugin.openSetupWizard();
              }
              await this.plugin.saveSettings();
              this.display();
            }
          }),
      );

    // 5. Syncthing API key — only when Syncthing mode
    if (isSyncthing) {
      new Setting(containerEl)
        .setName('Syncthing API key')
        .setDesc('Required for sync. Found in Syncthing web UI > Actions > Settings > API Key')
        .addText((text) => {
          text
            .setPlaceholder('Enter API key')
            .setValue(this.plugin.settings.syncthingApiKey)
            .onChange((value) => {
              this.plugin.settings.syncthingApiKey = value.trim();
              this.debouncedSave();
            });
          text.inputEl.type = 'password';
        });

      // Warning when no API key configured
      if (!this.plugin.settings.syncthingApiKey) {
        const warning = containerEl.createDiv({ cls: 'setting-item-description remarkable-field-warning' });
        warning.setText('Syncthing API key is required for sync to work.');
      }
    }

    // 6. Auto-sync toggle + interval — only when SFTP + WiFi
    if (isSftp && isWifi) {
      new Setting(containerEl)
        .setName('Auto-sync from tablet')
        .setDesc('Periodically check for and download new files from the tablet via SFTP')
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.autoSyncEnabled)
            .onChange(async (value) => {
              this.plugin.settings.autoSyncEnabled = value;
              await this.plugin.saveSettings();
              this.plugin.toggleAutoSyncTimer();
              this.display();
            }),
        );

      // Make it obvious that with auto-sync off, new tablet docs won't appear
      // on their own — the silent "nothing happens" state we want to avoid.
      if (!this.plugin.settings.autoSyncEnabled) {
        const hint = containerEl.createDiv({ cls: 'setting-item-description remarkable-field-warning' });
        hint.setText(
          'Auto-sync is off — new tablet documents won\'t appear until you sync manually ' +
          '(ribbon icon or the "Sync now" command).',
        );
      }

      if (this.plugin.settings.autoSyncEnabled) {
        new Setting(containerEl)
          .setName('Auto-sync interval (minutes)')
          .setDesc('How often to check the tablet for new files')
          .addSlider((slider) =>
            slider
              .setLimits(5, 120, 5)
              .setValue(this.plugin.settings.autoSyncIntervalMinutes ?? 15)
              .setDynamicTooltip()
              .onChange(async (value) => {
                this.plugin.settings.autoSyncIntervalMinutes = value;
                await this.plugin.saveSettings();
                this.plugin.toggleAutoSyncTimer();
              }),
          );
      }
    }

    // 7. Auto-extract highlights
    new Setting(containerEl)
      .setName('Auto-extract highlights')
      .setDesc('Automatically create highlight notes when new annotations sync from the tablet')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoExtractEnabled)
          .onChange(async (value) => {
            this.plugin.settings.autoExtractEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.toggleFileWatcher();
          }),
      );

    // 8. PDF link format
    new Setting(containerEl)
      .setName('PDF link format')
      .setDesc('How highlight notes link back to PDF pages')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('pdfpp', 'PDF++ (recommended)')
          .addOption('obsidian', 'Obsidian built-in')
          .addOption('none', 'No links')
          .setValue(this.plugin.settings.extraction.pdfLinkFormat)
          .onChange(async (value) => {
            this.plugin.settings.extraction.pdfLinkFormat = value as PdfLinkFormat;
            await this.plugin.saveSettings();
          }),
      );

    // 9. Incremental extraction
    new Setting(containerEl)
      .setName('Incremental extraction')
      .setDesc('Only process documents changed since last run')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.extraction.incrementalOnly)
          .onChange(async (value) => {
            this.plugin.settings.extraction.incrementalOnly = value;
            await this.plugin.saveSettings();
          }),
      );

    // 10. Include EPUB
    new Setting(containerEl)
      .setName('Include EPUB documents')
      .setDesc('Also extract highlights from EPUB-format books.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeEpub)
          .onChange(async (value) => {
            this.plugin.settings.includeEpub = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Managed Python environment')
      .setDesc(
        'Let the plugin create and maintain its own Python environment (via uv or venv) ' +
        'with the required packages, instead of trusting whatever Python is on PATH. ' +
        'Extraction aborts with an error instead of writing empty notes when no usable ' +
        'environment exists.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.managedPythonEnv)
          .onChange(async (value) => {
            this.plugin.settings.managedPythonEnv = value;
            await this.plugin.saveSettings();
          }),
      );

    // 11. Overwrite existing notes
    new Setting(containerEl)
      .setName('Overwrite existing notes')
      .setDesc('Replace highlight notes on each extraction. When off, new highlights are merged into existing notes.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.extraction.overwriteExisting)
          .onChange(async (value) => {
            this.plugin.settings.extraction.overwriteExisting = value;
            await this.plugin.saveSettings();
          }),
      );

    // 12. Include highlight colors
    new Setting(containerEl)
      .setName('Include highlight colors')
      .setDesc('Show the color name (yellow, green, pink) for each highlight in the output.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.extraction.includeColors)
          .onChange(async (value) => {
            this.plugin.settings.extraction.includeColors = value;
            await this.plugin.saveSettings();
          }),
      );

    // 13. Group highlights by page
    new Setting(containerEl)
      .setName('Group highlights by page')
      .setDesc('Organize highlights under page number headers. When off, highlights appear as a flat list.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.extraction.groupByPage)
          .onChange(async (value) => {
            this.plugin.settings.extraction.groupByPage = value;
            await this.plugin.saveSettings();
          }),
      );

    // 14. Truncate blank page space
    new Setting(containerEl)
      .setName('Trim blank page space')
      .setDesc('Crop the empty bottom of short notebook and quick-sheet pages so a page with only a little content doesn\'t embed a tall blank image.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.extraction.truncateBlankSpace)
          .onChange(async (value) => {
            this.plugin.settings.extraction.truncateBlankSpace = value;
            await this.plugin.saveSettings();
          }),
      );

    // 15. OCR handwriting search
    new Setting(containerEl)
      .setName('Search handwriting (OCR)')
      .setDesc('Run local OCR on notebook pages so handwriting becomes searchable text, folded under each page image. Requires Tesseract OCR installed on this computer (pip install pytesseract Pillow, plus the Tesseract binary). All processing stays on your machine.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.extraction.ocrEnabled)
          .onChange(async (value) => {
            this.plugin.settings.extraction.ocrEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    // 16. OCR language
    new Setting(containerEl)
      .setName('OCR language')
      .setDesc('Tesseract language code(s), e.g. "eng" or "eng+deu". Requires the matching language pack to be installed.')
      .addText((text) =>
        text
          .setPlaceholder('eng')
          .setValue(this.plugin.settings.extraction.ocrLanguage)
          .onChange(async (value) => {
            this.plugin.settings.extraction.ocrLanguage = value.trim() || 'eng';
            await this.plugin.saveSettings();
          }),
      );

    // 17. Render page templates
    new Setting(containerEl)
      .setName('Render page templates')
      .setDesc('Draw the reMarkable page template (ruled lines, grid, planner) behind notebook strokes. The template art is fetched from the tablet over SFTP during sync; until then, pages render on plain white.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.extraction.renderTemplates)
          .onChange(async (value) => {
            this.plugin.settings.extraction.renderTemplates = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  // -------------------------------------------------------------------
  // Sync Sources section
  // -------------------------------------------------------------------

  private renderSyncSourcesSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Sync sources').setHeading();

    const sources = this.plugin.getSyncSources();

    if (sources.length === 0) {
      containerEl.createEl('p', {
        text: 'No sync sources configured. Add one to start extracting highlights.',
        cls: 'setting-item-description',
      });
    }

    // Render each source
    for (const source of sources) {
      this.renderSourceItem(containerEl, source);
    }

    // Add source button
    new Setting(containerEl)
      .setName('Add sync source')
      .setDesc('Connect an additional reMarkable tablet or sync folder')
      .addButton((button) =>
        button
          .setButtonText('Add source')
          .setCta()
          .onClick(() => {
            const existingFolders = this.plugin.getSyncSources().map((s) => s.syncFolder);
            new AddSourceModal(this.app, existingFolders, this.plugin.settings.syncMethod ?? 'sftp', async (newSource) => {
              const updatedSources = [...this.plugin.getSyncSources(), newSource];
              await this.plugin.updateSyncSources(updatedSources);
              await ensureFolders(this.plugin.app, newSource.syncFolder);
              this.plugin.restartFileWatcher();
              // Re-run vault isolation checks after adding a new source
              this.plugin.runVaultIsolationChecks();
              this.display();
            }).open();
          }),
      );
  }

  private renderSourceItem(containerEl: HTMLElement, source: SyncSource): void {
    const sourceEl = containerEl.createDiv({ cls: 'remarkable-source-item' });

    // Source header with label and last extraction time (from device state)
    const deviceState = this.plugin.getDeviceState();
    const deviceTs = getSourceTimestamp(deviceState, source.id);
    const lastExtracted = deviceTs
      ? formatRelativeTime(deviceTs, 'long')
      : 'Never';

    new Setting(sourceEl)
      .setName(source.label)
      .setDesc(`${source.syncFolder} -- Last extracted: ${lastExtracted}`);

    // Sync folder (editable)
    new Setting(sourceEl)
      .setName('Sync folder')
      .setDesc('Path to the synced xochitl directory')
      .addText((text) =>
        text
          .setPlaceholder('reMarkable/Sync')
          .setValue(source.syncFolder)
          .onChange((value) => {
            const trimmed = value.trim();
            if (!trimmed || trimmed === source.syncFolder) return;
            this.handleSourceFolderChange(source, trimmed, text.inputEl);
          }),
      );

    // Syncthing folder ID — only shown when using Syncthing
    if ((this.plugin.settings.syncMethod ?? 'sftp') === 'syncthing') {
      new Setting(sourceEl)
        .setName('Syncthing folder ID')
        .addText((text) =>
          text
            .setPlaceholder('remarkable-xochitl')
            .setValue(source.syncthingFolderId)
            .onChange(async (value) => {
              source.syncthingFolderId = value.trim();
              await this.plugin.updateSyncSources(this.plugin.getSyncSources());
            }),
        );
    }

    // Highlights subfolder (optional)
    new Setting(sourceEl)
      .setName('Highlights subfolder')
      .setDesc('Optional subfolder within highlights folder for this source\'s notes')
      .addText((text) =>
        text
          .setPlaceholder('(same as main)')
          .setValue(source.highlightsSubfolder ?? '')
          .onChange(async (value) => {
            source.highlightsSubfolder = value.trim() || null;
            await this.plugin.updateSyncSources(this.plugin.getSyncSources());
          }),
      );

    // Action buttons row
    const actionsRow = new Setting(sourceEl);
    actionsRow.setName('');

    // Extract button
    actionsRow.addButton((button) =>
      button
        .setButtonText('Extract')
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText('Extracting...');
          try {
            await this.plugin.runExtraction(false, source.id);
            button.setButtonText('Done');
          } catch {
            button.setButtonText('Failed');
          }
          setTimeout(() => {
            button.setDisabled(false);
            button.setButtonText('Extract');
          }, 3000);
        }),
    );

    // Reset button
    actionsRow.addButton((button) =>
      button
        .setButtonText('Reset')
        .setWarning()
        .onClick(async () => {
          this.plugin.resetExtractionTimestamp(source.id);
          new Notice(
            `E-Ink Sync: Extraction state reset for "${source.label}". ` +
            'Next extraction will re-process all documents.',
          );
          button.setButtonText('Done');
          button.setDisabled(true);
          setTimeout(() => {
            button.setButtonText('Reset');
            button.setDisabled(false);
          }, 3000);
          this.display();
        }),
    );

    // Remove button (only show if there are multiple sources or this isn't the only source)
    actionsRow.addButton((button) =>
      button
        .setButtonText('Remove')
        .onClick(async () => {
          const confirmed = confirm(
            `Remove sync source "${source.label}"?\n\n` +
            'This only removes the configuration. Sync folder and highlight notes will remain on disk.',
          );
          if (!confirmed) return;

          const updated = this.plugin.getSyncSources().filter((s) => s.id !== source.id);
          await this.plugin.updateSyncSources(updated);
          this.plugin.restartFileWatcher();
          new Notice(`E-Ink Sync: Source "${source.label}" removed.`);
          this.display();
        }),
    );
  }

  /**
   * Handle a sync folder change for a specific source.
   * Shows the folder migration modal and updates the source on confirmation.
   */
  private handleSourceFolderChange(
    source: SyncSource,
    newPath: string,
    inputEl: HTMLInputElement,
  ): void {
    const oldPath = source.syncFolder;

    const modal = new FolderMigrationModal(
      this.app,
      'syncFolder' as FolderSettingKey,
      oldPath,
      newPath,
      async (choice) => {
        if (choice === 'cancel') {
          inputEl.value = oldPath;
          return;
        }

        // Apply the new path to the source
        source.syncFolder = newPath;

        // Ensure the new folder exists
        await ensureFolders(this.plugin.app, newPath);

        // Reset extraction timestamp for this source
        this.plugin.resetExtractionTimestamp(source.id);
        new Notice(
          `E-Ink Sync: Source "${source.label}" folder changed. ` +
          'Extraction state reset. All documents in the new folder will be processed on next run.',
        );

        // Restart file watchers
        this.plugin.restartFileWatcher();

        // Update Syncthing folder path if API key is configured
        if (this.plugin.settings.syncthingApiKey && source.syncthingFolderId) {
          const basePath = getVaultBasePath(this.plugin.app);
          const newSyncPath = path.resolve(basePath, newPath);

          const result = await updateSyncthingFolderPath(
            this.plugin.settings.syncthingUrl,
            this.plugin.settings.syncthingApiKey,
            source.syncthingFolderId,
            newSyncPath,
          );

          if (result.success) {
            new Notice('E-Ink Sync: Syncthing folder path updated.');
          } else {
            new Notice(`E-Ink Sync: Could not update Syncthing. ${result.error}`);
          }
        }

        await this.plugin.updateSyncSources(this.plugin.getSyncSources());
        // Re-run vault isolation checks after folder change
        this.plugin.runVaultIsolationChecks();
        this.display();
      },
    );

    modal.open();
  }

  private renderActionsSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Actions').setHeading();

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Check if the plugin can reach your tablet')
      .addButton((button) =>
        button
          .setButtonText('Test')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Testing...');
            try {
              const connected = await this.plugin.testConnection();
              button.setButtonText(connected ? 'Connected' : 'Failed');
            } catch {
              button.setButtonText('Error');
            }
            setTimeout(() => {
              button.setDisabled(false);
              button.setButtonText('Test');
            }, 3000);
          }),
      );

    new Setting(containerEl)
      .setName('Extract highlights now')
      .setDesc('Manually run extraction on all synced documents')
      .addButton((button) =>
        button
          .setButtonText('Extract')
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Extracting...');
            try {
              await this.plugin.runExtraction();
              button.setButtonText('Done');
            } catch {
              button.setButtonText('Failed');
            }
            setTimeout(() => {
              button.setDisabled(false);
              button.setButtonText('Extract');
            }, 3000);
          }),
      );

    new Setting(containerEl)
      .setName('Run setup wizard')
      .setDesc('Reconfigure connection, sync, and folder settings')
      .addButton((button) =>
        button
          .setButtonText('Open Wizard')
          .onClick(() => this.plugin.openSetupWizard()),
      );

    // ----- Folders -----
    new Setting(containerEl).setName('Folders').setHeading();

    // Validation — check all source sync folders against highlights/archive
    // Shown BEFORE folder inputs so warnings are visible immediately
    const { highlightsFolder, archiveFolder } = this.plugin.settings;
    const sourceFolders = this.plugin.getSyncSources().map((s) => s.syncFolder).filter(Boolean);
    const allFolders = [...sourceFolders, highlightsFolder, archiveFolder].filter(Boolean);
    const unique = new Set(allFolders);
    const hasDuplicates = unique.size !== allFolders.length;
    const archiveInSync = sourceFolders.some(
      (sf) => archiveFolder && (archiveFolder.startsWith(sf + '/') || archiveFolder === sf),
    );

    if (hasDuplicates || archiveInSync) {
      const warning = containerEl.createDiv({ cls: 'setting-item-description remarkable-field-error' });
      if (archiveInSync) {
        warning.setText('Warning: Archive folder cannot be inside a Sync folder. Syncthing would re-sync archived files back to the tablet.');
      } else {
        warning.setText('Warning: All folders must be different paths. Overlapping folders may cause data loss.');
      }
    }

    new Setting(containerEl)
      .setName('Highlights folder')
      .setDesc('Extracted highlight notes are saved here.')
      .addText((text) =>
        text
          .setPlaceholder('reMarkable/Highlights')
          .setValue(this.plugin.settings.highlightsFolder)
          .onChange((value) => {
            const trimmed = value.trim();
            if (!trimmed || trimmed === this.plugin.settings.highlightsFolder) return;

            this.handleFolderChange('highlightsFolder', trimmed, text.inputEl);
          }),
      );

    new Setting(containerEl)
      .setName('Archive folder')
      .setDesc('Archived documents are moved here.')
      .addText((text) =>
        text
          .setPlaceholder('reMarkable/Archive')
          .setValue(this.plugin.settings.archiveFolder)
          .onChange((value) => {
            const trimmed = value.trim();
            if (!trimmed || trimmed === this.plugin.settings.archiveFolder) return;

            this.handleFolderChange('archiveFolder', trimmed, text.inputEl);
          }),
      );

    // ----- Template -----
    new Setting(containerEl)
      .setName('Template file')
      .setDesc('Path to template for highlight notes. Edit this file to customize the output format.')
      .addText((text) =>
        text
          .setPlaceholder('reMarkable/template.md')
          .setValue(this.plugin.settings.templatePath)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!trimmed) return;
            this.plugin.settings.templatePath = trimmed;
            await this.plugin.saveSettings();
          }),
      );
  }

  /**
   * Handle a global folder path change (highlights or archive) by showing
   * the migration modal.
   *
   * Sync folder changes are handled per-source in handleSourceFolderChange.
   */
  private handleFolderChange(
    key: FolderSettingKey,
    newPath: string,
    inputEl: HTMLInputElement,
  ): void {
    const oldPath = this.plugin.settings[key];

    const modal = new FolderMigrationModal(
      this.app,
      key,
      oldPath,
      newPath,
      async (choice) => {
        if (choice === 'cancel') {
          inputEl.value = oldPath;
          return;
        }

        // Apply the new path
        this.plugin.settings[key] = newPath;

        // Ensure the new folder exists
        await ensureFolders(this.plugin.app, newPath);

        await this.plugin.saveSettings();
        // Re-run vault isolation checks after folder change
        this.plugin.runVaultIsolationChecks();
        this.display();
      },
    );

    modal.open();
  }

  private renderAdvancedSection(containerEl: HTMLElement): void {
    const details = containerEl.createEl('details');
    details.createEl('summary', { text: 'Advanced Settings', cls: 'remarkable-advanced-toggle' });

    const advancedEl = details.createDiv({ cls: 'remarkable-advanced-content' });

    const isSyncthing = (this.plugin.settings.syncMethod ?? 'sftp') === 'syncthing';

    // ----- SSH -----
    new Setting(advancedEl).setName('SSH').setHeading();

    const portWarnEl = advancedEl.createDiv({
      cls: 'setting-item-description remarkable-field-warning',
    });
    portWarnEl.hide();
    new Setting(advancedEl)
      .setName('SSH port')
      .setDesc('Default is 22. Only change if your tablet uses a non-standard SSH port.')
      .addText((text) =>
        text
          .setPlaceholder('22')
          .setValue(String(this.plugin.settings.sshPort))
          .onChange((value) => {
            // Digits only -- parseInt would accept "22abc"/"1.5".
            const port = /^\d+$/.test(value.trim()) ? parseInt(value.trim(), 10) : NaN;
            if (!isNaN(port) && port > 0 && port <= 65535) {
              portWarnEl.hide();
              this.plugin.settings.sshPort = port;
              this.debouncedSave();
            } else {
              // Don't silently discard invalid input — tell the user why it
              // isn't taking effect.
              portWarnEl.setText(`"${value}" is not a valid port (1–65535). Keeping ${this.plugin.settings.sshPort}.`);
              portWarnEl.show();
            }
          }),
      );
    advancedEl.append(portWarnEl);

    new Setting(advancedEl)
      .setName('Connection timeout')
      .setDesc('How long to wait for SSH connections (milliseconds). Increase if you have a slow WiFi connection.')
      .addSlider((slider) =>
        slider
          .setLimits(5, 60, 5)
          .setValue(this.plugin.settings.sshTimeoutMs / 1000)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.sshTimeoutMs = value * 1000;
            await this.plugin.saveSettings();
          }),
      );

    // ----- Syncthing (only shown when using Syncthing) -----
    if (isSyncthing) {
      new Setting(advancedEl).setName('Syncthing').setHeading();

      new Setting(advancedEl)
        .setName('Syncthing URL')
        .setDesc('Address of Syncthing\'s web UI on your computer.')
        .addText((text) =>
          text
            .setPlaceholder('http://127.0.0.1:8384')
            .setValue(this.plugin.settings.syncthingUrl)
            .onChange((value) => {
              this.plugin.settings.syncthingUrl = value.trim();
              this.debouncedSave();
            }),
        );

      new Setting(advancedEl)
        .setName('Syncthing folder ID')
        .setDesc('The folder ID shared with your tablet (usually "remarkable-xochitl")')
        .addText((text) =>
          text
            .setPlaceholder('remarkable-xochitl')
            .setValue(this.plugin.settings.syncthingFolderId)
            .onChange((value) => {
              this.plugin.settings.syncthingFolderId = value.trim();
              this.debouncedSave();
            }),
        );
    }

    // ----- Extraction -----
    new Setting(advancedEl).setName('Extraction').setHeading();

    new Setting(advancedEl)
      .setName('Tags (optional)')
      .setDesc('Comma-separated tags added to notes. Leave empty for no tags.')
      .addText((text) =>
        text
          .setPlaceholder('remarkable, highlights')
          .setValue(this.plugin.settings.extraction.defaultTags.join(', '))
          .onChange((value) => {
            this.plugin.settings.extraction.defaultTags = value
              .split(',')
              .map((t) => t.trim())
              .filter((t) => t.length > 0);
            this.debouncedSave();
          }),
      );

    new Setting(advancedEl)
      .setName('Reset all extraction state')
      .setDesc('Force the next extraction to re-process all documents across all sources.')
      .addButton((button) =>
        button
          .setButtonText('Reset')
          .setWarning()
          .onClick(async () => {
            this.plugin.resetExtractionTimestamp();
            new Notice(
              'E-Ink Sync: Extraction state reset. Next extraction will re-process all documents.',
            );
            button.setButtonText('Done');
            button.setDisabled(true);
            setTimeout(() => {
              button.setButtonText('Reset');
              button.setDisabled(false);
            }, 3000);
          }),
      );

    // ----- Storage Management -----
    new Setting(advancedEl).setName('Storage management').setHeading();

    new Setting(advancedEl)
      .setName('Auto-archive old documents')
      .setDesc('Move old documents off the tablet when storage gets tight')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.archiveEnabled)
          .onChange(async (value) => {
            this.plugin.settings.archiveEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(advancedEl)
      .setName('Archive threshold')
      .setDesc('Archive when /home usage exceeds this %')
      .addSlider((slider) =>
        slider
          .setLimits(50, 95, 5)
          .setValue(this.plugin.settings.archiveThresholdPercent)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.archiveThresholdPercent = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(advancedEl)
      .setName('Minimum age (days)')
      .setDesc('Only archive documents not opened in this many days')
      .addSlider((slider) =>
        slider
          .setLimits(1, 90, 1)
          .setValue(this.plugin.settings.archiveMinAgeDays)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.archiveMinAgeDays = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(advancedEl)
      .setName('Archive now')
      .setDesc('Manually archive old documents from the tablet')
      .addButton((button) =>
        button
          .setButtonText('Archive')
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Archiving...');
            try {
              await this.plugin.archiveOldDocuments(true);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`Archive failed: ${msg}`);
            }
            button.setDisabled(false);
            button.setButtonText('Archive');
          }),
      );

    // ----- UI -----
    new Setting(advancedEl).setName('UI').setHeading();

    new Setting(advancedEl)
      .setName('Show status bar')
      .setDesc('Show sync status in Obsidian\'s bottom status bar.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showStatusBar)
          .onChange(async (value) => {
            this.plugin.settings.showStatusBar = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(advancedEl)
      .setName('Debug logging')
      .setDesc('Enable verbose logging to the developer console for troubleshooting.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}

// -------------------------------------------------------------------
// Add Source Modal
// -------------------------------------------------------------------

/**
 * Modal for adding a new sync source.
 * Collects label, sync folder path, and Syncthing folder ID.
 */
class AddSourceModal extends Modal {
  private label = '';
  private syncFolder = '';
  private syncthingFolderId = '';
  private onSubmit: (source: SyncSource) => void;
  private existingSyncFolders: string[];
  private syncMethod: SyncMethodSetting;

  constructor(app: App, existingSyncFolders: string[], syncMethod: SyncMethodSetting, onSubmit: (source: SyncSource) => void) {
    super(app);
    this.existingSyncFolders = existingSyncFolders;
    this.syncMethod = syncMethod;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName('Add sync source').setHeading();

    new Setting(contentEl)
      .setName('Label')
      .setDesc('A name for this source (e.g., "My rM1", "Partner\'s rM2")')
      .addText((text) =>
        text
          .setPlaceholder('My reMarkable')
          .onChange((value) => {
            this.label = value.trim();
          }),
      );

    new Setting(contentEl)
      .setName('Sync folder')
      .setDesc('Path to the synced xochitl directory (relative to vault)')
      .addText((text) =>
        text
          .setPlaceholder('reMarkable/Sync-2')
          .onChange((value) => {
            this.syncFolder = value.trim();
          }),
      );

    // Syncthing folder ID — only shown when using Syncthing
    if (this.syncMethod === 'syncthing') {
      new Setting(contentEl)
        .setName('Syncthing folder ID')
        .setDesc('The Syncthing shared folder ID for this tablet')
        .addText((text) =>
          text
            .setPlaceholder('remarkable-xochitl')
            .onChange((value) => {
              this.syncthingFolderId = value.trim();
            }),
        );
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText('Add')
          .setCta()
          .onClick(() => {
            if (!this.label) {
              new Notice('Please enter a label for the source.');
              return;
            }
            if (!this.syncFolder) {
              new Notice('Please enter a sync folder path.');
              return;
            }

            // Warn if the sync folder is already used by another source
            if (this.existingSyncFolders.includes(this.syncFolder)) {
              new Notice(
                'Warning: This sync folder is already used by another source. ' +
                'Each source should have a unique sync folder to avoid conflicts.',
              );
              return;
            }

            const newSource: SyncSource = {
              id: generateSourceId(),
              label: this.label,
              syncFolder: this.syncFolder,
              syncthingFolderId: this.syncthingFolderId,
              lastExtractionTimestamps: {},
              syncFolderPathHash: null,
              highlightsSubfolder: null,
            };

            this.onSubmit(newSource);
            this.close();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText('Cancel')
          .onClick(() => this.close()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
