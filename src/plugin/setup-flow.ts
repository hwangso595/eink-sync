/**
 * Stateful, UI-independent orchestration for the setup wizard.
 *
 * Obsidian controls only render this state. Keeping routing here makes the
 * device/architecture policy testable without mocking the whole DOM.
 */

import type {
  ConnectionResult,
  ConnectionTestResult,
} from '../ssh/connection-manager';
import type { DeviceInfo } from '../types/device';
import type { SyncMethodSetting } from './settings';
import { isKnownLegacyInstallerTarget } from '../device/firmware';

export type WizardStep = 1 | 2 | 3 | 4 | 5;

export interface StepState {
  verified: boolean;
  message: string;
  data: Record<string, unknown>;
}

interface SetupRoutingSettings {
  syncMethod: SyncMethodSetting;
  setupComplete: boolean;
  syncFolder: string;
  syncthingApiKey: string;
  syncthingUrl: string;
  syncthingFolderId: string;
}

export interface DeviceRoutingResult {
  changed: boolean;
  message: string | null;
}

export interface SetupCompletionOperations {
  testConnectionDetailed(): Promise<ConnectionTestResult>;
  ensureDefaultSyncSource(): Promise<void>;
  isSyncProviderAvailable(): Promise<boolean>;
  preparePythonEnvironment(
    onProgress: (message: string) => void,
  ): Promise<{ created: boolean }>;
  toggleAutoSyncTimer(): void;
}

export interface SyncthingPairingOperations {
  syncFolderIsDirectory(): boolean;
  persistProviderConfiguration(): Promise<void>;
  isSyncProviderAvailable(): Promise<boolean>;
}

/** Only legacy ARMv7 tablets can use the bundled Entware installer. */
export function supportsAutomaticSyncthingInstall(device: DeviceInfo | null): boolean {
  return device !== null
    && isKnownLegacyInstallerTarget(device.model, device.architecture);
}

export class SetupFlowController {
  currentStep: WizardStep = 1;
  readonly stepStates = new Map<WizardStep, StepState>();
  deviceInfo: DeviceInfo | null = null;
  connectionResult: ConnectionResult | null = null;

  constructor(
    private readonly settings: SetupRoutingSettings,
    private readonly persist: () => Promise<void>,
  ) {
    for (let step = 1; step <= 5; step++) {
      this.stepStates.set(step as WizardStep, {
        verified: false,
        message: '',
        data: {},
      });
    }
  }

  get isSftpMode(): boolean {
    return this.settings.syncMethod === 'sftp';
  }

  get activeSteps(): WizardStep[] {
    return this.isSftpMode ? [1, 2, 5] : [1, 2, 3, 4, 5];
  }

  get nextStep(): WizardStep | null {
    const index = this.activeSteps.indexOf(this.currentStep);
    return index >= 0 && index < this.activeSteps.length - 1
      ? this.activeSteps[index + 1]
      : null;
  }

  get previousStep(): WizardStep | null {
    const index = this.activeSteps.indexOf(this.currentStep);
    return index > 0 ? this.activeSteps[index - 1] : null;
  }

  get isLastStep(): boolean {
    return this.currentStep === this.activeSteps[this.activeSteps.length - 1];
  }

  /**
   * Record the real connection/detection result and reconcile its sync route.
   *
   * A readable device identity proves the SSH connection and lets the user see
   * the failed checks on step 2. Actual error-severity preflight failures still
   * block leaving step 2; warnings do not make `report.passed` false.
   */
  async recordConnection(result: ConnectionResult): Promise<DeviceRoutingResult> {
    this.connectionResult = result;
    const connectionState = this.stepStates.get(1)!;
    const detectionState = this.stepStates.get(2)!;

    if (!result.deviceInfo) {
      this.deviceInfo = null;
      connectionState.verified = false;
      connectionState.message = result.summary;
      connectionState.data = {};
      detectionState.verified = false;
      detectionState.message = '';
      detectionState.data = {};
      return { changed: false, message: null };
    }

    this.deviceInfo = result.deviceInfo;
    connectionState.verified = true;
    connectionState.message =
      `Connected to ${result.deviceInfo.model} (firmware ${result.deviceInfo.firmware.raw})`;
    connectionState.data = { deviceInfo: result.deviceInfo };

    detectionState.data = {
      deviceInfo: result.deviceInfo,
      preflightReport: result.preflightReport,
    };
    detectionState.verified = result.preflightReport?.passed === true;
    detectionState.message = detectionState.verified
      ? 'Device detected and all required pre-flight checks passed.'
      : 'Device detected, but one or more required pre-flight checks failed.';

    const routing = await this.reconcileDeviceRoute();
    if (routing.message) connectionState.message += ` | ${routing.message}`;
    return routing;
  }

  /** Reset a stale/unsupported Syncthing selection after detecting the tablet. */
  async reconcileDeviceRoute(): Promise<DeviceRoutingResult> {
    if (this.settings.syncMethod !== 'syncthing' || supportsAutomaticSyncthingInstall(this.deviceInfo)) {
      return { changed: false, message: null };
    }

    const previousComplete = this.settings.setupComplete;
    this.settings.syncMethod = 'sftp';
    this.settings.setupComplete = false;
    try {
      await this.persist();
    } catch (err) {
      this.settings.syncMethod = 'syncthing';
      this.settings.setupComplete = previousComplete;
      throw err;
    }
    return {
      changed: true,
      message:
        'SFTP selected because automatic Syncthing installation is limited to known reMarkable 1/2 ARMv7 tablets.',
    };
  }

