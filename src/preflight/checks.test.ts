import { runPreflightChecks, formatPreflightReport } from './checks';
import { SSHExecutor, CommandResult } from '../ssh/ssh-client';
import { DeviceInfo, DeviceModel, DEFAULT_RESOURCE_BUDGETS } from '../types/device';
import { parseFirmwareVersion } from '../device/firmware';

/** Create a mock SSHExecutor with preconfigured responses. */
function createMockSSH(responses: Record<string, Partial<CommandResult>> = {}): SSHExecutor {
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

/** Build a DeviceInfo fixture with overrides. */
function makeDeviceInfo(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    model: 'reMarkable1' as DeviceModel,
    firmware: parseFirmwareVersion('3.26.0.68'),
    memory: { totalMB: 512, availableMB: 300, usedMB: 212 },
    storage: [
      { mountPoint: '/', totalMB: 256, usedMB: 180, availableMB: 76, usagePercent: 70 },
      { mountPoint: '/home', totalMB: 6400, usedMB: 2100, availableMB: 4300, usagePercent: 33 },
    ],
    kernelVersion: '5.4.70',
    serialNumber: null,
    ...overrides,
  };
}

describe('runPreflightChecks', () => {
  it('passes all checks for a healthy rM1', async () => {
    const ssh = createMockSSH({
      'test -d': { stdout: 'exists', exitCode: 0 },
    });

    const report = await runPreflightChecks(makeDeviceInfo(), ssh);

    expect(report.passed).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(6);
    expect(report.checks.every(c => c.passed)).toBe(true);
  });

  it('fails when firmware is too old', async () => {
    const ssh = createMockSSH({
      'test -d': { stdout: 'exists', exitCode: 0 },
    });

    const info = makeDeviceInfo({
      firmware: parseFirmwareVersion('2.5.0.0'),
    });

    const report = await runPreflightChecks(info, ssh);

    const fwCheck = report.checks.find(c => c.name === 'Firmware Version');
    expect(fwCheck).toBeDefined();
    expect(fwCheck!.passed).toBe(false);
    expect(fwCheck!.severity).toBe('error');
    expect(report.passed).toBe(false);
  });

  it('fails when available memory is below minimum', async () => {
    const ssh = createMockSSH({
      'test -d': { stdout: 'exists', exitCode: 0 },
    });

    const budget = DEFAULT_RESOURCE_BUDGETS['reMarkable1'];
    const info = makeDeviceInfo({
      memory: { totalMB: 512, availableMB: budget.minFreeMemoryMB - 1, usedMB: 412 },
    });

    const report = await runPreflightChecks(info, ssh);

    const memCheck = report.checks.find(c => c.name === 'Available Memory');
    expect(memCheck).toBeDefined();
    expect(memCheck!.passed).toBe(false);
    expect(memCheck!.severity).toBe('error');
    expect(report.passed).toBe(false);
  });

  it('warns when memory is tight but above minimum', async () => {
    const ssh = createMockSSH({
      'test -d': { stdout: 'exists', exitCode: 0 },
    });

    const budget = DEFAULT_RESOURCE_BUDGETS['reMarkable1'];
    // Above minFreeMemoryMB but below minFreeMemoryMB + syncthingMaxMemoryMB
    const info = makeDeviceInfo({
      memory: {
        totalMB: 512,
        availableMB: budget.minFreeMemoryMB + 10,
        usedMB: 402,
      },
    });

    const report = await runPreflightChecks(info, ssh);

    const memCheck = report.checks.find(c => c.name === 'Available Memory');
    expect(memCheck).toBeDefined();
    expect(memCheck!.passed).toBe(true);
    expect(memCheck!.severity).toBe('warning');
  });

  it('fails when /home storage is below minimum', async () => {
    const ssh = createMockSSH({
      'test -d': { stdout: 'exists', exitCode: 0 },
    });

    const budget = DEFAULT_RESOURCE_BUDGETS['reMarkable1'];
    const info = makeDeviceInfo({
      storage: [
        { mountPoint: '/', totalMB: 256, usedMB: 180, availableMB: 76, usagePercent: 70 },
        { mountPoint: '/home', totalMB: 6400, usedMB: 6380, availableMB: budget.minFreeStorageMB - 1, usagePercent: 99 },
      ],
    });

    const report = await runPreflightChecks(info, ssh);

    const storageCheck = report.checks.find(c => c.name === '/home Storage');
    expect(storageCheck).toBeDefined();
    expect(storageCheck!.passed).toBe(false);
    expect(storageCheck!.severity).toBe('error');
    expect(report.passed).toBe(false);
  });

  it('warns when root partition is nearly full', async () => {
    const ssh = createMockSSH({
      'test -d': { stdout: 'exists', exitCode: 0 },
    });

    const info = makeDeviceInfo({
      storage: [
        { mountPoint: '/', totalMB: 256, usedMB: 250, availableMB: 6, usagePercent: 97 },
        { mountPoint: '/home', totalMB: 6400, usedMB: 2100, availableMB: 4300, usagePercent: 33 },
      ],
    });

    const report = await runPreflightChecks(info, ssh);

    const rootCheck = report.checks.find(c => c.name === 'Root Partition');
    expect(rootCheck).toBeDefined();
    expect(rootCheck!.passed).toBe(true); // root issues don't block
    expect(rootCheck!.message).toContain('97%');
  });

  it('fails when xochitl directory is missing', async () => {
    const ssh = createMockSSH({
      'test -d': { stdout: 'missing', exitCode: 0 },
    });

    const report = await runPreflightChecks(makeDeviceInfo(), ssh);

    const xochitlCheck = report.checks.find(c => c.name === 'xochitl Data Directory');
    expect(xochitlCheck).toBeDefined();
    expect(xochitlCheck!.passed).toBe(false);
    expect(xochitlCheck!.severity).toBe('error');
    expect(report.passed).toBe(false);
  });

  it('warns when device model is unknown', async () => {
    const ssh = createMockSSH({
      'test -d': { stdout: 'exists', exitCode: 0 },
    });

    const info = makeDeviceInfo({ model: 'unknown' });
    const report = await runPreflightChecks(info, ssh);

    const modelCheck = report.checks.find(c => c.name === 'Device Model');
    expect(modelCheck).toBeDefined();
    expect(modelCheck!.passed).toBe(true);
    expect(modelCheck!.message).toContain('conservative');
  });

  it('includes correct metadata in the report', async () => {
    const ssh = createMockSSH({
      'test -d': { stdout: 'exists', exitCode: 0 },
    });

    const info = makeDeviceInfo();
    const report = await runPreflightChecks(info, ssh);

    expect(report.deviceInfo).toBe(info);
    expect(report.installationPath).toBe('entware'); // 3.26 is entware
    expect(report.usesV6Format).toBe(true); // 3.26 uses v6
    expect(report.timestamp).toBeTruthy();
    expect(report.resourceBudget).toBe(DEFAULT_RESOURCE_BUDGETS['reMarkable1']);
  });
});

describe('formatPreflightReport', () => {
  it('formats a passing report', async () => {
    const ssh = createMockSSH({
      'test -d': { stdout: 'exists', exitCode: 0 },
    });

    const report = await runPreflightChecks(makeDeviceInfo(), ssh);
    const text = formatPreflightReport(report);

    expect(text).toContain('PASS');
    expect(text).toContain('3.26.0.68');
    expect(text).toContain('reMarkable1');
    expect(text).toContain('entware');
  });

  it('formats a failing report', async () => {
    const ssh = createMockSSH({
      'test -d': { stdout: 'missing', exitCode: 0 },
    });

    const info = makeDeviceInfo({
      firmware: parseFirmwareVersion('2.5.0.0'),
    });

    const report = await runPreflightChecks(info, ssh);
    const text = formatPreflightReport(report);

    expect(text).toContain('FAIL');
    expect(text).toContain('[FAIL]');
  });
});
