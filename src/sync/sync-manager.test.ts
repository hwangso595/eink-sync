import {
  recommendSyncMethod,
  getSyncStatus,
  stopSync,
  restartSync,
} from './sync-manager';
import type { SyncConfig } from './types';
import { XOCHITL_SYNC_PATH, SYNCTHING_BIN_PATH, SYNCTHING_SERVICE_NAME } from './types';
import { DEFAULT_RESOURCE_BUDGETS } from '../types/device';
import type { DeviceInfo, DeviceModel } from '../types/device';
import type { SSHExecutor, CommandResult } from '../ssh/ssh-client';

function createMockSSH(responses: Record<string, Partial<CommandResult>>): SSHExecutor {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue(true),
    isConnected: jest.fn().mockReturnValue(true),
    execute: jest.fn().mockImplementation((command: string) => {
      for (const [key, value] of Object.entries(responses)) {
        if (command.includes(key)) {
          return Promise.resolve({
            stdout: '',
            stderr: '',
            exitCode: 0,
            ...value,
          });
        }
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
    }),
  };
}

function createTestDeviceInfo(overrides?: Partial<DeviceInfo>): DeviceInfo {
  return {
    model: 'reMarkable1' as DeviceModel,
    firmware: { raw: '3.26.0.68', major: 3, minor: 26, patch: 0, build: 68 },
    memory: { totalMB: 512, availableMB: 300, usedMB: 212 },
    storage: [
      { mountPoint: '/', totalMB: 250, usedMB: 150, availableMB: 100, usagePercent: 60 },
      { mountPoint: '/home', totalMB: 6400, usedMB: 2100, availableMB: 4300, usagePercent: 33 },
    ],
    kernelVersion: '5.4.70',
    serialNumber: null,
    ...overrides,
  };
}

function createTestSyncConfig(overrides?: Partial<SyncConfig>): SyncConfig {
  return {
    method: 'syncthing',
    tabletSyncPath: XOCHITL_SYNC_PATH,
    hostSyncPath: '/home/user/remarkable-sync',
    schedule: { enabled: true, intervalMinutes: 5, wifiOnly: false },
    syncthing: null,
    deviceModel: 'reMarkable1',
    resourceBudget: DEFAULT_RESOURCE_BUDGETS.reMarkable1,
    ...overrides,
  };
}

describe('recommendSyncMethod', () => {
  it('recommends Syncthing when already installed', async () => {
    const ssh = createMockSSH({
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'yes', exitCode: 0 },
    });
    const deviceInfo = createTestDeviceInfo();

    const method = await recommendSyncMethod(ssh, deviceInfo);
    expect(method).toBe('syncthing');
  });

  it('recommends rsync for rM1 with low memory', async () => {
    const ssh = createMockSSH({
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'no', exitCode: 0 },
    });
    // rM1 needs minFreeMemoryMB (100) + syncthingMaxMemoryMB (64) = 164MB available
    const deviceInfo = createTestDeviceInfo({
      model: 'reMarkable1',
      memory: { totalMB: 512, availableMB: 150, usedMB: 362 },
    });

    const method = await recommendSyncMethod(ssh, deviceInfo);
    expect(method).toBe('rsync');
  });

  it('recommends Syncthing for rM1 with sufficient memory', async () => {
    const ssh = createMockSSH({
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'no', exitCode: 0 },
    });
    const deviceInfo = createTestDeviceInfo({
      model: 'reMarkable1',
      memory: { totalMB: 512, availableMB: 300, usedMB: 212 },
    });

    const method = await recommendSyncMethod(ssh, deviceInfo);
    expect(method).toBe('syncthing');
  });

  it('recommends Syncthing for rM2 regardless of memory', async () => {
    const ssh = createMockSSH({
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'no', exitCode: 0 },
    });
    const deviceInfo = createTestDeviceInfo({
      model: 'reMarkable2',
      memory: { totalMB: 1024, availableMB: 400, usedMB: 624 },
    });

    const method = await recommendSyncMethod(ssh, deviceInfo);
    expect(method).toBe('syncthing');
  });

  it('recommends Syncthing for unknown device with sufficient memory', async () => {
    const ssh = createMockSSH({
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'no', exitCode: 0 },
    });
    const deviceInfo = createTestDeviceInfo({
      model: 'unknown',
      memory: { totalMB: 512, availableMB: 300, usedMB: 212 },
    });

    const method = await recommendSyncMethod(ssh, deviceInfo);
    expect(method).toBe('syncthing');
  });
});

