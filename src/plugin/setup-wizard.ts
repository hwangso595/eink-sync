/**
 * Setup wizard modal for first-time configuration.
 *
 * Walks the user through five steps:
 *   1. SSH Connection Test -- enter IP/password, verify connectivity
 *   2. Firmware Detection  -- display device info and preflight results
 *   3. Entware Install     -- install Entware + Syncthing on the tablet
 *   4. Syncthing Pairing   -- configure Syncthing for local-only sync
 *   5. First Sync          -- trigger first sync, choose output folder
 *
 * Each step has a "Verify" button that must pass before the user can proceed.
 * Uses Obsidian's native Modal, Setting, and DOM APIs. No custom styling beyond
 * what is needed for the step layout.
 *
 * Privacy: The wizard only communicates with the user's tablet over SSH.
 * No analytics, telemetry, or external network calls.
 */

import { App, Modal, Setting, Notice } from 'obsidian';
import type ReMarkableBridgePlugin from './plugin';
import type { DeviceInfo } from '../types/device';
import type { ConnectionResult } from '../ssh/connection-manager';

/**
 * The wizard steps. When syncMethod is 'sftp', steps 3 (Entware Install)
 * and 4 (Syncthing Pairing) are skipped -- the wizard goes 1 -> 2 -> 5.
 */
type WizardStep = 1 | 2 | 3 | 4 | 5;

/** Per-step verification state. */
interface StepState {
  verified: boolean;
  message: string;
  data: Record<string, unknown>;
}

export class SetupWizardModal extends Modal {
  private currentStep: WizardStep = 1;
  private stepStates: Map<WizardStep, StepState> = new Map();
  private deviceInfo: DeviceInfo | null = null;
  private connectionResult: ConnectionResult | null = null;

  constructor(
    app: App,
    private plugin: ReMarkableBridgePlugin,
  ) {
    super(app);
    // Initialize step states
    for (let i = 1; i <= 5; i++) {
      this.stepStates.set(i as WizardStep, {
        verified: false,
        message: '',
        data: {},
      });
    }
  }

  /** Whether we're in SFTP mode (skip Syncthing steps). */
  private get isSftpMode(): boolean {
    return (this.plugin.settings.syncMethod ?? 'sftp') === 'sftp';
  }

  /** Get the ordered list of wizard steps for the current sync method. */
  private get activeSteps(): WizardStep[] {
    if (this.isSftpMode) {
      // SFTP: skip Entware install (3) and Syncthing pairing (4)
      return [1, 2, 5];
    }
    return [1, 2, 3, 4, 5];
  }

  /** Get the next step in the flow, or null if at the end. */
  private getNextStep(): WizardStep | null {
    const steps = this.activeSteps;
    const idx = steps.indexOf(this.currentStep);
    return idx < steps.length - 1 ? steps[idx + 1] : null;
  }

  /** Get the previous step in the flow, or null if at the beginning. */
  private getPrevStep(): WizardStep | null {
    const steps = this.activeSteps;
    const idx = steps.indexOf(this.currentStep);
    return idx > 0 ? steps[idx - 1] : null;
  }

  /** Whether the current step is the last step. */
  private get isLastStep(): boolean {
    const steps = this.activeSteps;
    return this.currentStep === steps[steps.length - 1];
  }

