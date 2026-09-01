import type { ConnectionResult } from '../ssh/connection-manager';
import type { DeviceArchitecture, DeviceInfo, DeviceModel } from '../types/device';
import { BridgeError, ErrorCode } from '../types/errors';
import type { SyncMethodSetting } from './settings';
import {
  resolveWizardConnectionTarget,
  SetupFlowController,
  supportsAutomaticSyncthingInstall,
} from './setup-flow';

function device(model: DeviceModel, architecture: DeviceArchitecture): DeviceInfo {
  return {
    model,
    architecture,
    firmware: { raw: '3.27.0.1', major: 3, minor: 27, patch: 0, build: 1 },
    memory: { totalMB: 2048, availableMB: 1024, usedMB: 1024 },
    storage: [],
    kernelVersion: '6.1.0',
    serialNumber: null,
  };
}

function connection(
  info: DeviceInfo | null,
  preflightPassed = true,
  automaticSyncthingInstallReady = true,
): ConnectionResult {
  return {
    success: info !== null && preflightPassed,
    deviceInfo: info,
    preflightReport: info === null ? null : {
      passed: preflightPassed,
      checks: [],
      deviceInfo: info,
      installationPath: info.architecture === 'armv7' ? 'entware' : 'sftp-only',
      usesV6Format: true,
      resourceBudget: {
        syncthingMaxMemoryMB: 64,
        minFreeMemoryMB: 100,
        minFreeStorageMB: 50,
      },
      automaticSyncthingInstallReady,
      timestamp: '2026-08-30T00:00:00.000Z',
    },
    summary: info ? 'Detected' : 'SSH failed',
    error: null,
  };
}

function flow(initialMethod: SyncMethodSetting) {
  const settings = {
    syncMethod: initialMethod,
    setupComplete: false,
    syncFolder: 'reMarkable/Sync',
    syncthingApiKey: 'api-key',
    syncthingUrl: 'http://127.0.0.1:8384',
    syncthingFolderId: 'remarkable-xochitl',
  };
  const persist = jest.fn(async () => undefined);
  return { settings, persist, controller: new SetupFlowController(settings, persist) };
}

describe('setup connection routing', () => {
  it('reuses the selected verified WiFi endpoint', () => {
    expect(resolveWizardConnectionTarget('wifi', '192.168.1.44', '')).toEqual({
      method: 'wifi',
      host: '192.168.1.44',
      requiresWifiSelection: false,
    });
  });

  it('keeps USB as the default', () => {
    expect(resolveWizardConnectionTarget('usb', '10.11.99.1', '')).toEqual({
      method: 'usb',
      host: '10.11.99.1',
      requiresWifiSelection: false,
    });
  });

  it('routes an explicit manual IPv4 fallback through verification', () => {
    expect(resolveWizardConnectionTarget('usb', '10.11.99.1', ' 192.168.1.55 ')).toEqual({
      method: 'wifi',
      host: '192.168.1.55',
      requiresWifiSelection: true,
    });
    expect(() => resolveWizardConnectionTarget('usb', '10.11.99.1', 'tablet.local'))
      .toThrow('not a usable WiFi IPv4 address');
  });
});

