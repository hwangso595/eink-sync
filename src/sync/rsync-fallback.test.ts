import {
  isRsyncAvailable,
  buildRsyncArgs,
  buildRsyncCommand,
  getHostRsyncCommand,
  parseRsyncOutput,
  verifyRsyncCapability,
} from './rsync-fallback';
import { XOCHITL_SYNC_PATH } from './types';
import type { SyncConfig } from './types';
import { DEFAULT_RESOURCE_BUDGETS } from '../types/device';
import type { SSHExecutor, CommandResult } from '../ssh/ssh-client';

function createTestSyncConfig(overrides?: Partial<SyncConfig>): SyncConfig {
  return {
    method: 'rsync',
    tabletSyncPath: XOCHITL_SYNC_PATH,
    hostSyncPath: '/home/user/remarkable-sync',
    schedule: { enabled: true, intervalMinutes: 5, wifiOnly: false },
    syncthing: null,
    deviceModel: 'reMarkable1',
    resourceBudget: DEFAULT_RESOURCE_BUDGETS.reMarkable1,
    ...overrides,
  };
}

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

describe('isRsyncAvailable', () => {
  it('returns true when rsync exists on tablet', async () => {
    const ssh = createMockSSH({
      'command -v rsync': { stdout: 'yes', exitCode: 0 },
    });
    expect(await isRsyncAvailable(ssh)).toBe(true);
  });

  it('returns false when rsync is missing', async () => {
    const ssh = createMockSSH({
      'command -v rsync': { stdout: 'no', exitCode: 0 },
    });
    expect(await isRsyncAvailable(ssh)).toBe(false);
  });
});

describe('buildRsyncArgs', () => {
  it('uses archive mode and compression', () => {
    const config = createTestSyncConfig();
    const args = buildRsyncArgs(config, '10.11.99.1', 22);

    expect(args).toContain('-az');
  });

  it('includes --delete for mirroring', () => {
    const config = createTestSyncConfig();
    const args = buildRsyncArgs(config, '10.11.99.1', 22);

    expect(args).toContain('--delete');
  });

  it('includes --partial for resume support', () => {
    const config = createTestSyncConfig();
    const args = buildRsyncArgs(config, '10.11.99.1', 22);

    expect(args).toContain('--partial');
  });

  it('excludes thumbnails and temp files', () => {
    const config = createTestSyncConfig();
    const args = buildRsyncArgs(config, '10.11.99.1', 22);

    expect(args).toContain('--exclude=.thumbnails/');
    expect(args).toContain('--exclude=*.tmp');
    expect(args).toContain('--exclude=.stfolder');
  });

  it('uses correct SSH transport with port', () => {
    const config = createTestSyncConfig();
    const args = buildRsyncArgs(config, '10.11.99.1', 22);

    const sshArg = args.find(a => a.startsWith('ssh'));
    expect(sshArg).toContain('-p 22');
  });

  it('builds correct source path with trailing slash', () => {
    const config = createTestSyncConfig();
    const args = buildRsyncArgs(config, '10.11.99.1', 22);

    expect(args).toContain(`root@10.11.99.1:${XOCHITL_SYNC_PATH}/`);
  });

  it('includes host sync path as destination', () => {
    const config = createTestSyncConfig({ hostSyncPath: '/data/rm-sync' });
    const args = buildRsyncArgs(config, '10.11.99.1', 22);

    expect(args[args.length - 1]).toBe('/data/rm-sync');
  });

  it('uses custom SSH port', () => {
    const config = createTestSyncConfig();
    const args = buildRsyncArgs(config, '192.168.1.50', 2222);

    const sshArg = args.find(a => a.startsWith('ssh'));
    expect(sshArg).toContain('-p 2222');
  });
});

describe('buildRsyncCommand', () => {
  it('returns a single string command', () => {
    const config = createTestSyncConfig();
    const cmd = buildRsyncCommand(config, '10.11.99.1', 22);

    expect(typeof cmd).toBe('string');
    expect(cmd).toContain('rsync');
    expect(cmd).toContain('-az');
  });
});

