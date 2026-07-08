import { stopServices, removeServices } from './service-manager';
import {
  SYNCTHING_SERVICE_NAME,
  SYNCTHING_SERVICE_PATH,
  WATCHDOG_SERVICE_NAME,
} from './types';
import type { SSHExecutor } from '../ssh/ssh-client';

function createRecordingSSH(executeCalls: string[]): SSHExecutor {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue(true),
    isConnected: jest.fn().mockReturnValue(true),
    execute: jest.fn().mockImplementation((command: string) => {
      executeCalls.push(command);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    }),
  };
}

describe('stopServices', () => {
  it('stops and disables both services', async () => {
    const executeCalls: string[] = [];
    const ssh = createRecordingSSH(executeCalls);

    await stopServices(ssh);

    const allCommands = executeCalls.join(' ');
    expect(allCommands).toContain(`systemctl stop ${WATCHDOG_SERVICE_NAME}`);
    expect(allCommands).toContain(`systemctl stop ${SYNCTHING_SERVICE_NAME}`);
    expect(allCommands).toContain(`systemctl disable ${WATCHDOG_SERVICE_NAME}`);
    expect(allCommands).toContain(`systemctl disable ${SYNCTHING_SERVICE_NAME}`);
  });
});

describe('removeServices', () => {
  it('stops services then removes files and reloads systemd', async () => {
    const executeCalls: string[] = [];
    const ssh = createRecordingSSH(executeCalls);

    await removeServices(ssh);

    const allCommands = executeCalls.join(' ');
    // Should stop first, then remove files
    expect(allCommands).toContain('systemctl stop');
    expect(allCommands).toContain(`rm -f ${SYNCTHING_SERVICE_PATH}`);
    expect(allCommands).toContain('daemon-reload');
  });
});
