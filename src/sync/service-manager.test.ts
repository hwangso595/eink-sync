import {
  generateSyncthingServiceUnit,
  generateWatchdogScript,
  generateWatchdogServiceUnit,
  deployServices,
  startServices,
  stopServices,
  isServiceRunning,
  getSyncthingMemoryUsage,
  removeServices,
} from './service-manager';
import {
  SYNCTHING_BIN_PATH,
  SYNCTHING_CONFIG_DIR,
  SYNCTHING_SERVICE_NAME,
  SYNCTHING_SERVICE_PATH,
  WATCHDOG_SERVICE_NAME,
  WATCHDOG_SERVICE_PATH,
  WATCHDOG_SCRIPT_PATH,
} from './types';
import type { SyncConfig } from './types';
import { DEFAULT_RESOURCE_BUDGETS } from '../types/device';
import type { SSHExecutor, CommandResult } from '../ssh/ssh-client';

function createTestSyncConfig(overrides?: Partial<SyncConfig>): SyncConfig {
  return {
    method: 'syncthing',
    tabletSyncPath: '/home/root/.local/share/remarkable/xochitl',
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
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    }),
  };
}

describe('generateSyncthingServiceUnit', () => {
  it('includes the correct ExecStart command', () => {
    const config = createTestSyncConfig();
    const unit = generateSyncthingServiceUnit(config);

    expect(unit).toContain(`ExecStart=${SYNCTHING_BIN_PATH} serve --no-browser --no-restart --home=${SYNCTHING_CONFIG_DIR}`);
  });

  it('sets memory limits based on resource budget', () => {
    const config = createTestSyncConfig();
    const unit = generateSyncthingServiceUnit(config);

    // rM1 budget: 64MB max
    expect(unit).toContain('MemoryMax=64M');
    // Soft limit at 80%: floor(64 * 0.8) = 51
    expect(unit).toContain('MemoryHigh=51M');
  });

  it('sets higher memory limits for rM2', () => {
    const config = createTestSyncConfig({
      deviceModel: 'reMarkable2',
      resourceBudget: DEFAULT_RESOURCE_BUDGETS.reMarkable2,
    });
    const unit = generateSyncthingServiceUnit(config);

    expect(unit).toContain('MemoryMax=128M');
    expect(unit).toContain('MemoryHigh=102M'); // floor(128 * 0.8) = 102
  });

  it('sets OOMScoreAdjust to sacrifice sync before xochitl', () => {
    const config = createTestSyncConfig();
    const unit = generateSyncthingServiceUnit(config);

    expect(unit).toContain('OOMScoreAdjust=500');
  });

  it('sets Nice=19 for lowest CPU priority', () => {
    const config = createTestSyncConfig();
    const unit = generateSyncthingServiceUnit(config);

    expect(unit).toContain('Nice=19');
  });

  it('sets GOMAXPROCS=1 for single-core ARM', () => {
    const config = createTestSyncConfig();
    const unit = generateSyncthingServiceUnit(config);

    expect(unit).toContain('Environment=GOMAXPROCS=1');
  });

  it('disables Syncthing auto-upgrade via environment', () => {
    const config = createTestSyncConfig();
    const unit = generateSyncthingServiceUnit(config);

    expect(unit).toContain('Environment=STNOUPGRADE=1');
  });

  it('configures restart on failure with sane limits', () => {
    const config = createTestSyncConfig();
    const unit = generateSyncthingServiceUnit(config);

    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=30');
    expect(unit).toContain('StartLimitBurst=5');
  });

  it('waits for network to be online', () => {
    const config = createTestSyncConfig();
    const unit = generateSyncthingServiceUnit(config);

    expect(unit).toContain('After=network-online.target');
  });

  it('includes install section for systemd enable', () => {
    const config = createTestSyncConfig();
    const unit = generateSyncthingServiceUnit(config);

    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=multi-user.target');
  });
});