describe('SetupFlowController device route integration', () => {
  it.each<[DeviceModel, DeviceArchitecture, boolean]>([
    ['reMarkable1', 'armv7', true],
    ['reMarkable2', 'armv7', true],
    ['paperPro', 'aarch64', false],
    ['paperProMove', 'aarch64', false],
    ['paperPure', 'aarch64', false],
    ['unknown', 'unknown', false],
    ['unknown', 'aarch64', false],
    ['unknown', 'armv7', false],
  ])('%s/%s installer support is %s', (model, architecture, expected) => {
    expect(supportsAutomaticSyncthingInstall(device(model, architecture))).toBe(expected);
  });

  it('lets a fresh ARMv7 setup explicitly select Syncthing and expands the route', async () => {
    const { controller, settings, persist } = flow('sftp');
    await controller.recordConnection(connection(device('reMarkable2', 'armv7')));

    expect(controller.activeSteps).toEqual([1, 2, 5]);
    await controller.selectSyncMethod('syncthing');

    expect(settings.syncMethod).toBe('syncthing');
    expect(controller.activeSteps).toEqual([1, 2, 3, 4, 5]);
    expect(controller.nextStep).toBe(2);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it.each<[DeviceModel, DeviceArchitecture]>([
    ['paperPro', 'aarch64'],
    ['paperProMove', 'aarch64'],
    ['paperPure', 'aarch64'],
    ['unknown', 'unknown'],
  ])('resets stale Syncthing for %s/%s and persists SFTP', async (model, architecture) => {
    const { controller, settings, persist } = flow('syncthing');
    const routing = await controller.recordConnection(connection(device(model, architecture)));

    expect(routing.changed).toBe(true);
    expect(settings.syncMethod).toBe('sftp');
    expect(controller.activeSteps).toEqual([1, 2, 5]);
    expect(persist).toHaveBeenCalledTimes(1);
    await expect(controller.selectSyncMethod('syncthing')).rejects.toThrow('Use SFTP');
  });

  it('accepts SSH detection on step 1 but blocks step 2 on required preflight failures', async () => {
    const { controller } = flow('sftp');
    await controller.recordConnection(connection(device('paperPro', 'aarch64'), false));

    expect(controller.stepStates.get(1)?.verified).toBe(true);
    expect(controller.stepStates.get(2)?.verified).toBe(false);
    expect(controller.stepStates.get(2)?.message).toContain('required pre-flight checks failed');
  });

  it('completes low-resource rM2 detection for the SFTP route', async () => {
    const { controller } = flow('sftp');
    await controller.recordConnection(connection(device('reMarkable2', 'armv7'), true, false));

    expect(controller.stepStates.get(1)?.verified).toBe(true);
    expect(controller.stepStates.get(2)).toMatchObject({
      verified: true,
      message: 'Device detected and all required pre-flight checks passed.',
    });
  });

  it('fails low-resource Syncthing readiness before invoking the installer', async () => {
    const { controller } = flow('syncthing');
    await controller.recordConnection(connection(device('reMarkable2', 'armv7'), true, false));
    const install = jest.fn(async () => undefined);

    expect(controller.stepStates.get(2)).toMatchObject({
      verified: false,
      message: expect.stringContaining('resource checks'),
    });
    await expect(controller.installLegacySyncStack(install)).rejects.toThrow(
      'pre-flight resource checks',
    );
    expect(install).not.toHaveBeenCalled();
  });

  it('blocks switching a low-resource SFTP detection to Syncthing', async () => {
    const { controller, settings, persist } = flow('sftp');
    await controller.recordConnection(connection(device('reMarkable2', 'armv7'), true, false));

    await expect(controller.selectSyncMethod('syncthing')).rejects.toThrow(
      'pre-flight resource checks',
    );

    expect(settings.syncMethod).toBe('sftp');
    expect(controller.stepStates.get(2)?.verified).toBe(true);
    expect(controller.activeSteps).toEqual([1, 2, 5]);
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps a transport/detection failure on the connection step', async () => {
    const { controller } = flow('sftp');
    await controller.recordConnection(connection(null));

    expect(controller.stepStates.get(1)).toMatchObject({
      verified: false,
      message: 'SSH failed',
    });
    expect(controller.deviceInfo).toBeNull();
  });

  it('runs the legacy installer only for an ARMv7 Syncthing route', async () => {
    const legacy = flow('syncthing').controller;
    await legacy.recordConnection(connection(device('reMarkable1', 'armv7')));
    const install = jest.fn(async () => undefined);
    await legacy.installLegacySyncStack(install);
    expect(install).toHaveBeenCalledTimes(1);
    expect(legacy.stepStates.get(3)?.verified).toBe(true);

    const current = flow('sftp').controller;
    await current.recordConnection(connection(device('paperProMove', 'aarch64')));
    await expect(current.installLegacySyncStack(install)).rejects.toThrow('unsupported tablet');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('recomputes navigation when ARMv7 switches back to SFTP', async () => {
    const { controller } = flow('syncthing');
    await controller.recordConnection(connection(device('reMarkable2', 'armv7')));
    controller.currentStep = 3;
    expect(controller.previousStep).toBe(2);

    await controller.selectSyncMethod('sftp');
    controller.currentStep = 2;
    expect(controller.nextStep).toBe(5);
    expect(controller.activeSteps).toEqual([1, 2, 5]);
  });

  it('rolls a method change back when settings cannot be persisted', async () => {
    const settings = {
      syncMethod: 'sftp' as SyncMethodSetting,
      setupComplete: false,
      syncFolder: 'reMarkable/Sync',
      syncthingApiKey: 'api-key',
      syncthingUrl: 'http://127.0.0.1:8384',
      syncthingFolderId: 'remarkable-xochitl',
    };
    const controller = new SetupFlowController(
      settings,
      async () => { throw new Error('disk full'); },
    );
    await controller.recordConnection(connection(device('reMarkable2', 'armv7')));

    await expect(controller.selectSyncMethod('syncthing')).rejects.toThrow('disk full');
    expect(settings.syncMethod).toBe('sftp');
    expect(controller.activeSteps).toEqual([1, 2, 5]);
  });

  it('invalidates an existing completed setup when its transport changes', async () => {
    const settings = {
      syncMethod: 'sftp' as SyncMethodSetting,
      setupComplete: true,
      syncFolder: 'reMarkable/Sync',
      syncthingApiKey: 'api-key',
      syncthingUrl: 'http://127.0.0.1:8384',
      syncthingFolderId: 'remarkable-xochitl',
    };
    const controller = new SetupFlowController(settings, async () => undefined);
    await controller.recordConnection(connection(device('reMarkable2', 'armv7')));

    await controller.selectSyncMethod('syncthing');

    expect(settings.syncMethod).toBe('syncthing');
    expect(settings.setupComplete).toBe(false);
  });

  it('preserves completed SFTP until Syncthing is explicitly selected in the wizard', async () => {
    const settings = {
      syncMethod: 'sftp' as SyncMethodSetting,
      setupComplete: true,
      syncFolder: 'reMarkable/Sync',
      syncthingApiKey: 'api-key',
      syncthingUrl: 'http://127.0.0.1:8384',
      syncthingFolderId: 'remarkable-xochitl',
    };
    const persist = jest.fn(async () => undefined);
    const controller = new SetupFlowController(settings, persist);

    await controller.recordConnection(connection(device('reMarkable2', 'armv7')));
    expect(settings).toMatchObject({ syncMethod: 'sftp', setupComplete: true });
    expect(persist).not.toHaveBeenCalled();

    await controller.selectSyncMethod('syncthing');
    expect(settings).toMatchObject({ syncMethod: 'syncthing', setupComplete: false });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('verifies Syncthing pairing through its API even when the library is empty', async () => {
    const { controller } = flow('syncthing');
    await controller.recordConnection(connection(device('reMarkable2', 'armv7')));
    const persistProviderConfiguration = jest.fn(async () => undefined);
    const isSyncProviderAvailable = jest.fn(async () => true);

    await controller.verifySyncthingPairing({
      syncFolderIsDirectory: () => true,
      persistProviderConfiguration,
      isSyncProviderAvailable,
    });

    expect(persistProviderConfiguration).toHaveBeenCalledTimes(1);
    expect(isSyncProviderAvailable).toHaveBeenCalledTimes(1);
    expect(controller.stepStates.get(4)).toMatchObject({
      verified: true,
      message: 'Syncthing is ready for "reMarkable/Sync".',
    });
  });

  it('blocks pairing before provider access when the API key is missing', async () => {
    const { controller, settings } = flow('syncthing');
    settings.syncthingApiKey = '';
    await controller.recordConnection(connection(device('reMarkable1', 'armv7')));
    const isSyncProviderAvailable = jest.fn(async () => true);

    await expect(controller.verifySyncthingPairing({
      syncFolderIsDirectory: () => true,
      persistProviderConfiguration: async () => undefined,
      isSyncProviderAvailable,
    })).rejects.toThrow('Enter the Syncthing API key');
    expect(isSyncProviderAvailable).not.toHaveBeenCalled();
  });

  it.each<SyncMethodSetting>(['sftp', 'syncthing'])(
    'completes a verified %s setup through the selected provider',
    async (method) => {
      const { controller, settings, persist } = flow(method);
      await controller.recordConnection(connection(device('reMarkable2', 'armv7')));
      if (method === 'syncthing') {
        await controller.installLegacySyncStack(async () => undefined);
        await controller.verifySyncthingPairing({
          syncFolderIsDirectory: () => true,
          persistProviderConfiguration: async () => undefined,
          isSyncProviderAvailable: async () => true,
        });
      }
      const events: string[] = [];
      const operations = {
        testConnectionDetailed: jest.fn(async () => {
          events.push('ssh');
          return { ok: true, error: null };
        }),
        ensureDefaultSyncSource: jest.fn(async () => { events.push('source'); }),
        isSyncProviderAvailable: jest.fn(async () => { events.push('provider'); return true; }),
        preparePythonEnvironment: jest.fn(async () => {
          events.push('python');
          return { created: false };
        }),
        toggleAutoSyncTimer: jest.fn(() => { events.push('timer'); }),
      };

      await controller.completeSetup(operations);

      expect(events).toEqual(['ssh', 'source', 'provider', 'python', 'timer']);
      expect(settings.setupComplete).toBe(true);
      expect(controller.stepStates.get(5)).toMatchObject({
        verified: true,
        message: 'Setup complete. E-Ink Sync is ready.',
      });
      // One initial save plus the final setupComplete commit. ARMv7 did not
      // need a route migration save.
      expect(persist).toHaveBeenCalledTimes(2);
    },
  );

  it('does not complete when SSH works but the SFTP subsystem is unavailable', async () => {
    const { controller, settings } = flow('sftp');
    await controller.recordConnection(connection(device('paperPro', 'aarch64')));
    const preparePythonEnvironment = jest.fn(async () => ({ created: false }));

    await expect(controller.completeSetup({
      testConnectionDetailed: async () => ({ ok: true, error: null }),
      ensureDefaultSyncSource: async () => undefined,
      isSyncProviderAvailable: async () => false,
      preparePythonEnvironment,
      toggleAutoSyncTimer: () => {},
    })).rejects.toThrow('SFTP subsystem is unavailable');

    expect(settings.setupComplete).toBe(false);
    expect(preparePythonEnvironment).not.toHaveBeenCalled();
  });

  it('does not complete when extraction preparation fails', async () => {
    const { controller, settings } = flow('sftp');
    await controller.recordConnection(connection(device('paperPure', 'aarch64')));

    await expect(controller.completeSetup({
      testConnectionDetailed: async () => ({ ok: true, error: null }),
      ensureDefaultSyncSource: async () => undefined,
      isSyncProviderAvailable: async () => true,
      preparePythonEnvironment: async () => { throw new Error('Python unavailable'); },
      toggleAutoSyncTimer: () => {},
    })).rejects.toThrow('Python unavailable');

    expect(settings.setupComplete).toBe(false);
  });

  it('preserves the detailed SSH failure for the wizard to display', async () => {
    const { controller } = flow('sftp');
    await controller.recordConnection(connection(device('paperPro', 'aarch64')));
    const denied = new BridgeError(
      ErrorCode.SSH_SOCKET_ACCESS_DENIED,
      'Obsidian cannot open the SSH socket.',
      'Allow Obsidian through the firewall.',
    );

    const completion = controller.completeSetup({
      testConnectionDetailed: async () => ({ ok: false, error: denied }),
      ensureDefaultSyncSource: async () => undefined,
      isSyncProviderAvailable: async () => true,
      preparePythonEnvironment: async () => ({ created: false }),
      toggleAutoSyncTimer: () => {},
    });

    await expect(completion).rejects.toBe(denied);
  });
});
