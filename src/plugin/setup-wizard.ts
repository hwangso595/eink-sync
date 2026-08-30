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
 */

import { App, Modal, Setting, Notice } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type ReMarkableBridgePlugin from './plugin';
import { BridgeError } from '../types/errors';
import {
  SetupFlowController,
  supportsAutomaticSyncthingInstall,
  type StepState,
  type WizardStep,
} from './setup-flow';

export class SetupWizardModal extends Modal {
  private readonly flow: SetupFlowController;

  constructor(
    app: App,
    private plugin: ReMarkableBridgePlugin,
  ) {
    super(app);
    this.flow = new SetupFlowController(
      plugin.settings,
      () => plugin.saveSettings(),
    );
  }

  private get currentStep(): WizardStep {
    return this.flow.currentStep;
  }

  private set currentStep(step: WizardStep) {
    this.flow.currentStep = step;
  }

  private get stepStates(): Map<WizardStep, StepState> {
    return this.flow.stepStates;
  }

  private get deviceInfo() {
    return this.flow.deviceInfo;
  }

  /** Whether we're in SFTP mode (skip Syncthing steps). */
  private get isSftpMode(): boolean {
    return this.flow.isSftpMode;
  }

  /** Get the ordered list of wizard steps for the current sync method. */
  private get activeSteps(): WizardStep[] {
    return this.flow.activeSteps;
  }

  /** Get the next step in the flow, or null if at the end. */
  private getNextStep(): WizardStep | null {
    return this.flow.nextStep;
  }

  /** Get the previous step in the flow, or null if at the beginning. */
  private getPrevStep(): WizardStep | null {
    return this.flow.previousStep;
  }