describe('generateWatchdogScript', () => {
  it('uses MemAvailable from /proc/meminfo', () => {
    const config = createTestSyncConfig();
    const script = generateWatchdogScript(config);

    expect(script).toContain('MemAvailable');
    expect(script).toContain('/proc/meminfo');
  });

  it('sets minimum free RAM threshold from resource budget', () => {
    const config = createTestSyncConfig();
    const script = generateWatchdogScript(config);

    // rM1 minFreeMemoryMB = 100
    expect(script).toContain('MIN_FREE_MB=100');
  });

  it('sets recovery threshold 20% above minimum', () => {
    const config = createTestSyncConfig();
    const script = generateWatchdogScript(config);

    // Recovery: floor(100 * 1.2) = 120
    expect(script).toContain('RECOVERY_MB=120');
  });

  it('uses correct service name for stop/start', () => {
    const config = createTestSyncConfig();
    const script = generateWatchdogScript(config);

    expect(script).toContain(`SERVICE="${SYNCTHING_SERVICE_NAME}"`);
    expect(script).toContain('systemctl stop');
    expect(script).toContain('systemctl start');
  });

  it('uses sh shebang (not bash) for busybox compatibility', () => {
    const config = createTestSyncConfig();
    const script = generateWatchdogScript(config);

    expect(script).toMatch(/^#!\/bin\/sh/);
  });

  it('includes sleep interval for resource efficiency', () => {
    const config = createTestSyncConfig();
    const script = generateWatchdogScript(config);

    expect(script).toContain('sleep');
  });
});

describe('generateWatchdogServiceUnit', () => {
  it('binds to the Syncthing service', () => {
    const unit = generateWatchdogServiceUnit();

    expect(unit).toContain(`BindsTo=${SYNCTHING_SERVICE_NAME}.service`);
  });

  it('starts after the Syncthing service', () => {
    const unit = generateWatchdogServiceUnit();

    expect(unit).toContain(`After=${SYNCTHING_SERVICE_NAME}.service`);
  });

  it('executes the watchdog script', () => {
    const unit = generateWatchdogServiceUnit();

    expect(unit).toContain(`ExecStart=/bin/sh ${WATCHDOG_SCRIPT_PATH}`);
  });

  it('has very high OOM score (kill watchdog before xochitl)', () => {
    const unit = generateWatchdogServiceUnit();

    expect(unit).toContain('OOMScoreAdjust=900');
  });
});

describe('deployServices', () => {
  it('creates config directory before writing files', async () => {
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

    await deployServices(ssh, createTestSyncConfig());

    // First command should create the config directory
    expect(executeCalls[0]).toContain(`mkdir -p ${SYNCTHING_CONFIG_DIR}`);
  });

  it('writes all three files and reloads systemd', async () => {
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

    await deployServices(ssh, createTestSyncConfig());

    // Should write: service unit, watchdog script, watchdog unit, then reload
    const allCommands = executeCalls.join(' ');
    expect(allCommands).toContain(SYNCTHING_SERVICE_PATH);
    expect(allCommands).toContain(WATCHDOG_SCRIPT_PATH);
    expect(allCommands).toContain(WATCHDOG_SERVICE_PATH);
    expect(allCommands).toContain('daemon-reload');
  });

  it('throws BridgeError when service file write fails', async () => {
    const ssh = createMockSSH({
      'mkdir -p': { exitCode: 0 },
      [SYNCTHING_SERVICE_PATH]: { exitCode: 1, stderr: 'permission denied' },
    });

    await expect(deployServices(ssh, createTestSyncConfig())).rejects.toThrow(/Failed to write/);
  });
});

describe('startServices', () => {
  it('enables and starts the Syncthing service', async () => {
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

    await startServices(ssh);

    const allCommands = executeCalls.join(' ');
    expect(allCommands).toContain(`systemctl enable ${SYNCTHING_SERVICE_NAME}`);
    expect(allCommands).toContain(`systemctl start ${SYNCTHING_SERVICE_NAME}`);
    expect(allCommands).toContain(`systemctl enable ${WATCHDOG_SERVICE_NAME}`);
    expect(allCommands).toContain(`systemctl start ${WATCHDOG_SERVICE_NAME}`);
  });
});

describe('stopServices', () => {
  it('stops and disables both services', async () => {
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

    await stopServices(ssh);

    const allCommands = executeCalls.join(' ');
    expect(allCommands).toContain(`systemctl stop ${WATCHDOG_SERVICE_NAME}`);
    expect(allCommands).toContain(`systemctl stop ${SYNCTHING_SERVICE_NAME}`);
    expect(allCommands).toContain(`systemctl disable ${WATCHDOG_SERVICE_NAME}`);
    expect(allCommands).toContain(`systemctl disable ${SYNCTHING_SERVICE_NAME}`);
  });
});

describe('isServiceRunning', () => {
  it('returns true when service is active', async () => {
    const ssh = createMockSSH({
      'systemctl is-active': { stdout: 'active', exitCode: 0 },
    });
    expect(await isServiceRunning(ssh)).toBe(true);
  });

  it('returns false when service is inactive', async () => {
    const ssh = createMockSSH({
      'systemctl is-active': { stdout: 'inactive', exitCode: 3 },
    });
    expect(await isServiceRunning(ssh)).toBe(false);
  });

  it('returns false when service is failed', async () => {
    const ssh = createMockSSH({
      'systemctl is-active': { stdout: 'failed', exitCode: 3 },
    });
    expect(await isServiceRunning(ssh)).toBe(false);
  });
});

describe('getSyncthingMemoryUsage', () => {
  it('returns RSS in MB when syncthing is running', async () => {
    const ssh = createMockSSH({
      'ps -o rss=': { stdout: '52', exitCode: 0 },
    });
    const rss = await getSyncthingMemoryUsage(ssh);
    expect(rss).toBe(52);
  });

  it('returns null when syncthing is not running', async () => {
    const ssh = createMockSSH({
      'ps -o rss=': { stdout: 'none', exitCode: 0 },
    });
    const rss = await getSyncthingMemoryUsage(ssh);
    expect(rss).toBeNull();
  });

  it('returns null on command failure', async () => {
    const ssh = createMockSSH({
      'ps -o rss=': { stdout: '', exitCode: 1 },
    });
    const rss = await getSyncthingMemoryUsage(ssh);
    expect(rss).toBeNull();
  });

  it('returns null for non-numeric output', async () => {
    const ssh = createMockSSH({
      'ps -o rss=': { stdout: 'NaN', exitCode: 0 },
    });
    const rss = await getSyncthingMemoryUsage(ssh);
    expect(rss).toBeNull();
  });
});

describe('removeServices', () => {
  it('stops services then removes files and reloads systemd', async () => {
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

    await removeServices(ssh);

    const allCommands = executeCalls.join(' ');
    // Should stop first, then remove files
    expect(allCommands).toContain('systemctl stop');
    expect(allCommands).toContain(`rm -f ${SYNCTHING_SERVICE_PATH}`);
    expect(allCommands).toContain(`rm -f`);
    expect(allCommands).toContain('daemon-reload');
  });
});