  /** Persist an explicit method choice made on the detection step. */
  async selectSyncMethod(method: SyncMethodSetting): Promise<void> {
    if (!this.deviceInfo) {
      throw new Error('Detect the tablet before selecting a sync method.');
    }
    if (method === 'syncthing' && !supportsAutomaticSyncthingInstall(this.deviceInfo)) {
      throw new Error(
        'Automatic Syncthing installation is unavailable for this tablet architecture. Use SFTP.',
      );
    }
    if (this.settings.syncMethod === method) return;

    const previousMethod = this.settings.syncMethod;
    const previousComplete = this.settings.setupComplete;
    this.settings.syncMethod = method;
    this.settings.setupComplete = false;
    try {
      await this.persist();
    } catch (err) {
      this.settings.syncMethod = previousMethod;
      this.settings.setupComplete = previousComplete;
      throw err;
    }
    if (method === 'sftp') {
      this.stepStates.get(3)!.verified = false;
      this.stepStates.get(4)!.verified = false;
    }
  }

  /** Run the mutating legacy installer only after the safe route is proven. */
  async installLegacySyncStack(install: () => Promise<void>): Promise<void> {
    if (this.settings.syncMethod !== 'syncthing' || !supportsAutomaticSyncthingInstall(this.deviceInfo)) {
      throw new Error('Refusing automatic Syncthing installation on an unsupported tablet.');
    }

    await install();
    const state = this.stepStates.get(3)!;
    state.verified = true;
    state.message = 'Entware and Syncthing installed successfully.';
    state.data.syncMethod = 'syncthing';
  }

  /** Verify a complete host-side Syncthing configuration, including empty libraries. */
  async verifySyncthingPairing(operations: SyncthingPairingOperations): Promise<void> {
    if (this.settings.syncMethod !== 'syncthing') {
      throw new Error('Syncthing pairing is not part of the selected SFTP route.');
    }
    if (!this.settings.syncthingApiKey.trim()) {
      throw new Error('Enter the Syncthing API key from the desktop Syncthing settings.');
    }
    if (!this.settings.syncthingUrl.trim()) {
      throw new Error('Enter the desktop Syncthing URL.');
    }
    if (!this.settings.syncthingFolderId.trim()) {
      throw new Error('Enter the Syncthing shared folder ID.');
    }
    if (!this.settings.syncFolder.trim() || !operations.syncFolderIsDirectory()) {
      throw new Error(
        `Sync folder "${this.settings.syncFolder}" does not exist. Accept the shared folder and wait for Syncthing to create it.`,
      );
    }

    await operations.persistProviderConfiguration();
    if (!await operations.isSyncProviderAvailable()) {
      throw new Error(
        'Syncthing could not verify the configured folder. Check the URL, API key, and folder ID.',
      );
    }

    const state = this.stepStates.get(4)!;
    state.verified = true;
    state.message = `Syncthing is ready for "${this.settings.syncFolder}".`;
  }

  /**
   * Verify the configured transport and extraction runtime before committing
   * setup. `isSyncProviderAvailable` must exercise the selected provider (the
   * SFTP implementation probes the SFTP subsystem, not only an SSH shell).
   */
  async completeSetup(
    operations: SetupCompletionOperations,
    onProgress: (message: string) => void = () => {},
  ): Promise<void> {
    const state = this.stepStates.get(5)!;
    state.verified = false;

    if (!this.deviceInfo || !this.stepStates.get(2)?.verified) {
      throw new Error('Complete device detection and required pre-flight checks first.');
    }
    if (
      !this.isSftpMode
      && (!this.stepStates.get(3)?.verified || !this.stepStates.get(4)?.verified)
    ) {
      throw new Error('Complete the Syncthing installation and pairing steps first.');
    }

    await this.persist();

    onProgress('Testing SSH connection...');
    const connection = await operations.testConnectionDetailed();
    if (!connection.ok) {
      throw connection.error ?? new Error('Cannot reach the tablet. Check your connection.');
    }

    await operations.ensureDefaultSyncSource();

    const providerName = this.isSftpMode ? 'SFTP' : 'Syncthing';
    onProgress(`Checking ${providerName}...`);
    if (!await operations.isSyncProviderAvailable()) {
      throw new Error(
        this.isSftpMode
          ? 'SSH connected, but the tablet SFTP subsystem is unavailable. Check Developer Mode and retry.'
          : 'Syncthing is not reachable yet. Open the Syncthing web UI, add the shared folder, then set the Syncthing URL, API key, and folder ID in settings and verify again.',
      );
    }

    onProgress('Preparing highlight extraction...');
    const python = await operations.preparePythonEnvironment(onProgress);
    onProgress(
      python.created
        ? 'Python environment installed and verified.'
        : 'Python environment verified.',
    );

    this.settings.setupComplete = true;
    try {
      await this.persist();
    } catch (err) {
      this.settings.setupComplete = false;
      throw err;
    }

    operations.toggleAutoSyncTimer();
    state.verified = true;
    state.message = 'Setup complete. E-Ink Sync is ready.';
  }
}