  onOpen(): void {
    this.modalEl.addClass('remarkable-setup-wizard');
    this.renderCurrentStep();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderCurrentStep(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Header with step indicator
    this.renderStepIndicator(contentEl);

    // Step content
    const stepContainer = contentEl.createDiv({ cls: 'remarkable-wizard-step' });

    switch (this.currentStep) {
      case 1:
        this.renderStep1(stepContainer);
        break;
      case 2:
        this.renderStep2(stepContainer);
        break;
      case 3:
        this.renderStep3(stepContainer);
        break;
      case 4:
        this.renderStep4(stepContainer);
        break;
      case 5:
        this.renderStep5(stepContainer);
        break;
    }

    // Navigation buttons
    this.renderNavigation(contentEl);
  }

  /**
   * Render the step progress indicator (1 of 5, 2 of 5, etc).
   */
  private renderStepIndicator(containerEl: HTMLElement): void {
    const headerEl = containerEl.createDiv({ cls: 'remarkable-wizard-header' });
    headerEl.createEl('h2', { text: 'reMarkable Bridge Setup' });

    const stepsEl = headerEl.createDiv({ cls: 'remarkable-wizard-steps' });
    const stepLabels: Record<number, string> = {
      1: 'Connection',
      2: 'Detection',
      3: 'Install',
      4: 'Pairing',
      5: 'Finish',
    };

    const steps = this.activeSteps;
    for (let idx = 0; idx < steps.length; idx++) {
      const step = steps[idx];
      const stepEl = stepsEl.createSpan({
        cls: 'remarkable-wizard-step-indicator',
      });

      if (step === this.currentStep) {
        stepEl.addClass('is-active');
      } else if (this.stepStates.get(step)?.verified) {
        stepEl.addClass('is-complete');
      }

      stepEl.setText(`${idx + 1}. ${stepLabels[step]}`);
    }
  }

  // -------------------------------------------------------------------
  // Step 1: SSH Connection Test
  // -------------------------------------------------------------------
  private renderStep1(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Step 1: Connect to your reMarkable' });
    containerEl.createEl('p', {
      text:
        'Connect your tablet via USB and enter the root password. ' +
        'Find the password on your tablet at Settings > Help > Copyrights and licenses (scroll to the bottom). ' +
        'After connecting, the plugin will auto-detect your tablet\'s WiFi IP for wireless syncing.',
    });

    const settings = this.plugin.settings;

    // Default to USB for initial setup — WiFi IP auto-detected after connection
    if (!settings.tabletIp) {
      settings.tabletIp = '10.11.99.1';
      settings.connectionMethod = 'usb';
    }

    containerEl.createEl('p', {
      text: 'Plug in your reMarkable via USB cable, then enter the root password below.',
      cls: 'remarkable-wizard-hint',
    });

    new Setting(containerEl)
      .setName('Root password')
      .addText((text) => {
        text
          .setPlaceholder('Enter root password')
          .setValue(settings.rootPassword)
          .onChange((value) => {
            settings.rootPassword = value;
          });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
      });

    // Verify button and status
    const verifyContainer = containerEl.createDiv({ cls: 'remarkable-wizard-verify' });
    const statusEl = verifyContainer.createDiv({ cls: 'remarkable-wizard-status' });
    const state = this.stepStates.get(1)!;

    if (state.verified) {
      statusEl.addClass('is-success');
      statusEl.setText(state.message);
    } else if (state.message) {
      statusEl.addClass('is-error');
      statusEl.setText(state.message);
    }

    new Setting(verifyContainer)
      .addButton((button) =>
        button
          .setButtonText('Verify Connection')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Connecting...');
            statusEl.empty();
            statusEl.removeClass('is-success', 'is-error');
            statusEl.addClass('is-loading');
            statusEl.setText('Establishing SSH connection...');

            try {
              const result = await this.plugin.connectAndVerify(
                (step: string, detail: string) => {
                  statusEl.setText(`${step}: ${detail}`);
                },
              );

              this.connectionResult = result;
              if (result.success && result.deviceInfo) {
                this.deviceInfo = result.deviceInfo;
                state.verified = true;
                state.message = `Connected to ${result.deviceInfo.model} (firmware ${result.deviceInfo.firmware.raw})`;
                state.data = { deviceInfo: result.deviceInfo };

                // Also mark step 2 data
                const step2 = this.stepStates.get(2)!;
                step2.data = {
                  deviceInfo: result.deviceInfo,
                  preflightReport: result.preflightReport,
                };

                // Auto-detect WiFi IP if connected via USB
                if (settings.connectionMethod === 'usb') {
                  try {
                    statusEl.setText('Detecting WiFi IP address...');
                    const wifiIp = await this.plugin.detectTabletWifiIp();
                    if (wifiIp) {
                      state.message += ` | WiFi IP: ${wifiIp}`;
                      state.data.wifiIp = wifiIp;
                      // Auto-configure for WiFi sync
                      settings.tabletIp = wifiIp;
                      settings.connectionMethod = 'wifi';
                      new Notice(`Tablet WiFi IP detected: ${wifiIp}. Switching to WiFi mode.`);
                    }
                  } catch {
                    // WiFi detection failed — tablet may not be on WiFi, that's fine
                  }
                }

                await this.plugin.saveSettings();
              } else {
                state.verified = false;
                state.message = result.summary;
              }
            } catch (err) {
              state.verified = false;
              state.message = err instanceof Error
                ? err.message
                : 'Connection failed. Check settings and try again.';
            }

            button.setDisabled(false);
            button.setButtonText('Verify Connection');
            this.renderCurrentStep();
          }),
      );
  }

  // -------------------------------------------------------------------
  // Step 2: Firmware Detection & Preflight
  // -------------------------------------------------------------------
  private renderStep2(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Step 2: Device Detection' });

    if (!this.deviceInfo) {
      containerEl.createEl('p', {
        text: 'No device information available. Please complete Step 1 first.',
        cls: 'remarkable-wizard-warning',
      });
      return;
    }

    containerEl.createEl('p', {
      text: 'Your reMarkable has been detected. Review the device information below.',
    });

    const info = this.deviceInfo;
    const infoTable = containerEl.createDiv({ cls: 'remarkable-wizard-device-info' });

    this.addInfoRow(infoTable, 'Device Model', info.model);
    this.addInfoRow(infoTable, 'Firmware Version', info.firmware.raw);
    this.addInfoRow(infoTable, 'Kernel', info.kernelVersion);
    this.addInfoRow(infoTable, 'Total RAM', `${info.memory.totalMB} MB`);
    this.addInfoRow(infoTable, 'Available RAM', `${info.memory.availableMB} MB`);

    for (const storage of info.storage) {
      this.addInfoRow(
        infoTable,
        `Storage (${storage.mountPoint})`,
        `${storage.availableMB} MB free of ${storage.totalMB} MB (${storage.usagePercent}% used)`,
      );
    }

    if (info.serialNumber) {
      this.addInfoRow(infoTable, 'Serial Number', info.serialNumber);
    }

    // Preflight report
    const step2 = this.stepStates.get(2)!;
    const report = step2.data?.preflightReport as { passed: boolean; checks: Array<{ name: string; passed: boolean; message: string }> } | undefined;

    if (report) {
      containerEl.createEl('h4', { text: 'Pre-flight Checks' });
      const checksEl = containerEl.createDiv({ cls: 'remarkable-wizard-checks' });

      for (const check of report.checks) {
        const checkRow = checksEl.createDiv({ cls: 'remarkable-wizard-check-row' });
        const icon = check.passed ? '\u2713' : '\u2717';
        const cls = check.passed ? 'is-pass' : 'is-fail';
        checkRow.createSpan({ text: icon, cls: `remarkable-check-icon ${cls}` });
        checkRow.createSpan({ text: `${check.name}: ${check.message}` });
      }
    }

    // Verify button (auto-verified if step 1 passed with device info)
    const verifyContainer = containerEl.createDiv({ cls: 'remarkable-wizard-verify' });
    const state = this.stepStates.get(2)!;

    if (this.deviceInfo && this.connectionResult?.success) {
      state.verified = true;
      state.message = 'Device detected and all pre-flight checks passed.';
    }

    const statusEl = verifyContainer.createDiv({ cls: 'remarkable-wizard-status' });
    if (state.verified) {
      statusEl.addClass('is-success');
      statusEl.setText(state.message);
    } else {
      statusEl.addClass('is-error');
      statusEl.setText(
        report?.passed === false
          ? 'Some pre-flight checks failed. You may still proceed, but setup may encounter issues.'
          : 'Detection incomplete.',
      );
      // Allow proceeding even with warnings
      state.verified = true;
    }
  }

  // -------------------------------------------------------------------
  // Step 3: Sync Method Selection
  // -------------------------------------------------------------------
  private renderStep3(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Step 3: Install Syncthing' });
    containerEl.createEl('p', {
      text:
        'Syncthing provides automatic background sync between your reMarkable ' +
        'and this computer. It requires installing Entware and Syncthing on the tablet. ' +
        'All files go to /home/root/.entware (safe, reversible with rm -rf /home/root/.entware).',
    });

    const state = this.stepStates.get(3)!;
    state.data.syncMethod = 'syncthing';

    const safetyNote = containerEl.createDiv({ cls: 'remarkable-wizard-safety-note' });
    safetyNote.createEl('strong', { text: 'Requires: ' });
    safetyNote.createSpan({
      text: 'Syncthing installed on both this computer and the tablet. Internet access on the tablet for initial install.',
    });

    const statusEl = containerEl.createDiv({ cls: 'remarkable-wizard-status' });
    const logEl = containerEl.createDiv({ cls: 'remarkable-wizard-log' });

    if (state.verified) {
      statusEl.addClass('is-success');
      statusEl.setText(state.message);
    } else if (state.message) {
      statusEl.addClass('is-error');
      statusEl.setText(state.message);
    }

    const verifyContainer = containerEl.createDiv({ cls: 'remarkable-wizard-verify' });

    new Setting(verifyContainer)
      .addButton((button) =>
        button
          .setButtonText('Install on Tablet')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Installing...');
            statusEl.empty();
            statusEl.removeClass('is-success', 'is-error');
            logEl.empty();

            const appendLog = (text: string) => {
              logEl.createDiv({ text, cls: 'remarkable-wizard-log-line' });
              logEl.scrollTop = logEl.scrollHeight;
            };

            try {
              appendLog('Starting installation...');
              await this.plugin.installSyncStack(
                (phase: string, step: string, detail: string) => {
                  appendLog(`[${phase}] ${step}: ${detail}`);
                },
              );

              state.verified = true;
              state.message = 'Entware and Syncthing installed successfully.';
              statusEl.addClass('is-success');
              statusEl.setText(state.message);
              appendLog('Installation complete.');
            } catch (err) {
              state.verified = false;
              state.message = err instanceof Error ? err.message : 'Installation failed.';
              statusEl.addClass('is-error');
              statusEl.setText(state.message);
              appendLog(`ERROR: ${state.message}`);
            }

            button.setDisabled(false);
            button.setButtonText('Install on Tablet');
            this.renderCurrentStep();
          }),
      );
  }

  // -------------------------------------------------------------------
  // Step 4: Syncthing Pairing
  // -------------------------------------------------------------------
  private renderStep4(containerEl: HTMLElement): void {
    const state = this.stepStates.get(4)!;

    containerEl.createEl('h3', { text: 'Step 4: Configure Syncthing' });

    containerEl.createEl('p', {
      text: 'You need to pair Syncthing on your computer with the tablet. Follow these steps:',
    });

    const steps = containerEl.createEl('ol', { cls: 'remarkable-wizard-steps-list' });
    steps.createEl('li', {
      text: 'Open Syncthing on your computer (http://127.0.0.1:8384)',
    });
    steps.createEl('li', {
      text: 'Accept the reMarkable device when it appears, or add it manually using the Device ID shown below',
    });
    steps.createEl('li', {
      text: 'When asked about the shared folder "reMarkable Documents", accept it',
    });
    steps.createEl('li', {
      text: 'Set the folder path to a location inside your vault (e.g., your vault path + /reMarkable)',
    });
    steps.createEl('li', {
      text: 'Set the folder type to "Send & Receive"',
    });
    steps.createEl('li', {
      text: 'Click "Verify" below to confirm sync is working',
    });

    // Warning
    const warning = containerEl.createDiv({ cls: 'remarkable-wizard-status is-error' });
    warning.createEl('strong', { text: 'Important: ' });
    warning.createSpan({
      text: 'Do not manually modify files in the Syncthing sync folder. ' +
        'Use the plugin commands to send documents or archive them. ' +
        'Editing files directly can corrupt the tablet\'s document database.',
    });

    // Show tablet device ID for manual pairing
    if (this.deviceInfo) {
      const idContainer = containerEl.createDiv({ cls: 'remarkable-wizard-safety-note' });
      idContainer.createEl('strong', { text: 'Tablet Syncthing Device ID: ' });

      const verifyIdContainer = idContainer.createDiv();
      new Setting(verifyIdContainer)
        .addButton((button) =>
          button
            .setButtonText('Get Device ID')
            .onClick(async () => {
              button.setDisabled(true);
              button.setButtonText('Fetching...');
              try {
                const id = await this.plugin.withSSH(async (ssh) => {
                  const result = await ssh.execute(
                    '/home/root/.entware/bin/syncthing --device-id 2>/dev/null || syncthing --device-id 2>/dev/null'
                  );
                  return result.stdout.trim();
                });
                idContainer.createEl('code', { text: id, cls: 'remarkable-device-id' });
                button.setButtonText('Got it');
              } catch {
                button.setButtonText('Failed (is tablet connected?)');
              }
              setTimeout(() => {
                button.setDisabled(false);
                button.setButtonText('Get Device ID');
              }, 5000);
            }),
        );
    }

    // Sync folder path
    new Setting(containerEl)
      .setName('Sync folder (relative to vault)')
      .setDesc('Must match the folder path you set in Syncthing above.')
      .addText((text) =>
        text
          .setPlaceholder('reMarkable/Sync')
          .setValue(this.plugin.settings.syncFolder || 'reMarkable/Sync')
          .onChange((value) => {
            this.plugin.settings.syncFolder = value.trim();
          }),
      );

    // Verify button
    const verifyContainer = containerEl.createDiv({ cls: 'remarkable-wizard-verify' });
    const statusEl = verifyContainer.createDiv({ cls: 'remarkable-wizard-status' });

    if (state.verified) {
      statusEl.addClass('is-success');
      statusEl.setText(state.message);
    } else if (state.message) {
      statusEl.addClass('is-error');
      statusEl.setText(state.message);
    }

    new Setting(verifyContainer)
      .addButton((button) =>
        button
          .setButtonText('Verify Sync')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Checking...');
            statusEl.empty();
            statusEl.removeClass('is-success', 'is-error');

            try {
              const syncFolder = this.plugin.settings.syncFolder || 'reMarkable/Sync';
              const fs = require('fs');
              const path = require('path');
              const basePath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '';
              const fullPath = basePath ? path.join(basePath, syncFolder) : syncFolder;

              // Check if the folder exists and has metadata files
              if (!fs.existsSync(fullPath)) {
                state.verified = false;
                state.message = `Folder "${fullPath}" does not exist. Make sure Syncthing has synced at least once.`;
              } else {
                const files = fs.readdirSync(fullPath);
                const metaFiles = files.filter((f: string) => f.endsWith('.metadata'));

                if (metaFiles.length > 0) {
                  state.verified = true;
                  state.message = `Sync working! Found ${metaFiles.length} document(s) in "${syncFolder}".`;
                } else {
                  state.verified = false;
                  state.message = `Folder exists but no documents found yet. Wait for Syncthing to complete the initial sync, then try again.`;
                }
              }
            } catch (err) {
              state.verified = false;
              state.message = err instanceof Error ? err.message : 'Verification failed.';
            }

            statusEl.addClass(state.verified ? 'is-success' : 'is-error');
            statusEl.setText(state.message);
            button.setDisabled(false);
            button.setButtonText('Verify Sync');
            this.renderCurrentStep();
          }),
      );
  }

  // -------------------------------------------------------------------
  // Step 5: First Sync & Output Folder
  // -------------------------------------------------------------------
  private renderStep5(containerEl: HTMLElement): void {
    const stepLabel = this.isSftpMode ? 'Step 3: Review & Finish' : 'Step 5: Review & Finish';
    containerEl.createEl('h3', { text: stepLabel });
    containerEl.createEl('p', {
      text: 'Review your setup and verify everything works.',
    });

    // Sync folder setting -- especially important for SFTP where there's no
    // Syncthing pairing step to set this.
    if (this.isSftpMode) {
      new Setting(containerEl)
        .setName('Sync folder (relative to vault)')
        .setDesc('Files from the tablet will be downloaded here via SFTP.')
        .addText((text) =>
          text
            .setPlaceholder('reMarkable/Sync')
            .setValue(this.plugin.settings.syncFolder || 'reMarkable/Sync')
            .onChange((value) => {
              this.plugin.settings.syncFolder = value.trim();
            }),
        );
    }

    new Setting(containerEl)
      .setName('PDF link format')
      .setDesc('How highlight notes reference pages in the source PDF.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('pdfpp', 'PDF++ (recommended)')
          .addOption('obsidian', 'Obsidian built-in')
          .addOption('none', 'No links')
          .setValue(this.plugin.settings.extraction.pdfLinkFormat)
          .onChange((value) => {
            this.plugin.settings.extraction.pdfLinkFormat = value as 'pdfpp' | 'obsidian' | 'none';
          }),
      );

    // Summary card
    const summaryEl = containerEl.createDiv({ cls: 'remarkable-wizard-summary' });
    summaryEl.createEl('h4', { text: 'Setup Summary' });

    const syncMethodLabel = this.isSftpMode ? 'SFTP (direct SSH)' : 'Syncthing';
    const summaryItems: [string, string][] = [
      ['Tablet', this.deviceInfo ? `${this.deviceInfo.model} (fw ${this.deviceInfo.firmware.raw})` : 'Not detected'],
      ['Connection', `${this.plugin.settings.connectionMethod.toUpperCase()} to ${this.plugin.settings.tabletIp}`],
      ['Sync Method', syncMethodLabel],
      ['Sync Folder', this.plugin.settings.syncFolder || '(not set)'],
      ['Highlights Folder', this.plugin.settings.highlightsFolder || '(not set)'],
      ['Archive Folder', this.plugin.settings.archiveFolder || '(not set)'],
      ['PDF Links', this.plugin.settings.extraction.pdfLinkFormat === 'pdfpp' ? 'PDF++' : this.plugin.settings.extraction.pdfLinkFormat],
    ];

    for (const [label, value] of summaryItems) {
      this.addInfoRow(summaryEl, label, value);
    }

    // Final verify
    const state = this.stepStates.get(5)!;
    const verifyContainer = containerEl.createDiv({ cls: 'remarkable-wizard-verify' });
    const statusEl = verifyContainer.createDiv({ cls: 'remarkable-wizard-status' });

    if (state.verified) {
      statusEl.addClass('is-success');
      statusEl.setText(state.message);
    } else if (state.message) {
      statusEl.addClass('is-error');
      statusEl.setText(state.message);
    }

    new Setting(verifyContainer)
      .addButton((button) =>
        button
          .setButtonText('Verify & Complete Setup')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Verifying...');

            try {
              // Save all settings
              await this.plugin.saveSettings();

              // Test connection one more time
              statusEl.setText('Testing connection...');
              const connected = await this.plugin.testConnection();
              if (!connected) {
                throw new Error('Cannot reach the tablet. Check your connection.');
              }

              // Ensure a default sync source exists
              const sources = this.plugin.getSyncSources();
              if (sources.length === 0 && this.plugin.settings.syncFolder) {
                const { generateSourceId } = await import('./settings');
                const newSource = {
                  id: generateSourceId(),
                  label: 'Default',
                  syncFolder: this.plugin.settings.syncFolder,
                  syncthingFolderId: this.plugin.settings.syncthingFolderId ?? '',
                  lastExtractionTimestamps: {} as Record<string, number>,
                  syncFolderPathHash: null,
                  highlightsSubfolder: null,
                };
                await this.plugin.updateSyncSources([newSource]);
              }

              // Mark setup as complete
              this.plugin.settings.setupComplete = true;
              await this.plugin.saveSettings();

              // Start auto-sync timer if enabled (SFTP mode)
              this.plugin.toggleAutoSyncTimer();

              state.verified = true;
              state.message = 'Setup complete. Your reMarkable Bridge is ready.';

              new Notice('reMarkable Bridge setup complete!');
            } catch (err) {
              state.verified = false;
              state.message = err instanceof Error ? err.message : 'Verification failed.';
            }

            button.setDisabled(false);
            button.setButtonText('Verify & Complete Setup');
            this.renderCurrentStep();
          }),
      );
  }

  // -------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------

  private addInfoRow(containerEl: HTMLElement, label: string, value: string): void {
    const row = containerEl.createDiv({ cls: 'remarkable-info-row' });
    row.createSpan({ text: label, cls: 'remarkable-info-label' });
    row.createSpan({ text: value, cls: 'remarkable-info-value' });
  }

  /**
   * Render the bottom navigation bar (Back / Next / Finish).
   */
  private renderNavigation(containerEl: HTMLElement): void {
    const navEl = containerEl.createDiv({ cls: 'remarkable-wizard-nav' });

    // Back button
    const prevStep = this.getPrevStep();
    if (prevStep !== null) {
      new Setting(navEl)
        .addButton((button) =>
          button
            .setButtonText('Back')
            .onClick(() => {
              this.currentStep = prevStep;
              this.renderCurrentStep();
            }),
        );
    }

    // Spacer
    navEl.createDiv({ cls: 'remarkable-wizard-nav-spacer' });

    // Next or Finish button
    const currentState = this.stepStates.get(this.currentStep)!;

    if (!this.isLastStep) {
      const nextStep = this.getNextStep();
      new Setting(navEl)
        .addButton((button) => {
          button
            .setButtonText('Next')
            .setCta()
            .onClick(() => {
              if (!currentState.verified) {
                new Notice('Please verify the current step before proceeding.');
                return;
              }
              if (nextStep !== null) {
                this.currentStep = nextStep;
                this.renderCurrentStep();
              }
            });

          if (!currentState.verified) {
            button.setDisabled(true);
          }
        });
    } else {
      // Last step: Finish button
      if (currentState.verified) {
        new Setting(navEl)
          .addButton((button) =>
            button
              .setButtonText('Finish')
              .setCta()
              .onClick(() => {
                this.close();
              }),
          );
      }
    }
  }
}
