/**
 * Tests for firmware-compat.ts -- post-update health checks, firmware update
 * recovery detection, and Entware persistence verification.
 */

import {
  runPostUpdateHealthCheck,
  formatHealthCheckReport,
  type HealthCheckResult,
} from './firmware-compat';
import type { SSHExecutor, CommandResult } from '../ssh/ssh-client';

/** Create a mock SSH executor with configurable responses. */
function createMockSSH(responses: Record<string, Partial<CommandResult>>): SSHExecutor {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue(true),
    isConnected: jest.fn().mockReturnValue(true),
    execute: jest.fn().mockImplementation(async (cmd: string) => {
      // Match against registered command patterns
      for (const [pattern, response] of Object.entries(responses)) {
        if (cmd.includes(pattern)) {
          return {
            stdout: response.stdout ?? '',
            stderr: response.stderr ?? '',
            exitCode: response.exitCode ?? 0,
          };
        }
      }
      // Default: command not found
      return { stdout: '', stderr: 'command not found', exitCode: 127 };
    }),
  };
}

describe('runPostUpdateHealthCheck', () => {
  it('returns healthy when all components are present and running', async () => {
    const ssh = createMockSSH({
      'cat /etc/version': { stdout: '3.26.0.68' },
      'test -e /home/root/.entware': { stdout: 'yes' },
      'df /home/root/.entware': { stdout: '/dev/mmcblk2p4 3000 1000 2000 34% /home' },
      'test -e /home/root/.entware/bin/syncthing': { stdout: 'yes' },
      'systemctl is-active remarkable-sync': { stdout: 'active' },
      'test -e /etc/systemd/system/remarkable-sync.service': { stdout: 'yes' },
      'test -e /home/root/.config/syncthing': { stdout: 'yes' },
      'test -e /home/root/.local/share/remarkable/xochitl': { stdout: 'yes' },
      'ls /home/root/.local/share/remarkable/xochitl/*.metadata': { stdout: '5' },
    });

    const result = await runPostUpdateHealthCheck(ssh);

    expect(result.healthy).toBe(true);
    expect(result.firmwareVersion).not.toBeNull();
    expect(result.firmwareVersion!.raw).toBe('3.26.0.68');
    expect(result.installPath).toBe('entware');
    expect(result.firmwareUpdateDetected).toBe(false);
  });

  it('detects firmware update when service is missing but binary+config present', async () => {
    const ssh = createMockSSH({
      'cat /etc/version': { stdout: '3.28.0.100' },
      'test -e /home/root/.entware': { stdout: 'yes' },
      'df /home/root/.entware': { stdout: '/dev/mmcblk2p4 3000 1000 2000 34% /home' },
      'test -e /home/root/.entware/bin/syncthing': { stdout: 'yes' },
      'systemctl is-active remarkable-sync': { stdout: 'inactive', exitCode: 3 },
      'test -e /etc/systemd/system/remarkable-sync.service': { stdout: 'no' },
      'test -e /home/root/.entware/remarkable-sync.service.bak': { stdout: 'yes' },
      'test -e /home/root/.config/syncthing': { stdout: 'yes' },
      'test -e /home/root/.local/share/remarkable/xochitl': { stdout: 'yes' },
      'ls /home/root/.local/share/remarkable/xochitl/*.metadata': { stdout: '10' },
    });

    const result = await runPostUpdateHealthCheck(ssh);

    expect(result.healthy).toBe(false);
    expect(result.firmwareUpdateDetected).toBe(true);
    expect(result.recoverySteps.length).toBeGreaterThan(0);
    expect(result.recoverySteps.some(s => s.includes('firmware update'))).toBe(true);
  });

  it('handles toltec firmware range (2.6-3.3)', async () => {
    const ssh = createMockSSH({
      'cat /etc/version': { stdout: '3.2.0.50' },
      'test -e /home/root/.entware': { stdout: 'yes' },
      'df /home/root/.entware': { stdout: '/dev/mmcblk2p4 3000 1000 2000 34% /home' },
      'test -e /home/root/.entware/bin/syncthing': { stdout: 'yes' },
      'systemctl is-active remarkable-sync': { stdout: 'active' },
      'test -e /home/root/.config/syncthing': { stdout: 'yes' },
      'test -e /home/root/.local/share/remarkable/xochitl': { stdout: 'yes' },
      'ls /home/root/.local/share/remarkable/xochitl/*.metadata': { stdout: '3' },
    });

    const result = await runPostUpdateHealthCheck(ssh);

    expect(result.installPath).toBe('toltec');
  });

  it('marks Entware as warning if not on /home partition', async () => {
    const ssh = createMockSSH({
      'cat /etc/version': { stdout: '3.26.0.68' },
      'test -e /home/root/.entware': { stdout: 'yes' },
      'df /home/root/.entware': { stdout: '/dev/mmcblk2p3 200 100 100 50% /' },  // root partition
      'test -e /home/root/.entware/bin/syncthing': { stdout: 'yes' },
      'systemctl is-active remarkable-sync': { stdout: 'active' },
      'test -e /home/root/.config/syncthing': { stdout: 'yes' },
      'test -e /home/root/.local/share/remarkable/xochitl': { stdout: 'yes' },
      'ls /home/root/.local/share/remarkable/xochitl/*.metadata': { stdout: '2' },
    });

    const result = await runPostUpdateHealthCheck(ssh);

    const entwareCheck = result.checks.find(c => c.name === 'Entware installation');
    expect(entwareCheck).toBeDefined();
    expect(entwareCheck!.status).toBe('warn');
  });

  it('handles missing xochitl directory gracefully', async () => {
    const ssh = createMockSSH({
      'cat /etc/version': { stdout: '3.26.0.68' },
      'test -e /home/root/.entware': { stdout: 'yes' },
      'df /home/root/.entware': { stdout: '/dev/mmcblk2p4 3000 1000 2000 34% /home' },
      'test -e /home/root/.entware/bin/syncthing': { stdout: 'yes' },
      'systemctl is-active remarkable-sync': { stdout: 'active' },
      'test -e /home/root/.config/syncthing': { stdout: 'yes' },
      'test -e /home/root/.local/share/remarkable/xochitl': { stdout: 'no' },
    });

    const result = await runPostUpdateHealthCheck(ssh);

    const xochitlCheck = result.checks.find(c => c.name === 'xochitl data');
    expect(xochitlCheck).toBeDefined();
    expect(xochitlCheck!.status).toBe('fail');
  });
});

