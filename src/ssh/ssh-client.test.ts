import type { SSHConfig } from '../types/config';
import { ErrorCode } from '../types/errors';
import { mapSSHConnectionError } from './ssh-client';

function config(method: 'usb' | 'wifi', host = '10.11.99.1'): SSHConfig {
  return {
    host,
    port: 22,
    username: 'root',
    password: 'secret',
    timeoutMs: 10_000,
    method,
  };
}

describe('mapSSHConnectionError', () => {
  it('maps Windows connect EACCES to a local socket-policy error for USB', () => {
    const cause = Object.assign(
      new Error('connect EACCES 10.11.99.1:22'),
      { code: 'EACCES', syscall: 'connect' },
    );

    const result = mapSSHConnectionError(cause, config('usb'));

    expect(result.code).toBe(ErrorCode.SSH_SOCKET_ACCESS_DENIED);
    expect(result.message).toContain('before authentication');
    expect(result.message).not.toContain('operating system');
    expect(result.suggestion).toContain('Developer Mode');
    expect(result.suggestion).toContain('factory-resets');
    expect(result.suggestion).toContain('successful ping does not prove TCP 22');
    expect(result.suggestion).toContain('Windows Defender Firewall');
    expect(result.suggestion).toContain('outbound TCP 22 to 10.11.99.1');
    expect(result.suggestion!.indexOf('Developer Mode'))
      .toBeLessThan(result.suggestion!.indexOf('Windows Defender Firewall'));
    expect(result.cause).toBe(cause);
  });

  it('provides WiFi-specific firewall guidance for socket EACCES', () => {
    const cause = Object.assign(new Error('connect EACCES 192.168.1.42:22'), {
      code: 'EACCES',
      syscall: 'connect',
    });

    const result = mapSSHConnectionError(
      cause,
      config('wifi', '192.168.1.42'),
    );

    expect(result.code).toBe(ErrorCode.SSH_SOCKET_ACCESS_DENIED);
    expect(result.suggestion).toContain('rm-ssh-over-wlan on');
    expect(result.suggestion).toContain('outbound TCP 22 to 192.168.1.42');
    expect(result.suggestion!.indexOf('rm-ssh-over-wlan on'))
      .toBeLessThan(result.suggestion!.indexOf('firewall'));
  });

  it('recognizes the Windows access-permissions wording when code metadata is lost', () => {
    const result = mapSSHConnectionError(
      new Error('An attempt was made to access a socket in a way forbidden by its access permissions.'),
      config('usb'),
    );

    expect(result.code).toBe(ErrorCode.SSH_SOCKET_ACCESS_DENIED);
  });

  it('keeps server-side permission denied classified as authentication failure', () => {
    const result = mapSSHConnectionError(
      new Error('Permission denied (publickey,password).'),
      config('usb'),
    );

    expect(result.code).toBe(ErrorCode.SSH_AUTH_FAILED);
    expect(result.message).toContain('root password');
    expect(result.message).not.toContain('operating system');
  });
});
