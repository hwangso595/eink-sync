import {
  detectFirmwareVersion,
  detectDeviceModel,
  detectMemoryInfo,
  detectStorageInfo,
} from './detector';
import { SSHExecutor, CommandResult } from '../ssh/ssh-client';
import { BridgeError, ErrorCode } from '../types/errors';

/** Create a mock SSHExecutor that returns preconfigured results per command. */
function createMockSSH(responses: Record<string, Partial<CommandResult>>): SSHExecutor {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue(true),
    isConnected: jest.fn().mockReturnValue(true),
    execute: jest.fn().mockImplementation((command: string) => {
      // Match on the beginning of the command to handle pipes and redirects
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

describe('detectFirmwareVersion', () => {
  it('parses a valid firmware version from /etc/version', async () => {
    const ssh = createMockSSH({
      'cat /etc/version': { stdout: '3.26.0.68\n', exitCode: 0 },
    });

    const fw = await detectFirmwareVersion(ssh);
    expect(fw.major).toBe(3);
    expect(fw.minor).toBe(26);
    expect(fw.patch).toBe(0);
    expect(fw.build).toBe(68);
    expect(fw.raw).toBe('3.26.0.68');
  });

  it('throws BridgeError when /etc/version is empty', async () => {
    const ssh = createMockSSH({
      'cat /etc/version': { stdout: '', exitCode: 0 },
    });

    await expect(detectFirmwareVersion(ssh)).rejects.toThrow(BridgeError);
  });

  it('throws BridgeError when command fails', async () => {
    const ssh = createMockSSH({
      'cat /etc/version': { stdout: '', exitCode: 1 },
    });

    await expect(detectFirmwareVersion(ssh)).rejects.toThrow(BridgeError);
  });
});

describe('detectDeviceModel', () => {
  it('detects reMarkable 1 from machine file', async () => {
    const ssh = createMockSSH({
      ['/sys/devices/soc0/machine']: { stdout: 'reMarkable 1.0', exitCode: 0 },
    });

    const model = await detectDeviceModel(ssh);
    expect(model).toBe('reMarkable1');
  });

  it('detects reMarkable 2 from machine file', async () => {
    const ssh = createMockSSH({
      ['/sys/devices/soc0/machine']: { stdout: 'reMarkable 2.0', exitCode: 0 },
    });

    const model = await detectDeviceModel(ssh);
    expect(model).toBe('reMarkable2');
  });

  it('falls back to device tree compatible string', async () => {
    const ssh = createMockSSH({
      ['/sys/devices/soc0/machine']: { stdout: '', exitCode: 1 },
      ['/proc/device-tree/compatible']: { stdout: 'remarkable2\0imx7d', exitCode: 0 },
    });

    const model = await detectDeviceModel(ssh);
    expect(model).toBe('reMarkable2');
  });

  it('falls back to RAM heuristic for rM1 (512MB)', async () => {
    const ssh = createMockSSH({
      ['/sys/devices/soc0/machine']: { stdout: '', exitCode: 1 },
      ['/proc/device-tree/compatible']: { stdout: '', exitCode: 1 },
      'cat /proc/meminfo': {
        stdout: 'MemTotal:      524288 kB\nMemAvailable:  300000 kB\n',
        exitCode: 0,
      },
    });

    const model = await detectDeviceModel(ssh);
    expect(model).toBe('reMarkable1');
  });

  it('falls back to RAM heuristic for rM2 (1GB)', async () => {
    const ssh = createMockSSH({
      ['/sys/devices/soc0/machine']: { stdout: '', exitCode: 1 },
      ['/proc/device-tree/compatible']: { stdout: '', exitCode: 1 },
      'cat /proc/meminfo': {
        stdout: 'MemTotal:     1048576 kB\nMemAvailable:  700000 kB\n',
        exitCode: 0,
      },
    });

    const model = await detectDeviceModel(ssh);
    expect(model).toBe('reMarkable2');
  });

  it('returns unknown for very high RAM values', async () => {
    const ssh = createMockSSH({
      ['/sys/devices/soc0/machine']: { stdout: '', exitCode: 1 },
      ['/proc/device-tree/compatible']: { stdout: '', exitCode: 1 },
      'cat /proc/meminfo': {
        stdout: 'MemTotal:     2097152 kB\nMemAvailable:  1500000 kB\n',
        exitCode: 0,
      },
    });

    const model = await detectDeviceModel(ssh);
    expect(model).toBe('unknown');
  });

  it('returns unknown for unrecognized machine string', async () => {
    const ssh = createMockSSH({
      ['/sys/devices/soc0/machine']: { stdout: 'Not a reMarkable', exitCode: 0 },
    });

    const model = await detectDeviceModel(ssh);
    expect(model).toBe('unknown');
  });
});

describe('detectMemoryInfo', () => {
  it('parses standard /proc/meminfo output', async () => {
    const ssh = createMockSSH({
      'cat /proc/meminfo': {
        stdout: [
          'MemTotal:      524288 kB',
          'MemFree:       100000 kB',
          'MemAvailable:  250000 kB',
          'Buffers:        50000 kB',
          'Cached:        100000 kB',
        ].join('\n'),
        exitCode: 0,
      },
    });

    const mem = await detectMemoryInfo(ssh);
    expect(mem.totalMB).toBe(512);
    expect(mem.availableMB).toBe(244); // 250000/1024 rounded
    expect(mem.usedMB).toBe(268); // (524288-250000)/1024 rounded
  });

  it('falls back to MemFree when MemAvailable is missing', async () => {
    const ssh = createMockSSH({
      'cat /proc/meminfo': {
        stdout: 'MemTotal:      524288 kB\nMemFree:       200000 kB\n',
        exitCode: 0,
      },
    });

    const mem = await detectMemoryInfo(ssh);
    expect(mem.totalMB).toBe(512);
    expect(mem.availableMB).toBe(195); // 200000/1024 rounded
  });

  it('throws BridgeError when command fails', async () => {
    const ssh = createMockSSH({
      'cat /proc/meminfo': { stdout: '', exitCode: 1 },
    });

    await expect(detectMemoryInfo(ssh)).rejects.toThrow(BridgeError);
  });

  it('returns zeros for unparseable meminfo', async () => {
    const ssh = createMockSSH({
      'cat /proc/meminfo': {
        stdout: 'garbage data here',
        exitCode: 0,
      },
    });

    const mem = await detectMemoryInfo(ssh);
    expect(mem.totalMB).toBe(0);
    expect(mem.availableMB).toBe(0);
  });
});

describe('detectStorageInfo', () => {
  it('parses standard df output', async () => {
    const ssh = createMockSSH({
      'df -m /home': {
        stdout: '/dev/mmcblk1p7   6400  2100  4300  33% /home',
        exitCode: 0,
      },
    });

    const storage = await detectStorageInfo(ssh, '/home');
    expect(storage.mountPoint).toBe('/home');
    expect(storage.totalMB).toBe(6400);
    expect(storage.usedMB).toBe(2100);
    expect(storage.availableMB).toBe(4300);
    expect(storage.usagePercent).toBe(33);
  });

  it('throws BridgeError on command failure', async () => {
    const ssh = createMockSSH({
      'df -m /nonexistent': { stdout: '', exitCode: 1 },
    });

    await expect(detectStorageInfo(ssh, '/nonexistent')).rejects.toThrow(BridgeError);
  });

  it('throws BridgeError on unexpected df format', async () => {
    const ssh = createMockSSH({
      'df -m /home': { stdout: 'short', exitCode: 0 },
    });

    await expect(detectStorageInfo(ssh, '/home')).rejects.toThrow(BridgeError);
  });

  it('handles NaN values gracefully', async () => {
    const ssh = createMockSSH({
      'df -m /home': {
        stdout: '/dev/mmcblk1p7   abc  def  ghi  jkl% /home',
        exitCode: 0,
      },
    });

    const storage = await detectStorageInfo(ssh, '/home');
    expect(storage.totalMB).toBe(0);
    expect(storage.usedMB).toBe(0);
    expect(storage.availableMB).toBe(0);
    expect(storage.usagePercent).toBe(0);
  });
});