describe('formatHealthCheckReport', () => {
  it('formats a healthy result', () => {
    const result: HealthCheckResult = {
      healthy: true,
      checks: [
        { name: 'Test', status: 'pass', message: 'All good' },
      ],
      firmwareVersion: { raw: '3.26.0.68', major: 3, minor: 26, patch: 0, build: 68 },
      installPath: 'entware',
      firmwareUpdateDetected: false,
      recoverySteps: [],
    };

    const report = formatHealthCheckReport(result);
    expect(report).toContain('3.26.0.68');
    expect(report).toContain('HEALTHY');
    expect(report).toContain('[OK]');
  });

  it('formats a result with firmware update detected', () => {
    const result: HealthCheckResult = {
      healthy: false,
      checks: [
        { name: 'Service', status: 'fail', message: 'Missing', recoveryHint: 'Fix it' },
      ],
      firmwareVersion: { raw: '3.28.0.100', major: 3, minor: 28, patch: 0, build: 100 },
      installPath: 'entware',
      firmwareUpdateDetected: true,
      recoverySteps: ['A firmware update appears to have removed the Syncthing service.'],
    };

    const report = formatHealthCheckReport(result);
    expect(report).toContain('[FAIL]');
    expect(report).toContain('Firmware update detected');
    expect(report).toContain('ISSUES FOUND');
  });
});