  /** Whether the current step is the last step. */
  private get isLastStep(): boolean {
    return this.flow.isLastStep;
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
    new Setting(headerEl).setName('E-Ink Sync Setup').setHeading();

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
    new Setting(containerEl).setName('Step 1: Connect to your reMarkable').setHeading();
    containerEl.createEl('p', {
      text:
        'Connect your tablet via USB and enter the root password. ' +
        'Find the password on the tablet’s Copyrights and licenses screen. ' +
        'Paper Pro, Paper Pro Move, and Paper Pure require Developer Mode before SSH is available. ' +
        'Enabling Developer Mode factory-resets those devices, so sync or back up their files first. ' +
        'The plugin verifies USB first; enabling WiFi afterward is a separate explicit action.',
    });

    const settings = this.plugin.settings;
    const state = this.stepStates.get(1)!;

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
            state.verified = false;
            state.message = '';
          });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
      });

    // Verify button and status
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
              // Setup always starts from the fixed USB endpoint. This avoids a
              // stale saved WiFi address changing which tablet is detected.
              await this.plugin.useUsbConnection();
              const result = await this.plugin.connectAndVerifyUsb(
                (step: string, detail: string) => {
                  statusEl.setText(`${step}: ${detail}`);
                },
              );
              const routing = await this.flow.recordConnection(result);
              if (routing.changed) {
                new Notice(routing.message ?? 'SFTP selected for this tablet.');
              }
              // Persist the password even when no routing change was needed.
              await this.plugin.saveSettings();
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

    if (state.verified) {
      new Setting(containerEl)
        .setName('Use WiFi after setup')
        .setDesc(
          'Optional. This explicitly runs "rm-ssh-over-wlan on" when the tablet provides it, ' +
          'discovers the WiFi address, verifies the same tablet host key, and only then switches. ' +
          'This exposes password-protected SSH on your local network, so use it only on trusted WiFi. ' +
          'It does not enable Developer Mode or reset the tablet.',
        )
        .addButton((button) =>
          button
            .setButtonText('Enable & verify WiFi')
            .setCta()
            .onClick(async () => {
              button.setDisabled(true);
              button.setButtonText('Verifying WiFi...');
              try {
                const result = await this.plugin.enableAndUseWifiViaUsb();
                state.data.wifiStatus = `WiFi verified at ${result.host}; it is now the default connection.`;
                state.data.wifiError = false;
                new Notice(`Tablet WiFi verified at ${result.host}.`);
              } catch (err) {
                state.data.wifiStatus = err instanceof BridgeError
                  ? err.toUserMessage()
                  : err instanceof Error ? err.message : 'WiFi setup failed; USB remains selected.';
                state.data.wifiError = true;
              }
              this.renderCurrentStep();
            }),
        );

      if (typeof state.data.wifiStatus === 'string') {
        containerEl.createDiv({
          cls: `remarkable-wizard-status ${state.data.wifiError ? 'is-error' : 'is-success'}`,
          text: state.data.wifiStatus,
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // Step 2: Firmware Detection & Preflight
  // -------------------------------------------------------------------
  private renderStep2(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Step 2: Device Detection').setHeading();

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
    this.addInfoRow(infoTable, 'Architecture', info.architecture);
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
      new Setting(containerEl).setName('Pre-flight Checks').setHeading();
      const checksEl = containerEl.createDiv({ cls: 'remarkable-wizard-checks' });

      for (const check of report.checks) {
        const checkRow = checksEl.createDiv({ cls: 'remarkable-wizard-check-row' });
        const icon = check.passed ? '\u2713' : '\u2717';
        const cls = check.passed ? 'is-pass' : 'is-fail';
        checkRow.createSpan({ text: icon, cls: `remarkable-check-icon ${cls}` });
        checkRow.createSpan({ text: `${check.name}: ${check.message}` });
      }
    }

    new Setting(containerEl).setName('Sync method').setHeading();
    if (supportsAutomaticSyncthingInstall(info)) {
      new Setting(containerEl)
        .setName('Tablet transfer')
        .setDesc(
          'SFTP is simpler and does not install tablet software. Syncthing provides background sync ' +
          'and uses the legacy ARMv7 Entware installer in the next step.',
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOption('sftp', 'SFTP (recommended)')
            .addOption('syncthing', 'Syncthing (background sync)')
            .setValue(this.plugin.settings.syncMethod)
            .onChange(async (value) => {
              try {
                await this.flow.selectSyncMethod(value as 'sftp' | 'syncthing');
              } catch (err) {
                const message = err instanceof Error ? err.message : 'Could not save the sync method.';
                new Notice(`E-Ink Sync: ${message}`);
              }
              this.renderCurrentStep();
            }),
        );
    } else {
      containerEl.createEl('p', {
        text:
          `SFTP selected for ${info.model}/${info.architecture}. Automatic Syncthing installation ` +
          'is limited to the known reMarkable 1 and reMarkable 2 ARMv7 models.',
        cls: 'remarkable-wizard-safety-note',
      });
    }

    // recordConnection() verifies this only when required pre-flight checks pass.
    const verifyContainer = containerEl.createDiv({ cls: 'remarkable-wizard-verify' });
    const state = this.stepStates.get(2)!;

    const statusEl = verifyContainer.createDiv({ cls: 'remarkable-wizard-status' });
    if (state.verified) {
      statusEl.addClass('is-success');
      statusEl.setText(state.message);
    } else {
      statusEl.addClass('is-error');
      statusEl.setText(
        report?.passed === false
          ? 'Required pre-flight checks failed. Resolve the failed checks, then go back and verify again.'
          : 'Detection incomplete.',
      );
    }
  }

  // -------------------------------------------------------------------
  // Step 3: Sync Method Selection
  // -------------------------------------------------------------------
  private renderStep3(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Step 3: Install Syncthing').setHeading();

    // The bundled Entware path is limited to known rM1/rM2 ARMv7 hardware.
    // Keep current, unknown, and future devices on the safe SFTP route.
    if (!supportsAutomaticSyncthingInstall(this.deviceInfo)) {
      const architecture = this.deviceInfo?.architecture ?? 'unknown';
      containerEl.createEl('p', {
        text:
          `Automatic Syncthing installation is unavailable for ${architecture} tablets. ` +
          'SFTP provides the supported sync path and does not install software on the tablet.',
        cls: 'remarkable-wizard-warning',
      });

      new Setting(containerEl)
        .addButton((button) =>
          button
            .setButtonText('Use SFTP instead')
            .setCta()
            .onClick(async () => {
              await this.flow.selectSyncMethod('sftp');
              this.currentStep = 5;
              this.renderCurrentStep();
            }),
        );
      return;
    }

    containerEl.createEl('p', {
      text:
        'Syncthing provides automatic background sync between your reMarkable ' +
        'and this computer. It requires installing Entware and Syncthing on the tablet. ' +
        'Package data is stored in /home/root/.entware; the legacy installer also creates ' +
        'an /opt bind mount and /etc/systemd/system/opt.mount.',
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
              await this.flow.installLegacySyncStack(
                () => this.plugin.installSyncStack(
                  (phase: string, step: string, detail: string) => {
                    appendLog(`[${phase}] ${step}: ${detail}`);
                  },
                ),
              );

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
    const invalidatePairing = (): void => {
      state.verified = false;
      state.message = '';
    };

    new Setting(containerEl).setName('Step 4: Configure Syncthing').setHeading();

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
              window.setTimeout(() => {
                button.setDisabled(false);
                button.setButtonText('Get Device ID');
              }, 5000);
            }),
        );
    }

    new Setting(containerEl)
      .setName('Desktop Syncthing URL')
      .setDesc('The Syncthing web/API address on this computer.')
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:8384')
          .setValue(this.plugin.settings.syncthingUrl)
          .onChange((value) => {
            this.plugin.settings.syncthingUrl = value.trim();
            invalidatePairing();
          }),
      );

    new Setting(containerEl)
      .setName('Desktop Syncthing API key')
      .setDesc('Found in the desktop Syncthing web UI under Actions > Settings.')
      .addText((text) => {
        text
          .setPlaceholder('Enter API key')
          .setValue(this.plugin.settings.syncthingApiKey)
          .onChange((value) => {
            this.plugin.settings.syncthingApiKey = value.trim();
            invalidatePairing();
          });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
      });

    new Setting(containerEl)
      .setName('Syncthing folder ID')
      .setDesc('Must match the shared folder ID configured in desktop Syncthing.')
      .addText((text) =>
        text
          .setPlaceholder('remarkable-xochitl')
          .setValue(this.plugin.settings.syncthingFolderId)
          .onChange((value) => {
            this.plugin.settings.syncthingFolderId = value.trim();
            invalidatePairing();
          }),
      );

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
            invalidatePairing();
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
              const basePath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '';
              const fullPath = basePath ? path.join(basePath, syncFolder) : syncFolder;
              await this.flow.verifySyncthingPairing({
                syncFolderIsDirectory: () => {
                  try {
                    return fs.statSync(fullPath).isDirectory();
                  } catch {
                    return false;
                  }
                },
                persistProviderConfiguration: async () => {
                  const sources = this.plugin.getSyncSources();
                  if (sources.length > 0) {
                    await this.plugin.updateSyncSources([
                      {
                        ...sources[0],
                        syncFolder: this.plugin.settings.syncFolder,
                        syncthingFolderId: this.plugin.settings.syncthingFolderId,
                      },
                      ...sources.slice(1),
                    ]);
                  } else {
                    await this.plugin.saveSettings();
                  }
                },
                isSyncProviderAvailable: () => this.plugin.getSyncProvider().isAvailable(),
              });
            } catch (err) {
              state.verified = false;
              state.message = err instanceof BridgeError
                ? err.toUserMessage()
                : err instanceof Error ? err.message : 'Verification failed.';
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
    const state = this.stepStates.get(5)!;
    const invalidateCompletion = (): void => {
      state.verified = false;
      state.message = '';
    };
    const stepLabel = this.isSftpMode ? 'Step 3: Review & Finish' : 'Step 5: Review & Finish';
    new Setting(containerEl).setName(stepLabel).setHeading();
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
              invalidateCompletion();
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
            invalidateCompletion();
          }),
      );

    // Summary card
    const summaryEl = containerEl.createDiv({ cls: 'remarkable-wizard-summary' });
    new Setting(summaryEl).setName('Setup summary').setHeading();

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
              await this.flow.completeSetup({
                testConnectionDetailed: () => this.plugin.testConnectionDetailed(),
                ensureDefaultSyncSource: async () => {
                  const sources = this.plugin.getSyncSources();
                  if (sources.length === 0 && this.plugin.settings.syncFolder) {
                    const { generateSourceId } = await import('./settings');
                    await this.plugin.updateSyncSources([{
                      id: generateSourceId(),
                      label: 'Default',
                      syncFolder: this.plugin.settings.syncFolder,
                      syncthingFolderId: this.plugin.settings.syncthingFolderId ?? '',
                      lastExtractionTimestamps: {} as Record<string, number>,
                      syncFolderPathHash: null,
                      highlightsSubfolder: null,
                    }]);
                  }
                },
                isSyncProviderAvailable: () => this.plugin.getSyncProvider().isAvailable(),
                preparePythonEnvironment: (onProgress) =>
                  this.plugin.preparePythonEnvironment(onProgress),
                toggleAutoSyncTimer: () => this.plugin.toggleAutoSyncTimer(),
              }, (message) => statusEl.setText(message));

              new Notice('E-Ink Sync setup complete!');
            } catch (err) {
              state.verified = false;
              state.message = err instanceof BridgeError
                ? err.toUserMessage()
                : err instanceof Error ? err.message : 'Verification failed.';
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