describe('getHostRsyncCommand', () => {
  it('uses SSHPASS env var instead of embedding password in command', () => {
    const config = createTestSyncConfig();
    const result = getHostRsyncCommand(config, '10.11.99.1', 22, 'mypassword');

    expect(result.command).toContain('sshpass -e');
    expect(result.command).not.toContain('mypassword');
    expect(result.env.SSHPASS).toBe('mypassword');
  });

  it('includes --stats for transfer reporting', () => {
    const config = createTestSyncConfig();
    const result = getHostRsyncCommand(config, '10.11.99.1', 22, 'pass');

    expect(result.command).toContain('--stats');
  });

  it('handles passwords with special characters safely', () => {
    const config = createTestSyncConfig();
    const result = getHostRsyncCommand(config, '10.11.99.1', 22, "p@ss'w\"ord$!");

    // Password is in env, not in command string -- no shell injection risk
    expect(result.command).not.toContain("p@ss");
    expect(result.env.SSHPASS).toBe("p@ss'w\"ord$!");
  });
});

describe('parseRsyncOutput', () => {
  it('parses files transferred count', () => {
    const output = `
Number of files: 1,234
Number of regular files transferred: 42
Total file size: 5,678,901 bytes
Total transferred file size: 1,234,567 bytes
    `;

    const result = parseRsyncOutput(output);
    expect(result.filesTransferred).toBe(42);
    expect(result.bytesTransferred).toBe(1234567);
  });

  it('handles zero transfers', () => {
    const output = `
Number of files: 100
Number of regular files transferred: 0
Total transferred file size: 0 bytes
    `;

    const result = parseRsyncOutput(output);
    expect(result.filesTransferred).toBe(0);
    expect(result.bytesTransferred).toBe(0);
  });

  it('returns zeros for empty output', () => {
    const result = parseRsyncOutput('');
    expect(result.filesTransferred).toBe(0);
    expect(result.bytesTransferred).toBe(0);
  });

  it('returns zeros for non-matching output', () => {
    const result = parseRsyncOutput('some random error output');
    expect(result.filesTransferred).toBe(0);
    expect(result.bytesTransferred).toBe(0);
  });

  it('handles large numbers with commas', () => {
    const output = `
Number of regular files transferred: 1,234
Total transferred file size: 12,345,678,901 bytes
    `;

    const result = parseRsyncOutput(output);
    expect(result.filesTransferred).toBe(1234);
    expect(result.bytesTransferred).toBe(12345678901);
  });
});

describe('verifyRsyncCapability', () => {
  it('returns available when rsync exists and path is accessible', async () => {
    const ssh = createMockSSH({
      'command -v rsync': { stdout: 'yes', exitCode: 0 },
      'test -d': { stdout: 'ok', exitCode: 0 },
    });

    const result = await verifyRsyncCapability(ssh);
    expect(result.available).toBe(true);
  });

  it('returns unavailable when rsync is missing', async () => {
    const ssh = createMockSSH({
      'command -v rsync': { stdout: 'no', exitCode: 0 },
    });

    const result = await verifyRsyncCapability(ssh);
    expect(result.available).toBe(false);
    expect(result.message).toContain('not installed');
  });

  it('returns unavailable when sync path is missing', async () => {
    const ssh = createMockSSH({
      'command -v rsync': { stdout: 'yes', exitCode: 0 },
      'test -d': { stdout: 'missing', exitCode: 0 },
    });

    const result = await verifyRsyncCapability(ssh);
    expect(result.available).toBe(false);
    expect(result.message).toContain('does not exist');
  });

  it('checks custom sync path when provided', async () => {
    const executeCalls: string[] = [];
    const ssh: SSHExecutor = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue(true),
      isConnected: jest.fn().mockReturnValue(true),
      execute: jest.fn().mockImplementation((command: string) => {
        executeCalls.push(command);
        if (command.includes('command -v rsync')) {
          return Promise.resolve({ stdout: 'yes', stderr: '', exitCode: 0 });
        }
        if (command.includes('test -d')) {
          return Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
      }),
    };

    await verifyRsyncCapability(ssh, '/custom/path');
    expect(executeCalls.some(c => c.includes('/custom/path'))).toBe(true);
  });
});