describe('getSyncStatus', () => {
  it('returns unreachable status when tablet is not reachable', async () => {
    const ssh: SSHExecutor = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockRejectedValue(new Error('timeout')),
      isConnected: jest.fn().mockReturnValue(true),
      execute: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 }),
    };

    const config = createTestSyncConfig();
    const status = await getSyncStatus(ssh, config);

    expect(status.tabletReachable).toBe(false);
    expect(status.message).toContain('not reachable');
  });

  it('returns Syncthing running status with memory usage', async () => {
    const ssh = createMockSSH({
      'systemctl is-active': { stdout: 'active', exitCode: 0 },
      'ps -o rss=': { stdout: '48', exitCode: 0 },
    });
    (ssh.ping as jest.Mock).mockResolvedValue(true);

    const config = createTestSyncConfig({ method: 'syncthing' });
    const status = await getSyncStatus(ssh, config);

    expect(status.tabletReachable).toBe(true);
    expect(status.running).toBe(true);
    expect(status.method).toBe('syncthing');
    expect(status.syncProcessMemoryMB).toBe(48);
    expect(status.message).toContain('running');
  });

  it('returns Syncthing stopped status', async () => {
    const ssh = createMockSSH({
      'systemctl is-active': { stdout: 'inactive', exitCode: 3 },
      'ps -o rss=': { stdout: 'none', exitCode: 0 },
    });
    (ssh.ping as jest.Mock).mockResolvedValue(true);

    const config = createTestSyncConfig({ method: 'syncthing' });
    const status = await getSyncStatus(ssh, config);

    expect(status.running).toBe(false);
    expect(status.message).toContain('not running');
  });

  it('returns rsync idle status', async () => {
    const ssh = createMockSSH({
      'pgrep rsync': { stdout: 'idle', exitCode: 0 },
    });
    (ssh.ping as jest.Mock).mockResolvedValue(true);

    const config = createTestSyncConfig({ method: 'rsync' });
    const status = await getSyncStatus(ssh, config);

    expect(status.method).toBe('rsync');
    expect(status.running).toBe(false);
    expect(status.message).toContain('idle');
  });

  it('returns rsync running status during active transfer', async () => {
    const ssh = createMockSSH({
      'pgrep rsync': { stdout: 'running', exitCode: 0 },
    });
    (ssh.ping as jest.Mock).mockResolvedValue(true);

    const config = createTestSyncConfig({ method: 'rsync' });
    const status = await getSyncStatus(ssh, config);

    expect(status.running).toBe(true);
    expect(status.message).toContain('in progress');
  });
});

describe('stopSync', () => {
  it('stops Syncthing services for syncthing method', async () => {
    const executeCalls: string[] = [];
    const ssh: SSHExecutor = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(true),
      isConnected: jest.fn().mockReturnValue(true),
      execute: jest.fn().mockImplementation((command: string) => {
        executeCalls.push(command);
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }),
    };

    const config = createTestSyncConfig({ method: 'syncthing' });
    await stopSync(ssh, config);

    const allCommands = executeCalls.join(' ');
    expect(allCommands).toContain('systemctl stop');
  });

  it('kills rsync process for rsync method', async () => {
    const executeCalls: string[] = [];
    const ssh: SSHExecutor = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(true),
      isConnected: jest.fn().mockReturnValue(true),
      execute: jest.fn().mockImplementation((command: string) => {
        executeCalls.push(command);
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }),
    };

    const config = createTestSyncConfig({ method: 'rsync' });
    await stopSync(ssh, config);

    expect(executeCalls.some(c => c.includes('pkill rsync'))).toBe(true);
  });
});

describe('restartSync', () => {
  it('restarts systemd service for syncthing method', async () => {
    const executeCalls: string[] = [];
    const ssh: SSHExecutor = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(true),
      isConnected: jest.fn().mockReturnValue(true),
      execute: jest.fn().mockImplementation((command: string) => {
        executeCalls.push(command);
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }),
    };

    const config = createTestSyncConfig({ method: 'syncthing' });
    await restartSync(ssh, config);

    expect(executeCalls.some(c => c.includes('systemctl restart'))).toBe(true);
  });

  it('does nothing for rsync method (no daemon)', async () => {
    const ssh: SSHExecutor = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(true),
      isConnected: jest.fn().mockReturnValue(true),
      execute: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const config = createTestSyncConfig({ method: 'rsync' });
    await restartSync(ssh, config);

    // execute should not be called for rsync restart
    expect(ssh.execute).not.toHaveBeenCalled();
  });
});
