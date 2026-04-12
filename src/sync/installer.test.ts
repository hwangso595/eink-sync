import {
  isEntwareInstalled,
  isSyncthingInstalled,
  getSyncthingVersion,
  installEntware,
  installSyncthing,
  installSyncStack,
} from './installer';
import { ENTWARE_PATH, SYNCTHING_BIN_PATH } from './types';
import type { SSHExecutor, CommandResult } from '../ssh/ssh-client';
import { BridgeError, ErrorCode } from '../types/errors';

/** Create a mock SSHExecutor with command-based routing. */
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

describe('isEntwareInstalled', () => {
  it('returns true when opkg binary exists', async () => {
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'yes', exitCode: 0 },
    });
    expect(await isEntwareInstalled(ssh)).toBe(true);
  });

  it('returns false when opkg binary is missing', async () => {
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'no', exitCode: 0 },
    });
    expect(await isEntwareInstalled(ssh)).toBe(false);
  });

  it('returns false on command failure', async () => {
    const ssh = createMockSSH({});
    expect(await isEntwareInstalled(ssh)).toBe(false);
  });
});

describe('isSyncthingInstalled', () => {
  it('returns true when syncthing binary exists', async () => {
    const ssh = createMockSSH({
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'yes', exitCode: 0 },
    });
    expect(await isSyncthingInstalled(ssh)).toBe(true);
  });

  it('returns false when syncthing binary is missing', async () => {
    const ssh = createMockSSH({
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'no', exitCode: 0 },
    });
    expect(await isSyncthingInstalled(ssh)).toBe(false);
  });
});

describe('getSyncthingVersion', () => {
  it('returns version string when syncthing is installed', async () => {
    const ssh = createMockSSH({
      '--version': { stdout: 'syncthing v1.27.0 "Tungsten Turtle"\n', exitCode: 0 },
    });
    const version = await getSyncthingVersion(ssh);
    expect(version).toBe('syncthing v1.27.0 "Tungsten Turtle"');
  });

  it('returns null when syncthing is not installed', async () => {
    const ssh = createMockSSH({});
    const version = await getSyncthingVersion(ssh);
    expect(version).toBeNull();
  });

  it('returns null when version output is empty', async () => {
    const ssh = createMockSSH({
      '--version': { stdout: '', exitCode: 0 },
    });
    const version = await getSyncthingVersion(ssh);
    expect(version).toBeNull();
  });
});

describe('installEntware', () => {
  it('skips installation if already installed', async () => {
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'yes', exitCode: 0 },
    });

    const result = await installEntware(ssh);

    expect(result.success).toBe(true);
    expect(result.alreadyInstalled).toBe(true);
  });

  it('throws when tablet has no internet', async () => {
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'no', exitCode: 0 },
      'wget -q --spider': { stdout: 'fail', exitCode: 1 },
    });

    await expect(installEntware(ssh)).rejects.toThrow(BridgeError);
    await expect(installEntware(ssh)).rejects.toThrow(/cannot reach/i);
  });

  it('throws when installation script fails', async () => {
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'no', exitCode: 0 },
      'wget -q --spider': { stdout: 'ok', exitCode: 0 },
      'entware_install.sh': { stdout: 'error', exitCode: 1 },
    });

    await expect(installEntware(ssh)).rejects.toThrow(BridgeError);
  });

  it('calls progress callback during installation', async () => {
    const progress = jest.fn();
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'yes', exitCode: 0 },
    });

    await installEntware(ssh, progress);

    expect(progress).toHaveBeenCalledWith('Checking', expect.any(String));
  });

  it('verifies installation after script completes', async () => {
    // Setup: first check says not installed, internet check passes,
    // install succeeds, but verification fails (opkg still not found)
    let opkgCallCount = 0;
    const ssh: SSHExecutor = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(true),
      isConnected: jest.fn().mockReturnValue(true),
      execute: jest.fn().mockImplementation((command: string) => {
        if (command.includes('test -x /home/root/.entware/bin/opkg')) {
          opkgCallCount++;
          // First call: not installed; second call: still not installed (verification fails)
          return Promise.resolve({
            stdout: opkgCallCount <= 1 ? 'no' : 'no',
            stderr: '',
            exitCode: 0,
          });
        }
        if (command.includes('wget -q --spider')) {
          return Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 });
        }
        if (command.includes('entware_install.sh')) {
          return Promise.resolve({ stdout: 'done', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
      }),
    };

    await expect(installEntware(ssh)).rejects.toThrow(/opkg binary not found/);
  });
});

describe('installSyncthing', () => {
  it('throws when Entware is not installed', async () => {
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'no', exitCode: 0 },
    });

    await expect(installSyncthing(ssh)).rejects.toThrow(BridgeError);
    await expect(installSyncthing(ssh)).rejects.toThrow(/Entware is not installed/);
  });

  it('skips if Syncthing is already installed', async () => {
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'yes', exitCode: 0 },
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'yes', exitCode: 0 },
      '--version': { stdout: 'syncthing v1.27.0', exitCode: 0 },
    });

    const result = await installSyncthing(ssh);

    expect(result.success).toBe(true);
    expect(result.alreadyInstalled).toBe(true);
    expect(result.syncthingVersion).toBe('syncthing v1.27.0');
  });

  it('throws when opkg update fails', async () => {
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'yes', exitCode: 0 },
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'no', exitCode: 0 },
      'opkg update': { stdout: '', exitCode: 1, stderr: 'network error' },
    });

    await expect(installSyncthing(ssh)).rejects.toThrow(/package lists/);
  });

  it('throws when opkg install fails', async () => {
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'yes', exitCode: 0 },
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'no', exitCode: 0 },
      'opkg update': { stdout: 'ok', exitCode: 0 },
      'opkg install syncthing': { stdout: '', exitCode: 1, stderr: 'not found' },
    });

    await expect(installSyncthing(ssh)).rejects.toThrow(/installation failed/i);
  });

  it('verifies binary after installation', async () => {
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'yes', exitCode: 0 },
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'no', exitCode: 0 },
      'opkg update': { stdout: 'ok', exitCode: 0 },
      'opkg install syncthing': { stdout: 'ok', exitCode: 0 },
      // version check fails -- binary installed but broken
      '--version': { stdout: '', exitCode: 1 },
    });

    await expect(installSyncthing(ssh)).rejects.toThrow(/does not execute correctly/);
  });
});

describe('installSyncStack', () => {
  it('installs both Entware and Syncthing', async () => {
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'yes', exitCode: 0 },
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'yes', exitCode: 0 },
      '--version': { stdout: 'syncthing v1.27.0', exitCode: 0 },
    });

    const result = await installSyncStack(ssh);

    expect(result.success).toBe(true);
    expect(result.syncthingVersion).toBe('syncthing v1.27.0');
  });

  it('reports progress for both installation phases', async () => {
    const progress = jest.fn();
    const ssh = createMockSSH({
      'test -x /home/root/.entware/bin/opkg': { stdout: 'yes', exitCode: 0 },
      [`test -x ${SYNCTHING_BIN_PATH}`]: { stdout: 'yes', exitCode: 0 },
      '--version': { stdout: 'syncthing v1.27.0', exitCode: 0 },
    });

    await installSyncStack(ssh, progress);

    expect(progress).toHaveBeenCalledWith('Entware', expect.any(String));
    expect(progress).toHaveBeenCalledWith('Syncthing', expect.any(String));
  });
});
